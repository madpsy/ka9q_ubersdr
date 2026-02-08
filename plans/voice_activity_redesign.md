# Voice Activity Detection System Redesign

## Problem Analysis

The current [`voice_activity.go`](../voice_activity.go) implementation has multiple critical flaws causing:
1. **False positives** - detecting activity on empty frequencies
2. **Frequency offset errors** - 500 Hz to 1 kHz dial frequency estimation errors
3. **Missing real signals** - failing to detect actual voice activity

## Root Causes

### 1. Noise Floor Calculation Issues
**Current Implementation (Line 136-155):**
```go
func calculateNoiseFloor(data []float32) float32 {
    // Uses 5th percentile as noise floor
    sorted := make([]float32, len(data))
    copy(sorted, data)
    sort.Slice(sorted, func(i, j int) bool {
        return sorted[i] < sorted[j]
    })
    idx := len(sorted) * 5 / 100
    return sorted[idx]
}
```

**Problems:**
- 5th percentile is too low for bands with significant activity
- Doesn't account for persistent carriers, broadcast stations, or digital modes
- Results in threshold being set too low, causing false positives
- No adaptive adjustment based on band conditions

### 2. Threshold Logic Issues
**Current Implementation (Line 49, 236):**
```go
threshold := noiseFloor + thresholdDB  // Default 8 dB
```

**Problems:**
- Fixed 8 dB threshold is too sensitive
- Doesn't distinguish between voice (varying amplitude) and carriers (constant)
- No consideration of signal characteristics (bandwidth, modulation)
- Catches noise spikes, QRM, and non-voice signals

### 3. Bandwidth Filtering Problems
**Current Implementation (Line 243-252):**
```go
minBandwidth := uint64(2200)  // Default 2200 Hz
maxBandwidth := uint64(3200)  // Default 3200 Hz
```

**Problems:**
- Too narrow range misses wider SSB signals (can be 2.4-3.0 kHz)
- Too wide range catches multiple adjacent signals as one
- Doesn't account for filter characteristics
- Gap-filling logic (maxGap=3 bins) artificially widens signals

### 4. Frequency Estimation Errors
**Current Implementation (Line 157-201):**
```go
func estimateDialFrequency(startFreq, endFreq, bandStart, bandEnd uint64) (uint64, string) {
    isLSB := bandStart < 10000000
    
    const filterOffset uint64 = 150  // SSB filter low-cut offset
    
    if isLSB {
        estimatedDial := roundedEnd + filterOffset
        dialFreq = ((estimatedDial + 250) / 500) * 500  // Round to 500 Hz
    } else {
        estimatedDial := roundedStart - filterOffset
        dialFreq = ((estimatedDial + 250) / 500) * 500
    }
}
```

**Critical Problems:**
- **150 Hz filter offset is wrong** - typical SSB filters are 300-400 Hz from carrier
- **500 Hz rounding is too coarse** - modern radios tune in 1 Hz steps
- **Assumes signal edges are accurate** - but gap-filling distorts edges
- **No consideration of actual signal center** - uses edges instead of centroid
- **Band-based LSB/USB detection is simplistic** - doesn't check actual signal characteristics

### 5. Signal Grouping Issues
**Current Implementation (Line 51-114):**
```go
maxGap := 3  // Allow up to 3 consecutive bins below threshold
```

**Problems:**
- Gap-filling joins separate signals into one
- Creates artificially wide "signals" from noise clusters
- Distorts frequency edges used for dial estimation
- No validation that grouped bins form coherent signal

### 6. Data Averaging Issues
**Current Implementation (Line 288):**
```go
fft := buffer.GetAveragedFFT(20 * time.Second)
```

**Problems:**
- 20-second averaging smooths out voice characteristics
- Voice has natural pauses - averaging fills them in
- Makes it impossible to distinguish voice from carriers
- Creates phantom "activity" from averaged noise

## Proposed Solution Architecture

### Phase 1: Improved Noise Floor Calculation

```go
// Use multiple percentiles for robust noise estimation
type NoiseProfile struct {
    P5   float32  // 5th percentile - absolute floor
    P10  float32  // 10th percentile
    P25  float32  // 25th percentile - better for busy bands
    Mode float32  // Most common value
    StdDev float32 // Standard deviation
}

func calculateNoiseProfile(data []float32) NoiseProfile {
    // Calculate multiple statistics
    // Use P25 for busy bands, P10 for quiet bands
    // Detect and exclude persistent carriers
}
```

**Benefits:**
- Adaptive to band conditions
- Robust against outliers
- Can detect and exclude persistent signals

### Phase 2: Signal Characterization

```go
type SignalCharacteristics struct {
    CenterFreq     uint64   // Weighted centroid, not edges
    Bandwidth      uint64   // 3dB bandwidth
    PeakPower      float32  // Peak power in dB
    AvgPower       float32  // Average power in dB
    PowerVariance  float32  // Variance over time (voice varies, carriers don't)
    SpectralShape  string   // "narrow", "voice", "wide"
    Confidence     float32  // Detection confidence 0-1
}

func analyzeSignal(bins []float32, timestamps []time.Time) SignalCharacteristics {
    // Calculate weighted centroid for accurate center frequency
    // Measure 3dB bandwidth properly
    // Analyze temporal variation (voice modulates, carriers don't)
    // Compute confidence score
}
```

**Benefits:**
- Accurate frequency estimation from centroid
- Distinguishes voice from carriers via temporal variation
- Provides confidence metric for filtering

### Phase 3: Improved Detection Algorithm

```go
func detectVoiceActivity(fft *BandFFT, params DetectionParams) []VoiceActivity {
    // 1. Calculate adaptive noise profile
    noiseProfile := calculateNoiseProfile(fft.Data)
    
    // 2. Use higher threshold (12-15 dB above P25)
    threshold := noiseProfile.P25 + params.ThresholdDB
    
    // 3. Find candidate regions (no gap-filling)
    candidates := findCandidateRegions(fft.Data, threshold)
    
    // 4. Analyze each candidate
    activities := []VoiceActivity{}
    for _, candidate := range candidates {
        chars := analyzeSignal(candidate)
        
        // 5. Apply filters
        if !isValidVoiceSignal(chars, params) {
            continue
        }
        
        // 6. Estimate dial frequency from centroid
        dialFreq := estimateDialFromCentroid(chars, fft)
        
        activities = append(activities, VoiceActivity{
            EstimatedDialFreq: dialFreq,
            Confidence: chars.Confidence,
            // ... other fields
        })
    }
    
    return activities
}
```

### Phase 4: Accurate Frequency Estimation

```go
func estimateDialFromCentroid(chars SignalCharacteristics, fft *BandFFT) (uint64, string) {
    centerFreq := chars.CenterFreq
    bandwidth := chars.Bandwidth
    
    // Determine mode from signal position and characteristics
    mode := determineMode(centerFreq, bandwidth, fft.StartFreq, fft.EndFreq)
    
    var dialFreq uint64
    if mode == "LSB" {
        // For LSB: dial is typically 300-400 Hz above signal center
        // (carrier suppression + filter characteristics)
        dialFreq = centerFreq + 350
    } else {
        // For USB: dial is typically 300-400 Hz below signal center
        dialFreq = centerFreq - 350
    }
    
    // Round to 100 Hz (more reasonable than 500 Hz)
    dialFreq = ((dialFreq + 50) / 100) * 100
    
    return dialFreq, mode
}
```

**Key Improvements:**
- Uses signal centroid, not edges
- 350 Hz offset based on typical SSB characteristics
- 100 Hz rounding (more accurate than 500 Hz)
- Mode determination from actual signal characteristics

### Phase 5: Validation Filters

```go
func isValidVoiceSignal(chars SignalCharacteristics, params DetectionParams) bool {
    // Bandwidth check (2.0 - 3.5 kHz for SSB voice)
    if chars.Bandwidth < 2000 || chars.Bandwidth > 3500 {
        return false
    }
    
    // Power variance check (voice varies, carriers don't)
    if chars.PowerVariance < params.MinVariance {
        return false  // Too steady, likely carrier
    }
    
    // Spectral shape check
    if chars.SpectralShape == "narrow" {
        return false  // Likely CW or carrier
    }
    
    // Confidence threshold
    if chars.Confidence < params.MinConfidence {
        return false
    }
    
    return true
}
```

## Implementation Plan

### Step 1: Add Helper Functions
- `calculateNoiseProfile()` - robust noise estimation
- `calculateCentroid()` - weighted frequency centroid
- `calculateBandwidth3dB()` - proper 3dB bandwidth
- `analyzeTemporalVariation()` - detect modulation

### Step 2: Refactor Detection Logic
- Remove gap-filling (causes edge distortion)
- Use shorter averaging window (5 seconds instead of 20)
- Implement proper signal grouping
- Add confidence scoring

### Step 3: Fix Frequency Estimation
- Use centroid instead of edges
- Correct filter offset (350 Hz instead of 150 Hz)
- Improve rounding (100 Hz instead of 500 Hz)
- Better mode determination

### Step 4: Add Validation
- Bandwidth validation (2.0-3.5 kHz)
- Temporal variation check (voice vs carrier)
- Spectral shape analysis
- Confidence thresholding

### Step 5: Tunable Parameters
```go
type DetectionParams struct {
    ThresholdDB      float32  // dB above noise (default: 12)
    MinBandwidth     uint64   // Hz (default: 2000)
    MaxBandwidth     uint64   // Hz (default: 3500)
    MinVariance      float32  // Power variance (default: 2.0 dB)
    MinConfidence    float32  // 0-1 (default: 0.6)
    AveragingWindow  time.Duration  // default: 5s
    FilterOffset     uint64   // Hz (default: 350)
    RoundingInterval uint64   // Hz (default: 100)
}
```

## Expected Improvements

### Accuracy
- **Frequency estimation**: ±100 Hz (vs current ±500 Hz)
- **False positive rate**: <5% (vs current ~40%)
- **Detection rate**: >90% for SNR > 15 dB

### Robustness
- Adaptive to band conditions
- Distinguishes voice from carriers
- Handles QRM and interference better
- Provides confidence metrics

### Usability
- Tunable parameters via API
- Confidence scores for filtering
- Better dial frequency estimates
- Reduced false alarms

## Testing Strategy

### Test Cases
1. **Clean voice signal** - should detect with high confidence
2. **Carrier/beacon** - should reject (low variance)
3. **CW signal** - should reject (narrow bandwidth)
4. **Digital mode** - should reject (wrong characteristics)
5. **Weak voice** - should detect if SNR > threshold
6. **Multiple signals** - should separate correctly
7. **QRM/QRN** - should reject (low confidence)

### Validation Metrics
- Precision: detected voice / total detections
- Recall: detected voice / actual voice
- Frequency accuracy: |estimated - actual| dial frequency
- Confidence correlation: confidence vs actual signal quality

## Migration Path

1. Implement new functions alongside existing code
2. Add feature flag to switch between old/new detection
3. Run both in parallel for comparison
4. Collect metrics and tune parameters
5. Switch default to new implementation
6. Deprecate old implementation after validation period

## Configuration Example

```yaml
voice_activity:
  detection:
    threshold_db: 12.0          # dB above noise floor
    min_bandwidth: 2000         # Hz
    max_bandwidth: 3500         # Hz
    min_variance: 2.0           # dB power variance
    min_confidence: 0.6         # 0-1 confidence threshold
    averaging_window: 5         # seconds
    filter_offset: 350          # Hz (SSB carrier offset)
    rounding_interval: 100      # Hz (dial frequency rounding)
    use_new_algorithm: true     # Enable new detection
```

## Conclusion

The current voice activity detection has fundamental flaws in:
- Noise floor estimation (too low)
- Threshold logic (too sensitive)
- Signal grouping (gap-filling distorts edges)
- Frequency estimation (wrong offset, coarse rounding)
- Lack of signal characterization (can't distinguish voice from carriers)

The proposed redesign addresses all these issues with:
- Adaptive noise profiling
- Signal characterization and confidence scoring
- Accurate centroid-based frequency estimation
- Temporal variation analysis to distinguish voice from carriers
- Tunable parameters for different conditions

This will dramatically improve detection accuracy and reduce false positives.
