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
//
// Physics:
//   wsprd reports SNR normalised to a 2500 Hz reference bandwidth (it internally
//   subtracts 26.3 dB from the raw in-band SNR before writing the spot file).
//   SSB phone occupies ~2700 Hz noise bandwidth.
//   BW correction = 10 * log10(2700/2500) ≈ +0.35 dB  (negligible but included)
//
//   WSPR uses coherent FSK + FEC and can decode down to ≈ −31 dB SNR (2500 Hz ref).
//   A human ear needs ≈ +10 dB SNR (2500 Hz ref) to copy SSB phone.
//   This gives a WSPR coding advantage of ≈ 41 dB that must be subtracted.
//
//   Predicted SSB SNR = WSPR_SNR + BW_correction − coding_advantage + (phone_power_dbm − wspr_tx_dbm)
//
//   Prediction categories:
//     "good"     predicted SSB SNR ≥ +10 dB
//     "marginal" predicted SSB SNR ≥   0 dB
//     "poor"     predicted SSB SNR <   0 dB

const (
	// wsprRefBWHz is the reference noise bandwidth that wsprd normalises its SNR to.
	// wsprd internally subtracts 10*log10(wsprSignalBW/wsprRefBWHz) ≈ 26.3 dB from
	// the raw in-band SNR, so the reported value is already a 2500 Hz SNR.
	wsprRefBWHz = 2500.0
	// ssbNoiseBWHz is the effective noise bandwidth of an SSB phone signal (~2700 Hz)
	ssbNoiseBWHz = 2700.0

	// wsprMinDecodeSNR is the minimum SNR (in 2500 Hz BW) at which wsprd can decode.
	// wsprd uses coherent FSK + FEC; empirically decodes down to ≈ −31 dB SNR.
	wsprMinDecodeSNR = -31.0
	// ssbMinCopySNR is the minimum SNR (in 2500 Hz BW) at which a human can copy SSB phone.
	// Typically ≈ +10 dB for comfortable copy; some operators manage at +6 dB.
	ssbMinCopySNR = 10.0
	// wsprCodingAdvantageDB is the SNR advantage WSPR has over SSB phone.
	// = ssbMinCopySNR − wsprMinDecodeSNR = 10 − (−31) = 41 dB
	// This must be SUBTRACTED from the WSPR SNR when predicting SSB viability.
	wsprCodingAdvantageDB = ssbMinCopySNR - wsprMinDecodeSNR // = 41 dB
)

// bwCorrectionDB is the small bandwidth correction to convert the wsprd 2500 Hz
// reference SNR to the equivalent SNR in a 2700 Hz SSB phone bandwidth.
// = 10 * log10(2700 / 2500) ≈ +0.35 dB  (negligible but included for correctness)
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
	PhonePowerW       int       `json:"phone_power_w"`
	PhonePowerDbm     float64   `json:"phone_power_dbm"`
	BWCorrectionDB    float64   `json:"bw_correction_db"`    // ≈+0.35 dB (2500→2700 Hz)
	CodingAdvantageDB float64   `json:"coding_advantage_db"` // 41 dB (WSPR vs SSB phone)
	Minutes           int       `json:"minutes"`
	BandFilter        string    `json:"band_filter"`
	BandsAvailable    []string  `json:"bands_available"`
	SpotCount         int       `json:"spot_count"`
	GeneratedAt       time.Time `json:"generated_at"`
	ReceiverLocator   string    `json:"receiver_locator,omitempty"`
	ReceiverLat       *float64  `json:"receiver_lat,omitempty"`
	ReceiverLon       *float64  `json:"receiver_lon,omitempty"`
	ReceiverCallsign  string    `json:"receiver_callsign,omitempty"`
}

// WSPRPredictionEntry holds the prediction result for a single country+band combination
type WSPRPredictionEntry struct {
	Country           string   `json:"country"`
	Continent         string   `json:"continent"`
	Band              string   `json:"band"`
	MeanWSPRSNR       float64  `json:"mean_wspr_snr"`       // mean WSPR SNR across all spots (normalised to 2500 Hz by wsprd)
	MeanTxDbm         float64  `json:"mean_tx_dbm"`         // mean reported TX power across all spots
	BWCorrectionDB    float64  `json:"bw_correction_db"`    // ≈+0.35 dB: converts wsprd 2500 Hz SNR to 2700 Hz SSB equivalent
	CodingAdvantageDB float64  `json:"coding_advantage_db"` // 41 dB: WSPR decodes at −31 dB; SSB needs +10 dB
	PhonePowerDbm     float64  `json:"phone_power_dbm"`
	PowerGainDB       float64  `json:"power_gain_db"`     // phone_power_dbm − mean_tx_dbm
	PredictedSSBSNR   float64  `json:"predicted_ssb_snr"` // mean_wspr_snr + bw_correction − coding_advantage + power_gain
	Prediction        string   `json:"prediction"`
	SpotCount         int      `json:"spot_count"`
	LastSeen          string   `json:"last_seen"`
	Locator           string   `json:"locator,omitempty"`
	DistanceKm        *float64 `json:"distance_km,omitempty"`
	BearingDeg        *float64 `json:"bearing_deg,omitempty"`
}

// WSPRPredictionResponse is the full API response
type WSPRPredictionResponse struct {
	Meta        WSPRPredictionMeta    `json:"meta"`
	Predictions []WSPRPredictionEntry `json:"predictions"`
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

	// min_ssb_snr: -60–30, default -60 (show everything)
	minSSBSNR := -60.0
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
		SNRSum     float64 // sum of WSPR SNR values (in ~6 Hz BW)
		TxDbmSum   float64 // sum of reported TX power in dBm
		SpotCount  int
		LastSeen   string
		Locator    string // locator of the most recent spot (for map placement)
		DistanceKm *float64
		BearingDeg *float64
		Continent  string
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

		// Correct formula:
		//   predicted_ssb_snr = mean_wspr_snr + bw_correction − coding_advantage + power_gain
		//
		// Where:
		//   mean_wspr_snr      = mean WSPR SNR normalised to 2500 Hz (wsprd does this internally)
		//   bw_correction      = +0.35 dB (2500→2700 Hz; negligible but included for correctness)
		//   coding_advantage   = 41 dB (WSPR decodes at −31 dB; SSB phone needs +10 dB)
		//   power_gain         = phone_power_dbm − mean_tx_dbm (your power vs their power)
		meanWSPRSNR := g.SNRSum / float64(g.SpotCount)
		meanTxDbm := g.TxDbmSum / float64(g.SpotCount)
		powerGainDB := phonePowerDbm - meanTxDbm
		predictedSSBSNR := meanWSPRSNR + bwCorrectionDB - wsprCodingAdvantageDB + powerGainDB

		// Apply min_ssb_snr filter
		if predictedSSBSNR < minSSBSNR {
			continue
		}

		entry := WSPRPredictionEntry{
			Country:           k.Country,
			Continent:         g.Continent,
			Band:              k.Band,
			MeanWSPRSNR:       math.Round(meanWSPRSNR*10) / 10,
			MeanTxDbm:         math.Round(meanTxDbm*10) / 10,
			BWCorrectionDB:    math.Round(bwCorrectionDB*100) / 100,
			CodingAdvantageDB: wsprCodingAdvantageDB,
			PhonePowerDbm:     math.Round(phonePowerDbm*10) / 10,
			PowerGainDB:       math.Round(powerGainDB*10) / 10,
			PredictedSSBSNR:   math.Round(predictedSSBSNR*10) / 10,
			Prediction:        classifyPrediction(predictedSSBSNR),
			SpotCount:         g.SpotCount,
			LastSeen:          g.LastSeen,
			Locator:           g.Locator,
			DistanceKm:        g.DistanceKm,
			BearingDeg:        g.BearingDeg,
		}
		predictions = append(predictions, entry)
	}

	// Sort predictions: good first, then marginal, then poor; within each group by predicted SNR descending
	sortWSPRPredictions(predictions)

	// ── Build response ────────────────────────────────────────────────────────
	meta := WSPRPredictionMeta{
		PhonePowerW:       phonePowerW,
		PhonePowerDbm:     math.Round(phonePowerDbm*10) / 10,
		BWCorrectionDB:    math.Round(bwCorrectionDB*100) / 100,
		CodingAdvantageDB: wsprCodingAdvantageDB,
		Minutes:           minutes,
		BandFilter:        band,
		BandsAvailable:    bandsAvailable,
		SpotCount:         totalFiltered,
		GeneratedAt:       now,
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
