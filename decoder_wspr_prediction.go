package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
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
//   summary        bool  If "true", return a lightweight grouped summary — no meta block.
//                        When summary=true the default min_ssb_snr is raised to +10 dB (Good+)
//                        so only realistically usable bands appear.
//   by             str   "country" (default) or "band" — controls grouping in summary mode.
//                        by=country: one entry per country, best band highlighted, all qualifying
//                          bands listed.  Shape: { country, continent, best_prediction,
//                          best_predicted_ssb_snr, bands:[{band,prediction,predicted_ssb_snr}] }
//                        by=band: one entry per band, all qualifying countries listed sorted by
//                          SNR descending.  Shape: { band, country_count, best_prediction,
//                          countries:[{country,continent,prediction,predicted_ssb_snr}] }
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
	250:  true,
	500:  true,
	1000: true,
}

// wsprSpotsCacheTTL is how long the raw spot slice is reused before the CSV
// files are re-read.  Two minutes matches the WSPR transmission cycle so the
// cache is always fresh enough for any lookback window a caller might request.
const wsprSpotsCacheTTL = 2 * time.Minute

// wsprSpotsCache holds the most-recently-fetched raw WSPR spot slice and the
// time it was populated.  It always covers yesterday + today (the widest
// possible window — up to 1440 minutes) so that requests with different
// 'minutes' values all share the same single cached slice.  Per-request
// filtering (band, timestamp window, min SNR) is applied in the handler after
// the cache lookup.  All fields are protected by mu.
var wsprSpotsCache struct {
	mu        sync.RWMutex
	spots     []SpotRecord
	fetchedAt time.Time
}

// getWSPRSpotsCached returns all WSPR spots for yesterday + today, reading
// from disk only when the cache is stale (older than wsprSpotsCacheTTL).
// Concurrent callers share a single disk read via double-checked locking.
func getWSPRSpotsCached(sl *SpotsLogger) ([]SpotRecord, error) {
	now := time.Now().UTC()
	// Always fetch yesterday + today so every possible 'minutes' window is covered.
	fromDate := now.AddDate(0, 0, -1).Format("2006-01-02")
	toDate := now.Format("2006-01-02")

	// Fast path — read lock only.
	wsprSpotsCache.mu.RLock()
	if time.Since(wsprSpotsCache.fetchedAt) < wsprSpotsCacheTTL {
		spots := wsprSpotsCache.spots
		wsprSpotsCache.mu.RUnlock()
		return spots, nil
	}
	wsprSpotsCache.mu.RUnlock()

	// Slow path — write lock with double-check.
	wsprSpotsCache.mu.Lock()
	defer wsprSpotsCache.mu.Unlock()

	// Another goroutine may have refreshed the cache while we waited for the lock.
	if time.Since(wsprSpotsCache.fetchedAt) < wsprSpotsCacheTTL {
		return wsprSpotsCache.spots, nil
	}

	spots, err := sl.GetHistoricalSpots(
		"WSPR", // mode
		"",     // band — fetch all, filter in handler
		"",     // name
		"",     // callsign
		"",     // locator
		"",     // continent
		"",     // direction
		fromDate,
		toDate,
		"",    // startTime
		"",    // endTime
		false, // deduplicate
		false, // locatorsOnly
		0,     // minDistanceKm
		-999,  // minSNR
	)
	if err != nil {
		return nil, err
	}

	wsprSpotsCache.spots = spots
	wsprSpotsCache.fetchedAt = time.Now()
	log.Printf("WSPR spots cache refreshed: %d spots for %s–%s", len(spots), fromDate, toDate)
	return spots, nil
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
	Lat             *float64 `json:"lat,omitempty"`               // CTY entity latitude (from best-SNR callsign lookup)
	Lon             *float64 `json:"lon,omitempty"`               // CTY entity longitude (from best-SNR callsign lookup)
}

// WSPRPredictionResponse is the full API response
type WSPRPredictionResponse struct {
	Meta        WSPRPredictionMeta    `json:"meta"`
	Predictions []WSPRPredictionEntry `json:"predictions"`
	GridSquares []WSPRGridSquareEntry `json:"grid_squares,omitempty"`
}

// ── Grid-square types ─────────────────────────────────────────────────────────

// WSPRGridSquareBandEntry is one band's quality for a specific 4-char grid square.
type WSPRGridSquareBandEntry struct {
	Band            string  `json:"band"`
	Prediction      string  `json:"prediction"`
	PredictedSSBSNR float64 `json:"predicted_ssb_snr"`
}

// WSPRGridSquareEntry aggregates all bands seen from a single 4-char Maidenhead
// grid square.  The map colour is driven by BestPrediction; the Bands list
// provides per-band detail for the hover tooltip.
type WSPRGridSquareEntry struct {
	Grid           string                    `json:"grid"` // 4-char Maidenhead (e.g. "IO91")
	Country        string                    `json:"country"`
	Continent      string                    `json:"continent"`
	BestPrediction string                    `json:"best_prediction"` // best quality across all bands
	BestSSBSNR     float64                   `json:"best_ssb_snr"`    // highest predicted SSB SNR across all bands
	Bands          []WSPRGridSquareBandEntry `json:"bands"`           // all bands heard, best-first
}

// ── Summary-mode types ────────────────────────────────────────────────────────

// WSPRSummaryBandEntry is one band within a by=country summary row.
type WSPRSummaryBandEntry struct {
	Band            string  `json:"band"`
	Prediction      string  `json:"prediction"`
	PredictedSSBSNR float64 `json:"predicted_ssb_snr"`
}

// WSPRSummaryByCountryEntry is one row in a by=country summary response.
type WSPRSummaryByCountryEntry struct {
	Country             string                 `json:"country"`
	Continent           string                 `json:"continent"`
	BestPrediction      string                 `json:"best_prediction"`
	BestPredictedSSBSNR float64                `json:"best_predicted_ssb_snr"`
	Bands               []WSPRSummaryBandEntry `json:"bands"`         // all qualifying bands, best-first
	Lat                 *float64               `json:"lat,omitempty"` // CTY entity latitude (from best-SNR callsign lookup)
	Lon                 *float64               `json:"lon,omitempty"` // CTY entity longitude (from best-SNR callsign lookup)
}

// WSPRSummaryByCountryResponse wraps the by=country summary list.
type WSPRSummaryByCountryResponse struct {
	Predictions []WSPRSummaryByCountryEntry `json:"predictions"`
	GridSquares []WSPRGridSquareEntry       `json:"grid_squares,omitempty"`
}

// WSPRSummaryCountryEntry is one country within a by=band summary row.
type WSPRSummaryCountryEntry struct {
	Country         string   `json:"country"`
	Continent       string   `json:"continent"`
	Prediction      string   `json:"prediction"`
	PredictedSSBSNR float64  `json:"predicted_ssb_snr"`
	Lat             *float64 `json:"lat,omitempty"` // CTY entity latitude (from best-SNR callsign lookup)
	Lon             *float64 `json:"lon,omitempty"` // CTY entity longitude (from best-SNR callsign lookup)
}

// WSPRSummaryByBandEntry is one row in a by=band summary response.
type WSPRSummaryByBandEntry struct {
	Band           string                    `json:"band"`
	CountryCount   int                       `json:"country_count"`
	BestPrediction string                    `json:"best_prediction"`
	Countries      []WSPRSummaryCountryEntry `json:"countries"` // sorted by predicted_ssb_snr desc
}

// WSPRSummaryByBandResponse wraps the by=band summary list.
type WSPRSummaryByBandResponse struct {
	Predictions []WSPRSummaryByBandEntry `json:"predictions"`
	GridSquares []WSPRGridSquareEntry    `json:"grid_squares,omitempty"`
}

// WSPRSummaryResult holds both the by-band predictions and the grid-square
// overlay data returned by computeWSPRSummaryByBand.
type WSPRSummaryResult struct {
	Predictions []WSPRSummaryByBandEntry
	GridSquares []WSPRGridSquareEntry
}

// computeWSPRSummaryByBand computes the by=band SSB phone prediction summary
// using the shared spot cache.  It is safe to call from any goroutine.
//
// Parameters:
//
//	sl           – SpotsLogger used to read WSPR spot CSV files (must not be nil)
//	phonePowerW  – assumed SSB TX power in watts (must be in validPhonePowers)
//	minutes      – lookback window in minutes (1–1440)
//
// Returns nil when there are no qualifying spots so callers can use nil as a
// sentinel for "no data" and omit the field from JSON.
func computeWSPRSummaryByBand(sl *SpotsLogger, phonePowerW, minutes int) *WSPRSummaryResult {
	now := time.Now().UTC()
	windowStart := now.Add(-time.Duration(minutes) * time.Minute)
	phonePowerDbm := wattsTodBm(phonePowerW)
	minSSBSNR := 10.0 // same default as summary mode in the HTTP handler

	spots, err := getWSPRSpotsCached(sl)
	if err != nil || len(spots) == 0 {
		return nil
	}

	type groupKey struct {
		Country string
		Band    string
	}
	type groupData struct {
		SNRSum       float64
		TxDbmSum     float64
		SpotCount    int
		Continent    string
		BestCallsign string
		BestSNR      int
		BestSNRSet   bool
	}

	groups := make(map[groupKey]*groupData)
	gridGroups := make(map[gridBandKey]*gridBandData) // parallel grid-square accumulator

	for _, spot := range spots {
		ts, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil || ts.Before(windowStart) {
			continue
		}
		if spot.DBm == nil || spot.Country == "" {
			continue
		}
		k := groupKey{Country: spot.Country, Band: spot.Band}
		g, ok := groups[k]
		if !ok {
			g = &groupData{Continent: spot.Continent}
			groups[k] = g
		}
		g.SNRSum += float64(spot.SNR)
		g.TxDbmSum += float64(*spot.DBm)
		g.SpotCount++
		if !g.BestSNRSet || spot.SNR > g.BestSNR {
			g.BestSNR = spot.SNR
			g.BestCallsign = spot.Callsign
			g.BestSNRSet = true
		}

		// Parallel grid-square accumulation
		if len(spot.Locator) >= 4 {
			gk := gridBandKey{
				Grid:    strings.ToUpper(spot.Locator[:4]),
				Band:    spot.Band,
				Country: spot.Country,
			}
			gg, ok := gridGroups[gk]
			if !ok {
				gg = &gridBandData{Continent: spot.Continent}
				gridGroups[gk] = gg
			}
			gg.SNRSum += float64(spot.SNR)
			gg.TxDbmSum += float64(*spot.DBm)
			gg.SpotCount++
		}
	}

	if len(groups) == 0 {
		return nil
	}

	// Build flat prediction list, applying the same SNR filter as summary mode.
	type flatEntry struct {
		Country         string
		Continent       string
		Band            string
		PredictedSSBSNR float64
		Prediction      string
		BestCallsign    string
	}
	var flat []flatEntry
	for k, g := range groups {
		if g.SpotCount == 0 {
			continue
		}
		meanWSPRSNR := g.SNRSum / float64(g.SpotCount)
		meanTxDbm := g.TxDbmSum / float64(g.SpotCount)
		predictedSSBSNR := meanWSPRSNR + (phonePowerDbm - meanTxDbm) - bwCorrectionDB
		if predictedSSBSNR < minSSBSNR {
			continue
		}
		flat = append(flat, flatEntry{
			Country:         k.Country,
			Continent:       g.Continent,
			Band:            k.Band,
			PredictedSSBSNR: math.Round(predictedSSBSNR*10) / 10,
			Prediction:      classifyPrediction(predictedSSBSNR),
			BestCallsign:    g.BestCallsign,
		})
	}

	if len(flat) == 0 {
		return nil
	}

	predRank := map[string]int{
		"excellent": 0, "good": 1, "workable": 2,
		"marginal": 3, "poor": 4, "not_viable": 5,
	}

	// Group by band.
	bandOrder := []string{"2200m", "630m", "160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"}
	type bandAcc struct {
		bestPrediction string
		countries      []WSPRSummaryCountryEntry
	}
	byBand := make(map[string]*bandAcc)
	for _, e := range flat {
		acc, ok := byBand[e.Band]
		if !ok {
			acc = &bandAcc{bestPrediction: e.Prediction}
			byBand[e.Band] = acc
		}
		entry := WSPRSummaryCountryEntry{
			Country:         e.Country,
			Continent:       e.Continent,
			Prediction:      e.Prediction,
			PredictedSSBSNR: e.PredictedSSBSNR,
		}
		if e.BestCallsign != "" {
			if ctyInfo := GetCallsignInfo(e.BestCallsign); ctyInfo != nil {
				lat := ctyInfo.Latitude
				lon := ctyInfo.Longitude
				entry.Lat = &lat
				entry.Lon = &lon
			}
		}
		acc.countries = append(acc.countries, entry)
		if predRank[e.Prediction] < predRank[acc.bestPrediction] {
			acc.bestPrediction = e.Prediction
		}
	}

	result := make([]WSPRSummaryByBandEntry, 0, len(byBand))
	for _, b := range bandOrder {
		acc, ok := byBand[b]
		if !ok {
			continue
		}
		sort.Slice(acc.countries, func(i, j int) bool {
			ri, rj := predRank[acc.countries[i].Prediction], predRank[acc.countries[j].Prediction]
			if ri != rj {
				return ri < rj
			}
			return acc.countries[i].PredictedSSBSNR > acc.countries[j].PredictedSSBSNR
		})
		result = append(result, WSPRSummaryByBandEntry{
			Band:           b,
			CountryCount:   len(acc.countries),
			BestPrediction: acc.bestPrediction,
			Countries:      acc.countries,
		})
	}

	if len(result) == 0 {
		return nil
	}
	return &WSPRSummaryResult{
		Predictions: result,
		GridSquares: buildWSPRGridSquaresTyped(gridGroups, phonePowerDbm),
	}
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
				"error": "phone_power_w must be one of: 10, 50, 100, 250, 500, 1000",
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

	// summary: if "true", return a lightweight grouped summary — no meta block.
	// When summary mode is active the default min_ssb_snr is raised to +10 dB
	// (Good+) so the list only contains bands that are realistically usable.
	summaryMode := r.URL.Query().Get("summary") == "true"

	// by: grouping dimension for summary mode — "country" (default) or "band".
	// Ignored when summary=false.
	summaryBy := r.URL.Query().Get("by")
	if summaryBy == "" {
		summaryBy = "country"
	}
	if summaryMode && summaryBy != "country" && summaryBy != "band" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "by must be 'country' or 'band'",
		})
		return
	}

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

	// ── Determine the exact timestamp window for in-memory filtering ──────────
	// The cache always holds yesterday + today (the widest possible range).
	// windowStart is used below to trim spots to the caller's requested window.
	now := time.Now().UTC()
	windowStart := now.Add(-time.Duration(minutes) * time.Minute)

	// ── Fetch WSPR spots (cached) ─────────────────────────────────────────────
	// Raw spots for yesterday + today are cached for wsprSpotsCacheTTL (2 min).
	// All requests — regardless of their 'minutes' window — share this one slice.
	// Per-request filtering (band, timestamp window, min SNR) is applied below.
	spots, err := getWSPRSpotsCached(md.spotsLogger)
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

	// Parallel grouping by grid4+band+country for the map grid-square layer.
	// Each entry accumulates SNR/TxDbm independently so we can compute a
	// per-grid-square predicted SSB SNR that is then aggregated across bands.
	// gridBandKey and gridBandData are defined at package level.

	groups := make(map[groupKey]*groupData)
	gridBandGroups := make(map[gridBandKey]*gridBandData)
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

		// ── Parallel grid-square grouping ─────────────────────────────────────
		// Only accumulate spots that have a valid 4-char locator prefix and a
		// resolved country (same guard as the main prediction path).
		if len(spot.Locator) >= 4 && spot.Country != "" {
			gk := gridBandKey{
				Grid:    strings.ToUpper(spot.Locator[:4]),
				Band:    spot.Band,
				Country: spot.Country,
			}
			gg, ok := gridBandGroups[gk]
			if !ok {
				gg = &gridBandData{Continent: spot.Continent}
				gridBandGroups[gk] = gg
			}
			gg.SNRSum += float64(spot.SNR)
			gg.TxDbmSum += float64(*spot.DBm)
			gg.SpotCount++
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
		if g.BestCallsign != "" {
			if ctyInfo := GetCallsignInfo(g.BestCallsign); ctyInfo != nil {
				lat := ctyInfo.Latitude
				lon := ctyInfo.Longitude
				entry.Lat = &lat
				entry.Lon = &lon
			}
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

	// ── Summary mode ─────────────────────────────────────────────────────────
	if summaryMode {
		predRank := map[string]int{
			"excellent": 0, "good": 1, "workable": 2,
			"marginal": 3, "poor": 4, "not_viable": 5,
		}

		if summaryBy == "country" {
			// Group by country — one entry per country, all qualifying bands listed.
			type countryAcc struct {
				continent           string
				bestPrediction      string
				bestPredictedSSBSNR float64
				bands               []WSPRSummaryBandEntry
			}
			byCountry := make(map[string]*countryAcc)
			for _, p := range predictions {
				acc, ok := byCountry[p.Country]
				if !ok {
					acc = &countryAcc{
						continent:           p.Continent,
						bestPrediction:      p.Prediction,
						bestPredictedSSBSNR: p.PredictedSSBSNR,
					}
					byCountry[p.Country] = acc
				}
				acc.bands = append(acc.bands, WSPRSummaryBandEntry{
					Band:            p.Band,
					Prediction:      p.Prediction,
					PredictedSSBSNR: p.PredictedSSBSNR,
				})
				if predRank[p.Prediction] < predRank[acc.bestPrediction] ||
					(predRank[p.Prediction] == predRank[acc.bestPrediction] && p.PredictedSSBSNR > acc.bestPredictedSSBSNR) {
					acc.bestPrediction = p.Prediction
					acc.bestPredictedSSBSNR = p.PredictedSSBSNR
				}
			}

			// Build result slice, sort bands within each country best-first
			// Track best callsign per country for CTY lat/lon lookup
			type countryBestCallsign struct {
				callsign string
				snr      float64
				set      bool
			}
			bestCallsignByCountry := make(map[string]*countryBestCallsign)
			for _, p := range predictions {
				bc, ok := bestCallsignByCountry[p.Country]
				if !ok {
					bc = &countryBestCallsign{}
					bestCallsignByCountry[p.Country] = bc
				}
				if p.BestCallsign != "" && (!bc.set || p.MeanWSPRSNR > bc.snr) {
					bc.callsign = p.BestCallsign
					bc.snr = p.MeanWSPRSNR
					bc.set = true
				}
			}

			result := make([]WSPRSummaryByCountryEntry, 0, len(byCountry))
			for country, acc := range byCountry {
				sort.Slice(acc.bands, func(i, j int) bool {
					ri, rj := predRank[acc.bands[i].Prediction], predRank[acc.bands[j].Prediction]
					if ri != rj {
						return ri < rj
					}
					return acc.bands[i].PredictedSSBSNR > acc.bands[j].PredictedSSBSNR
				})
				countryEntry := WSPRSummaryByCountryEntry{
					Country:             country,
					Continent:           acc.continent,
					BestPrediction:      acc.bestPrediction,
					BestPredictedSSBSNR: acc.bestPredictedSSBSNR,
					Bands:               acc.bands,
				}
				if bc, ok := bestCallsignByCountry[country]; ok && bc.set && bc.callsign != "" {
					if ctyInfo := GetCallsignInfo(bc.callsign); ctyInfo != nil {
						lat := ctyInfo.Latitude
						lon := ctyInfo.Longitude
						countryEntry.Lat = &lat
						countryEntry.Lon = &lon
					}
				}
				result = append(result, countryEntry)
			}
			// Sort countries: best prediction first, then by best SNR descending
			sort.Slice(result, func(i, j int) bool {
				ri, rj := predRank[result[i].BestPrediction], predRank[result[j].BestPrediction]
				if ri != rj {
					return ri < rj
				}
				return result[i].BestPredictedSSBSNR > result[j].BestPredictedSSBSNR
			})

			w.WriteHeader(http.StatusOK)
			if err := json.NewEncoder(w).Encode(WSPRSummaryByCountryResponse{
				Predictions: result,
				GridSquares: buildWSPRGridSquaresTyped(gridBandGroups, phonePowerDbm),
			}); err != nil {
				log.Printf("WSPR prediction summary by=country: error encoding response: %v", err)
			}
			return
		}

		// by=band: one entry per band, all qualifying countries listed sorted by SNR desc.
		// Use the canonical band order so bands appear in frequency order.
		bandOrder := []string{"2200m", "630m", "160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"}
		type bandAcc struct {
			bestPrediction string
			countries      []WSPRSummaryCountryEntry
		}
		byBand := make(map[string]*bandAcc)
		for _, p := range predictions {
			acc, ok := byBand[p.Band]
			if !ok {
				acc = &bandAcc{bestPrediction: p.Prediction}
				byBand[p.Band] = acc
			}
			countryEntry := WSPRSummaryCountryEntry{
				Country:         p.Country,
				Continent:       p.Continent,
				Prediction:      p.Prediction,
				PredictedSSBSNR: p.PredictedSSBSNR,
			}
			if p.BestCallsign != "" {
				if ctyInfo := GetCallsignInfo(p.BestCallsign); ctyInfo != nil {
					lat := ctyInfo.Latitude
					lon := ctyInfo.Longitude
					countryEntry.Lat = &lat
					countryEntry.Lon = &lon
				}
			}
			acc.countries = append(acc.countries, countryEntry)
			if predRank[p.Prediction] < predRank[acc.bestPrediction] {
				acc.bestPrediction = p.Prediction
			}
		}

		result := make([]WSPRSummaryByBandEntry, 0, len(byBand))
		for _, b := range bandOrder {
			acc, ok := byBand[b]
			if !ok {
				continue
			}
			sort.Slice(acc.countries, func(i, j int) bool {
				ri, rj := predRank[acc.countries[i].Prediction], predRank[acc.countries[j].Prediction]
				if ri != rj {
					return ri < rj
				}
				return acc.countries[i].PredictedSSBSNR > acc.countries[j].PredictedSSBSNR
			})
			result = append(result, WSPRSummaryByBandEntry{
				Band:           b,
				CountryCount:   len(acc.countries),
				BestPrediction: acc.bestPrediction,
				Countries:      acc.countries,
			})
		}

		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(WSPRSummaryByBandResponse{
			Predictions: result,
			GridSquares: buildWSPRGridSquaresTyped(gridBandGroups, phonePowerDbm),
		}); err != nil {
			log.Printf("WSPR prediction summary by=band: error encoding response: %v", err)
		}
		return
	}

	resp := WSPRPredictionResponse{
		Meta:        meta,
		Predictions: predictions,
		GridSquares: buildWSPRGridSquaresTyped(gridBandGroups, phonePowerDbm),
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("WSPR prediction: error encoding response: %v", err)
	}
}

// gridBandKey is the map key for the parallel grid-square accumulator.
// Defined at package level so buildWSPRGridSquaresTyped can reference it.
type gridBandKey struct {
	Grid    string
	Band    string
	Country string
}

// gridBandData accumulates SNR/TxDbm per grid+band+country group.
type gridBandData struct {
	SNRSum    float64
	TxDbmSum  float64
	SpotCount int
	Continent string
}

// buildWSPRGridSquaresTyped converts the parallel grid+band+country accumulator
// into a sorted []WSPRGridSquareEntry for the map overlay.
//
// Each WSPRGridSquareEntry represents one 4-char Maidenhead grid square.
// BestPrediction / BestSSBSNR reflect the best quality across all bands heard
// from that square; Bands lists every band with its individual quality.
func buildWSPRGridSquaresTyped(groups map[gridBandKey]*gridBandData, phonePowerDbm float64) []WSPRGridSquareEntry {
	if len(groups) == 0 {
		return nil
	}

	predRank := map[string]int{
		"excellent": 0, "good": 1, "workable": 2,
		"marginal": 3, "poor": 4, "not_viable": 5,
	}

	// Aggregate by grid square across bands.
	type gridAcc struct {
		country        string
		continent      string
		bestPrediction string
		bestSSBSNR     float64
		bands          map[string]WSPRGridSquareBandEntry // band → best entry for that band
	}
	byGrid := make(map[string]*gridAcc)

	bandOrder := []string{"2200m", "630m", "160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m"}

	for gk, gg := range groups {
		if gg.SpotCount == 0 {
			continue
		}
		meanWSPR := gg.SNRSum / float64(gg.SpotCount)
		meanTx := gg.TxDbmSum / float64(gg.SpotCount)
		snr := math.Round((meanWSPR+(phonePowerDbm-meanTx)-bwCorrectionDB)*10) / 10
		pred := classifyPrediction(snr)

		acc, ok := byGrid[gk.Grid]
		if !ok {
			acc = &gridAcc{
				country:        gk.Country,
				continent:      gg.Continent,
				bestPrediction: pred,
				bestSSBSNR:     snr,
				bands:          make(map[string]WSPRGridSquareBandEntry),
			}
			byGrid[gk.Grid] = acc
		}

		// Keep best SNR per band for this grid square (a grid may be heard by
		// multiple transmitters on the same band — keep the strongest).
		existing, hasBand := acc.bands[gk.Band]
		if !hasBand || snr > existing.PredictedSSBSNR {
			acc.bands[gk.Band] = WSPRGridSquareBandEntry{
				Band:            gk.Band,
				Prediction:      pred,
				PredictedSSBSNR: snr,
			}
		}

		// Update best across all bands
		if predRank[pred] < predRank[acc.bestPrediction] ||
			(predRank[pred] == predRank[acc.bestPrediction] && snr > acc.bestSSBSNR) {
			acc.bestPrediction = pred
			acc.bestSSBSNR = snr
		}
	}

	if len(byGrid) == 0 {
		return nil
	}

	result := make([]WSPRGridSquareEntry, 0, len(byGrid))
	for grid, acc := range byGrid {
		// Build sorted bands slice (canonical band order)
		bands := make([]WSPRGridSquareBandEntry, 0, len(acc.bands))
		for _, b := range bandOrder {
			if entry, ok := acc.bands[b]; ok {
				bands = append(bands, entry)
			}
		}
		result = append(result, WSPRGridSquareEntry{
			Grid:           grid,
			Country:        acc.country,
			Continent:      acc.continent,
			BestPrediction: acc.bestPrediction,
			BestSSBSNR:     acc.bestSSBSNR,
			Bands:          bands,
		})
	}

	// Sort by best prediction tier, then by best SNR descending
	sort.Slice(result, func(i, j int) bool {
		ri, rj := predRank[result[i].BestPrediction], predRank[result[j].BestPrediction]
		if ri != rj {
			return ri < rj
		}
		return result[i].BestSSBSNR > result[j].BestSSBSNR
	})

	return result
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
