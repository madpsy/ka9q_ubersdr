# UberSDR with Caddy Reverse Proxy

This Docker Compose configuration adds Caddy as a reverse proxy to enable secure HTTPS access to UberSDR while maintaining direct HTTP access on port 8080.

## Features

- **HTTPS Access**: Automatic SSL/TLS certificates via Let's Encrypt
- **Direct Access**: Port 8080 remains available for direct HTTP connections
- **Security Headers**: HSTS, XSS protection, and other security headers
- **HTTP/3 Support**: Modern protocol support for improved performance
- **Automatic Redirects**: Optional www to non-www redirect

## Configuration

### 1. Edit the Caddyfile

Before starting, edit `docker/Caddyfile` and replace:

- `ubersdr.example.com` with your actual domain name
- `admin@example.com` with your actual email address (for Let's Encrypt notifications)

```bash
# Example:
ubersdr.yourdomain.com {
    tls your-email@yourdomain.com
    ...
}
```

### 2. DNS Configuration

Ensure your domain points to your server's public IP address:

```
A Record: ubersdr.example.com -> YOUR_PUBLIC_IP
```

### 3. Router Port Forwarding

Configure your router to forward incoming traffic to the host running UberSDR:

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

### Starting the Services

```bash
cd docker
docker-compose -f docker-compose-caddy.yml up -d
```

### Viewing Logs

```bash
# All services
docker-compose -f docker-compose-caddy.yml logs -f

# Caddy only
docker-compose -f docker-compose-caddy.yml logs -f caddy

# UberSDR only
docker-compose -f docker-compose-caddy.yml logs -f ubersdr
```

### Stopping the Services

```bash
docker-compose -f docker-compose-caddy.yml down
```

### Updating Configuration

After editing the Caddyfile:

```bash
docker-compose -f docker-compose-caddy.yml restart caddy
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
3. Check Caddy logs: `docker-compose -f docker-compose-caddy.yml logs caddy`

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

To disable direct access, remove the `ports` section from the `ubersdr` service in `docker-compose-caddy.yml`.

## Security Considerations

- Keep your email address up to date for certificate expiration notifications
- Consider restricting port 8080 to local network only via firewall rules
- Regularly update Docker images: `docker-compose -f docker-compose-caddy.yml pull`
- Monitor Caddy access logs: `docker exec caddy cat /data/access.log`

## Volumes

The configuration uses the following persistent volumes:

- `caddy-data`: SSL certificates and Caddy data
- `caddy-config`: Caddy configuration cache
- `ubersdr-config`: UberSDR configuration
- `radiod-config`: ka9q-radio configuration
- `radiod-data`: ka9q-radio data

To reset Caddy (e.g., to get new certificates):

```bash
docker-compose -f docker-compose-caddy.yml down
docker volume rm docker_caddy-data docker_caddy-config
docker-compose -f docker-compose-caddy.yml up -d