# The audio classifier, in C, for WebAssembly

The v2 page's audio classifier (VOICE / MUSIC / NOISE above the spectrum,
`src/lib/audioClass/`) runs this: EfficientAT's mn05 AudioSet tagger on the
receiver's demodulated audio, folded to a verdict by NightDX's rules, plus the
640-number embedding the network computes on the way.

It replaced a Go implementation compiled to WebAssembly (ported from
ubersdr_airsplice's `efficientat.go`; see git history). Go's WebAssembly
target cannot emit SIMD, carries Go's runtime in the module, and copies every
call's data across `syscall/js`. This is freestanding C (no libc, no imports),
built twice, with and without WebAssembly SIMD, like `../pcmv4`.

| | per 5 s window (CPU) | model load | resampling, per second of audio | size |
|---|---|---|---|---|
| this, WebAssembly SIMD | ~33 ms | ~45 ms | ~2 ms | 61 kB |
| this, scalar | ~65 ms | ~48 ms | ~2 ms | 52 kB |
| the Go module it replaced | ~208 ms | ~393 ms | ~20 ms | 3.75 MB |

CPU time (`process.cpuUsage`) under node 24 on a Ryzen desktop, `bench.js`.
SIMD runs in Chrome 91, Firefox 89, Safari 16.4 and later; the worker falls
back to the scalar build elsewhere. Both builds are carried, base64, in the
classifier's worker bundle; only the weights are fetched
(`static/v2/audioclass/mn05_as_mAP_443.pt`).

## Exactness

Both builds give the Go module's numbers **to the last bit**: every one of the
527 class probabilities and the 640 numbers of the embedding.

- The arithmetic is the Go's, operation for operation, in the same precision
  (float32 where it used float32, float64 where it used float64).
- `exp`, `log`, `sin` and `cos` are Go's own (`gomath.c`): Go's WebAssembly
  build ran its portable math code, not a platform library, so that is what
  had to be matched. `floor` and `sqrt` are WebAssembly instructions in both.
- Only loops whose every output element is an independent chain of the same
  operations run several at a time (the pointwise and depthwise convolutions
  four floats at a time, the FFT's butterflies two doubles at a time). Sums
  along a vector (the mel bands, the resampler, the dense layers) stay
  left-to-right and scalar, as Go's were.
- Speed-ups that keep the result: the FFT's twiddles are tabulated by the
  Go's own recurrence instead of recomputed per block; the pointwise
  convolutions do four output channels per pass over the input.

`test.js` holds it to that: `testdata/wasm_parity.json` records what the Go
module computed (all 527 probabilities and the embedding, by hash) for a set
of deterministic signals streamed in as the page streams them, and
`testdata/efficientat_golden.json` holds outputs from an independent PyTorch
run on the official weights.

After a **deliberate** change to the arithmetic, the parity file is
re-recorded from this module (check the new verdicts by hand first):

```
AUDIOCLASS_RECORD_PARITY=1 node test.js
```

## Files

| File | What |
|---|---|
| `audioclass.h` | types, constants, the ABI version, how the files fit together |
| `api.c` | the exports: load, reset, push, classify, results |
| `pt.c` | the `.pt` reader: zip directory and the pickle subset of a state dict |
| `model.c` | the mel front end and the network |
| `resample.c` | the streaming windowed-sinc resampler (the stream's rate to 32 kHz) |
| `verdict.c` | AudioSet tags to voice / music / noise (NightDX) |
| `kernels.c` | the float32 loops, with and without SIMD |
| `gomath.c` | Go's `exp`, `log`, `sin`, `cos`, `Round` |
| `shim.c` | memory and `mem*`: no libc |
| `audioset_labels.csv` | the AudioSet class names in output order (EfficientAT's metadata) |
| `gen_labels.js` | those labels into a C header |
| `build.sh`, `embed.js` | build both modules and write `../../src/lib/audioClass/audioclass-wasm.generated.js` |
| `test.js`, `bench.js`, `testdata/` | the tests, their references, and the benchmark |

## Building and testing

```
./build.sh            # needs clang and wasm-ld (LLVM 18) and node; writes the generated JS
./build.sh --check    # fails if the committed generated JS is not these sources' build
node test.js          # needs only node: uses the committed build (also run by test/run.sh)
node bench.js         # CPU time per window, both builds
```

The build is deterministic: the same sources and toolchain give the same
bytes. The generated file records a hash of the sources, and `test.js` fails
if it is stale. After `./build.sh`, rebuild the page (`static/v2/build.sh`) so
`dist/audioclass-worker.js` carries the new module.

## The module's interface

`../../src/lib/audioClass/workerHost.js` is the only caller in the page.

| Export | |
|---|---|
| `ac_abi()` | `AC_ABI_VERSION`; the JS refuses a module that does not match |
| `ac_model_buffer(bytes)` → ptr | room for the `.pt` file; the caller copies it there |
| `ac_load()` → 0 / 1 | build the model; on 1, `ac_error()` / `ac_error_len()` say why |
| `ac_reset(rate)` | a new stream rate, or a retune: drops the audio held |
| `ac_input()` → ptr, `ac_input_capacity()` | room for that many float32 samples ... |
| `ac_push(n)` | ... of which the first `n` are new audio at the stream rate |
| `ac_classify(seconds)` → 0 / 1 | 1: a verdict on the newest `seconds` (1-10) is in `ac_result()`; 0: too little audio, or no model |
| `ac_result()` → ptr | `ac_result` (see `audioclass.h`): verdict, confidence, up to five tags, seconds |
| `ac_label(i)`, `ac_label_len(i)` | AudioSet class names, UTF-8 |
| `ac_probs()`, `ac_embedding()`, `ac_embedding_size()` | the window's 527 probabilities and its 640-number embedding |

and, for the tests and the benchmark only, `ac_test_buffer`, `ac_window`,
`ac_mel`, `ac_mel_frames`, `ac_test_resample`, `ac_pt_*`, `ac_bench_mel`.

Memory is one arena in nested regions (`shim.c`): the model (from
`ac_model_buffer`), then the stream (from `ac_reset`). Loading moves the built
model down over the file it was read from, so the 5.9 MB of `.pt` does not
stay resident. Pointers into a region are good until it is recreated; the
caller asks for `ac_input()` again after a reset.

## Licences

EfficientAT (the network and its weights) is MIT, Copyright (c) 2022 Florian
Schmid. The voice / music / noise rules are NightDX's (MIT, Marco Zennaro).
The AudioSet labels are Google's, CC BY 4.0. `gomath.c` transcribes Go's math
package, BSD, Copyright (c) 2009 The Go Authors. See
`../../audioclass/README.md`.
