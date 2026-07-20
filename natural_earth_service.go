package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/paulmach/orb"
	"github.com/paulmach/orb/geojson"
	"github.com/paulmach/orb/planar"
)

// NaturalEarthCountry holds the parsed geometry and key properties for one country feature.
type NaturalEarthCountry struct {
	Geometry  orb.Geometry
	Name      string
	NameLong  string
	ISOA2     string // ISO 3166-1 alpha-2 (may be empty for some features; see ISOA2EH)
	ISOA2EH   string // ISO_A2_EH — exhaustive-hierarchy variant, fills -99 gaps (e.g. France = "FR")
	ISOA3     string
	ISOA3EH   string
	ADM0A3    string // ADM0_A3 — always populated, used as final fallback
	Continent string
	Region    string
	Subregion string
	Sovereign string
}

// resolvedISO2 returns the best available 2-letter ISO code for the country.
// Natural Earth uses "-99" as a placeholder on some features (e.g. metropolitan France).
// We prefer ISO_A2, then ISO_A2_EH, then WB_A2.
func (c *NaturalEarthCountry) resolvedISO2() string {
	if c.ISOA2 != "" && c.ISOA2 != "-99" {
		return c.ISOA2
	}
	if c.ISOA2EH != "" && c.ISOA2EH != "-99" {
		return c.ISOA2EH
	}
	return ""
}

// resolvedISO3 returns the best available 3-letter ISO code.
func (c *NaturalEarthCountry) resolvedISO3() string {
	if c.ISOA3 != "" && c.ISOA3 != "-99" {
		return c.ISOA3
	}
	if c.ISOA3EH != "" && c.ISOA3EH != "-99" {
		return c.ISOA3EH
	}
	return c.ADM0A3
}

// locatorCacheMaxSize is the maximum number of locator→country results to cache.
// At ~200 bytes per entry, 10,000 entries ≈ 2 MB.  This covers all ~10,000
// land-based 4-char Maidenhead squares globally, plus a generous allowance for
// 6-char locators reported by WSPR stations.
const locatorCacheMaxSize = 10_000

// NaturalEarthService loads and queries the Natural Earth country boundary dataset.
type NaturalEarthService struct {
	countries     []*NaturalEarthCountry
	mu            sync.RWMutex
	loaded        bool
	locatorCache  sync.Map     // map[string]*MaidenheadCountryResult — never evicted, boundaries don't change
	locatorCacheN atomic.Int64 // current number of cached entries
}

var globalNaturalEarth *NaturalEarthService

// InitNaturalEarthService loads the GeoJSON file and builds the in-memory country list.
// path should point to ne_10m_admin_0_countries.geojson (or the 50m variant).
func InitNaturalEarthService(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("natural earth: cannot read %s: %w", path, err)
	}

	fc, err := geojson.UnmarshalFeatureCollection(data)
	if err != nil {
		return fmt.Errorf("natural earth: cannot parse GeoJSON: %w", err)
	}

	svc := &NaturalEarthService{}

	for _, feat := range fc.Features {
		if feat.Geometry == nil {
			continue
		}

		props := feat.Properties
		c := &NaturalEarthCountry{
			Geometry:  feat.Geometry,
			Name:      propString(props, "NAME"),
			NameLong:  propString(props, "NAME_LONG"),
			ISOA2:     propString(props, "ISO_A2"),
			ISOA2EH:   propString(props, "ISO_A2_EH"),
			ISOA3:     propString(props, "ISO_A3"),
			ISOA3EH:   propString(props, "ISO_A3_EH"),
			ADM0A3:    propString(props, "ADM0_A3"),
			Continent: propString(props, "CONTINENT"),
			Region:    propString(props, "REGION_UN"),
			Subregion: propString(props, "SUBREGION"),
			Sovereign: propString(props, "SOVEREIGNT"),
		}
		svc.countries = append(svc.countries, c)
	}

	svc.loaded = true
	globalNaturalEarth = svc
	log.Printf("NaturalEarth: loaded %d country features from %s", len(svc.countries), path)
	return nil
}

// propString safely extracts a string property from a GeoJSON feature properties map.
func propString(props geojson.Properties, key string) string {
	v, ok := props[key]
	if !ok || v == nil {
		return ""
	}
	switch s := v.(type) {
	case string:
		return s
	default:
		return fmt.Sprintf("%v", v)
	}
}

// continentCodeMap maps Natural Earth CONTINENT field values (full names) to
// the 2-letter ham-radio / CTY continent codes used throughout the codebase
// and expected by the WSPR rank frontend filter.
var continentCodeMap = map[string]string{
	"Europe":                  "EU",
	"Asia":                    "AS",
	"Africa":                  "AF",
	"Oceania":                 "OC",
	"North America":           "NA",
	"South America":           "SA",
	"Antarctica":              "AN",
	"Seven seas (open ocean)": "",
}

// continentCode returns the 2-letter code for a Natural Earth continent name,
// or an empty string if the name is not recognised.
func continentCode(name string) string {
	return continentCodeMap[name]
}

// MaidenheadCountryResult is the result of a Maidenhead → country lookup.
type MaidenheadCountryResult struct {
	Locator       string  `json:"locator"`
	Lat           float64 `json:"lat"`
	Lon           float64 `json:"lon"`
	MinLat        float64 `json:"grid_min_lat"`
	MinLon        float64 `json:"grid_min_lon"`
	MaxLat        float64 `json:"grid_max_lat"`
	MaxLon        float64 `json:"grid_max_lon"`
	Country       string  `json:"country"`
	CountryLong   string  `json:"country_long"`
	ISOA2         string  `json:"iso_a2"`
	ISOA3         string  `json:"iso_a3"`
	Continent     string  `json:"continent"`      // full name, e.g. "Europe"
	ContinentCode string  `json:"continent_code"` // 2-letter code, e.g. "EU"
	Region        string  `json:"region"`
	Subregion     string  `json:"subregion"`
	Sovereign     string  `json:"sovereign"`
	Method        string  `json:"method"` // "intersection", "largest_overlap", "point_in_polygon", or "nearest_land"
}

// LookupMaidenhead converts a Maidenhead grid locator to a country.
// It uses the full grid square polygon (not just the centre point) to handle
// squares that straddle borders or whose centre falls in water.
// Results are cached indefinitely — country boundaries don't change at runtime.
func (svc *NaturalEarthService) LookupMaidenhead(locator string) (*MaidenheadCountryResult, error) {
	if !svc.loaded {
		return nil, fmt.Errorf("natural earth service not loaded")
	}

	// Normalise to uppercase for consistent cache keys
	cacheKey := strings.ToUpper(locator)

	// Check cache first — avoids the expensive grid-sampling computation on repeat lookups
	if v, ok := svc.locatorCache.Load(cacheKey); ok {
		return v.(*MaidenheadCountryResult), nil
	}

	minLat, minLon, maxLat, maxLon, err := maidenheadToBBox(locator)
	if err != nil {
		return nil, err
	}

	centreLat := (minLat + maxLat) / 2
	centreLon := (minLon + maxLon) / 2

	// Build the grid square as an orb.Ring (closed polygon)
	gridRing := orb.Ring{
		{minLon, minLat},
		{maxLon, minLat},
		{maxLon, maxLat},
		{minLon, maxLat},
		{minLon, minLat}, // close
	}
	gridPoly := orb.Polygon{gridRing}

	svc.mu.RLock()
	defer svc.mu.RUnlock()

	// Pass 1: find all countries whose geometry intersects the grid square.
	// Pick the one with the largest intersection area.
	type candidate struct {
		country *NaturalEarthCountry
		area    float64
	}
	var candidates []candidate

	for _, c := range svc.countries {
		if !boundingBoxOverlaps(c.Geometry.Bound(), gridPoly.Bound()) {
			continue
		}
		area := intersectionArea(c.Geometry, gridPoly)
		if area > 0 {
			candidates = append(candidates, candidate{c, area})
		}
	}

	if len(candidates) > 0 {
		// Find the candidate with the largest overlap
		best := candidates[0]
		for _, cand := range candidates[1:] {
			if cand.area > best.area {
				best = cand
			}
		}

		method := "intersection"
		if len(candidates) > 1 {
			method = "largest_overlap"
		}

		result := buildResult(locator, centreLat, centreLon, minLat, minLon, maxLat, maxLon, best.country, method)
		svc.cacheLocator(cacheKey, result)
		return result, nil
	}

	// Pass 2: no intersection — grid square is entirely in open ocean or unclaimed territory.
	// Fall back to the nearest country by distance from the grid square centre.
	centrePoint := orb.Point{centreLon, centreLat}
	var nearest *NaturalEarthCountry
	nearestDist := math.MaxFloat64

	for _, c := range svc.countries {
		dist := geometryDistance(c.Geometry, centrePoint)
		if dist < nearestDist {
			nearestDist = dist
			nearest = c
		}
	}

	if nearest != nil {
		result := buildResult(locator, centreLat, centreLon, minLat, minLon, maxLat, maxLon, nearest, "nearest_land")
		svc.cacheLocator(cacheKey, result)
		return result, nil
	}

	return nil, fmt.Errorf("no country found for locator %s", locator)
}

// cacheLocator stores a result in the locator cache if the cache is not full.
func (svc *NaturalEarthService) cacheLocator(key string, result *MaidenheadCountryResult) {
	if svc.locatorCacheN.Load() >= locatorCacheMaxSize {
		return // cache full — skip storing (existing entries remain valid)
	}
	if _, loaded := svc.locatorCache.LoadOrStore(key, result); !loaded {
		svc.locatorCacheN.Add(1)
	}
}

// LookupLatLon resolves a latitude/longitude coordinate pair to a country.
// Unlike LookupMaidenhead, this tests a single point (no grid square polygon).
// If the point falls in water, it falls back to the nearest country by distance.
func (svc *NaturalEarthService) LookupLatLon(lat, lon float64) (*MaidenheadCountryResult, error) {
	if !svc.loaded {
		return nil, fmt.Errorf("natural earth service not loaded")
	}
	if lat < -90 || lat > 90 {
		return nil, fmt.Errorf("latitude %g out of range [-90, 90]", lat)
	}
	if lon < -180 || lon > 180 {
		return nil, fmt.Errorf("longitude %g out of range [-180, 180]", lon)
	}

	pt := orb.Point{lon, lat}
	ptBound := orb.Bound{Min: pt, Max: pt}

	svc.mu.RLock()
	defer svc.mu.RUnlock()

	// Pass 1: exact point-in-polygon
	for _, c := range svc.countries {
		if !boundingBoxOverlaps(c.Geometry.Bound(), ptBound) {
			continue
		}
		if pointInGeometry(c.Geometry, pt) {
			return buildResult("", lat, lon, lat, lon, lat, lon, c, "point_in_polygon"), nil
		}
	}

	// Pass 2: nearest land (point is in water or unclaimed territory)
	var nearest *NaturalEarthCountry
	nearestDist := math.MaxFloat64
	for _, c := range svc.countries {
		dist := geometryDistance(c.Geometry, pt)
		if dist < nearestDist {
			nearestDist = dist
			nearest = c
		}
	}
	if nearest != nil {
		return buildResult("", lat, lon, lat, lon, lat, lon, nearest, "nearest_land"), nil
	}

	return nil, fmt.Errorf("no country found for coordinates (%g, %g)", lat, lon)
}

// buildResult constructs a MaidenheadCountryResult from a matched country.
func buildResult(locator string, centreLat, centreLon, minLat, minLon, maxLat, maxLon float64, c *NaturalEarthCountry, method string) *MaidenheadCountryResult {
	return &MaidenheadCountryResult{
		Locator:       locator,
		Lat:           centreLat,
		Lon:           centreLon,
		MinLat:        minLat,
		MinLon:        minLon,
		MaxLat:        maxLat,
		MaxLon:        maxLon,
		Country:       c.Name,
		CountryLong:   c.NameLong,
		ISOA2:         c.resolvedISO2(),
		ISOA3:         c.resolvedISO3(),
		Continent:     c.Continent,
		ContinentCode: continentCode(c.Continent),
		Region:        c.Region,
		Subregion:     c.Subregion,
		Sovereign:     c.Sovereign,
		Method:        method,
	}
}

// maidenheadToBBox converts a Maidenhead locator to its bounding box.
// Returns (minLat, minLon, maxLat, maxLon).
// Supports 4, 6, or 8 character locators.
func maidenheadToBBox(locator string) (minLat, minLon, maxLat, maxLon float64, err error) {
	// Reuse the existing MaidenheadToLatLon validation by calling it on the locator.
	// We compute the bbox manually here to avoid importing the centre-point function.
	if len(locator) != 4 && len(locator) != 6 && len(locator) != 8 {
		return 0, 0, 0, 0, fmt.Errorf("invalid Maidenhead locator length %d (must be 4, 6, or 8)", len(locator))
	}

	upper := make([]byte, len(locator))
	for i, ch := range locator {
		if ch >= 'a' && ch <= 'z' {
			upper[i] = byte(ch - 32)
		} else {
			upper[i] = byte(ch)
		}
	}
	loc := string(upper)

	// Validate
	if loc[0] < 'A' || loc[0] > 'R' || loc[1] < 'A' || loc[1] > 'R' {
		return 0, 0, 0, 0, fmt.Errorf("invalid field characters in %s", locator)
	}
	if loc[2] < '0' || loc[2] > '9' || loc[3] < '0' || loc[3] > '9' {
		return 0, 0, 0, 0, fmt.Errorf("invalid square characters in %s", locator)
	}
	if len(loc) >= 6 && (loc[4] < 'A' || loc[4] > 'X' || loc[5] < 'A' || loc[5] > 'X') {
		return 0, 0, 0, 0, fmt.Errorf("invalid subsquare characters in %s", locator)
	}
	if len(loc) == 8 && (loc[6] < '0' || loc[6] > '9' || loc[7] < '0' || loc[7] > '9') {
		return 0, 0, 0, 0, fmt.Errorf("invalid extended square characters in %s", locator)
	}

	lon := float64(loc[0]-'A') * 20.0
	lat := float64(loc[1]-'A') * 10.0

	lon += float64(loc[2]-'0') * 2.0
	lat += float64(loc[3]-'0') * 1.0

	var dLon, dLat float64
	switch len(loc) {
	case 4:
		dLon, dLat = 2.0, 1.0
	case 6:
		lon += float64(loc[4]-'A') * (2.0 / 24.0)
		lat += float64(loc[5]-'A') * (1.0 / 24.0)
		dLon, dLat = 2.0/24.0, 1.0/24.0
	case 8:
		lon += float64(loc[4]-'A') * (2.0 / 24.0)
		lat += float64(loc[5]-'A') * (1.0 / 24.0)
		lon += float64(loc[6]-'0') * (2.0 / 240.0)
		lat += float64(loc[7]-'0') * (1.0 / 240.0)
		dLon, dLat = 2.0/240.0, 1.0/240.0
	}

	// Convert bottom-left corner to standard coordinates
	minLon = lon - 180.0
	minLat = lat - 90.0
	maxLon = minLon + dLon
	maxLat = minLat + dLat
	return minLat, minLon, maxLat, maxLon, nil
}

// boundingBoxOverlaps returns true if two orb.Bounds overlap.
func boundingBoxOverlaps(a, b orb.Bound) bool {
	return a.Min[0] <= b.Max[0] && a.Max[0] >= b.Min[0] &&
		a.Min[1] <= b.Max[1] && a.Max[1] >= b.Min[1]
}

// intersectionArea computes the approximate area of intersection between a country
// geometry and the grid square polygon using a sampling approach.
// We use planar.PolygonContains / planar.MultiPolygonContains for point-in-polygon tests
// on a grid of sample points within the grid square.
func intersectionArea(geom orb.Geometry, grid orb.Polygon) float64 {
	bound := grid.Bound()
	// Use a 10×10 sample grid within the grid square
	const samples = 10
	dLon := (bound.Max[0] - bound.Min[0]) / samples
	dLat := (bound.Max[1] - bound.Min[1]) / samples
	cellArea := dLon * dLat

	count := 0
	for i := 0; i < samples; i++ {
		for j := 0; j < samples; j++ {
			lon := bound.Min[0] + (float64(i)+0.5)*dLon
			lat := bound.Min[1] + (float64(j)+0.5)*dLat
			pt := orb.Point{lon, lat}
			if pointInGeometry(geom, pt) {
				count++
			}
		}
	}

	return float64(count) * cellArea
}

// pointInGeometry tests whether a point is inside a geometry (Polygon or MultiPolygon).
func pointInGeometry(geom orb.Geometry, pt orb.Point) bool {
	switch g := geom.(type) {
	case orb.Polygon:
		return planar.PolygonContains(g, pt)
	case orb.MultiPolygon:
		return planar.MultiPolygonContains(g, pt)
	default:
		return false
	}
}

// geometryDistance returns the minimum squared-degree distance from a point to any
// vertex of the geometry. Used only for the open-ocean fallback (nearest land).
// This is an approximation — good enough for finding the nearest country.
func geometryDistance(geom orb.Geometry, pt orb.Point) float64 {
	minDist := math.MaxFloat64

	visitRing := func(ring orb.Ring) {
		for _, v := range ring {
			dx := v[0] - pt[0]
			dy := v[1] - pt[1]
			d := dx*dx + dy*dy
			if d < minDist {
				minDist = d
			}
		}
	}

	switch g := geom.(type) {
	case orb.Polygon:
		for _, ring := range g {
			visitRing(ring)
		}
	case orb.MultiPolygon:
		for _, poly := range g {
			for _, ring := range poly {
				visitRing(ring)
			}
		}
	}

	return minDist
}

// GetCountryForMaidenhead is a convenience function using the global service.
func GetCountryForMaidenhead(locator string) (*MaidenheadCountryResult, error) {
	if globalNaturalEarth == nil {
		return nil, fmt.Errorf("natural earth service not initialised")
	}
	return globalNaturalEarth.LookupMaidenhead(locator)
}

// GetCountryForLatLon is a convenience function using the global service.
func GetCountryForLatLon(lat, lon float64) (*MaidenheadCountryResult, error) {
	if globalNaturalEarth == nil {
		return nil, fmt.Errorf("natural earth service not initialised")
	}
	return globalNaturalEarth.LookupLatLon(lat, lon)
}

// NaturalEarthEnabled returns true if the service has been successfully loaded.
func NaturalEarthEnabled() bool {
	return globalNaturalEarth != nil && globalNaturalEarth.loaded
}

// naturalEarthHealthJSON returns a JSON snippet for health checks.
func naturalEarthHealthJSON() map[string]interface{} {
	if globalNaturalEarth == nil || !globalNaturalEarth.loaded {
		return map[string]interface{}{"enabled": false}
	}
	globalNaturalEarth.mu.RLock()
	n := len(globalNaturalEarth.countries)
	globalNaturalEarth.mu.RUnlock()
	return map[string]interface{}{
		"enabled":  true,
		"features": n,
	}
}

// Ensure json import is used (for propString fallback formatting)
var _ = json.Marshal
