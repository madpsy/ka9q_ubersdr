# real-load — CPU-based load average (cpuset-corrected)

## Integration with UberSDR Admin UI

When the volume mount below is configured, the UberSDR Go backend
(`admin.go` / `load_history.go`) will automatically use the corrected load
averages instead of `/proc/loadavg` for:

- The three large load average numbers on the Monitor tab
- The 60-minute and 24-hour load history charts
- The system load line shown on the Sessions tab
- The `ok` / `warning` / `critical` status colour coding

The fallback to `/proc/loadavg` is automatic when the file is absent, stale
(older than 30 seconds), or unparseable — so nothing breaks if the daemon is
not installed.

## The Problem

Linux load average (`/proc/loadavg`, `uptime`) counts threads in the runnable
and uninterruptible-sleep states across all CPUs. When a Docker container is
constrained to a subset of CPUs via `cpuset:`, the kernel's per-cpuset
run-queue accounting inflates the apparent runnable count significantly.

A system with 128 radiod threads pinned to 4 CPUs out of 24 will show a load
average of 40-60 even when CPU utilisation is under 30% and everything is
working correctly. The load average number is meaningless in this configuration.

`isolcpus` does not fix this. It is a kernel accounting artefact that has been
present since at least kernel 4.x.

## The Solution

These tools compute a corrected load average based on actual CPU utilisation:

    corrected_load = (cpu_busy_pct / 100) * nproc

The daemon samples `/proc/stat` every 5 seconds and maintains three exponential
moving averages using the same decay formula as the Linux kernel, giving values
directly comparable to the standard 1-minute, 5-minute, and 15-minute load
averages — but based on real CPU usage rather than run-queue length.

## Files

    real-load-daemon.sh      Background daemon that samples CPU and writes EMAs
    real-load.sh             Reader that prints the corrected load averages
    real-load-daemon.service systemd unit file

## Installation

    sudo cp real-load-daemon.sh real-load.sh /usr/local/bin/
    sudo cp real-load-daemon.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now real-load-daemon

### Connecting to UberSDR (Docker volume mount)

The UberSDR Go process runs inside a Docker container and cannot see host files
unless they are mounted in.  Edit `docker-compose.yml` (typically at
`~/ubersdr/docker-compose.yml`) and uncomment the bind-mount line under the
`ubersdr` service volumes:

    ubersdr:
      volumes:
        # ... existing mounts ...
        - /run/real-load-avg:/run/real-load-avg:ro

Then restart the container:

    docker compose -f ~/ubersdr/docker-compose.yml up -d ubersdr

The UberSDR backend will automatically detect the file and switch to corrected
load averages.  No container rebuild is required.  The fallback to
`/proc/loadavg` is automatic if the file is absent or the daemon stops.

## Usage

### Normal output (uptime-style)

    real-load.sh

    09:50:24  real load average: 1.62, 1.59, 1.58  (12.8% of 16 CPUs)
    09:50:24  /proc/loadavg:      4.16 3.12 2.18  <- may be inflated by cpuset artefact

### Live watch (refreshes every 2 seconds)

    real-load.sh --watch

### Raw numbers (for shell scripting)

    real-load.sh --raw

Output: `<load1> <load5> <load15> <cpu_pct> <nproc>`

    1.6162 1.5865 1.5814 12.8 16

### CSV output (for external applications)

    real-load.sh --csv

Output includes a header row followed by one data row:

    timestamp,load1,load5,load15,cpu_pct,nproc,age_s
    2026-04-22T08:50:24Z,1.62,1.59,1.58,12.8,16,2

Fields:

| Field       | Description                                              |
|-------------|----------------------------------------------------------|
| `timestamp` | ISO 8601 UTC timestamp of the reading                    |
| `load1`     | 1-minute EMA load equivalent                             |
| `load5`     | 5-minute EMA load equivalent                             |
| `load15`    | 15-minute EMA load equivalent                            |
| `cpu_pct`   | Instantaneous CPU busy % at last sample                  |
| `nproc`     | Total logical CPUs on the system                         |
| `age_s`     | Seconds since the daemon last wrote this value           |

### Continuous CSV stream

    real-load.sh --csv --watch

Prints the header once, then appends a new row every 2 seconds. Suitable for
piping to another process or redirecting to a log file.

### CSV without header (for appending to an existing file)

    real-load.sh --csv-nohead >> /var/log/cpu-load.csv

## Running Without systemd

    # Start daemon in background
    real-load-daemon.sh &

    # Read current values
    real-load.sh

    # Stop daemon
    kill $(cat /run/real-load-daemon.pid)

If `/run` is not writable (non-root), the daemon falls back to
`~/.real-load-avg` and `~/.real-load-daemon.pid`.

## How the EMA is Computed

The daemon uses the same exponential moving average formula as the Linux kernel:

    new_ema = old_ema + alpha * (instantaneous - old_ema)

Where alpha is derived from the sample interval and the averaging window:

    alpha_1min  = 1 - exp(-interval / 60)
    alpha_5min  = 1 - exp(-interval / 300)
    alpha_15min = 1 - exp(-interval / 900)

With the default 5-second interval:

    alpha_1min  = 0.0811
    alpha_5min  = 0.0165
    alpha_15min = 0.0055

The instantaneous value is `(cpu_busy_pct / 100) * nproc`, which gives a
load-average-equivalent number on the same scale as `/proc/loadavg`.

## Stale Data Warning

If the daemon stops, `real-load.sh` will warn when the state file is more than
30 seconds old:

    data is 45s old -- is real-load-daemon still running?

## Relationship to /proc/loadavg

The corrected load average will always be lower than or equal to `/proc/loadavg`
on a system with an active cpuset. On a system without a cpuset, the two values
should be approximately equal (within normal sampling variance).
