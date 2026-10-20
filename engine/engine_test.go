package engine

import (
	"context"
	"errors"
	"image"
	"image/color"
	"image/color/palette"
	"image/jpeg"
	"math"
	"math/rand"
	"os"
	"testing"
)

func noiseImage(w, h int, seed int64) *image.NRGBA {
	rng := rand.New(rand.NewSource(seed))
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// Smooth-ish gradient plus noise so the energy is non-trivial.
			base := float64(x*255/w+y*255/h) / 2
			v := uint8(math.Max(0, math.Min(255, base+rng.NormFloat64()*25)))
			img.SetNRGBA(x, y, color.NRGBA{v, uint8(255 - int(v)), uint8(rng.Intn(256)), 255})
		}
	}
	return img
}

func TestSizes(t *testing.T) {
	src := noiseImage(120, 80, 1)
	cases := []struct {
		name         string
		w, h, ew, eh int
	}{
		{"shrinkW", 70, 0, 70, 80},
		{"shrinkH", 0, 50, 120, 50},
		{"shrinkBoth", 90, 40, 90, 40},
		{"shrinkBothOther", 40, 70, 40, 70},
		{"enlargeW", 200, 0, 200, 80},
		{"enlargeWBig", 400, 0, 400, 80},
		{"enlargeH", 0, 150, 120, 150},
		{"enlargeBoth", 150, 100, 150, 100},
		{"enlargeBothSquare", 130, 130, 130, 130},
		{"enlargeBothMax", 480, 320, 480, 320},
		{"mixedWShrinkHGrow", 90, 120, 90, 120},
		{"mixedWGrowHShrink", 160, 60, 160, 60},
		{"same", 120, 80, 120, 80},
		{"width1", 1, 0, 1, 80},
		{"height1", 0, 1, 120, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := Resize(context.Background(), src, Options{Width: c.w, Height: c.h}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if b := out.Bounds(); b.Dx() != c.ew || b.Dy() != c.eh || b.Min != (image.Point{}) {
				t.Fatalf("got %v, want %dx%d", b, c.ew, c.eh)
			}
		})
	}
}

func TestErrors(t *testing.T) {
	src := noiseImage(40, 30, 2)
	for _, o := range []Options{{}, {Width: -5}, {Width: 161}, {Height: 121}, {Width: 10, Height: -1}} {
		if _, err := Resize(context.Background(), src, o, nil); err == nil {
			t.Errorf("%+v: expected error", o)
		}
	}
	if _, err := Resize(context.Background(), nil, Options{Width: 5}, nil); err == nil {
		t.Error("nil src: expected error")
	}
}

// The incremental blur/energy update must match a full recomputation.
func TestIncrementalEnergyExact(t *testing.T) {
	src := noiseImage(90, 60, 3)
	pix := toPacked(src)
	c := newCarver(90, 60, pix, nil, true, false, defaultParams)
	for i := 0; i < 40; i++ {
		c.findSeam()
		c.removeSeam()
	}
	// Incrementally maintained cumulative energy must equal a full DP pass exactly.
	c.findSeam()
	inc := append([]float64(nil), c.dp...)
	seam := append([]int32(nil), c.seam...)
	c.fullDP()
	c.backtrack()
	for y := 0; y < c.h; y++ {
		for x := 0; x < c.w; x++ {
			if i := y*c.stride + x; inc[i] != c.dp[i] {
				t.Fatalf("dp mismatch at %d,%d: %v vs %v", x, y, inc[i], c.dp[i])
			}
		}
		if seam[y] != c.seam[y] {
			t.Fatalf("seam mismatch at row %d", y)
		}
	}
	p, _ := c.extract()
	ref := newCarver(c.w, c.h, p, nil, false, false, defaultParams)
	for y := 0; y < c.h; y++ {
		for x := 0; x < c.w; x++ {
			a := c.energy[y*c.stride+x]
			b := ref.energy[y*ref.stride+x]
			if math.Abs(float64(a-b)) > 1e-2 {
				t.Fatalf("energy mismatch at %d,%d: %v vs %v", x, y, a, b)
			}
		}
	}
}

func TestRemoveMask(t *testing.T) {
	w, h := 120, 80
	src := noiseImage(w, h, 4)
	sq := image.Rect(70, 20, 90, 60)
	mask := image.NewGray(src.Bounds())
	for y := sq.Min.Y; y < sq.Max.Y; y++ {
		for x := sq.Min.X; x < sq.Max.X; x++ {
			src.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
			mask.SetGray(x, y, color.Gray{255})
		}
	}
	count := func(img *image.NRGBA) int {
		n := 0
		for i := 0; i < len(img.Pix); i += 4 {
			if img.Pix[i] == 255 && img.Pix[i+1] == 255 && img.Pix[i+2] == 255 {
				n++
			}
		}
		return n
	}
	before := count(src)
	out, err := Resize(context.Background(), src, Options{Width: w - sq.Dx(), Remove: mask}, nil)
	if err != nil {
		t.Fatal(err)
	}
	after := count(out)
	if after > before/50 {
		t.Fatalf("white square not removed: %d of %d white pixels remain", after, before)
	}
	// Without the mask the high-contrast square should mostly survive.
	out2, _ := Resize(context.Background(), src, Options{Width: w - sq.Dx()}, nil)
	if count(out2) < before/2 {
		t.Fatalf("control: expected the square to survive without a mask, %d of %d left", count(out2), before)
	}
}

func TestProtectMask(t *testing.T) {
	w, h := 120, 80
	src := noiseImage(w, h, 5)
	pr := image.Rect(10, 10, 50, 70) // in the low-energy region? doesn't matter
	mask := image.NewGray(src.Bounds())
	for y := pr.Min.Y; y < pr.Max.Y; y++ {
		for x := pr.Min.X; x < pr.Max.X; x++ {
			mask.SetGray(x, y, color.Gray{255})
		}
	}
	out, err := Resize(context.Background(), src, Options{Width: 70, Protect: mask}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for y := pr.Min.Y; y < pr.Max.Y; y++ {
		want := src.Pix[src.PixOffset(pr.Min.X, y):src.PixOffset(pr.Max.X, y)]
		row := out.Pix[out.PixOffset(0, y):out.PixOffset(out.Rect.Dx(), y)]
		found := false
		for off := 0; off+len(want) <= len(row); off += 4 {
			if string(row[off:off+len(want)]) == string(want) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("protected row %d not intact", y)
		}
	}
}

func TestProtectMaskHeight(t *testing.T) {
	src := noiseImage(80, 120, 6)
	pr := image.Rect(20, 30, 60, 60)
	mask := image.NewGray(src.Bounds())
	for y := pr.Min.Y; y < pr.Max.Y; y++ {
		for x := pr.Min.X; x < pr.Max.X; x++ {
			mask.SetGray(x, y, color.Gray{255})
		}
	}
	out, err := Resize(context.Background(), src, Options{Height: 70, Protect: mask}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Every protected column must appear contiguously in the output column.
	for x := pr.Min.X; x < pr.Max.X; x++ {
		found := false
		for oy := 0; oy+pr.Dy() <= out.Rect.Dy() && !found; oy++ {
			ok := true
			for d := 0; d < pr.Dy(); d++ {
				if src.NRGBAAt(x, pr.Min.Y+d) != out.NRGBAAt(x, oy+d) {
					ok = false
					break
				}
			}
			found = ok
		}
		if !found {
			t.Fatalf("protected column %d not intact", x)
		}
	}
}

func TestCancel(t *testing.T) {
	src := noiseImage(300, 200, 7)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Resize(ctx, src, Options{Width: 150}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled: got %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	_, err := Resize(ctx, src, Options{Width: 100, Height: 400}, func(f float64) {
		if f > 0.3 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel mid-run: got %v", err)
	}
}

func TestProgress(t *testing.T) {
	src := noiseImage(200, 120, 8)
	for _, o := range []Options{{Width: 100}, {Width: 120, Height: 200}, {Width: 400, Height: 60}, {Width: 200}} {
		var calls []float64
		if _, err := Resize(context.Background(), src, o, func(f float64) { calls = append(calls, f) }); err != nil {
			t.Fatal(err)
		}
		if len(calls) == 0 || calls[len(calls)-1] != 1 {
			t.Fatalf("%+v: progress must end at 1: %v", o, calls)
		}
		if len(calls) > 52 {
			t.Fatalf("%+v: too many progress calls: %d", o, len(calls))
		}
		for i := 1; i < len(calls); i++ {
			if calls[i] < calls[i-1] || calls[i] < 0 || calls[i] > 1 {
				t.Fatalf("%+v: non-monotonic progress: %v", o, calls)
			}
		}
	}
}

func TestPalettedInput(t *testing.T) {
	src := noiseImage(60, 40, 9)
	p := image.NewPaletted(src.Bounds(), palette.Plan9)
	for y := 0; y < 40; y++ {
		for x := 0; x < 60; x++ {
			p.Set(x, y, src.At(x, y))
		}
	}
	out, err := Resize(context.Background(), p, Options{Width: 45, Height: 50}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Rect.Dx() != 45 || out.Rect.Dy() != 50 {
		t.Fatalf("got %v", out.Rect)
	}
	if out.Pix[3] != 255 {
		t.Fatalf("alpha lost: %d", out.Pix[3])
	}
}

func TestNonZeroMin(t *testing.T) {
	big := noiseImage(200, 150, 10)
	sub := big.SubImage(image.Rect(50, 40, 150, 120)).(*image.NRGBA)
	// Same pixels at origin, to compare against.
	ref := image.NewNRGBA(image.Rect(0, 0, 100, 80))
	for y := 0; y < 80; y++ {
		copy(ref.Pix[y*ref.Stride:y*ref.Stride+400], sub.Pix[sub.PixOffset(50, 40+y):])
	}
	mask := image.NewGray(image.Rect(50, 40, 150, 120))
	for y := 40; y < 60; y++ {
		for x := 60; x < 80; x++ {
			mask.SetGray(x, y, color.Gray{255})
		}
	}
	refMask := image.NewGray(image.Rect(0, 0, 100, 80))
	for y := 0; y < 20; y++ {
		for x := 10; x < 30; x++ {
			refMask.SetGray(x, y, color.Gray{255})
		}
	}
	a, err := Resize(context.Background(), sub, Options{Width: 70, Remove: mask}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Resize(context.Background(), ref, Options{Width: 70, Remove: refMask}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a.Rect != image.Rect(0, 0, 70, 80) || string(a.Pix) != string(b.Pix) {
		t.Fatal("sub-image result differs from the equivalent zero-origin image")
	}
	// YCbCr sub-image too.
	yc := image.NewYCbCr(image.Rect(0, 0, 64, 48), image.YCbCrSubsampleRatio420)
	ys := yc.SubImage(image.Rect(10, 8, 60, 40))
	out, err := Resize(context.Background(), ys, Options{Width: 30}, nil)
	if err != nil || out.Rect.Dx() != 30 || out.Rect.Dy() != 32 {
		t.Fatalf("ycbcr sub-image: %v %v", err, out)
	}
}

func TestFacesSample(t *testing.T) {
	f, err := os.Open("../site/samples/portrait-field.jpg")
	if err != nil {
		t.Skip("sample not present")
	}
	defer f.Close()
	img, err := jpeg.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	out, err := Resize(context.Background(), img, Options{Width: b.Dx() * 2 / 3, ProtectFaces: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Rect.Dx() != b.Dx()*2/3 {
		t.Fatalf("got %v", out.Rect)
	}
	ycb, _ := img.(*image.YCbCr)
	if ycb != nil {
		faces, _ := detectFaces(toPacked(img), b.Dx(), b.Dy())
		t.Logf("faces detected on sample: %v", faces)
	}
}
