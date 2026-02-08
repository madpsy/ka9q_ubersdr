# Adaptive Dial Frequency Offset - Design Addendum

## Problem with Fixed Offset

The initial design proposed a fixed 350 Hz offset between signal centroid and dial frequency. This has several issues:

1. **Radio-specific variations** - Different radios have different SSB filter characteristics
2. **Bandwidth dependency** - Wider signals may have different effective centers
3. **Operator tuning habits** - Some operators tune differently
4. **Filter shape variations** - Crystal filters vs DSP filters behave differently

## Improved Approach: Adaptive Offset Calculation

### Strategy 1: Bandwidth-Based Adaptive Offset

The offset should vary based on the detected signal bandwidth:

```go
// calculateAdaptiveOffset determines offset based on signal characteristics
func calculateAdaptiveOffset(char SignalCharacteristics, params DetectionParams) uint64 {
    // Base offset from configuration (default 350 Hz, but tunable)
    baseOffset := params.FilterOffset
    
    // Adjust based on bandwidth
    // Narrower signals (2.0-2.4 kHz): carrier closer to edge (~300 Hz)
    // Typical signals (2.4-2.8 kHz): standard offset (~350 Hz)  
    // Wider signals (2.8-3.5 kHz): carrier further from edge (~400 Hz)
    
    bw := float64(char.Bandwidth)
    var adjustment float64
    
    if bw < 2400 {
        // Narrow signal - reduce offset
        adjustment = -50.0 * (2400.0 - bw) / 400.0 // Up to -50 Hz
    } else if bw > 2800 {
        // Wide signal - increase offset  
        adjustment = 50.0 * (bw - 2800.0) / 700.0 // Up to +50 Hz
    } else {
        // Typical bandwidth - no adjustment
        adjustment = 0
    }
    
    offset := uint64(float64(baseOffset) + adjustment)
    
    // Clamp to reasonable range (250-450 Hz)
    if offset < 250 {
        offset = 250
    }
    if offset > 450 {
        offset = 450
    }
    
    return offset
}
```

**Benefits:**
- Adapts to signal characteristics
- Still uses configurable base offset
- Bounded to reasonable range

### Strategy 2: Return Multiple Candidates

Instead of trying to guess the exact dial frequency, return multiple likely candidates:

```go
type VoiceActivity struct {
    // ... existing fields ...
    
    // Frequency estimates
    EstimatedDialFreq     uint64   `json:"estimated_dial_freq"`      // Best guess
    AlternativeDialFreqs  []uint64 `json:"alternative_dial_freqs"`   // Other possibilities
    FrequencyConfidence   float32  `json:"frequency_confidence"`     // 0-1 confidence in estimate
}

func estimateDialFrequencyWithAlternatives(char SignalCharacteristics, bandStart, bandEnd uint64, 
                                           params DetectionParams) (uint64, []uint64, string) {
    centerFreq := char.CenterFreq
    mode := determineMode(centerFreq, bandStart, bandEnd)
    
    // Calculate primary estimate with adaptive offset
    primaryOffset := calculateAdaptiveOffset(char, params)
    
    // Generate alternatives with different offsets
    alternatives := []uint64{}
    offsets := []uint64{300, 350, 400} // Common SSB filter offsets
    
    for _, offset := range offsets {
        var dialFreq uint64
        if mode == "LSB" {
            dialFreq = centerFreq + offset
        } else {
            dialFreq = centerFreq - offset
        }
        
        // Round
        halfInterval := params.RoundingInterval / 2
        dialFreq = ((dialFreq + halfInterval) / params.RoundingInterval) * params.RoundingInterval
        
        alternatives = append(alternatives, dialFreq)
    }
    
    // Primary estimate
    var primaryDialFreq uint64
    if mode == "LSB" {
        primaryDialFreq = centerFreq + primaryOffset
    } else {
        primaryDialFreq = centerFreq - primaryOffset
    }
    primaryDialFreq = ((primaryDialFreq + params.RoundingInterval/2) / params.RoundingInterval) * params.RoundingInterval
    
    return primaryDialFreq, alternatives, mode
}
```

**Benefits:**
- Provides multiple options for user/application to choose from
- Acknowledges uncertainty in estimation
- Allows UI to show "dial frequency range"

### Strategy 3: Learning from User Feedback

Implement a feedback mechanism to learn the correct offset over time:

```go
type OffsetLearning struct {
    BandOffsets map[string]OffsetStats // Per-band learned offsets
    mu          sync.RWMutex
}

type OffsetStats struct {
    SampleCount int
    MeanOffset  float64
    StdDev      float64
}

// RecordUserCorrection records when user tunes to actual dial frequency
func (ol *OffsetLearning) RecordUserCorrection(band string, detectedCenter uint64, 
                                                actualDial uint64, mode string) {
    ol.mu.Lock()
    defer ol.mu.Unlock()
    
    // Calculate actual offset
    var actualOffset int64
    if mode == "LSB" {
        actualOffset = int64(actualDial) - int64(detectedCenter)
    } else {
        actualOffset = int64(detectedCenter) - int64(actualDial)
    }
    
    // Update running statistics
    stats := ol.BandOffsets[band]
    stats.SampleCount++
    
    // Update mean using online algorithm
    delta := float64(actualOffset) - stats.MeanOffset
    stats.MeanOffset += delta / float64(stats.SampleCount)
    
    // Update variance
    delta2 := float64(actualOffset) - stats.MeanOffset
    stats.StdDev = math.Sqrt((stats.StdDev*stats.StdDev*float64(stats.SampleCount-1) + 
                              delta*delta2) / float64(stats.SampleCount))
    
    ol.BandOffsets[band] = stats
}

// GetLearnedOffset returns the learned offset for a band
func (ol *OffsetLearning) GetLearnedOffset(band string, defaultOffset uint64) uint64 {
    ol.mu.RLock()
    defer ol.mu.RUnlock()
    
    stats, ok := ol.BandOffsets[band]
    if !ok || stats.SampleCount < 10 {
        // Not enough data, use default
        return defaultOffset
    }
    
    // Use learned mean if we have enough samples
    return uint64(stats.MeanOffset)
}
```

**Benefits:**
- Adapts to specific radio/operator characteristics
- Improves over time
- Per-band learning accounts for different filter characteristics

### Strategy 4: Signal Edge Analysis

Instead of using centroid, analyze the signal edges to find the actual filter cutoff:

```go
// findFilterCutoff analyzes signal edges to estimate filter characteristics
func findFilterCutoff(data []float32, candidate SignalCharacteristics, 
                     binWidth float64, startFreq uint64) (uint64, uint64) {
    
    signalBins := data[candidate.StartBin : candidate.EndBin+1]
    peakPower := candidate.PeakPower
    
    // Find where signal drops to -6dB from peak (typical filter rolloff point)
    cutoffThreshold := peakPower - 6.0
    
    var lowCutoff, highCutoff uint64
    
    // Scan from edges inward to find cutoff points
    for i := 0; i < len(signalBins); i++ {
        if signalBins[i] >= cutoffThreshold {
            lowCutoff = startFreq + uint64(float64(candidate.StartBin+i)*binWidth)
            break
        }
    }
    
    for i := len(signalBins) - 1; i >= 0; i-- {
        if signalBins[i] >= cutoffThreshold {
            highCutoff = startFreq + uint64(float64(candidate.StartBin+i)*binWidth)
            break
        }
    }
    
    return lowCutoff, highCutoff
}

// estimateDialFromFilterEdges uses filter cutoff analysis
func estimateDialFromFilterEdges(char SignalCharacteristics, data []float32,
                                 binWidth float64, startFreq uint64, mode string) uint64 {
    
    lowCutoff, highCutoff := findFilterCutoff(data, char, binWidth, startFreq)
    
    var dialFreq uint64
    
    if mode == "LSB" {
        // LSB: dial is at high edge of passband
        // Typical SSB filter: -6dB point is ~100-200 Hz from carrier
        dialFreq = highCutoff + 150
    } else {
        // USB: dial is at low edge of passband
        dialFreq = lowCutoff - 150
    }
    
    return dialFreq
}
```

**Benefits:**
- Based on actual signal characteristics
- Accounts for filter shape
- More accurate for well-defined signals

## Recommended Hybrid Approach

Combine multiple strategies for robustness:

```go
func estimateDialFrequencyHybrid(char SignalCharacteristics, data []float32,
                                bandStart, bandEnd uint64, binWidth float64,
                                startFreq uint64, params DetectionParams,
                                learning *OffsetLearning) (uint64, []uint64, float32, string) {
    
    mode := determineMode(char.CenterFreq, bandStart, bandEnd)
    
    // Method 1: Adaptive offset from centroid
    adaptiveOffset := calculateAdaptiveOffset(char, params)
    estimate1 := applyOffset(char.CenterFreq, adaptiveOffset, mode, params.RoundingInterval)
    
    // Method 2: Filter edge analysis
    estimate2 := estimateDialFromFilterEdges(char, data, binWidth, startFreq, mode)
    estimate2 = roundFrequency(estimate2, params.RoundingInterval)
    
    // Method 3: Learned offset (if available)
    bandName := getBandName(bandStart, bandEnd)
    learnedOffset := learning.GetLearnedOffset(bandName, adaptiveOffset)
    estimate3 := applyOffset(char.CenterFreq, learnedOffset, mode, params.RoundingInterval)
    
    // Combine estimates with confidence weighting
    estimates := []uint64{estimate1, estimate2, estimate3}
    weights := []float32{0.4, 0.3, 0.3} // Adjust based on confidence
    
    // If learned offset has enough samples, increase its weight
    if stats, ok := learning.BandOffsets[bandName]; ok && stats.SampleCount >= 50 {
        weights = []float32{0.2, 0.2, 0.6} // Trust learned offset more
    }
    
    // Calculate weighted average
    var weightedSum, totalWeight float64
    for i, est := range estimates {
        weightedSum += float64(est) * float64(weights[i])
        totalWeight += float64(weights[i])
    }
    primaryEstimate := uint64(weightedSum / totalWeight)
    primaryEstimate = roundFrequency(primaryEstimate, params.RoundingInterval)
    
    // Calculate confidence based on agreement between methods
    maxDiff := maxDifference(estimates)
    confidence := calculateConfidenceFromAgreement(maxDiff)
    
    // Return primary estimate, alternatives, confidence, and mode
    alternatives := removeDuplicates(estimates)
    
    return primaryEstimate, alternatives, confidence, mode
}

func calculateConfidenceFromAgreement(maxDiff uint64) float32 {
    // High confidence if estimates agree within 100 Hz
    // Low confidence if they differ by > 500 Hz
    if maxDiff <= 100 {
        return 1.0
    } else if maxDiff >= 500 {
        return 0.3
    }
    // Linear interpolation between
    return 1.0 - float32(maxDiff-100)/400.0*0.7
}
```

## Configuration Options

Add to DetectionParams:

```go
type DetectionParams struct {
    // ... existing fields ...
    
    // Frequency estimation strategy
    UseAdaptiveOffset    bool    // Enable bandwidth-based adaptation
    UseFilterEdgeAnalysis bool   // Enable edge-based estimation
    UseLearning          bool    // Enable learning from corrections
    
    // Offset configuration
    FilterOffset         uint64  // Base offset Hz (default: 350)
    MinOffset            uint64  // Minimum offset Hz (default: 250)
    MaxOffset            uint64  // Maximum offset Hz (default: 450)
    
    // Alternative estimates
    ProvideAlternatives  bool    // Return multiple dial frequency candidates
}
```

## Summary

Instead of a fixed 350 Hz offset, the improved design:

1. **Adapts to signal bandwidth** - narrower/wider signals get different offsets
2. **Provides alternatives** - acknowledges uncertainty
3. **Learns from feedback** - improves over time with user corrections
4. **Analyzes filter edges** - uses actual signal characteristics
5. **Combines methods** - hybrid approach with confidence scoring
6. **Fully configurable** - base offset and strategy selection via config

This makes the system much more robust and adaptable to different radios, operators, and signal conditions.
