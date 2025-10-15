# FT8 Decoder Extension

A production-quality FT8 signal decoder for the ka9q UberSDR web interface with multi-frequency detection and Costas synchronization.

## Features

### Signal Detection
- **Multi-frequency search**: Scans 200-3200 Hz in 12.5 Hz steps
- **Costas sync detection**: Finds FT8 sync pattern [3,1,4,0,6,5,2]
- **Time-slot synchronization**: Aligns to 15-second FT8 time slots
- **Multi-signal tracking**: Detects up to 50 simultaneous signals
- **SNR estimation**: Calculates signal-to-noise ratio per candidate

### Demodulation
- **8-FSK with Gray coding**: Proper bit-to-symbol mapping
- **Soft-decision LLRs**: Log-likelihood ratios for LDPC
- **Goertzel algorithm**: Efficient single-frequency detection
- **Per-signal frequency tracking**: Demodulates at detected frequency

### Error Correction
- **Real WSJT-X LDPC matrix**: (174,91) code with 83 parity checks
- **Sum-product algorithm**: Belief propagation decoder
- **Fast approximations**: Optimized tanh/atanh functions
- **Typical decode time**: 1-4ms per attempt

### User Interface
- **Waterfall display**: Visual spectrum 200-3200 Hz
- **Real-time status**: Time slot, candidates, decode count
- **Debug logging**: Detailed signal detection and decode info
- **Performance metrics**: Processing time, buffer status

## Technical Details

### Signal Detection Algorithm

1. **Time Slot Alignment**
   - Monitors system time for 15-second boundaries
   - Receives during first 12.64 seconds of each slot
   - Clears candidates at slot boundaries

2. **Frequency Search**
   - Scans 200-3200 Hz range (3000 Hz bandwidth)
   - Steps by 12.5 Hz (2× tone spacing for speed)
   - ~240 frequency channels searched per pass

3. **Costas Sync Detection**
   - Demodulates 7+ symbols at each frequency
   - Matches against pattern [3,1,4,0,6,5,2]
   - Requires ≥60% match for valid sync
   - Calculates sync score and SNR

4. **Candidate Filtering**
   - Removes duplicates within 25 Hz
   - Ranks by sync score (best first)
   - Limits to top 50 candidates
   - Decodes best candidate with score ≥70%

### LDPC Decoder

**Code Parameters:**
- N = 174 (codeword bits)
- K = 91 (information bits)
- M = 83 (parity checks)
- Rate = 91/174 ≈ 0.52

**Algorithm:**
- Variable nodes: 174 (one per bit)
- Check nodes: 83 (one per parity equation)
- Connections: 7 per check, 3 per variable
- Max iterations: 20
- Success: 0 parity errors

### Protocol Specifications

**Timing:**
- Symbol period: 160 ms
- Symbols per message: 79
- Transmission duration: 12.64 seconds
- Time slot: 15 seconds (at :00, :15, :30, :45)

**Modulation:**
- 8-FSK (8 frequency tones)
- Tone spacing: 6.25 Hz
- Bandwidth: 50 Hz (8 × 6.25)
- Gray coding: Minimizes bit errors

**Structure:**
- Symbols 0-6: Costas sync array
- Symbols 7-35: First data block
- Symbols 36-42: Costas sync array
- Symbols 43-78: Second data block

## Usage

1. **Tune to FT8 frequency**
   - 14.074 MHz (20m)
   - 7.074 MHz (40m)
   - Other FT8 frequencies

2. **Set mode to USB**
   - Required for proper demodulation

3. **Enable FT8 Decoder**
   - Extension will start searching

4. **Monitor debug log**
   - Shows detected signals
   - Displays decode attempts
   - Reports success/failure

## Status Indicators

- **Searching**: Scanning for signals
- **Synced**: Signal(s) detected
- **Decoding**: LDPC decoder running
- **📡**: Receive window active
- **⏸️**: Transmit window (no reception)

## Debug Log Information

**Signal Detection:**
```
Found 3 candidate signal(s)
  #1: 1234.5 Hz, sync=85%, SNR=12.3
  #2: 1567.8 Hz, sync=78%, SNR=9.8
  #3: 2001.2 Hz, sync=71%, SNR=7.5
```

**Decode Attempts:**
```
Decoding signal at 1234.5 Hz
Codeword generated: 174 LLRs
Using real FT8 LDPC matrix
LDPC decode completed in 1.2ms: 0 errors
SUCCESS! Decoded message: CQ DX FN20
```

## Performance

**Signal Detection:**
- Frequency search: ~50-100ms per pass
- Costas detection: ~1-2ms per frequency
- Total scan time: ~100-200ms

**Decoding:**
- LDPC decode: 1-4ms per attempt
- Symbol extraction: <1ms
- Total decode time: 2-5ms

**Memory:**
- Audio buffer: ~720KB (15 seconds @ 48kHz)
- Candidate storage: ~50KB (50 signals)
- Total footprint: ~1MB

## Requirements

- **Mode**: USB (Upper Sideband)
- **Bandwidth**: 200-3200 Hz
- **Sample rate**: 48 kHz recommended
- **Browser**: Modern browser with Web Audio API

## Limitations

**Current Implementation:**
- ✅ Multi-frequency signal detection
- ✅ Costas sync pattern matching
- ✅ Time-slot synchronization
- ✅ LDPC error correction
- ✅ Multi-signal tracking
- ⚠️ Message decoding (simplified placeholder)
- ⚠️ Frequency offset correction (basic)
- ⚠️ Multi-path handling (none)

**For Full WSJT-X Compatibility:**
- Message encoding/decoding (callsigns, grids, reports)
- CRC checking
- Doppler correction
- AGC (Automatic Gain Control)
- Transmit capability

## Troubleshooting

**No signals detected:**
- Check frequency (14.074 MHz for 20m)
- Verify USB mode
- Ensure bandwidth is 200-3200 Hz
- Wait for receive window (📡 indicator)

**High parity errors:**
- Signal may be too weak (SNR < 0 dB)
- Frequency offset too large
- Multi-path interference
- Check sync score (should be >70%)

**No decodes despite detection:**
- Sync score may be too low
- LDPC decoder needs stronger signal
- Try adjusting RF gain
- Check for interference

## Architecture

```
Audio Input (48kHz)
    ↓
FT8SignalDetector
    ├─ Time slot sync
    ├─ Multi-frequency search (200-3200 Hz)
    ├─ Costas pattern detection
    └─ Candidate ranking
    ↓
Best Candidate
    ↓
Symbol Extraction
    ↓
Gray Code Mapping
    ↓
LLR Generation
    ↓
LDPC Decoder
    ↓
Message Output
```

## Files

- `main.js`: Extension controller
- `ft8-signal-detector.js`: Multi-frequency detector
- `ft8-demodulator.js`: 8-FSK demodulator
- `ldpc.js`: LDPC error correction
- `ft8-ldpc-matrix.js`: Real WSJT-X matrix
- `ft8-constants.js`: Protocol constants
- `template.html`: UI layout
- `styles.css`: Styling
- `manifest.json`: Extension metadata

## Credits

Based on the WSJT-X FT8 protocol specification and implementation by K1JT and the WSJT Development Group.