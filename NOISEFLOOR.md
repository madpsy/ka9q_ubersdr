# HF Noise Floor Monitoring

This feature provides automated noise floor monitoring across amateur radio HF bands (160m through 10m), with data logging and visualization.

## Overview

The noise floor monitor:
- Captures a single 0-30 MHz spectrum from radiod
- Extracts data for each amateur radio band
- Calculates statistical noise floor metrics using the 5th percentile method
- Logs measurements to daily CSV files
- Provides a web interface for real-time and historical visualization

## Features

### Noise Floor Calculation

The system uses the **5th percentile method** to calculate noise floor, which is robust against signals:

- **P5 (Noise Floor)**: 5th percentile - represents the true noise floor between signals
- **P10**: 10th percentile - additional noise reference
- **P50 (Median)**: 50th percentile - typical signal level
- **P95 (Signal Peak)**: 95th percentile - peak signal activity
- **Dynamic Range**: P95 - P5 (indicates propagation conditions)
- **Band Occupancy**: Percentage of spectrum above noise floor + 10dB

### Why 5th Percentile Works

Even on busy bands:
- Amateur bands are mostly empty (>95% of spectrum has no signals)
- Signals are narrow (SSB ~3kHz, CW ~200Hz) vs band width (300+ kHz)
- Statistical separation: noise is Gaussian, signals are sparse outliers
- Immune to strong signals that would skew mean/median

## Configuration

Add this section to your `config.yaml`:

```yaml
noisefloor:
  enabled: true                    # Enable/disable monitoring
  poll_interval_sec: 60            # Measurement interval (seconds)
  data_dir: "noisefloor"           # CSV storage directory (relative to config dir)
  center_frequency: 15000000       # 15 MHz (for 0-30 MHz coverage)
  bin_count: 30000                 # 30,000 bins
  bin_bandwidth: 1000.0            # 1 kHz per bin
  
  # Bands to monitor (defaults provided if omitted)
  bands:
    - name: "160m"
      start: 1800000
      end: 2000000
    - name: "80m"
      start: 3500000
      end: 4000000
    # ... (add more bands as needed)
```

**Note**: If `data_dir` is not specified or is a relative path, it will be created relative to your config directory (e.g., if your config is in `/etc/ka9q_ubersdr/`, data will be stored in `/etc/ka9q_ubersdr/noisefloor/`).

## Data Storage

### CSV Format

Data is stored in daily CSV files in the config directory: `<config_dir>/noisefloor/noise_floor_YYYY-MM-DD.csv`

Columns:
- `timestamp`: ISO 8601 timestamp
- `band`: Band name (e.g., "40m")
- `min_db`: Minimum power in band
- `max_db`: Maximum power in band
- `mean_db`: Mean power
- `median_db`: Median power (P50)
- `p5_db`: 5th percentile (noise floor estimate)
- `p10_db`: 10th percentile
- `p95_db`: 95th percentile (signal peak)
- `dynamic_range`: P95 - P5 (dB)
- `occupancy_pct`: % of bins above noise + 10dB

### Storage Requirements

- ~50-60 KB per day
- ~20 MB per year
- Files can be compressed with gzip (~5 KB/day)

## Web Interface

Access the noise floor monitor at: `http://your-server:8080/noisefloor.html`

### Features

1. **Live Dashboard**
   - Real-time noise floor for all bands
   - Auto-refreshes every 60 seconds
   - Color-coded metrics

2. **Historical Data**
   - Select any date with available data
   - Filter by specific band or view all
   - 24-hour trend charts

3. **Visualizations**
   - Noise floor trends over time
   - 24-hour heatmap showing daily patterns
   - Band comparison charts

## API Endpoints

### Get Latest Measurements

```
GET /api/noisefloor/latest
```

Returns current noise floor for all bands.

Response:
```json
{
  "40m": {
    "timestamp": "2025-11-03T12:00:00Z",
    "band": "40m",
    "min_db": -95.2,
    "max_db": -65.4,
    "mean_db": -82.3,
    "median_db": -83.1,
    "p5_db": -90.2,
    "p10_db": -88.1,
    "p95_db": -65.4,
    "dynamic_range": 24.8,
    "occupancy_pct": 15.2
  },
  ...
}
```

### Get Historical Data

```
GET /api/noisefloor/history?date=YYYY-MM-DD&band=40m
```

Parameters:
- `date` (required): Date in YYYY-MM-DD format
- `band` (optional): Band name (e.g., "40m"), omit for all bands

Returns array of measurements for the specified date.

### Get Available Dates

```
GET /api/noisefloor/dates
```

Returns list of dates with available data:
```json
{
  "dates": ["2025-11-03", "2025-11-02", "2025-11-01"]
}
```

## Technical Details

### Spectrum Parameters

- **Center Frequency**: 15 MHz
- **Total Bandwidth**: 30 MHz (0-30 MHz coverage)
- **Bin Count**: 30,000 bins
- **Bin Bandwidth**: 1 kHz
- **Resolution**: 1 kHz per bin provides good balance of resolution and data size

### Performance

- **Memory**: ~120 KB per spectrum sample
- **Network**: ~2 KB/s at 60-second intervals
- **CPU**: Minimal (FFT done by radiod)
- **Disk I/O**: One write per measurement per band

### Integration with radiod

The monitor:
1. Creates a dedicated spectrum session with radiod
2. Polls for spectrum data at configured interval
3. Receives STATUS packets via UDP multicast
4. Extracts power values and converts to dB
5. Processes each band independently

## Use Cases

### Propagation Monitoring

- Track daily/seasonal noise floor variations
- Identify best times for each band
- Correlate with solar activity

### RFI Detection

- Detect new interference sources
- Track intermittent RFI patterns
- Compare noise floor across bands

### Station Performance

- Verify antenna performance
- Compare receive capabilities
- Identify local noise sources

### Research

- Long-term HF noise studies
- Propagation prediction validation
- Atmospheric noise research

## Troubleshooting

### No Data Appearing

1. Check configuration:
   ```yaml
   noisefloor:
     enabled: true
   ```

2. Check logs for errors:
   ```
   grep -i "noise floor" /path/to/logfile
   ```

3. Verify radiod is running and accessible

4. Check data directory permissions:
   ```bash
   ls -la noise_floor_data/
   ```

### High Noise Floor Values

- Check for local RFI sources
- Verify antenna connections
- Compare with other stations
- Check for overload (P95 values)

### Missing Bands

- Verify band definitions in config
- Check frequency ranges match your license
- Ensure spectrum covers band frequencies

## Example Analysis

### Python Script to Analyze CSV Data

```python
import pandas as pd
import matplotlib.pyplot as plt

# Load data
df = pd.read_csv('noise_floor_data/noise_floor_2025-11-03.csv')
df['timestamp'] = pd.to_datetime(df['timestamp'])

# Plot 40m band noise floor over 24 hours
band_40m = df[df['band'] == '40m']
plt.figure(figsize=(12, 6))
plt.plot(band_40m['timestamp'], band_40m['p5_db'], label='Noise Floor (P5)')
plt.plot(band_40m['timestamp'], band_40m['p95_db'], label='Signal Peak (P95)')
plt.xlabel('Time (UTC)')
plt.ylabel('Power (dB)')
plt.title('40m Band - 24 Hour Noise Floor')
plt.legend()
plt.grid(True)
plt.show()
```

## Future Enhancements

Potential additions:
- Email alerts for unusual noise floor changes
- Integration with solar data (SFI, A-index, K-index)
- Machine learning for RFI detection
- Comparison with other monitoring stations
- Export to WSPR or PSKReporter format

## References

- [ITU-R P.372: Radio Noise](https://www.itu.int/rec/R-REC-P.372/)
- [ARRL Technical Information Service](http://www.arrl.org/tis)
- [Noise Floor Measurement Techniques](https://www.itu.int/dms_pubrec/itu-r/rec/sm/R-REC-SM.1753-0-200601-I!!PDF-E.pdf)

## Support

For issues or questions:
- GitHub Issues: https://github.com/madpsy/ka9q_ubersdr/issues
- Documentation: https://github.com/madpsy/ka9q_ubersdr

## License

This feature is part of ka9q_ubersdr and follows the same license terms.