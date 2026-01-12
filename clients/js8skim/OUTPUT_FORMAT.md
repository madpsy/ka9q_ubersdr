# JS8Skim Enhanced Output Format

This document shows exactly how the enhanced js8skim outputs data, including how multi-frame message reconstruction appears.

## Output Format

Each line of output follows this format:

```
TIMESTAMP FREQUENCY CALLSIGN SNR [GRID] SUBMODE FRAMETYPE [FLAGS]
```

## Example Output Session

Here's a real example showing how multi-frame messages are displayed:

```
# Individual frames are printed as they're decoded:
2026-01-12T09:30:15Z 14074500 K1ABC 5.2 FN42 Normal DIRECTED [FIRST]
2026-01-12T09:30:30Z 14074500 K1ABC 4.8 Normal DIRECTED [BLK:2]
2026-01-12T09:30:45Z 14074500 K1ABC 5.5 Normal DIRECTED [LAST]

# When the last frame arrives, a COMPLETE message line is printed:
2026-01-12T09:30:45Z 14074500 [COMPLETE] W1XYZ: K1ABC: This is the complete reconstructed message that was split across three transmission frames

# Other activity continues normally:
2026-01-12T09:31:00Z 14074800 W1XYZ -3.5 EM79 Fast HB
2026-01-12T09:31:15Z 14074300 N2DEF 8.2 Normal DATA
```

## Key Points

### 1. Individual Frames Are Always Shown

Each decoded frame produces its own output line with metadata:
- Timestamp when decoded
- Frequency offset
- Callsign (if extractable)
- SNR
- Grid locator (if present)
- Submode (Normal, Fast, Turbo, Slow)
- Frame type (DIRECTED, HB, DATA, etc.)
- Flags indicating position in multi-frame sequence

### 2. Complete Messages Are Separate Lines

When a multi-frame message is complete (last frame received):
- A **new line** is printed with `[COMPLETE]` marker
- The callsign field shows `[COMPLETE]` instead of a callsign
- The rest of the line contains the **full reconstructed message text**
- This happens immediately when the last frame is decoded

### 3. The `[COMPLETE]` Line Format

```
TIMESTAMP FREQUENCY [COMPLETE] FULL_MESSAGE_TEXT
```

**Example:**
```
2026-01-12T09:30:45Z 14074500 [COMPLETE] W1XYZ: K1ABC: This is the complete message
```

**Fields:**
- `TIMESTAMP`: When the last frame was received
- `FREQUENCY`: The frequency offset where the message was transmitted
- `[COMPLETE]`: Marker indicating this is a reconstructed message
- `FULL_MESSAGE_TEXT`: The complete message with all frames concatenated

## Detailed Example: Multi-Frame QSO

Here's a complete example of a multi-frame conversation:

```
# Station K1ABC starts a long message to W1XYZ
2026-01-12T14:00:00Z 14074500 K1ABC 6.1 FN42 Normal DIRECTED [FIRST]
2026-01-12T14:00:15Z 14074500 K1ABC 5.8 Normal DIRECTED [BLK:2]
2026-01-12T14:00:30Z 14074500 K1ABC 6.3 Normal DIRECTED [BLK:3]
2026-01-12T14:00:45Z 14074500 K1ABC 5.9 Normal DIRECTED [LAST]
2026-01-12T14:00:45Z 14074500 [COMPLETE] W1XYZ: K1ABC: Thanks for the QSO! My rig is an IC-7300 running 100W into a dipole at 40 feet. 73!

# Meanwhile, other stations are active on different frequencies
2026-01-12T14:00:10Z 14074800 N2DEF 4.2 EM79 Normal HB
2026-01-12T14:00:25Z 14074300 W3GHI -1.5 Normal DATA

# W1XYZ replies with a shorter message (single frame)
2026-01-12T14:01:00Z 14074500 W1XYZ 7.8 EM79 Normal DIRECTED
2026-01-12T14:01:00Z 14074500 [COMPLETE] K1ABC: W1XYZ: 73 and thanks!

# Another station sends a CQ
2026-01-12T14:01:15Z 14074600 K4JKL 9.2 EM85 Normal DATA
```

## Parsing the Output

### For Simple Monitoring

Just watch for lines - each line is a decode event. Lines with `[COMPLETE]` contain full reconstructed messages.

### For Automated Processing

```python
import sys

for line in sys.stdin:
    parts = line.strip().split(maxsplit=3)
    timestamp = parts[0]
    frequency = int(parts[1])
    
    if '[COMPLETE]' in line:
        # This is a reconstructed multi-frame message
        message_text = parts[3]  # Everything after "[COMPLETE]"
        print(f"Complete message at {frequency} Hz: {message_text}")
    else:
        # This is an individual frame
        callsign = parts[2]
        # Parse remaining fields...
        print(f"Frame from {callsign} at {frequency} Hz")
```

### For Database Logging

You might want to:
1. **Log individual frames** to track all activity
2. **Log complete messages** separately for conversation tracking
3. **Link frames to complete messages** using frequency and timestamp

## Comparison: With vs Without Reconstruction

### Without Message Reconstruction (`--no-reconstruct`)

```
2026-01-12T14:00:00Z 14074500 K1ABC 6.1 FN42 Normal DIRECTED [FIRST]
2026-01-12T14:00:15Z 14074500 K1ABC 5.8 Normal DIRECTED [BLK:2]
2026-01-12T14:00:30Z 14074500 K1ABC 6.3 Normal DIRECTED [BLK:3]
2026-01-12T14:00:45Z 14074500 K1ABC 5.9 Normal DIRECTED [LAST]
```

You see the individual frames but **no `[COMPLETE]` line** - you'd have to manually piece together the message.

### With Message Reconstruction (default)

```
2026-01-12T14:00:00Z 14074500 K1ABC 6.1 FN42 Normal DIRECTED [FIRST]
2026-01-12T14:00:15Z 14074500 K1ABC 5.8 Normal DIRECTED [BLK:2]
2026-01-12T14:00:30Z 14074500 K1ABC 6.3 Normal DIRECTED [BLK:3]
2026-01-12T14:00:45Z 14074500 K1ABC 5.9 Normal DIRECTED [LAST]
2026-01-12T14:00:45Z 14074500 [COMPLETE] W1XYZ: K1ABC: Thanks for the QSO! My rig is an IC-7300 running 100W into a dipole at 40 feet. 73!
```

You see both the individual frames **and** the complete reconstructed message.

## Why Both Individual Frames and Complete Messages?

### Individual Frames Are Useful For:
- Real-time monitoring of signal strength (SNR)
- Tracking propagation changes across a multi-frame transmission
- Debugging reception issues
- Spotting to PSK Reporter (each frame is a separate spot)

### Complete Messages Are Useful For:
- Reading the actual conversation
- Logging QSOs
- Understanding the full context
- Automated message processing

## Special Cases

### Single-Frame Messages

If a message fits in one frame, you'll see:
```
2026-01-12T14:01:00Z 14074500 W1XYZ 7.8 EM79 Normal DIRECTED
2026-01-12T14:01:00Z 14074500 [COMPLETE] K1ABC: W1XYZ: 73!
```

Both lines appear because even single-frame messages go through the reconstruction logic.

### Incomplete Messages

If frames are missed (poor propagation), you might see:
```
2026-01-12T14:00:00Z 14074500 K1ABC 6.1 FN42 Normal DIRECTED [FIRST]
2026-01-12T14:00:15Z 14074500 K1ABC 5.8 Normal DIRECTED [BLK:2]
# Frame 3 was missed due to QSB
2026-01-12T14:00:45Z 14074500 K1ABC 5.9 Normal DIRECTED [LAST]
2026-01-12T14:00:45Z 14074500 [COMPLETE] W1XYZ: K1ABC: Thanks for the QSO! My rig is [MISSING] 73!
```

The `[COMPLETE]` line will still appear, but with gaps where frames were missed.

**Note:** The current implementation concatenates available frames. A future enhancement could mark missing frames explicitly.

### Timeout Expiry

If the last frame never arrives (transmission interrupted), the incomplete message buffer expires after 60 seconds and **no `[COMPLETE]` line is printed**. You'll only see the individual frames that were received.

## Filtering Output

### Show Only Complete Messages

```bash
./js8skim-enhanced localhost:8073,14074000 | grep '\[COMPLETE\]'
```

### Show Only Individual Frames

```bash
./js8skim-enhanced localhost:8073,14074000 | grep -v '\[COMPLETE\]'
```

### Show Only Multi-Frame Messages

```bash
./js8skim-enhanced localhost:8073,14074000 | grep -E '\[FIRST\]|\[LAST\]|\[BLK:\]|\[COMPLETE\]'
```

## Summary

- **Individual frames**: One line per decoded frame with metadata
- **Complete messages**: Additional line with `[COMPLETE]` marker containing full text
- **Both are printed**: You get both the frame-by-frame view and the complete message
- **Easy to parse**: The `[COMPLETE]` marker makes it simple to identify reconstructed messages
- **Separate lines**: Complete messages don't replace individual frames, they're added as new lines
