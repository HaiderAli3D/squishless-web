package engine

import (
	"math"
	"runtime"
	"sync"
)

// maxBlurRadius is the largest supported box blur radius. The box sum of a
// (2*7+1)^2 window of 8-bit gray values is at most 225*255 = 57375, which fits uint16.
const maxBlurRadius = 7

// energyParams selects how the energy map is computed.
type energyParams struct {
	radius int     // box blur radius applied to gray before Sobel (0..maxBlurRadius; 0 = no blur)
	thresh float32 // Sobel magnitudes (gray units) <= thresh become 0 before the bias is added
}

// defaultParams is the tuned behaviour (DefaultBlurRadius, DefaultSobelThreshold).
var defaultParams = energyParams{radius: DefaultBlurRadius, thresh: DefaultSobelThreshold}

// clamped returns p with the radius forced into [0, maxBlurRadius] and a non-negative threshold.
func (p energyParams) clamped() energyParams {
	p.radius = clampi(p.radius, 0, maxBlurRadius)
	if !(p.thresh > 0) { // also maps NaN to 0
		p.thresh = 0
	}
	return p
}

// parallelMinPixels is the image size from which seam removal is split across goroutines.
const parallelMinPixels = 1 << 17

// carver holds every per-pixel buffer needed to remove vertical seams.
//
// All buffers are flat slices of h rows with a fixed stride (the initial width);
// only the first w entries of each row are meaningful. Removing a seam shifts the
// tail of every row one position to the left (memmove) and then recomputes the
// blurred gray, energy and cumulative energy only where they can have changed.
// The result is bit-for-bit what a full recomputation would produce.
type carver struct {
	w, h, stride int

	r      int     // box blur radius (0..maxBlurRadius)
	norm   float32 // 1/(2r+1)^2: turns a Sobel response on box sums back into gray units
	thresh float32 // Sobel threshold in gray units

	pix    []uint32  // packed NRGBA (R | G<<8 | B<<16 | A<<24); nil when only seam positions are needed
	gray   []uint8   // luminance
	blur   []uint16  // box sum of gray over the (2R+1)^2 window (clamped edges)
	energy []float32 // Sobel magnitude of blur + bias: the cost the DP minimises
	bias   []float32 // +protect / -remove; nil when there are no masks
	orig   []int32   // original column of every pixel; nil unless tracking

	// dp is the cumulative energy, kept aligned by removeSeam. It is float64 because
	// protect/remove biases (+-1e6 per pixel) summed over hundreds of rows would swamp
	// the real image energy in float32 (ulp 32 at 3e8), making seams outside the mask
	// pick arbitrary straight paths that leave hard edges in smooth areas.
	dp     []float64
	seam   []int32 // column of the current seam in every row
	lo, hi []int32 // per row: blur columns refreshed by the last removal
	elo    []int32 // per row: energy columns refreshed by the last removal
	ehi    []int32
	// dpValid is true once dp holds a full cumulative map that removeSeam keeps aligned.
	dpValid bool

	workers int
}

// newCarver builds a carver for a w*h image. pix and bias are not modified; bias may be nil.
// If keepPix is false the pixel colours are only used to derive the gray image.
func newCarver(w, h int, pix []uint32, bias []float32, keepPix, trackOrig bool, ep energyParams) *carver {
	n := w * h
	ep = ep.clamped()
	d := 2*ep.radius + 1
	c := &carver{
		w: w, h: h, stride: w,
		r: ep.radius, norm: 1 / float32(d*d), thresh: ep.thresh,
		gray:   make([]uint8, n),
		blur:   make([]uint16, n),
		energy: make([]float32, n),
		dp:     make([]float64, n),
		seam:   make([]int32, h),
		lo:     make([]int32, h),
		hi:     make([]int32, h),
		elo:    make([]int32, h),
		ehi:    make([]int32, h),
	}
	if n >= parallelMinPixels {
		c.workers = min(runtime.GOMAXPROCS(0), 8, h/16)
	}
	if keepPix {
		c.pix = make([]uint32, n)
		copy(c.pix, pix)
	}
	if bias != nil {
		c.bias = make([]float32, n)
		copy(c.bias, bias)
	}
	if trackOrig {
		c.orig = make([]int32, n)
		for y := 0; y < h; y++ {
			row := c.orig[y*w : y*w+w]
			for x := range row {
				row[x] = int32(x)
			}
		}
	}
	for i, p := range pix[:n] {
		r, g, b := p&0xff, (p>>8)&0xff, (p>>16)&0xff
		c.gray[i] = uint8((299*r + 587*g + 114*b + 500) / 1000)
	}
	c.fullBlur()
	c.parallel(func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			c.energyRow(y, 0, w-1)
		}
	})
	return c
}

// parallel runs fn over row ranges covering [0, h), concurrently for large images.
func (c *carver) parallel(fn func(y0, y1 int)) {
	if c.workers <= 1 {
		fn(0, c.h)
		return
	}
	var wg sync.WaitGroup
	chunk := (c.h + c.workers - 1) / c.workers
	for y0 := 0; y0 < c.h; y0 += chunk {
		y1 := min(y0+chunk, c.h)
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn(y0, y1)
		}()
	}
	wg.Wait()
}

func clampi(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// fullBlur computes the clamped-edge box sum of the whole gray image (separable).
func (c *carver) fullBlur() {
	w, h, s, r := c.w, c.h, c.stride, c.r
	if r == 0 {
		for i, g := range c.gray[:w*h] {
			c.blur[i] = uint16(g)
		}
		return
	}
	tmp := make([]uint16, w*h)
	for y := 0; y < h; y++ {
		g := c.gray[y*s : y*s+w]
		t := tmp[y*s : y*s+w]
		for x := 0; x < w; x++ {
			var sum uint16
			for d := -r; d <= r; d++ {
				sum += uint16(g[clampi(x+d, 0, w-1)])
			}
			t[x] = sum
		}
	}
	for y := 0; y < h; y++ {
		b := c.blur[y*s : y*s+w]
		clear(b)
		for d := -r; d <= r; d++ {
			t := tmp[clampi(y+d, 0, h-1)*s:]
			t = t[:w]
			for x := range b {
				b[x] += t[x]
			}
		}
	}
}

// blurRange recomputes the box sum for row y, columns [x0, x1].
func (c *carver) blurRange(y, x0, x1 int) {
	w, h, s, r := c.w, c.h, c.stride, c.r
	var rowBuf [2*maxBlurRadius + 1][]uint8
	rows := rowBuf[:2*r+1]
	for d := -r; d <= r; d++ {
		yy := clampi(y+d, 0, h-1)
		rows[d+r] = c.gray[yy*s : yy*s+w]
	}
	out := c.blur[y*s : y*s+w]
	// Vertical sums of the columns the windows touch, then a sliding horizontal sum.
	// removeSeam asks for at most 4r+1 columns, so 6r+1 <= 43 entries fit the stack buffer.
	var buf [64]uint16
	col := buf[:0]
	for xx := x0 - r; xx <= x1+r; xx++ {
		cx := clampi(xx, 0, w-1)
		var v uint16
		for i := range rows {
			v += uint16(rows[i][cx])
		}
		col = append(col, v)
	}
	var sum uint16
	for i := 0; i < 2*r; i++ {
		sum += col[i]
	}
	for x := x0; x <= x1; x++ {
		i := x - x0
		sum += col[i+2*r]
		out[x] = sum
		sum -= col[i]
	}
}

// energyRow recomputes the cost (Sobel magnitude + bias) for row y, columns [x0, x1].
// Magnitudes (in gray units) at or below the threshold count as 0, like caire's SobelDetector.
func (c *carver) energyRow(y, x0, x1 int) {
	w, h, s := c.w, c.h, c.stride
	norm, thresh := c.norm, c.thresh
	ya, yb := clampi(y-1, 0, h-1), clampi(y+1, 0, h-1)
	top := c.blur[ya*s : ya*s+w]
	mid := c.blur[y*s : y*s+w]
	bot := c.blur[yb*s : yb*s+w]
	out := c.energy[y*s : y*s+w]
	var bias []float32
	if c.bias != nil {
		bias = c.bias[y*s : y*s+w]
	}
	for x := x0; x <= x1; x++ {
		l, r := x-1, x+1
		if l < 0 {
			l = 0
		}
		if r > w-1 {
			r = w - 1
		}
		gx := (int32(top[r]) + 2*int32(mid[r]) + int32(bot[r])) - (int32(top[l]) + 2*int32(mid[l]) + int32(bot[l]))
		gy := (int32(bot[l]) + 2*int32(bot[x]) + int32(bot[r])) - (int32(top[l]) + 2*int32(top[x]) + int32(top[r]))
		v := float32(math.Sqrt(float64(gx*gx+gy*gy))) * norm
		if v <= thresh {
			v = 0
		}
		if bias != nil {
			v += bias[x]
		}
		out[x] = v
	}
}

// findSeam brings the cumulative energy map up to date and backtracks the cheapest
// vertical seam into c.seam.
func (c *carver) findSeam() {
	if c.dpValid {
		c.updateDP()
	} else {
		c.fullDP()
		c.dpValid = true
	}
	c.backtrack()
}

// updateDP recomputes only the cumulative energy cells that can have changed since the
// last seam removal: the energy band around the removed seam in each row, plus the cells
// below a cell whose value actually changed. Cells outside are already correct because
// removeSeam shifted the dp rows together with the other buffers.
func (c *carver) updateDP() {
	w, h, s := c.w, c.h, c.stride
	dp, e := c.dp, c.energy
	last := w - 1

	clo, chi := -1, -2 // changed columns of the previous row (empty)
	for y := 0; y < h; y++ {
		lo, hi := int(c.elo[y]), int(c.ehi[y])
		if clo <= chi {
			lo = min(lo, clo-1)
			hi = max(hi, chi+1)
		}
		lo = max(lo, 0)
		hi = min(hi, last)
		nlo, nhi := -1, -2 // changed cells, relative to lo
		if lo > hi {
			clo, chi = nlo, nhi
			continue
		}
		off := y * s
		cur := dp[off+lo : off+hi+1]
		er := e[off+lo : off+hi+1]
		n := len(cur)
		switch {
		case y == 0:
			for i, ev := range er {
				if v := float64(ev); v != cur[i] {
					cur[i] = v
					if nlo < 0 {
						nlo = i
					}
					nhi = i
				}
			}
		case w == 1:
			if v := float64(er[0]) + dp[off-s]; v != cur[0] {
				cur[0] = v
				nlo, nhi = 0, 0
			}
		default:
			// prev holds the previous row's columns [pl, ph]; cell lo+i reads prev
			// columns lo+i-1 .. lo+i+1, i.e. prev[base+i : base+i+3].
			pl := max(lo-1, 0)
			ph := min(hi+1, last)
			prev := dp[off-s+pl : off-s+ph+1]
			base := lo - 1 - pl
			i, end := 0, n
			if lo == 0 {
				if v := float64(er[0]) + fmin(prev[0], prev[1]); v != cur[0] {
					cur[0] = v
					nlo, nhi = 0, 0
				}
				i = 1
			}
			if hi == last {
				end = n - 1
			}
			for ; i < end; i++ {
				j := base + i
				q := prev[j : j+3 : j+3]
				if v := float64(er[i]) + fmin3(q[0], q[1], q[2]); v != cur[i] {
					cur[i] = v
					if nlo < 0 {
						nlo = i
					}
					nhi = i
				}
			}
			if end < n {
				j := base + end
				if v := float64(er[end]) + fmin(prev[j], prev[j+1]); v != cur[end] {
					cur[end] = v
					if nlo < 0 {
						nlo = end
					}
					nhi = end
				}
			}
		}
		if nlo >= 0 {
			nlo += lo
			nhi += lo
		}
		clo, chi = nlo, nhi
	}
}

// fullDP computes the whole cumulative energy map.
func (c *carver) fullDP() {
	w, h, s := c.w, c.h, c.stride
	dp, e := c.dp, c.energy
	for x, v := range e[:w] {
		dp[x] = float64(v)
	}
	for y := 1; y < h; y++ {
		off := y * s
		prev := dp[off-s : off-s+w]
		cur := dp[off : off+w]
		er := e[off : off+w]
		if w == 1 {
			cur[0] = prev[0] + float64(er[0])
			continue
		}
		last := w - 1
		cur[0] = float64(er[0]) + fmin(prev[0], prev[1])
		// Sliding window over prev: a=prev[x-1], p=prev[x], q=prev[x+1].
		a, p := prev[0], prev[1]
		_ = er[last]
		_ = cur[last]
		for x := 1; x < last; x++ {
			q := prev[x+1]
			cur[x] = float64(er[x]) + fmin3(a, p, q)
			a, p = p, q
		}
		cur[last] = float64(er[last]) + fmin(prev[last-1], prev[last])
	}
}

// backtrack follows the cumulative energy map up from the cheapest cell of the last row.
func (c *carver) backtrack() {
	w, h, s := c.w, c.h, c.stride
	dp := c.dp
	off := (h - 1) * s
	row := dp[off : off+w]
	best := 0
	for x := 1; x < w; x++ {
		if row[x] < row[best] {
			best = x
		}
	}
	c.seam[h-1] = int32(best)
	for y := h - 2; y >= 0; y-- {
		row := dp[y*s : y*s+w]
		x := best
		if best > 0 && row[best-1] < row[x] {
			x = best - 1
		}
		if best < w-1 && row[best+1] < row[x] {
			x = best + 1
		}
		best = x
		c.seam[y] = int32(best)
	}
}

// removeSeam deletes c.seam from every buffer and refreshes blur/energy around it.
func (c *carver) removeSeam() {
	w, h, s := c.w, c.h, c.stride
	c.parallel(func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			x := int(c.seam[y])
			a, z := y*s+x, y*s+w
			if c.pix != nil {
				copy(c.pix[a:z-1], c.pix[a+1:z])
			}
			if c.orig != nil {
				copy(c.orig[a:z-1], c.orig[a+1:z])
			}
			if c.bias != nil {
				copy(c.bias[a:z-1], c.bias[a+1:z])
			}
			copy(c.gray[a:z-1], c.gray[a+1:z])
			copy(c.blur[a:z-1], c.blur[a+1:z])
			copy(c.energy[a:z-1], c.energy[a+1:z])
			if c.dpValid {
				copy(c.dp[a:z-1], c.dp[a+1:z])
			}
		}
	})
	w--
	c.w = w
	if w == 0 {
		return
	}

	// The box sum at (y, x) depends on gray rows y-R..y+R; it changed only between
	// the extreme seam columns of those rows, widened by the radius.
	r := c.r
	c.parallel(func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			mn, mx := int32(math.MaxInt32), int32(-1)
			for d := -r; d <= r; d++ {
				v := c.seam[clampi(y+d, 0, h-1)]
				mn = min(mn, v)
				mx = max(mx, v)
			}
			x0 := clampi(int(mn)-r, 0, w-1)
			x1 := clampi(int(mx)+r-1, x0, w-1)
			c.lo[y], c.hi[y] = int32(x0), int32(x1)
			c.blurRange(y, x0, x1)
		}
	})
	// Energy at (y, x) depends on blur rows y-1..y+1, columns x-1..x+1.
	c.parallel(func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			ya, yb := clampi(y-1, 0, h-1), clampi(y+1, 0, h-1)
			x0 := min(c.lo[ya], c.lo[y], c.lo[yb]) - 1
			x1 := max(c.hi[ya], c.hi[y], c.hi[yb]) + 1
			a, z := clampi(int(x0), 0, w-1), clampi(int(x1), 0, w-1)
			c.energyRow(y, a, z)
			c.elo[y], c.ehi[y] = int32(a), int32(z)
		}
	})
}

// extract returns compact (stride == w) copies of the pixels and bias (nil if none).
func (c *carver) extract() ([]uint32, []float32) {
	w, h, s := c.w, c.h, c.stride
	pix := make([]uint32, w*h)
	var bias []float32
	if c.bias != nil {
		bias = make([]float32, w*h)
	}
	for y := 0; y < h; y++ {
		copy(pix[y*w:y*w+w], c.pix[y*s:y*s+w])
		if bias != nil {
			copy(bias[y*w:y*w+w], c.bias[y*s:y*s+w])
		}
	}
	return pix, bias
}
