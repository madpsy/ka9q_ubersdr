# Predictive codec test captures

Real packets from a live receiver, used by `pcm_predictive_test.go` to check
that the codec stays lossless and does not regress in compression ratio.

Synthetic signals cannot replace these. Every bug found while developing this
codec was triggered by a property of real RF that a generator does not
reproduce: unary runs long enough to overflow the bit writer, band statistics
that make one predictor configuration beat another, and residual distributions
that decide whether the entropy coder is well matched.

## Provenance

Captured from `m9psy.tunnel.ubersdr.org` on 2026-08-31 (12:12-14:18 UTC) over
the `/ws` audio WebSocket with `format=pcm-zstd&version=3`, then zstd-decoded
back to the packets the encoder had produced. Each file is the first 600
packets of a 20-second capture, which is 12 seconds of audio at 12/24 kHz and
about half a second at 384 kHz.

## Format

A flat sequence of length-prefixed packets:

    [payload length: uint32 little-endian][packet bytes]...

Each packet is a full protocol version 3 binary PCM packet: a 37-byte header
(magic `0x5043`) followed by big-endian int16 samples, interleaved I/Q for the
IQ captures and mono for the audio ones. `loadTestCapture` in
`pcm_predictive_test.go` parses this.

## The files, and why each is here

| file | mode | rate | why it is in the set |
|---|---|---|---|
| `iq384-ft8-14074.bin` | iq384 | 384 kHz | the widest IQ stream, on a busy band; the main throughput case |
| `iq12k-ft8-14074.bin` | iq | 12 kHz | the only IQ mode the browser offers, so the one a JS decoder must handle |
| `iq384-mw-carriers.bin` | iq384 | 384 kHz | medium wave, 60 dB of spread between carriers and noise floor. Its large unpredicted samples produce long unary runs, which is what exposed a bit-writer overflow that every other capture passed straight through. |
| `iq384-quiet-band.bin` | iq384 | 384 kHz | an empty band, nearly white. Prediction can win almost nothing here, so it guards against a change that only ever helps and never has to degrade gracefully. |
| `usb-ft8-14074.bin` | usb | 12 kHz | demodulated FT8 |
| `lsb-voice-7150.bin` | lsb | 12 kHz | demodulated voice |
| `cw-14025.bin` | cwu | 12 kHz | a narrow tone in a mostly empty channel; the highest ratio the codec reaches |
| `am-14074.bin` | am | 24 kHz | the other audio sample rate |
| `nfm-14074.bin` | nfm | 24 kHz | the lowest ratio of the audio modes, and near full scale at -1.4 dBFS |

Together they cover both predictor profiles, every sample rate the server
offers, and the range from nearly incompressible to highly compressible.

## Regenerating

The capture tool is not in the tree; it dials `/connection` for a session UUID
and then `/ws?format=pcm-zstd&version=3&mode=...`, decodes each zstd frame and
writes it with a length prefix. Any client that speaks that protocol can
produce the same format. There is no need to regenerate these unless the
packet header layout changes.
