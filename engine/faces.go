package engine

import (
	_ "embed"
	"fmt"
	"image"
	"sync"

	pigo "github.com/esimov/pigo/core"
)

//go:embed facefinder
var cascadeFile []byte

var (
	detOnce sync.Once
	det     *pigo.Pigo
	detErr  error
)

func classifier() (*pigo.Pigo, error) {
	detOnce.Do(func() {
		det, detErr = pigo.NewPigo().Unpack(cascadeFile)
		if detErr != nil {
			detErr = fmt.Errorf("engine: unpacking face cascade: %w", detErr)
		}
	})
	return det, detErr
}

// faceQuality is the minimum detection score kept.
const faceQuality = 5

// detectFaces returns face rectangles (enlarged by 20%) in image coordinates.
func detectFaces(pix []uint32, w, h int) ([]image.Rectangle, error) {
	pg, err := classifier()
	if err != nil {
		return nil, err
	}
	gray := make([]uint8, w*h)
	for i, p := range pix[:w*h] {
		r, g, b := p&0xff, (p>>8)&0xff, (p>>16)&0xff
		gray[i] = uint8((299*r + 587*g + 114*b) / 1000)
	}
	maxSize := max(w, h)
	cp := pigo.CascadeParams{
		MinSize:     20,
		MaxSize:     maxSize,
		ShiftFactor: 0.1,
		ScaleFactor: 1.1,
		ImageParams: pigo.ImageParams{Pixels: gray, Rows: h, Cols: w, Dim: w},
	}
	dets := pg.RunCascade(cp, 0)
	dets = pg.ClusterDetections(dets, 0.2)
	var out []image.Rectangle
	for _, d := range dets {
		if d.Q < faceQuality {
			continue
		}
		half := int(float64(d.Scale) * 0.6)
		out = append(out, image.Rect(d.Col-half, d.Row-half, d.Col+half, d.Row+half))
	}
	return out, nil
}
