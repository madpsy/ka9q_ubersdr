# PCM v4 decoder in WebAssembly

A WebAssembly build of the browser's lossless PCM v4 decoder: the Rice bitstream
and the adaptive predictor of `src/radio/pcm-v4.js`, in C, compiled twice (with
and without WebAssembly SIMD) and embedded in the v2 bundle as base64.

**Wired in for IQ.** `audio-connection.js` decodes every IQ stream (profiles 0
and 2, plain IQ through iq384) with it wherever it loads; demodulated audio
(profile 1) stays on `pcm-v4.js`. How, and why the handover is safe, is at the
end.

## Why

PCM v4 is decoded on the main thread, packet by packet, for every IQ and
lossless-audio session. In JavaScript that costs about 220 ns a frame once the
JIT has warmed up (more before): over 8% of a core at iq384, all of it on the
thread that also renders the spectrum. The SIMD build does the same work in
about 50 ns, the scalar build in about 130, with output identical to the bit.
`bench.js` measures it; the numbers below are from a Ryzen 7 5700U under node 20.

## Files

| file | what | who changes it |
|---|---|---|
| `pcmv4.h` | shared types, constants, the JavaScript's helpers in C, error codes, the internal interfaces between the files | anyone, carefully |
| `iq.c` | the complex order-16 stage (profiles 0 and 2): per-frame path plus the SIMD128 block kernel, with a scalar-integer kernel when built without SIMD | IQ optimiser |
| `audio.c` | the real cascade, orders 8/8/4/2 (profile 1): per-frame path | audio optimiser |
| `rice.c` | the Rice decoder: a fast int32 one and a wide one for corrupt bodies | bitstream optimiser |
| `api.c` | the exported ABI, profile lifecycle, shared scratch buffers | API owner |
| `shim.c` | freestanding runtime: allocator, `memset`/`memcpy`/`memmove` | rarely |
| `build.sh`, `embed.js` | build both modules, strip, embed into `../../src/radio/pcm-v4-wasm.generated.js` | |
| `test.js` | bit-exactness against the JavaScript decoder, plus fuzz | |
| `bench.js` | cost per frame and per mode | |
| `fixtures.js` | loads the streams and builds the node bundles for the two above | |
| `testdata/` | server-encoded streams; see below | regenerated, never edited |

The JavaScript side is `../../src/radio/pcm-v4-wasm.js` (the wrapper) and
`../../src/radio/pcm-v4-wasm.generated.js` (the embedded modules, generated).

The C is split so the four optimisable parts can be worked on in parallel
without touching each other: `iq.c`, `audio.c`, `rice.c` and `api.c` each
depend only on `pcmv4.h`, and the interfaces between them are declared there.

## The exactness contract

The reference is **`PCMv4StreamDecoder` in `pcm-v4.js`**, not the server's Go and
not the other native clients. This module replaces that decoder in place, so it
must return what that decoder returns: the same `null` for every packet it
refuses, the same metadata, and Float32 planes identical bit for bit.

On every stream the server can send, the JavaScript, the Go and every integer
port agree, because taps are clamped to 2^24 and samples are 16-bit, so every
value stays an exact integer in a double. On a corrupt stream they do not: a bad
Rice body can carry residuals up to 2^49, the history then exceeds 2^24, products
pass 2^53 and the JavaScript starts rounding, and a few frames later reaches
Infinity and NaN. The JavaScript also never clamps a reconstructed sample to
int16, so a corrupt packet decodes to audio past full scale. An integer codec
diverges from all of that. This one does not, by construction:

- The canonical predictor state is the JavaScript's: doubles, tap 0 on the newest
  sample (`pv4_stage` in `pcmv4.h`).
- The per-frame paths in `iq.c` and `audio.c` are the JavaScript transcribed into
  C doubles, same operations in the same order, compiled with
  `-ffp-contract=off`. They are exact on any input.
- A fast path may use integers only while that is provably the same as the
  doubles: every history value in the window below 2^24 in magnitude and every
  residual inside int32 (`PV4_INT_SAFE` in `pcmv4.h`). The IQ block kernel checks
  this on entry and leaves before taking in a sample outside it; the per-frame
  path carries on from the canonical state. The Rice decoder returns `PV4_WIDE`
  on a value past int32, and the body is decoded again by `pv4_rice_decode_wide`,
  which is the JavaScript's `riceDecode` in double arithmetic.
- Every refusal leaves the predictor untouched, as the JavaScript does by
  decoding the whole body before stepping a stage.
- The wrapper mirrors the JavaScript's header code line for line, including the
  state a refused packet still changes (a new profile resets the predictor even
  when the packet is then refused) and its allocations: the output planes are
  allocated before the body is examined, and its residual buffer
  (`new Float64Array(count)` whenever `count` is the largest yet) is allocated at
  the same points, so a header claiming an absurd sample count throws the same
  `RangeError` from both decoders.

The one thing that cannot be matched is **the bit pattern of a NaN**. Both
decoders produce NaN at the same samples, but neither WebAssembly nor JavaScript
specifies a NaN's sign or payload; in the fuzz about half of them differ in bits.
`test.js` treats NaN as equal to NaN for that reason and no other.

Also by design, not by accident: the module grows its memory to the largest
packet seen. If a body is so large that WebAssembly memory cannot grow (near
4 GB), the wrapper throws `out of memory` where the JavaScript would have decoded
it; no real packet is within five orders of magnitude of that.

## Building

```sh
./build.sh           # build both modules and regenerate ../../src/radio/pcm-v4-wasm.generated.js
./build.sh --check   # build, and fail if the committed generated file is stale
```

Needs clang and wasm-ld (LLVM 18 was used: `clang-18`, `wasm-ld-18` or
`/usr/lib/llvm-18/bin/wasm-ld`) and node. No emscripten, no wasi-sysroot, no libc:
the module is freestanding and imports nothing.

- SIMD build: `-mcpu=generic -msimd128`. Scalar build: `-mcpu=mvp`, for the oldest
  engines, which are the ones that need it.
- Both: `-O3 -g0 -ffreestanding -nostdlib -ffp-contract=off`, linked with
  `--no-entry --strip-all --stack-first`, 64 kB stack. `embed.js` then drops every
  custom section, including `producers`.
- Deterministic: the same sources and toolchain give the same bytes. The generated
  file records a SHA-256 of the sources, and `test.js` fails if it does not match
  the tree, so a forgotten rebuild cannot pass.
- Size: about 16 kB per module, 44 kB for the generated file with both.

The objects and the stripped `.wasm` files are left in `.build/` (git-ignored).

## Testing

```sh
node test.js         # from this directory or any other
```

Needs node and esbuild only; it tests the modules embedded in the generated file,
so it needs no C toolchain. It bundles `pcm-v4.js` and `pcm-v4-wasm.js` with
esbuild into `.build/` (it does not use `static/v2/test/run.sh`).

What it checks, with both builds against the JavaScript decoder:

- every packet of every fixture stream (below), plus the browser's existing
  fixtures `static/v2/test/pcmv4.sample.bin`, `pcmv4scaled.sample.bin` and the
  three v4 streams in `pcmcpu.sample.bin`;
- the JavaScript reference itself against a hash of the **server decoder's**
  output for each stream in `testdata/`, so the reference is pinned to the Go;
- that on clean streams every IQ frame went through the block kernel, and that
  the per-frame IQ path alone (kernel switched off) is identical as well;
- joining part-way through each stream, and `reset()` mid-stream;
- fuzz: real streams with bits flipped, truncated, extended, and with `k`
  rewritten to anything from 0 to 31; synthetic packets with random profiles
  (including unknown ones), channel counts that disagree with the profile, counts,
  modes and bodies; counts too large for their bodies and too large to allocate;
  bodies built to drive residuals past int32 and a trained predictor on to
  Infinity and NaN, asserting that the wide decoder and the kernel hand-over both
  ran; and a clean stream decoded after a corrupt one on the same decoders;
- that decoders can be created and disposed indefinitely without the module's
  memory growing.

### Fixtures

`testdata/*.v4` are real captures from `testdata/pcm_predictive/` coded by the
**server's** encoder, with silent and escape packets forced into each:

| file | profile | content |
|---|---|---|
| `iq12k-ft8.v4` | 0 | IQ 12 kHz, the IQ mode the browser offers |
| `iq384-ft8.v4` | 0 | 384 kHz, busy band: the throughput case |
| `iq384-mw-carriers.v4` | 0 | 384 kHz, strong carriers: long unary runs; packets split so the count varies |
| `iq384-quiet-band.v4` | 0 | 384 kHz, empty band, nearly white |
| `usb-ft8.v4`, `lsb-voice.v4`, `cw.v4` | 1 | 12 kHz demodulated audio (usb with varying counts) |
| `am.v4`, `nfm.v4` | 1 | 24 kHz demodulated audio |
| `iq384-scaled.v4` | 2, 0 | reduced depth with a moving margin: the shift changes per packet and the profile goes 2 -> 0 -> 2 |
| `mixed-modes.v4` | 1, 0 | lsb -> iq12k -> am: the profile changes twice mid-stream |

`manifest.json` lists each with its packet, sample and body-mode counts and the
SHA-256 of the server decoder's output. Layout: `"UV4F"`, a format byte, a
uint32 packet count, then each packet as a uint32 length and its bytes (the same
as the native clients' conformance fixtures). Regenerate, from the repo root:

```sh
GEN_WASM_FIXTURE=1 go test -short -run TestGenerateWasmFixtures -v .
```

(`pcm_v4_wasm_fixture_test.go`; it skips unless the variable is set.)

## Benchmarking

```sh
node bench.js [--native-dir=<dir>] [--quick]
```

Decodes each stream start to finish with a fresh decoder per pass, header parse
and plane copies included, and reports ns per frame and the share of a core at
the mode's real rate for the JavaScript decoder, both WebAssembly builds and a
native baseline: `clients/python/pcm_v4_native.c` (AVX2) built with
`gcc -O2 -march=native` into `--native-dir`, outside the tree. The native figure is
a floor for the codec, not a like-for-like decoder: it outputs int16 and parses
no header. iq48/96/192 are extrapolated from the 384 kHz captures' per-frame cost.

Ryzen 7 5700U, node 20.19, ns per frame / share of one core:

| mode | JS | wasm scalar | wasm SIMD | native AVX2 |
|---|---|---|---|---|
| usb/lsb/cw 12k | 226 / 0.27% | 110 / 0.13% | 111 / 0.13% | 58 / 0.07% |
| am/nfm 24k | 213 / 0.51% | 98 / 0.23% | 99 / 0.24% | 55 / 0.13% |
| iq 12k | 216 / 0.26% | 131 / 0.16% | 52 / 0.06% | 28 / 0.03% |
| iq96 (extrapolated) | 218 / 2.1% | 129 / 1.2% | 51 / 0.49% | 29 / 0.27% |
| iq384 | 218 / 8.4% | 129 / 5.0% | 51 / 2.0% | 29 / 1.1% |
| iq384 scaled | 219 / 8.4% | 127 / 4.9% | 48 / 1.9% | 27 / 1.0% |

The JavaScript figures are after a long warm-up. Cold, the gap is wider: over the
first 60 packets of a fresh iq384 stream in a fresh process the JavaScript cost
about 1060-1090 ns a frame and the SIMD build 130-160.

The audio cascade has no SIMD or integer path yet (`audio.c` explains how one
would be added and what it must check), so its two builds are the same code.

## ABI

`PV4_ABI_VERSION` is **1**. The wrapper refuses a module reporting any other.
All exports take and return i32; pointers are offsets into the exported `memory`.

| export | |
|---|---|
| `pv4_abi() -> int` | the ABI version |
| `pv4_simd() -> int` | 1 if this is the SIMD build |
| `pv4_codec_new() -> handle` | a codec with no profile; 0 when memory cannot grow |
| `pv4_codec_free(handle)` | |
| `pv4_codec_reset(handle) -> rc` | back to no profile |
| `pv4_codec_profile(handle, id) -> rc` | select profile 0, 1 or 2; the same id keeps the adaptation, a different one starts cold; any other id is refused and changes nothing |
| `pv4_input(len) -> ptr` | a buffer for a body of `len` bytes (followed by 16 zero bytes a decoder may read); 0 when memory cannot grow |
| `pv4_decode(handle, len, count, mode, shift) -> frames` | decode the body at `pv4_input()`: `count` int16 samples, `mode` 0 Rice / 1 escape, `shift` 0-15; negative for a body the JavaScript refuses (-6 is out of memory) |
| `pv4_plane(which) -> ptr` | plane 0 (I, or the audio) and plane 1 (Q), `frames` floats each, already scaled by 1/32768 x 2^shift |
| `pv4_silent(handle, count) -> rc` | advance the predictor over `count` zero samples |
| `pv4_counter(i)`, `pv4_counters_reset()` | path counters for tests and benchmarks: kernel frames, per-frame frames, kernel hand-overs, wide bodies |
| `pv4_set_kernel(on)` | tests only: 0 sends every IQ frame through the per-frame path |

No allocation happens per packet in the steady state: the input buffer, residual
buffer and planes are shared by every codec in an instance (decoding is
synchronous) and grow by doubling to the largest packet seen. Growing memory
detaches JavaScript views, so the wrapper rebuilds its views whenever
`memory.buffer` changes.

## Browser support

- **SIMD build:** WebAssembly SIMD, as shipped: Chrome 91, Firefox 89, Safari 16.4
  and later (and Electron, and Android WebView 91+). Chosen when
  `WebAssembly.validate` accepts a tiny module using a SIMD instruction.
- **Scalar build:** anywhere WebAssembly runs (built for the MVP feature set),
  for older Safari in particular.
- **Neither:** `loadPCMv4Wasm()` rejects, and the caller keeps the JavaScript
  decoder.

Compiling is asynchronous (Chrome refuses synchronous compiles over 4 kB on the
main thread), so a decoder comes from a promise: `PCMv4WasmStreamDecoder.create()`,
or `loadPCMv4Wasm()` once and `new PCMv4WasmStreamDecoder(runtime)` per
connection. `decoder.backend` is `'wasm-simd'` or `'wasm-scalar'`;
`pcmV4WasmStatus()` reports `{ state, backend, error }` for a Stats panel or a
fallback decision.

**CSP:** a page served with a `Content-Security-Policy` must allow
`'wasm-unsafe-eval'` in `script-src` (or `'unsafe-eval'`) to compile any
WebAssembly. The v2 page carries no CSP today -- not from the server, nor in the
Electron or Capacitor builds (their receiver-chooser pages have one, and do not
run the decoder) -- but if one is added this decoder needs that source,
and without it `loadPCMv4Wasm()` rejects -- which must mean "use the JavaScript
decoder", never "no audio".

## How it is wired in

`audio-connection.js` is the only consumer:

1. It starts `loadPCMv4Wasm()` once, when the file loads, and keeps the runtime
   when it resolves. Nothing waits on it; until then, and wherever it cannot
   load, everything decodes in JavaScript as before.
2. Each connection keeps both decoders: `this.pcmV4` (JavaScript) and
   `this.pcmV4Wasm`, made the first time an IQ stream finds the runtime ready.
   `_v4DecoderFor` reads the profile from each packet's flags byte and sends IQ
   (profiles 0 and 2) to the WebAssembly decoder and audio (profile 1) to the
   JavaScript one.
3. A stream changes hands only where no predictor state carries over: the first
   packet after `reset()`, and a change between IQ and audio on a live socket.
   The second is safe because the server rebuilds its predictor on a profile
   change (`pcm_v4_stream.go`), and the change of channel count that causes it
   forces a full header -- metadata, absolute timestamp, count and quality
   (`needsResync` in `pcm_v4_header.go`) -- so a freshly reset decoder reads
   that packet exactly as the one in hand would have. A periodic
   resynchronisation is not such a point (the predictor runs on through it), so
   a module that loads part way through an IQ stream waits for the next
   boundary.
4. `v4Decoder` on the connection says what decoded the last packet (`'js'`,
   `'wasm-simd'` or `'wasm-scalar'`), and the Stats panel shows it on the
   Lossless card.

The decoder is dropped with its connection and its codec freed on garbage
collection. No change to `build.sh` was needed: the generated module is an
ordinary import.
