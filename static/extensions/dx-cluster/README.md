# DX Cluster Extension

Real-time display of DX spots from amateur radio DX clusters.

## Features

- **Live Spot Display**: Shows DX spots in real-time as they arrive from the cluster
- **Click-to-Tune**: Click any frequency to tune your radio to that spot
- **Auto-Tune Mode**: Automatically tune to spots when clicked
- **Band Filtering**: Filter spots by amateur radio band (160m-10m)
- **Clean Interface**: Color-coded table with sortable columns
- **Connection Status**: Visual indicator of cluster connection status
- **Auto-Reconnect**: Automatically reconnects if connection is lost

## Usage

1. **Enable the Extension**: Click the DX Cluster button in the extensions panel
2. **View Spots**: Spots appear in the table as they arrive from the cluster
3. **Tune to a Spot**: Click on any frequency to tune your radio
4. **Enable Auto-Tune**: Check the "Auto-tune" box to automatically tune when clicking spots
5. **Filter by Band**: Use the band dropdown to show only spots on specific bands
6. **Clear Display**: Click "Clear" to remove all spots from the display

## Configuration

The DX cluster connection is configured in `config.yaml`:

```yaml
dxcluster:
  enabled: true
  server: "dxspider.co.uk:7300"
  callsign: "N0CALL"
  reconnect_delay: 30
```

## Display Features

- **Time**: UTC time when the spot was posted
- **Frequency**: Click to tune (color: green)
- **DX Call**: The station being spotted (color: blue)
- **Spotter**: Who posted the spot (color: purple)
- **Comment**: Additional information about the spot

## Keyboard Shortcuts

- None currently implemented

## Technical Details

- Connects via WebSocket to `/ws/dxcluster`
- Receives spots in JSON format
- Maintains up to 100 spots in memory (configurable)
- Auto-reconnects every 5 seconds if disconnected
- Uses session UUID for authentication

## Troubleshooting

**No spots appearing:**
- Check that DX cluster is enabled in config.yaml
- Verify the cluster server is reachable
- Check browser console for connection errors

**Connection keeps dropping:**
- Check your internet connection
- Verify the cluster server is online
- Check server logs for authentication issues

**Spots not filtering correctly:**
- Ensure the band filter is set correctly
- Check that spot frequencies are within amateur bands

## Development

The extension consists of:
- `manifest.json`: Extension metadata and settings
- `main.js`: WebSocket connection and spot handling
- `template.html`: UI layout
- `styles.css`: Visual styling

## Future Enhancements

- [ ] Spot history with search
- [ ] Export spots to CSV
- [ ] Audio alerts for specific callsigns
- [ ] Spot statistics and analysis
- [ ] Multiple cluster connections
- [ ] Spot filtering by mode/band/callsign
- [ ] Integration with logging software