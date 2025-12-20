# TCI Server Implementation for Go Client

## Overview

This document describes the TCI (Transceiver Control Interface) server implementation for the UberSDR Go client. The TCI protocol is used by applications like JTDX, WSJT-X, and CW Skimmer to control SDR radios and receive audio/IQ data streams.

## Architecture

The TCI server implementation consists of:

1. **`tci_server.go`** - Core TCI protocol server
2. **Integration in `radio_client.go`** - Audio/IQ streaming to TCI clients
3. **Mode handling** - Special logic for audio vs IQ modes

## Key Features

### Protocol Support

- **WebSocket-based communication** - TCI uses WebSocket for both control and data
- **Command/response protocol** - Text-based commands with semicolon delimiters
- **Binary data streaming** - Audio and IQ data sent as binary frames
- **Multi-receiver support** - Supports up to 2 receivers (RX0, RX1)

### Supported Commands

- `device` - Query device name
- `protocol` - Query protocol version
- `vfo` - Set/query VFO frequency
- `dds` - Set/query receiver center frequency
- `modulation` - Set/query modulation mode
- `iq_samplerate` - Set/query IQ sample rate
- `iq_start/iq_stop` - Start/stop IQ streaming
- `audio_start/audio_stop` - Start/stop audio streaming
- `rx_smeter` - Query signal level (S-meter)
- And many more...

## Audio vs IQ Mode Handling

### Critical Differences

The TCI implementation handles **audio modes** and **IQ modes** very differently, which is crucial for proper operation:

#### Audio Modes (USB, LSB, CW, AM, FM, etc.)

**Characteristics:**
- Demodulated audio output
- Typically mono (1 channel)
- Sample rate: Usually 12 kHz or 48 kHz
- Data format: PCM int16 → converted to float32 stereo for TCI

**TCI Streaming:**
```go
// Audio mode: Send as audio stream (type 1)
// TCI expects float32 stereo audio at 48 kHz
if !isIQMode {
    // Convert PCM int16 to float32
    audioFloat32 := ConvertPCMToFloat32(pcmData, c.channels)
    
    // Convert mono to stereo if needed
    if c.channels == 1 {
        // Duplicate mono channel to both L and R
        stereoData := make([]byte, numSamples*2*4)
        for i := 0; i < numSamples; i++ {
            copy(stereoData[i*8:i*8+4], audioFloat32[i*4:i*4+4])
            copy(stereoData[i*8+4:i*8+8], audioFloat32[i*4:i*4+4])
        }
        audioFloat32 = stereoData
    }
    
    // Send to TCI server
    c.tciServer.SendAudioData(0, audioFloat32, c.sampleRate)
}
```

**Frame Format:**
```
Header (64 bytes):
  - receiver (uint32)
  - sampleRate (uint32)
  - format (uint32) = 3 (float32)
  - codec (uint32) = 0
  - crc (uint32) = 0
  - length (uint32) = total number of floats
  - type (uint32) = 1 (RxAudioStream)
  - reserved[9] (uint32)
Data: float32 samples (interleaved L,R,L,R,...)
```

#### IQ Modes (IQ48, IQ96, IQ192, IQ384)

**Characteristics:**
- Raw I/Q (In-phase/Quadrature) data
- Always stereo (2 channels: I and Q)
- Sample rate: 48, 96, 192, or 384 kHz
- Data format: PCM int16 → converted to float32 for TCI
- **No demodulation** - raw baseband data

**TCI Streaming:**
```go
// IQ mode: Send as IQ stream (type 0)
if isIQMode {
    // Convert PCM int16 to float32 for TCI
    iqFloat32 := ConvertPCMToFloat32(pcmData, c.channels)
    
    // IQ data is already interleaved (I,Q,I,Q,...)
    // Send to TCI server as IQ stream
    c.tciServer.SendIQData(0, iqFloat32, c.sampleRate)
}
```

**Frame Format:**
```
Header (64 bytes):
  - receiver (uint32)
  - sampleRate (uint32)
  - format (uint32) = 3 (float32)
  - codec (uint32) = 0
  - crc (uint32) = 0
  - length (uint32) = total number of floats
  - type (uint32) = 0 (IQ_STREAM)
  - channels (uint32) = 2 (I and Q)
  - reserved[8] (uint32)
Data: float32 samples (interleaved I,Q,I,Q,...)
```

### Mode Switching Behavior

The TCI server implements intelligent mode switching:

1. **Modulation Command Alone** - Does NOT change radio mode
   - Only updates TCI state
   - Saves the desired mode for later use
   - Prevents unwanted mode changes during setup

2. **Audio Streaming Start** - Switches from IQ to audio mode
   ```go
   if s.currentIQMode != "" {
       // Restore previous audio mode
       restoreMode := s.previousMode
       if restoreMode == "" {
           restoreMode = "usb"
       }
       s.debouncedModeChange(restoreMode, false)
   }
   ```

3. **IQ Streaming Start** - Switches from audio to IQ mode
   ```go
   if s.currentIQMode == "" {
       // Determine IQ mode from sample rate
       iqMode := rateToMode[s.iqSampleRate]
       s.debouncedModeChange(iqMode, true)
   }
   ```

4. **Mode Change Debouncing** - Prevents rate limit errors
   - 600ms cooldown between mode changes
   - Accounts for server's 500ms rate limit
   - Queues mode changes if needed

### Sample Rate Handling

**Audio Modes:**
- Server determines sample rate (typically 12 kHz)
- TCI expects 48 kHz (resampling may be needed)
- Mono audio is converted to stereo

**IQ Modes:**
- Sample rate MUST match mode name:
  - `iq48` = 48,000 Hz
  - `iq96` = 96,000 Hz
  - `iq192` = 192,000 Hz
  - `iq384` = 384,000 Hz
- No resampling allowed (would corrupt IQ data)
- Client can request specific rate via `iq_samplerate` command

## Integration Points

### Radio Client Integration

The radio client integrates TCI in the `OutputAudio` function:

```go
func (c *RadioClient) OutputAudio(pcmData []byte) error {
    // Send audio/IQ to TCI server if enabled (BEFORE any processing)
    if c.tciServer != nil {
        isIQMode := strings.HasPrefix(c.mode, "iq")
        
        if isIQMode {
            // Send as IQ stream
            iqFloat32 := ConvertPCMToFloat32(pcmData, c.channels)
            c.tciServer.SendIQData(0, iqFloat32, c.sampleRate)
        } else {
            // Send as audio stream
            audioFloat32 := ConvertPCMToFloat32(pcmData, c.channels)
            // Convert mono to stereo if needed
            c.tciServer.SendAudioData(0, audioFloat32, c.sampleRate)
        }
    }
    
    // Continue with other outputs (PortAudio, FIFO, UDP, etc.)
    // ...
}
```

### GUI Callbacks

The TCI server can call back to the GUI for frequency/mode changes:

```go
tciServer := NewTCIServer(radioClient, port, host, func(paramType string, value interface{}) {
    switch paramType {
    case "frequency":
        // Update GUI frequency
        freq := value.(int)
        // ... update frequency display
    case "mode":
        // Update GUI mode
        mode := value.(string)
        // ... update mode selector
    }
})
```

## Usage Example

```go
// Create radio client
client := NewRadioClient(...)

// Create TCI server with GUI callback
tciServer := NewTCIServer(client, 40001, "0.0.0.0", guiCallback)

// Attach TCI server to client
client.tciServer = tciServer

// Start TCI server
if err := tciServer.Start(); err != nil {
    log.Fatalf("Failed to start TCI server: %v", err)
}

// TCI clients can now connect to ws://localhost:40001
```

## Client Configuration

TCI clients (like JTDX) should be configured as:
- **Radio**: TCI
- **Server**: 127.0.0.1 (or server IP)
- **Port**: 40001 (default)

## Important Notes

1. **Only one TCI client at a time** - The server rejects additional connections
2. **Receive-only** - TX commands are acknowledged but not executed
3. **Mode tracking** - Server tracks current IQ mode vs audio mode
4. **Frequency sync** - VFO changes are bidirectional (TCI ↔ SDR)
5. **Signal level** - S-meter updates sent periodically

## Comparison with Python Implementation

The Go implementation closely follows the Python `tci_server.py` design:

- Same protocol commands and responses
- Same audio/IQ frame formats
- Same mode switching logic
- Same debouncing mechanism
- Similar callback architecture

Key differences:
- Go uses goroutines instead of asyncio
- Go uses channels for thread-safe communication
- Go has stronger type safety
- Go compiles to native binary (better performance)

## Future Enhancements

- [ ] Audio resampling for 48 kHz TCI requirement
- [ ] Spot injection support (SPOT command)
- [ ] Multiple receiver support (RX1)
- [ ] TX audio support (for future TX capability)
- [ ] Spectrum data streaming
- [ ] Configuration persistence

## References

- TCI Protocol Specification: Expert Electronics documentation
- JTDX TCITransceiver.hpp: Reference implementation
- Python tci_server.py: Original UberSDR implementation