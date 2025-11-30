# UberSDR Instance Directory Webpage

The collector now includes a web interface that displays all registered UberSDR instances with their real-time band conditions.

## Features

### Instance Display
- **Grid Layout**: Responsive card-based layout showing all active instances
- **Instance Information**:
  - Callsign and name
  - Location and coordinates
  - Altitude
  - Software version
  - Online/offline status
  - Enabled features (CW Skimmer, Digital Decodes, Noise Floor)
  - Last seen timestamp
  - Direct link to connect to the SDR

### Band Conditions Display
For instances with noise floor monitoring enabled, the webpage displays real-time band conditions using color-coded badges:

- **POOR** (Red): SNR < 6 dB
- **FAIR** (Orange): SNR 6-20 dB
- **GOOD** (Yellow): SNR 20-30 dB
- **EXCELLENT** (Green): SNR > 30 dB

Bands displayed: 160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m

### Auto-Refresh
The page automatically refreshes every 60 seconds to show the latest data.

## Accessing the Webpage

Once the collector is running, access the webpage at:
```
http://your-collector-host:8443/
```

For example, if running locally:
```
http://localhost:8443/
```

## API Endpoints Used

The webpage uses the following API endpoints:

1. **GET /api/instances** - Fetches list of all active instances
2. **GET /api/noisefloor/{public_uuid}** - Fetches noise floor data for each instance

## Files

- `static/index.html` - Main HTML page with styling
- `static/instances.js` - JavaScript for fetching and displaying data

## Styling

The webpage uses a modern, responsive design with:
- Gradient blue background matching the main UberSDR interface
- Glass-morphism effects on cards
- Hover animations
- Mobile-responsive grid layout
- Color-coded status badges and band condition indicators

## Development

To modify the webpage:

1. Edit `static/index.html` for layout and styling changes
2. Edit `static/instances.js` for functionality changes
3. Restart the collector to see changes (or use a development server with live reload)

## Notes

- Instances are considered "online" if they've reported within the last 5 minutes
- Noise floor data is fetched asynchronously for better performance
- The page gracefully handles missing or unavailable noise floor data
- All timestamps are displayed in relative format (e.g., "5 min ago")