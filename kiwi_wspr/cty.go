package main

import (
	"bufio"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
)

// CTYEntity represents a DXCC entity from the CTY.DAT file
type CTYEntity struct {
	Name       string
	CQZone     int
	ITUZone    int
	Continent  string
	Latitude   float64
	Longitude  float64
	TimeOffset float64
	PrimaryPfx string
	IsWAEDC    bool // Marked with * in file
}

// CTYPrefix represents a callsign prefix with optional overrides
type CTYPrefix struct {
	Prefix     string
	IsExact    bool // Preceded by = in file
	CQZone     int  // Override if != 0
	ITUZone    int  // Override if != 0
	Latitude   float64
	Longitude  float64
	HasLatLon  bool
	Continent  string
	TimeOffset float64
	HasOffset  bool
}

// CTYDatabase holds the parsed CTY.DAT data
type CTYDatabase struct {
	entities map[string]*CTYEntity // Key is primary prefix
	prefixes map[string]*CTYEntry  // Key is prefix (including exact matches)
	mu       sync.RWMutex
}

// CTYEntry links a prefix to its entity with overrides
type CTYEntry struct {
	Entity *CTYEntity
	Prefix *CTYPrefix
}

var globalCTY *CTYDatabase

// InitCTYDatabase loads and parses the CTY.DAT file
func InitCTYDatabase(filename string) error {
	db := &CTYDatabase{
		entities: make(map[string]*CTYEntity),
		prefixes: make(map[string]*CTYEntry),
	}

	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer func() {
		if err := file.Close(); err != nil {
			log.Printf("Error closing CTY file: %v", err)
		}
	}()

	scanner := bufio.NewScanner(file)
	var currentEntity *CTYEntity
	var prefixLine strings.Builder

	for scanner.Scan() {
		line := scanner.Text()

		// Check if this is an entity definition line (contains ':' delimiters)
		if strings.Contains(line, ":") && !strings.HasPrefix(strings.TrimSpace(line), "=") {
			// Parse entity definition
			entity, err := parseEntityLine(line)
			if err != nil {
				log.Printf("Error parsing entity line: %v", err)
				continue
			}
			currentEntity = entity
			db.entities[entity.PrimaryPfx] = entity
			prefixLine.Reset()
		} else if currentEntity != nil {
			// This is a prefix line
			prefixLine.WriteString(line)

			// Check if line ends with semicolon (end of prefix list)
			if strings.HasSuffix(strings.TrimSpace(line), ";") {
				// Parse all prefixes for this entity
				prefixStr := prefixLine.String()
				prefixes := parsePrefixLine(prefixStr, currentEntity)
				for _, pfx := range prefixes {
					entry := &CTYEntry{
						Entity: currentEntity,
						Prefix: pfx,
					}
					// Store with prefix as key
					key := pfx.Prefix
					if pfx.IsExact {
						key = "=" + key // Exact matches get = prefix in map
					}
					db.prefixes[key] = entry
				}
				currentEntity = nil
				prefixLine.Reset()
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return err
	}

	globalCTY = db
	log.Printf("Loaded CTY database: %d entities, %d prefixes", len(db.entities), len(db.prefixes))
	return nil
}

// parseEntityLine parses a CTY.DAT entity definition line
func parseEntityLine(line string) (*CTYEntity, error) {
	parts := strings.Split(line, ":")
	if len(parts) < 8 {
		return nil, nil
	}

	entity := &CTYEntity{}

	// Country name (column 1-26)
	entity.Name = strings.TrimSpace(parts[0])

	// CQ Zone (column 27-31)
	if cq, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil {
		entity.CQZone = cq
	}

	// ITU Zone (column 32-36)
	if itu, err := strconv.Atoi(strings.TrimSpace(parts[2])); err == nil {
		entity.ITUZone = itu
	}

	// Continent (column 37-41)
	entity.Continent = strings.TrimSpace(parts[3])

	// Latitude (column 42-50)
	if lat, err := strconv.ParseFloat(strings.TrimSpace(parts[4]), 64); err == nil {
		entity.Latitude = lat
	}

	// Longitude (column 51-60)
	if lon, err := strconv.ParseFloat(strings.TrimSpace(parts[5]), 64); err == nil {
		entity.Longitude = lon
	}

	// Time offset (column 61-69)
	if offset, err := strconv.ParseFloat(strings.TrimSpace(parts[6]), 64); err == nil {
		entity.TimeOffset = offset
	}

	// Primary prefix (column 70-75)
	pfx := strings.TrimSpace(parts[7])
	if strings.HasPrefix(pfx, "*") {
		entity.IsWAEDC = true
		pfx = pfx[1:]
	}
	entity.PrimaryPfx = pfx

	return entity, nil
}

// parsePrefixLine parses the prefix aliases for an entity
func parsePrefixLine(line string, entity *CTYEntity) []*CTYPrefix {
	var prefixes []*CTYPrefix

	// Remove trailing semicolon and whitespace
	line = strings.TrimRight(line, "; \t\n\r")

	// Split by comma
	parts := strings.Split(line, ",")

	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		pfx := &CTYPrefix{
			Prefix: part,
		}

		// Check for exact match (=)
		if strings.HasPrefix(part, "=") {
			pfx.IsExact = true
			part = part[1:]
			pfx.Prefix = part
		}

		// Parse overrides
		// (#) = CQ Zone override
		if idx := strings.Index(part, "("); idx != -1 {
			endIdx := strings.Index(part, ")")
			if endIdx > idx {
				if zone, err := strconv.Atoi(part[idx+1 : endIdx]); err == nil {
					pfx.CQZone = zone
				}
				part = part[:idx] + part[endIdx+1:]
				pfx.Prefix = part
			}
		}

		// [#] = ITU Zone override
		if idx := strings.Index(part, "["); idx != -1 {
			endIdx := strings.Index(part, "]")
			if endIdx > idx {
				if zone, err := strconv.Atoi(part[idx+1 : endIdx]); err == nil {
					pfx.ITUZone = zone
				}
				part = part[:idx] + part[endIdx+1:]
				pfx.Prefix = part
			}
		}

		// <#/#> = Lat/Lon override
		if idx := strings.Index(part, "<"); idx != -1 {
			endIdx := strings.Index(part, ">")
			if endIdx > idx {
				coords := strings.Split(part[idx+1:endIdx], "/")
				if len(coords) == 2 {
					if lat, err := strconv.ParseFloat(coords[0], 64); err == nil {
						if lon, err := strconv.ParseFloat(coords[1], 64); err == nil {
							pfx.Latitude = lat
							pfx.Longitude = lon
							pfx.HasLatLon = true
						}
					}
				}
				part = part[:idx] + part[endIdx+1:]
				pfx.Prefix = part
			}
		}

		// {aa} = Continent override
		if idx := strings.Index(part, "{"); idx != -1 {
			endIdx := strings.Index(part, "}")
			if endIdx > idx {
				pfx.Continent = part[idx+1 : endIdx]
				part = part[:idx] + part[endIdx+1:]
				pfx.Prefix = part
			}
		}

		// ~#~ = Time offset override
		if idx := strings.Index(part, "~"); idx != -1 {
			endIdx := strings.LastIndex(part, "~")
			if endIdx > idx {
				if offset, err := strconv.ParseFloat(part[idx+1:endIdx], 64); err == nil {
					pfx.TimeOffset = offset
					pfx.HasOffset = true
				}
				part = part[:idx] + part[endIdx+1:]
				pfx.Prefix = part
			}
		}

		prefixes = append(prefixes, pfx)
	}

	return prefixes
}

// LookupCallsign finds the country for a callsign
func (db *CTYDatabase) LookupCallsign(callsign string) string {
	if db == nil {
		return ""
	}

	db.mu.RLock()
	defer db.mu.RUnlock()

	callsign = strings.ToUpper(callsign)

	// First, check for exact match
	exactKey := "=" + callsign
	if entry, ok := db.prefixes[exactKey]; ok {
		return entry.Entity.Name
	}

	// Try progressively shorter prefixes
	for i := len(callsign); i > 0; i-- {
		prefix := callsign[:i]
		if entry, ok := db.prefixes[prefix]; ok {
			return entry.Entity.Name
		}
	}

	return ""
}

// CTYLookupResult contains all CTY information for a callsign
type CTYLookupResult struct {
	Country    string
	CQZone     int
	ITUZone    int
	Continent  string
	TimeOffset float64
	Latitude   float64
	Longitude  float64
}

// LookupCallsignFull finds all CTY information for a callsign, including overrides
func (db *CTYDatabase) LookupCallsignFull(callsign string) *CTYLookupResult {
	if db == nil {
		return nil
	}

	db.mu.RLock()
	defer db.mu.RUnlock()

	callsign = strings.ToUpper(callsign)

	// First, check for exact match
	exactKey := "=" + callsign
	if entry, ok := db.prefixes[exactKey]; ok {
		return buildLookupResult(entry)
	}

	// Try progressively shorter prefixes
	for i := len(callsign); i > 0; i-- {
		prefix := callsign[:i]
		if entry, ok := db.prefixes[prefix]; ok {
			return buildLookupResult(entry)
		}
	}

	return nil
}

// buildLookupResult creates a CTYLookupResult from a CTYEntry, applying overrides
func buildLookupResult(entry *CTYEntry) *CTYLookupResult {
	result := &CTYLookupResult{
		Country:    entry.Entity.Name,
		CQZone:     entry.Entity.CQZone,
		ITUZone:    entry.Entity.ITUZone,
		Continent:  entry.Entity.Continent,
		TimeOffset: entry.Entity.TimeOffset,
		Latitude:   entry.Entity.Latitude,
		Longitude:  entry.Entity.Longitude,
	}

	// Apply prefix overrides if present
	if entry.Prefix != nil {
		if entry.Prefix.CQZone != 0 {
			result.CQZone = entry.Prefix.CQZone
		}
		if entry.Prefix.ITUZone != 0 {
			result.ITUZone = entry.Prefix.ITUZone
		}
		if entry.Prefix.Continent != "" {
			result.Continent = entry.Prefix.Continent
		}
		if entry.Prefix.HasOffset {
			result.TimeOffset = entry.Prefix.TimeOffset
		}
		if entry.Prefix.HasLatLon {
			result.Latitude = entry.Prefix.Latitude
			result.Longitude = entry.Prefix.Longitude
		}
	}

	return result
}

// GetCountryForCallsign is a convenience function using the global database
// Deprecated: Use GetCallsignInfo for full CTY information
func GetCountryForCallsign(callsign string) string {
	if globalCTY == nil {
		return ""
	}
	return globalCTY.LookupCallsign(callsign)
}

// GetCallsignInfo returns full CTY information for a callsign using the global database
func GetCallsignInfo(callsign string) *CTYLookupResult {
	if globalCTY == nil {
		return nil
	}
	return globalCTY.LookupCallsignFull(callsign)
}
