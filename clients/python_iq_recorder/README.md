# IQ Stream Recorder

A multi-stream IQ recording application for ka9q_ubersdr with a graphical user interface.

> **Note**: This application depends on [`radio_client.py`](../python/radio_client.py) from the parent `python/` directory. For standalone executable distribution, see [BUILD_EXECUTABLE.md](BUILD_EXECUTABLE.md).

## Overview

The IQ Stream Recorder allows you to record multiple IQ streams simultaneously from a ka9q_ubersdr instance to WAV files. This is useful for:

- Recording multiple bands simultaneously
- Creating IQ recordings for later analysis
- Feeding IQ data to external applications (CW Skimmer, etc.)
- Band monitoring and archiving

## Features

- **Multi-stream recording**: Record up to 8 simultaneous IQ streams
- **Multiple IQ modes**: Support for IQ48, IQ96, and IQ192
- **Independent control**: Each stream has its own frequency and mode settings
- **Flexible file naming**: Auto-generated or custom filenames with templates
- **Real-time monitoring**: Live status updates, duration, and file size
- **Configuration management**: Save and load stream configurations
- **Automated scheduling**: Schedule recordings at specific times and days (see [SCHEDULER.md](SCHEDULER.md))
- **Disk space monitoring**: Track available disk space
- **Cross-platform**: Works on Windows, Linux, and macOS

## Supported IQ Modes

| Mode | Sample Rate | Bandwidth | Typical Use |
|------|-------------|-----------|-------------|
| IQ48 | 48 kHz | ±24 kHz | Single band monitoring |
| IQ96 | 96 kHz | ±48 kHz | Wide band coverage |
| IQ192 | 192 kHz | ±96 kHz | Full band recording |

## Installation

### Prerequisites

1. Python 3.7 or later
2. ka9q_ubersdr server running and accessible
3. Required Python packages (see requirements.txt)

### Setup

```bash
# Navigate to the application directory
cd clients/python_iq_recorder

# Install dependencies
pip install -r requirements.txt

# Run the application
python iq_recorder.py
```

See [INSTALL.md](INSTALL.md) for detailed installation instructions.

### Building Standalone Executable

To create a standalone executable that doesn't require Python:

```bash
pip install pyinstaller
pyinstaller iq_recorder.spec
```

The executable will be in `dist/iq_recorder/`. See [BUILD_EXECUTABLE.md](BUILD_EXECUTABLE.md) for detailed instructions.

## Usage

### Starting the Application

```bash
python iq_recorder.py
```

### Basic Workflow

1. **Configure Server Connection**
   - Enter the ka9q_ubersdr server hostname/IP
   - Enter the server port (default: 8073)
   - Set the recording directory

2. **Add IQ Streams**
   - Click "Add Stream"
   - Enter frequency in MHz (e.g., 14.074)
   - Select IQ mode (IQ48, IQ96, or IQ192)
   - Choose output file or use auto-generated name
   - Click "Add Stream"

3. **Start Recording**
   - Select a stream and click "Start" (or double-click)
   - Or click "Start All" to start all configured streams
   - Monitor status, duration, and file size in real-time

4. **Stop Recording**
   - Select a stream and right-click → "Stop"
   - Or click "Stop All" to stop all recordings

### Quick Frequency Selection

The "Add Stream" dialog includes quick-select buttons for common FT8 frequencies:

- **160m**: 1.840 MHz
- **80m**: 3.573 MHz
- **40m**: 7.074 MHz
- **30m**: 10.136 MHz
- **20m**: 14.074 MHz
- **17m**: 18.100 MHz
- **15m**: 21.074 MHz
- **12m**: 24.915 MHz
- **10m**: 28.074 MHz

### Filename Templates

The application supports several filename templates:

- **default**: `YYYYMMDD_HHMMSS_14.074MHz_iq96.wav`
- **timestamp**: `YYYYMMDD_HHMMSS_14074000_iq96.wav`
- **frequency**: `14.074MHz_iq96_YYYYMMDD.wav`
- **simple**: `14.074MHz_iq96.wav`
- **detailed**: `stream1_14.074MHz_iq96_YYYYMMDD_HHMMSS.wav`

You can also specify a custom template using these variables:
- `{timestamp}`: Full timestamp (YYYYMMDD_HHMMSS)
- `{date}`: Date only (YYYYMMDD)
- `{time}`: Time only (HHMMSS)
- `{freq}`: Frequency in Hz
- `{freq_mhz}`: Frequency in MHz
- `{mode}`: IQ mode (iq48/iq96/iq192)
- `{stream_id}`: Stream ID number

### Configuration Management

**Save Configuration:**
1. File → Save Configuration...
2. Choose a location and filename
3. Configuration is saved as JSON

**Load Configuration:**
1. File → Load Configuration...
2. Select a previously saved configuration file
3. All streams and settings are restored

### Context Menu

Right-click on a stream in the list to access:
- **Start**: Start recording the stream
- **Stop**: Stop recording the stream
- **Remove**: Remove the stream from the list

## WAV File Format

Recorded files are standard WAV files with the following format:

- **Format**: WAV (RIFF)
- **Channels**: 2 (I and Q)
- **Sample Format**: 32-bit float or 16-bit signed integer
- **Sample Rate**: 48000, 96000, or 192000 Hz (depending on IQ mode)
- **Layout**: Interleaved I/Q samples

These files can be opened with:
- Audio editing software (Audacity, etc.)
- SDR applications (SDR#, HDSDR, etc.)
- Custom analysis tools
- CW Skimmer (via appropriate drivers)

## Data Rates and Storage

Approximate data rates and storage requirements:

| Mode | Data Rate | 1 Hour | 24 Hours |
|------|-----------|--------|----------|
| IQ48 | ~384 KB/s | ~1.3 GB | ~32 GB |
| IQ96 | ~768 KB/s | ~2.6 GB | ~64 GB |
| IQ192 | ~1.5 MB/s | ~5.3 GB | ~128 GB |

**Note**: Actual file sizes may vary slightly due to WAV header overhead.

## Comparison with Other Tools

| Feature | CW Skimmer Monitor | Python Radio Client | IQ Recorder |
|---------|-------------------|---------------------|-------------|
| Multiple streams | ✓ (8 max) | ✗ (single) | ✓ (8 max) |
| GUI | ✓ (Windows) | ✓ (cross-platform) | ✓ (cross-platform) |
| Recording | ✓ (debug only) | ✓ (single stream) | ✓ (multi-stream) |
| IQ modes | ✓ (48/96/192) | ✓ (48/96/192/384) | ✓ (48/96/192) |
| Frequency control | ✓ | ✓ | ✓ |
| Platform | Windows only | Cross-platform | Cross-platform |
| Config save/load | ✗ | ✗ | ✓ |

## Troubleshooting

### "RadioClient not available" Error

**Problem**: The application can't find the radio_client module.

**Solution**: Ensure `radio_client.py` is in the `../python` directory relative to the application.

### Connection Errors

**Problem**: Can't connect to ka9q_ubersdr server.

**Solutions**:
- Verify the server is running
- Check hostname/IP and port are correct
- Ensure firewall allows connections
- Test with the standalone radio_client first

### Recording Stops Immediately

**Problem**: Recording starts but stops right away.

**Solutions**:
- Check server has available channels
- Verify the frequency is valid
- Check server logs for errors
- Ensure IQ mode is supported by the server

### File Permission Errors

**Problem**: Can't write to recording directory.

**Solutions**:
- Check directory exists and is writable
- Choose a different recording directory
- Run with appropriate permissions

### High CPU Usage

**Problem**: Application uses too much CPU.

**Solutions**:
- Reduce number of simultaneous streams
- Use lower sample rate (IQ48 instead of IQ192)
- Close other applications
- Check for network issues causing retransmissions

## Advanced Usage

### Command-Line Integration

While the application is primarily GUI-based, you can create configurations programmatically:

```python
import json

config = {
    'host': 'localhost',
    'port': 8073,
    'recording_dir': './recordings',
    'streams': [
        {
            'stream_id': 1,
            'frequency': 14074000,
            'iq_mode': 'iq96',
            'output_file': './recordings/20m_ft8.wav'
        },
        {
            'stream_id': 2,
            'frequency': 7074000,
            'iq_mode': 'iq96',
            'output_file': './recordings/40m_ft8.wav'
        }
    ]
}

with open('my_config.json', 'w') as f:
    json.dump(config, f, indent=2)
```

Then load this configuration in the GUI: File → Load Configuration...

### Automated Recording

For automated/scheduled recording, you can:

1. Create a configuration file with your desired streams
2. Load it in the GUI
3. Click "Start All"
4. Use system scheduling (cron, Task Scheduler) to start the application

## Architecture

The application consists of several modules:

- **iq_recorder.py**: Main entry point
- **iq_recorder_gui.py**: GUI implementation using tkinter
- **iq_stream_config.py**: Stream configuration and status management
- **iq_file_manager.py**: File naming and disk space management

The application uses the existing `radio_client.py` from the ka9q_ubersdr Python client for WebSocket connectivity and WAV recording.

## License

Same as ka9q_ubersdr

## Support

For issues, questions, or contributions, please refer to the main ka9q_ubersdr repository.

## Version History

### v1.0 (2026-03-06)
- Initial release
- Support for IQ48, IQ96, IQ192 modes
- Up to 8 simultaneous streams
- Configuration save/load
- Real-time monitoring
- Cross-platform GUI
