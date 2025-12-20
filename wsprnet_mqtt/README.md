# WSPR MQTT Aggregator

A Go application that aggregates WSPR decodes from multiple UberSDR instances via MQTT and submits them to WSPRNet.

## Features

- Subscribes to MQTT topics for WSPR decodes from multiple UberSDR instances
- Aggregates spots from all bands (160m, 80m, 40m, 30m, 20m, etc.)
- Submits spots to WSPRNet with your configured receiver callsign and locator
- **Deduplication**: Aggregates spots within 2-minute windows and removes duplicates
- **Best SNR Selection**: When multiple instances report the same callsign, keeps the report with highest SNR
- Parallel upload workers for efficient submission
- Automatic retry logic with exponential backoff
- Queue management to handle high volumes

## Installation

### Prerequisites

- Go 1.21 or later
- Access to an MQTT broker
- One or more UberSDR instances publishing WSPR decodes to MQTT

### Build

```bash
cd wsprnet_mqtt
go mod download
go build -o wsprnet_mqtt
```

## Configuration

1. Copy the example configuration:
```bash
cp config.yaml.example config.yaml
```

2. Edit `config.yaml` with your settings:

```yaml
receiver:
  callsign: "YOUR_CALL"    # Your callsign for WSPRNet reporting
  locator: "AB12cd"        # Your Maidenhead locator

mqtt:
  broker: "tcp://mqtt.example.com:1883"
  username: "your_username"  # Optional
  password: "your_password"  # Optional
  topic_prefixes:            # List of topic prefixes (one per UberSDR instance)
    - "ubersdr/metrics"      # First instance
    - "ubersdr2/metrics"     # Second instance
    # Add more as needed
  qos: 0

web_port: 9009  # Port for web dashboard (default: 9009)

dry_run: false  # Set to true to test without actually submitting to WSPRNet
```

## Usage

Run the application:

```bash
./wsprnet_mqtt -config config.yaml
```

The application will:
1. Connect to the MQTT broker
2. Subscribe to `{topic_prefix}/digital_modes/WSPR/+` for each configured prefix
3. Aggregate WSPR decodes from multiple UberSDR instances within 2-minute windows
4. Deduplicate spots (same callsign in same 2-minute window), keeping the one with highest SNR
5. Submit deduplicated spots to WSPRNet with your receiver information after a 4-minute delay
6. Provide a web dashboard at `http://localhost:9009` (or your configured port)

Press `Ctrl+C` to stop gracefully.

## Web Dashboard

The application includes a real-time web dashboard accessible at `http://localhost:9009` (or your configured port).

### Features

- **Real-time Statistics**: Total submitted, unique spots, duplicates removed, pending spots
- **Spots Over Time Chart**: Line graph showing submission trends
- **Band Distribution**: Bar chart showing spots per band
- **Live WSPR Spots Map**: Interactive Leaflet.js map showing current spots
  - Color-coded markers by band (one color per band)
  - Multi-colored markers for callsigns heard on multiple bands
  - Popup with callsign, country, locator, bands, and SNR values
  - Automatic Maidenhead locator to lat/lon conversion (supports 4 and 6 character locators)
  - Random offset for multiple stations in same grid square
- **Instance Performance Table**: Compare performance across multiple UberSDR instances
  - Total spots received
  - Unique spots (only seen by that instance)
  - Best SNR wins (times that instance had the best signal)
  - Win rate percentage
  - Last report time
- **Per-Band Instance Performance**: Detailed breakdown by band and instance
  - Shows which instances perform best on which bands
  - Average SNR per instance per band
  - Unique spots per band
- **Country Statistics by Band**: See which countries are being heard on each band
  - Unique callsigns per country
  - Min/Max/Average SNR per country
  - Total spots per country

### Auto-Refresh

The dashboard automatically refreshes every 60 seconds to show the latest statistics.

### Use Cases

- **Monitor Multiple Receivers**: See which of your UberSDR instances is performing best
- **Band Analysis**: Identify which bands each instance receives best
- **Coverage Gaps**: Find callsigns that only one instance can hear
- **Signal Quality**: Compare SNR performance across instances
- **Geographic Visualization**: See where WSPR signals are coming from in real-time
- **Multi-Band Propagation**: Identify stations being heard on multiple bands simultaneously
- **Country Analysis**: Track which countries are active on each band

### Dry Run Mode

To test the application without actually submitting to WSPRNet, enable dry run mode in the config:

```yaml
dry_run: true
```

In dry run mode, the application will:
- Connect to MQTT and receive spots normally
- Log what would be sent to WSPRNet (including full POST data)
- NOT make actual HTTP requests to WSPRNet
- Show statistics as if reports were sent successfully

This is useful for:
- Testing your MQTT configuration
- Verifying spot data format
- Monitoring what would be submitted before going live

## MQTT Topic Structure

The application subscribes to WSPR decodes published by multiple UberSDR instances:

```
{topic_prefix}/digital_modes/WSPR/{band}
```

Examples for multiple instances:

**Instance 1** (`ubersdr/metrics`):
- `ubersdr/metrics/digital_modes/WSPR/160m`
- `ubersdr/metrics/digital_modes/WSPR/80m`
- `ubersdr/metrics/digital_modes/WSPR/40m`

**Instance 2** (`ubersdr2/metrics`):
- `ubersdr2/metrics/digital_modes/WSPR/160m`
- `ubersdr2/metrics/digital_modes/WSPR/80m`
- `ubersdr2/metrics/digital_modes/WSPR/40m`

All spots from all instances are aggregated and submitted with your configured receiver callsign and locator.

## Deduplication Logic

The aggregator implements intelligent deduplication to prevent WSPRNet from rejecting duplicate spots:

1. **2-Minute Windows**: Spots are grouped by their WSPR transmission time (rounded to 2-minute boundaries: 00, 02, 04, etc.)

2. **Deduplication Key**: `callsign + mode + window`
   - Same callsign in the same 2-minute window = duplicate

3. **Best SNR Selection**: When multiple UberSDR instances report the same callsign in the same window:
   - The spot with the **highest SNR** is kept
   - Lower SNR reports are discarded

4. **Synchronized Flushing**: The flusher runs at WSPR cycle boundaries (every 2 minutes at :00, :02, :04, etc.)
   - Ensures predictable submission times aligned with WSPR cycles
   - Submissions happen exactly at even 2-minute marks (e.g., 09:04:00, 09:06:00, 09:08:00)

5. **4-Minute Delay**: Windows are submitted 4 minutes after their transmission time
   - WSPR transmission: 2 minutes
   - Decoding time: up to 2 minutes (varies by system load)
   - MQTT transmission: a few seconds
   - This ensures all instances have time to decode and report before deduplication

**Timeline Example:**
```
09:00:00 - WSPR cycle 1 transmits
09:02:00 - WSPR cycle 2 transmits
09:04:00 - WSPR cycle 3 transmits → Flusher runs, submits cycle 1 (09:00:00)
09:06:00 - WSPR cycle 4 transmits → Flusher runs, submits cycle 2 (09:02:00)
09:08:00 - WSPR cycle 5 transmits → Flusher runs, submits cycle 3 (09:04:00)
```

**Deduplication Example:**
- 09:00:00 - WSPR transmission starts
- 09:00:15 - Instance 1 reports W1ABC with SNR -15 dB (decoded quickly)
- 09:01:45 - Instance 2 reports W1ABC with SNR -12 dB (decoded slowly)
- 09:04:00 - Flusher runs at cycle boundary, submits only -12 dB report (better SNR)

## Expected MQTT Payload Format

The application expects JSON payloads in this format:

```json
{
  "mode": "WSPR",
  "band": "40m",
  "callsign": "W1ABC",
  "locator": "FN42",
  "snr": -15,
  "frequency": 7040100,
  "timestamp": "2025-12-13T09:14:00Z",
  "dt": -0.1,
  "drift": 0,
  "dbm": 23,
  "tx_frequency": 7040086
}
```

## WSPRNet Submission

The application submits spots to WSPRNet using:
- **Receiver callsign**: From your config
- **Receiver locator**: From your config
- **Transmitter info**: From the MQTT payload (callsign, locator, frequency, power)
- **Signal info**: From the MQTT payload (SNR, drift, time offset)

## Statistics

The application logs statistics on shutdown:
- Successful reports submitted
- Failed reports
- Retry attempts

## Troubleshooting

### Connection Issues

If you can't connect to MQTT:
1. Check the broker URL format: `tcp://host:port` or `ssl://host:port`
2. Verify username/password if authentication is required
3. Check firewall rules

### No Spots Being Submitted

1. Verify UberSDR instances are publishing to MQTT
2. Check the topic prefix matches your UberSDR configuration
3. Enable debug logging by checking the console output
4. Verify your receiver callsign and locator are valid

### WSPRNet Submission Failures

1. Check your internet connection
2. Verify WSPRNet is accessible (http://wsprnet.org)
3. Check that callsigns and locators in the spots are valid
4. The application will automatically retry failed submissions

## License

This application uses the same WSPRNet submission logic as the main UberSDR project.