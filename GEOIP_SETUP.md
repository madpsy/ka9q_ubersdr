# GeoIP Setup Guide

This guide explains how to set up IP geolocation functionality in UberSDR using MaxMind's GeoLite2 database.

## Overview

The GeoIP service provides IP-to-country lookup functionality for:
- **Internal use**: Enriching session data with country information
- **Admin API**: Allowing administrators to lookup IP addresses and view sessions with country data

**Important**: This service is **NOT** publicly accessible. It's only available to:
1. Internal modules (session management, logging, analytics)
2. Admin API endpoints (requires admin authentication)

## Prerequisites

You need a MaxMind account to download the GeoLite2 database:

1. Create a free account at: https://www.maxmind.com/en/geolite2/signup
2. Generate a license key in your account settings
3. Download the GeoLite2-Country database

## Installation Steps

### 1. Download the GeoLite2 Database

#### Option A: Manual Download

1. Log in to your MaxMind account
2. Navigate to "Download Files" → "GeoLite2 Country"
3. Download the **GeoLite2-Country.mmdb** file (MMDB format)
4. Extract the `.mmdb` file from the archive

#### Option B: Using geoipupdate (Recommended for automatic updates)

Install the `geoipupdate` tool:

```bash
# Ubuntu/Debian
sudo apt-get install geoipupdate

# CentOS/RHEL
sudo yum install geoipupdate

# macOS
brew install geoipupdate
```

Configure `/etc/GeoIP.conf`:

```conf
AccountID YOUR_ACCOUNT_ID
LicenseKey YOUR_LICENSE_KEY
EditionIDs GeoLite2-Country
DatabaseDirectory /var/lib/GeoIP
```

Run the update:

```bash
sudo geoipupdate
```

### 2. Place the Database File

Copy the database to a location accessible by UberSDR:

```bash
# Create directory if it doesn't exist
sudo mkdir -p /var/lib/ubersdr

# Copy the database
sudo cp GeoLite2-Country.mmdb /var/lib/ubersdr/

# Set appropriate permissions
sudo chown ubersdr:ubersdr /var/lib/ubersdr/GeoLite2-Country.mmdb
sudo chmod 644 /var/lib/ubersdr/GeoLite2-Country.mmdb
```

### 3. Configure UberSDR

Add the following to your `config.yaml`:

```yaml
geoip:
  enabled: true
  database_path: "/var/lib/ubersdr/GeoLite2-Country.mmdb"
```

### 4. Restart UberSDR

```bash
sudo systemctl restart ubersdr
```

Check the logs to confirm GeoIP service started successfully:

```bash
sudo journalctl -u ubersdr -f | grep -i geoip
```

You should see:
```
GeoIP: Service initialized successfully (database: /var/lib/ubersdr/GeoLite2-Country.mmdb)
```

## Admin API Endpoints

Once configured, the following admin-only endpoints are available:

### 1. Lookup IP Address

**Endpoint**: `POST /admin/geoip/lookup`

**Request**:
```json
{
  "ip": "8.8.8.8"
}
```

**Response**:
```json
{
  "ip": "8.8.8.8",
  "country": "United States",
  "country_code": "US",
  "continent": "NA"
}
```

**Example**:
```bash
curl -X POST http://localhost:8080/admin/geoip/lookup \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"ip":"8.8.8.8"}'
```

### 2. Get Sessions with Country Information

**Endpoint**: `GET /admin/sessions/countries`

**Response**:
```json
{
  "sessions": [
    {
      "user_session_id": "abc-123",
      "client_ip": "203.0.113.42",
      "country": "Australia",
      "country_code": "AU",
      "mode": "usb",
      "frequency": 14250000,
      "is_spectrum": false
    }
  ],
  "count": 1
}
```

**Example**:
```bash
curl http://localhost:8080/admin/sessions/countries \
  -b cookies.txt
```

### 3. Check GeoIP Service Health

**Endpoint**: `GET /admin/geoip-health`

**Response**:
```json
{
  "enabled": true,
  "status": "healthy"
}
```

**Example**:
```bash
curl http://localhost:8080/admin/geoip-health \
  -b cookies.txt
```

## Automatic Updates

MaxMind updates the GeoLite2 database weekly. To keep your database current:

### Using geoipupdate with cron

Add to `/etc/cron.weekly/geoipupdate`:

```bash
#!/bin/bash
/usr/bin/geoipupdate
systemctl reload ubersdr  # Reload to pick up new database
```

Make it executable:

```bash
sudo chmod +x /etc/cron.weekly/geoipupdate
```

### Using systemd timer

Create `/etc/systemd/system/geoipupdate.service`:

```ini
[Unit]
Description=Update GeoIP databases
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/geoipupdate
ExecStartPost=/bin/systemctl reload ubersdr
```

Create `/etc/systemd/system/geoipupdate.timer`:

```ini
[Unit]
Description=Weekly GeoIP database update

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
sudo systemctl enable geoipupdate.timer
sudo systemctl start geoipupdate.timer
```

## Troubleshooting

### Service Not Starting

**Check configuration**:
```bash
grep -A 2 "^geoip:" config.yaml
```

**Verify database file exists**:
```bash
ls -lh /var/lib/ubersdr/GeoLite2-Country.mmdb
```

**Check permissions**:
```bash
sudo -u ubersdr cat /var/lib/ubersdr/GeoLite2-Country.mmdb > /dev/null
```

### Database Not Found Error

If you see:
```
Warning: Failed to initialize GeoIP service: failed to open GeoIP database
```

1. Verify the path in `config.yaml` matches the actual file location
2. Check file permissions
3. Ensure the file is the correct format (`.mmdb`)

### Lookup Failures

If lookups fail for valid IPs:

1. Check the database is up to date
2. Verify the IP is not private (10.x.x.x, 192.168.x.x, etc.)
3. Check the health endpoint: `GET /admin/geoip-health`

## Privacy Considerations

- **No external API calls**: All lookups are performed locally
- **Admin-only access**: Public users cannot access geolocation data
- **Internal use only**: Country data is only stored in session objects for admin visibility
- **GDPR compliance**: Only country-level data is stored, no precise location
- **No logging**: IP lookups are not logged by default

## Performance

- **Lookup speed**: < 1ms per lookup (local database)
- **Memory usage**: ~10-20 MB for GeoLite2-Country database
- **Database size**: ~6 MB compressed, ~15 MB uncompressed
- **Update frequency**: Weekly (recommended)

## License

GeoLite2 databases are distributed under the Creative Commons Attribution-ShareAlike 4.0 International License.

You must include the following attribution in your application:

> This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com

## Support

For issues with:
- **UberSDR GeoIP integration**: Open an issue on the UberSDR GitHub repository
- **MaxMind database**: Contact MaxMind support or check their documentation
- **geoipupdate tool**: Check the geoipupdate documentation

## References

- MaxMind GeoLite2: https://dev.maxmind.com/geoip/geolite2-free-geolocation-data
- geoipupdate: https://github.com/maxmind/geoipupdate
- Go GeoIP2 library: https://github.com/oschwald/geoip2-golang
