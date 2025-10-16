# ka9q_ubersdr

Web interface for ka9q-radio SDR software.

> **Note:** This is currently designed for RX888 MKII SDR hardware to provide 0-30 MHz (full HF) coverage.

## Quick Start

> **Note:** This installation script is designed for Debian/Ubuntu-based systems only.

Run this one-liner to install and start everything automatically:

```bash
curl -fsSL https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/main/install.sh | bash
```

This will install Docker, clone both repositories, build the images, and start the services.

## Manual Installation

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
## Generate FFTW Wisdom File (Optional but Recommended)

It's recommended to generate an FFTW wisdom file, which is specific to each computer and optimises FFT performance. This step is optional but can significantly improve performance:

```bash
sudo fftwf-wisdom -v -T 1 -o /var/lib/docker/volumes/docker_radiod-data/_data/wisdom rof500000 cof36480 cob1920 cob1200 cob960 cob800 cob600 cob480 cob320 cob300 cob200 cob160
```

This command will take some time to complete as it benchmarks various FFT algorithms on your specific hardware.

After generating the wisdom file, restart the containers to use it:

```bash
cd ka9q_ubersdr/docker
sudo docker compose down
sudo docker compose up -d
```


## Making it Public with Cloudflare Tunnel

You can expose your SDR web interface to the internet securely using Cloudflare Tunnel (no port forwarding required).

### Prerequisites

1. A Cloudflare account with a domain
2. Install cloudflared:
   ```bash
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
   sudo dpkg -i cloudflared-linux-arm64.deb
   ```

### Setup

1. Authenticate with Cloudflare:
   ```bash
   cloudflared tunnel login
   ```

2. Create a tunnel:
   ```bash
   cloudflared tunnel create my-sdr-tunnel
   ```
   This will output a tunnel UUID - save this for the next step.

3. Create a config file at `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <your-tunnel-uuid>
   credentials-file: /home/<username>/.cloudflared/<your-tunnel-uuid>.json

   ingress:
     - hostname: sdr.yourdomain.com
       service: http://localhost:8080
     - service: http_status:404
   ```

4. Create a DNS record:
   ```bash
   cloudflared tunnel route dns my-sdr-tunnel sdr.yourdomain.com
   ```

5. Run the tunnel:
   ```bash
   cloudflared tunnel run my-sdr-tunnel
   ```

Your SDR interface will now be accessible at `https://sdr.yourdomain.com`

### Run as a Service

To keep the tunnel running automatically:
```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```
