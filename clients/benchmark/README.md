# UberSDR Benchmark Tool

A multi-threaded load-testing CLI that simulates N concurrent real users against a
[ka9q_ubersdr](https://github.com/ka9q/ubersdr) instance.

> **URL format**: pass an `http://` or `https://` base URL with `--url`.
> WebSocket URLs (`ws://` / `wss://`) are derived automatically — you never need
> to specify them directly.

Each virtual user mirrors the behaviour of the real Python client:

1. **POST `/connection`** — registers the session and checks whether the server
   will accept it.
2. **Audio WebSocket** (`/ws`) — connects with the same URL parameters as
   `radio_client.py`, receives PCM-zstd frames, and discards them.
3. **Spectrum WebSocket** (`/ws/user-spectrum`) — connects, sends a zoom command
   after the first `config` message (mirrors `spectrum_display.py`), receives
   binary SPEC frames or gzip JSON, and discards them.
4. **DX Cluster WebSocket** (`/ws/dxcluster`) — connects, subscribes to CW and
   digital spots, responds to server pings, and discards all data.

No audio is decoded or played.  No spectrum is rendered.  The tool only measures
connection counts, message rates, and byte throughput.

---

## Requirements

- Python **3.10+**
- `pip install -r requirements.txt`

```
aiohttp>=3.9.0
websockets>=12.0
```

---

## Architecture

```
benchmark.py  (CLI entry point)
    └── BenchmarkRunner  (runner.py)
            ├── Thread 0  ──  asyncio loop  ──  VirtualUser 0 … k
            ├── Thread 1  ──  asyncio loop  ──  VirtualUser k+1 … 2k
            └── Thread N  ──  asyncio loop  ──  VirtualUser …

Each VirtualUser runs three concurrent asyncio tasks:
    AudioWebSocket      /ws
    SpectrumWebSocket   /ws/user-spectrum
    DXClusterWebSocket  /ws/dxcluster

StatsReporter (main thread) reads from a queue.Queue and prints a live table.
```

- **N OS threads**, each with its own `asyncio.new_event_loop()`, for true I/O
  parallelism.
- A `threading.Event` is used as the stop signal; each WebSocket handler polls it
  every 0.25 s via a `_stop_watcher` coroutine.
- Stats are pushed to a `queue.Queue` every second and aggregated in the main
  thread.

---

## Usage

```
python benchmark.py --url <URL> [options]
```

### Connection

| Flag | Default | Description |
|------|---------|-------------|
| `--url URL` | *(required)* | Server base URL, e.g. `http://localhost:8073` or `https://radio.example.com`. WebSocket URLs are derived automatically (`http`→`ws`, `https`→`wss`). |
| `--password PW` | — | Bypass password (sent to `POST /connection` and audio WebSocket) |
| `--ssl` | off | Force WSS/HTTPS (also inferred automatically from an `https://` URL) |

### Scale

| Flag | Default | Description |
|------|---------|-------------|
| `--users N` | 10 | Number of simulated concurrent users |
| `--threads N` | 4 | OS threads; each runs its own asyncio event loop |
| `--duration SECS` | 60 | Benchmark duration in seconds |
| `--ramp-up SECS` | 5 | Seconds over which all users are staggered at startup |
| `--report-interval SECS` | 5 | Seconds between live console reports |
| `--reconnect` | off | Auto-reconnect individual WebSockets on disconnect |

### Radio / Demodulation

| Flag | Default | Description |
|------|---------|-------------|
| `-f / --frequency HZ` | 14200000 | Tuned frequency in Hz |
| `-m / --mode MODE` | `usb` | Demodulation mode (see table below) |
| `-b / --bandwidth LOW:HIGH` | *(mode default)* | Filter edges in Hz, e.g. `50:2700` or `-2700:-50` |

**Supported modes:**

| Mode | Bandwidth default | Notes |
|------|-------------------|-------|
| `usb` | 50:2700 | Upper sideband |
| `lsb` | -2700:-50 | Lower sideband |
| `am` | -5000:5000 | AM |
| `sam` | -5000:5000 | Synchronous AM |
| `cwu` | -200:200 | CW upper |
| `cwl` | -200:200 | CW lower |
| `fm` | -8000:8000 | Wideband FM |
| `nfm` | -5000:5000 | Narrow FM |
| `iq` / `iq48` / `iq96` / `iq192` / `iq384` | *(none)* | IQ capture — bandwidth params not sent |

### Spectrum

| Flag | Default | Description |
|------|---------|-------------|
| `--spectrum-zoom KHZ` | 200 | Spectrum display bandwidth in kHz sent as the zoom command |

### Feature flags

| Flag | Description |
|------|-------------|
| `--no-audio` | Disable audio WebSocket connections (`/ws`) |
| `--no-spectrum` | Disable spectrum WebSocket connections (`/ws/user-spectrum`) |
| `--no-dxcluster` | Disable DX cluster WebSocket connections (`/ws/dxcluster`) |

---

## Examples

### 50 users, 14.074 MHz USB, 2-minute run

```bash
python benchmark.py \
    --url http://localhost:8073 \
    --users 50 --threads 10 --duration 120 \
    -f 14074000 -m usb
```

### 100 users, 7.1 MHz LSB, explicit bandwidth, 500 kHz spectrum zoom

```bash
python benchmark.py \
    --url http://radio.example.com:8073 \
    --users 100 --threads 10 --duration 300 \
    -f 7100000 -m lsb -b -2700:-50 \
    --spectrum-zoom 500 --password secret
```

### TLS instance (HTTPS → WSS derived automatically)

```bash
python benchmark.py \
    --url https://radio.example.com \
    --users 50 --threads 10 --duration 120 \
    -f 14200000 -m usb
```

### Audio only (no spectrum, no DX cluster)

```bash
python benchmark.py \
    --url http://localhost:8073 \
    --users 20 -f 14200000 -m usb \
    --no-spectrum --no-dxcluster
```

### IQ mode (no bandwidth sent)

```bash
python benchmark.py \
    --url http://localhost:8073 \
    --users 5 -f 14000000 -m iq96
```

### Stress test: 100 users, 10 threads, reconnect on drop

```bash
python benchmark.py \
    --url http://localhost:8073 \
    --users 100 --threads 10 --duration 600 \
    --ramp-up 30 --reconnect \
    -f 14200000 -m usb
```

---

## Live Output

Every `--report-interval` seconds the tool prints a table like:

```
[  15s /  60s]  Users: 50/50 connected
  Type       Connected   Msgs/s    Bytes/s   Total RX    Errors
  Audio          50       1 250    620 KB/s   9.3 MB        0
  Spectrum       50         250     48 KB/s   0.7 MB        0
  DX Cluster     50           8      2 KB/s  30.0 KB        0
```

A final summary is printed when the run completes or is interrupted with Ctrl-C.

---

## File Structure

```
clients/benchmark/
├── benchmark.py        CLI entry point (argparse → BenchmarkConfig → BenchmarkRunner)
├── config.py           BenchmarkConfig dataclass; mode/bandwidth constants
├── runner.py           BenchmarkRunner: thread pool, ramp-up, stop signal, stats queue
├── user.py             VirtualUser: POST /connection + three WS tasks
├── audio_ws.py         AudioWebSocket handler (/ws)
├── spectrum_ws.py      SpectrumWebSocket handler (/ws/user-spectrum)
├── dxcluster_ws.py     DXClusterWebSocket handler (/ws/dxcluster)
├── stats.py            UserStats dataclass + StatsReporter (live table)
├── requirements.txt    Python dependencies
└── README.md           This file
```
