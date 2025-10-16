# ka9q_ubersdr

Web interface for ka9q-radio SDR software.

## Installation

### System Prerequisites

Install Docker:
```bash
sudo apt install docker.io
```

Docker includes Compose as a built-in plugin (use `docker compose` instead of `docker-compose`).

### Clone Repositories

Create a directory for the SDR projects and clone both repositories:
```bash
mkdir ubersdr
cd ubersdr
git clone https://github.com/madpsy/ka9q-radio.git
git clone https://github.com/madpsy/ka9q_ubersdr.git
```

**Note for Debian Bookworm users (Raspberry Pi, etc.):** If you're running Debian Bookworm, run the Docker installation script before proceeding:
```bash
cd ka9q_ubersdr
./install-docker-bookworm.sh
```

### Build and Start Services

Build both containers from the unified docker-compose:
```bash
cd ka9q_ubersdr/docker/
sudo docker compose build
```

Start both services:
```bash
sudo ADMIN_PASSWORD="supersecretpassword" docker compose up -d
```

This will automatically:
- Create the shared network (sdr-network) if it doesn't exist
- Start ka9q-radio (radiod)
- Wait for radiod to be healthy
- Start ka9q_ubersdr web interface

### Access the Web Interface

Open your browser and navigate to:
```
http://<IP address>:8080
```

Replace `<IP address>` with your server's IP address, or use `localhost` if running locally.

### View Logs

```bash
cd ka9q_ubersdr/docker

# All services
sudo docker compose logs -f

# Just radiod
sudo docker compose logs -f ka9q-radio

# Just web interface
sudo docker compose logs -f ka9q_ubersdr
```

### Stop Services

```bash
cd ka9q_ubersdr/docker
sudo docker compose down
```

## Documentation

For detailed configuration options, troubleshooting, and development workflow, see [docker/README.md](docker/README.md).
