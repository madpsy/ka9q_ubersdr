# ka9q_ubersdr

Web interface for ka9q-radio SDR software.

## Docker Installation (Recommended)

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

Start ka9q_ubersdr with admin password:
```bash
ADMIN_PASSWORD="supersecretpassword" docker-compose up -d
```

Start ka9q-radio:
```bash
cd ../../ka9q-radio/docker/
docker-compose up -d
```

### Access the Web Interface

Open your browser and navigate to:
```
http://<IP address>:8080
```

Replace `<IP address>` with your server's IP address, or use `localhost` if running locally.

## Manual Installation

### Build radiod

Install at least Golang 1.24

Install dependencies for radiod:

```bash
sudo apt install libbsd-dev libiniparser-dev libopus-dev libavahi-client-dev libavahi-common-dev libavahi-client-dev libavahi-common-dev libncurses5-dev libncursesw5-dev libportaudio2 portaudio19-dev libsamplerate0 libsamplerate0-dev libogg-dev libvorbis-dev libogg-dev libvorbis-dev libairspyhf-dev libairspy-dev librtlsdr-dev libfftw3-dev uuid-dev avahi-utils
```

Build and install:
```bash
cd ka9q-radio
make
sudo make install
sudo fftwf-wisdom -v -T 1 -o /var/lib/ka9q-radio/wisdom rof500000 cof36480 cob1920 cob1200 cob960 cob800 cob600 cob480 cob320 cob300 cob200 cob160
cd ..
radiod radiod-rx888.conf
```

### Build ubersdr

```bash
make
cp config.yaml.example config.yaml
cp bands.yaml.example bands.yaml
cp bookmarks.yaml.example bookmarks.yaml
```

Change admin password in config.yaml

```bash
./ka9q_ubersdr
