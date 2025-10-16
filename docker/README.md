# Docker Setup for ka9q_ubersdr + ka9q-radio

This unified docker-compose configuration manages both the ka9q-radio backend (radiod) and the ka9q_ubersdr web interface as a single system.

## Prerequisites

1. Docker and Docker Compose installed
2. Both repositories cloned:
   - `~/repos/ka9q-radio` - The SDR backend
   - `~/repos/ka9q_ubersdr` - The web interface (this repo)

## Quick Start

### 1. Create the shared network (one-time setup)

```bash
docker network create sdr-network --subnet 172.20.0.0/16
```

### 2. Build and start both services

```bash
cd ~/repos/ka9q_ubersdr/docker
docker compose up -d
```

This will:
- Build the ka9q-radio image from `~/repos/ka9q-radio`
- Build the ka9q_ubersdr image from this repo
- Start radiod first and wait for it to be healthy
- Start the web interface once radiod is ready
- Expose the web interface on http://localhost:8080

### 3. View logs

```bash
# All services
docker compose logs -f

# Just radiod
docker compose logs -f ka9q-radio

# Just web interface
docker compose logs -f ubersdr
```

### 4. Stop services

```bash
docker compose down
```

## Configuration

### Environment Variables

Create a `.env` file in the `docker/` directory:

```env
TZ=America/New_York
ADMIN_PASSWORD=your_secure_password
```

### Custom radiod Configuration

To use a custom radiod configuration:

1. Uncomment the volume mount in docker-compose.yml:
   ```yaml
   - ../../ka9q-radio/docker/radiod@ubersdr.conf:/etc/ka9q-radio/radiod@ubersdr.conf
   ```

2. Place your config file at `~/repos/ka9q-radio/docker/radiod@ubersdr.conf`

3. Restart: `docker compose restart ka9q-radio`

## Persistent Data

The following Docker volumes store persistent data:

- `radiod-config` - radiod configuration files
- `radiod-data` - recordings and FFTW wisdom files
- `ubersdr-config` - web interface configuration

To reset to defaults, remove the volumes:

```bash
docker compose down -v
```

## Troubleshooting

### Check service health

```bash
docker compose ps
```

Both services should show "healthy" status.

### Radiod not starting

1. Check USB device permissions:
   ```bash
   ls -la /dev/bus/usb
   ```

2. Verify the container has privileged access:
   ```bash
   docker inspect ka9q-radio | grep Privileged
   ```

### Web interface can't connect to radiod

1. Verify both containers are on the same network:
   ```bash
   docker network inspect sdr-network
   ```

2. Check radiod is listening for multicast:
   ```bash
   docker compose exec ka9q-radio netstat -uln
   ```

### Rebuild after code changes

```bash
# Rebuild specific service
docker compose build ka9q-radio
docker compose build ubersdr

# Rebuild and restart
docker compose up -d --build
```

## Development Workflow

For active development:

```bash
# Watch logs while developing
docker compose logs -f

# Rebuild and restart after changes
docker compose up -d --build

# Quick restart without rebuild
docker compose restart ubersdr
```

## Architecture

```
┌─────────────────┐
│   Browser       │
│  :8080          │
└────────┬────────┘
         │ HTTP
         ▼
┌─────────────────┐     Multicast      ┌─────────────────┐
│   ubersdr       │◄──────────────────►│  ka9q-radio     │
│  (Web UI)       │    sdr-network     │   (radiod)      │
└─────────────────┘   172.20.0.0/16    └────────┬────────┘
                                                 │
                                                 ▼
                                        ┌─────────────────┐
                                        │  USB SDR Device │
                                        │  /dev/bus/usb   │
                                        └─────────────────┘
```

## Notes

- The `depends_on` with `service_healthy` ensures radiod is fully running before ubersdr starts
- Both services use the same `sdr-network` for multicast communication
- The ka9q-radio service requires privileged mode for USB device access
- Configuration persists across container restarts via Docker volumes