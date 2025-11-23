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

	// Collect all band predictions from country analytics
	predictions := make([]BandPrediction, 0)

	// Process each country's bands
	for _, country := range analytics.ByCountry {
		for _, band := range country.Bands {
			// Find next opening hour for this band
			nextHour := findNextActiveHour(band.HourlyDistribution, currentUTCHour)
			if nextHour == -1 {
				continue // No future activity for this band
			}

			// Get historical space weather for this hour
			historicalKIndex, historicalSolarFlux, samples := getHistoricalSpaceWeatherForHour(
				spaceWeatherMonitor,
				nextHour,
				hours,
			)

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

			// Compare conditions
			conditionsSimilar, conditionsNote := compareSpaceWeatherConditions(
				currentSpaceWeather.KIndex,
				currentSpaceWeather.SolarFlux,
				historicalKIndex,
				historicalSolarFlux,
			)

			// Convert UTC hour to local time
			localTime := utcHourToLocalTimeString(nextHour)

			prediction := BandPrediction{
				Band:                band.Band,
				OpensAtUTC:          nextHour,
				OpensAtLocal:        localTime,
				HoursUntil:          hoursUntil,
				HistoricalSpots:     spotsForHour,
				HistoricalCallsigns: band.UniqueCallsigns,
				HistoricalKIndex:    historicalKIndex,
				HistoricalSolarFlux: historicalSolarFlux,
				CurrentKIndex:       currentSpaceWeather.KIndex,
				CurrentSolarFlux:    currentSpaceWeather.SolarFlux,
				ConditionsSimilar:   conditionsSimilar,
				ConditionsNote:      conditionsNote,
				HistoricalSamples:   samples,
			}

			predictions = append(predictions, prediction)
		}
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

// getHistoricalSpaceWeatherForHour gets average space weather for a specific UTC hour
// across the historical period
func getHistoricalSpaceWeatherForHour(
	swm *SpaceWeatherMonitor,
	targetHour int,
	daysBack int,
) (avgKIndex float64, avgSolarFlux float64, samples int) {

	if swm == nil || !swm.config.LogToCSV {
		return 0, 0, 0
	}

	now := time.Now()
	toDate := now.Format("2006-01-02")
	fromDate := now.AddDate(0, 0, -daysBack).Format("2006-01-02")

	// Get historical space weather data
	historicalData, err := swm.GetHistoricalData(fromDate, toDate, "", "", "")
	if err != nil {
		log.Printf("Warning: Failed to get historical space weather: %v", err)
		return 0, 0, 0
	}

	// Filter to only the target hour and calculate averages
	var totalKIndex float64
	var totalSolarFlux float64
	count := 0

	for _, data := range historicalData {
		if data.LastUpdate.UTC().Hour() == targetHour {
			totalKIndex += float64(data.KIndex)
			totalSolarFlux += data.SolarFlux
			count++
		}
	}

	if count == 0 {
		return 0, 0, 0
	}

	return totalKIndex / float64(count), totalSolarFlux / float64(count), count
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
