# UberSDR Go Radio Client - Docker Setup

This directory contains Docker configuration for running the UberSDR Go radio client in a container with audio and MIDI device access.

## Prerequisites

- Docker and Docker Compose installed
- Host user must be in the `audio` group:
  ```bash
  sudo usermod -aG audio $USER
  # Log out and back in for changes to take effect
  ```

## Quick Start

### Using Docker Compose (Recommended)

```bash
cd clients/go/docker
docker-compose up -d
```

### Using Docker Build and Run

```bash
# Build the image
cd clients/go
docker build -f docker/Dockerfile -t ubersdr-radio-client .

# Run with audio and MIDI access
docker run -d \
  --name ubersdr-radio-client \
  --privileged \
  -v /dev:/dev \
  -v /dev/shm:/dev/shm \
  --group-add audio \
  -p 8090:8090 \
  -v ./config:/home/radio/.config/ubersdr \
  ubersdr-radio-client
```

## Configuration

### Audio and MIDI Access

The Docker setup provides access to audio and MIDI devices through:

1. **Privileged mode**: `privileged: true` - Required for device access on Raspberry Pi and similar systems
2. **Volume mount**: `/dev:/dev` - Grants access to all device files
3. **Shared memory**: `/dev/shm:/dev/shm` - Required for ALSA/PulseAudio
4. **Audio group**: `--group-add audio` - Provides proper permissions

**Note**: Privileged mode is required because simple volume mounts don't expose device nodes properly in Docker. This is especially true for Raspberry Pi and embedded systems.

### Verify Device Access

Check that devices are accessible inside the container:

```bash
# Enter the container
docker exec -it ubersdr-radio-client bash

# List audio devices
aplay -l

# List MIDI devices
aconnect -l

# Monitor MIDI input
aseqdump -l
```

### Configuration Files

Configuration is persisted in a volume mounted at `/home/radio/.config/ubersdr`:

```bash
# Create config directory on host
mkdir -p ./config

# Your config.json will be stored here
```

## Environment Variables

- `API_PORT` - API server port (default: 8090)
- `CONFIG_FILE` - Path to configuration file (default: /home/radio/.config/ubersdr/config.json)

## Ports

- `8090` - API server port (configurable via API_PORT)

## Security Considerations

### Current Setup

The current configuration uses **privileged mode** which grants the container extensive access to the host system. This is necessary because:

1. Simple device mounting (`--device /dev/snd`) doesn't work reliably on all systems (especially Raspberry Pi)
2. Audio and MIDI devices require proper device node access
3. Some audio subsystems need additional kernel capabilities

**This setup is suitable for:**
- Personal workstations and development machines
- Raspberry Pi and embedded systems
- Single-user environments
- Trusted applications

**Security implications:**
- Container has root-equivalent access to host devices
- Can access all hardware devices
- Should only be used with trusted code

### Alternative: Specific Device Access (May Not Work on All Systems)

If you want to try a more restricted approach (note: this may not work on Raspberry Pi):

```yaml
# In docker-compose.yml, replace privileged section with:
devices:
  - /dev/snd:/dev/snd
volumes:
  - /dev/shm:/dev/shm
  - ./config:/home/radio/.config/ubersdr
```

If audio devices still don't appear, you'll need to use privileged mode.

## Troubleshooting

### No Audio Devices Found

1. Verify host has audio devices: `aplay -l`
2. Check user is in audio group: `groups`
3. Restart Docker daemon: `sudo systemctl restart docker`

### MIDI Controller Not Detected

1. List MIDI devices on host: `aconnect -l`
2. Check device permissions: `ls -l /dev/snd/midi*`
3. Verify ALSA sequencer is loaded: `lsmod | grep snd_seq`

### Permission Denied Errors

1. Ensure host user is in audio group
2. Check container user has audio group: `docker exec ubersdr-radio-client groups`
3. Verify /dev mount permissions

## Building Multi-Architecture Images

The Dockerfile supports multiple architectures:

```bash
# Build for multiple platforms
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t ubersdr-radio-client:latest \
  -f docker/Dockerfile \
  .
```

## Health Check

The container includes a health check that verifies the API server is responding:

```bash
# Check container health
docker ps

# View health check logs
docker inspect ubersdr-radio-client | grep -A 10 Health
```

## Logs

View container logs:

```bash
# Follow logs
docker-compose logs -f

# Or with docker
docker logs -f ubersdr-radio-client
```

## Stopping and Removing

```bash
# Stop the container
docker-compose down

# Or with docker
docker stop ubersdr-radio-client
docker rm ubersdr-radio-client