//go:build js && wasm

// main_js.go — the WebAssembly module's face to the page.
//
// Run once, in the audio classifier's worker (src/lib/audioClass/worker.entry.js),
// it puts one object on the global scope and then parks:
//
//	audioclass.load(Uint8Array)    the model's .pt file; returns "" or an error
//	audioclass.reset(rate)         a new stream rate, or a retune: drops the audio held
//	audioclass.push(Uint8Array)    float32 samples at that rate, as bytes
//	audioclass.classify(seconds)   a windowResult as JSON, or "" when too little is held
//
// Samples cross as the bytes of a Float32Array because syscall/js copies only
// byte arrays; WebAssembly is little-endian, as is every browser's Float32Array,
// so the bytes are the floats.
package main

import (
	"encoding/json"
	"syscall/js"
	"unsafe"
)

func main() {
	var s stream
	api := js.Global().Get("Object").New()

	api.Set("load", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 1 {
			return "no model"
		}
		b := make([]byte, args[0].Get("byteLength").Int())
		js.CopyBytesToGo(b, args[0])
		// One thread: goroutines in Go's WebAssembly all run on the one the
		// worker has, so asking for more would only add scheduling.
		m, err := loadEfficientAT(b, "mn05", eatWidths["mn05"], 1)
		if err != nil {
			return err.Error()
		}
		s.model = m
		return ""
	}))

	api.Set("reset", js.FuncOf(func(_ js.Value, args []js.Value) any {
		rate := 0
		if len(args) > 0 {
			rate = args[0].Int()
		}
		s.reset(rate)
		return nil
	}))

	var scratch []float32
	api.Set("push", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 1 {
			return nil
		}
		n := args[0].Get("byteLength").Int() / 4
		if n == 0 {
			return nil
		}
		if cap(scratch) < n {
			scratch = make([]float32, n)
		}
		f := scratch[:n]
		js.CopyBytesToGo(unsafe.Slice((*byte)(unsafe.Pointer(&f[0])), n*4), args[0])
		s.push(f)
		return nil
	}))

	api.Set("classify", js.FuncOf(func(_ js.Value, args []js.Value) any {
		sec := 5.0
		if len(args) > 0 {
			sec = args[0].Float()
		}
		res, ok := s.classify(sec)
		if !ok {
			return ""
		}
		b, _ := json.Marshal(res)
		return string(b)
	}))

	api.Set("buffered", js.FuncOf(func(js.Value, []js.Value) any {
		return s.buffered()
	}))

	js.Global().Set("audioclass", api)
	select {}
}
