package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"time"
)

// wspr_prediction.go — WSPR → SSB Phone Propagation Prediction API
//
// Endpoint: GET /api/wspr/phone-prediction
//
// Query parameters (all optional):
//   minutes        int   1–1440   Lookback window in minutes (default: 60)
//   phone_power_w  int   whitelist {10,50,100,500,1000}  Assumed SSB TX power in watts (default: 100)
//   band           str   WSPR band whitelist or empty for all (default: "")
//   min_ssb_snr    int   -60–30   Minimum predicted SSB SNR to include in results (default: -60)
//   summary        bool  If "true", return a lightweight list of country/band combinations only.
//                        When summary=true the default min_ssb_snr is raised to +10 dB (Good+)
//                        so the list only contains bands that are realistically usable.
//                        Response shape changes to { "predictions": [ { country, continent, band,
//                        prediction, predicted_ssb_snr }, … ] } — no meta block.
//
// Physics:
//   wsprd reports SNR normalised to a 2500 Hz reference bandwidth.  This is the
//   actual channel SNR — the ratio of signal power to noise power in that bandwidth.
//   WSPR's coding gain (≈28–31 dB) is what allows wsprd to *decode* signals that are
//   deep in the noise, but the reported SNR value is the real channel SNR, not a
//   coding-adjusted figure.  A spot with SNR = −28 dB genuinely has 28 dB less signal
//   power than noise power in 2500 Hz.
//
//   To predict the SNR an SSB phone transmitter would produce on the same path:
//
//     1. Scale for the power difference between the phone TX and the WSPR TX:
//          S_phone_2500Hz = S_wspr_2500Hz + (phone_power_dBm − wspr_tx_dBm)
//
//     2. Correct for the different noise bandwidth.  SSB occupies ≈2700 Hz; the
//        wsprd reference is 2500 Hz.  A wider noise bandwidth admits more noise,
//        so the SNR is slightly lower:
//          S_phone_2700Hz = S_phone_2500Hz + 10·log10(2500/2700) ≈ −0.33 dB
//
//   Combined:
//     predicted_ssb_snr = wspr_snr + (phone_power_dBm − wspr_tx_dBm) − bw_correction_db
//
//   where bw_correction_db = 10·log10(2700/2500) ≈ +0.33 dB (positive value, subtracted).
//
//   Note: the WSPR coding advantage (≈41 dB) explains *why* WSPR can decode at −28 dB
//   but it is NOT subtracted here — the channel SNR is the channel SNR regardless of
//   which modulation scheme is used to measure it.
//
//   Prediction categories (SSB SNR in 2700 Hz BW):
//     "excellent"  ≥ +15 dB  — RS 5, broadcast quality
//     "good"       ≥ +10 dB  — RS 4, easy copy
//     "workable"   ≥  +6 dB  — RS 3, readable with concentration
//     "marginal"   ≥  +3 dB  — RS 2, partial copy only
//     "poor"       ≥   0 dB  — RS 1, barely detectable
//     "not_viable" <   0 dB  — below noise floor for SSB phone

const (
	// wsprRefBWHz is the reference noise bandwidth that wsprd normalises its SNR to.
	// wsprd internally subtracts 10·log10(wsprSignalBW/wsprRefBWHz) ≈ 26.3 dB from
	// the raw in-band SNR, so the reported value is already a 2500 Hz channel SNR.
	wsprRefBWHz = 2500.0
	// ssbNoiseBWHz is the effective noise bandwidth of an SSB phone signal (≈2700 Hz).
	ssbNoiseBWHz = 2700.0
)

// bwCorrectionDB is the bandwidth penalty when moving from the wsprd 2500 Hz
// reference to the 2700 Hz SSB noise bandwidth.  A wider bandwidth admits more
// noise, so the SNR decreases:
//
//	bwCorrectionDB = 10·log10(2700/2500) ≈ +0.33 dB  (positive; subtracted in formula)
var bwCorrectionDB = 10.0 * math.Log10(ssbNoiseBWHz/wsprRefBWHz)

// validWSPRBands is the whitelist of standard amateur bands on which WSPR operates
var validWSPRBands = map[string]bool{
	"":      true, // empty = all bands
	"2200m": true,
	"630m":  true,
	"160m":  true,
	"80m":   true,
	"60m":   true,
	"40m":   true,
	"30m":   true,
	"20m":   true,
	"17m":   true,
	"15m":   true,
	"12m":   true,
	"10m":   true,
}

// validPhonePowers is the whitelist of allowed SSB TX power values in watts
var validPhonePowers = map[int]bool{
	10:   true,
	50:   true,
	100:  true,
	500:  true,
	1000: true,
}

// WSPRPredictionMeta holds metadata about the prediction request
type WSPRPredictionMeta struct {
	PhonePowerW      int       `json:"phone_power_w"`
	PhonePowerDbm    float64   `json:"phone_power_dbm"`
	BWCorrectionDB   float64   `json:"bw_correction_db"` // 10·log10(2700/2500) ≈ −0.33 dB penalty for wider SSB BW
	Minutes          int       `json:"minutes"`
	BandFilter       string    `json:"band_filter"`
	BandsAvailable   []string  `json:"bands_available"`
	SpotCount        int       `json:"spot_count"`
	GeneratedAt      time.Time `json:"generated_at"`
	ReceiverLocator  string    `json:"receiver_locator,omitempty"`
	ReceiverLat      *float64  `json:"receiver_lat,omitempty"`
	ReceiverLon      *float64  `json:"receiver_lon,omitempty"`
	ReceiverCallsign string    `json:"receiver_callsign,omitempty"`
}

// WSPRPredictionEntry holds the prediction result for a single country+band combination
type WSPRPredictionEntry struct {
	Country         string   `json:"country"`
	Continent       string   `json:"continent"`
	Band            string   `json:"band"`
	MeanWSPRSNR     float64  `json:"mean_wspr_snr"`    // mean channel SNR in 2500 Hz BW as reported by wsprd
	MeanTxDbm       float64  `json:"mean_tx_dbm"`      // mean reported TX power across all spots
	BWCorrectionDB  float64  `json:"bw_correction_db"` // 10·log10(2700/2500) ≈ −0.33 dB: SNR penalty for 2700 Hz SSB BW
	PhonePowerDbm   float64  `json:"phone_power_dbm"`
	PowerGainDB     float64  `json:"power_gain_db"`     // phone_power_dbm − mean_tx_dbm
	PredictedSSBSNR float64  `json:"predicted_ssb_snr"` // mean_wspr_snr + power_gain − bw_correction_db
	Prediction      string   `json:"prediction"`
	SpotCount       int      `json:"spot_count"`
	LastSeen        string   `json:"last_seen"`
	Locator         string   `json:"locator,omitempty"`
	DistanceKm      *float64 `json:"distance_km,omitempty"`
	BearingDeg      *float64 `json:"bearing_deg,omitempty"`
	BestCallsign    string   `json:"best_callsign,omitempty"`     // callsign of the spot with the highest SNR in this group
	BestCallsignDBm int      `json:"best_callsign_dbm,omitempty"` // TX power (dBm) reported by that callsign
}

// WSPRPredictionResponse is the full API response
type WSPRPredictionResponse struct {
	Meta        WSPRPredictionMeta    `json:"meta"`
	Predictions []WSPRPredictionEntry `json:"predictions"`
}

// WSPRPredictionSummaryEntry is the lightweight per-country/band entry returned
// when the caller passes summary=true.  It omits all signal-level detail and
// meta information so the response is small enough to embed in other pages.
type WSPRPredictionSummaryEntry struct {
	Country         string  `json:"country"`
	Continent       string  `json:"continent"`
	Band            string  `json:"band"`
	Prediction      string  `json:"prediction"`
	PredictedSSBSNR float64 `json:"predicted_ssb_snr"`
}

// WSPRPredictionSummaryResponse is the slim API response used when summary=true
type WSPRPredictionSummaryResponse struct {
	Predictions []WSPRPredictionSummaryEntry `json:"predictions"`
}

// wattsTodBm converts power in watts to dBm
func wattsTodBm(watts int) float64 {
	return 10.0*math.Log10(float64(watts)) + 30.0
}

// dbmToWatts converts dBm to approximate watts (for display)
func dbmToWatts(dbm int) float64 {
	return math.Pow(10.0, (float64(dbm)-30.0)/10.0)
}

// classifyPrediction returns a signal quality category based on predicted SSB SNR
// in a 2700 Hz noise bandwidth, using ITU-R RS.1808 / CCIR Report 322 thresholds
// aligned with the amateur radio RS (Readability/Strength) report system.
//
//	"excellent"   ≥ +15 dB  — RS 5, broadcast quality
//	"good"        ≥ +10 dB  — RS 4, easy copy
//	"workable"    ≥  +6 dB  — RS 3, readable with concentration
//	"marginal"    ≥  +3 dB  — RS 2, partial copy only
//	"poor"        ≥   0 dB  — RS 1, barely detectable
//	"not_viable"  <   0 dB  — below noise floor
func classifyPrediction(predictedSSBSNR float64) string {
	switch {
	case predictedSSBSNR >= 15.0:
		return "excellent"
	case predictedSSBSNR >= 10.0:
		return "good"
	case predictedSSBSNR >= 6.0:
		return "workable"
	case predictedSSBSNR >= 3.0:
		return "marginal"
	case predictedSSBSNR >= 0.0:
		return "poor"
	default:
		return "not_viable"
	}
}

// handleWSPRPhonePrediction is the HTTP handler for GET /api/wspr/phone-prediction
func handleWSPRPhonePrediction(w http.ResponseWriter, r *http.Request, md *MultiDecoder, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if md == nil || md.spotsLogger == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Decoder spots logging is not enabled",
		})
		return
	}

	// ── Parameter validation ──────────────────────────────────────────────────

	// minutes: 1–1440, default 60
	minutes := 60
	if s := r.URL.Query().Get("minutes"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 1 || v > 1440 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "minutes must be an integer between 1 and 1440",
			})
			return
		}
		minutes = v
	}

	// phone_power_w: whitelist {10, 50, 100, 500, 1000}, default 100
	phonePowerW := 100
	if s := r.URL.Query().Get("phone_power_w"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || !validPhonePowers[v] {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "phone_power_w must be one of: 10, 50, 100, 500, 1000",
			})
			return
		}
		phonePowerW = v
	}

	// band: whitelist of WSPR bands or empty for all
	band := r.URL.Query().Get("band")
	if !validWSPRBands[band] {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "band must be one of: 2200m, 630m, 160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m, or empty for all",
		})
		return
	}

	// summary: if "true", return a lightweight country/band list only.
	// When summary mode is active the default min_ssb_snr is raised to +10 dB
	// (Good+) so the list only contains bands that are realistically usable.
	summaryMode := r.URL.Query().Get("summary") == "true"

	// min_ssb_snr: -60–30.
	// Default is -60 (show everything) in full mode; +10 (Good+) in summary mode.
	defaultMinSSBSNR := -60.0
	if summaryMode {
		defaultMinSSBSNR = 10.0
	}
	minSSBSNR := defaultMinSSBSNR
	if s := r.URL.Query().Get("min_ssb_snr"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < -60 || v > 30 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "min_ssb_snr must be an integer between -60 and 30",
			})
			return
		}
		minSSBSNR = float64(v)
	}

	// ── Rate limiting ─────────────────────────────────────────────────────────
	clientIP := getClientIP(r)
	rateLimitKey := fmt.Sprintf("wspr-prediction-%s-%d-%d", band, minutes, phonePowerW)
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait before retrying.",
		})
		log.Printf("WSPR prediction endpoint rate limit exceeded for IP: %s", clientIP)
		return
	}

	// ── Determine date range for the lookback window ──────────────────────────
	now := time.Now().UTC()
	windowStart := now.Add(-time.Duration(minutes) * time.Minute)

	fromDate := windowStart.Format("2006-01-02")
	toDate := now.Format("2006-01-02")

	// ── Fetch WSPR spots ──────────────────────────────────────────────────────
	// We fetch all WSPR spots for the date range (no band filter at DB level —
	// we filter by timestamp and band in Go after fetching).
	// deduplicate=false so we see all spots and can pick the best SNR per country+band.
	spots, err := md.spotsLogger.GetHistoricalSpots(
		"WSPR", // mode
		"",     // band — fetch all, filter below
		"",     // name
		"",     // callsign
		"",     // locator
		"",     // continent
		"",     // direction
		fromDate,
		toDate,
		"",    // startTime
		"",    // endTime
		false, // deduplicate — we need all spots to pick best SNR
		false, // locatorsOnly — WSPR spots without locators still have dBm
		0,     // minDistanceKm
		-999,  // minSNR
	)
	if err != nil {
		// No data is not an error — return empty predictions
		log.Printf("WSPR prediction: failed to fetch spots: %v", err)
		spots = nil
	}

	// ── Filter spots to the exact time window ─────────────────────────────────
	// GetHistoricalSpots works on whole days; we need to trim to the minute window.
	phonePowerDbm := wattsTodBm(phonePowerW)

	// key: "country|band"
	type groupKey struct {
		Country string
		Band    string
	}
	// groupData accumulates SNR and TX power separately so we can apply the
	// bandwidth correction and power adjustment correctly at prediction time.
	// Using means across all spots makes the prediction robust against outliers
	// and transmitters mis-reporting their TX power.
	type groupData struct {
		SNRSum          float64 // sum of WSPR SNR values (in ~6 Hz BW)
		TxDbmSum        float64 // sum of reported TX power in dBm
		SpotCount       int
		LastSeen        string
		Locator         string // locator of the most recent spot (for map placement)
		DistanceKm      *float64
		BearingDeg      *float64
		Continent       string
		BestSNR         int    // highest SNR seen in this group
		BestCallsign    string // callsign of the spot with the highest SNR
		BestCallsignDBm int    // TX power (dBm) of that best-SNR spot
		BestSNRSet      bool   // whether BestSNR has been initialised
	}

	groups := make(map[groupKey]*groupData)
	bandsSeenSet := make(map[string]bool)
	totalFiltered := 0

	for _, spot := range spots {
		// Parse timestamp and check it's within the window
		ts, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		if ts.Before(windowStart) {
			continue
		}

		// Apply band filter if specified
		if band != "" && spot.Band != band {
			continue
		}

		// Must have a dBm value (WSPR-specific field)
		if spot.DBm == nil {
			continue
		}

		totalFiltered++
		bandsSeenSet[spot.Band] = true

		k := groupKey{Country: spot.Country, Band: spot.Band}
		existing, ok := groups[k]
		if !ok {
			existing = &groupData{
				LastSeen:   spot.Timestamp,
				Locator:    spot.Locator,
				DistanceKm: spot.DistanceKm,
				BearingDeg: spot.BearingDeg,
				Continent:  spot.Continent,
			}
			groups[k] = existing
		}

		// Accumulate SNR and TX power separately
		existing.SNRSum += float64(spot.SNR)
		existing.TxDbmSum += float64(*spot.DBm)
		existing.SpotCount++

		// Track the callsign with the highest SNR (best propagation sample for this group)
		if !existing.BestSNRSet || spot.SNR > existing.BestSNR {
			existing.BestSNR = spot.SNR
			existing.BestSNRSet = true
			existing.BestCallsign = spot.Callsign
			existing.BestCallsignDBm = *spot.DBm
		}

		// Track latest timestamp and its associated locator/distance/bearing
		if spot.Timestamp > existing.LastSeen {
			existing.LastSeen = spot.Timestamp
			if spot.Locator != "" {
				existing.Locator = spot.Locator
				existing.DistanceKm = spot.DistanceKm
				existing.BearingDeg = spot.BearingDeg
			}
		}
	}

	// ── Build sorted list of available bands ──────────────────────────────────
	bandOrder := []string{"2200m", "630m", "160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"}
	bandsAvailable := make([]string, 0, len(bandsSeenSet))
	for _, b := range bandOrder {
		if bandsSeenSet[b] {
			bandsAvailable = append(bandsAvailable, b)
		}
	}

	// ── Calculate predictions ─────────────────────────────────────────────────
	predictions := make([]WSPRPredictionEntry, 0, len(groups))

	for k, g := range groups {
		if g.SpotCount == 0 {
			continue
		}

		// Skip entries with no resolved country — these are spots from transmitters
		// whose locator could not be matched to a DXCC entity.  They would appear
		// as blank/dash rows in the table and are not useful for propagation planning.
		if k.Country == "" {
			continue
		}

		// Correct formula:
		//   predicted_ssb_snr = mean_wspr_snr + power_gain − bw_correction_db
		//
		// Where:
		//   mean_wspr_snr   = actual channel SNR in 2500 Hz BW (wsprd normalises to this internally)
		//   power_gain      = phone_power_dbm − mean_tx_dbm  (TX power difference, dB)
		//   bw_correction   = 10·log10(2700/2500) ≈ +0.33 dB (subtracted: wider SSB BW = more noise = lower SNR)
		//
		// The WSPR coding advantage (≈41 dB) is NOT subtracted here.  It explains why
		// wsprd can decode signals 28–31 dB below the noise floor, but the SNR value
		// wsprd reports is the real channel SNR.  Subtracting the coding advantage would
		// be double-counting — it would imply the channel is 41 dB worse than measured.
		meanWSPRSNR := g.SNRSum / float64(g.SpotCount)
		meanTxDbm := g.TxDbmSum / float64(g.SpotCount)
		powerGainDB := phonePowerDbm - meanTxDbm
		predictedSSBSNR := meanWSPRSNR + powerGainDB - bwCorrectionDB

		// Apply min_ssb_snr filter
		if predictedSSBSNR < minSSBSNR {
			continue
		}

		entry := WSPRPredictionEntry{
			Country:         k.Country,
			Continent:       g.Continent,
			Band:            k.Band,
			MeanWSPRSNR:     math.Round(meanWSPRSNR*10) / 10,
			MeanTxDbm:       math.Round(meanTxDbm*10) / 10,
			BWCorrectionDB:  math.Round(bwCorrectionDB*100) / 100,
			PhonePowerDbm:   math.Round(phonePowerDbm*10) / 10,
			PowerGainDB:     math.Round(powerGainDB*10) / 10,
			PredictedSSBSNR: math.Round(predictedSSBSNR*10) / 10,
			Prediction:      classifyPrediction(predictedSSBSNR),
			SpotCount:       g.SpotCount,
			LastSeen:        g.LastSeen,
			Locator:         g.Locator,
			DistanceKm:      g.DistanceKm,
			BearingDeg:      g.BearingDeg,
			BestCallsign:    g.BestCallsign,
			BestCallsignDBm: g.BestCallsignDBm,
		}
		predictions = append(predictions, entry)
	}

	// Sort predictions: good first, then marginal, then poor; within each group by predicted SNR descending
	sortWSPRPredictions(predictions)

	// ── Build response ────────────────────────────────────────────────────────
	meta := WSPRPredictionMeta{
		PhonePowerW:    phonePowerW,
		PhonePowerDbm:  math.Round(phonePowerDbm*10) / 10,
		BWCorrectionDB: math.Round(bwCorrectionDB*100) / 100,
		Minutes:        minutes,
		BandFilter:     band,
		BandsAvailable: bandsAvailable,
		SpotCount:      totalFiltered,
		GeneratedAt:    now,
	}

	// Add receiver location if configured (convert Maidenhead locator to lat/lon)
	if md.config != nil {
		if md.config.ReceiverLocator != "" {
			meta.ReceiverLocator = md.config.ReceiverLocator
			if lat, lon, err := MaidenheadToLatLon(md.config.ReceiverLocator); err == nil {
				meta.ReceiverLat = &lat
				meta.ReceiverLon = &lon
			}
		}
		if md.config.ReceiverCallsign != "" {
			meta.ReceiverCallsign = md.config.ReceiverCallsign
		}
	}

	// ── Summary mode: return slim country/band list ───────────────────────────
	if summaryMode {
		summary := make([]WSPRPredictionSummaryEntry, 0, len(predictions))
		for _, p := range predictions {
			summary = append(summary, WSPRPredictionSummaryEntry{
				Country:         p.Country,
				Continent:       p.Continent,
				Band:            p.Band,
				Prediction:      p.Prediction,
				PredictedSSBSNR: p.PredictedSSBSNR,
			})
		}
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(WSPRPredictionSummaryResponse{Predictions: summary}); err != nil {
			log.Printf("WSPR prediction summary: error encoding response: %v", err)
		}
		return
	}

	resp := WSPRPredictionResponse{
		Meta:        meta,
		Predictions: predictions,
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("WSPR prediction: error encoding response: %v", err)
	}
}

// sortWSPRPredictions sorts predictions by quality tier (best first), then by predicted SSB SNR descending within each tier
func sortWSPRPredictions(predictions []WSPRPredictionEntry) {
	predictionRank := map[string]int{
		"excellent":  0,
		"good":       1,
		"workable":   2,
		"marginal":   3,
		"poor":       4,
		"not_viable": 5,
	}

	// Simple insertion sort (list is typically small — bounded by ~250 DXCC × 12 bands)
	for i := 1; i < len(predictions); i++ {
		for j := i; j > 0; j-- {
			a := predictions[j-1]
			b := predictions[j]
			rankA := predictionRank[a.Prediction]
			rankB := predictionRank[b.Prediction]
			if rankA > rankB || (rankA == rankB && a.PredictedSSBSNR < b.PredictedSSBSNR) {
				predictions[j-1], predictions[j] = predictions[j], predictions[j-1]
			} else {
				break
			}
		}
	}
}
