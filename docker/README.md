# Docker Setup for ka9q_ubersdr and ka9q-radio

This directory contains Docker configuration files for running both ka9q-radio (SDR backend) and ka9q_ubersdr (web interface) in containerized environments based on Alpine Linux.

## Overview

The setup includes two separate Docker images:

1. **ka9q-radio** - The SDR backend that interfaces with hardware and provides RTP streams
2. **ka9q_ubersdr** - The web interface for controlling and monitoring the SDR

## Prerequisites

- Docker installed on your system
- Docker Compose (optional, but recommended)
- For ka9q_ubersdr: Pre-built binary (see Building section)
- For ka9q-radio: Source code will be built in the container
- USB SDR hardware (for ka9q-radio)

## Files

- **Dockerfile.ka9q-radio** - Alpine Linux container for ka9q-radio SDR backend
- **Dockerfile.ubersdr** - Alpine Linux container for ka9q_ubersdr web interface
- **docker-compose.yml** - Orchestrates both services together
- **entrypoint.sh** - Startup script for ubersdr that handles configuration
- **.dockerignore** - Files to exclude from the Docker build context

## Quick Start with Docker Compose (Both Services)

This is the recommended way to run the complete system.

1. Build the ka9q_ubersdr binary:
   ```bash
   make build
   ```

2. Edit radiod-rx888.conf as needed:
   ```bash
   nano radiod-rx888.conf
   ```

3. Set admin password (optional):
   ```bash
   export ADMIN_PASSWORD=your_secure_password
   ```

4. Start both services:
   ```bash
   cd docker
   docker-compose up -d
   ```

5. Access the web interface at `http://localhost:8080`

6. View logs:
   ```bash
   docker-compose logs -f
   # Or for specific service:
   docker-compose logs -f radiod
   docker-compose logs -f ubersdr
   ```

7. Stop the services:
   ```bash
   docker-compose down
   ```

## Running Services Individually

### ka9q-radio (SDR Backend)

#### Build the Image

From the project root directory:

```bash
docker build -f docker/Dockerfile.ka9q-radio -t ka9q_radio:latest .
```

#### Run the Container

```bash
# Create a network first
docker network create ka9q-network

# Run radiod
docker run -d \
  --name ka9q_radiod \
  --network ka9q-network \
  --privileged \
  --device /dev/bus/usb:/dev/bus/usb \
  -v $(pwd)/radiod-rx888.conf:/etc/ka9q-radio/radiod-rx888.conf:ro \
  -v $(pwd)/docker/radiod-data:/var/lib/ka9q-radio \
  ka9q_radio:latest
```

**Note:** The `--privileged` flag and device mapping are required for USB SDR hardware access.

### ka9q_ubersdr (Web Interface)

#### Build the Binary First

```bash
make build
```

#### Build the Image

From the project root directory:

```bash
docker build -f docker/Dockerfile.ubersdr -t ka9q_ubersdr:latest .
```

#### Run the Container

```bash
# Create a network first
docker network create ka9q-network

# Run ubersdr (mount config files from project root)
docker run -d \
  --name ka9q_ubersdr \
  --network ka9q-network \
  -p 8080:8073 \
  -v $(pwd)/config.yaml:/app/config/config.yaml \
  -v $(pwd)/bands.yaml:/app/config/bands.yaml \
  -v $(pwd)/bookmarks.yaml:/app/config/bookmarks.yaml \
  ka9q_ubersdr:latest
```

## Configuration

### ka9q-radio Configuration

#### Environment Variables

- **TZ** - Timezone for the container (default: `UTC`)

#### Volumes

- `/etc/ka9q-radio/radiod-rx888.conf` - Configuration file (mount from project root)
- `/var/lib/ka9q-radio` - Data directory (wisdom files, etc.)

- `/var/lib/ka9q-radio` - Data directory (wisdom files, etc.)

#### Ports

- **5004/udp** - RTP audio stream
- **5006/udp** - RTP control

#### Configuration File

The container expects the configuration file to be mounted at `/etc/ka9q-radio/radiod-rx888.conf`. By default, docker-compose mounts the `radiod-rx888.conf` file from the project root directory.

**Note:** The radiod configuration uses multicast addresses (`hf-status.local`, `pcm.local`) which work fine in the container. The ubersdr container is configured to connect to `ka9q_radiod` (the container hostname) instead of multicast addresses, as Docker bridge networks don't support multicast DNS resolution.

#### Hardware Access

The container needs privileged mode and USB device access to communicate with SDR hardware:

```yaml
privileged: true
devices:
  - /dev/bus/usb:/dev/bus/usb
```

### ka9q_ubersdr Configuration

#### Environment Variables

- **CONFIG_PATH** - Path to the config.yaml file (default: `/app/config/config.yaml`)
- **TZ** - Timezone for the container (default: `UTC`)

#### Volumes

- `/app` - Working directory (persistent volume mounted to `docker/ubersdr-data/`)
  - Contains config files: `config.yaml`, `bands.yaml`, `bookmarks.yaml`
  - On first run, example configs are automatically copied here
  - Edit files directly in `docker/ubersdr-data/` directory

**Important:** ka9q_ubersdr expects config files in its current working directory (/app). The entire /app directory is mounted as a volume for persistence. Configuration files are automatically initialized from examples on first run, and Docker networking fixes plus admin password are applied on every startup.

#### Ports

- **8080/tcp** - Web interface

#### Automatic Configuration Changes

The entrypoint script runs on every container startup and:
1. **Initializes config files** - Copies example configs to `/app/config/` if they don't exist
2. **Applies Docker networking fixes** to config.yaml:
   - Changes `radiod->interface` from `"lo"` to `""` (listen on all interfaces)
   - Changes `radiod->status_group` from `"hf-status.local:5006"` to `"ka9q_radiod:5006"`
   - Changes `radiod->data_group` from `"pcm.local:5004"` to `"ka9q_radiod:5004"`
3. **Updates admin password** - If `ADMIN_PASSWORD` environment variable is set, it overwrites the password in config.yaml

These changes ensure proper communication between containers on the private network, as multicast DNS (.local) doesn't work in Docker bridge networks.

## Network Configuration

### Docker Compose Setup

The docker-compose.yml creates a private bridge network (`ka9q-network`) for both services:
- Both containers communicate on the private network
- ubersdr can access radiod by container name (`radiod`)
- Only ubersdr's web interface (port 8080) is exposed to the host
- RTP streams remain internal to the private network

### Standalone Containers

If running containers separately, they must be on the same network to communicate:

```bash
# Create a network
docker network create ka9q-network

# Run radiod on the network
docker run --network ka9q-network --name radiod ...

# Run ubersdr on the same network
docker run --network ka9q-network --name ubersdr ...
```

This allows ubersdr to connect to radiod using the container name as hostname.

### Multicast Support

For multicast networking, use host network mode:

```yaml
network_mode: host
```

Or with Docker CLI:
```bash
docker run --network host ...
```

**Note:** When using host network mode, port mappings are ignored.

## Health Checks

### ka9q-radio

Checks if the radiod process is running:
```bash
docker ps  # Check HEALTH status
```

### ka9q_ubersdr

Verifies the web interface is responding:
```bash
docker ps  # Check HEALTH status
```

## Troubleshooting

### ka9q-radio Issues

#### Container won't start

1. Check logs:
   ```bash
   docker-compose logs radiod
   ```

2. Verify USB device access:
   ```bash
   docker exec ka9q_radiod ls -la /dev/bus/usb
   ```

3. Check if SDR hardware is detected:
   ```bash
   docker exec ka9q_radiod lsusb
   ```

#### No audio output

1. Verify RTP ports are accessible:
   ```bash
   netstat -an | grep 5004
   ```

2. Check radiod configuration file
3. Verify SDR hardware is working

### ka9q_ubersdr Issues

#### Container won't start

1. Check logs:
   ```bash
   docker-compose logs ubersdr
   ```

2. Verify the binary was built:
   ```bash
   ls -lh ka9q_ubersdr
   ```

3. Check file permissions:
   ```bash
   chmod +x ka9q_ubersdr
   ```

#### Can't access web interface

1. Verify the container is running:
   ```bash
   docker ps
   ```

2. Check port bindings (should show 8080 -> 8073):
   ```bash
   docker port ka9q_ubersdr
   ```

3. Access at `http://localhost:8080` (not 8073)

4. Check firewall rules on your host

#### Can't connect to radiod

1. Verify both containers are on the same network:
   ```bash
   docker network inspect ka9q-network
   ```

2. Check radiod is running and healthy:
   ```bash
   docker ps
   ```

3. Verify ubersdr can reach radiod:
   ```bash
   docker exec ka9q_ubersdr ping -c 3 ka9q_radiod
   ```

4. Check RTP stream configuration in ubersdr config points to `radiod` or `ka9q_radiod`

### Configuration not updating

1. Ensure volumes are properly mounted:
   ```bash
   docker inspect ka9q_ubersdr | grep Mounts -A 10
   ```

2. Restart the container after configuration changes:
   ```bash
   docker-compose restart
   ```

## Updating

### Update ka9q-radio

Rebuild the image (source code is built during image creation):

```bash
docker-compose build radiod
docker-compose up -d radiod
```

### Update ka9q_ubersdr

1. Rebuild the binary:
   ```bash
   make build
   ```

2. Rebuild the Docker image:
   ```bash
   docker-compose build ubersdr
   ```

3. Restart the container:
   ```bash
   docker-compose up -d ubersdr
   ```

## Advanced Usage

### Running Multiple Instances

You can run multiple instances with different configurations:

```bash
# First instance
docker-compose -p ka9q1 up -d

# Second instance (edit docker-compose.yml to use different ports first)
docker-compose -p ka9q2 up -d
```

### Resource Limits

Add resource limits in docker-compose.yml:

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 1G
    reservations:
      cpus: '0.5'
      memory: 256M
```

### Custom Entrypoint

Override the entrypoint for debugging:

```bash
docker run -it --entrypoint /bin/bash ka9q_ubersdr:latest
```

## Security Considerations

- Always change the default admin password
- Use strong passwords for the `ADMIN_PASSWORD` environment variable
- Keep your Docker images updated
- Consider using Docker secrets for sensitive data in production
- Limit network exposure by binding to specific interfaces if needed
- Be cautious with `--privileged` mode - only use when necessary for hardware access
- Review and restrict USB device access to only required devices

## Production Deployment

For production deployments, consider:

1. Using specific Alpine version tags instead of `latest`
2. Implementing proper logging and monitoring
3. Setting resource limits
4. Using Docker secrets for sensitive configuration
5. Running behind a reverse proxy (nginx, traefik) for HTTPS
6. Regular backups of configuration and data volumes
7. Implementing automatic restart policies
8. Using orchestration tools (Kubernetes, Docker Swarm) for high availability

## Performance Optimization

### FFTW Wisdom

For better performance, generate FFTW wisdom in the ka9q-radio container:

```bash
docker exec ka9q_radiod fftwf-wisdom -v -T 1 -o /var/lib/ka9q-radio/wisdom \
  rof500000 cof36480 cob1920 cob1200 cob960 cob800 cob600 cob480 cob320 cob300 cob200 cob160
```

This can take several minutes but will improve FFT performance.

### CPU Affinity

Pin containers to specific CPU cores for better performance:

```yaml
cpuset: "0,1"  # Use cores 0 and 1
```

## Support

For issues specific to the Docker setup:
- Docker logs: `docker-compose logs`
- Container status: `docker-compose ps`
- System resources: `docker stats`

For application-specific issues, refer to:
- ka9q-radio: `ka9q-radio/README.md`
- ka9q_ubersdr: Main project `README.md`