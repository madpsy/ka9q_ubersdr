# Frontend Status - Gain and Overload Monitoring

This document explains how to access frontend gain settings and ADC overload counts from radiod in ka9q_ubersdr.

## Overview

The ka9q_ubersdr application now listens to STATUS packets from radiod and extracts frontend parameters including:

- **LNA Gain** - Low Noise Amplifier gain in dB
- **Mixer Gain** - Mixer gain in dB  
- **IF Gain** - Intermediate Frequency gain in dB
- **RF Gain** - RF gain (float value)
- **RF Attenuation** - RF attenuation (float value)
- **RF AGC** - RF Automatic Gain Control on/off status
- **IF Power** - IF power level in dBFS (decibels relative to full scale)
- **AD Overranges** - Count of A/D converter overload events
- **Samples Since Overrange** - Number of samples since last overload

## Implementation Details

### Files Created/Modified

1. **`radiod_status.go`** (new) - Contains:
   - `FrontendStatus` struct - Holds all frontend parameters
   - `FrontendStatusTracker` - Manages STATUS packet reception and parsing
   - TLV decoding functions - Decode radiod's Type-Length-Value encoded data
   - STATUS packet listener - Goroutine that receives multicast STATUS packets

2. **`radiod.go`** (modified) - Updated to:
   - Include `FrontendStatusTracker` in `RadiodController`
   - Start STATUS listener on initialization
   - Provide getter methods to access frontend status
   - Clean up STATUS listener on close

### Tag Numbers

The following tag numbers from ka9q-radio's `status.h` are used:

```go
const (
    tagLNAGain          = 30  // LNA_GAIN
    tagMixerGain        = 31  // MIXER_GAIN
    tagIFGain           = 32  // IF_GAIN
    tagIFPower          = 47  // IF_POWER
    tagRFAtten          = 96  // RF_ATTEN
    tagRFGain           = 97  // RF_GAIN
    tagRFAGC            = 98  // RF_AGC
    tagADOver           = 103 // AD_OVER
    tagSamplesSinceOver = 107 // SAMPLES_SINCE_OVER
)
```

## Usage

### Getting Frontend Status for a Specific SSRC

```go
// Get the radiod controller instance (already available in main.go)
// radiod *RadiodController

// Get frontend status for a specific channel SSRC
ssrc := uint32(0x12345678) // Your channel's SSRC
status := radiod.GetFrontendStatus(ssrc)

if status != nil {
    log.Printf("Frontend Status for SSRC 0x%08x:", status.SSRC)
    log.Printf("  LNA Gain: %d dB", status.LNAGain)
    log.Printf("  Mixer Gain: %d dB", status.MixerGain)
    log.Printf("  IF Gain: %d dB", status.IFGain)
    log.Printf("  RF Gain: %.1f", status.RFGain)
    log.Printf("  RF Attenuation: %.1f", status.RFAtten)
    log.Printf("  RF AGC: %d", status.RFAGC)
    log.Printf("  IF Power: %.1f dBFS", status.IFPower)
    log.Printf("  AD Overranges: %d", status.ADOverranges)
    log.Printf("  Samples Since Overrange: %d", status.SamplesSinceOver)
    log.Printf("  Last Update: %s", status.LastUpdate)
} else {
    log.Printf("No frontend status available for SSRC 0x%08x", ssrc)
}
```

### Getting All Frontend Status Entries

```go
// Get all frontend status entries (map of SSRC -> FrontendStatus)
allStatus := radiod.GetAllFrontendStatus()

for ssrc, status := range allStatus {
    log.Printf("SSRC 0x%08x: LNA=%d dB, Mixer=%d dB, IF=%d dB, Overranges=%d",
        ssrc, status.LNAGain, status.MixerGain, status.IFGain, status.ADOverranges)
}
```

### Accessing from Session Manager

Since `SessionManager` has access to the `RadiodController`, you can add methods to access frontend status:

```go
// In session.go, add a method to SessionManager:
func (sm *SessionManager) GetSessionFrontendStatus(sessionID string) *FrontendStatus {
    sm.mu.RLock()
    session, exists := sm.sessions[sessionID]
    sm.mu.RUnlock()
    
    if !exists {
        return nil
    }
    
    return sm.radiod.GetFrontendStatus(session.SSRC)
}
```

## Monitoring Overloads

The `ADOverranges` field is particularly useful for detecting when the ADC is being overdriven:

```go
status := radiod.GetFrontendStatus(ssrc)
if status != nil && status.ADOverranges > 0 {
    log.Printf("WARNING: ADC overload detected! Count: %d, Last: %s ago",
        status.ADOverranges,
        time.Since(status.LastUpdate))
    
    // Check if overload is recent
    if status.SamplesSinceOver < 1000000 { // Less than ~1 second at typical rates
        log.Printf("ALERT: Recent ADC overload! Samples since: %d", status.SamplesSinceOver)
    }
}
```

## Debug Mode

Enable debug mode to see STATUS packet parsing in action:

```go
// In main.go or config
DebugMode = true
```

This will log every STATUS packet received:

```
Updated frontend status for SSRC 0x12345678: LNA=20 dB, Mixer=10 dB, IF=15 dB, RF=30.0, Atten=0.0, IFPower=-20.5 dBFS, Overranges=0
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ka9q_ubersdr                           │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           RadiodController                           │  │
│  │                                                      │  │
│  │  ┌────────────────────────────────────────────────┐ │  │
│  │  │      FrontendStatusTracker                     │ │  │
│  │  │                                                │ │  │
│  │  │  • Listens to STATUS multicast group          │ │  │
│  │  │  • Parses TLV-encoded STATUS packets          │ │  │
│  │  │  • Stores FrontendStatus per SSRC             │ │  │
│  │  │  • Thread-safe access via RWMutex             │ │  │
│  │  └────────────────────────────────────────────────┘ │  │
│  │                                                      │  │
│  │  GetFrontendStatus(ssrc) → *FrontendStatus          │  │
│  │  GetAllFrontendStatus() → map[uint32]*FrontendStatus│  │
│  └──────────────────────────────────────────────────────┘  │
│                          ▲                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           │ STATUS packets (multicast UDP)
                           │
                    ┌──────┴──────┐
                    │   radiod    │
                    │ (ka9q-radio)│
                    └─────────────┘
```

## Notes

- STATUS packets are received automatically once the `RadiodController` is initialized
- Frontend status is updated in real-time as STATUS packets arrive from radiod
- Each SSRC (channel) has its own `FrontendStatus` entry
- The `LastUpdate` timestamp indicates when the status was last received
- If no STATUS packets are received, `GetFrontendStatus()` will return `nil`
- The STATUS listener runs in a separate goroutine and is automatically cleaned up on shutdown

## Future Enhancements

Potential additions for WebSocket/API integration:

1. Add frontend status to WebSocket status updates
2. Create REST API endpoint: `/api/frontend/status/:ssrc`
3. Add frontend status to session info in UI
4. Create overload alerts/notifications
5. Add historical tracking of overload events
6. Display gain settings in the UI for monitoring
