// Command heroseams precomputes the landing page's demo data at build time, so the hero
// is interactive before (and without) the WebAssembly engine:
//
//   - for each hero photo: <name>.jpg (the photo at hero size), <name>-thumb.jpg (sample
//     switcher thumbnail) and <name>.seams (the removed vertical seams, see format.go);
//   - for the before/after gallery: gallery/<name>-squishless.jpg (engine.Resize) and
//     gallery/<name>-normal.jpg (a plain resample to the same size);
//   - with -dev: dev/landing/<name>.png, the exact hero pixels the seams were computed on
//     (lossless, for the Playwright check against the wasm engine; dist/dev/ is removed
//     from production builds).
//
// Usage (scripts/build-site.sh runs it after the wasm build):
//
//	go run ./cmd/heroseams -samples site/samples -out dist/assets/landing -dev dist/dev/landing
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/image/draw"

	"github.com/HaiderAli3D/squishless-web/engine"
)

// hero photos: all are brought to the same 20:13 aspect so the demo stage never changes shape.
type hero struct {
	name  string
	file  string
	width int // hero width in px (height follows the 20:13 aspect)
}

var heroes = []hero{
	{"portrait-field", "portrait-field.jpg", 900},
	{"lake-canoe", "lake-canoe.jpg", 900},
	{"city-skyline", "city-skyline.jpg", 900},
	{"sample", "sample.jpg", 670}, // 670x447 source: cropped to 670x436, never upscaled
}

// gallery examples: source resized to an exact size with the engine (faces protected).
type example struct {
	name string
	file string
	w, h int
}

var gallery = []example{
	{"city-portrait", "city-skyline.jpg", 520, 650}, // 4:5
	{"girl-square", "sample.jpg", 447, 447},         // 1:1
	{"canoe-portrait", "lake-canoe.jpg", 520, 650},  // 4:5
}

const (
	heroAspectW, heroAspectH = 20, 13
	seamFraction             = 0.62 // remove up to 62% of the width
	heroQuality              = 82
	thumbWidth               = 144
)

func main() {
	samples := flag.String("samples", "site/samples", "directory with the sample photos")
	out := flag.String("out", "dist/assets/landing", "output directory")
	dev := flag.String("dev", "", "optional directory for lossless hero PNGs (test fixtures)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[heroseams] ")

	if err := os.MkdirAll(filepath.Join(*out, "gallery"), 0o755); err != nil {
		log.Fatal(err)
	}
	if *dev != "" {
		if err := os.MkdirAll(*dev, 0o755); err != nil {
			log.Fatal(err)
		}
	}
	ctx := context.Background()
	start := time.Now()
	for _, hr := range heroes {
		if err := buildHero(ctx, hr, *samples, *out, *dev); err != nil {
			log.Fatalf("%s: %v", hr.name, err)
		}
	}
	for _, ex := range gallery {
		if err := buildExample(ctx, ex, *samples, *out); err != nil {
			log.Fatalf("%s: %v", ex.name, err)
		}
	}
	log.Printf("done in %.1fs", time.Since(start).Seconds())
}

func loadJPEG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return jpeg.Decode(f)
}

// heroImage crops src to the hero aspect (centred) and scales it to width w.
func heroImage(src image.Image, w int) *image.NRGBA {
	b := src.Bounds()
	cw, ch := b.Dx(), b.Dy()
	if cw*heroAspectH > ch*heroAspectW { // too wide: crop the sides
		cw = int(math.Round(float64(ch) * heroAspectW / heroAspectH))
	} else {
		ch = int(math.Round(float64(cw) * heroAspectH / heroAspectW))
	}
	crop := image.Rect(0, 0, cw, ch).Add(b.Min).Add(image.Pt((b.Dx()-cw)/2, (b.Dy()-ch)/2))
	w = min(w, cw)
	h := int(math.Round(float64(w) * heroAspectH / heroAspectW))
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	if w == cw && h == ch {
		draw.Draw(dst, dst.Bounds(), src, crop.Min, draw.Src)
	} else {
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, crop, draw.Src, nil)
	}
	return dst
}

func scaleTo(src image.Image, w, h int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return dst
}

func writeFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	log.Printf("wrote %s (%.1f KiB)", filepath.ToSlash(path), float64(len(data))/1024)
	return nil
}

func encodeJPEG(img image.Image, q int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func buildHero(ctx context.Context, hr hero, samples, out, dev string) error {
	src, err := loadJPEG(filepath.Join(samples, hr.file))
	if err != nil {
		return err
	}
	img := heroImage(src, hr.width)
	w, h := img.Rect.Dx(), img.Rect.Dy()

	n := int(math.Round(seamFraction * float64(w)))
	opt := engine.Options{ProtectFaces: true, BlurRadius: engine.DefaultBlurRadius, SobelThreshold: engine.DefaultSobelThreshold}
	order, err := engine.SeamOrder(ctx, img.Pix, w, h, opt, engine.AxisX, n)
	if err != nil {
		return err
	}
	paths, err := engine.SeamPaths(order, w, h)
	if err != nil {
		return err
	}
	data, err := encodeSeams(paths, w, h)
	if err != nil {
		return err
	}
	// Belt and braces: the file must decode back to the exact map.
	if err := verifySeams(data, order, w, h); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(out, hr.name+".seams"), data); err != nil {
		return err
	}

	jpg, err := encodeJPEG(img, heroQuality)
	if err != nil {
		return err
	}
	if err := writeFile(filepath.Join(out, hr.name+".jpg"), jpg); err != nil {
		return err
	}
	th := int(math.Round(float64(thumbWidth) * float64(h) / float64(w)))
	thumb, err := encodeJPEG(scaleTo(img, thumbWidth, th), 78)
	if err != nil {
		return err
	}
	if err := writeFile(filepath.Join(out, hr.name+"-thumb.jpg"), thumb); err != nil {
		return err
	}
	if dev != "" {
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return err
		}
		if err := writeFile(filepath.Join(dev, hr.name+".png"), buf.Bytes()); err != nil {
			return err
		}
	}
	log.Printf("%s: %dx%d, %d seams", hr.name, w, h, len(paths))
	return nil
}

func verifySeams(data []byte, order []uint16, w, h int) error {
	paths, dw, dh, err := decodeSeams(data)
	if err != nil {
		return err
	}
	if dw != w || dh != h {
		return fmt.Errorf("decoded size %dx%d, want %dx%d", dw, dh, w, h)
	}
	got, err := engine.OrderFromSeamPaths(paths, w, h)
	if err != nil {
		return err
	}
	for i := range got {
		if got[i] != order[i] {
			return fmt.Errorf("decoded order differs at pixel %d", i)
		}
	}
	return nil
}

func buildExample(ctx context.Context, ex example, samples, out string) error {
	src, err := loadJPEG(filepath.Join(samples, ex.file))
	if err != nil {
		return err
	}
	opt := engine.Options{Width: ex.w, Height: ex.h, ProtectFaces: true, BlurRadius: engine.DefaultBlurRadius}
	res, err := engine.Resize(ctx, src, opt, nil)
	if err != nil {
		return err
	}
	jpg, err := encodeJPEG(res, heroQuality)
	if err != nil {
		return err
	}
	if err := writeFile(filepath.Join(out, "gallery", ex.name+"-squishless.jpg"), jpg); err != nil {
		return err
	}
	naive, err := encodeJPEG(scaleTo(src, ex.w, ex.h), heroQuality)
	if err != nil {
		return err
	}
	return writeFile(filepath.Join(out, "gallery", ex.name+"-normal.jpg"), naive)
}
