package engine

import (
	"context"
	"image"
	"image/color"
	"math/rand"
	"testing"
)

// full reference: recompute everything for the current image and compare.
func checkCarverExact(t *testing.T, c *carver, step int) {
	t.Helper()
	p := make([]uint32, c.w*c.h)
	var b []float32
	if c.bias != nil {
		b = make([]float32, c.w*c.h)
	}
	for y := 0; y < c.h; y++ {
		copy(p[y*c.w:], c.gray2pix(y))
		if b != nil {
			copy(b[y*c.w:y*c.w+c.w], c.bias[y*c.stride:y*c.stride+c.w])
		}
	}
	ref := newCarver(c.w, c.h, p, b, false, false, energyParams{radius: c.r, thresh: c.thresh})
	for y := 0; y < c.h; y++ {
		for x := 0; x < c.w; x++ {
			i, j := y*c.stride+x, y*ref.stride+x
			if c.blur[i] != ref.blur[j] {
				t.Fatalf("step %d w=%d: blur mismatch at %d,%d", step, c.w, x, y)
			}
			if c.energy[i] != ref.energy[j] {
				t.Fatalf("step %d w=%d: energy mismatch at %d,%d: %v vs %v", step, c.w, x, y, c.energy[i], ref.energy[j])
			}
		}
	}
	if c.dpValid {
		c.updateDP()
		inc := append([]float64(nil), c.dp...)
		c.fullDP()
		for y := 0; y < c.h; y++ {
			for x := 0; x < c.w; x++ {
				if i := y*c.stride + x; inc[i] != c.dp[i] {
					t.Fatalf("step %d w=%d: dp mismatch at %d,%d", step, c.w, x, y)
				}
			}
		}
		c.backtrack()
		return
	}
	c.findSeam()
}

// gray2pix rebuilds a gray-only packed row (gray -> r=g=b) so that newCarver reproduces gray exactly.
func (c *carver) gray2pix(y int) []uint32 {
	out := make([]uint32, c.w)
	for x := 0; x < c.w; x++ {
		v := c.gray[y*c.stride+x]
		out[x] = pack(v, v, v, 255)
	}
	return out
}

// exactParams are the blur radius / Sobel threshold combinations the incremental
// update must reproduce exactly.
var exactParams = func() []energyParams {
	var ps []energyParams
	for _, r := range []int{0, 1, 2, 4, 7} {
		for _, th := range []float32{0, 8} {
			ps = append(ps, energyParams{radius: r, thresh: th})
		}
	}
	return ps
}()

func TestEdgeExactEveryStep(t *testing.T) {
	for _, ep := range exactParams {
		for _, sz := range [][2]int{{6, 5}, {3, 1}, {1, 7}, {2, 2}, {40, 3}, {23, 19}, {700, 200}} {
			w, h := sz[0], sz[1]
			src := noiseImage(w, h, int64(w*h))
			if ep.thresh > 0 {
				// Smooth the noise so a fair share of magnitudes fall under the threshold.
				src = smoothImage(src)
			}
			pix := toPacked(src)
			rng := rand.New(rand.NewSource(1))
			bias := make([]float32, w*h)
			for i := range bias {
				switch rng.Intn(10) {
				case 0:
					bias[i] = protectBias
				case 1:
					bias[i] = removeBias
				}
			}
			for _, bb := range [][]float32{nil, bias} {
				c := newCarver(w, h, pix, bb, true, false, ep)
				steps := w - 1
				if w > 100 {
					steps = 150
					if ep != defaultParams {
						steps = 40
					}
				}
				for s := 0; s < steps; s++ {
					checkCarverExact(t, c, s)
					c.removeSeam()
				}
			}
		}
	}
}

// smoothImage averages each pixel with its right and lower neighbours.
func smoothImage(src *image.NRGBA) *image.NRGBA {
	b := src.Bounds()
	out := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			var s [3]int
			for _, p := range [][2]int{{x, y}, {min(x+1, b.Max.X-1), y}, {x, min(y+1, b.Max.Y-1)}} {
				c := src.NRGBAAt(p[0], p[1])
				s[0] += int(c.R)
				s[1] += int(c.G)
				s[2] += int(c.B)
			}
			out.SetNRGBA(x, y, color.NRGBA{uint8(s[0] / 3), uint8(s[1] / 3), uint8(s[2] / 3), 255})
		}
	}
	return out
}

// Threshold must actually zero some energies, and radius 0 must leave blur == gray.
func TestEnergyParamsEffect(t *testing.T) {
	src := smoothImage(noiseImage(60, 40, 9))
	pix := toPacked(src)
	c0 := newCarver(60, 40, pix, nil, false, false, energyParams{radius: 0})
	for i, g := range c0.gray {
		if c0.blur[i] != uint16(g) {
			t.Fatalf("radius 0: blur %d != gray %d at %d", c0.blur[i], g, i)
		}
	}
	plain := newCarver(60, 40, pix, nil, false, false, energyParams{radius: 1})
	th := newCarver(60, 40, pix, nil, false, false, energyParams{radius: 1, thresh: 8})
	zeroed := 0
	for i := range plain.energy {
		switch {
		case plain.energy[i] <= 8:
			if th.energy[i] != 0 {
				t.Fatalf("energy %v under threshold not zeroed", plain.energy[i])
			}
			if plain.energy[i] > 0 {
				zeroed++
			}
		case th.energy[i] != plain.energy[i]:
			t.Fatalf("energy above threshold changed: %v vs %v", th.energy[i], plain.energy[i])
		}
	}
	if zeroed == 0 {
		t.Fatal("threshold 8 zeroed nothing")
	}
	// Out-of-range values are clamped.
	if c := newCarver(5, 5, toPacked(noiseImage(5, 5, 1)), nil, false, false, energyParams{radius: 99, thresh: -3}); c.r != maxBlurRadius || c.thresh != 0 {
		t.Fatalf("clamp: r=%d thresh=%v", c.r, c.thresh)
	}
	if c := newCarver(5, 5, toPacked(noiseImage(5, 5, 1)), nil, false, false, energyParams{radius: -4}); c.r != 0 {
		t.Fatalf("clamp: r=%d", c.r)
	}
}

// texturedImage has a smooth gradient background with fine and coarse texture patches.
func texturedImage(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	rng := rand.New(rand.NewSource(77))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			v := 60 + x*120/w + y*40/h
			switch {
			case x%37 < 9 && y%23 < 11: // fine high-contrast noise
				v += rng.Intn(80) - 40
			case (x/6+y/6)%2 == 0 && x > w/2: // coarse checker
				v += 25
			}
			g := uint8(clampi(v, 0, 255))
			img.SetNRGBA(x, y, color.NRGBA{g, g, uint8(clampi(v+10, 0, 255)), 255})
		}
	}
	return img
}

// Different blur radii and Sobel thresholds must change which seams are removed.
func TestEnergyParamsChangeSeams(t *testing.T) {
	src := texturedImage(160, 90)
	seams := func(ep energyParams) []int32 {
		c := newCarver(160, 90, toPacked(src), nil, false, true, ep)
		var out []int32
		for i := 0; i < 20; i++ {
			c.findSeam()
			for y := 0; y < c.h; y++ {
				out = append(out, c.orig[y*c.stride+int(c.seam[y])])
			}
			c.removeSeam()
		}
		return out
	}
	base := seams(defaultParams)
	for _, ep := range []energyParams{{radius: 0}, {radius: 7}, {radius: 2, thresh: 20}} {
		got := seams(ep)
		same := true
		for i := range base {
			if got[i] != base[i] {
				same = false
				break
			}
		}
		if same {
			t.Errorf("%+v: seams identical to the defaults", ep)
		}
	}
	// And through the public API: outputs differ.
	a, err := Resize(context.Background(), src, Options{Width: 120, BlurRadius: DefaultBlurRadius}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Resize(context.Background(), src, Options{Width: 120, BlurRadius: 7, SobelThreshold: 20}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(a.Pix) == string(b.Pix) {
		t.Error("BlurRadius/SobelThreshold had no effect on the output")
	}
}

// Options{} zero values (no blur, no threshold) and out-of-range values must work.
func TestOptionsZeroAndClamped(t *testing.T) {
	src := texturedImage(80, 50)
	for _, o := range []Options{
		{Width: 60},
		{Width: 60, Height: 40},
		{Width: 120},
		{Height: 30, BlurRadius: 100, SobelThreshold: 1e9},
		{Width: 50, BlurRadius: -3, SobelThreshold: -1},
	} {
		out, err := Resize(context.Background(), src, o, nil)
		if err != nil {
			t.Fatalf("%+v: %v", o, err)
		}
		ew, eh := o.Width, o.Height
		if ew == 0 {
			ew = 80
		}
		if eh == 0 {
			eh = 50
		}
		if out.Rect.Dx() != ew || out.Rect.Dy() != eh {
			t.Fatalf("%+v: got %v", o, out.Rect)
		}
	}
}

func TestEdgeTiny(t *testing.T) {
	cases := []struct{ sw, sh, w, h int }{
		{2, 2, 1, 1}, {2, 2, 8, 8}, {1, 1, 4, 4}, {1, 1, 4, 1}, {3, 1, 12, 1}, {1, 5, 4, 0},
		{2, 2, 1, 8}, {2, 2, 8, 1}, {1, 1, 1, 1}, {5, 1, 1, 1}, {1, 9, 0, 1}, {2, 3, 7, 2},
	}
	for _, c := range cases {
		src := noiseImage(c.sw, c.sh, 3)
		out, err := Resize(context.Background(), src, Options{Width: c.w, Height: c.h, ProtectFaces: true}, nil)
		ew, eh := c.w, c.h
		if ew == 0 {
			ew = c.sw
		}
		if eh == 0 {
			eh = c.sh
		}
		if err != nil || out.Rect.Dx() != ew || out.Rect.Dy() != eh {
			t.Errorf("%+v: %v %v", c, err, out)
		}
	}
}

// Enlarge must duplicate seams: every original pixel must still be present in order.
func TestEdgeEnlargeKeepsOriginals(t *testing.T) {
	src := noiseImage(30, 10, 11)
	out, err := Resize(context.Background(), src, Options{Width: 100}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 10; y++ {
		ox := 0
		for x := 0; x < 30; x++ {
			want := src.NRGBAAt(x, y)
			for ox < 100 && out.NRGBAAt(ox, y) != want {
				ox++
			}
			if ox == 100 {
				t.Fatalf("row %d: original pixel %d not found in order", y, x)
			}
			ox++
		}
	}
}

// Mask after pre-scale: removing a marked block with both dimensions shrinking.
func TestEdgeMaskPrescale(t *testing.T) {
	w, h := 200, 100
	src := noiseImage(w, h, 4)
	mask := image.NewGray(src.Bounds())
	for y := 0; y < h; y++ {
		for x := 150; x < 170; x++ {
			src.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
			mask.SetGray(x, y, color.Gray{255})
		}
	}
	out, err := Resize(context.Background(), src, Options{Width: 120, Height: 90, Remove: mask}, nil)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for i := 0; i < len(out.Pix); i += 4 {
		if out.Pix[i] > 240 && out.Pix[i+1] > 240 && out.Pix[i+2] > 240 {
			n++
		}
	}
	if n > 0 {
		t.Fatalf("white pixels left: %d", n)
	}
}
