# CWSL WebSDR Quick Start Guide

## Build Status: ✅ SUCCESS

The CWSL WebSDR driver has been successfully built and integrated into ka9q-radio!

```
Build output:
- cwsl_websdr.so: 26KB ELF 64-bit LSB shared object
- Exported symbols: cwsl_websdr_setup, cwsl_websdr_startup, cwsl_websdr_tune
- Dependencies: Only standard C library (no additional dependencies)
```

## Quick Build

```bash
cd ka9q-radio/src
make clean
make
```

The driver (`cwsl_websdr.so`) will be built automatically along with all other drivers.

## Quick Test

### 1. Start CWSL WebSDR Server

Make sure your CWSL WebSDR server is running:
```bash
# Example - adjust for your setup
./cwsl_websdr
```

### 2. Configure radiod

```bash
# Copy example config
sudo mkdir -p /etc/radio
sudo cp ka9q-radio/share/radiod@cwsl-hf.conf /etc/radio/

# Edit to match your setup
sudo vi /etc/radio/radiod@cwsl-hf.conf
```

Key settings to check:
- `host = localhost` (or your server IP)
- `port = 50001` (CWSL WebSDR TCP port)
- `udp_port = 50100` (local UDP port for IQ data)
- `receiver = 0` (receiver ID)

### 3. Run radiod

```bash
# Test with verbose output
radiod -v /etc/radio/radiod@cwsl-hf.conf
```

Expected output:
```
Loading config file /etc/radio/radiod@cwsl-hf.conf
Dynamically loading cwsl_websdr hardware driver from /usr/local/lib/ka9q-radio/cwsl_websdr.so
cwsl-websdr connected to localhost:50001, receiver 0, samprate 192,000 Hz
Attached to receiver 0: SampleRate=192000, BlockInSamples=1024, L0=7091000
Started IQ streaming on UDP port 50100 with scaling factor 16
cwsl_websdr threads running
```

## Troubleshooting

### Build Issues

If you see "Nothing to be done for 'all'":
```bash
cd ka9q-radio/src
make clean
make
```

### Connection Issues

1. **Check CWSL WebSDR is running**:
   ```bash
   telnet localhost 50001
   ```

2. **Check UDP port is available**:
   ```bash
   netstat -an | grep 50100
   ```

3. **Test with verbose logging**:
   ```bash
   radiod -v /etc/radio/radiod@cwsl-hf.conf
   ```

### Common Errors

| Error | Solution |
|-------|----------|
| "Failed to connect" | Check host/port, ensure server is running |
| "Failed to attach to receiver" | Verify receiver ID is valid |
| "UDP recv error" | Check firewall, ensure UDP port not blocked |
| "No such file or directory" | Run `sudo make install` to install driver |

## Next Steps

Once radiod is running successfully:

1. **Monitor with control**:
   ```bash
   control ka9q-hf-cwsl.local
   ```

2. **View with monitor**:
   ```bash
   monitor ka9q-hf-cwsl.local
   ```

3. **Check status**:
   ```bash
   tune ka9q-hf-cwsl.local
   ```

## Documentation

- **Build Guide**: [BUILD_CWSL_WEBSDR.md](BUILD_CWSL_WEBSDR.md)
- **User Manual**: [cwsl_websdr.md](cwsl_websdr.md)
- **Integration Details**: [CWSL_INTEGRATION.md](CWSL_INTEGRATION.md)
- **Example Config**: [../share/radiod@cwsl-hf.conf](../share/radiod@cwsl-hf.conf)

## Architecture

```
┌─────────────────────────────────────────┐
│         ka9q-radio (radiod)             │
│  ┌───────────────────────────────────┐  │
│  │   cwsl_websdr.so (26KB)           │  │
│  │   - cwsl_websdr_setup()           │  │
│  │   - cwsl_websdr_startup()         │  │
│  │   - cwsl_websdr_tune()            │  │
│  └───────────┬───────────────────────┘  │
└──────────────┼──────────────────────────┘
               │
               │ TCP :50001 (control)
               │ UDP :50100 (IQ data)
               │
┌──────────────▼──────────────────────────┐
│       CWSL WebSDR Server                │
│  - Receiver management                  │
│  - IQ streaming (16-bit samples)        │
│  - Multiple client support              │
└──────────────┬──────────────────────────┘
               │
               │ USB
┌──────────────▼──────────────────────────┐
│         SDR Hardware                    │
│  (RTL-SDR, Airspy, RX888, etc.)        │
└─────────────────────────────────────────┘
```

## Success Indicators

✅ **Build**: `cwsl_websdr.so` created (26KB)  
✅ **Symbols**: All required functions exported  
✅ **Dependencies**: Only standard C library  
✅ **Integration**: Added to Makefile  
✅ **Documentation**: Complete guides available  
✅ **Configuration**: Example config provided  

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the full documentation
3. Verify CWSL WebSDR server is working correctly
4. Test with verbose logging (`-v` flag)

The integration is complete and ready for use!