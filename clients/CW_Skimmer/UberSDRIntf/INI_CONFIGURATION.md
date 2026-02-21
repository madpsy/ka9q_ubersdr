# UberSDR INI Configuration

## Overview

The UberSDR DLL now supports configuration via an INI file instead of requiring the DLL to be renamed. This makes configuration easier and more flexible.

## Configuration File

The DLL looks for a file named `UberSDRIntf.ini` in the same directory as the DLL.

### File Format

```ini
[Server]
Host=127.0.0.1
Port=8080
debug_rec=0

[Calibration]
FrequencyOffset=0
swap_iq=1
```

### Parameters

#### [Server] Section

- **Host**: IP address or hostname of the ka9q-radio server
  - Default: `127.0.0.1` (localhost)
  - Examples: `192.168.1.100`, `radio.example.com`
  
- **Port**: WebSocket port number
  - Default: `8080`
  - Valid range: 1-65535

- **debug_rec**: Enable 10-second WAV recording on start (for debugging)
  - Default: `0` (disabled)
  - Values: `0` = disabled, `1` = enabled
  - When enabled, creates a 10-second WAV file named `<frequency>.wav` for each receiver

#### [Calibration] Section

- **FrequencyOffset**: Frequency correction in Hz (can be positive or negative)
  - Default: `0` (no correction)
  - Examples: `100` (add 100 Hz), `-50` (subtract 50 Hz)
  - Use this to compensate for systematic frequency offsets in your SDR or server
  - The offset is applied to all frequency requests (both initial connection and tune messages)

- **swap_iq**: Swap I and Q channels for correct sideband orientation
  - Default: `1` (enabled - swaps I and Q)
  - Values: `0` = no swap (I as I, Q as Q), `1` = swap (Q as I, I as Q)
  - Use this if signals appear at wrong frequencies or with inverted sidebands
  - Default behavior (swap_iq=1) matches original driver for backward compatibility
  - Try swap_iq=0 if you experience frequency offset issues

## Behavior

1. **INI file exists**: Configuration is loaded from the INI file
2. **INI file missing**: Uses default values (127.0.0.1:8080)
3. **Invalid configuration**: Falls back to defaults and logs a warning

## Changes from Previous Version

### Removed Features
- **DLL filename parsing**: The DLL no longer reads configuration from its filename (e.g., `UberSDRIntf_192.168.1.100_8080.dll`)
- The DLL can now be named simply `UberSDRIntf.dll`

### New Features
- **INI file support**: Configuration via `UberSDRIntf.ini`
- **Default to localhost**: Changed default from `192.168.9.99:8080` to `127.0.0.1:8080`
- **Better error handling**: Invalid configurations fall back to safe defaults

## Migration Guide

If you were using the filename-based configuration:

**Old method:**
```
UberSDRIntf_192.168.1.100_8080.dll
```

**New method:**
1. Rename DLL to `UberSDRIntf.dll`
2. Create `UberSDRIntf.ini` in the same directory:
```ini
[Server]
Host=192.168.1.100
Port=8080
debug_rec=0

[Calibration]
FrequencyOffset=0
swap_iq=1
```

## Logging

The DLL logs configuration loading to `UberSDRIntf_log_file.txt`:

- INI file path being checked
- Whether INI file was found
- Configuration values loaded
- Any validation errors

Example log entries:
```
2024-01-20 10:30:00.123: Looking for INI file: C:\Path\To\UberSDRIntf.ini
2024-01-20 10:30:00.124: Configuration loaded from INI: 192.168.1.100:8080, debug_rec=false, frequencyOffset=100 Hz
2024-01-20 10:30:00.125: UberSDR initialized with server: 192.168.1.100:8080
```

## Troubleshooting

### DLL uses wrong server
- Check that `UberSDRIntf.ini` is in the same directory as the DLL
- Verify the INI file format is correct (see examples above)
- Check the log file for configuration loading messages

### INI file not found
- The DLL will use defaults (127.0.0.1:8080)
- Check the log file for the exact path being searched
- Ensure the INI file is named exactly `UberSDRIntf.ini` (case-sensitive on some systems)

### Invalid configuration
- The DLL validates hostname and port
- Invalid values cause fallback to defaults
- Check the log file for validation error messages

## Frequency Offset Calibration

If you notice that CW Skimmer or other applications consistently report frequencies that are offset by a fixed amount (e.g., always 100 Hz low), you can use the `FrequencyOffset` parameter to correct this:

### Example: Spots are 100 Hz low

If CW Skimmer reports 18075.9 kHz when the actual signal is at 18076.0 kHz:

```ini
[Calibration]
FrequencyOffset=100
```

This will add 100 Hz to all frequency requests, compensating for the systematic offset.

### Example: Spots are 50 Hz high

If spots are consistently 50 Hz too high:

```ini
[Calibration]
FrequencyOffset=-50
```

This will subtract 50 Hz from all frequency requests.

### Notes
- The offset is applied transparently to both initial WebSocket connections and tune messages
- Changes to the INI file require restarting CW Skimmer to take effect
- The offset value is logged on startup for verification

## I/Q Swap Troubleshooting

If you experience frequency offset issues (signals appearing at wrong frequencies):

### Symptoms
- Signals appear consistently offset by ~100 Hz or more
- The offset varies proportionally with frequency (e.g., 50 Hz at 7 MHz, 100 Hz at 14 MHz)
- IQ data from ka9q_ubersdr is correct, but CW Skimmer sees wrong frequencies

### Solution: Try Disabling I/Q Swap

```ini
[Calibration]
swap_iq=0
```

This tells the driver to NOT swap I and Q channels. If ka9q_ubersdr already provides correctly-oriented IQ data, the swap may be causing frequency errors.

### Testing
1. Set `swap_iq=0` in the INI file
2. Restart CW Skimmer
3. Check if signals now appear at correct frequencies
4. If signals are now inverted (USB appears as LSB), revert to `swap_iq=1`

### Background
The original driver swapped I and Q channels to match HPSDR/Hermes sideband orientation. However, if your ka9q_ubersdr instance already provides correctly-oriented IQ data, this swap may cause frequency offset issues. The `swap_iq` parameter allows you to disable this behavior if needed.