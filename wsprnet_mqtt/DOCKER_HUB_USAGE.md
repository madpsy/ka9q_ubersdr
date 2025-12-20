# WSPR MQTT Aggregator - Docker Hub Usage

This guide explains how to run the WSPR MQTT Aggregator using the pre-built Docker image from Docker Hub.

## Quick Start

1. **Create a directory for your deployment:**
   ```bash
   mkdir wsprnet-mqtt
   cd wsprnet-mqtt
   ```

2. **Download the docker-compose file:**
   ```bash
   wget https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/wsprnet_mqtt/docker-compose-hub.yaml
   ```

3. **Create your configuration file:**
   ```bash
   wget https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/wsprnet_mqtt/config.yaml.example -O config.yaml
   ```

4. **Edit the configuration:**
   ```bash
   nano config.yaml
   ```
   
   At minimum, configure:
   - Your receiver callsign and locator
   - MQTT broker connection details
   - MQTT instances to subscribe to

5. **Start the container:**
   ```bash
   docker-compose -f docker-compose-hub.yaml up -d
   ```

6. **Access the web dashboard:**
   Open your browser to `http://localhost:9009`

## Configuration

The `config.yaml` file must be in the same directory as `docker-compose-hub.yaml`. The container will mount it as read-only.

### Example config.yaml:

```yaml
receiver:
  callsign: "W1ABC"
  locator: "FN42"

mqtt:
  broker: "tcp://mqtt.example.com:1883"
  username: ""
  password: ""
  qos: 0
  instances:
    - name: "My UberSDR"
      topic_prefix: "ubersdr/instance1"

web_port: 9009
dry_run: false
persistence_file: "data/wsprnet_stats.json"
admin_password: ""  # Set this to enable admin interface
```

## Admin Interface

To enable the admin interface:

1. Set `admin_password` in your `config.yaml`
2. Restart the container: `docker-compose -f docker-compose-hub.yaml restart`
3. Access admin at: `http://localhost:9009/admin/login`

The admin interface allows you to:
- Modify configuration without editing files
- View real-time statistics
- Manage MQTT instances

**Note:** Saving configuration in the admin interface will restart the application.

## Viewing Logs

```bash
docker-compose -f docker-compose-hub.yaml logs -f
```

## Stopping the Container

```bash
docker-compose -f docker-compose-hub.yaml down
```

## Updating to Latest Version

```bash
docker-compose -f docker-compose-hub.yaml pull
docker-compose -f docker-compose-hub.yaml up -d
```

## Data Persistence

Statistics and state are persisted in a Docker volume named `wsprnet-data`. This data survives container restarts and updates.

To backup your data:
```bash
docker run --rm -v wsprnet-data:/data -v $(pwd):/backup alpine tar czf /backup/wsprnet-backup.tar.gz -C /data .
```

To restore from backup:
```bash
docker run --rm -v wsprnet-data:/data -v $(pwd):/backup alpine tar xzf /backup/wsprnet-backup.tar.gz -C /data
```

## Troubleshooting

### Container won't start
- Check logs: `docker-compose -f docker-compose-hub.yaml logs`
- Verify `config.yaml` exists and is valid YAML
- Ensure port 9009 is not already in use

### Can't connect to MQTT broker
- Verify broker URL in config.yaml
- Check network connectivity from container
- Verify credentials if authentication is required

### No spots appearing
- Check MQTT topic subscriptions match your UberSDR instances
- Verify MQTT messages are being published by your UberSDR
- Check logs for any error messages

## Support

For issues and questions:
- GitHub: https://github.com/madpsy/ka9q_ubersdr
- Docker Hub: https://hub.docker.com/r/madpsy/wsprnet-mqtt