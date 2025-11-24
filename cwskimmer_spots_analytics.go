package main

import (
	"fmt"
	"sort"
	"time"
)

// GetCWSpotsAnalytics aggregates CW spots data for analytics (similar to decoder but without mode)
func (sl *CWSkimmerSpotsLogger) GetCWSpotsAnalytics(filterCountry string, filterContinent string, filterBand string, minSNR int, hours int, ctyDatabase *CTYDatabase) (*AnalyticsResponse, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("CW Skimmer spots logging is not enabled")
	}

	// Calculate date range
	now := time.Now()
	toDate := now.Format("2006-01-02")
	fromTime := now.Add(-time.Duration(hours) * time.Hour)
	fromDate := fromTime.Format("2006-01-02")

	// Get spots using existing method
	spots, err := sl.GetCWHistoricalSpots(
		filterBand,      // band filter
		"",              // name - all names
		"",              // callsign - all callsigns
		filterContinent, // continent filter
		"",              // direction - all directions
		fromDate,
		toDate,
		"", // startTime - no time filter
		"", // endTime - no time filter
		0,  // minDistanceKm
		minSNR,
		ctyDatabase,
	)
	if err != nil {
		return nil, err
	}

	// Filter by country if specified
	if filterCountry != "" {
		filtered := make([]CWSpotRecord, 0)
		for _, spot := range spots {
			if spot.Country == filterCountry {
				filtered = append(filtered, spot)
			}
		}
		spots = filtered
	}

	// Filter by time window (only keep spots within the hours range)
	cutoffTime := fromTime
	filtered := make([]CWSpotRecord, 0)
	for _, spot := range spots {
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		if spotTime.After(cutoffTime) || spotTime.Equal(cutoffTime) {
			filtered = append(filtered, spot)
		}
	}
	spots = filtered

	// Build analytics response
	response := &AnalyticsResponse{}
	response.TimeRange.From = fromTime.Format(time.RFC3339)
	response.TimeRange.To = now.Format(time.RFC3339)
	response.TimeRange.Hours = hours
	response.Filters.MinSNR = minSNR
	response.Filters.Country = filterCountry
	response.Filters.Continent = filterContinent

	// Aggregate by country and band
	countryData := make(map[string]map[string]*bandAggregator)
	continentData := make(map[string]map[string]*bandAggregator)
	continentCountries := make(map[string]map[string]bool)

	// Track unique callsigns per country/band (CW doesn't have locators)
	countryCallsigns := make(map[string]map[string]map[string]bool)   // country -> band -> callsign -> true
	continentCallsigns := make(map[string]map[string]map[string]bool) // continent -> band -> callsign -> true

	for _, spot := range spots {
		// Skip spots without country info
		if spot.Country == "" {
			continue
		}

		// Initialize country map if needed
		if countryData[spot.Country] == nil {
			countryData[spot.Country] = make(map[string]*bandAggregator)
		}
		if countryData[spot.Country][spot.Band] == nil {
			countryData[spot.Country][spot.Band] = &bandAggregator{
				hourly:   make(map[int]int),
				locators: make(map[string]*locatorAggregator),
				minSNR:   float64(spot.SNR),
				maxSNR:   float64(spot.SNR),
			}
		}

		// Initialize continent map if needed
		if spot.Continent != "" {
			if continentData[spot.Continent] == nil {
				continentData[spot.Continent] = make(map[string]*bandAggregator)
				continentCountries[spot.Continent] = make(map[string]bool)
			}
			if continentData[spot.Continent][spot.Band] == nil {
				continentData[spot.Continent][spot.Band] = &bandAggregator{
					hourly:   make(map[int]int),
					locators: make(map[string]*locatorAggregator),
					minSNR:   float64(spot.SNR),
					maxSNR:   float64(spot.SNR),
				}
			}
			continentCountries[spot.Continent][spot.Country] = true
		}

		// Parse timestamp to get hour
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		hour := spotTime.UTC().Hour()

		// Aggregate country data
		agg := countryData[spot.Country][spot.Band]
		agg.count++
		agg.totalSNR += float64(spot.SNR)
		if float64(spot.SNR) < agg.minSNR {
			agg.minSNR = float64(spot.SNR)
		}
		if float64(spot.SNR) > agg.maxSNR {
			agg.maxSNR = float64(spot.SNR)
		}
		agg.hourly[hour]++

		// Track unique callsigns per country/band
		if spot.Callsign != "" {
			if countryCallsigns[spot.Country] == nil {
				countryCallsigns[spot.Country] = make(map[string]map[string]bool)
			}
			if countryCallsigns[spot.Country][spot.Band] == nil {
				countryCallsigns[spot.Country][spot.Band] = make(map[string]bool)
			}
			countryCallsigns[spot.Country][spot.Band][spot.Callsign] = true
		}

		// Aggregate continent data
		if spot.Continent != "" {
			contAgg := continentData[spot.Continent][spot.Band]
			contAgg.count++
			contAgg.totalSNR += float64(spot.SNR)
			if float64(spot.SNR) < contAgg.minSNR {
				contAgg.minSNR = float64(spot.SNR)
			}
			if float64(spot.SNR) > contAgg.maxSNR {
				contAgg.maxSNR = float64(spot.SNR)
			}
			contAgg.hourly[hour]++

			// Track unique callsigns per continent/band
			if spot.Callsign != "" {
				if continentCallsigns[spot.Continent] == nil {
					continentCallsigns[spot.Continent] = make(map[string]map[string]bool)
				}
				if continentCallsigns[spot.Continent][spot.Band] == nil {
					continentCallsigns[spot.Continent][spot.Band] = make(map[string]bool)
				}
				continentCallsigns[spot.Continent][spot.Band][spot.Callsign] = true
			}
		}
	}

	// Build country analytics
	continentNames := map[string]string{
		"AF": "Africa",
		"AS": "Asia",
		"EU": "Europe",
		"NA": "North America",
		"OC": "Oceania",
		"SA": "South America",
		"AN": "Antarctica",
	}

	for country, bands := range countryData {
		countryAnalytics := CountryAnalytics{
			Country: country,
			Bands:   make([]BandAnalytics, 0),
		}

		// Find continent and lat/lon for this country (from first spot with coordinates)
		for _, spot := range spots {
			if spot.Country == country {
				countryAnalytics.Continent = spot.Continent
				// Use the lat/lon from CTY.dat if available
				if spot.Latitude != nil && spot.Longitude != nil {
					countryAnalytics.Latitude = spot.Latitude
					countryAnalytics.Longitude = spot.Longitude
				}
				// Break once we have both continent and coordinates
				if countryAnalytics.Continent != "" && countryAnalytics.Latitude != nil {
					break
				}
			}
		}

		totalSpots := 0
		for band, agg := range bands {
			// CW doesn't have locators, so unique_locators will be empty
			locatorStats := make([]LocatorStats, 0)

			// Calculate unique callsigns for this band
			uniqueCallsignsCount := 0
			if countryCallsigns[country] != nil && countryCallsigns[country][band] != nil {
				uniqueCallsignsCount = len(countryCallsigns[country][band])
			}

			bandAnalytics := BandAnalytics{
				Band:               band,
				Spots:              agg.count,
				UniqueCallsigns:    uniqueCallsignsCount,
				MinSNR:             agg.minSNR,
				AvgSNR:             agg.totalSNR / float64(agg.count),
				MaxSNR:             agg.maxSNR,
				UniqueLocators:     locatorStats,
				BestHoursUTC:       findBestHours(agg.hourly, 3),
				HourlyDistribution: formatHourlyDistribution(agg.hourly),
			}
			countryAnalytics.Bands = append(countryAnalytics.Bands, bandAnalytics)
			totalSpots += agg.count
		}

		// Sort bands by spot count (descending)
		sort.Slice(countryAnalytics.Bands, func(i, j int) bool {
			return countryAnalytics.Bands[i].Spots > countryAnalytics.Bands[j].Spots
		})

		countryAnalytics.TotalSpots = totalSpots
		response.ByCountry = append(response.ByCountry, countryAnalytics)
	}

	// Sort countries by total spots (descending)
	sort.Slice(response.ByCountry, func(i, j int) bool {
		return response.ByCountry[i].TotalSpots > response.ByCountry[j].TotalSpots
	})

	// Build continent analytics
	for continent, bands := range continentData {
		continentAnalytics := ContinentAnalytics{
			Continent:      continent,
			ContinentName:  continentNames[continent],
			CountriesCount: len(continentCountries[continent]),
			Bands:          make([]BandAnalytics, 0),
		}

		if continentAnalytics.ContinentName == "" {
			continentAnalytics.ContinentName = continent
		}

		totalSpots := 0
		for band, agg := range bands {
			// CW doesn't have locators
			locatorStats := make([]LocatorStats, 0)

			// Calculate unique callsigns for this band
			uniqueCallsignsCount := 0
			if continentCallsigns[continent] != nil && continentCallsigns[continent][band] != nil {
				uniqueCallsignsCount = len(continentCallsigns[continent][band])
			}

			bandAnalytics := BandAnalytics{
				Band:               band,
				Spots:              agg.count,
				UniqueCallsigns:    uniqueCallsignsCount,
				MinSNR:             agg.minSNR,
				AvgSNR:             agg.totalSNR / float64(agg.count),
				MaxSNR:             agg.maxSNR,
				UniqueLocators:     locatorStats,
				BestHoursUTC:       findBestHours(agg.hourly, 3),
				HourlyDistribution: formatHourlyDistribution(agg.hourly),
			}
			continentAnalytics.Bands = append(continentAnalytics.Bands, bandAnalytics)
			totalSpots += agg.count
		}

		// Sort bands by spot count (descending)
		sort.Slice(continentAnalytics.Bands, func(i, j int) bool {
			return continentAnalytics.Bands[i].Spots > continentAnalytics.Bands[j].Spots
		})

		continentAnalytics.TotalSpots = totalSpots
		response.ByContinent = append(response.ByContinent, continentAnalytics)
	}

	// Sort continents by total spots (descending)
	sort.Slice(response.ByContinent, func(i, j int) bool {
		return response.ByContinent[i].TotalSpots > response.ByContinent[j].TotalSpots
	})

	return response, nil
}

// GetCWSpotsAnalyticsHourly returns CW analytics data broken down by hour
func (sl *CWSkimmerSpotsLogger) GetCWSpotsAnalyticsHourly(filterCountry string, filterContinent string, filterBand string, minSNR int, hours int, ctyDatabase *CTYDatabase) (*HourlyAnalyticsResponse, error) {
	if !sl.enabled {
		return nil, fmt.Errorf("CW Skimmer spots logging is not enabled")
	}

	// Calculate date range
	now := time.Now()
	toDate := now.Format("2006-01-02")
	fromTime := now.Add(-time.Duration(hours) * time.Hour)
	fromDate := fromTime.Format("2006-01-02")

	// Get spots using existing method
	spots, err := sl.GetCWHistoricalSpots(
		filterBand,      // band filter
		"",              // name - all names
		"",              // callsign - all callsigns
		filterContinent, // continent filter
		"",              // direction - all directions
		fromDate,
		toDate,
		"", // startTime - no time filter
		"", // endTime - no time filter
		0,  // minDistanceKm
		minSNR,
		ctyDatabase,
	)
	if err != nil {
		return nil, err
	}

	// Filter by country if specified
	if filterCountry != "" {
		filtered := make([]CWSpotRecord, 0)
		for _, spot := range spots {
			if spot.Country == filterCountry {
				filtered = append(filtered, spot)
			}
		}
		spots = filtered
	}

	// Filter by time window (only keep spots within the hours range)
	cutoffTime := fromTime
	filtered := make([]CWSpotRecord, 0)
	for _, spot := range spots {
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		if spotTime.After(cutoffTime) || spotTime.Equal(cutoffTime) {
			filtered = append(filtered, spot)
		}
	}
	spots = filtered

	// Build hourly analytics response
	response := &HourlyAnalyticsResponse{}
	response.TimeRange.From = fromTime.Format(time.RFC3339)
	response.TimeRange.To = now.Format(time.RFC3339)
	response.TimeRange.Hours = hours
	response.Filters.MinSNR = minSNR
	response.Filters.Country = filterCountry
	response.Filters.Continent = filterContinent

	// Group spots by hour
	hourlySpots := make(map[int][]CWSpotRecord)
	for _, spot := range spots {
		spotTime, err := time.Parse(time.RFC3339, spot.Timestamp)
		if err != nil {
			continue
		}
		hour := spotTime.UTC().Hour()
		hourlySpots[hour] = append(hourlySpots[hour], spot)
	}

	// Build hourly data for each hour (0-23)
	response.HourlyData = make([]HourlyLocatorData, 0, 24)

	for hour := 0; hour < 24; hour++ {
		// Create timestamp for this hour (use today's date with the hour)
		hourTime := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, time.UTC)

		hourData := HourlyLocatorData{
			Hour:      hour,
			Timestamp: hourTime.Format(time.RFC3339),
			Locators:  make([]LocatorStats, 0),
		}

		// Get spots for this hour
		spotsForHour := hourlySpots[hour]
		if len(spotsForHour) == 0 {
			// Include empty hour data
			response.HourlyData = append(response.HourlyData, hourData)
			continue
		}

		// For CW, aggregate by country instead of locator
		// Use LocatorStats structure but populate with country data
		countryMap := make(map[string]*locatorAggregator)
		callsignsByCountry := make(map[string]map[string]bool) // country -> callsign -> true

		for _, spot := range spotsForHour {
			if spot.Country == "" {
				continue
			}

			if countryMap[spot.Country] == nil {
				countryMap[spot.Country] = &locatorAggregator{
					callsigns: make(map[string]bool),
				}
			}

			agg := countryMap[spot.Country]
			agg.totalSNR += float64(spot.SNR)
			agg.count++
			if spot.Callsign != "" {
				agg.callsigns[spot.Callsign] = true
			}

			// Track callsigns per country
			if spot.Callsign != "" {
				if callsignsByCountry[spot.Country] == nil {
					callsignsByCountry[spot.Country] = make(map[string]bool)
				}
				callsignsByCountry[spot.Country][spot.Callsign] = true
			}
		}

		// Convert to LocatorStats (using country as "locator" field)
		for country, agg := range countryMap {
			// Build CallsignInfo list
			callsignInfoList := make([]CallsignInfo, 0)
			if callsignsByCountry[country] != nil {
				for callsign := range callsignsByCountry[country] {
					callsignInfoList = append(callsignInfoList, CallsignInfo{
						Callsign: callsign,
						Bands:    []string{}, // CW doesn't track bands in hourly view
					})
				}
			}
			// Sort callsigns alphabetically
			sort.Slice(callsignInfoList, func(i, j int) bool {
				return callsignInfoList[i].Callsign < callsignInfoList[j].Callsign
			})

			// Create a LocatorStats entry with country data
			// The frontend will look up lat/lon from the country name
			locatorStat := LocatorStats{
				Locator:         country, // Use country name as the "locator"
				AvgSNR:          agg.totalSNR / float64(agg.count),
				Count:           agg.count,
				UniqueCallsigns: len(agg.callsigns),
				Callsigns:       callsignInfoList,
			}

			// Note: We need to pass lat/lon to the frontend somehow
			// The LocatorStats struct doesn't have lat/lon fields
			// The frontend will need to look up coordinates from the country name
			// Or we need to modify the struct (which would affect decoder too)
			// For now, the frontend can use the country name to look up coordinates

			hourData.Locators = append(hourData.Locators, locatorStat)
		}

		// Sort by country name
		sort.Slice(hourData.Locators, func(i, j int) bool {
			return hourData.Locators[i].Locator < hourData.Locators[j].Locator
		})

		response.HourlyData = append(response.HourlyData, hourData)
	}

	return response, nil
}
