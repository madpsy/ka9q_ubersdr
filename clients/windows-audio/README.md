# UberSDR Windows Audio Client

A lightweight Windows audio client for [ka9q_ubersdr](https://github.com/ka9q/ubersdr).
Connects to a running UberSDR instance via WebSocket, plays audio through any Windows
audio device, and lets you change frequency, mode, and bandwidth on the fly — no
waterfall or spectrum display.

## Features

- **Modes**: USB, LSB, AM, FM, CWU, CWL
- **Live retune** without reconnecting (sends a `tune` JSON message over the existing WebSocket)
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
