# CWSL WebSDR Integration for ka9q-radio

## Overview

The `cwsl_websdr` driver enables ka9q-radio to use CWSL WebSDR as a network-based IQ data source instead of USB hardware. This allows ka9q-radio to receive and process IQ data from remote CWSL WebSDR servers over the network.

## Architecture

The integration consists of:

1. **cwsl_websdr.c** - Frontend driver that implements the ka9q-radio frontend interface
2. **TCP Control Connection** - Manages receiver attachment, frequency tuning, and streaming control
3. **UDP Data Stream** - Receives 16-bit IQ samples from the CWSL WebSDR server

## Protocol

The driver implements the CWSL WebSDR network protocol:

### TCP Commands
- `attach <receiver_id>` - Attach to a specific receiver
- `frequency <freq_hz>` - Set receiver frequency
- `start iq <udp_port> <scaling_factor>` - Start IQ streaming
- `stop iq` - Stop IQ streaming
- `detach <receiver_id>` - Detach from receiver
- `quit` - Close connection

### UDP Data Format
- 16-bit signed integers (little-endian)
- Interleaved I/Q samples: I, Q, I, Q, ...
- Default sample rate: 192 kHz
- Configurable scaling factor (1-64, default 16)

## Configuration

### Example Configuration File

```ini
[global]
hardware = cwsl_websdr
status = ka9q-hf-cwsl.local
data = ka9q-hf-cwsl-pcm.local

[cwsl_websdr]
device = cwsl_websdr
description = CWSL WebSDR HF Receiver
host = localhost
port = 50001
udp_port = 50100
receiver = 0
samprate = 192000
scaling = 16
frequency = 7074000
calibrate = 0.0
```

### Configuration Parameters

| Parameter | Description | Default | Required |
|-----------|-------------|---------|----------|
| `device` | Must be "cwsl_websdr" | - | Yes |
| `description` | Human-readable description | "cwsl-websdr" | No |
| `host` | CWSL WebSDR server hostname/IP | "localhost" | No |
| `port` | TCP control port | 50001 | No |
| `udp_port` | UDP data port (local) | 50100 | No |
| `receiver` | Receiver ID to attach to | 0 | No |
| `samprate` | Sample rate in Hz | 192000 | No |
| `scaling` | IQ scaling factor (1-64) | 16 | No |
| `frequency` | Initial frequency in Hz | (from server) | No |
| `calibrate` | Frequency calibration offset | 0.0 | No |

## Building

Add `cwsl_websdr.c` to the ka9q-radio build:

```bash
cd ka9q-radio/src
# Add cwsl_websdr.c to Makefile
make
```

The driver will be compiled as a shared library: `cwsl_websdr.so`

## Usage

### Starting radiod with CWSL WebSDR

```bash
radiod /etc/radio/radiod@cwsl-hf.conf
```

### Multiple Receivers

You can configure multiple CWSL WebSDR receivers by using different UDP ports:

```ini
[cwsl_websdr_1]
device = cwsl_websdr
host = sdr1.example.com
udp_port = 50100
receiver = 0

[cwsl_websdr_2]
device = cwsl_websdr
host = sdr2.example.com
udp_port = 50101
receiver = 1
```

## Comparison with USB Devices

### Advantages
- **Network-based**: Access remote SDR hardware over LAN/WAN
- **No USB dependencies**: No USB drivers or hardware required
- **Flexible deployment**: Run ka9q-radio on different machines than SDR hardware
- **Multiple clients**: Multiple ka9q-radio instances can connect to same CWSL WebSDR server

### Considerations
- **Network latency**: UDP packet delivery depends on network quality
- **Bandwidth**: Requires stable network bandwidth (e.g., ~6 Mbps for 192 kHz IQ)
- **Server dependency**: Requires running cwsl_websdr server

## Troubleshooting

### Connection Issues

```bash
# Check if CWSL WebSDR server is running
telnet localhost 50001

# Check UDP port availability
netstat -an | grep 50100
```

### Debugging

Enable verbose mode to see detailed connection and streaming information:

```bash
radiod -v /etc/radio/radiod@cwsl-hf.conf
```

### Common Issues

1. **"Failed to connect"**: Check host and port settings, ensure cwsl_websdr server is running
2. **"Failed to attach to receiver"**: Verify receiver ID is valid and available
3. **"UDP recv error"**: Check firewall settings, ensure UDP port is not blocked
4. **No audio output**: Verify frequency is within receiver coverage, check scaling factor

## Performance

### Recommended Settings

- **Sample Rate**: 192 kHz (default for CWSL WebSDR)
- **Scaling Factor**: 16 (provides good dynamic range)
- **Block Time**: 20 ms (default in ka9q-radio)
- **Network**: Gigabit Ethernet or better for local connections

### Resource Usage

- **CPU**: Similar to USB-based frontends
- **Memory**: ~50 MB per receiver
- **Network**: ~6 Mbps per 192 kHz receiver

## Integration with cwsl_netrx

The cwsl_websdr driver is compatible with the cwsl_netrx ecosystem:

```
┌─────────────────┐
│  CWSL Hardware  │
│   (USB SDR)     │
└────────┬────────┘
         │
┌────────▼────────┐
│  cwsl_websdr    │
│    (Server)     │
└────────┬────────┘
         │ TCP/UDP
    ┌────┴────┐
    │         │
┌───▼───┐ ┌──▼──────┐
│ka9q-  │ │ cwsl_   │
│radio  │ │ netrx   │
└───────┘ └─────────┘
```

## See Also

- [ka9q-radio documentation](ka9q-radio-3.md)
- [CWSL WebSDR protocol](../../cwsl_websdr/)
- [cwsl_netrx client](../../cwsl_netrx/)

## License

Copyright 2025, Nathan Handler
Part of the CWSL project