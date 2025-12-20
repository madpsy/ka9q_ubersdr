# WSPR MQTT Aggregator - Docker Deployment

This directory contains Docker configuration files for deploying the WSPR MQTT Aggregator as a container.

## Quick Start

### Automated Installation (Recommended)

Run the installation script which will guide you through the setup:

```bash
cd wsprnet_mqtt/docker
./install.sh
```

The script will:
- Create the data directory
- Set up the configuration file
- Build the Docker image
- Start the container
- Display the auto-generated admin password

### Manual Installation

1. **Build and start the container:**
   ```bash
   docker-compose up -d
   ```
   
   This will automatically:
   - Create a Docker volume named `wsprnet-data`
   - Initialize config from example on first run
   - Generate a random admin password

2. **View logs to get the admin password:**
   ```bash
   docker-compose logs | grep "Generated random admin password"
   ```

3. **Access the web interface:**
   Open http://localhost:9009 in your browser

4. **Configure via admin interface:**
   - Login at http://localhost:9009/admin/login
   - Configure receiver, MQTT broker, and instances

5. **Stop the container:**
   ```bash
   docker-compose down
   ```
   
   **Note:** Your data persists in the Docker volume even after stopping

### Using Docker CLI

1. **Build the image:**
   ```bash
   docker build -t wsprnet-mqtt -f Dockerfile ..
   ```

2. **Create data directory:**
   ```bash
   mkdir -p data
   cp ../config.yaml.example data/config.yaml
   nano data/config.yaml
   ```

3. **Run the container:**
   ```bash
   docker run -d \
     --name wsprnet-mqtt \
     --restart unless-stopped \
     -p 9009:9009 \
     -v $(pwd)/data:/app/data \
     -e TZ=UTC \
     wsprnet-mqtt
   ```

4. **View logs:**
   ```bash
   docker logs -f wsprnet-mqtt
   ```

5. **Stop the container:**
   ```bash
   docker stop wsprnet-mqtt
   docker rm wsprnet-mqtt
   ```

## Configuration

### Docker Volume

The application uses a named Docker volume `wsprnet-data` for persistent storage:

- **Volume name:** `wsprnet-data`
- **Mount point:** `/app/data`
- **Contents:**
  - `config.yaml` - Application configuration (auto-created from example)
  - `wsprnet_stats.jsonl` - Statistics persistence file (auto-created)
  - `config.yaml.backup.*` - Timestamped backups (auto-created on updates)

### Managing the Volume

View volume details:
```bash
docker volume inspect wsprnet-data
```

Backup the volume:
```bash
docker run --rm -v wsprnet-data:/data -v $(pwd):/backup ubuntu tar czf /backup/wsprnet-backup.tar.gz -C /data .
```

Restore from backup:
```bash
docker run --rm -v wsprnet-data:/data -v $(pwd):/backup ubuntu tar xzf /backup/wsprnet-backup.tar.gz -C /data
```

Remove volume (WARNING: deletes all data):
```bash
docker-compose down -v
```

### Environment Variables

- `TZ` - Timezone (default: UTC)

### Ports

- `9009` - Web interface and API

## Admin Interface

The admin interface is available at http://localhost:9009/admin/login

### Admin Password

The admin password is **automatically generated** on first start for security. You can find it in the container logs:

```bash
docker-compose logs | grep "Generated random admin password"
```

Or view all logs:
```bash
docker-compose logs
```

### Custom Admin Password

To use a custom password, set the `ADMIN_PASSWORD` environment variable in `docker-compose.yml`:

```yaml
services:
  wsprnet-mqtt:
    environment:
      - ADMIN_PASSWORD=your-secure-password-here
```

Or set it directly in `data/config.yaml`:

```yaml
admin_password: "your-secure-password-here"
```

### Admin Features

- View and edit configuration
- Add/remove MQTT instances
- Save changes (triggers automatic container restart)

## Health Check

The container includes a health check that verifies the web interface is responding:
- Interval: 30 seconds
- Timeout: 10 seconds
- Retries: 3
- Start period: 5 seconds

Check health status:
```bash
docker ps
# or
docker inspect wsprnet-mqtt | grep -A 10 Health
```

## Configuration Management

### Automatic Config Merging

The container automatically merges new configuration fields from updates while preserving your settings:

1. On startup, the entrypoint script checks for new fields in `config.yaml.example`
2. Missing fields are added to your `data/config.yaml`
3. Your existing values are preserved
4. A timestamped backup is created before any changes

This means you can update the Docker image and your config will automatically get new features without manual editing.

### Automatic Restart

The container is configured with `restart: unless-stopped`, which means:
- Restarts automatically if it crashes
- Restarts automatically after system reboot
- Does NOT restart if manually stopped

When you save configuration changes via the admin interface, the application exits cleanly and Docker automatically restarts it with the new configuration.

## Building from Source

To build the image locally:

```bash
cd wsprnet_mqtt/docker
docker build -t wsprnet-mqtt -f Dockerfile ..
```

## Multi-Architecture Support

To build for multiple architectures (e.g., ARM64 for Raspberry Pi):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t wsprnet-mqtt -f Dockerfile ..
```

## Troubleshooting

### Container won't start
- Check logs: `docker-compose logs`
- Verify config.yaml exists in data directory
- Ensure config.yaml is valid YAML
- Check if yq is installed in container: `docker-compose exec wsprnet-mqtt yq --version`

### Can't connect to MQTT broker
- Verify broker URL in config.yaml
- Check network connectivity from container
- Ensure broker is accessible from Docker network

### Web interface not accessible
- Verify port 9009 is not in use: `netstat -tuln | grep 9009`
- Check firewall rules
- Verify container is running: `docker ps`

### Configuration changes not taking effect
- Save via admin interface (triggers automatic restart)
- Or manually restart: `docker-compose restart`

### Forgot admin password
- Check logs: `docker-compose logs | grep password`
- Or set a new one via environment variable in docker-compose.yml
- Or edit data/config.yaml directly and restart

## Security Considerations

1. **Admin Password**:
   - Automatically generated on first start (16 characters, alphanumeric + special chars)
   - Stored in logs - save it securely
   - Can be customized via environment variable
2. **Network**: Consider using Docker networks to isolate containers
3. **Volumes**: Ensure proper file permissions on mounted volumes
4. **Updates**:
   - Regularly rebuild images to get security updates
   - Config merging ensures your settings are preserved during updates
5. **Backups**: Config backups are created automatically before merges (timestamped)

## Example docker-compose.yml with MQTT Broker

```yaml
version: '3.8'

services:
  mosquitto:
    image: eclipse-mosquitto:latest
    container_name: mosquitto
    restart: unless-stopped
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto/config:/mosquitto/config
      - ./mosquitto/data:/mosquitto/data
      - ./mosquitto/log:/mosquitto/log
    networks:
      - wsprnet

  wsprnet-mqtt:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    container_name: wsprnet-mqtt
    restart: unless-stopped
    ports:
      - "9009:9009"
    volumes:
      - ./data:/app/data
    environment:
      - TZ=UTC
    networks:
      - wsprnet
    depends_on:
      - mosquitto

networks:
  wsprnet:
    driver: bridge
```

## Support

For issues and questions, please refer to the main README.md in the parent directory.