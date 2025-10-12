# Testing CWSL WebSDR Integration

This guide walks you through testing the ka9q-radio CWSL WebSDR integration step-by-step.

## Prerequisites

1. **CWSL WebSDR server running** (cwsl_websdr or CWSL_Net)
2. **ka9q-radio built** with cwsl_websdr.so
3. **Network connectivity** to the server

## Step 1: Verify CWSL WebSDR Server

First, check if the CWSL WebSDR server is accessible:

### Test TCP Connection

```bash
# Test if server is listening (adjust host/port as needed)
telnet 192.168.9.74 11000
# or for local server:
telnet localhost 50001
```

If successful, you should see a connection. Try these commands:
```
attach 0
# Should respond with: OK SampleRate=192000 BlockInSamples=1024 L0=<frequency>

quit
# Should respond with: OK
```

### Common Server Configurations

Based on cwsl_netrx defaults:
- **Network server**: `192.168.9.74:11000` (CWSL_Net default)
- **Local server**: `localhost:50001` (cwsl_websdr default)

## Step 2: Create Test Configuration

Create a minimal test configuration:

```bash
cat > /tmp/test-cwsl.conf << 'EOF'
[global]
hardware = cwsl_websdr
status = test-cwsl.local
data = test-cwsl-pcm.local
blocktime = 20
verbose = 1

[cwsl_websdr]
device = cwsl_websdr
description = CWSL WebSDR Test
host = 192.168.9.74    # Change to your server IP
port = 11000           # Change to your server port
udp_port = 12000       # Local UDP port for IQ data
receiver = 0
samprate = 192000
scaling = 16
frequency = 14074000   # 20m FT8
calibrate = 0.0

# Simple test channel - IQ output
[test-iq]
freq = 14074000
mode = iq
data = test-iq.local
low = -1500
high = 1500
EOF
```

### Configuration Notes

- **host**: Your CWSL WebSDR server IP (192.168.9.74 for network, localhost for local)
- **port**: TCP control port (11000 for CWSL_Net, 50001 for cwsl_websdr)
- **udp_port**: Local UDP port (12000+ for CWSL_Net, 50100+ for cwsl_websdr)
- **receiver**: Receiver ID (0-7, start with 0)
- **frequency**: Initial frequency in Hz

## Step 3: Test Basic Connection

Run radiod with verbose output to see connection details:

```bash
radiod -v /tmp/test-cwsl.conf
```

### Expected Output (Success)

```
Loading config file /tmp/test-cwsl.conf
1 total demodulators started
Dynamically loading cwsl_websdr hardware driver from /usr/local/lib/ka9q-radio/cwsl_websdr.so
cwsl-websdr connected to 192.168.9.74:11000, receiver 0, samprate 192,000 Hz, UDP port 12000, scaling 16
Attached to receiver 0: SampleRate=192000, BlockInSamples=1024, L0=7091000
Started IQ streaming on UDP port 12000 with scaling factor 16
cwsl_websdr threads running
```

### Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| "Failed to connect" | Server not running or wrong host/port | Check server is running, verify host/port |
| "Connection refused" | Firewall blocking | Check firewall rules |
| "Failed to attach to receiver" | Invalid receiver ID | Try receiver 0, check server has receivers |
| "Address already in use" | UDP port in use | Change udp_port to different value |
| "No such file" | Driver not installed | Run `sudo make install` |

## Step 4: Verify Data Reception

### Check UDP Traffic

In another terminal, monitor UDP traffic:

```bash
# Monitor UDP packets on the data port
sudo tcpdump -i any -n udp port 12000 -c 10
```

You should see UDP packets arriving:
```
09:00:01.123456 IP 192.168.9.74.11000 > 127.0.0.1.12000: UDP, length 2048
09:00:01.143456 IP 192.168.9.74.11000 > 127.0.0.1.12000: UDP, length 2048
...
```

### Check radiod Status

While radiod is running, check status in another terminal:

```bash
# View status
tune test-cwsl.local

# Or use control
control test-cwsl.local
```

### Monitor Output

```bash
# Monitor the IQ output stream
monitor test-iq.local
```

You should see:
- Frequency display
- Signal strength
- Spectrum display (if applicable)

## Step 5: Verify IQ Data Quality

### Check for Overranges

In radiod output, look for overrange messages:
```
# Good - no overranges
samples: 1920000, overranges: 0

# Bad - many overranges (reduce scaling factor)
samples: 1920000, overranges: 15234
```

If you see many overranges, reduce the scaling factor in config:
```ini
scaling = 8  # Try lower values: 8, 4, 2
```

### Check Signal Levels

Use `tune` to check signal levels:
```bash
tune test-cwsl.local
```

Look for:
- **IF Power**: Should be reasonable (not maxed out)
- **Frequency**: Should match your setting
- **Sample Rate**: Should be 192000

## Step 6: Test Frequency Tuning

Test if frequency changes work:

```bash
# Tune to different frequency
tune test-cwsl.local freq=14.100e6

# Check it changed
tune test-cwsl.local
```

## Step 7: Test with Real Signals

### FT8 Test (20m)

```bash
# Configure for FT8
cat > /tmp/test-ft8.conf << 'EOF'
[global]
hardware = cwsl_websdr
status = test-cwsl.local
data = test-cwsl-pcm.local

[cwsl_websdr]
device = cwsl_websdr
host = 192.168.9.74
port = 11000
udp_port = 12000
receiver = 0
samprate = 192000
scaling = 16
frequency = 14074000

[ft8-20m]
freq = 14074000
mode = iq
data = ft8-20m.local
low = -1500
high = 1500
EOF

# Run radiod
radiod /tmp/test-ft8.conf

# In another terminal, decode FT8
# (requires wsjtx or similar)
```

### WSPR Test (20m)

```bash
# Configure for WSPR
cat > /tmp/test-wspr.conf << 'EOF'
[global]
hardware = cwsl_websdr
status = test-cwsl.local

[cwsl_websdr]
device = cwsl_websdr
host = 192.168.9.74
port = 11000
udp_port = 12000
receiver = 0
frequency = 14095600

[wspr-20m]
freq = 14095600
mode = iq
data = wspr-20m.local
low = -100
high = 100
EOF

radiod /tmp/test-wspr.conf
```

## Step 8: Performance Testing

### Check CPU Usage

```bash
# Monitor CPU usage
top -p $(pgrep radiod)
```

Should be similar to USB-based frontends (~5-10% per receiver).

### Check Network Bandwidth

```bash
# Monitor network usage
iftop -i eth0 -f "port 12000"
```

Expected: ~6 Mbps for 192 kHz IQ stream.

### Check Latency

```bash
# Ping the server
ping -c 10 192.168.9.74
```

Should be <10ms for local network.

## Troubleshooting

### No Data Received

1. **Check server is streaming**:
   ```bash
   # On server, check if UDP is being sent
   sudo tcpdump -i any -n udp port 12000
   ```

2. **Check firewall**:
   ```bash
   # Allow UDP port
   sudo ufw allow 12000/udp
   ```

3. **Try different UDP port**:
   ```ini
   udp_port = 12001  # Try different port
   ```

### Poor Audio Quality

1. **Adjust scaling factor**:
   ```ini
   scaling = 8  # Try: 4, 8, 16, 32
   ```

2. **Check sample rate**:
   ```bash
   # Verify server sample rate matches config
   telnet 192.168.9.74 11000
   > attach 0
   # Check SampleRate in response
   ```

### Connection Drops

1. **Check network stability**:
   ```bash
   ping -c 100 192.168.9.74
   ```

2. **Increase TCP keepalive** (in cwsl_websdr.c, already set to 10s)

3. **Check server logs** for disconnection reasons

## Success Criteria

✅ radiod starts without errors  
✅ Connection to CWSL WebSDR server succeeds  
✅ Receiver attaches successfully  
✅ UDP data packets arrive  
✅ No excessive overranges  
✅ Frequency tuning works  
✅ Signal levels are reasonable  
✅ CPU usage is normal  
✅ Can decode real signals (FT8, WSPR, etc.)  

## Next Steps

Once basic testing passes:

1. **Configure for production** - Edit `/etc/radio/radiod@cwsl-hf.conf`
2. **Set up multiple receivers** - Use different UDP ports
3. **Configure demodulators** - Add FT8, WSPR, SSB channels
4. **Monitor performance** - Use `monitor` and `control` tools
5. **Set up logging** - Configure syslog or file logging

## Quick Test Script

Save this as `test-cwsl.sh`:

```bash
#!/bin/bash
# Quick test script for CWSL WebSDR integration

SERVER_HOST="${1:-192.168.9.74}"
SERVER_PORT="${2:-11000}"
UDP_PORT="${3:-12000}"

echo "Testing CWSL WebSDR at $SERVER_HOST:$SERVER_PORT"

# Test 1: TCP connection
echo "Test 1: TCP connection..."
timeout 5 bash -c "echo 'quit' | telnet $SERVER_HOST $SERVER_PORT" 2>&1 | grep -q "OK" && echo "✅ TCP OK" || echo "❌ TCP FAILED"

# Test 2: Build check
echo "Test 2: Driver build..."
[ -f ka9q-radio/src/cwsl_websdr.so ] && echo "✅ Driver built" || echo "❌ Driver not built"

# Test 3: Symbol check
echo "Test 3: Driver symbols..."
nm -D ka9q-radio/src/cwsl_websdr.so | grep -q "cwsl_websdr_setup" && echo "✅ Symbols OK" || echo "❌ Symbols missing"

echo ""
echo "Ready to test! Run:"
echo "  radiod -v /tmp/test-cwsl.conf"
```

Run with:
```bash
chmod +x test-cwsl.sh
./test-cwsl.sh 192.168.9.74 11000 12000
```

## Reference

- **CWSL_Net defaults**: host=192.168.9.74, port=11000, udp_base=12000
- **cwsl_websdr defaults**: host=localhost, port=50001, udp_port=50100
- **Sample rate**: 192000 Hz (192 kHz)
- **Block size**: 1024 samples
- **Scaling factor**: 16 (adjustable 1-64)