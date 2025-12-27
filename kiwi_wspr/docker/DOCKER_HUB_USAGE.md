# Using KiwiSDR WSPR Decoder from Docker Hub

This guide explains how to use the pre-built Docker image from Docker Hub.

## Quick Start

### Using Docker Compose (Recommended)

1. Download the docker-compose file:
```bash
wget https://raw.githubusercontent.com/your-repo/ka9q_ubersdr/main/kiwi_wspr/docker/docker-compose-hub.yaml
```

2. Start the container:
```bash
docker-compose -f docker-compose-hub.yaml up -d
```

3. Access the web interface:
```
http://localhost:8080
```

### Using Docker Run

```bash
docker run -d \
  --name kiwi-wspr \
  -p 8080:8080 \
  -v kiwi-wspr-data:/app/data \
  -e TZ=UTC \
  --restart unless-stopped \
  your-dockerhub-username/kiwi-wspr:latest
```

## Initial Configuration

On first run, the container creates a default configuration file. You need to configure your KiwiSDR instances:

### Option 1: Using the Web Interface (Easiest)

1. Open http://localhost:8080 in your browser
2. Configure your KiwiSDR instances and bands
3. Click "Save Configuration"

### Option 2: Edit Configuration File Directly

```bash
# Copy config out of container
docker cp kiwi-wspr:/app/data/config.yaml ./config.yaml

# Edit the file with your settings
nano config.yaml

# Copy it back
docker cp ./config.yaml kiwi-wspr:/app/data/config.yaml

# Restart container
docker restart kiwi-wspr
```

## Configuration Example

```yaml
receiver:
  callsign: "N0CALL"
  locator: "FN20"

mqtt:
  enabled: true
  host: "mqtt-broker"
  port: 1883
  topic_prefix: "kiwi_wspr"

kiwi_instances:
  - name: "kiwi1"
    host: "kiwisdr.example.com"
    port: 8073
    user: "kiwi_wspr"
    enabled: true

wspr_bands:
  - name: "20m"
    frequency: 14097.0
    instance: "kiwi1"
    enabled: true
  - name: "40m"
    frequency: 7040.0
    instance: "kiwi1"
    enabled: true
```

## Ports

- `8080` - Web interface (HTTP)

## Volumes

- `/app/data` - Configuration and decoded data
  - `config.yaml` - Configuration file
  - `wspr_data/` - Decoded WSPR spots and WAV files

## Environment Variables

- `TZ` - Timezone (default: UTC)

## Connecting to MQTT Broker

### Same Docker Network

If your MQTT broker is in another container:

```yaml
version: '3.8'

services:
  kiwi-wspr:
    image: your-dockerhub-username/kiwi-wspr:latest
    networks:
      - mqtt-network
    # ... other config ...

  mosquitto:
    image: eclipse-mosquitto:latest
    networks:
      - mqtt-network

networks:
  mqtt-network:
    driver: bridge
```

Then set MQTT host to `mosquitto` in the config.

### External MQTT Broker

Set the MQTT host to the external IP or hostname in your config.

## Monitoring

### View Logs

```bash
docker logs -f kiwi-wspr
```

### Check Health

```bash
docker ps
# Look for "healthy" status
```

### View Decoded Spots

```bash
# List decoded files
docker exec kiwi-wspr ls -lh /app/data/wspr_data/

# View a specific decode
docker exec kiwi-wspr cat /app/data/wspr_data/spots_20251227.txt
```

## Updating

```bash
# Pull latest image
docker pull your-dockerhub-username/kiwi-wspr:latest

# Recreate container
docker-compose -f docker-compose-hub.yaml up -d
```

Your configuration and data are preserved in the volume.

## Backup

### Backup Configuration

```bash
docker cp kiwi-wspr:/app/data/config.yaml ./backup-config-$(date +%Y%m%d).yaml
```

### Backup All Data

```bash
docker run --rm \
  -v kiwi-wspr-data:/data \
  -v $(pwd):/backup \
  ubuntu tar czf /backup/kiwi-wspr-backup-$(date +%Y%m%d).tar.gz /data
```

### Restore Data

```bash
docker run --rm \
  -v kiwi-wspr-data:/data \
  -v $(pwd):/backup \
  ubuntu tar xzf /backup/kiwi-wspr-backup-YYYYMMDD.tar.gz -C /
```

## Troubleshooting

### Container won't start

Check logs:
```bash
docker logs kiwi-wspr
```

### Can't access web interface

1. Check container is running: `docker ps`
2. Check port mapping: `docker port kiwi-wspr`
3. Try accessing: `curl http://localhost:8080`

### No WSPR decoding

1. Check configuration is correct
2. Verify KiwiSDR is reachable from container
3. Check wsprd is working: `docker exec kiwi-wspr wsprd --help`

### Configuration not saving

Ensure volume is properly mounted:
```bash
docker volume inspect kiwi-wspr-data
```

## Advanced Usage

### Custom Port

```bash
docker run -d \
  --name kiwi-wspr \
  -p 9090:8080 \
  -v kiwi-wspr-data:/app/data \
  your-dockerhub-username/kiwi-wspr:latest
```

Access at: http://localhost:9090

### Multiple Instances

Run multiple containers with different ports and volumes:

```bash
# Instance 1
docker run -d \
  --name kiwi-wspr-1 \
  -p 8080:8080 \
  -v kiwi-wspr-data-1:/app/data \
  your-dockerhub-username/kiwi-wspr:latest

# Instance 2
docker run -d \
  --name kiwi-wspr-2 \
  -p 8081:8080 \
  -v kiwi-wspr-data-2:/app/data \
  your-dockerhub-username/kiwi-wspr:latest
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/your-repo/ka9q_ubersdr/issues
- Documentation: https://github.com/your-repo/ka9q_ubersdr/tree/main/kiwi_wspr

## Tags

- `latest` - Latest stable release
- `v1.0.0` - Specific version (when available)
- `dev` - Development version (unstable)
