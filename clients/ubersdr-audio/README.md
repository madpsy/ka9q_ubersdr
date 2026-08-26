# UberSDR Windows Audio Client

A lightweight Windows audio client for [ka9q_ubersdr](https://github.com/ka9q/ubersdr).
Connects to a running UberSDR instance via WebSocket, plays audio through any Windows
audio device, and lets you change frequency, mode, and bandwidth on the fly — no
waterfall or spectrum display.

## Features

- **Modes**: USB, LSB, AM, FM, CWU, CWL
- **Live retune** without reconnecting (sends a `tune` JSON message over the existing WebSocket)
- **Follows the receiver's tuning range**, read from `/api/description` on connect —
  not always 0–30 MHz, since the span follows the front end sample rate (a
  129.6 Msps RX888 reaches 60 MHz and has 6 m in it). A receiver that reports no
  range, or none connected, falls back to 10 kHz – 30 MHz
- **Frequency step buttons**: 1 Hz, 100 Hz, 1 kHz, 10 kHz, 100 kHz, 1 MHz
- **Per-mode bandwidth defaults** (editable low/high cut fields)
- **Audio format**: Uncompressed (PCM-zstd) or Compressed (Opus)
- **Volume slider** (0–100 %)
- **SSL/TLS** support (`wss://`)
- **Password** support for protected instances
- Single `.exe`, no external DLLs required

## Requirements

- Go 1.21 or later (1.23+ recommended)
- A C compiler — Fyne uses OpenGL (via go-gl/GLFW) which always requires CGo:
  - **Windows native**: [TDM-GCC](https://jmeubank.github.io/tdm-gcc/) or MSYS2/MinGW
  - **Linux cross-compile**: `gcc-mingw-w64-x86-64` (`sudo apt install gcc-mingw-w64-x86-64`)
- Windows 10/11 target (WASAPI audio via oto)
- A running UberSDR instance

> **Note on Opus**: The Opus audio format additionally requires `gopkg.in/hraban/opus.v2`
> (also CGo). Since Fyne already requires CGo, Opus support comes at no extra toolchain cost.
> The "Compressed (Opus)" option in the GUI sets `format=opus` in the WebSocket URL;
> the server handles encoding. If the server doesn't support Opus it will fall back to PCM.

## Building

### Native Windows build (recommended — simplest)

Install [Go](https://go.dev/dl/) and [TDM-GCC](https://jmeubank.github.io/tdm-gcc/) (or MSYS2 MinGW), then:

```powershell
cd clients\windows-audio
go mod tidy
go build -ldflags="-H windowsgui" -o UberSDRAudio.exe .
```

The `-H windowsgui` flag suppresses the console window so only the GUI appears.

### Cross-compile from Linux (recommended for CI/CD)

Fyne's OpenGL backend requires CGo, so a C cross-compiler is needed.
A convenience script [`build.sh`](build.sh) handles everything:

```bash
# 1. Install the mingw-w64 cross-compiler (one-time)
sudo apt install gcc-mingw-w64-x86-64

# 2. Run the build script from the repo root or this directory
cd clients/windows-audio
./build.sh
# → produces UberSDRAudio.exe in clients/windows-audio/
```

### Publishing

`./build.sh --publish` builds as above and then uploads both binaries to the
rolling `latest` release on `madpsy/ka9q_ubersdr`, replacing the pair already
there. The asset names are the filenames the build writes — `UberSDRAudio` and
`UberSDRAudio.exe` — because the download cards on the website link straight at
`releases/download/latest/UberSDRAudio{,.exe}`, so those URLs must not move.

It needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`),
and it asks before uploading. `--yes` answers that in advance for an unattended
run; without a terminal and without `--yes` it declines rather than assuming.
A build that skipped the Windows half (no mingw) uploads the Linux binary alone
and leaves the `.exe` on the release untouched. This is the same arrangement as
`clients/electron/build.sh`, which publishes to the same tag.

Or manually:

```bash
sudo apt install gcc-mingw-w64-x86-64

cd clients/windows-audio
go mod tidy
GOOS=windows GOARCH=amd64 CGO_ENABLED=1 \
    CC=x86_64-w64-mingw32-gcc \
    go build -ldflags="-H windowsgui" -o UberSDRAudio.exe .
```

### Using `fyne package` (adds Windows icon/manifest)

```powershell
go install fyne.io/fyne/v2/cmd/fyne@latest
cd clients\windows-audio
fyne package -os windows -name "UberSDR Audio" -appID io.github.ka9q.ubersdr.audio
```

## Usage

1. Run `UberSDRAudio.exe`
2. Enter the **Host** and **Port** of your UberSDR instance
3. Enter a **Password** if the instance requires one
4. Set the initial **Frequency** (Hz), **Mode**, and bandwidth cuts
5. Choose **Uncompressed (PCM)** or **Compressed (Opus)**
6. Click **Connect**
7. Use the **◀ / ▶** step buttons or edit the frequency field and click **Tune** to retune live

## Protocol

The client uses the standard UberSDR WebSocket protocol:

1. `POST /connection` with `{"user_session_id":"<uuid>"}` → checks if connection is allowed
2. `WebSocket /ws?frequency=X&mode=Y&format=pcm-zstd&user_session_id=<uuid>&bandwidthLow=L&bandwidthHigh=H`
3. Binary frames: zstd-compressed → 13-byte (PM) or 29-byte (PC) header → big-endian int16 PCM
4. Live retune: `{"type":"tune","frequency":N,"mode":"usb","bandwidthLow":-2400,"bandwidthHigh":2400}`
5. Keepalive: `{"type":"ping"}` every 30 seconds

On connect it also reads `GET /api/description` for the station label, the
session limit, the DSP inserts on offer, and the receiver's tuning range — see
the `tuning_range` note under Features. The range is reported on to the local
REST API and the bundled web UI as `frequency_min_hz` / `frequency_max_hz`; see
`web/API.md`.

## Tests

```bash
go test ./...
```

One test reaches the network and is skipped unless enabled. It checks that the
range a real receiver publishes is the one this client then clamps to:

```bash
UBERSDR_TEST_SERVER=http://example.org:8080 go test -run TestLiveTuningRange -v
```

## Directory structure

```
clients/windows-audio/
├── main.go          # Fyne GUI entry point
├── client.go        # RadioClient (WebSocket connection management)
├── pcm_decoder.go   # PCM-zstd binary frame decoder
├── audio_output.go  # oto v3 WASAPI audio output
├── go.mod
└── README.md
```
