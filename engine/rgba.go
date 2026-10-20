package engine

import (
	"context"
	"fmt"
	"image"
)

// Axis selects the direction of seam removal for SeamOrder.
type Axis uint8

const (
	AxisX Axis = iota // remove vertical seams: the width shrinks
	AxisY             // remove horizontal seams: the height shrinks
)

func (a Axis) String() string {
	switch a {
	case AxisX:
		return "x"
	case AxisY:
		return "y"
	}
	return fmt.Sprintf("Axis(%d)", uint8(a))
}

// NeverRemoved marks a pixel that survives every seam removal in a SeamOrder map.
const NeverRemoved = 65535

// maxOrderSeams is the largest number of seams a SeamOrder map can record.
const maxOrderSeams = NeverRemoved - 1

// checkRGBA validates a straight RGBA buffer of w*h pixels.
func checkRGBA(pix []byte, w, h int) error {
	if w <= 0 || h <= 0 {
		return fmt.Errorf("engine: invalid image size %dx%d", w, h)
	}
	if n := uint64(w) * uint64(h) * 4; uint64(len(pix)) != n {
		return fmt.Errorf("engine: pixel buffer has %d bytes, want %d for %dx%d RGBA", len(pix), n, w, h)
	}
	return nil
}

// rgbaImage wraps pix (straight RGBA, compact rows) as an *image.NRGBA without copying.
func rgbaImage(pix []byte, w, h int) *image.NRGBA {
	return &image.NRGBA{Pix: pix, Stride: 4 * w, Rect: image.Rect(0, 0, w, h)}
}

// ResizeRGBA is Resize for a raw buffer: pix is straight (non-premultiplied) RGBA,
// 4 bytes per pixel, row-major, len(pix) == 4*w*h. pix is not modified. The result
// is in the same format, ow*oh pixels.
func ResizeRGBA(ctx context.Context, pix []byte, w, h int, opt Options, progress func(fraction float64)) (out []byte, ow, oh int, err error) {
	if err := checkRGBA(pix, w, h); err != nil {
		return nil, 0, 0, err
	}
	img, err := Resize(ctx, rgbaImage(pix, w, h), opt, progress)
	if err != nil {
		return nil, 0, 0, err
	}
	return img.Pix, img.Rect.Dx(), img.Rect.Dy(), nil
}

// ClampSeams returns the number of seams SeamOrder records for a w*h image along axis
// when asked for maxSeams: maxSeams clamped to [0, size-1] and to at most 65534.
func ClampSeams(w, h int, axis Axis, maxSeams int) int {
	size := w
	if axis == AxisY {
		size = h
	}
	return clampi(maxSeams, 0, max(0, min(size-1, maxOrderSeams)))
}

// SeamOrder computes the seam-removal order of every pixel of a w*h straight RGBA image.
//
// It removes up to maxSeams seams along axis (clamped, see ClampSeams) exactly like
// Resize does for a shrink of that axis only, and returns one value per source pixel
// (index y*w+x): the 0-based step at which the pixel is removed, or NeverRemoved.
// Keeping the pixels with order >= k (per row for AxisX, per column for AxisY) gives
// exactly Resize to size-k on that axis. opt.Width and opt.Height are ignored;
// faces, masks, blur radius and Sobel threshold apply.
func SeamOrder(ctx context.Context, pix []byte, w, h int, opt Options, axis Axis, maxSeams int) ([]uint16, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := checkRGBA(pix, w, h); err != nil {
		return nil, err
	}
	if axis != AxisX && axis != AxisY {
		return nil, fmt.Errorf("engine: invalid axis %v", axis)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	n := ClampSeams(w, h, axis, maxSeams)

	// Same preparation as Resize for a one-axis shrink (no prescale happens there).
	packed := toPacked(rgbaImage(pix, w, h))
	bias := buildBias(opt.Protect, opt.Remove, w, h)
	if opt.ProtectFaces && n > 0 {
		var err error
		if bias, err = addFaceBias(packed, bias, w, h); err != nil {
			return nil, err
		}
	}

	order := make([]uint16, w*h)
	for i := range order {
		order[i] = NeverRemoved
	}
	if n == 0 {
		return order, nil
	}

	// Carve vertical seams of a cw*ch image; for AxisY that is the transpose, whose
	// row y is source column y and whose original columns are source rows.
	cw, ch := w, h
	if axis == AxisY {
		packed, bias = transpose32(packed, w, h), transposeF(bias, w, h)
		cw, ch = h, w
	}
	ep := energyParams{radius: opt.BlurRadius, thresh: opt.SobelThreshold}
	c := newCarver(cw, ch, packed, bias, false, true, ep)
	packed, bias = nil, nil
	for i := 0; i < n; i++ {
		if err := cancelled(ctx); err != nil {
			return nil, err
		}
		c.findSeam()
		step := uint16(i)
		for y := 0; y < ch; y++ {
			ox := int(c.orig[y*c.stride+int(c.seam[y])])
			if axis == AxisX {
				order[y*w+ox] = step
			} else {
				order[ox*w+y] = step
			}
		}
		c.removeSeam()
	}
	return order, nil
}

// MaskFromBytes wraps a 1-byte-per-pixel mask (> 127 = marked) of a w*h image as an
// *image.Gray (copied). It returns nil when b is empty or its length is not w*h.
func MaskFromBytes(b []byte, w, h int) *image.Gray {
	if w <= 0 || h <= 0 || len(b) == 0 || uint64(len(b)) != uint64(w)*uint64(h) {
		return nil
	}
	m := image.NewGray(image.Rect(0, 0, w, h))
	copy(m.Pix, b)
	return m
}
