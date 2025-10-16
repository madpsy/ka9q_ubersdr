# ka9q_ubersdr

Web interface for ka9q-radio SDR software.

## Installation

### System Prerequisites

Install Docker and Docker Compose:
```bash
sudo apt install docker-compose
```

Add your user to the docker group (to run Docker without sudo):
```bash
sudo adduser $(whoami) docker
```

**Important:** Restart your shell for the user group to take effect (log out and back in, or start a new terminal session).

### Clone Repositories

Create a directory for the SDR projects and clone both repositories:
```bash
mkdir ubersdr
cd ubersdr
git clone https://github.com/madpsy/ka9q-radio.git
git clone https://github.com/madpsy/ka9q_ubersdr.git
```

### Build Docker Images

Build the ka9q-radio container:
```bash
cd ka9q-radio/docker
docker-compose build
```

Build the ka9q_ubersdr container:
```bash
cd ../../ka9q_ubersdr/docker/
docker-compose build
```

### Create Docker Network

Create the shared network for communication between containers:
```bash
docker network create sdr-network --subnet 172.20.0.0/16
```

### Start the Services

Start both services using the unified docker-compose:
```bash
cd ../../ka9q_ubersdr/docker/
ADMIN_PASSWORD="supersecretpassword" docker compose up -d
```

This will automatically start both ka9q-radio and ka9q_ubersdr, ensuring radiod is healthy before starting the web interface.

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
docker compose logs -f

# Just radiod
docker compose logs -f ka9q-radio

# Just web interface
docker compose logs -f ka9q_ubersdr
```

### Stop Services

```bash
cd ka9q_ubersdr/docker
docker compose down
```

## Documentation

For detailed configuration options, troubleshooting, and development workflow, see [docker/README.md](docker/README.md).
