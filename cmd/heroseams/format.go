package main

// The .seams file format (version 1). All integers are little-endian.
//
//	offset size  field
//	0      4     magic "SQSM"
//	4      1     version = 1
//	5      1     axis: 0 = vertical seams (the width shrinks); nothing else is defined
//	6      2     reserved, 0
//	8      2     width  W of the image the seams were found in (px)
//	10     2     height H (px)
//	12     2     number of seams N (N < W)
//	14     2     bytes per seam record R = 2 + ceil(2*(H-1)/8)
//	16     N*R   seam records, in removal order
//
// Seam record s describes the seam removed from the image after s earlier removals
// (width W-s), in that image's coordinates:
//
//	2 bytes      column of the seam in row 0 (0 <= x < W-s)
//	R-2 bytes    H-1 steps, 2 bits each, packed LSB first (row 1 is bits 0-1 of the
//	             first byte, row 2 bits 2-3, ...). Step codes: 0 = same column,
//	             1 = column+1, 2 = column-1 (3 is invalid). Unused bits are 0.
//
// To rebuild the per-pixel removal order (engine.SeamOrder for AxisX): keep, per row,
// the list of source columns still present; for each seam s and row y, the pixel at
// position x of that list gets order s and is deleted from the list. Pixels never
// deleted get 65535. site/assets/js/landing/seams.js implements the decoder.

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	seamsMagic   = "SQSM"
	seamsVersion = 1
	headerSize   = 16
)

func recordSize(h int) int { return 2 + (2*(h-1)+7)/8 }

// encodeSeams writes the paths (engine.SeamPaths output) of a w*h image.
func encodeSeams(paths [][]uint16, w, h int) ([]byte, error) {
	if w <= 0 || h <= 0 || w > 65535 || h > 65535 || len(paths) >= w {
		return nil, fmt.Errorf("heroseams: bad size %dx%d with %d seams", w, h, len(paths))
	}
	rs := recordSize(h)
	buf := make([]byte, headerSize+len(paths)*rs)
	copy(buf, seamsMagic)
	buf[4] = seamsVersion
	buf[5] = 0
	binary.LittleEndian.PutUint16(buf[8:], uint16(w))
	binary.LittleEndian.PutUint16(buf[10:], uint16(h))
	binary.LittleEndian.PutUint16(buf[12:], uint16(len(paths)))
	binary.LittleEndian.PutUint16(buf[14:], uint16(rs))
	for s, p := range paths {
		if len(p) != h {
			return nil, fmt.Errorf("heroseams: seam %d has %d rows, want %d", s, len(p), h)
		}
		rec := buf[headerSize+s*rs : headerSize+(s+1)*rs]
		binary.LittleEndian.PutUint16(rec, p[0])
		for y := 1; y < h; y++ {
			var code byte
			switch int(p[y]) - int(p[y-1]) {
			case 0:
				code = 0
			case 1:
				code = 1
			case -1:
				code = 2
			default:
				return nil, fmt.Errorf("heroseams: seam %d jumps at row %d", s, y)
			}
			bit := 2 * (y - 1)
			rec[2+bit/8] |= code << (bit % 8)
		}
	}
	return buf, nil
}

// decodeSeams parses a .seams file into paths and the image size.
func decodeSeams(b []byte) (paths [][]uint16, w, h int, err error) {
	if len(b) < headerSize || string(b[:4]) != seamsMagic {
		return nil, 0, 0, errors.New("heroseams: not a .seams file")
	}
	if b[4] != seamsVersion || b[5] != 0 {
		return nil, 0, 0, fmt.Errorf("heroseams: unsupported version %d / axis %d", b[4], b[5])
	}
	w = int(binary.LittleEndian.Uint16(b[8:]))
	h = int(binary.LittleEndian.Uint16(b[10:]))
	n := int(binary.LittleEndian.Uint16(b[12:]))
	rs := int(binary.LittleEndian.Uint16(b[14:]))
	if w == 0 || h == 0 || n >= w || rs != recordSize(h) || len(b) != headerSize+n*rs {
		return nil, 0, 0, errors.New("heroseams: inconsistent header")
	}
	paths = make([][]uint16, n)
	for s := range paths {
		rec := b[headerSize+s*rs : headerSize+(s+1)*rs]
		p := make([]uint16, h)
		x := int(binary.LittleEndian.Uint16(rec))
		p[0] = uint16(x)
		for y := 1; y < h; y++ {
			bit := 2 * (y - 1)
			switch (rec[2+bit/8] >> (bit % 8)) & 3 {
			case 1:
				x++
			case 2:
				x--
			case 3:
				return nil, 0, 0, fmt.Errorf("heroseams: seam %d row %d: invalid step", s, y)
			}
			if x < 0 || x >= w-s {
				return nil, 0, 0, fmt.Errorf("heroseams: seam %d row %d: column %d out of range", s, y, x)
			}
			p[y] = uint16(x)
		}
		paths[s] = p
	}
	return paths, w, h, nil
}
