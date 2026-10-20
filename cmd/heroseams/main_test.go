package main

import (
	"context"
	"image"
	"image/color"
	"math/rand"
	"testing"

	"github.com/HaiderAli3D/squishless-web/engine"
)

// texture: smooth gradients plus a few hard-edged blocks, so seams wander.
func testImage(w, h int, seed int64) *image.NRGBA {
	r := rand.New(rand.NewSource(seed))
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			v := uint8((x*7 + y*3) % 256)
			img.SetNRGBA(x, y, color.NRGBA{v, uint8(r.Intn(40)) + v/2, 255 - v, 255})
		}
	}
	for i := 0; i < 6 && w > 8 && h > 8; i++ {
		x0, y0 := r.Intn(w-6), r.Intn(h-6)
		c := color.NRGBA{uint8(r.Intn(256)), uint8(r.Intn(256)), uint8(r.Intn(256)), 255}
		for y := y0; y < y0+5; y++ {
			for x := x0; x < x0+5; x++ {
				img.SetNRGBA(x, y, c)
			}
		}
	}
	return img
}

// The .seams round trip must reproduce engine.SeamOrder exactly.
func TestSeamsRoundTripMatchesSeamOrder(t *testing.T) {
	cases := []struct {
		w, h, seams int
		blur        int
	}{
		{40, 23, 25, 2},
		{37, 30, 36, 0}, // all the way (w-1)
		{64, 9, 10, 2},
		{5, 1, 4, 2},  // one row: no steps at all
		{12, 5, 0, 2}, // no seams
	}
	for i, tc := range cases {
		img := testImage(tc.w, tc.h, int64(i+1))
		opt := engine.Options{BlurRadius: tc.blur}
		order, err := engine.SeamOrder(context.Background(), img.Pix, tc.w, tc.h, opt, engine.AxisX, tc.seams)
		if err != nil {
			t.Fatal(err)
		}
		paths, err := engine.SeamPaths(order, tc.w, tc.h)
		if err != nil {
			t.Fatalf("case %d: SeamPaths: %v", i, err)
		}
		if len(paths) != tc.seams {
			t.Fatalf("case %d: %d paths, want %d", i, len(paths), tc.seams)
		}
		data, err := encodeSeams(paths, tc.w, tc.h)
		if err != nil {
			t.Fatalf("case %d: encode: %v", i, err)
		}
		if want := headerSize + tc.seams*recordSize(tc.h); len(data) != want {
			t.Fatalf("case %d: %d bytes, want %d", i, len(data), want)
		}
		got, w, h, err := decodeSeams(data)
		if err != nil {
			t.Fatalf("case %d: decode: %v", i, err)
		}
		if w != tc.w || h != tc.h {
			t.Fatalf("case %d: size %dx%d", i, w, h)
		}
		rebuilt, err := engine.OrderFromSeamPaths(got, w, h)
		if err != nil {
			t.Fatalf("case %d: replay: %v", i, err)
		}
		for j := range order {
			if rebuilt[j] != order[j] {
				t.Fatalf("case %d: pixel %d: order %d, want %d", i, j, rebuilt[j], order[j])
			}
		}
		// and rendering k seams from the rebuilt map equals Resize to w-k
		if tc.seams > 0 {
			k := tc.seams / 2
			if k == 0 {
				k = 1
			}
			res, err := engine.Resize(context.Background(), img, engine.Options{Width: tc.w - k, BlurRadius: tc.blur}, nil)
			if err != nil {
				t.Fatal(err)
			}
			for y := 0; y < tc.h; y++ {
				ox := 0
				for x := 0; x < tc.w; x++ {
					if rebuilt[y*tc.w+x] < uint16(k) {
						continue
					}
					if img.NRGBAAt(x, y) != res.NRGBAAt(ox, y) {
						t.Fatalf("case %d: k=%d: pixel (%d,%d) differs from Resize", i, k, ox, y)
					}
					ox++
				}
			}
		}
	}
}

func TestSeamPathsRejectsBadMaps(t *testing.T) {
	order := []uint16{0, 65535, 1, 65535, 0, 0} // row 1 repeats step 0
	if _, err := engine.SeamPaths(order, 3, 2); err == nil {
		t.Fatal("want an error for a repeated step")
	}
	order = []uint16{0, 65535, 65535, 65535, 65535, 0} // seam jumps 2 columns
	if _, err := engine.SeamPaths(order, 3, 2); err == nil {
		t.Fatal("want an error for a seam that jumps")
	}
	if _, _, _, err := decodeSeams([]byte("nope")); err == nil {
		t.Fatal("want an error for garbage")
	}
}
