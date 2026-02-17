package morse

import (
	"fmt"
	"log"
)

// AudioSample contains PCM audio data with timing information
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (mono, int16)
	RTPTimestamp uint32  // RTP timestamp from radiod (for jitter/loss detection)
	GPSTimeNs    int64   // GPS-synchronized Unix time in nanoseconds (packet arrival time)
}

// MorseExtension wraps the Morse decoder as an AudioExtension
type MorseExtension struct {
	decoder      *MultiChannelDecoder
	config       MorseConfig
	multiChannel bool
}

// NewMorseExtension creates a new Morse audio extension
func NewMorseExtension(sampleRate int, extensionParams map[string]interface{}) (*MorseExtension, error) {
	// Start with default config
	config := DefaultMorseConfig()

	// Check if multi-channel mode is requested (default: true)
	multiChannel := true
	if mc, ok := extensionParams["multi_channel"].(bool); ok {
		multiChannel = mc
	}

	// Override with user parameters
	if bw, ok := extensionParams["bandwidth"].(float64); ok {
		config.Bandwidth = bw
	}
	if minWPM, ok := extensionParams["min_wpm"].(float64); ok {
		config.MinWPM = minWPM
	}
	if maxWPM, ok := extensionParams["max_wpm"].(float64); ok {
		config.MaxWPM = maxWPM
	}
	if threshold, ok := extensionParams["threshold_snr"].(float64); ok {
		config.ThresholdSNR = threshold
	}

	// Get channel frequencies from parameters
	var channelFreqs [MaxDecoders]float64
	if freqs, ok := extensionParams["channel_frequencies"].([]interface{}); ok {
		for i := 0; i < MaxDecoders && i < len(freqs); i++ {
			if freq, ok := freqs[i].(float64); ok {
				channelFreqs[i] = freq
			}
		}
	}

	// Validate configuration
	if config.Bandwidth <= 0 || config.Bandwidth > 1000 {
		return nil, fmt.Errorf("invalid bandwidth: %.1f Hz (must be 1-1000)", config.Bandwidth)
	}
	if config.MinWPM <= 0 || config.MinWPM > 100 {
		return nil, fmt.Errorf("invalid min WPM: %.1f (must be 1-100)", config.MinWPM)
	}
	if config.MaxWPM <= 0 || config.MaxWPM > 100 {
		return nil, fmt.Errorf("invalid max WPM: %.1f (must be 1-100)", config.MaxWPM)
	}
	if config.MinWPM >= config.MaxWPM {
		return nil, fmt.Errorf("min WPM (%.1f) must be less than max WPM (%.1f)", config.MinWPM, config.MaxWPM)
	}
	if config.ThresholdSNR <= 0 || config.ThresholdSNR > 100 {
		return nil, fmt.Errorf("invalid threshold SNR: %.1f dB (must be 1-100)", config.ThresholdSNR)
	}

	decoder := NewMultiChannelDecoder(sampleRate, config, channelFreqs)

	log.Printf("[Morse Extension] Created multi-channel decoder: BW=%.1f Hz, WPM=%.1f-%.1f, SNR=%.1f dB, Channels=%d",
		config.Bandwidth, config.MinWPM, config.MaxWPM, config.ThresholdSNR, MaxDecoders)

	return &MorseExtension{
		decoder:      decoder,
		config:       config,
		multiChannel: multiChannel,
	}, nil
}

// Start begins processing audio
func (e *MorseExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	// Convert AudioSample to []int16 for the decoder
	// In the future, the decoder could use timestamps for message timestamping
	legacyChan := make(chan []int16, cap(audioChan))
	go func() {
		defer close(legacyChan)
		for sample := range audioChan {
			// TODO: Could use sample.GPSTimeNs to timestamp decoded messages
			legacyChan <- sample.PCMData
		}
	}()
	return e.decoder.Start(legacyChan, resultChan)
}

// Stop stops the extension
func (e *MorseExtension) Stop() error {
	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *MorseExtension) GetName() string {
	return "morse"
}
