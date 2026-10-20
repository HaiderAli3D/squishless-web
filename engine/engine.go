// Package engine implements fast content-aware image resizing (seam carving).
//
// The energy map (grayscale -> box blur -> Sobel magnitude) is computed once and then
// maintained incrementally while seams are removed, so each seam costs one cumulative
// energy pass plus a memmove per row, instead of a full image recomputation.
package engine

import (
	"context"
	"errors"
	"fmt"
	"image"
	"math"
)

// Options controls a resize.
type Options struct {
	Width, Height int         // target size in px; 0 = keep that dimension
	ProtectFaces  bool        // detect faces (pigo) once on the source, protect those regions
	Protect       *image.Gray // optional mask, same size as src, >127 = protect (may be nil)
	Remove        *image.Gray // optional mask, same size as src, >127 = remove first (may be nil)

	// BlurRadius is the box blur radius applied to the grayscale image before the Sobel
	// operator (window (2r+1)^2). 0 = no blur; values outside 0..7 are clamped.
	// Note the zero value means no blur: use DefaultBlurRadius for the tuned behaviour.
	BlurRadius int
	// SobelThreshold zeroes Sobel magnitudes (in gray units, 0..~1020) at or below it
	// before protect/remove biases are added, like caire's SobelDetector. Negative = 0.
	SobelThreshold float32
}

// Defaults that reproduce the tuned behaviour.
const (
	DefaultBlurRadius             = 2
	DefaultSobelThreshold float32 = 0
)

const (
	protectBias  = 1e6
	removeBias   = -1e6
	insertedBias = 1e5 // discourages picking an already duplicated seam in a later enlarge round
	maxScale     = 4
)

// Resize resizes src to the requested size using seam carving.
//
// progress may be nil; it is called at most ~50 times with a non-decreasing fraction in
// [0,1], the last call being exactly 1. Cancelling ctx makes Resize return ctx.Err() promptly.
func Resize(ctx context.Context, src image.Image, opt Options, progress func(fraction float64)) (*image.NRGBA, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if src == nil {
		return nil, errors.New("engine: nil source image")
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, errors.New("engine: empty source image")
	}
	if opt.Width == 0 && opt.Height == 0 {
		return nil, errors.New("engine: width and height are both zero")
	}
	tw, th := opt.Width, opt.Height
	if tw == 0 {
		tw = w
	}
	if th == 0 {
		th = h
	}
	if tw <= 0 || th <= 0 {
		return nil, fmt.Errorf("engine: invalid target size %dx%d", tw, th)
	}
	if tw > maxScale*w || th > maxScale*h {
		return nil, fmt.Errorf("engine: target %dx%d exceeds %dx the source size %dx%d", tw, th, maxScale, w, h)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	pix := toPacked(src)
	bias := buildBias(opt.Protect, opt.Remove, w, h)

	// Both dimensions shrink, or both grow: scale proportionally to the smallest
	// size that still covers the target, then carve only the remaining dimension.
	// For growth this turns large seam insertion (which visibly stretches subjects)
	// into a uniform upscale followed by seam removal.
	if (tw < w && th < h) || (tw > w && th > h) {
		s := math.Max(float64(tw)/float64(w), float64(th)/float64(h))
		sw := clampi(int(math.Round(float64(w)*s)), min(tw, w), max(tw, w))
		sh := clampi(int(math.Round(float64(h)*s)), min(th, h), max(th, h))
		if float64(tw)/float64(w) >= float64(th)/float64(h) {
			sw = tw
		} else {
			sh = th
		}
		if sw != w || sh != h {
			pix = scalePacked(pix, w, h, sw, sh)
			if bias != nil {
				bias = scaleBias(bias, w, h, sw, sh)
			}
			w, h = sw, sh
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if opt.ProtectFaces {
		var err error
		if bias, err = addFaceBias(pix, bias, w, h); err != nil {
			return nil, err
		}
	}

	ep := energyParams{radius: opt.BlurRadius, thresh: opt.SobelThreshold}
	rep := &reporter{fn: progress}
	rep.total = absi(tw-w) + absi(th-h)

	var err error
	if tw < w {
		pix, bias, err = shrink(ctx, rep, ep, pix, bias, w, h, w-tw)
		if err != nil {
			return nil, err
		}
		w = tw
	}
	if th < h {
		pt, bt := transpose32(pix, w, h), transposeF(bias, w, h)
		pt, bt, err = shrink(ctx, rep, ep, pt, bt, h, w, h-th)
		if err != nil {
			return nil, err
		}
		h = th
		pix, bias = transpose32(pt, h, w), transposeF(bt, h, w)
	}
	if tw > w {
		pix, bias, err = enlarge(ctx, rep, ep, pix, bias, w, h, tw-w)
		if err != nil {
			return nil, err
		}
		w = tw
	}
	if th > h {
		pt, bt := transpose32(pix, w, h), transposeF(bias, w, h)
		pt, _, err = enlarge(ctx, rep, ep, pt, bt, h, w, th-h)
		if err != nil {
			return nil, err
		}
		h = th
		pix = transpose32(pt, h, w)
	}

	out := fromPacked(pix, w, h)
	rep.finish()
	return out, nil
}

// addFaceBias detects faces in the w*h image and protects them in bias (allocated if
// nil and a face is found). Pixels already marked for removal stay marked.
func addFaceBias(pix []uint32, bias []float32, w, h int) ([]float32, error) {
	faces, err := detectFaces(pix, w, h)
	if err != nil {
		return nil, err
	}
	if len(faces) > 0 {
		if bias == nil {
			bias = make([]float32, w*h)
		}
		for _, r := range faces {
			r = r.Intersect(image.Rect(0, 0, w, h))
			for y := r.Min.Y; y < r.Max.Y; y++ {
				row := bias[y*w : y*w+w]
				for x := r.Min.X; x < r.Max.X; x++ {
					if row[x] >= 0 {
						row[x] = protectBias
					}
				}
			}
		}
	}
	return bias, nil
}

func absi(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// reporter throttles progress callbacks to steps of at least 2%.
type reporter struct {
	fn          func(float64)
	total, done int
	last        float64
}

func (r *reporter) step() {
	r.done++
	if r.fn == nil || r.total <= 0 {
		return
	}
	f := float64(r.done) / float64(r.total)
	if f < 1 && f-r.last >= 0.02 {
		r.last = f
		r.fn(f)
	}
}

func (r *reporter) finish() {
	if r.fn != nil {
		r.fn(1)
	}
}

func cancelled(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

// shrink removes n vertical seams from a w*h image.
func shrink(ctx context.Context, rep *reporter, ep energyParams, pix []uint32, bias []float32, w, h, n int) ([]uint32, []float32, error) {
	c := newCarver(w, h, pix, bias, true, false, ep)
	for i := 0; i < n; i++ {
		if err := cancelled(ctx); err != nil {
			return nil, nil, err
		}
		c.findSeam()
		c.removeSeam()
		rep.step()
	}
	p, b := c.extract()
	if bias == nil {
		b = nil
	}
	return p, b, nil
}

// enlarge inserts n vertical seams into a w*h image. The seams are found by removing
// them from a working copy (tracking original columns), then duplicated in the
// original, in rounds of at most half the current width.
func enlarge(ctx context.Context, rep *reporter, ep energyParams, pix []uint32, bias []float32, w, h, n int) ([]uint32, []float32, error) {
	var mark []bool // pixels created (or duplicated) by previous rounds
	for n > 0 {
		k := min(n, max(1, w/2))
		wb := make([]float32, w*h)
		for i := range wb {
			var v float32
			if bias != nil && bias[i] > 0 {
				v = bias[i]
			}
			if mark != nil && mark[i] {
				v += insertedBias
			}
			wb[i] = v
		}
		c := newCarver(w, h, pix, wb, false, true, ep)
		cols := make([]int32, k*h)
		for j := 0; j < k; j++ {
			if err := cancelled(ctx); err != nil {
				return nil, nil, err
			}
			c.findSeam()
			for y := 0; y < h; y++ {
				cols[j*h+y] = c.orig[y*c.stride+int(c.seam[y])]
			}
			if c.w > 1 {
				c.removeSeam()
			}
			rep.step()
		}

		nw := w + k
		np := make([]uint32, nw*h)
		nm := make([]bool, nw*h)
		var nb []float32
		if bias != nil {
			nb = make([]float32, nw*h)
		}
		dup := make([]bool, w)
		for y := 0; y < h; y++ {
			for x := range dup {
				dup[x] = false
			}
			for j := 0; j < k; j++ {
				dup[cols[j*h+y]] = true
			}
			src := pix[y*w : y*w+w]
			dst := np[y*nw : y*nw+nw]
			o := 0
			for x := 0; x < w; x++ {
				dst[o] = src[x]
				if mark != nil {
					nm[y*nw+o] = mark[y*w+x]
				}
				if nb != nil {
					nb[y*nw+o] = bias[y*w+x]
				}
				o++
				if dup[x] {
					if x+1 < w {
						dst[o] = avgPixel(src[x], src[x+1])
					} else {
						dst[o] = src[x]
					}
					nm[y*nw+o-1] = true
					nm[y*nw+o] = true
					if nb != nil {
						nb[y*nw+o] = bias[y*w+x]
					}
					o++
				}
			}
		}
		pix, bias, mark = np, nb, nm
		w = nw
		n -= k
	}
	return pix, bias, nil
}

func avgPixel(a, b uint32) uint32 {
	// Per-byte average without carries crossing channels.
	return (a & b) + (((a ^ b) & 0xfefefefe) >> 1)
}
