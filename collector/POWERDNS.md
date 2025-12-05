# PowerDNS Integration

The collector can automatically create DNS subdomains for UberSDR instances using PowerDNS.

## Overview

When an instance reports to the collector with `create_domain: true` in its JSON payload, the collector will:

1. **Use the source IP address** of the request (not the `host` field from JSON)
2. **Verify the instance is publicly accessible** via callback to the source IP (ignoring TLS certificate errors)
3. Validate the callsign as a valid DNS subdomain label
4. Validate the source IP address as a valid IPv4 address
5. Create or update an A record in PowerDNS pointing `<callsign>.instance.ubersdr.org` to the source IP

**Important Security Feature**: DNS records are only created or updated AFTER the instance has been successfully verified as publicly accessible via callback. This prevents DNS pollution from invalid or inaccessible instances.

**TLS Certificate Handling**: When `create_domain: true`, the verification callback ignores TLS certificate errors since the DNS record doesn't exist yet and the instance won't have a valid certificate for the subdomain.

The DNS record is updated every time the instance sends its data (and passes verification), ensuring the IP address stays current.

## Configuration

Add the following to your `config.json`:

```json
{
  "listen": ":8443",
  "database_path": "instances.db",
  "powerdns": {
    "enabled": true,
    "api_key": "your-powerdns-api-key-here",
    "api_url": "http://localhost:8081",
    "server_id": "localhost",
    "zone_name": "instance.ubersdr.org"
  }
}
```

### Configuration Fields

- `enabled`: Set to `true` to enable PowerDNS integration
- `api_key`: Your PowerDNS API key (configured in PowerDNS)
- `api_url`: The base URL of your PowerDNS API (typically `http://localhost:8081`)
- `server_id`: The PowerDNS server ID (usually `localhost`)
- `zone_name`: The DNS zone name where subdomains will be created (e.g., `instance.ubersdr.org`)

## PowerDNS Setup

1. Install and configure PowerDNS with the API enabled
2. Create the zone `instance.ubersdr.org` (or your chosen zone name)
3. Generate an API key in PowerDNS configuration
4. **Configure firewall access**: The collector's host IP must be allowed through the firewall to reach the PowerDNS server (default port 8081)
5. **Configure PowerDNS webserver access**: Add the collector's IP address to the `webserver-allow-from` list in `/etc/powerdns/pdns.conf`:
   ```
   webserver-allow-from=127.0.0.1,::1,<collector-ip-address>
   ```
   For example:
   ```
   webserver-allow-from=127.0.0.1,::1,192.168.1.100
   ```
6. Restart PowerDNS after configuration changes:
   ```bash
   systemctl restart pdns
   ```

## Instance Configuration

Instances should include the following field in their JSON payload when reporting to the collector:

```json
{
  "uuid": "...",
  "callsign": "W1ABC",
  "host": "w1abc.instance.ubersdr.org",
  "port": 8073,
  "create_domain": true,
  ...
}
```

### Fields Used

- `create_domain`: Boolean flag to request DNS subdomain creation
- `callsign`: Used as the subdomain label (must be valid DNS label)
- `host`: **MUST** be set to `<callsign>.<zone_name>` (e.g., `w1abc.instance.ubersdr.org`)
- `port`: Port number for verification callback

### Host Field Validation

**Critical**: When `create_domain: true`, the collector validates that the `host` field matches the expected format:
- Format: `<callsign>.<zone_name>` (case-insensitive)
- Example: If callsign is `W1ABC` and zone is `instance.ubersdr.org`, host must be `w1abc.instance.ubersdr.org`
- The request will be **rejected** if the host doesn't match this format

**Important**: The `host` field should contain the DNS hostname, NOT an IP address. The collector will use the **source IP address** of the HTTP request to create the DNS record.

## Validation

### Callsign Validation

The callsign must be a valid DNS subdomain label:
- 1-63 characters long
- Contains only alphanumeric characters and hyphens
- Cannot start or end with a hyphen
- Cannot contain consecutive hyphens

Examples:
- ✅ Valid: `w1abc`, `k2xyz`, `g4-test`
- ❌ Invalid: `-w1abc`, `w1abc-`, `w1--abc`, `this-is-way-too-long-for-a-dns-label-and-will-be-rejected`

### IP Address Validation

The source IP address must be:
- A valid IPv4 address format
- A publicly routable address (not private/loopback/reserved)

The collector automatically extracts the source IP from the HTTP request (checking `X-Forwarded-For` headers if behind a proxy).

## DNS Record Details

- **Record Type**: A (IPv4 address)
- **TTL**: 60 seconds (1 minute)
- **Format**: `<callsign>.instance.ubersdr.org.` → `<ip_address>`
- **Update Behavior**: Records are created or updated (REPLACE) on each instance report

## DNS Record Lifecycle

### Creation
- DNS record is created when `create_domain: true` is first sent
- The `has_subdomain` flag is set to `true` in the database

### Updates
- DNS record IP address is updated on every report with `create_domain: true`
- Keeps the DNS record synchronized with the instance's current IP

### Deletion
DNS records are automatically deleted in two scenarios:

1. **Instance disables subdomain**: When an instance that previously had `create_domain: true` sends a report with `create_domain: false` or omits the field entirely
2. **Instance ages out**: When an instance hasn't reported in 24 hours, it's removed from the database and its DNS record is deleted

This ensures DNS records are always cleaned up properly and don't become stale.

## Error Handling

If DNS record creation fails:
- The error is logged but does not fail the instance registration
- The instance will still be registered in the collector database
- DNS creation will be retried on the next instance report

## Security Considerations

1. **API Key Protection**: Keep your PowerDNS API key secure
2. **IP Validation**: Only valid public IPv4 addresses are accepted
3. **Callsign Validation**: Prevents DNS injection attacks through strict validation
4. **Zone Isolation**: Use a dedicated zone for instance subdomains

## Troubleshooting

### DNS Record Not Created

Check the collector logs for error messages:
```
Failed to create/update DNS record for W1ABC: <error details>
```

Common issues:
- PowerDNS API not accessible
- Invalid API key
- Zone does not exist in PowerDNS
- Callsign contains invalid characters
- IP address is not a valid public IPv4 address

### Verifying DNS Records

Query the DNS record directly:
```bash
dig @<powerdns-server> w1abc.instance.ubersdr.org A
```

Or check via PowerDNS API:
```bash
curl -H "X-API-Key: your-api-key" \
  http://localhost:8081/api/v1/servers/localhost/zones/instance.ubersdr.org.
```

## Example

Instance sends:
```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "callsign": "W1ABC",
  "host": "203.0.113.42",
  "port": 8073,
  "create_domain": true,
  ...
}
```

Result:
- DNS record created: `w1abc.instance.ubersdr.org` → `203.0.113.42`
- TTL: 300 seconds
- Comment: "Auto-created by UberSDR Collector for W1ABC"

Users can then access the instance at:
```
http://w1abc.instance.ubersdr.org:8073