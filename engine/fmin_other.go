//go:build !wasm

package engine

// fmin and fmin3: the builtin min compiles to fast min instructions on native targets.
// See fmin_wasm.go for why wasm uses plain comparisons instead.
func fmin(a, b float64) float64 { return min(a, b) }

func fmin3(a, b, c float64) float64 { return min(a, b, c) }
