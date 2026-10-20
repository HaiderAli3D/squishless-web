package engine

import "fmt"

// SeamPaths turns an AxisX SeamOrder map of a w*h image into the paths of the removed
// vertical seams, in the coordinates of the shrinking image.
//
// paths[s][y] is the column, in the image as it is after s removals (width w-s), of the
// pixel that seam s removes in row y. Consecutive rows of one seam differ by -1, 0 or +1
// (seams are 8-connected in the image they are removed from). Replaying the removals
// (for each seam, in each row, delete the pixel at paths[s][y]) rebuilds the order map.
//
// It returns an error when order is not a valid AxisX map: wrong length, rows that
// disagree on the number of seams, or a row whose removal steps are not 0..n-1.
func SeamPaths(order []uint16, w, h int) ([][]uint16, error) {
	if w <= 0 || h <= 0 || w > 65535 {
		return nil, fmt.Errorf("engine: invalid map size %dx%d", w, h)
	}
	if len(order) != w*h {
		return nil, fmt.Errorf("engine: order has %d entries, want %d", len(order), w*h)
	}
	n := 0
	for _, v := range order[:w] {
		if v != NeverRemoved {
			n++
		}
	}
	paths := make([][]uint16, n)
	for s := range paths {
		paths[s] = make([]uint16, h)
	}
	if n == 0 {
		return paths, nil
	}

	pos := make([]int, n)     // pos[s] = source column removed at step s (this row)
	fen := make([]int32, w+1) // Fenwick tree over source columns: 1 = already removed
	for y := 0; y < h; y++ {
		for s := range pos {
			pos[s] = -1
		}
		row := order[y*w : y*w+w]
		cnt := 0
		for x, v := range row {
			if v == NeverRemoved {
				continue
			}
			if int(v) >= n || pos[v] >= 0 {
				return nil, fmt.Errorf("engine: row %d: bad or repeated step %d", y, v)
			}
			pos[v] = x
			cnt++
		}
		if cnt != n {
			return nil, fmt.Errorf("engine: row %d removes %d pixels, row 0 removes %d", y, cnt, n)
		}
		clear(fen)
		for s := 0; s < n; s++ {
			x := pos[s]
			// columns left of x that are already gone
			gone := 0
			for i := x; i > 0; i -= i & -i {
				gone += int(fen[i])
			}
			cur := x - gone
			if y > 0 {
				if d := cur - int(paths[s][y-1]); d < -1 || d > 1 {
					return nil, fmt.Errorf("engine: seam %d jumps %d columns at row %d", s, d, y)
				}
			}
			paths[s][y] = uint16(cur)
			for i := x + 1; i <= w; i += i & -i {
				fen[i]++
			}
		}
	}
	return paths, nil
}

// OrderFromSeamPaths is the inverse of SeamPaths: it replays the removals and returns
// the AxisX order map of a w*h image (NeverRemoved for pixels no seam removes).
func OrderFromSeamPaths(paths [][]uint16, w, h int) ([]uint16, error) {
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("engine: invalid map size %dx%d", w, h)
	}
	if len(paths) >= w || len(paths) > maxOrderSeams {
		return nil, fmt.Errorf("engine: %d seams for width %d", len(paths), w)
	}
	order := make([]uint16, w*h)
	for i := range order {
		order[i] = NeverRemoved
	}
	cols := make([]uint16, w*h) // per row: source column of each remaining pixel
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			cols[y*w+x] = uint16(x)
		}
	}
	for s, p := range paths {
		if len(p) != h {
			return nil, fmt.Errorf("engine: seam %d has %d rows, want %d", s, len(p), h)
		}
		cw := w - s
		for y := 0; y < h; y++ {
			x := int(p[y])
			if x >= cw {
				return nil, fmt.Errorf("engine: seam %d row %d column %d outside width %d", s, y, x, cw)
			}
			row := cols[y*w : y*w+cw]
			order[y*w+int(row[x])] = uint16(s)
			copy(row[x:], row[x+1:])
		}
	}
	return order, nil
}
