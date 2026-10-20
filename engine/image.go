package engine

import (
	"image"
	"image/color"

	"golang.org/x/image/draw"
)

func pack(r, g, b, a uint8) uint32 {
	return uint32(r) | uint32(g)<<8 | uint32(b)<<16 | uint32(a)<<24
}

// toPacked converts any image to a compact w*h slice of packed NRGBA pixels.
func toPacked(src image.Image) []uint32 {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	out := make([]uint32, w*h)
	switch m := src.(type) {
	case *image.NRGBA:
		for y := 0; y < h; y++ {
			p := m.Pix[m.PixOffset(b.Min.X, b.Min.Y+y):]
			row := out[y*w : y*w+w]
			for x := range row {
				i := x * 4
				row[x] = pack(p[i], p[i+1], p[i+2], p[i+3])
			}
		}
	case *image.RGBA:
		for y := 0; y < h; y++ {
			p := m.Pix[m.PixOffset(b.Min.X, b.Min.Y+y):]
			row := out[y*w : y*w+w]
			for x := range row {
				i := x * 4
				r, g, bl, a := p[i], p[i+1], p[i+2], p[i+3]
				if a != 0xff && a != 0 {
					r = uint8(uint32(r) * 0xff / uint32(a))
					g = uint8(uint32(g) * 0xff / uint32(a))
					bl = uint8(uint32(bl) * 0xff / uint32(a))
				}
				row[x] = pack(r, g, bl, a)
			}
		}
	case *image.YCbCr:
		for y := 0; y < h; y++ {
			row := out[y*w : y*w+w]
			for x := range row {
				yi := m.YOffset(b.Min.X+x, b.Min.Y+y)
				ci := m.COffset(b.Min.X+x, b.Min.Y+y)
				r, g, bl := color.YCbCrToRGB(m.Y[yi], m.Cb[ci], m.Cr[ci])
				row[x] = pack(r, g, bl, 0xff)
			}
		}
	case *image.Gray:
		for y := 0; y < h; y++ {
			p := m.Pix[m.PixOffset(b.Min.X, b.Min.Y+y):]
			row := out[y*w : y*w+w]
			for x := range row {
				v := p[x]
				row[x] = pack(v, v, v, 0xff)
			}
		}
	case *image.Paletted:
		pal := make([]uint32, 256)
		for i, c := range m.Palette {
			n := color.NRGBAModel.Convert(c).(color.NRGBA)
			pal[i] = pack(n.R, n.G, n.B, n.A)
		}
		for y := 0; y < h; y++ {
			p := m.Pix[m.PixOffset(b.Min.X, b.Min.Y+y):]
			row := out[y*w : y*w+w]
			for x := range row {
				row[x] = pal[p[x]]
			}
		}
	default:
		for y := 0; y < h; y++ {
			row := out[y*w : y*w+w]
			for x := range row {
				n := color.NRGBAModel.Convert(src.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA)
				row[x] = pack(n.R, n.G, n.B, n.A)
			}
		}
	}
	return out
}

func fromPacked(pix []uint32, w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	p := img.Pix
	for i, v := range pix[:w*h] {
		j := i * 4
		p[j] = uint8(v)
		p[j+1] = uint8(v >> 8)
		p[j+2] = uint8(v >> 16)
		p[j+3] = uint8(v >> 24)
	}
	return img
}

// buildBias merges the protect/remove masks into a per-pixel energy bias.
// Masks of a different size than w*h are resampled (nearest neighbour). Returns nil
// when there are no masks. Removal wins where both masks are set.
func buildBias(protect, remove *image.Gray, w, h int) []float32 {
	if protect == nil && remove == nil {
		return nil
	}
	bias := make([]float32, w*h)
	apply := func(m *image.Gray, v float32) {
		mb := m.Bounds()
		mw, mh := mb.Dx(), mb.Dy()
		if mw <= 0 || mh <= 0 {
			return
		}
		for y := 0; y < h; y++ {
			my := y
			if mh != h {
				my = y * mh / h
			}
			mrow := m.Pix[my*m.Stride:]
			row := bias[y*w : y*w+w]
			for x := range row {
				mx := x
				if mw != w {
					mx = x * mw / w
				}
				if mrow[mx] > 127 {
					row[x] = v
				}
			}
		}
	}
	if protect != nil {
		apply(protect, protectBias)
	}
	if remove != nil {
		apply(remove, removeBias)
	}
	return bias
}

// scalePacked resamples the image with Catmull-Rom (premultiplied, via the x/image fast path).
func scalePacked(pix []uint32, w, h, nw, nh int) []uint32 {
	src := image.NewRGBA(image.Rect(0, 0, w, h))
	for i, v := range pix[:w*h] {
		j := i * 4
		r, g, b, a := uint32(v&0xff), uint32((v>>8)&0xff), uint32((v>>16)&0xff), v>>24
		if a != 0xff {
			r, g, b = r*a/0xff, g*a/0xff, b*a/0xff
		}
		src.Pix[j], src.Pix[j+1], src.Pix[j+2], src.Pix[j+3] = uint8(r), uint8(g), uint8(b), uint8(a)
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return toPacked(dst)
}

// scaleBias resamples the bias map with nearest neighbour.
func scaleBias(bias []float32, w, h, nw, nh int) []float32 {
	out := make([]float32, nw*nh)
	for y := 0; y < nh; y++ {
		sy := y * h / nh
		for x := 0; x < nw; x++ {
			out[y*nw+x] = bias[sy*w+x*w/nw]
		}
	}
	return out
}

func transpose32(p []uint32, w, h int) []uint32 {
	out := make([]uint32, w*h)
	const blk = 32
	for y0 := 0; y0 < h; y0 += blk {
		for x0 := 0; x0 < w; x0 += blk {
			for y := y0; y < min(y0+blk, h); y++ {
				for x := x0; x < min(x0+blk, w); x++ {
					out[x*h+y] = p[y*w+x]
				}
			}
		}
	}
	return out
}

func transposeF(p []float32, w, h int) []float32 {
	if p == nil {
		return nil
	}
	out := make([]float32, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			out[x*h+y] = p[y*w+x]
		}
	}
	return out
}
