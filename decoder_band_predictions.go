package main

import (
	"fmt"
	"log"
	"sort"
	"time"
)

// BandPrediction represents a predicted band opening with space weather context
type BandPrediction struct {
	Band                string  `json:"band"`
	OpensAtUTC          int     `json:"opens_at_utc"`          // UTC hour (0-23)
	OpensAtLocal        string  `json:"opens_at_local"`        // Local time string
	HoursUntil          int     `json:"hours_until"`           // Hours until opening
	HistoricalSpots     int     `json:"historical_spots"`      // Spots seen during this hour historically
	HistoricalCallsigns int     `json:"historical_callsigns"`  // Unique callsigns seen
	HistoricalKIndex    float64 `json:"historical_k_index"`    // Average K-index during historical periods
	HistoricalSolarFlux float64 `json:"historical_solar_flux"` // Average solar flux during historical periods
	CurrentKIndex       int     `json:"current_k_index"`       // Current K-index
	CurrentSolarFlux    float64 `json:"current_solar_flux"`    // Current solar flux
	ConditionsSimilar   bool    `json:"conditions_similar"`    // Whether current conditions are similar to historical
	ConditionsNote      string  `json:"conditions_note"`       // Human-readable note about conditions
	HistoricalSamples   int     `json:"historical_samples"`    // Number of historical data points used
	ConfidenceScore     int     `json:"confidence_score"`      // Confidence score 0-100 based on spots and weather similarity
	ConfidenceLevel     string  `json:"confidence_level"`      // Human-readable: "Low", "Medium", "High"
}

// BandPredictionsResponse represents the API response for band predictions
type BandPredictionsResponse struct {
	CurrentTime struct {
		UTC   string `json:"utc"`
		Local string `json:"local"`
		Hour  int    `json:"hour"` // Current UTC hour
	} `json:"current_time"`
	CurrentSpaceWeather struct {
		KIndex    int     `json:"k_index"`
		SolarFlux float64 `json:"solar_flux"`
		Quality   string  `json:"quality"`
	} `json:"current_space_weather"`
	Predictions []BandPrediction `json:"predictions"`
	TimeRange   struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Hours int    `json:"hours"`
	} `json:"time_range"`
	Filters struct {
		Country   string `json:"country,omitempty"`
		Continent string `json:"continent,omitempty"`
		Mode      string `json:"mode,omitempty"`
	} `json:"filters"`
}

// GetBandPredictions generates band opening predictions with space weather context
func GetBandPredictions(
	spotsLogger *SpotsLogger,
	spaceWeatherMonitor *SpaceWeatherMonitor,
	filterCountry, filterContinent, filterMode string,
	hours int,
) (*BandPredictionsResponse, error) {

	if spotsLogger == nil || !spotsLogger.enabled {
		return nil, fmt.Errorf("spots logging is not enabled")
	}

	if spaceWeatherMonitor == nil {
		return nil, fmt.Errorf("space weather monitoring is not available")
	}

	now := time.Now()
	currentUTCHour := now.UTC().Hour()

	// Get current space weather
	currentSpaceWeather := spaceWeatherMonitor.GetData()
	if currentSpaceWeather == nil {
		return nil, fmt.Errorf("current space weather data not available")
	}

	// Get historical spots analytics
	analytics, err := spotsLogger.GetSpotsAnalytics(filterCountry, filterContinent, filterMode, "", -999, hours)
	if err != nil {
		return nil, fmt.Errorf("failed to get spots analytics: %w", err)
	}

	// Build response
	response := &BandPredictionsResponse{}
	response.CurrentTime.UTC = now.UTC().Format(time.RFC3339)
	response.CurrentTime.Local = now.Format(time.RFC3339)
	response.CurrentTime.Hour = currentUTCHour
	response.CurrentSpaceWeather.KIndex = currentSpaceWeather.KIndex
	response.CurrentSpaceWeather.SolarFlux = currentSpaceWeather.SolarFlux
	response.CurrentSpaceWeather.Quality = currentSpaceWeather.PropagationQuality
	response.TimeRange.From = analytics.TimeRange.From
	response.TimeRange.To = analytics.TimeRange.To
	response.TimeRange.Hours = analytics.TimeRange.Hours
	response.Filters.Country = filterCountry
	response.Filters.Continent = filterContinent
	response.Filters.Mode = filterMode

	// OPTIMIZATION: Collect all unique hours needed for predictions first
	uniqueHours := make(map[int]bool)
	type bandInfo struct {
		band         string
		nextHour     int
		hoursUntil   int
		spotsForHour int
		callsigns    int
	}
	bandsToProcess := make([]bandInfo, 0)

	// First pass: identify all bands and their opening hours
	for _, country := range analytics.ByCountry {
		for _, band := range country.Bands {
			// Find next opening hour for this band
			nextHour := findNextActiveHour(band.HourlyDistribution, currentUTCHour)
			if nextHour == -1 {
				continue // No future activity for this band
			}

			// Calculate hours until opening
			hoursUntil := nextHour - currentUTCHour
			if hoursUntil < 0 {
				hoursUntil += 24
			}

			// Skip if already active (hoursUntil == 0)
			if hoursUntil == 0 {
				continue
			}

			// Get spot count for this hour
			hourKey := fmt.Sprintf("%02d", nextHour)
			spotsForHour := band.HourlyDistribution[hourKey]

			// Track this hour for space weather lookup
			uniqueHours[nextHour] = true

			// Store band info for second pass
			bandsToProcess = append(bandsToProcess, bandInfo{
				band:         band.Band,
				nextHour:     nextHour,
				hoursUntil:   hoursUntil,
				spotsForHour: spotsForHour,
				callsigns:    band.UniqueCallsigns,
			})
		}
	}

	// OPTIMIZATION: Fetch space weather for ALL unique hours in ONE call
	spaceWeatherCache := getHistoricalSpaceWeatherForHours(
		spaceWeatherMonitor,
		uniqueHours,
		hours,
	)

	// Second pass: build predictions using cached space weather data
	predictions := make([]BandPrediction, 0)
	for _, info := range bandsToProcess {
		// Get cached space weather for this hour
		swData, exists := spaceWeatherCache[info.nextHour]
		if !exists {
			// No space weather data for this hour, use zeros
			swData = spaceWeatherData{avgKIndex: 0, avgSolarFlux: 0, samples: 0}
		}

		// Compare conditions
		conditionsSimilar, conditionsNote := compareSpaceWeatherConditions(
			currentSpaceWeather.KIndex,
			currentSpaceWeather.SolarFlux,
			swData.avgKIndex,
			swData.avgSolarFlux,
		)

		// Calculate confidence score
		confidenceScore, confidenceLevel := calculateConfidenceScore(
			info.spotsForHour,
			conditionsSimilar,
		)

		// Convert UTC hour to local time
		localTime := utcHourToLocalTimeString(info.nextHour)

		prediction := BandPrediction{
			Band:                info.band,
			OpensAtUTC:          info.nextHour,
			OpensAtLocal:        localTime,
			HoursUntil:          info.hoursUntil,
			HistoricalSpots:     info.spotsForHour,
			HistoricalCallsigns: info.callsigns,
			HistoricalKIndex:    swData.avgKIndex,
			HistoricalSolarFlux: swData.avgSolarFlux,
			CurrentKIndex:       currentSpaceWeather.KIndex,
			CurrentSolarFlux:    currentSpaceWeather.SolarFlux,
			ConditionsSimilar:   conditionsSimilar,
			ConditionsNote:      conditionsNote,
			HistoricalSamples:   swData.samples,
			ConfidenceScore:     confidenceScore,
			ConfidenceLevel:     confidenceLevel,
		}

		predictions = append(predictions, prediction)
	}

	// Remove duplicate bands (keep the one with soonest opening)
	predictions = deduplicatePredictions(predictions)

	// Sort by hours until opening (soonest first)
	sort.Slice(predictions, func(i, j int) bool {
		return predictions[i].HoursUntil < predictions[j].HoursUntil
	})

	// Limit to top 5 predictions
	if len(predictions) > 5 {
		predictions = predictions[:5]
	}

	response.Predictions = predictions

	return response, nil
}

// findNextActiveHour finds the next hour after currentHour that has activity
// Returns -1 if no future activity found
func findNextActiveHour(hourlyDist map[string]int, currentHour int) int {
	// Check hours after current hour (same day)
	for hour := currentHour + 1; hour < 24; hour++ {
		hourKey := fmt.Sprintf("%02d", hour)
		if hourlyDist[hourKey] > 0 {
			return hour
		}
	}

	// Check hours from start of day up to current hour (next day)
	for hour := 0; hour <= currentHour; hour++ {
		hourKey := fmt.Sprintf("%02d", hour)
		if hourlyDist[hourKey] > 0 {
			return hour
		}
	}

	return -1 // No activity found
}

// spaceWeatherData holds cached space weather averages for an hour
type spaceWeatherData struct {
	avgKIndex    float64
	avgSolarFlux float64
	samples      int
}

// getHistoricalSpaceWeatherForHours gets average space weather for multiple UTC hours
// in a single efficient operation. This is much faster than calling per-hour.
func getHistoricalSpaceWeatherForHours(
	swm *SpaceWeatherMonitor,
	targetHours map[int]bool,
	daysBack int,
) map[int]spaceWeatherData {

	result := make(map[int]spaceWeatherData)

	if swm == nil || !swm.config.LogToCSV {
		return result
	}

	if len(targetHours) == 0 {
		return result
	}

	now := time.Now()
	toDate := now.Format("2006-01-02")
	fromDate := now.AddDate(0, 0, -daysBack).Format("2006-01-02")

	// Get historical space weather data ONCE for all hours
	historicalData, err := swm.GetHistoricalData(fromDate, toDate, "", "", "")
	if err != nil {
		log.Printf("Warning: Failed to get historical space weather: %v", err)
		return result
	}

	// Accumulate data per hour
	type accumulator struct {
		totalKIndex    float64
		totalSolarFlux float64
		count          int
	}
	hourAccumulators := make(map[int]*accumulator)

	// Initialize accumulators for target hours
	for hour := range targetHours {
		hourAccumulators[hour] = &accumulator{}
	}

	// Single pass through historical data
	for _, data := range historicalData {
		hour := data.LastUpdate.UTC().Hour()
		if acc, exists := hourAccumulators[hour]; exists {
			acc.totalKIndex += float64(data.KIndex)
			acc.totalSolarFlux += data.SolarFlux
			acc.count++
		}
	}

	// Calculate averages
	for hour, acc := range hourAccumulators {
		if acc.count > 0 {
			result[hour] = spaceWeatherData{
				avgKIndex:    acc.totalKIndex / float64(acc.count),
				avgSolarFlux: acc.totalSolarFlux / float64(acc.count),
				samples:      acc.count,
			}
		}
	}

	return result
}

// compareSpaceWeatherConditions compares current and historical space weather
// Returns whether conditions are similar and a human-readable note
func compareSpaceWeatherConditions(
	currentKIndex int,
	currentSolarFlux float64,
	historicalKIndex float64,
	historicalSolarFlux float64,
) (similar bool, note string) {

	// If no historical data, can't compare
	if historicalKIndex == 0 && historicalSolarFlux == 0 {
		return false, "No historical space weather data available"
	}

	// Compare K-index (tolerance: ±2)
	kIndexDiff := float64(currentKIndex) - historicalKIndex
	kIndexSimilar := kIndexDiff >= -2 && kIndexDiff <= 2

	// Compare Solar Flux (tolerance: ±20 SFU)
	solarFluxDiff := currentSolarFlux - historicalSolarFlux
	solarFluxSimilar := solarFluxDiff >= -20 && solarFluxDiff <= 20

	// Both must be similar for overall similarity
	similar = kIndexSimilar && solarFluxSimilar

	// Build note
	if similar {
		note = "Similar conditions"
	} else {
		notes := make([]string, 0)
		if !kIndexSimilar {
			if kIndexDiff > 0 {
				notes = append(notes, fmt.Sprintf("K-index higher (%.0f vs %.0f)", float64(currentKIndex), historicalKIndex))
			} else {
				notes = append(notes, fmt.Sprintf("K-index lower (%.0f vs %.0f)", float64(currentKIndex), historicalKIndex))
			}
		}
		if !solarFluxSimilar {
			if solarFluxDiff > 0 {
				notes = append(notes, fmt.Sprintf("Solar flux higher (%.0f vs %.0f)", currentSolarFlux, historicalSolarFlux))
			} else {
				notes = append(notes, fmt.Sprintf("Solar flux lower (%.0f vs %.0f)", currentSolarFlux, historicalSolarFlux))
			}
		}
		if len(notes) > 0 {
			note = notes[0]
			if len(notes) > 1 {
				note += "; " + notes[1]
			}
		} else {
			note = "Conditions differ"
		}
	}

	return similar, note
}

// utcHourToLocalTimeString converts a UTC hour to local time string
func utcHourToLocalTimeString(utcHour int) string {
	now := time.Now()
	utcDate := time.Date(now.Year(), now.Month(), now.Day(), utcHour, 0, 0, 0, time.UTC)
	localTime := utcDate.Local()
	return localTime.Format("15:04")
}

// deduplicatePredictions removes duplicate bands, keeping the one with soonest opening
func deduplicatePredictions(predictions []BandPrediction) []BandPrediction {
	seen := make(map[string]BandPrediction)

	for _, pred := range predictions {
		existing, exists := seen[pred.Band]
		if !exists || pred.HoursUntil < existing.HoursUntil {
			seen[pred.Band] = pred
		}
	}

	result := make([]BandPrediction, 0, len(seen))
	for _, pred := range seen {
		result = append(result, pred)
	}

	return result
}

// calculateConfidenceScore calculates a confidence score (0-100) for a band prediction
// based on the number of historical spots and space weather similarity
func calculateConfidenceScore(historicalSpots int, conditionsSimilar bool) (score int, level string) {
	// Base score from spot count (0-70 points)
	// Scale: 1-5 spots = 10-30, 6-15 spots = 31-50, 16-30 spots = 51-65, 31+ spots = 66-70
	spotScore := 0
	switch {
	case historicalSpots >= 31:
		spotScore = 70
	case historicalSpots >= 16:
		spotScore = 50 + (historicalSpots-16)*1 // 50-65
	case historicalSpots >= 6:
		spotScore = 30 + (historicalSpots-6)*2 // 30-50
	case historicalSpots >= 1:
		spotScore = 10 + (historicalSpots-1)*4 // 10-26
	default:
		spotScore = 0
	}

	// Weather similarity bonus (0-30 points)
	weatherBonus := 0
	if conditionsSimilar {
		weatherBonus = 30
	}

	// Total score
	score = spotScore + weatherBonus
	if score > 100 {
		score = 100
	}

	// Determine level
	switch {
	case score >= 70:
		level = "High"
	case score >= 40:
		level = "Medium"
	default:
		level = "Low"
	}

	return score, level
}
