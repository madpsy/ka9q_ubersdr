# UberSDR with Caddy Reverse Proxy

Caddy is now integrated into the main Docker Compose configurations to provide secure HTTPS access to UberSDR while maintaining direct HTTP access on port 8080.

**NEW: Dynamic Configuration** - The Caddyfile is now automatically generated from your `config.yaml` settings on every startup. No manual Caddyfile editing required!

## Features

- **HTTPS Access**: Automatic SSL/TLS certificates via Let's Encrypt
- **Direct Access**: Port 8080 remains available for direct HTTP connections
- **Security Headers**: HSTS, XSS protection, and other security headers
- **HTTP/3 Support**: Modern protocol support for improved performance
- **Automatic Redirects**: Optional www to non-www redirect

## Configuration

### Automatic Caddyfile Generation

The Caddyfile is automatically generated from your `config.yaml` on every startup based on these settings:

**In `config.yaml`:**
```yaml
# Admin email (used for Let's Encrypt notifications)
admin:
  email: "admin@example.com"

# Instance connection settings (used for Caddy domain configuration)
instance_reporting:
  instance:
    host: "ubersdr.example.com"  # Your domain name (empty = HTTP-only)
    port: 8080                    # Port number
    tls: true                     # Enable HTTPS with Let's Encrypt
```

**Configuration Modes:**

1. **HTTP-Only Mode** (Default/Safe)
   - Used when: `host` is empty OR `tls` is false OR `admin.email` is empty
   - No certificate requests
   - Works everywhere (including behind firewalls)
   - Example: `host: ""` or `tls: false`

2. **HTTPS Mode** (Production)
   - Used when: `host` is set AND `tls` is true AND `admin.email` is set
   - Automatic Let's Encrypt certificates
   - Requires ports 80 and 443 accessible from internet
   - Example: `host: "ubersdr.example.com"`, `tls: true`, `email: "admin@example.com"`

### 2. DNS Configuration

Ensure your domain points to your server's public IP address:

```
A Record: ubersdr.example.com -> YOUR_PUBLIC_IP
```

### DNS Configuration (HTTPS Mode Only)

If using HTTPS mode (`tls: true`), ensure your domain points to your server's public IP address:

```
A Record: ubersdr.example.com → YOUR_PUBLIC_IP
```

### Router Port Forwarding (HTTPS Mode Only)

If using HTTPS mode, configure your router to forward incoming traffic:

**Required Port Forwards:**
- **TCP Port 80** → Host IP:80 (for Let's Encrypt certificate validation)
- **TCP Port 443** → Host IP:443 (for HTTPS access)

**Example Router Configuration:**
```
External Port 80   → Internal IP 192.168.1.100:80   (TCP)
External Port 443  → Internal IP 192.168.1.100:443  (TCP)
```

Replace `192.168.1.100` with the actual local IP address of your UberSDR host.

**Example if you use ufw and need to allow ports through:**
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8080/tcp  # Optional
```

## Usage

Caddy is now included in both main Docker Compose files:
- `docker-compose.yml` - For building from source
- `docker-compose-dockerhub.yml` - For using pre-built images from Docker Hub

### Starting the Services

**Using local build:**
```bash
cd docker
docker-compose up -d
```

**Using Docker Hub images:**
```bash
cd docker
docker-compose -f docker-compose-dockerhub.yml up -d
```

### Viewing Logs

```bash
# All services
docker-compose logs -f

# Caddy only
docker-compose logs -f caddy

# UberSDR only
docker-compose logs -f ubersdr
```

### Stopping the Services

```bash
docker-compose down
```

### Updating Configuration

After editing the Caddyfile:

```bash
docker-compose restart caddy
```

## Access Methods

Once running, you can access UberSDR via:

1. **HTTPS (Recommended)**: `https://ubersdr.example.com`
   - Secure, encrypted connection
   - Automatic SSL certificate
   - Security headers enabled

2. **Direct HTTP**: `http://your-server-ip:8080`
   - Direct access to UberSDR
   - No encryption
   - Useful for local network access

## Certificate Management

Caddy automatically:
- Obtains SSL certificates from Let's Encrypt
- Renews certificates before expiration
- Stores certificates in the `caddy-data` volume

To view certificate information:

```bash
docker exec caddy caddy list-certificates
```

## Troubleshooting

### Certificate Issues

If Let's Encrypt fails to issue a certificate:

1. Verify DNS is correctly configured
2. Ensure ports 80 and 443 are accessible from the internet
3. Check Caddy logs: `docker-compose logs caddy`
4. Verify your `config.yaml` settings:
   - `instance_reporting.instance.host` is set to your domain
   - `instance_reporting.instance.tls` is `true`
   - `admin.email` is set to a valid email address

**Behind a Firewall?**

If your server is behind a firewall and Let's Encrypt cannot reach it via HTTP-01 challenge:

1. **Recommended**: Set `tls: false` in `config.yaml` to use HTTP-only mode
   - Caddy will serve HTTP without attempting certificate requests
   - No failed Let's Encrypt attempts
   - Works perfectly behind firewalls

2. **Alternative**: Use DNS-01 challenge (requires manual Caddyfile editing)
   - Allows certificate acquisition without inbound HTTP/HTTPS access
   - Requires DNS provider API access
   - See Caddy documentation for DNS provider setup

Caddy will continue running and serving HTTP even if certificates cannot be obtained, so there's no harm in always having it enabled.

### Connection Issues

If you can't connect via HTTPS:

1. Verify the domain resolves to your server: `nslookup ubersdr.example.com`
2. Check firewall rules allow ports 80 and 443
3. Ensure Caddy container is running: `docker ps`

### Direct Access Still Works

Port 8080 remains exposed for direct HTTP access. This is intentional and allows:
- Local network access without going through the reverse proxy
- Fallback access if the domain/certificate has issues
- Development and testing

To disable direct access, remove the `ports` section from the `ubersdr` service in the Docker Compose file you're using.

## Security Considerations

- Keep your email address up to date for certificate expiration notifications
- Consider restricting port 8080 to local network only via firewall rules
- Regularly update Docker images: `docker-compose pull`
- Monitor Caddy access logs: `docker exec caddy cat /data/access.log`

## Automatic Restart on Configuration Changes

Caddy now supports automatic restart when configuration changes are detected. This is useful when UberSDR updates the Caddyfile dynamically.

### How It Works

1. UberSDR writes a trigger file: `/var/run/restart-trigger/restart-caddy`
2. Caddy's entrypoint script detects the file and restarts the container
3. The trigger file is automatically removed after restart

This mechanism is similar to how radiod restarts when triggered by UberSDR on startup.

### Manual Restart Trigger

You can manually trigger a Caddy restart from within the UberSDR container:

```bash
docker exec ka9q_ubersdr touch /var/run/restart-trigger/restart-caddy
```

Or from the host:

```bash
docker exec ka9q_ubersdr sh -c "touch /var/run/restart-trigger/restart-caddy"
```

The Caddy container will detect the file and restart within 0.5 seconds.

## Volumes

The configuration uses the following persistent volumes:

- `caddy-data`: SSL certificates and Caddy data
- `caddy-config`: Caddy configuration cache
- `caddy-shared`: Shared volume for dynamic Caddyfile (generated by ubersdr)
- `restart-trigger`: Shared volume for restart trigger files
- `ubersdr-config`: UberSDR configuration
- `radiod-config`: ka9q-radio configuration
- `radiod-data`: ka9q-radio data

To reset Caddy (e.g., to get new certificates):

```bash
docker-compose down
docker volume rm docker_caddy-data docker_caddy-config docker_caddy-shared
docker-compose up -d