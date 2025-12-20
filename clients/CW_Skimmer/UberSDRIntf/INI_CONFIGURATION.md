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
```

### Parameters

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
2024-01-20 10:30:00.124: Configuration loaded from INI: 192.168.1.100:8080
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