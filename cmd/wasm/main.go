//go:build js && wasm

// Command wasm is the js/wasm entry point of the Squishless engine. It runs inside a
// Web Worker (or Node) after wasm_exec.js and exposes the `squishless` global:
//
//	squishless.version
//	squishless.resize(rgba, w, h, opts, onProgress) -> { rgba, width, height }
//	squishless.seamOrder(rgba, w, h, opts)          -> { order, axis, maxSeams }
//
// See ARCHITECTURE.md ("Wasm API"). Both calls are synchronous.
//
// Errors: a Go js.Func cannot throw into its JS caller (a Go panic would kill the
// runtime), so the raw functions return a JS Error object on failure. glue.js, which
// scripts/build-site.sh appends to dist/engine/wasm_exec.js, defines
// globalThis.__squishlessInstall; main hands it the raw API and it installs
// self.squishless with wrappers that throw those Errors. Without the glue the raw API is
// installed as is (failures are then returned, not thrown). Panics inside a call are
// recovered and reported the same way, so the next call still works.
package main

import (
	"context"
	"errors"
	"fmt"
	"image"
	"math"
	"runtime"
	"syscall/js"
	"unsafe"

	"github.com/HaiderAli3D/squishless-web/engine"
)

// version identifies the engine build; scripts/build-site.sh may override it with
// -ldflags "-X main.version=...".
var version = "1.0.0"

func main() {
	api := js.Global().Get("Object").New()
	api.Set("version", version+" ("+runtime.Version()+")")
	api.Set("resize", js.FuncOf(guard(resize)))
	api.Set("seamOrder", js.FuncOf(guard(seamOrder)))
	if install := js.Global().Get("__squishlessInstall"); install.Type() == js.TypeFunction {
		install.Invoke(api)
	} else {
		js.Global().Set("squishless", api)
	}
	select {}
}

// guard turns a Go error, or a recovered panic, into a JS Error value returned to the glue.
func guard(fn func(args []js.Value) (any, error)) func(this js.Value, args []js.Value) any {
	return func(this js.Value, args []js.Value) (ret any) {
		defer func() {
			if r := recover(); r != nil {
				msg := fmt.Sprint(r)
				if je, ok := r.(js.Error); ok {
					msg = je.Error()
				}
				ret = jsError("squishless: internal error: " + msg)
			}
		}()
		v, err := fn(args)
		if err != nil {
			return jsError(err.Error())
		}
		return v
	}
}

func jsError(msg string) js.Value {
	return js.Global().Get("Error").New(msg)
}

func arg(args []js.Value, i int) js.Value {
	if i < len(args) {
		return args[i]
	}
	return js.Undefined()
}

func nullish(v js.Value) bool { return v.IsUndefined() || v.IsNull() }

func isBytes(v js.Value) bool {
	g := js.Global()
	return v.InstanceOf(g.Get("Uint8Array")) || v.InstanceOf(g.Get("Uint8ClampedArray"))
}

// intValue reads an integer JS number in [lo, hi].
func intValue(v js.Value, name string, lo, hi int) (int, error) {
	if v.Type() != js.TypeNumber {
		return 0, fmt.Errorf("squishless: %s must be a number, got %s", name, v.Type())
	}
	f := v.Float()
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < float64(lo) || f > float64(hi) {
		return 0, fmt.Errorf("squishless: %s must be an integer in [%d, %d], got %v", name, lo, hi, f)
	}
	return int(f), nil
}

// optInt reads opts[name] as an integer, def when it is missing (undefined or null).
func optInt(opts js.Value, name string, def, lo, hi int) (int, error) {
	if nullish(opts) {
		return def, nil
	}
	v := opts.Get(name)
	if nullish(v) {
		return def, nil
	}
	return intValue(v, "opts."+name, lo, hi)
}

// maxDim bounds each image dimension; the JS side enforces the real pixel budget.
const maxDim = 1 << 16

// readImage reads (rgba, w, h) and copies the pixels into Go memory.
func readImage(args []js.Value) (pix []byte, w, h int, err error) {
	src := arg(args, 0)
	if !isBytes(src) {
		return nil, 0, 0, errors.New("squishless: rgba must be a Uint8Array or Uint8ClampedArray")
	}
	if w, err = intValue(arg(args, 1), "width", 1, maxDim); err != nil {
		return nil, 0, 0, err
	}
	if h, err = intValue(arg(args, 2), "height", 1, maxDim); err != nil {
		return nil, 0, 0, err
	}
	n := 4 * w * h
	if l := src.Get("length").Int(); l != n {
		return nil, 0, 0, fmt.Errorf("squishless: rgba has %d bytes, want %d for %dx%d", l, n, w, h)
	}
	pix = make([]byte, n)
	js.CopyBytesToGo(pix, src)
	return pix, w, h, nil
}

// readOptions reads the options shared by resize and seamOrder.
func readOptions(opts js.Value, w, h int) (engine.Options, error) {
	var o engine.Options
	if !nullish(opts) && opts.Type() != js.TypeObject {
		return o, errors.New("squishless: opts must be an object")
	}
	var err error
	if o.BlurRadius, err = optInt(opts, "blur", engine.DefaultBlurRadius, 0, 1000); err != nil {
		return o, err
	}
	o.SobelThreshold = engine.DefaultSobelThreshold
	if !nullish(opts) {
		o.ProtectFaces = opts.Get("faces").Truthy()
		if s := opts.Get("sobel"); !nullish(s) {
			if s.Type() != js.TypeNumber || math.IsNaN(s.Float()) {
				return o, errors.New("squishless: opts.sobel must be a number")
			}
			o.SobelThreshold = float32(s.Float())
		}
		if o.Protect, err = readMask(opts.Get("protect"), "protect", w, h); err != nil {
			return o, err
		}
		if o.Remove, err = readMask(opts.Get("remove"), "remove", w, h); err != nil {
			return o, err
		}
	}
	return o, nil
}

func readMask(v js.Value, name string, w, h int) (*image.Gray, error) {
	if nullish(v) {
		return nil, nil
	}
	if !isBytes(v) {
		return nil, fmt.Errorf("squishless: opts.%s must be a Uint8Array or null", name)
	}
	if l := v.Get("length").Int(); l != w*h {
		return nil, fmt.Errorf("squishless: opts.%s has %d bytes, want %d (1 byte per pixel)", name, l, w*h)
	}
	b := make([]byte, w*h)
	js.CopyBytesToGo(b, v)
	return engine.MaskFromBytes(b, w, h), nil
}

// resize(rgba, w, h, opts, onProgress) -> { rgba: Uint8Array, width, height }
func resize(args []js.Value) (any, error) {
	pix, w, h, err := readImage(args)
	if err != nil {
		return nil, err
	}
	opts := arg(args, 3)
	o, err := readOptions(opts, w, h)
	if err != nil {
		return nil, err
	}
	if o.Width, err = optInt(opts, "width", 0, 0, 4*maxDim); err != nil {
		return nil, err
	}
	if o.Height, err = optInt(opts, "height", 0, 0, 4*maxDim); err != nil {
		return nil, err
	}
	var progress func(float64)
	switch cb := arg(args, 4); {
	case nullish(cb):
	case cb.Type() == js.TypeFunction:
		progress = func(f float64) { cb.Invoke(f) }
	default:
		return nil, errors.New("squishless: onProgress must be a function or null")
	}
	out, ow, oh, err := engine.ResizeRGBA(context.Background(), pix, w, h, o, progress)
	if err != nil {
		return nil, err
	}
	pix = nil
	dst := js.Global().Get("Uint8Array").New(len(out))
	js.CopyBytesToJS(dst, out)
	res := js.Global().Get("Object").New()
	res.Set("rgba", dst)
	res.Set("width", ow)
	res.Set("height", oh)
	return res, nil
}

// seamOrder(rgba, w, h, opts) -> { order: Uint16Array, axis, maxSeams }
func seamOrder(args []js.Value) (any, error) {
	pix, w, h, err := readImage(args)
	if err != nil {
		return nil, err
	}
	opts := arg(args, 3)
	o, err := readOptions(opts, w, h)
	if err != nil {
		return nil, err
	}
	axis, name := engine.AxisX, "x"
	if !nullish(opts) {
		switch a := opts.Get("axis"); {
		case nullish(a):
		case a.Type() == js.TypeString && a.String() == "x":
		case a.Type() == js.TypeString && a.String() == "y":
			axis, name = engine.AxisY, "y"
		default:
			return nil, errors.New("squishless: opts.axis must be 'x' or 'y'")
		}
	}
	maxSeams := math.MaxInt32
	if !nullish(opts) && !nullish(opts.Get("maxSeams")) {
		v := opts.Get("maxSeams")
		if v.Type() != js.TypeNumber || math.IsNaN(v.Float()) {
			return nil, errors.New("squishless: opts.maxSeams must be a number")
		}
		maxSeams = int(math.Max(math.MinInt32, math.Min(math.MaxInt32, math.Floor(v.Float()))))
	}
	n := engine.ClampSeams(w, h, axis, maxSeams)
	order, err := engine.SeamOrder(context.Background(), pix, w, h, o, axis, n)
	if err != nil {
		return nil, err
	}
	pix = nil
	dst := js.Global().Get("Uint16Array").New(len(order))
	if len(order) > 0 {
		// wasm and every JS engine we target are little-endian, so the raw bytes of the
		// []uint16 are the Uint16Array's bytes.
		view := js.Global().Get("Uint8Array").New(dst.Get("buffer"), 0, 2*len(order))
		js.CopyBytesToJS(view, unsafe.Slice((*byte)(unsafe.Pointer(&order[0])), 2*len(order)))
	}
	res := js.Global().Get("Object").New()
	res.Set("order", dst)
	res.Set("axis", name)
	res.Set("maxSeams", n)
	return res, nil
}
