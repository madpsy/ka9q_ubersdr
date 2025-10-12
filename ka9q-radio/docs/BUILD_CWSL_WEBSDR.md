# Building ka9q-radio with CWSL WebSDR Support

## Quick Start

The CWSL WebSDR driver is now integrated into the ka9q-radio build system. Simply build as normal:

```bash
cd ka9q-radio/src
make
```

This will automatically build `cwsl_websdr.so` along with all other drivers.

## Installation

After building, install with:

```bash
cd ka9q-radio/src
sudo make install
```

This will:
1. Copy `cwsl_websdr.so` to `/usr/local/lib/ka9q-radio/`
2. Create a symlink in `/usr/local/lib/`
3. Install all executables and other drivers

## Verify Installation

Check that the driver was built and installed:

```bash
# Check if the .so file exists
ls -l /usr/local/lib/ka9q-radio/cwsl_websdr.so

# Or check in the build directory
ls -l ka9q-radio/src/cwsl_websdr.so
```

## Build Options

### Debug Build

To build with debugging symbols:

```bash
make BUILD=debug
```

### Clean Build

To rebuild from scratch:

```bash
make clean
make
```

### Build Only the CWSL WebSDR Driver

If you only want to rebuild the CWSL WebSDR driver:

```bash
make cwsl_websdr.so
```

## Dependencies

The CWSL WebSDR driver requires only standard libraries that are already required by ka9q-radio:

- **Standard C library** (glibc)
- **POSIX threads** (pthread)
- **BSD string functions** (libbsd)
- **iniparser** (for configuration)

No additional dependencies are needed beyond what ka9q-radio already requires.

## Troubleshooting Build Issues

### Compiler Errors

If you get compiler errors, make sure you have the development packages installed:

```bash
# On Debian/Ubuntu
sudo apt-get install build-essential libbsd-dev libiniparser-dev

# On Fedora/RHEL
sudo dnf install gcc make libbsd-devel iniparser-devel
```

### Missing Dependencies

If you get linking errors, ensure all ka9q-radio dependencies are installed. See the main ka9q-radio documentation for the complete list.

### Permission Errors During Install

If `make install` fails with permission errors:

```bash
sudo make install
```

## Configuration

After building and installing, configure radiod to use CWSL WebSDR:

1. **Copy example configuration**:
   ```bash
   sudo cp ka9q-radio/share/radiod@cwsl-hf.conf /etc/radio/
   ```

2. **Edit configuration**:
   ```bash
   sudo vi /etc/radio/radiod@cwsl-hf.conf
   ```
   
   Update these settings:
   - `host` - CWSL WebSDR server hostname/IP
   - `port` - TCP control port (default: 50001)
   - `udp_port` - Local UDP port for IQ data (default: 50100)
   - `receiver` - Receiver ID (default: 0)

3. **Start radiod**:
   ```bash
   radiod /etc/radio/radiod@cwsl-hf.conf
   ```

## Testing

### Test the Build

```bash
# Check if the driver loads
ldd ka9q-radio/src/cwsl_websdr.so

# Should show standard libraries only, no missing dependencies
```

### Test with radiod

```bash
# Run with verbose output to see connection details
radiod -v /etc/radio/radiod@cwsl-hf.conf
```

You should see output like:
```
Loading config file /etc/radio/radiod@cwsl-hf.conf
Dynamically loading cwsl_websdr hardware driver from /usr/local/lib/ka9q-radio/cwsl_websdr.so
cwsl-websdr connected to localhost:50001, receiver 0, samprate 192,000 Hz, UDP port 50100
cwsl_websdr threads running
```

## Next Steps

See the full documentation:
- [CWSL WebSDR Integration Guide](CWSL_INTEGRATION.md)
- [CWSL WebSDR User Documentation](cwsl_websdr.md)
- [Example Configuration](../share/radiod@cwsl-hf.conf)

## Build System Details

The CWSL WebSDR driver is integrated into the Makefile as a dynamic driver (`.so` file), similar to other SDR frontends like `rtlsdr.so`, `airspy.so`, etc.

**Makefile changes**:
- Added `cwsl_websdr.so` to `DYNAMIC_DRIVERS`
- Added `cwsl_websdr.c` to `CFILES`
- Added build rule for `cwsl_websdr.so`

The driver is built as a position-independent shared library that radiod loads dynamically at runtime based on the configuration file.