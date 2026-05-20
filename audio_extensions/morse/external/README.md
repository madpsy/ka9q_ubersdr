# cw-decoder

Standalone CW (Morse code) decoder. Reads raw PCM audio from stdin, writes decoded text as JSON to stdout. No dependencies beyond a C++20 compiler — no Qt, no system libraries beyond libstdc++.

Built on [ggmorse](https://github.com/ggerganov/ggmorse) (bundled, MIT licence).

## Dependencies

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt-get install -y cmake ninja-build g++
```

## Build

```bash
make
```

This produces `cw-decoder_<arch>` in the current directory (e.g. `cw-decoder_amd64`, `cw-decoder_arm64`).

To install to `/usr/local/bin/cw-decoder`:

```bash
sudo make install
```

## Input

**Mono signed 16-bit little-endian raw PCM on stdin** at the sample rate specified by `--sample-rate` (default: 12000 Hz).

No WAV header — raw samples only. Use `sox` or `rtl_fm` to produce this format:

```bash
# From a WAV file (12 kHz, default)
sox input.wav -t raw -r 12000 -c 1 -e signed -b 16 - | ./cw-decoder_amd64

# From a WAV file at 24 kHz
sox input.wav -t raw -r 24000 -c 1 -e signed -b 16 - | ./cw-decoder_amd64 --sample-rate 24000

# From an RTL-SDR (USB SDR dongle)
rtl_fm -f 14.074M -M usb -s 12000 - | ./cw-decoder_amd64
```

## Output

One JSON object per line on stdout. Two event types:

### `decode` — text was decoded

```json
{"type":"decode","text":"CQ CQ DE W1AW","cost":0.12,"confidence":"high","pitch":600,"speed":20}
```

| Field | Type | Description |
|---|---|---|
| `text` | string | Decoded characters |
| `cost` | float | ggmorse cost function (lower = more confident) |
| `confidence` | string | Bucketed confidence level (see table below) |
| `pitch` | float | Estimated tone pitch in Hz |
| `speed` | float | Estimated speed in WPM |

#### Confidence levels

Thresholds match AetherSDR's colour-coded CW decode panel:

| `confidence` | `cost` range | AetherSDR colour |
|---|---|---|
| `high` | < 0.15 | green `#00ff88` |
| `medium` | < 0.35 | yellow `#e0e040` |
| `low` | < 0.60 | orange `#ff9020` |
| `poor` | ≥ 0.60 | red |

### `stats` — pitch or speed estimate updated (no new text)

```json
{"type":"stats","pitch":600,"speed":20}
```

Emitted whenever ggmorse updates its pitch/speed estimate between decode events. Use this to keep a WPM/Hz display current.

## Options

| Option | Description |
|---|---|
| `--sample-rate HZ` | Input PCM sample rate in Hz (default: 12000) |
| `--pitch HZ` | Lock decoder pitch to HZ instead of auto-detecting |
| `--speed WPM` | Lock decoder speed to WPM instead of auto-detecting |
| `--help` | Print usage |

Locking both pitch and speed improves decode reliability when the operator's keying parameters are already known.

```bash
sox input.wav -t raw -r 12000 -c 1 -e signed -b 16 - | ./cw-decoder_amd64 --pitch 600 --speed 20
```
