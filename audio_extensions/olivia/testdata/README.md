# Olivia test vectors

Generated once by `gen_vectors.cpp`, which drives Pawel Jalocha's MFSK
transmitter, receiver and primitives — the header fldigi carries as
`src/include/jalocha/pj_mfsk.h` — and writes down what they produced.

Nothing in the Go tests reads fldigi. These files are the record, and the tests
must keep passing on a machine that has never had that source. The generator is
kept so the vectors can be regenerated or extended, not because anything builds
it: `testdata` is ignored by the Go tool.

## What is here

| File | Contents |
| --- | --- |
| `vectors.json` | Gray-code tables over the full byte range, three Hadamard transforms, a low-pass step response, the geometry of eighteen mode/centre combinations, and the metadata for the audio below |
| `olivia_*.s8.gz` | Real Olivia audio from the reference transmitter, 12 kHz, gzipped 8-bit PCM |

The audio is 8-bit purely for size. Olivia's soft demapper works on ratios of
tone energies and copies at around -10 dB SNR, so 8 bits leaves roughly 48 dB of
headroom it has no use for. The reference decode recorded in `vectors.json` was
run over these exact quantised bytes, not over the full-scale original, so what
is committed is precisely what fldigi was shown.

Each vector ends shortly after its transmission does, which is not long enough
for the synchroniser to read out its last blocks — it integrates `SyncIntegLen`
of them before printing one. The tests call `Decoder.Flush` for that, exactly as
the reference's own `Flush` does.

## Regenerating

```sh
g++ -O2 -o gen_vectors gen_vectors.cpp -I/path/to/fldigi/src/include/jalocha
./gen_vectors .
for f in *.s8; do gzip -9 -c "$f" > "$f.gz"; done && rm -f *.s8
```
