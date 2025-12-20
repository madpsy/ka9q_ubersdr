# CW Spots Extension

Display real-time CW spots from CW Skimmer in the ka9q UberSDR interface.

## Features

- Real-time CW spot display from CW Skimmer
- Filtering by:
  - Age (5 min to unlimited)
  - Band (160m - 10m)
  - Minimum SNR
  - Minimum WPM (CW speed)
  - Minimum distance
  - Callsign search
- CTY database enrichment (country, zones, distance, bearing)
- Click frequency to tune radio
- Click callsign to open QRZ.com
- Auto-updates band filter based on current radio frequency
- Performance optimized for high spot rates

## Installation

1. Ensure CW Skimmer is configured and enabled in `cwskimmer.yaml`

2. Add the extension to your `extensions.yaml`:

```yaml
extensions:
  - cw-spots
  # ... other extensions
```

3. Restart the server or reload the page

4. The extension will appear in the extensions menu with a ⚡ icon

## Configuration

The extension uses these settings from `cwskimmer.yaml`:

- `enabled`: Must be `true` to receive CW spots
- `host`: CW Skimmer server hostname
- `port`: CW Skimmer server port (default: 7300)
- `callsign`: Your callsign for login

## Message Format

CW spots are broadcast via websocket with type `cw_spot`:

```json
{
  "type": "cw_spot",
  "data": {
    "frequency": 14025000,
    "dx_call": "W1AW",
    "snr": 12,
    "wpm": 19,
    "comment": "CQ",
    "time": "2025-11-21T08:25:00Z",
    "band": "20m",
    "country": "United States",
    "cq_zone": 5,
    "itu_zone": 8,
    "continent": "NA",
    "distance_km": 5432.1,
    "bearing_deg": 285.3
  }
}
```

## Usage

1. Enable the extension from the extensions menu
2. CW spots will appear in real-time as they're received
3. Use the filter controls to narrow down spots
4. Click a frequency to tune your radio to that spot
5. Click a callsign to view it on QRZ.com

## Performance

The extension is optimized for high spot rates:

- Spot deduplication (2-minute window per callsign/band/frequency)
- Incremental rendering (500ms throttle)
- Filter result caching
- Display limit (500 spots, expandable)
- Efficient DOM updates

## Troubleshooting

**No spots appearing:**
- Check that CW Skimmer is enabled in `cwskimmer.yaml`
- Verify CW Skimmer server is running and accessible
- Check browser console for connection errors
- Ensure extension is enabled in the UI

**Extension not loading:**
- Verify `cw-spots` is listed in `extensions.yaml`
- Check that all extension files exist in `static/extensions/cw-spots/`
- Restart the server after configuration changes

## Related Extensions

- **Digital Spots** (📶) - FT8/FT4/WSPR spots from multi-decoder
- **DX Cluster** (📡) - Traditional DX cluster spots