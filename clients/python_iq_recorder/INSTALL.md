# Installation Guide - IQ Stream Recorder

## For End Users (Standalone Executable)

If you received a pre-built executable, you don't need Python or any dependencies:

1. **Extract the archive** (Linux/Windows) or **mount the DMG** (macOS)
2. **Run the executable**:
   - Linux: `./iq_recorder`
   - Windows: Double-click `iq_recorder.exe`
   - macOS: Open `IQ Recorder.app`

See [BUILD_EXECUTABLE.md](BUILD_EXECUTABLE.md) for building your own executable.

---

## For Developers (Python Installation)

### Quick Start

#### Prerequisites

1. **Python 3.7 or later**
   ```bash
   python3 --version
   ```

2. **ka9q_ubersdr server** running and accessible

3. **tkinter** (usually included with Python)
   - **Linux**: May need to install separately
     ```bash
     # Ubuntu/Debian
     sudo apt-get install python3-tk
     
     # Fedora/RHEL
     sudo dnf install python3-tkinter
     
     # Arch
     sudo pacman -S tk
     ```

### Installation Steps

1. **Navigate to the application directory**
   ```bash
   cd clients/python_iq_recorder
   ```

2. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```
   
   Or if you prefer using pip3:
   ```bash
   pip3 install -r requirements.txt
   ```

3. **Verify installation**
   ```bash
   python3 iq_recorder.py
   ```
   
   The GUI should launch. If you see errors, check the troubleshooting section below.

## Virtual Environment (Recommended)

Using a virtual environment keeps dependencies isolated:

```bash
# Create virtual environment
python3 -m venv venv

# Activate it
# On Linux/macOS:
source venv/bin/activate
# On Windows:
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the application
python iq_recorder.py
```

## Minimal Installation

If you only want the core functionality without optional features:

```bash
pip install aiohttp websockets requests numpy
```

This provides:
- ✓ Multi-stream IQ recording
- ✓ WAV file output
- ✓ GUI interface
- ✗ Opus codec support (not needed for IQ)
- ✗ Audio output (not needed for recording)

## System-Specific Notes

### Linux

**Ubuntu/Debian:**
```bash
sudo apt-get install python3 python3-pip python3-tk
pip3 install -r requirements.txt
```

**Fedora/RHEL:**
```bash
sudo dnf install python3 python3-pip python3-tkinter
pip3 install -r requirements.txt
```

**Arch Linux:**
```bash
sudo pacman -S python python-pip tk
pip install -r requirements.txt
```

### macOS

Python 3 usually includes tkinter. If not:
```bash
brew install python-tk
pip3 install -r requirements.txt
```

### Windows

1. Download Python from [python.org](https://www.python.org/downloads/)
2. During installation, check "Add Python to PATH"
3. Open Command Prompt or PowerShell:
   ```cmd
   cd clients\python_iq_recorder
   pip install -r requirements.txt
   python iq_recorder.py
   ```

## Verifying the Installation

### Test 1: Import Check
```bash
python3 -c "import tkinter; import aiohttp; import websockets; import numpy; print('All imports successful')"
```

### Test 2: Module Check
```bash
python3 -c "from iq_stream_config import IQMode; print('IQ Recorder modules OK')"
```

### Test 3: Launch GUI
```bash
python3 iq_recorder.py
```

## Troubleshooting

### "No module named 'tkinter'"

**Problem**: tkinter not installed

**Solution**:
```bash
# Linux
sudo apt-get install python3-tk  # Ubuntu/Debian
sudo dnf install python3-tkinter  # Fedora/RHEL

# macOS
brew install python-tk

# Windows: Reinstall Python with tkinter option checked
```

### "No module named 'radio_client'"

**Problem**: Can't find the radio_client module

**Solution**: Ensure `radio_client.py` exists in `../python/` directory:
```bash
ls ../python/radio_client.py
```

If missing, you need the full ka9q_ubersdr Python client.

### "ModuleNotFoundError: No module named 'aiohttp'"

**Problem**: Dependencies not installed

**Solution**:
```bash
pip install -r requirements.txt
```

### Permission Errors on Linux

**Problem**: Can't install packages globally

**Solution**: Use virtual environment or install with `--user`:
```bash
pip install --user -r requirements.txt
```

### "Can't connect to server"

**Problem**: ka9q_ubersdr server not accessible

**Solution**:
1. Verify server is running
2. Check hostname/IP and port
3. Test with curl:
   ```bash
   curl http://localhost:8073/api/description
   ```

## Updating

To update to a newer version:

```bash
cd clients/python_iq_recorder
git pull  # If using git
pip install -r requirements.txt --upgrade
```

## Uninstalling

To remove the application:

```bash
# If using virtual environment
deactivate
rm -rf venv

# Remove application files
cd ..
rm -rf python_iq_recorder
```

## Development Installation

For development or contributing:

```bash
# Clone repository
git clone <repository-url>
cd ka9q_ubersdr/clients/python_iq_recorder

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install in development mode
pip install -e .
pip install -r requirements.txt

# Run tests (if available)
python -m pytest
```

## Next Steps

After installation:

1. Read the [README.md](README.md) for usage instructions
2. Try the example configuration: File → Load Configuration → `example_config.json`
3. Configure your server connection
4. Add your first IQ stream
5. Start recording!

## Getting Help

If you encounter issues:

1. Check the [README.md](README.md) troubleshooting section
2. Verify all prerequisites are met
3. Check the ka9q_ubersdr server logs
4. Ensure you have the latest version

## Minimum System Requirements

- **CPU**: Any modern processor (multi-core recommended for multiple streams)
- **RAM**: 512 MB minimum, 2 GB recommended
- **Disk**: Varies by recording duration (see README.md for estimates)
- **Network**: Stable connection to ka9q_ubersdr server
- **OS**: Linux, macOS, or Windows with Python 3.7+
