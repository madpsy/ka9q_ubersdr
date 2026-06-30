package main

import (
	"context"
	"log"
	"time"
)

// StartVoiceActivityNotifier starts a background goroutine that polls the voice
// activity cache every pollInterval and fires a VoiceActivityEvent for each
// genuinely new signal (band + dial-frequency bucket not seen in the previous scan).
//
// "New" is defined as a (band, 500 Hz bucket) pair that was absent in the
// previous poll. Once a signal disappears from the cache and reappears it is
// treated as new again — matching the cache's own 30-second TTL behaviour.
//
// The notifier only starts if at least one voice_activity rule is enabled.
func StartVoiceActivityNotifier(
	ctx context.Context,
	nm *NotificationManager,
	nfm *NoiseFloorMonitor,
	pollInterval time.Duration,
) {
	if nm == nil || !nm.cfg.Enabled || nfm == nil {
		return
	}

	// Check whether any voice_activity rules are enabled; skip if none.
	hasRule := false
	for _, r := range nm.cfg.Rules {
		if r.IsEnabled() && r.Event == EventTypeVoiceActivity {
			hasRule = true
			break
		}
	}
	if !hasRule {
		return
	}

	go func() {
		// Track which (band, freqBucket) pairs were present in the last scan.
		// key = "band:freqBucket500Hz"
		prevSeen := make(map[string]bool)

		params := DefaultDetectionParams()

		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				currentSeen := make(map[string]bool)

				// Scan all configured noise-floor bands
				for _, bandCfg := range nfm.config.NoiseFloor.Bands {
					band := bandCfg.Name

					activities, err := GetVoiceActivityForBand(nfm, band, params)
					if err != nil || len(activities) == 0 {
						continue
					}

					// Enrich with DX cluster callsigns (same as the HTTP handler)
					activities = enrichWithDXCallsigns(activities)

					for _, act := range activities {
						// 500 Hz bucket — same key strategy as VoiceActivityCache
						bucket := (act.EstimatedDialFreq / 500) * 500
						key := band + ":" + uint64ToString(bucket)
						currentSeen[key] = true

						// Only fire if this is a new signal
						if prevSeen[key] {
							continue
						}

						evt := VoiceActivityEvent{
							Band:              band,
							CenterFreq:        act.CenterFreq,
							EstimatedDialFreq: act.EstimatedDialFreq,
							StartFreq:         act.StartFreq,
							EndFreq:           act.EndFreq,
							Bandwidth:         act.Bandwidth,
							Mode:              act.Mode,
							SNR:               act.SNR,
							Confidence:        act.Confidence,
							DXCallsign:        act.DXCallsign,
							DXCountry:         act.DXCountry,
							DXCountryCode:     act.DXCountryCode,
							DXContinent:       act.DXContinent,
							Time:              time.Now(),
						}

						nm.Publish(evt)
					}
				}

				prevSeen = currentSeen
			}
		}
	}()

	log.Printf("[VoiceActivityNotifier] Started (poll interval %s)", pollInterval)
}

// uint64ToString converts a uint64 to a decimal string without importing strconv
// (avoids a new import just for this helper).
func uint64ToString(n uint64) string {
	if n == 0 {
		return "0"
	}
	buf := make([]byte, 0, 20)
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	return string(buf)
}
