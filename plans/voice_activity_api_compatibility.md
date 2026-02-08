# Voice Activity API Compatibility

## Requirement

The enhanced voice activity detection must maintain **100% backward compatibility** with the existing API response format so that the frontend doesn't need any changes.

## Current API Response Format

From [`voice_activity.go`](../voice_activity.go) lines 27-37:

```go
type VoiceActivityResponse struct {
    Band           string           `json:"band"`
    Timestamp      string           `json:"timestamp"`
    NoiseFloorDB   float32          `json:"noise_floor_db"`
    ThresholdDB    float32          `json:"threshold_db"`
    MinBandwidth   uint64           `json:"min_bandwidth"`
    MaxBandwidth   uint64           `json:"max_bandwidth"`
    Activities     []VoiceActivity  `json:"activities"`
    TotalActivities int             `json:"total_activities"`
}
```

Current VoiceActivity structure (lines 14-25):

```go
type VoiceActivity struct {
    StartFreq          uint64  `json:"start_freq"`
    EndFreq            uint64  `json:"end_freq"`
    Bandwidth          uint64  `json:"bandwidth"`
    AvgSignalDB        float32 `json:"avg_signal_db"`
    SignalAboveNoise   float32 `json:"signal_above_noise"`
    EstimatedDialFreq  uint64  `json:"estimated_dial_freq"`
    Mode               string  `json:"mode"`
    PeakSignalDB       float32 `json:"peak_signal_db"`
    StartBin           int     `json:"start_bin"`
    EndBin             int     `json:"end_bin"`
}
```

## Compatibility Strategy

### Option 1: Keep Existing Structure, Add Optional Fields (RECOMMENDED)

Extend the VoiceActivity struct with **optional** new fields that won't break existing clients:

```go
type VoiceActivity struct {
    // EXISTING FIELDS - MUST REMAIN UNCHANGED
    StartFreq          uint64  `json:"start_freq"`
    EndFreq            uint64  `json:"end_freq"`
    Bandwidth          uint64  `json:"bandwidth"`
    AvgSignalDB        float32 `json:"avg_signal_db"`
    SignalAboveNoise   float32 `json:"signal_above_noise"`
    EstimatedDialFreq  uint64  `json:"estimated_dial_freq"`
    Mode               string  `json:"mode"`
    PeakSignalDB       float32 `json:"peak_signal_db"`
    StartBin           int     `json:"start_bin"`
    EndBin             int     `json:"end_bin"`
    
    // NEW OPTIONAL FIELDS - Safe to add, won't break existing clients
    CenterFreq         uint64  `json:"center_freq,omitempty"`         // Weighted centroid
    SNR                float32 `json:"snr,omitempty"`                 // Signal-to-noise ratio
    SpectralShape      string  `json:"spectral_shape,omitempty"`      // "narrow", "voice", "wide"
    PowerStdDev        float32 `json:"power_std_dev,omitempty"`       // Power variation
    Confidence         float32 `json:"confidence,omitempty"`          // Detection confidence 0-1
    DetectionMethod    string  `json:"detection_method,omitempty"`    // "legacy" or "enhanced"
    AlternativeDialFreqs []uint64 `json:"alternative_dial_freqs,omitempty"` // Other possible dial freqs
    FrequencyConfidence float32 `json:"frequency_confidence,omitempty"` // Confidence in dial freq estimate
}
```

**Benefits:**
- Existing clients ignore unknown fields (JSON standard behavior)
- New clients can use enhanced fields
- No breaking changes
- Gradual migration path

### Option 2: Version Parameter

Add a version parameter to the API endpoint:

```
GET /api/voice-activity?band=20m&version=1  // Returns legacy format
GET /api/voice-activity?band=20m&version=2  // Returns enhanced format
GET /api/voice-activity?band=20m            // Returns legacy format (default)
```

**Benefits:**
- Explicit versioning
- Clear separation of old/new formats
- Easy to deprecate old version later

**Drawbacks:**
- More complex to maintain
- Requires frontend changes to use new version

## Implementation Plan

### Phase 1: Maintain Exact Compatibility

The enhanced detection algorithm will populate the **exact same fields** as the current implementation:

```go
func detectVoiceActivityEnhanced(fft *BandFFT, params DetectionParams) []VoiceActivity {
    // ... enhanced detection logic ...
    
    // Map enhanced results to legacy format
    activity := VoiceActivity{
        // REQUIRED LEGACY FIELDS - populated exactly as before
        StartFreq:         char.StartFreq,
        EndFreq:           char.EndFreq,
        Bandwidth:         char.Bandwidth,
        AvgSignalDB:       char.AvgPower,
        SignalAboveNoise:  char.SNR,  // Same as SNR
        EstimatedDialFreq: dialFreq,
        Mode:              mode,
        PeakSignalDB:      char.PeakPower,
        StartBin:          char.StartBin,
        EndBin:            char.EndBin,
        
        // OPTIONAL NEW FIELDS - only if client requests them
        CenterFreq:        char.CenterFreq,
        SNR:               char.SNR,
        SpectralShape:     char.SpectralShape,
        PowerStdDev:       char.PowerStdDev,
        Confidence:        confidence,
        DetectionMethod:   "enhanced",
    }
    
    return activities
}
```

### Phase 2: Optional Enhanced Fields

Add query parameter to enable enhanced fields:

```
GET /api/voice-activity?band=20m&enhanced=true&include_extras=true
```

When `include_extras=true`, populate the optional fields. Otherwise, leave them empty (they'll be omitted from JSON with `omitempty` tag).

### Phase 3: Handler Modification

Modify the API handler to support both algorithms while maintaining response format:

```go
func handleVoiceActivity(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, 
                        ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
    // ... existing validation code ...
    
    // Get algorithm selection
    useEnhanced := r.URL.Query().Get("enhanced") == "true"
    includeExtras := r.URL.Query().Get("include_extras") == "true"
    
    // Get FFT data
    var fft *BandFFT
    if useEnhanced {
        fft = buffer.GetAveragedFFT(5 * time.Second)
    } else {
        fft = buffer.GetAveragedFFT(20 * time.Second)
    }
    
    // Detect voice activity
    var activities []VoiceActivity
    if useEnhanced {
        params := DefaultDetectionParams()
        // Parse optional parameters from query string
        activities = detectVoiceActivityEnhanced(fft, params)
        
        // Strip optional fields if not requested
        if !includeExtras {
            activities = stripEnhancedFields(activities)
        }
    } else {
        activities = detectVoiceActivity(fft, thresholdDB, minBandwidth, maxBandwidth)
    }
    
    // Calculate noise floor for response (same as before)
    noiseFloor := calculateNoiseFloor(fft.Data)
    
    // Build response - EXACT SAME FORMAT
    response := VoiceActivityResponse{
        Band:            band,
        Timestamp:       fft.Timestamp.Format("2006-01-02T15:04:05Z07:00"),
        NoiseFloorDB:    noiseFloor,
        ThresholdDB:     thresholdDB,
        MinBandwidth:    minBandwidth,
        MaxBandwidth:    maxBandwidth,
        Activities:      activities,
        TotalActivities: len(activities),
    }
    
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(response)
}

// stripEnhancedFields removes optional fields for backward compatibility
func stripEnhancedFields(activities []VoiceActivity) []VoiceActivity {
    stripped := make([]VoiceActivity, len(activities))
    for i, act := range activities {
        stripped[i] = VoiceActivity{
            // Copy only legacy fields
            StartFreq:        act.StartFreq,
            EndFreq:          act.EndFreq,
            Bandwidth:        act.Bandwidth,
            AvgSignalDB:      act.AvgSignalDB,
            SignalAboveNoise: act.SignalAboveNoise,
            EstimatedDialFreq: act.EstimatedDialFreq,
            Mode:             act.Mode,
            PeakSignalDB:     act.PeakSignalDB,
            StartBin:         act.StartBin,
            EndBin:           act.EndBin,
        }
    }
    return stripped
}
```

## API Endpoint Behavior

### Default Behavior (No Changes Required)

```bash
GET /api/voice-activity?band=20m
```

**Response:** Exact same format as current implementation
```json
{
  "band": "20m",
  "timestamp": "2026-02-08T10:00:00Z",
  "noise_floor_db": -95.5,
  "threshold_db": 8.0,
  "min_bandwidth": 2200,
  "max_bandwidth": 3200,
  "activities": [
    {
      "start_freq": 14200000,
      "end_freq": 14202800,
      "bandwidth": 2800,
      "avg_signal_db": -75.2,
      "signal_above_noise": 20.3,
      "estimated_dial_freq": 14200000,
      "mode": "USB",
      "peak_signal_db": -72.1,
      "start_bin": 571,
      "end_bin": 579
    }
  ],
  "total_activities": 1
}
```

### Enhanced Algorithm (Opt-in)

```bash
GET /api/voice-activity?band=20m&enhanced=true
```

**Response:** Same format, but with improved accuracy in existing fields
- `estimated_dial_freq` will be more accurate (±100 Hz vs ±500 Hz)
- Fewer false positives in `activities` array
- Better `signal_above_noise` calculation

### Enhanced Algorithm with Extra Fields (Opt-in)

```bash
GET /api/voice-activity?band=20m&enhanced=true&include_extras=true
```

**Response:** Same format PLUS optional new fields
```json
{
  "band": "20m",
  "timestamp": "2026-02-08T10:00:00Z",
  "noise_floor_db": -95.5,
  "threshold_db": 12.0,
  "min_bandwidth": 2000,
  "max_bandwidth": 3500,
  "activities": [
    {
      "start_freq": 14200000,
      "end_freq": 14202800,
      "bandwidth": 2800,
      "avg_signal_db": -75.2,
      "signal_above_noise": 20.3,
      "estimated_dial_freq": 14199700,
      "mode": "USB",
      "peak_signal_db": -72.1,
      "start_bin": 571,
      "end_bin": 579,
      "center_freq": 14201400,
      "snr": 20.3,
      "spectral_shape": "voice",
      "power_std_dev": 3.2,
      "confidence": 0.87,
      "detection_method": "enhanced",
      "alternative_dial_freqs": [14199600, 14199700, 14199800],
      "frequency_confidence": 0.92
    }
  ],
  "total_activities": 1
}
```

## Testing Compatibility

### Test 1: Existing Client (No Changes)

```bash
# Current API call
curl "http://localhost:8080/api/voice-activity?band=20m"

# Should return exact same JSON structure
# Frontend should work without any changes
```

### Test 2: Enhanced Algorithm (Drop-in Replacement)

```bash
# Enable enhanced algorithm
curl "http://localhost:8080/api/voice-activity?band=20m&enhanced=true"

# Should return same JSON structure
# But with better accuracy in existing fields
# Frontend should work without any changes
```

### Test 3: Enhanced Fields (Opt-in)

```bash
# Enable enhanced algorithm with extra fields
curl "http://localhost:8080/api/voice-activity?band=20m&enhanced=true&include_extras=true"

# Returns same structure PLUS optional new fields
# Old frontend ignores new fields (JSON standard)
# New frontend can use new fields
```

## Configuration

Add to config.yaml (optional, defaults maintain compatibility):

```yaml
voice_activity:
  # Default algorithm (false = legacy, true = enhanced)
  default_enhanced: false  # Start with legacy for safety
  
  # Allow clients to request enhanced algorithm
  allow_enhanced: true
  
  # Allow clients to request extra fields
  allow_extras: true
  
  # Detection parameters (only used if enhanced=true)
  detection:
    threshold_db: 12.0
    min_bandwidth: 2000
    max_bandwidth: 3500
    min_snr: 10.0
    min_confidence: 0.6
    filter_offset: 350
    rounding_interval: 100
    averaging_window: 5
```

## Migration Path

1. **Phase 1** (Week 1): Deploy enhanced algorithm with `enhanced=false` by default
   - Existing API works exactly as before
   - No frontend changes needed
   - Test enhanced algorithm with `?enhanced=true` parameter

2. **Phase 2** (Week 2-3): Validate enhanced algorithm
   - Monitor accuracy improvements
   - Collect user feedback
   - Tune parameters if needed

3. **Phase 3** (Week 4): Make enhanced algorithm default
   - Change `default_enhanced: true` in config
   - Existing API still returns same JSON format
   - No frontend changes needed

4. **Phase 4** (Future): Deprecate legacy algorithm
   - Remove legacy code after validation period
   - Keep API format unchanged

## Summary

**Key Points:**
- ✅ **Zero breaking changes** - existing API format maintained exactly
- ✅ **Backward compatible** - old clients work without modifications
- ✅ **Forward compatible** - new fields available via opt-in
- ✅ **Gradual migration** - can switch algorithms without frontend changes
- ✅ **Safe deployment** - legacy algorithm remains available as fallback

The enhanced detection provides better accuracy in the **same JSON fields**, so the frontend automatically benefits from improvements without any code changes.
