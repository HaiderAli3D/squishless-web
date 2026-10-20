package engine

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"testing"
)

// applyOrder keeps the pixels with order >= k (per row for AxisX, per column for
// AxisY), returning the compact RGBA result and its size.
func applyOrder(t testing.TB, pix []byte, w, h int, order []uint16, axis Axis, k int) ([]byte, int, int) {
	t.Helper()
	ow, oh := w, h
	if axis == AxisX {
		ow -= k
	} else {
		oh -= k
	}
	out := make([]byte, 0, 4*ow*oh)
	if axis == AxisX {
		for y := 0; y < h; y++ {
			n := 0
			for x := 0; x < w; x++ {
				if int(order[y*w+x]) >= k {
					out = append(out, pix[4*(y*w+x):4*(y*w+x)+4]...)
					n++
				}
			}
			if n != ow {
				t.Fatalf("row %d keeps %d pixels, want %d", y, n, ow)
			}
		}
		return out, ow, oh
	}
	// AxisY: build the result column by column, then lay it out row-major.
	cols := make([][]int, w)
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			if int(order[y*w+x]) >= k {
				cols[x] = append(cols[x], y)
			}
		}
		if len(cols[x]) != oh {
			t.Fatalf("column %d keeps %d pixels, want %d", x, len(cols[x]), oh)
		}
	}
	for j := 0; j < oh; j++ {
		for x := 0; x < w; x++ {
			i := 4 * (cols[x][j]*w + x)
			out = append(out, pix[i:i+4]...)
		}
	}
	return out, ow, oh
}

// checkOrderShape verifies that every row (AxisX) or column (AxisY) holds each step
// 0..n-1 exactly once and NeverRemoved elsewhere.
func checkOrderShape(t *testing.T, order []uint16, w, h int, axis Axis, n int) {
	t.Helper()
	lines, length := h, w
	at := func(line, i int) uint16 { return order[line*w+i] }
	if axis == AxisY {
		lines, length = w, h
		at = func(line, i int) uint16 { return order[i*w+line] }
	}
	seen := make([]bool, n)
	for l := 0; l < lines; l++ {
		clear(seen)
		never := 0
		for i := 0; i < length; i++ {
			v := at(l, i)
			switch {
			case v == NeverRemoved:
				never++
			case int(v) >= n:
				t.Fatalf("line %d: step %d >= %d", l, v, n)
			case seen[v]:
				t.Fatalf("line %d: step %d twice", l, v)
			default:
				seen[v] = true
			}
		}
		if never != length-n {
			t.Fatalf("line %d: %d never-removed pixels, want %d", l, never, length-n)
		}
	}
}

// checkInvariant asserts that the order map reproduces Resize for every k in ks.
func checkInvariant(t *testing.T, src *image.NRGBA, opt Options, axis Axis, maxSeams int, ks []int) {
	t.Helper()
	w, h := src.Rect.Dx(), src.Rect.Dy()
	order, err := SeamOrder(context.Background(), src.Pix, w, h, opt, axis, maxSeams)
	if err != nil {
		t.Fatal(err)
	}
	n := ClampSeams(w, h, axis, maxSeams)
	checkOrderShape(t, order, w, h, axis, n)
	for _, k := range ks {
		if k > n {
			t.Fatalf("test bug: k=%d > n=%d", k, n)
		}
		got, gw, gh := applyOrder(t, src.Pix, w, h, order, axis, k)
		o := opt
		o.Width, o.Height = 0, 0
		if axis == AxisX {
			o.Width = w - k
		} else {
			o.Height = h - k
		}
		want, err := Resize(context.Background(), src, o, nil)
		if err != nil {
			t.Fatal(err)
		}
		if want.Rect.Dx() != gw || want.Rect.Dy() != gh {
			t.Fatalf("k=%d: size %dx%d, Resize gives %v", k, gw, gh, want.Rect)
		}
		if string(got) != string(want.Pix) {
			diff := 0
			for i := range got {
				if got[i] != want.Pix[i] {
					diff++
				}
			}
			t.Fatalf("axis %v k=%d: order map differs from Resize in %d of %d bytes", axis, k, diff, len(got))
		}
	}
}

func rectMask(w, h int, r image.Rectangle) *image.Gray {
	m := image.NewGray(image.Rect(0, 0, w, h))
	r = r.Intersect(m.Rect)
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			m.Pix[y*m.Stride+x] = 255
		}
	}
	return m
}

func TestSeamOrderMatchesResize(t *testing.T) {
	src := noiseImage(96, 72, 7)
	w, h := 96, 72
	protect := rectMask(w, h, image.Rect(10, 5, 40, 50))
	remove := rectMask(w, h, image.Rect(55, 20, 70, 60))
	opts := []struct {
		name string
		opt  Options
	}{
		{"default", Options{BlurRadius: DefaultBlurRadius, SobelThreshold: DefaultSobelThreshold}},
		{"noBlur", Options{}},
		{"blur7", Options{BlurRadius: 7}},
		{"blurClamped", Options{BlurRadius: 20}},
		{"threshold", Options{BlurRadius: 1, SobelThreshold: 12}},
		{"protect", Options{BlurRadius: 2, Protect: protect}},
		{"remove", Options{BlurRadius: 2, Remove: remove}},
		{"bothMasks", Options{BlurRadius: 2, Protect: protect, Remove: remove, SobelThreshold: 4}},
		{"halfSizeMask", Options{BlurRadius: 2, Protect: rectMask(w/2, h/2, image.Rect(5, 3, 20, 25))}},
		{"facesNoFace", Options{BlurRadius: 2, ProtectFaces: true}},
	}
	for _, o := range opts {
		t.Run(o.name+"/x", func(t *testing.T) {
			checkInvariant(t, src, o.opt, AxisX, 60, []int{0, 1, 2, 7, 33, 60})
		})
		t.Run(o.name+"/y", func(t *testing.T) {
			checkInvariant(t, src, o.opt, AxisY, 50, []int{0, 1, 3, 20, 50})
		})
	}
}

func TestSeamOrderAllTheWay(t *testing.T) {
	src := noiseImage(23, 17, 9)
	checkInvariant(t, src, Options{BlurRadius: 2}, AxisX, 1000, []int{0, 11, 21, 22})
	checkInvariant(t, src, Options{BlurRadius: 2}, AxisY, 1000, []int{0, 8, 15, 16})
}

// Large enough that the carver runs its parallel paths (on native builds).
func TestSeamOrderParallelSize(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	src := noiseImage(512, 300, 11)
	checkInvariant(t, src, Options{BlurRadius: 2}, AxisX, 40, []int{1, 17, 40})
	checkInvariant(t, src, Options{BlurRadius: 2}, AxisY, 30, []int{5, 30})
}

func loadSample(t testing.TB) *image.NRGBA {
	return loadJPEG(t, "../site/samples/portrait-field.jpg")
}

func loadJPEG(t testing.TB, path string) *image.NRGBA {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Skip("sample not present")
	}
	defer f.Close()
	img, err := jpeg.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	return fromPacked(toPacked(img), b.Dx(), b.Dy())
}

// portrait-field.jpg is the requested sample (pigo finds no face in it at the
// moment); sample.jpg (from caire) has a detected face, so the face bias is exercised.
func TestSeamOrderFacesSample(t *testing.T) {
	for _, c := range []struct {
		name      string
		needFaces bool
	}{{"portrait-field.jpg", false}, {"sample.jpg", true}} {
		t.Run(c.name, func(t *testing.T) {
			src := loadJPEG(t, "../site/samples/"+c.name)
			testSeamOrderFaces(t, src, c.needFaces)
		})
	}
}

func testSeamOrderFaces(t *testing.T, src *image.NRGBA, needFaces bool) {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	faces, err := detectFaces(toPacked(src), w, h)
	if err != nil {
		t.Fatal(err)
	}
	if len(faces) == 0 {
		if needFaces {
			t.Fatal("expected a face on this sample")
		}
		t.Log("no face detected on the sample; the faces path still runs")
	}
	t.Logf("sample %dx%d, faces %v", w, h, faces)
	opt := Options{ProtectFaces: true, BlurRadius: DefaultBlurRadius}
	checkInvariant(t, src, opt, AxisX, w/2, []int{1, w / 5, w / 2})
	if !testing.Short() {
		checkInvariant(t, src, opt, AxisY, h/3, []int{h / 7, h / 3})
	}
	// Faces must change the order compared to no faces when a face is found.
	if len(faces) > 0 {
		a, _ := SeamOrder(context.Background(), src.Pix, w, h, opt, AxisX, w/2)
		opt.ProtectFaces = false
		b, _ := SeamOrder(context.Background(), src.Pix, w, h, opt, AxisX, w/2)
		if fmt.Sprint(a) == fmt.Sprint(b) {
			t.Error("ProtectFaces had no effect on the seam order")
		}
	}
}

func TestSeamOrderEdgeCases(t *testing.T) {
	ctx := context.Background()
	src := noiseImage(30, 20, 5)
	pix := src.Pix
	all := func(o []uint16, v uint16) bool {
		for _, x := range o {
			if x != v {
				return false
			}
		}
		return true
	}
	for _, m := range []int{0, -1, -1000} {
		o, err := SeamOrder(ctx, pix, 30, 20, Options{}, AxisX, m)
		if err != nil || len(o) != 600 || !all(o, NeverRemoved) {
			t.Fatalf("maxSeams=%d: %v", m, err)
		}
	}
	if n := ClampSeams(30, 20, AxisX, 1<<30); n != 29 {
		t.Fatalf("clamp x: %d", n)
	}
	if n := ClampSeams(30, 20, AxisY, 1<<30); n != 19 {
		t.Fatalf("clamp y: %d", n)
	}
	if n := ClampSeams(70000, 2, AxisX, 1<<30); n != 65534 {
		t.Fatalf("clamp 65534: %d", n)
	}
	if n := ClampSeams(0, 0, AxisX, 5); n != 0 {
		t.Fatalf("clamp empty: %d", n)
	}

	// 1-pixel images.
	one := []byte{1, 2, 3, 255}
	for _, ax := range []Axis{AxisX, AxisY} {
		o, err := SeamOrder(ctx, one, 1, 1, Options{BlurRadius: 2, ProtectFaces: true}, ax, 5)
		if err != nil || len(o) != 1 || o[0] != NeverRemoved {
			t.Fatalf("1x1 %v: %v %v", ax, o, err)
		}
	}
	col := noiseImage(1, 9, 3)
	o, err := SeamOrder(ctx, col.Pix, 1, 9, Options{}, AxisX, 5)
	if err != nil || !all(o, NeverRemoved) {
		t.Fatalf("1x9 x: %v %v", o, err)
	}
	checkInvariant(t, col, Options{BlurRadius: 2}, AxisY, 100, []int{0, 1, 4, 8})
	row := noiseImage(9, 1, 3)
	checkInvariant(t, row, Options{BlurRadius: 2}, AxisX, 100, []int{0, 1, 4, 8})
	two := noiseImage(2, 2, 4)
	checkInvariant(t, two, Options{}, AxisX, 1, []int{0, 1})
	checkInvariant(t, two, Options{}, AxisY, 1, []int{0, 1})

	// Errors.
	if _, err := SeamOrder(ctx, pix[:len(pix)-1], 30, 20, Options{}, AxisX, 3); err == nil {
		t.Error("short buffer: expected error")
	}
	if _, err := SeamOrder(ctx, pix, 20, 20, Options{}, AxisX, 3); err == nil {
		t.Error("size mismatch: expected error")
	}
	if _, err := SeamOrder(ctx, nil, 0, 0, Options{}, AxisX, 3); err == nil {
		t.Error("empty: expected error")
	}
	if _, err := SeamOrder(ctx, pix, 30, 20, Options{}, Axis(2), 3); err == nil {
		t.Error("bad axis: expected error")
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := SeamOrder(cctx, pix, 30, 20, Options{}, AxisX, 3); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: got %v", err)
	}
}

func TestResizeRGBAEqualsResize(t *testing.T) {
	src := noiseImage(64, 48, 12)
	mask := rectMask(64, 48, image.Rect(5, 5, 30, 30))
	for _, o := range []Options{
		{Width: 40},
		{Height: 30, BlurRadius: 2},
		{Width: 50, Height: 40, BlurRadius: 3, SobelThreshold: 5},
		{Width: 100, BlurRadius: 2, Protect: mask},
		{Width: 80, Height: 60},
		{Width: 50, Height: 70, Remove: mask},
		{Width: 64, Height: 48},
		{Width: 32, ProtectFaces: true},
	} {
		t.Run(fmt.Sprintf("%dx%d", o.Width, o.Height), func(t *testing.T) {
			before := append([]byte(nil), src.Pix...)
			var calls int
			out, ow, oh, err := ResizeRGBA(context.Background(), src.Pix, 64, 48, o, func(float64) { calls++ })
			if err != nil {
				t.Fatal(err)
			}
			if string(before) != string(src.Pix) {
				t.Fatal("ResizeRGBA modified its input")
			}
			want, err := Resize(context.Background(), src, o, nil)
			if err != nil {
				t.Fatal(err)
			}
			if ow != want.Rect.Dx() || oh != want.Rect.Dy() || len(out) != 4*ow*oh || string(out) != string(want.Pix) {
				t.Fatalf("ResizeRGBA %dx%d differs from Resize %v", ow, oh, want.Rect)
			}
			if calls == 0 {
				t.Error("progress never called")
			}
		})
	}
	ctx := context.Background()
	if _, _, _, err := ResizeRGBA(ctx, src.Pix[:100], 64, 48, Options{Width: 10}, nil); err == nil {
		t.Error("short buffer: expected error")
	}
	if _, _, _, err := ResizeRGBA(ctx, src.Pix, 48, 64+1, Options{Width: 10}, nil); err == nil {
		t.Error("size mismatch: expected error")
	}
	if _, _, _, err := ResizeRGBA(ctx, src.Pix, -64, -48, Options{Width: 10}, nil); err == nil {
		t.Error("negative size: expected error")
	}
	if _, _, _, err := ResizeRGBA(ctx, src.Pix, 64, 48, Options{}, nil); err == nil {
		t.Error("zero target: expected error")
	}
	if _, _, _, err := ResizeRGBA(ctx, src.Pix, 64, 48, Options{Width: 1000}, nil); err == nil {
		t.Error("too big: expected error")
	}
	out, ow, oh, err := ResizeRGBA(ctx, []byte{9, 8, 7, 6}, 1, 1, Options{Width: 1}, nil)
	if err != nil || ow != 1 || oh != 1 || string(out) != string([]byte{9, 8, 7, 6}) {
		t.Fatalf("1x1: %v %d %d %v", out, ow, oh, err)
	}
}

func TestMaskFromBytes(t *testing.T) {
	b := []byte{0, 127, 128, 255, 10, 200}
	m := MaskFromBytes(b, 3, 2)
	if m == nil || m.Rect != image.Rect(0, 0, 3, 2) || string(m.Pix) != string(b) {
		t.Fatalf("got %+v", m)
	}
	b[0] = 99
	if m.Pix[0] != 0 {
		t.Error("mask aliases the input")
	}
	for _, c := range []struct {
		b    []byte
		w, h int
	}{{nil, 3, 2}, {[]byte{}, 3, 2}, {b, 2, 2}, {b, 7, 1}, {b, 0, 6}, {b, -3, -2}} {
		if MaskFromBytes(c.b, c.w, c.h) != nil {
			t.Errorf("%v %dx%d: expected nil", c.b, c.w, c.h)
		}
	}
	// Threshold: > 127 is marked. Only column 2 (128) and 3 (255) are protected/removed.
	bias := buildBias(nil, MaskFromBytes([]byte{0, 127, 128, 255}, 4, 1), 4, 1)
	if bias[0] != 0 || bias[1] != 0 || bias[2] != removeBias || bias[3] != removeBias {
		t.Fatalf("bias %v", bias)
	}
	// A remove mask from bytes steers SeamOrder: the marked column goes first.
	src := noiseImage(20, 10, 2)
	mb := make([]byte, 200)
	for y := 0; y < 10; y++ {
		mb[y*20+13] = 255
	}
	o, err := SeamOrder(context.Background(), src.Pix, 20, 10, Options{Remove: MaskFromBytes(mb, 20, 10)}, AxisX, 1)
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 10; y++ {
		if o[y*20+13] != 0 {
			t.Fatalf("row %d: marked pixel has order %d", y, o[y*20+13])
		}
	}
}

func BenchmarkSeamOrder(b *testing.B) {
	src := loadSample(b)
	w, h := src.Rect.Dx(), src.Rect.Dy()
	for _, c := range []struct {
		name  string
		axis  Axis
		faces bool
	}{{"x", AxisX, false}, {"x-faces", AxisX, true}, {"y", AxisY, false}} {
		b.Run(c.name, func(b *testing.B) {
			opt := Options{BlurRadius: DefaultBlurRadius, ProtectFaces: c.faces}
			n := w / 2
			if c.axis == AxisY {
				n = h / 2
			}
			b.ReportMetric(float64(w*h)/1e6, "MP")
			for b.Loop() {
				if _, err := SeamOrder(context.Background(), src.Pix, w, h, opt, c.axis, n); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
