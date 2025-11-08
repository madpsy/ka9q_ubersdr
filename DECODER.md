# Multi-Decoder Implementation

## Overview

The multi-decoder system enables UberSDR to simultaneously decode digital modes (FT8, FT4, WSPR) across multiple bands. It integrates with the existing UberSDR architecture, leveraging session management, audio routing, and radiod communication infrastructure.

## Architecture

### Design Philosophy

The implementation follows the same pattern as UberSDR's NoiseFloorMonitor:
- Creates dedicated audio sessions per band
- Each session has a unique SSRC for RTP routing
- Leverages existing SessionManager for channel lifecycle
- Uses existing audio routing via Session.AudioChan

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                      MultiDecoder                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  DecoderBand (per frequency)                           │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  DecoderSession (per cycle)                      │ │ │
│  │  │  - WAVWriter (records audio)                     │ │ │
│  │  │  - Cycle timing state machine                    │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  │  - Audio channel (from SessionManager)               │ │
│  │  - DecoderSpawner (runs external decoders)           │ │
│  └────────────────────────────────────────────────────────┘ │
│  - DecoderParser (parses decoder output)                   │
│  - DecoderStats (tracks performance)                       │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
   SessionManager                      RadiodController
   (audio routing)                     (channel setup)
```

### File Structure

- **decoder_config.go** - Configuration structures and mode definitions
- **decoder_types.go** - Core types (DecodeInfo, DecoderBand, DecoderSession, DecoderStats)
- **decoder_wav.go** - WAV file writer with proper header management
- **decoder_parser.go** - Parser for FT8/FT4/WSPR decoder output
- **decoder_spawner.go** - External decoder process spawner
- **decoder.go** - Main MultiDecoder manager with cycle-based state machine

## Installation

### Prerequisites

The decoder requires external binaries for decoding:

1. **WSJT-X** (for FT8/FT4):
   ```bash
   # Debian/Ubuntu
   sudo apt-get install wsjtx
   
   # Arch Linux
   sudo pacman -S wsjtx
   
   # From source
   git clone https://git.code.sf.net/p/wsjt/wsjtx
   cd wsjtx
   mkdir build && cd build
   cmake ..
   make
   sudo make install
   ```

2. **wsprd** (for WSPR):
   ```bash
   # Usually included with WSJT-X
   # Or build from ka9q-radio:
   git clone https://github.com/ka9q/ka9q-radio
   cd ka9q-radio
   make wsprd
   sudo cp wsprd /usr/local/bin/
   ```

### Verify Installation

```bash
# Check for required binaries
which jt9    # Should return path to jt9
which wsprd  # Should return path to wsprd

# Test decoders
jt9 --help
wsprd --help
```

## Configuration

### Basic Setup

1. Copy the example configuration:
   ```bash
   cp decoder.yaml.example decoder.yaml
   ```

2. Edit `decoder.yaml` with your station details:
   ```yaml
   decoder:
     enabled: true
     receiver_callsign: "YOUR_CALL"
     receiver_locator: "YOUR_GRID"
     receiver_antenna: "Your Antenna"
     
     bands:
       - name: "20m-ft8"
         mode: "FT8"
         frequency: 14074000
         enabled: true
   ```

3. Include decoder config in main config:
   ```yaml
   # In config.yaml
   decoder: !include decoder.yaml
   ```

### Configuration Options

#### Global Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | bool | false | Enable/disable decoder |
| `data_dir` | string | "decoder_data" | Directory for WAV files and logs (absolute or relative) |
| `jt9_path` | string | "/usr/local/bin/jt9" | Full path to jt9 binary (for FT8/FT4) |
| `wsprd_path` | string | "/usr/local/bin/wsprd" | Full path to wsprd binary (for WSPR) |
| `keep_wav` | bool | false | Keep WAV files after decoding |
| `keep_logs` | bool | false | Keep decoder log files |
| `include_dead_time` | bool | false | Record full cycle vs transmission only |
| `receiver_callsign` | string | required | Your callsign |
| `receiver_locator` | string | required | Your grid locator |
| `receiver_antenna` | string | optional | Antenna description |
| `program_name` | string | "UberSDR" | Program name for reporting |
| `program_version` | string | auto | Version for reporting |
| `pskreporter_enabled` | bool | false | Enable PSKReporter uploads |
| `wsprnet_enabled` | bool | false | Enable WSPRNet uploads |

#### Band Configuration

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | string | yes | Unique band identifier |
| `mode` | string | yes | "FT8", "FT4", or "WSPR" |
| `frequency` | int | yes | Center frequency in Hz |
| `enabled` | bool | yes | Enable this band |

### Mode-Specific Frequencies

#### FT8 Standard Frequencies
- 160m: 1840000 Hz
- 80m: 3573000 Hz
- 60m: 5357000 Hz
- 40m: 7074000 Hz
- 30m: 10136000 Hz
- 20m: 14074000 Hz
- 17m: 18100000 Hz
- 15m: 21074000 Hz
- 12m: 24915000 Hz
- 10m: 28074000 Hz
- 6m: 50313000 Hz

#### FT4 Standard Frequencies
- 80m: 3575000 Hz
- 40m: 7047500 Hz
- 30m: 10140000 Hz
- 20m: 14080000 Hz
- 17m: 18104000 Hz
- 15m: 21140000 Hz
- 12m: 24919000 Hz
- 10m: 28180000 Hz
- 6m: 50318000 Hz

#### WSPR Standard Frequencies
- 160m: 1836600 Hz
- 80m: 3568600 Hz
- 60m: 5287200 Hz
- 40m: 7038600 Hz
- 30m: 10138700 Hz
- 20m: 14095600 Hz
- 17m: 18104600 Hz
- 15m: 21094600 Hz
- 12m: 24924600 Hz
- 10m: 28124600 Hz
- 6m: 50293000 Hz

## Operation

### Startup

When enabled, the decoder:
1. Creates data directory if needed
2. Validates configuration
3. Creates audio session for each enabled band
4. Starts monitoring loops for each band
5. Begins cycle-based recording and decoding

### Cycle-Based State Machine

Each mode operates on a fixed cycle:

```
FT8:  15 second cycle
      - 0-12.64s: Transmission (record)
      - 12.64-15s: Dead time (optional record)
      
FT4:  7.5 second cycle
      - 0-4.48s: Transmission (record)
      - 4.48-7.5s: Dead time (optional record)
      
WSPR: 120 second cycle
      - 0-114s: Transmission (record)
      - 114-120s: Dead time (optional record)
```

State transitions:
1. **No file + in recording window** → Create new WAV file
2. **Have file + cycle boundary** → Close file, queue for decode
3. **Have file + past recording time** → Close file, queue for decode
4. **No file + past recording window** → Wait for next cycle

### File Organization

```
decoder_data/
├── 14074000/              # Frequency directory
│   ├── 250108_120000.wav  # Timestamped WAV files
│   ├── 250108_120015.wav
│   └── ...
├── 7074000/
│   └── ...
├── FT8_14074000.log       # Decoded spots log
├── FT4_7047500.log
└── WSPR_7038600.log
```

### Logging

Decoded spots are logged in CSV format:

**FT8/FT4 Format:**
```
timestamp,cycle,snr,dt,freq,message,callsign,locator
2025-01-08T12:00:15Z,120000,-5,0.2,1234,CQ MM3NDH IO86,MM3NDH,IO86ha
```

**WSPR Format:**
```
timestamp,cycle,snr,dt,freq,drift,callsign,locator,power
2025-01-08T12:02:00Z,120000,-12,0.1,7038650,-1,MM3NDH,IO86,23
```

### Decoder Process Management

The spawner uses Go's `exec.Command` with goroutines:

1. Parent closes WAV file
2. Spawns decoder in goroutine
3. Parent continues receiving audio
4. Decoder completes asynchronously
5. Parser extracts spots from output
6. Deduplication keeps strongest SNR per callsign
7. Results logged and optionally reported

### Deduplication

Within each cycle, if multiple decodes of the same callsign occur:
- Keep the decode with highest SNR
- Discard duplicates
- Log unique callsigns only

## Monitoring

### Statistics

The decoder tracks:
- Total cycles processed
- Total decodes found
- Unique spots (after deduplication)
- Errors encountered
- Per-band statistics

### Logs

Check logs for decoder activity:
```bash
# View decoded spots
tail -f decoder_data/FT8_14074000.log

# Check for errors in main log
grep -i decoder ubersdr.log
```

### Debugging

Enable debug options:
```yaml
decoder:
  keep_wav: true   # Keep WAV files for inspection
  keep_logs: true  # Keep decoder output logs
```

Inspect files:
```bash
# Check WAV file
file decoder_data/14074000/250108_120000.wav
ffprobe decoder_data/14074000/250108_120000.wav

# Check decoder output
cat decoder_data/14074000/250108_120000.log
```

## Integration with UberSDR

### Session Management

Each decoder band creates a session via SessionManager:
- Unique SSRC allocated
- Audio channel created
- Radiod channel configured with USB preset
- 12 kHz sample rate (optimal for digital modes)

### Audio Routing

Audio flows through existing infrastructure:
```
radiod → RTP packets → SessionManager → AudioChan → Decoder
```

### Resource Usage

Per enabled band:
- 1 audio session
- 1 goroutine for monitoring
- ~12 kHz bandwidth
- Minimal CPU (recording only)
- Decoder CPU burst during decode phase

## Reporting (Future Enhancement)

### PSKReporter

When `pskreporter_enabled: true`:
- Spots uploaded to PSKReporter.info
- Requires valid callsign and locator
- Uploads after each decode cycle
- Includes SNR, frequency, mode

### WSPRNet

When `wsprnet_enabled: true`:
- WSPR spots uploaded to WSPRNet.org
- Requires valid callsign and locator
- Uploads after each WSPR cycle
- Includes all WSPR-specific fields

## Troubleshooting

### Decoder Not Starting

Check:
1. `enabled: true` in config
2. At least one band enabled
3. Valid callsign and locator
4. Decoder binaries installed

### No Decodes

Check:
1. Correct frequency for mode
2. Radiod channel active
3. Audio data flowing (check logs)
4. WAV files being created
5. Decoder binary working: `jt9 --help`

### WAV File Issues

Check:
1. Data directory writable
2. Sufficient disk space
3. WAV header correct: `file *.wav`
4. Audio format: 16-bit PCM, 12000 Hz, mono

### Decoder Errors

Check:
1. Decoder binary in PATH
2. Working directory permissions
3. Decoder output logs (if `keep_logs: true`)
4. System resources (CPU, memory)

## Performance Considerations

### CPU Usage

- Recording: Minimal (memory copy only)
- Decoding: Burst during decode phase
  - FT8: ~1-2s CPU per 15s cycle
  - FT4: ~0.5-1s CPU per 7.5s cycle
  - WSPR: ~5-10s CPU per 120s cycle

### Memory Usage

- Per band: ~1-2 MB for audio buffer
- WAV files: ~1.5 MB per FT8 cycle (if kept)
- Minimal overhead for state tracking

### Disk Usage

With `keep_wav: false` (default):
- Only log files grow
- ~1 KB per decode
- Rotate logs periodically

With `keep_wav: true`:
- ~1.5 MB per FT8 cycle
- ~750 KB per FT4 cycle
- ~14 MB per WSPR cycle
- Clean up old files regularly

### Network Usage

- Audio: ~192 kbps per band (12 kHz * 16-bit)
- Reporting: Minimal (few KB per cycle)

## Comparison with ka9q_multidecoder

### Similarities

- Cycle-based recording
- External decoder spawning
- WAV file format
- Spot parsing and deduplication
- Multi-band support

### Differences

| Feature | ka9q_multidecoder | UberSDR Decoder |
|---------|-------------------|-----------------|
| Language | C | Go |
| Session Management | Manual | SessionManager |
| Audio Routing | Manual RTP | Existing infrastructure |
| Configuration | Command-line | YAML |
| Process Model | Double-fork | Goroutines |
| Integration | Standalone | Integrated |

### Advantages

1. **Leverages existing infrastructure** - No duplicate session/audio code
2. **Simpler configuration** - YAML vs command-line arguments
3. **Better integration** - Shares radiod connection, logging, etc.
4. **Modern concurrency** - Go goroutines vs fork/exec
5. **Easier maintenance** - Single codebase, consistent patterns

## Future Enhancements

### Planned Features

1. **PSKReporter Integration**
   - Upload spots to PSKReporter.info
   - Configurable upload interval
   - Error handling and retry logic

2. **WSPRNet Integration**
   - Upload WSPR spots to WSPRNet.org
   - Proper authentication
   - Spot validation

3. **Web UI**
   - Real-time spot display
   - Band activity visualization
   - Configuration interface
   - Statistics dashboard

4. **Advanced Features**
   - Automatic band switching based on conditions
   - Spot filtering and alerting
   - Historical spot database
   - Export to ADIF format

### Contributing

To add new modes or features:

1. Update `DecoderMode` enum in `decoder_config.go`
2. Add mode info to `modeInfoMap`
3. Update parser in `decoder_parser.go`
4. Add decoder command to spawner
5. Update documentation

## License

Same as UberSDR main project.

## Credits

Based on concepts from:
- ka9q_multidecoder by Phil Karn (KA9Q)
- WSJT-X by Joe Taylor (K1JT) and others
- WSPR by Joe Taylor (K1JT)

## Support

For issues or questions:
1. Check this documentation
2. Review example configuration
3. Check logs for errors
4. Open GitHub issue with details