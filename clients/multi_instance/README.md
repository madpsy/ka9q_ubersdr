# Multi-Instance Spectrum Client

A GUI-only client for viewing multiple ka9q_ubersdr spectrum displays simultaneously with synchronized pan/zoom.

## Features

- **Up to 10 simultaneous connections** - Monitor multiple receivers at once
- **Synchronized pan/zoom** - All instances show the same frequency range (can be toggled)
- **Spectrum display only** - No audio processing, lightweight and efficient
- **Easy instance management** - Add, edit, enable/disable, and remove instances
- **Public instance support** - Quick access to public UberSDR receivers
- **Persistent configuration** - Saves your instances between sessions
- **Individual control** - Connect/disconnect each instance independently

## Requirements

- Python 3.7+
- tkinter (usually included with Python)
- numpy
- matplotlib
- websockets
- All dependencies from `clients/python/requirements.txt`

## Installation

1. Install dependencies:
```bash
cd clients/python
pip install -r requirements.txt
```

2. Run the multi-instance client:
```bash
cd clients/multi_instance
python multi_spectrum_gui.py
```

Or from the repository root:
```bash
python -m clients.multi_instance.multi_spectrum_gui
```

## Usage

### Synchronization

The client includes a **"Synchronize Pan/Zoom"** checkbox in the control panel. When enabled (default):

- **Zoom operations** (mouse wheel, zoom in/out) on any spectrum display are synchronized to all other connected instances
- **Pan operations** (click-and-drag) on any spectrum display are synchronized to all other connected instances
- All instances will show the exact same frequency range and zoom level

This allows you to compare signals across multiple receivers at the same frequency and bandwidth simultaneously.

To disable synchronization and allow independent control of each instance, uncheck the "Synchronize Pan/Zoom" checkbox.

### Adding Instances

**Manual Entry:**
1. Click "Add Instance"
2. Enter name, host, port, and frequency
3. Check "Use TLS" if the server requires HTTPS
4. Click OK

**From Public List:**
1. Click "Add from Public"
2. Select a public instance from the list
3. Instance is automatically added

### Managing Instances

- **Enable/Disable**: Check/uncheck the checkbox next to each instance
- **Connect**: Click "Connect" button for individual instances
- **Connect All**: Click "Connect All Enabled" to connect all enabled instances at once
- **Edit**: Click "Edit" to modify instance settings
- **Remove**: Click "Remove" to delete an instance

### Viewing Spectrums

- Each connected instance displays its spectrum in the bottom panel
- Spectrums are stacked vertically
- Scroll to view all connected instances
- Each spectrum shows the receiver name in its frame

## File Structure

```
clients/multi_instance/
├── __init__.py                 # Package initialization
├── multi_spectrum_gui.py       # Main GUI application (382 lines)
├── spectrum_instance.py        # Instance data model (52 lines)
├── instance_manager.py         # Connection management (123 lines)
├── config_manager.py           # Configuration persistence (70 lines)
├── instance_dialogs.py         # Add/Edit dialogs (153 lines)
└── README.md                   # This file
```

Total: ~780 lines of code (vs 5400+ in full client)

## Configuration

Configuration is automatically saved to:
- **Linux/Mac**: `~/.ubersdr_multi_spectrum.json`
- **Windows**: `%APPDATA%\ubersdr\multi_spectrum_config.json`

The configuration includes:
- Instance names, hosts, ports
- TLS settings
- Frequencies
- Enabled/disabled state

## Connection Process

Before connecting to each instance, the client performs a `/connection` check (same as the full Python client):

1. **POST request** to `/connection` endpoint with `user_session_id` and optional `password`
2. **Server validates** connection permission based on IP, session limits, etc.
3. **Response includes**:
   - `allowed`: Whether connection is permitted
   - `reason`: Rejection reason if not allowed
   - `bypassed`: Whether connection has elevated privileges
   - `allowed_iq_modes`: List of permitted IQ modes
   - `max_session_time`: Maximum session duration (0 = unlimited)
4. **Connection proceeds** only if allowed, otherwise shows error dialog

This ensures the client respects server connection limits and provides clear error messages.

## Differences from Full Client

This client is **GUI-only** and does **not** include:
- Audio streaming or playback
- Waterfall displays
- Audio spectrum analysis
- Recording capabilities
- Radio control (rigctl/OmniRig)
- MIDI controller support
- Noise reduction or audio filters
- Spots displays (digital/CW)
- Band conditions monitoring

## Architecture

The client is split into focused modules:

1. **spectrum_instance.py** - Data model for each instance
2. **instance_manager.py** - Handles connections and lifecycle
3. **config_manager.py** - Saves/loads configuration
4. **instance_dialogs.py** - UI dialogs for add/edit
5. **multi_spectrum_gui.py** - Main application and UI

This modular design keeps each file small and maintainable.

## Troubleshooting

**"Spectrum display not available"**
- Make sure `spectrum_display.py` exists in `clients/python/`
- Install required dependencies: `pip install -r clients/python/requirements.txt`

**Connection fails**
- Verify host and port are correct
- Check if TLS is required (use HTTPS for public instances)
- Ensure the server is running and accessible

**Public instances not available**
- The public instances feature requires `public_instances_display.py`
- You can still add instances manually

## License

Same as ka9q_ubersdr project.