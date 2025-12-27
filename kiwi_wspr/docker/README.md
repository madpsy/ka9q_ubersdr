# KiwiSDR WSPR Decoder - Docker Deployment

This directory contains Docker configuration for running the KiwiSDR WSPR Decoder in a container.

## Features

- **Multi-stage build** for optimized image size
- **WSJT-X included** with `wsprd` binary for WSPR decoding
- **Persistent storage** for configuration and decoded data
- **Auto-configuration** with config merging on updates
- **Health checks** for container monitoring
- **Web interface** on port 8080

## Quick Start

### Using Docker Compose (Recommended)

1. Build and start the container:
```bash
cd kiwi_wspr/docker
docker-compose up -d
```

2. Check the logs to see the initial configuration message:
```bash
docker-compose logs -f
```

3. Edit the configuration file:
```bash
# The config is stored in a Docker volume
# To edit it, you can:
docker exec -it kiwi-wspr vi /app/data/config.yaml

# Or copy it out, edit, and copy back:
docker cp kiwi-wspr:/app/data/config.yaml ./config.yaml
# Edit config.yaml locally
docker cp ./config.yaml kiwi-wspr:/app/data/config.yaml
docker-compose restart
```

4. Access the web interface:
```
http://localhost:8080
```

### Using Docker Build Directly

```bash
# Build the image
cd kiwi_wspr
docker build -f docker/Dockerfile -t kiwi-wspr:latest .

# Run the container
docker run -d \
  --name kiwi-wspr \
  -p 8080:8080 \
  -v kiwi-wspr-data:/app/data \
  -e TZ=UTC \
  kiwi-wspr:latest
```

## Configuration

### Initial Setup

On first run, the container will:
1. Create `/app/data/config.yaml` from the example
2. Set `wsprd_path` to the correct location (`/usr/bin/wsprd`)
3. Set `work_dir` to `/app/data/wspr_data` for persistent storage
4. Display a message prompting you to configure your KiwiSDR instances

### Configuration Updates

When you update the container, the entrypoint script will:
- Merge new configuration keys from the updated example
- Create a timestamped backup of your existing config
- Preserve your custom settings

### Environment Variables

- `TZ` - Timezone (default: UTC)

### Volumes

- `/app/data` - Persistent storage for:
  - `config.yaml` - Configuration file
  - `wspr_data/` - Decoded WSPR data and WAV files
  - Config backups

## Web Interface

The web interface is available at `http://localhost:8080` and provides:
- Configuration management for instances and bands
- Enable/Disable controls for instances and bands
- MQTT settings configuration
- Real-time status monitoring

## MQTT Integration

To connect to an MQTT broker:

1. Edit the config via the web interface or directly:
```yaml
mqtt:
  enabled: true
  host: "mqtt-broker-hostname"
  port: 1883
  topic_prefix: "kiwi_wspr"
  username: "your-username"  # optional
  password: "your-password"  # optional
```

2. Restart the container:
```bash
docker-compose restart
```

## Connecting to Other Services

To connect to an MQTT broker in another container, use Docker networks:

```yaml
version: '3.8'

services:
  kiwi-wspr:
    # ... existing config ...
    networks:
      - kiwi-wspr
      - mqtt-network  # Add this

  mosquitto:
    image: eclipse-mosquitto:latest
    networks:
      - mqtt-network

networks:
  kiwi-wspr:
    driver: bridge
  mqtt-network:
    driver: bridge
```

Then configure the MQTT host as `mosquitto` (the service name).

## Monitoring

### Health Checks

The container includes a health check that verifies the web interface is responding:
```bash
docker-compose ps
```

### Logs

View logs:
```bash
docker-compose logs -f
```

### Decoded Spots

WSPR spots are:
1. Published to MQTT (if enabled)
2. Stored in `/app/data/wspr_data/`

## Troubleshooting

### Container won't start

Check logs:
```bash
docker-compose logs
```

Common issues:
- Port 8080 already in use (change in docker-compose.yml)
- Invalid configuration file (check YAML syntax)

### No WSPR decoding

Verify:
1. KiwiSDR instances are configured and reachable
2. Bands are enabled in the configuration
3. `wsprd` is working: `docker exec kiwi-wspr wsprd --help`

### Configuration not persisting

Ensure the volume is properly mounted:
```bash
docker volume inspect kiwi-wspr-data
```

## Building for Production

### Multi-architecture builds

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile \
  -t your-registry/kiwi-wspr:latest \
  --push \
  .
```

## Maintenance

### Backup Configuration

```bash
docker cp kiwi-wspr:/app/data/config.yaml ./backup-config.yaml
```

### Update Container

```bash
docker-compose pull
docker-compose up -d
```

### Clean Up

```bash
# Stop and remove container
docker-compose down

# Remove volume (WARNING: deletes all data)
docker-compose down -v
```

## Requirements

- Docker 20.10+
- Docker Compose 1.29+ (or Docker Compose V2)
- 500MB disk space for image
- Additional space for WSPR data (varies by usage)

## See Also

- [Main README](../README.md) - Application documentation
- [config.yaml.example](../config.yaml.example) - Configuration reference
