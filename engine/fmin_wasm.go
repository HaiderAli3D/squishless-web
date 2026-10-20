//go:build wasm

package engine

// fmin and fmin3 are min for the finite float64 values of the dp map. On wasm they are
// plain comparisons: the builtin min must handle NaN and signed zeros, which makes it
// several times slower there and made it the main cost of updateDP (the hot loop of the
// browser engine). dp values are never NaN, and a -0 can only stand where +0 compares
// equal, so the results are the same bit for bit as with the builtin (see fmin_other.go).
func fmin(a, b float64) float64 {
	if b < a {
		return b
	}
	return a
}

func fmin3(a, b, c float64) float64 {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}
