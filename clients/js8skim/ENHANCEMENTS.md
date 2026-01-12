# JS8Skim Enhancements

This document describes the enhancements made to js8skim to bring it closer to the full JS8Call desktop application functionality.

## Overview

The enhanced version (`js8skim-enhanced`) adds three major features that were missing from the original skimmer:

1. **Multi-submode decoding support** - Decode multiple JS8 speeds simultaneously
2. **Message reconstruction** - Buffer and reassemble multi-frame messages
3. **Deduplication** - Track and filter duplicate decodes

## What Was Missing

### Original js8skim Limitations

The original `js8skim` was a minimal receive-only decoder that:
- Only decoded JS8 Normal mode (15-second transmissions)
- Output each decoded frame independently without tracking message continuity
- Had no deduplication, showing the same decode multiple times
- Couldn't reconstruct multi-frame messages that span multiple transmission cycles

### JS8Call Desktop Features

The full JS8Call application includes:
- **Variable speed support**: Normal, Fast, Turbo, Slow, and Ultra modes
- **Message reconstruction**: Buffers frames and assembles complete multi-frame messages
- **Deduplication**: Tracks recently seen frames to avoid duplicate output
- **Frame type parsing**: Identifies heartbeats, directed messages, compounds, etc.
- **Activity tracking**: Maintains band activity and call activity tables
- **Heard graph**: Tracks which stations have heard which other stations

## New Features

### 1. Multi-Submode Decoding

JS8 has five different transmission speeds (submodes):

| Submode | Symbol Duration | TX Time | Use Case |
|---------|----------------|---------|----------|
| Normal (A) | 1920 samples | 15s | Standard operation |
| Fast (B) | 1200 samples | 10s | Faster QSOs |
| Turbo (C) | 600 samples | 6s | Very fast, shorter range |
| Slow (E) | 3840 samples | 30s | Weak signal, long range |
| Ultra (I) | 384 samples | 4s | Experimental, rarely used |

**Implementation:**
- Added `JS8Submode` enum with all five modes
- Created `SubmodeParams` structure with timing parameters for each mode
- Enhanced decoder can be configured to decode specific submodes
- Each decode is tagged with its submode in the output

**Usage:**
```bash
# Decode only Normal mode (default)
./js8skim-enhanced localhost:8073,14074000

# Decode Normal and Fast modes
./js8skim-enhanced --multi-submode --submodes=normal,fast localhost:8073,14074000

# Decode all common modes
./js8skim-enhanced --multi-submode --submodes=normal,fast,turbo,slow localhost:8073,14074000
```

**Note:** Multi-submode decoding is CPU-intensive as it runs multiple decoders in parallel. It's disabled by default.

### 2. Message Reconstruction

JS8Call messages can span multiple transmission frames. The enhanced decoder:

- **Buffers frames** by frequency offset
- **Tracks frame types**: First, Last, or continuation frames
- **Extracts block numbers** from message text (e.g., `[01]`, `[02]`)
- **Assembles complete messages** when the last frame is received
- **Outputs reconstructed messages** with `[COMPLETE]` tag

**Frame Types:**
- `TX_FIRST` - First frame of a multi-frame message (marked with `^`)
- `TX_LAST` - Last frame of a multi-frame message (marked with `$`)
- `TX_NORMAL` - Continuation or single-frame message

**Message Buffer:**
- Tracks frames by frequency offset
- Expires incomplete messages after 60 seconds
- Sorts frames by block number or timestamp
- Concatenates frame text to reconstruct complete message

**Example Output:**
```
2026-01-12T09:30:15Z 14074500 K1ABC 5.2 Normal DIRECTED [FIRST]
2026-01-12T09:30:30Z 14074500 K1ABC 4.8 Normal DIRECTED [BLK:2]
2026-01-12T09:30:45Z 14074500 K1ABC 5.5 Normal DIRECTED [LAST]
2026-01-12T09:30:45Z 14074500 [COMPLETE] K1ABC: W1XYZ: This is a complete multi-frame message that was split across three transmissions
```

**Usage:**
```bash
# Enable message reconstruction (default)
./js8skim-enhanced localhost:8073,14074000

# Disable message reconstruction
./js8skim-enhanced --no-reconstruct localhost:8073,14074000
```

### 3. Deduplication

The enhanced decoder maintains a cache of recently seen frames to prevent duplicate output.

**Cache Key:** Combination of:
- Decoded text
- Frequency offset
- Submode

**Cache Expiry:** 5 minutes (300 seconds)

**Benefits:**
- Reduces output noise from repeated decodes of the same signal
- Prevents duplicate spots to PSK Reporter or other logging systems
- Makes output easier to read and process

**Usage:**
```bash
# Enable deduplication (default)
./js8skim-enhanced localhost:8073,14074000

# Disable deduplication (show all decodes)
./js8skim-enhanced --no-dedup localhost:8073,14074000
```

## Implementation Details

### File Structure

```
clients/js8skim/
├── js8_enhanced.h          # Enhanced decoder header
├── js8_enhanced.cc         # Enhanced decoder implementation
├── fate_enhanced.cc        # Enhanced main program
├── fate.cc                 # Original main program (unchanged)
├── js8.cc                  # Core JS8 decoder (unchanged)
└── Makefile                # Updated to build both versions
```

### Key Classes

#### `JS8EnhancedDecoder`
Main class that manages:
- Deduplication cache
- Message reconstruction buffers
- Frame parsing and analysis
- Cache cleanup

#### `DecodedFrame`
Structure containing:
- Decoded text
- Frequency, time offset, SNR
- Submode
- Frame type (heartbeat, directed, data, etc.)
- Transmission type (first, last, normal)
- Block number (if present)
- Timestamp

#### `MessageBuffer`
Structure for reconstructing multi-frame messages:
- From/to callsigns
- Vector of frames
- First/last seen timestamps
- Completion status

### Frame Type Detection

The enhanced decoder identifies frame types based on content patterns:

- **FRAME_HEARTBEAT**: Contains "HB" or "♡"
- **FRAME_DIRECTED**: Contains ":" (TO: FROM: format)
- **FRAME_COMPOUND**: Contains "/" in callsign
- **FRAME_COMPOUND_DIRECTED**: Compound callsign with ">"
- **FRAME_DATA**: General data frame (CQ, etc.)

### Transmission Type Detection

Transmission types are detected using heuristics:

- **TX_FIRST**: Text starts with "^"
- **TX_LAST**: Text contains or ends with "$"
- **TX_NORMAL**: Default for other frames

**Note:** Full implementation would require access to the i3 bits from the FT8 decoder, which encode the transmission type directly.

## Output Format

### Enhanced Output

```
TIMESTAMP FREQUENCY CALLSIGN SNR [GRID] SUBMODE FRAMETYPE [FLAGS]
```

**Example:**
```
2026-01-12T09:30:15Z 14074500 K1ABC 5.2 FN42 Normal DIRECTED [FIRST]
2026-01-12T09:30:30Z 14074800 W1XYZ -3.5 EM79 Fast HB
2026-01-12T09:30:45Z 14074500 [COMPLETE] K1ABC: W1XYZ: Complete message text here
```

**Fields:**
- `TIMESTAMP`: ISO 8601 format with Z suffix (UTC)
- `FREQUENCY`: Actual RF frequency (tuned freq + audio offset)
- `CALLSIGN`: Extracted callsign or `[text]` if no callsign
- `SNR`: Signal-to-noise ratio in dB
- `GRID`: Maidenhead grid locator (if present)
- `SUBMODE`: Normal, Fast, Turbo, Slow, or Ultra
- `FRAMETYPE`: HB, DIRECTED, COMPOUND, DATA, etc.
- `FLAGS`: [FIRST], [LAST], [BLK:n], [COMPLETE]

## Building

```bash
cd clients/js8skim

# Build original version
make js8skim

# Build enhanced version
make js8skim-enhanced

# Build both
make all

# Clean
make clean
```

## Usage Examples

### Basic Usage

```bash
# Original version (simple, fast)
./js8skim localhost:8073,14074000

# Enhanced version with all features
./js8skim-enhanced localhost:8073,14074000
```

### Advanced Usage

```bash
# Multi-submode with Normal and Fast
./js8skim-enhanced --multi-submode --submodes=normal,fast localhost:8073,14074000

# No deduplication (show all decodes)
./js8skim-enhanced --no-dedup localhost:8073,14074000

# No message reconstruction (individual frames only)
./js8skim-enhanced --no-reconstruct localhost:8073,14074000

# Minimal mode (like original js8skim)
./js8skim-enhanced --no-dedup --no-reconstruct localhost:8073,14074000

# Unix socket with PCM audio (local, low latency)
./js8skim-enhanced unix:/tmp/ubersdr.sock,14074000
```

## Performance Considerations

### CPU Usage

- **Original js8skim**: Low CPU usage, single decoder
- **Enhanced (default)**: Slightly higher due to caching and parsing
- **Enhanced (multi-submode)**: High CPU usage, runs multiple decoders in parallel

**Recommendation:** Use multi-submode only when necessary, or on powerful hardware.

### Memory Usage

- **Deduplication cache**: ~1KB per unique decode, expires after 5 minutes
- **Message buffers**: ~1KB per incomplete message, expires after 60 seconds
- **Typical usage**: < 10MB additional memory

### Cleanup

A background thread runs every 60 seconds to remove expired cache entries and message buffers.

## Future Enhancements

Potential improvements for future versions:

1. **True multi-submode decoding**: Modify core decoder to detect submode from signal characteristics
2. **Heard graph**: Track which stations have heard which other stations
3. **Activity tables**: Maintain band activity and call activity like JS8Call
4. **Command parsing**: Identify and parse JS8Call commands (SNR?, GRID?, etc.)
5. **Relay path tracking**: Parse and display relay paths for relayed messages
6. **Configuration file**: Support config file for persistent settings
7. **Metrics output**: Export statistics (decodes/minute, SNR distribution, etc.)
8. **Database logging**: Optional SQLite database for decode history

## Compatibility

- **Backward compatible**: Original `js8skim` still available and unchanged
- **Output format**: Enhanced version adds fields but maintains basic format
- **Dependencies**: Same as original (FFTW3, Opus, libcurl)
- **Platform**: Linux, macOS (same as original)

## Testing

To test the enhanced features:

1. **Deduplication**: Run with and without `--no-dedup`, observe duplicate filtering
2. **Message reconstruction**: Look for `[COMPLETE]` messages during multi-frame transmissions
3. **Multi-submode**: Use `--multi-submode` and transmit on different speeds

## Troubleshooting

### No decodes appearing

- Check that the frequency is correct
- Verify UberSDR connection is working
- Try `--no-dedup` to see if deduplication is too aggressive

### Incomplete messages not reconstructing

- Check that frames are on the same frequency offset
- Verify 60-second timeout isn't expiring messages
- Look for `[FIRST]` and `[LAST]` tags in output

### High CPU usage

- Disable multi-submode if not needed
- Reduce number of enabled submodes
- Use original `js8skim` for minimal CPU usage

## Credits

- **Original js8skim**: Robert Morris, AB1HL
- **JS8Call**: Jordan Sherer, KN4CRD
- **Enhancements**: Based on JS8Call desktop application architecture

## License

Same license as original js8skim (see LICENSE file).
