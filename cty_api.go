package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// CTYAPIResponse represents the response structure for CTY API endpoints
type CTYAPIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// CTYCountryInfo represents detailed country information
type CTYCountryInfo struct {
	Name       string  `json:"name"`
	PrimaryPfx string  `json:"primary_prefix"`
	CQZone     int     `json:"cq_zone"`
	ITUZone    int     `json:"itu_zone"`
	Continent  string  `json:"continent"`
	Latitude   float64 `json:"latitude"`
	Longitude  float64 `json:"longitude"`
	TimeOffset float64 `json:"time_offset"`
	IsWAEDC    bool    `json:"is_waedc"`
}

// CTYPrefixInfo represents prefix information with overrides
type CTYPrefixInfo struct {
	Prefix     string  `json:"prefix"`
	IsExact    bool    `json:"is_exact"`
	Country    string  `json:"country"`
	CQZone     int     `json:"cq_zone"`
	ITUZone    int     `json:"itu_zone"`
	Continent  string  `json:"continent"`
	Latitude   float64 `json:"latitude"`
	Longitude  float64 `json:"longitude"`
	TimeOffset float64 `json:"time_offset"`
}

// CTYCallsignLookupResponse represents the response for callsign lookup
type CTYCallsignLookupResponse struct {
	Callsign   string  `json:"callsign"`
	Country    string  `json:"country"`
	CQZone     int     `json:"cq_zone"`
	ITUZone    int     `json:"itu_zone"`
	Continent  string  `json:"continent"`
	Latitude   float64 `json:"latitude"`
	Longitude  float64 `json:"longitude"`
	TimeOffset float64 `json:"time_offset"`
}

// handleCTYCountries returns a list of all countries in the database
func handleCTYCountries(w http.ResponseWriter, r *http.Request, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if globalCTY == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "CTY database is not loaded",
		})
		return
	}

	globalCTY.mu.RLock()
	defer globalCTY.mu.RUnlock()

	// Get optional continent filter
	continentFilter := strings.ToUpper(r.URL.Query().Get("continent"))

	countries := make([]CTYCountryInfo, 0, len(globalCTY.entities))
	for _, entity := range globalCTY.entities {
		// Apply continent filter if specified
		if continentFilter != "" && entity.Continent != continentFilter {
			continue
		}

		countries = append(countries, CTYCountryInfo{
			Name:       entity.Name,
			PrimaryPfx: entity.PrimaryPfx,
			CQZone:     entity.CQZone,
			ITUZone:    entity.ITUZone,
			Continent:  entity.Continent,
			Latitude:   entity.Latitude,
			Longitude:  entity.Longitude,
			TimeOffset: entity.TimeOffset,
			IsWAEDC:    entity.IsWAEDC,
		})
	}

	// Sort by name
	sort.Slice(countries, func(i, j int) bool {
		return countries[i].Name < countries[j].Name
	})

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(CTYAPIResponse{
		Success: true,
		Data: map[string]interface{}{
			"countries": countries,
			"count":     len(countries),
		},
	})
}

// handleCTYContinents returns a list of all continents with country counts
func handleCTYContinents(w http.ResponseWriter, r *http.Request, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if globalCTY == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "CTY database is not loaded",
		})
		return
	}

	globalCTY.mu.RLock()
	defer globalCTY.mu.RUnlock()

	// Count countries per continent
	continentCounts := make(map[string]int)
	for _, entity := range globalCTY.entities {
		continentCounts[entity.Continent]++
	}

	// Convert to sorted list
	type ContinentInfo struct {
		Code  string `json:"code"`
		Name  string `json:"name"`
		Count int    `json:"count"`
	}

	continentNames := map[string]string{
		"AF": "Africa",
		"AS": "Asia",
		"EU": "Europe",
		"NA": "North America",
		"OC": "Oceania",
		"SA": "South America",
		"AN": "Antarctica",
	}

	continents := make([]ContinentInfo, 0, len(continentCounts))
	for code, count := range continentCounts {
		name := continentNames[code]
		if name == "" {
			name = code
		}
		continents = append(continents, ContinentInfo{
			Code:  code,
			Name:  name,
			Count: count,
		})
	}

	// Sort by code
	sort.Slice(continents, func(i, j int) bool {
		return continents[i].Code < continents[j].Code
	})

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(CTYAPIResponse{
		Success: true,
		Data: map[string]interface{}{
			"continents": continents,
		},
	})
}

// handleCTYLookup looks up a callsign and returns country information
func handleCTYLookup(w http.ResponseWriter, r *http.Request, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if globalCTY == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "CTY database is not loaded",
		})
		return
	}

	// Get callsign parameter
	callsign := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("callsign")))
	if callsign == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "callsign parameter is required",
		})
		return
	}

	// Lookup callsign
	result := globalCTY.LookupCallsignFull(callsign)
	if result == nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "Callsign not found in database",
		})
		return
	}

	response := CTYCallsignLookupResponse{
		Callsign:   callsign,
		Country:    result.Country,
		CQZone:     result.CQZone,
		ITUZone:    result.ITUZone,
		Continent:  result.Continent,
		Latitude:   result.Latitude,
		Longitude:  result.Longitude,
		TimeOffset: result.TimeOffset,
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(CTYAPIResponse{
		Success: true,
		Data:    response,
	})
}

// handleCTYPrefixes returns all prefixes, optionally filtered by country
func handleCTYPrefixes(w http.ResponseWriter, r *http.Request, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if globalCTY == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "CTY database is not loaded",
		})
		return
	}

	globalCTY.mu.RLock()
	defer globalCTY.mu.RUnlock()

	// Get optional country filter (primary prefix)
	countryFilter := strings.ToUpper(r.URL.Query().Get("country"))

	prefixes := make([]CTYPrefixInfo, 0)
	for key, entry := range globalCTY.prefixes {
		// Apply country filter if specified
		if countryFilter != "" && entry.Entity.PrimaryPfx != countryFilter {
			continue
		}

		prefix := entry.Prefix.Prefix
		isExact := entry.Prefix.IsExact

		// Remove = prefix from key if it's an exact match
		if strings.HasPrefix(key, "=") {
			prefix = key[1:]
			isExact = true
		}

		// Build prefix info with overrides applied
		info := CTYPrefixInfo{
			Prefix:     prefix,
			IsExact:    isExact,
			Country:    entry.Entity.Name,
			CQZone:     entry.Entity.CQZone,
			ITUZone:    entry.Entity.ITUZone,
			Continent:  entry.Entity.Continent,
			Latitude:   entry.Entity.Latitude,
			Longitude:  entry.Entity.Longitude,
			TimeOffset: entry.Entity.TimeOffset,
		}

		// Apply prefix overrides
		if entry.Prefix.CQZone != 0 {
			info.CQZone = entry.Prefix.CQZone
		}
		if entry.Prefix.ITUZone != 0 {
			info.ITUZone = entry.Prefix.ITUZone
		}
		if entry.Prefix.Continent != "" {
			info.Continent = entry.Prefix.Continent
		}
		if entry.Prefix.HasLatLon {
			info.Latitude = entry.Prefix.Latitude
			info.Longitude = entry.Prefix.Longitude
		}
		if entry.Prefix.HasOffset {
			info.TimeOffset = entry.Prefix.TimeOffset
		}

		prefixes = append(prefixes, info)
	}

	// Sort by prefix
	sort.Slice(prefixes, func(i, j int) bool {
		return prefixes[i].Prefix < prefixes[j].Prefix
	})

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(CTYAPIResponse{
		Success: true,
		Data: map[string]interface{}{
			"prefixes": prefixes,
			"count":    len(prefixes),
		},
	})
}

// handleCTYStats returns statistics about the CTY database
func handleCTYStats(w http.ResponseWriter, r *http.Request, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if globalCTY == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "CTY database is not loaded",
		})
		return
	}

	globalCTY.mu.RLock()
	defer globalCTY.mu.RUnlock()

	// Count continents
	continents := make(map[string]int)
	for _, entity := range globalCTY.entities {
		continents[entity.Continent]++
	}

	// Count exact matches
	exactMatches := 0
	for key := range globalCTY.prefixes {
		if strings.HasPrefix(key, "=") {
			exactMatches++
		}
	}

	stats := map[string]interface{}{
		"total_countries": len(globalCTY.entities),
		"total_prefixes":  len(globalCTY.prefixes),
		"exact_matches":   exactMatches,
		"continents":      continents,
		"continent_count": len(continents),
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(CTYAPIResponse{
		Success: true,
		Data:    stats,
	})
}

// handleCTYZones returns information about CQ and ITU zones
func handleCTYZones(w http.ResponseWriter, r *http.Request, ipBanManager *IPBanManager) {
	// Check if IP is banned
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if globalCTY == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(CTYAPIResponse{
			Success: false,
			Error:   "CTY database is not loaded",
		})
		return
	}

	globalCTY.mu.RLock()
	defer globalCTY.mu.RUnlock()

	// Get optional zone type and number filters
	zoneType := strings.ToLower(r.URL.Query().Get("type")) // "cq" or "itu"
	zoneNumStr := r.URL.Query().Get("zone")

	var zoneNum int
	if zoneNumStr != "" {
		var err error
		zoneNum, err = strconv.Atoi(zoneNumStr)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(CTYAPIResponse{
				Success: false,
				Error:   "Invalid zone number",
			})
			return
		}
	}

	// Collect zone information
	cqZones := make(map[int][]string)
	ituZones := make(map[int][]string)

	for _, entity := range globalCTY.entities {
		cqZones[entity.CQZone] = append(cqZones[entity.CQZone], entity.Name)
		ituZones[entity.ITUZone] = append(ituZones[entity.ITUZone], entity.Name)
	}

	// Build response based on filters
	var response interface{}

	if zoneType == "cq" {
		if zoneNum > 0 {
			// Specific CQ zone
			countries := cqZones[zoneNum]
			sort.Strings(countries)
			response = map[string]interface{}{
				"zone":      zoneNum,
				"type":      "CQ",
				"countries": countries,
				"count":     len(countries),
			}
		} else {
			// All CQ zones
			type ZoneInfo struct {
				Zone      int      `json:"zone"`
				Countries []string `json:"countries"`
				Count     int      `json:"count"`
			}
			zones := make([]ZoneInfo, 0, len(cqZones))
			for zone, countries := range cqZones {
				sort.Strings(countries)
				zones = append(zones, ZoneInfo{
					Zone:      zone,
					Countries: countries,
					Count:     len(countries),
				})
			}
			sort.Slice(zones, func(i, j int) bool {
				return zones[i].Zone < zones[j].Zone
			})
			response = map[string]interface{}{
				"type":  "CQ",
				"zones": zones,
			}
		}
	} else if zoneType == "itu" {
		if zoneNum > 0 {
			// Specific ITU zone
			countries := ituZones[zoneNum]
			sort.Strings(countries)
			response = map[string]interface{}{
				"zone":      zoneNum,
				"type":      "ITU",
				"countries": countries,
				"count":     len(countries),
			}
		} else {
			// All ITU zones
			type ZoneInfo struct {
				Zone      int      `json:"zone"`
				Countries []string `json:"countries"`
				Count     int      `json:"count"`
			}
			zones := make([]ZoneInfo, 0, len(ituZones))
			for zone, countries := range ituZones {
				sort.Strings(countries)
				zones = append(zones, ZoneInfo{
					Zone:      zone,
					Countries: countries,
					Count:     len(countries),
				})
			}
			sort.Slice(zones, func(i, j int) bool {
				return zones[i].Zone < zones[j].Zone
			})
			response = map[string]interface{}{
				"type":  "ITU",
				"zones": zones,
			}
		}
	} else {
		// Both zone types summary
		type ZoneSummary struct {
			Zone  int `json:"zone"`
			Count int `json:"count"`
		}

		cqSummary := make([]ZoneSummary, 0, len(cqZones))
		for zone, countries := range cqZones {
			cqSummary = append(cqSummary, ZoneSummary{
				Zone:  zone,
				Count: len(countries),
			})
		}
		sort.Slice(cqSummary, func(i, j int) bool {
			return cqSummary[i].Zone < cqSummary[j].Zone
		})

		ituSummary := make([]ZoneSummary, 0, len(ituZones))
		for zone, countries := range ituZones {
			ituSummary = append(ituSummary, ZoneSummary{
				Zone:  zone,
				Count: len(countries),
			})
		}
		sort.Slice(ituSummary, func(i, j int) bool {
			return ituSummary[i].Zone < ituSummary[j].Zone
		})

		response = map[string]interface{}{
			"cq_zones":  cqSummary,
			"itu_zones": ituSummary,
		}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(CTYAPIResponse{
		Success: true,
		Data:    response,
	})
}

// RegisterCTYAPIHandlers registers all CTY API endpoints
func RegisterCTYAPIHandlers(ipBanManager *IPBanManager) {
	http.HandleFunc("/api/cty/countries", func(w http.ResponseWriter, r *http.Request) {
		handleCTYCountries(w, r, ipBanManager)
	})
	http.HandleFunc("/api/cty/continents", func(w http.ResponseWriter, r *http.Request) {
		handleCTYContinents(w, r, ipBanManager)
	})
	http.HandleFunc("/api/cty/lookup", func(w http.ResponseWriter, r *http.Request) {
		handleCTYLookup(w, r, ipBanManager)
	})
	http.HandleFunc("/api/cty/prefixes", func(w http.ResponseWriter, r *http.Request) {
		handleCTYPrefixes(w, r, ipBanManager)
	})
	http.HandleFunc("/api/cty/zones", func(w http.ResponseWriter, r *http.Request) {
		handleCTYZones(w, r, ipBanManager)
	})
	http.HandleFunc("/api/cty/stats", func(w http.ResponseWriter, r *http.Request) {
		handleCTYStats(w, r, ipBanManager)
	})

	log.Println("CTY API endpoints registered:")
	log.Println("  GET /api/cty/countries - List all countries (optional: ?continent=EU)")
	log.Println("  GET /api/cty/continents - List all continents with counts")
	log.Println("  GET /api/cty/lookup?callsign=W1AW - Lookup callsign")
	log.Println("  GET /api/cty/prefixes - List all prefixes (optional: ?country=K)")
	log.Println("  GET /api/cty/zones - List all zones (optional: ?type=cq&zone=14)")
	log.Println("  GET /api/cty/stats - Database statistics")
}
