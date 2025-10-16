# Docker Setup for ka9q_ubersdr and ka9q-radio

This directory contains Docker configuration files for running both ka9q_ubersdr (web interface) and ka9q-radio (SDR backend) in containerized environments based on Ubuntu 24.04.

## Overview

This setup provides two Docker containers that communicate via a private bridge network:
- **radiod** - ka9q-radio SDR backend for hardware control and signal processing
- **ubersdr** - ka9q_ubersdr web interface for browser-based SDR control

Both containers use a private Docker bridge network (`sdr-network`) for multicast communication, isolating SDR traffic from the host network.

## Prerequisites

- Docker installed on your system
- Docker Compose (recommended)
- SDR hardware (for radiod container)
- USB access for SDR devices

## Files

- **Dockerfile** - Ubuntu 24.04 container for ka9q_ubersdr web interface
- **docker-compose.yml** - Docker Compose configuration for easy deployment
- **entrypoint.sh** - Startup script that handles configuration and admin password
- **.dockerignore** - Files to exclude from the Docker build context

## Quick Start with Docker Compose

This is the recommended way to run both ka9q-radio and ka9q_ubersdr together.

### Prerequisites

1. Clone the ka9q-radio repository alongside this project:
   ```bash
   cd /path/to/repos
   git clone https://github.com/ka9q/ka9q-radio.git
   ```

2. Create the shared Docker network:
   ```bash
   docker network create sdr-network --subnet 172.20.0.0/16
   ```

### Starting the Services

1. Set environment variables (optional):
   ```bash
   export ADMIN_PASSWORD=your_secure_password
   export TZ=America/New_York
   ```

2. Start ka9q-radio first:
   ```bash
   cd ~/repos/ka9q-radio/docker
   docker-compose up -d
   ```

3. Start ka9q_ubersdr:
   ```bash
   cd ~/repos/ka9q_ubersdr/docker
   docker-compose up -d
   ```

4. Access the web interface at `http://localhost:8080`

### Managing the Services

View logs:
```bash
# From ka9q-radio directory
docker-compose logs -f

# From ka9q_ubersdr directory
docker-compose logs -f
```

Stop the services:
```bash
# Stop both (run from each directory)
docker-compose down

# Or stop all containers
docker stop ka9q-radio ka9q_ubersdr
```

Remove everything (including volumes):
```bash
docker-compose down -v  # Run in each directory
docker network rm sdr-network
```

## Architecture

### Network Configuration

Both containers use an **external shared bridge network** (`sdr-network` on subnet 172.20.0.0/16) for multicast communication:

- **External network**: Created once with `docker network create sdr-network --subnet 172.20.0.0/16`
- **radiod** container runs ka9q-radio and publishes multicast streams on the bridge network
- **ubersdr** container connects to radiod via Docker DNS (`radiod:5006` and `radiod:5004`)
- Multicast addresses are generated using FNV-1 hash algorithm when DNS resolution fails
- The web interface is exposed on host port 8080

This architecture isolates SDR multicast traffic from the host network while allowing browser access to the web interface. Using an external network allows both docker-compose files to be managed independently while sharing the same network.

### Container Communication

```
┌─────────────────────────────────────────────────┐
│ Host Network                                     │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │ sdr-network (172.20.0.0/16)                │ │
│  │                                            │ │
│  │  ┌──────────────┐      ┌───────────────┐  │ │
│  │  │   radiod     │─────▶│   ubersdr     │  │ │
│  │  │ (ka9q-radio) │      │ (web UI)      │  │ │
│  │  │              │      │               │  │ │
│  │  │ Multicast:   │      │ Listens on:   │  │ │
│  │  │ radiod:5006  │      │ radiod:5006   │  │ │
│  │  │ radiod:5004  │      │ radiod:5004   │  │ │
│  │  └──────────────┘      └───────────────┘  │ │
│  │        │                      │            │ │
│  └────────┼──────────────────────┼────────────┘ │
│           │                      │              │
│           │                      └──────────────┼─▶ Port 8080
│           │                                     │   (Web Interface)
│           └─────────────────────────────────────┼─▶ USB Devices
│                                                 │   (/dev/bus/usb)
└─────────────────────────────────────────────────┘
```

## Building and Running with Docker CLI

### Build the Image

From the project root directory:

```bash
docker build -f docker/Dockerfile -t ka9q_ubersdr:latest .
```

### Run the Container

```bash
docker run -d \
  --name ka9q_ubersdr \
  -p 8080:8080 \
  -e ADMIN_PASSWORD=your_secure_password \
  -v ubersdr-data:/app \
  ka9q_ubersdr:latest
```

## Configuration

### Environment Variables

- **ADMIN_PASSWORD** - Sets the admin password in config.yaml (optional, updates on every startup if set)
- **TZ** - Timezone for the container (default: `UTC`)

### Volumes

- `/app` - Working directory (Docker named volume `ubersdr-data`)
  - Contains config files: `config.yaml`, `bands.yaml`, `bookmarks.yaml`
  - On first run, example configs are automatically copied here
  - Managed by Docker's volume system for persistence

**Important:** ka9q_ubersdr expects config files in its current working directory (/app). The entire /app directory is stored in a Docker named volume for persistence. Configuration files are automatically initialized from examples on first run, and Docker networking fixes plus admin password are applied on every startup.

### Ports

- **8080/tcp** - Web interface

### Automatic Configuration Changes

The ubersdr entrypoint script runs on every container startup and:
1. **Initializes config files** - Copies example configs to `/app` if they don't exist
2. **Applies Docker bridge networking fixes** to config.yaml:
   - Sets `radiod->interface` to `"eth0"` (Docker bridge interface)
   - Changes `radiod->status_group` from `"hf-status.local:5006"` to `"radiod:5006"`
   - Changes `radiod->data_group` from `"pcm.local:5004"` to `"radiod:5004"`
3. **Updates admin password** - If `ADMIN_PASSWORD` environment variable is set, overwrites the password in config.yaml

These changes ensure proper communication between containers on the private bridge network.

## Customizing Configuration

Configuration files are stored in the Docker named volume `ubersdr-data` and persist across container restarts:

1. On first run, example configs are automatically copied to the volume

2. Edit configuration files by accessing them in the running container:
   ```bash
   # Copy config out to edit
   docker cp ka9q_ubersdr:/app/config.yaml ./config.yaml
   nano config.yaml
   docker cp ./config.yaml ka9q_ubersdr:/app/config.yaml
   
   # Or edit directly in the container
   docker exec -it ka9q_ubersdr nano /app/config.yaml
   ```

3. Restart the container to apply changes:
   ```bash
   docker-compose restart ubersdr
   ```

**Alternative:** You can also inspect the volume location:
```bash
docker volume inspect ubersdr-data
# Then edit files at the Mountpoint location shown
```

**Tip:** You can also set the admin password via environment variable:
```bash
ADMIN_PASSWORD=mysecurepassword docker-compose up -d
```
This will override the password in config.yaml on every startup.

## Health Check

The container includes a health check that verifies the web interface is responding:

```bash
# Check container health
docker ps
# or
docker-compose ps
```

## Troubleshooting

### Container won't start

1. Check logs:
   ```bash
   docker-compose logs ubersdr
   ```

2. Verify the build completed successfully:
   ```bash
   docker-compose build ubersdr
   ```

### Can't access web interface

1. Verify the container is running:
   ```bash
   docker ps
   ```

2. Check port bindings (should show 8080 -> 8080):
   ```bash
   docker port ka9q_ubersdr
   ```

3. Access at `http://localhost:8080` (not 8073)

4. Check firewall rules on your host

### Can't connect to radiod

1. Verify radiod is running and accessible

2. Check the network configuration between containers/host

3. Verify the addresses in config.yaml:
   ```bash
   docker exec ka9q_ubersdr cat /app/config.yaml | grep -A 3 radiod:
   ```

4. Test connectivity:
   ```bash
   docker exec ka9q_ubersdr ping -c 3 radiod
   # or
   docker exec ka9q_ubersdr ping -c 3 host.docker.internal
   ```

### Configuration not updating

1. Ensure volumes are properly mounted:
   ```bash
   docker inspect ka9q_ubersdr | grep Mounts -A 10
   ```

2. Restart the container after configuration changes:
   ```bash
   docker-compose restart ubersdr
   ```

## Updating

Rebuild the Docker images (source code is built during image creation):

```bash
# Update both containers
docker-compose build
docker-compose up -d

# Or update individually
docker-compose build ubersdr
docker-compose up -d ubersdr

docker-compose build radiod
docker-compose up -d radiod
```

## Security Considerations

- Always change the default admin password
- Use strong passwords for the `ADMIN_PASSWORD` environment variable
- Keep your Docker images updated
- Consider using Docker secrets for sensitive data in production
- Limit network exposure by binding to specific interfaces if needed

## Production Deployment

For production deployments, consider:

1. Using specific Ubuntu version tags instead of `latest`
2. Implementing proper logging and monitoring
3. Setting resource limits in docker-compose.yml
4. Using Docker secrets for sensitive configuration
5. Running behind a reverse proxy (nginx, traefik) for HTTPS
6. Regular backups of Docker volumes:
   ```bash
   docker run --rm -v ubersdr-data:/data -v $(pwd):/backup ubuntu tar czf /backup/ubersdr-backup.tar.gz /data
   ```
7. Implementing automatic restart policies
8. Using orchestration tools (Kubernetes, Docker Swarm) for high availability

## Advanced Configuration

### Running Only ubersdr (with external radiod)

If you want to run only the ubersdr container with an external radiod instance:

1. Comment out the radiod service in docker-compose.yml
2. Update the network configuration to connect to your radiod instance
3. Modify the ubersdr config.yaml to point to your radiod address

### USB Device Permissions

The radiod container runs in privileged mode for USB access. For better security in production:

1. Use specific device mappings instead of privileged mode:
   ```yaml
   devices:
     - /dev/bus/usb/001/002:/dev/bus/usb/001/002
   ```

2. Add udev rules on the host for SDR devices

### Multicast Configuration

The containers use FNV-1 hash-based multicast address generation (matching ka9q-radio's behavior):
- When DNS resolution fails for "radiod:5006", a multicast address is generated using FNV-1 hash
- Addresses are in the 239.0.0.0/8 range (administratively scoped)
- Collision avoidance for 239.0.0.0/24 and 239.128.0.0/24 ranges

## Support

For issues specific to the Docker setup:
- Docker logs: `docker-compose logs`
- Container status: `docker-compose ps`
- System resources: `docker stats`
- Network inspection: `docker network inspect docker_sdr-network`

For application-specific issues, refer to the main project README.md