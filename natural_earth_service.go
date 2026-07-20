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

// preparedPolygon is one polygon of a country's geometry with its outer-ring
// bounding box precomputed.
//
// orb recomputes Ring.Bound() from scratch on every RingContains call, which
// means rejecting a point against Canada's 412 sub-polygons walks all 68,000 of
// its vertices — every time.  Caching the bound turns that rejection into a
// four-comparison test.
type preparedPolygon struct {
	rings []preparedRing // rings[0] is the outer ring, the rest are holes
	bound orb.Bound      // == poly[0].Bound(), the outer ring's bound
}

// preparedRing is a ring with a cached bound and a longitude "slab" index over
// its edges.
//
// The ray-casting test walks every edge of the ring, but an edge can only affect
// the outcome when the query point's longitude lies within that edge's longitude
// span — see ringContains.  Bucketing edges by longitude therefore lets a query
// visit a few dozen edges instead of all 14,000 of (say) China's outer ring,
// without changing the answer.
// The slab index is stored CSR-style — one flat edge-id array plus per-slab
// offsets — rather than a slice of slices, which would cost a 24-byte header and
// a separate allocation for each of the ~68,000 slabs in the dataset.
type preparedRing struct {
	ring      orb.Ring
	bound     orb.Bound
	minX      float64
	slabW     float64
	slabStart []int32 // len = nSlabs+1; slab s owns slabEdges[slabStart[s]:slabStart[s+1]]
	slabEdges []int32 // edge ids; see ringEdge for the encoding
}

// preparedGeometry is the query-optimised form of a country's geometry.
// It is built once at load time and is read-only thereafter.
type preparedGeometry struct {
	bound orb.Bound         // == Geometry.Bound()
	polys []preparedPolygon // one entry per polygon (a Polygon geometry yields one)
}

// NaturalEarthCountry holds the parsed geometry and key properties for one country feature.
type NaturalEarthCountry struct {
	Geometry  orb.Geometry
	prepared  preparedGeometry
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

// Spatial index geometry: the world is divided into 1°×1° cells and each cell
// records which countries have a polygon whose bounding box touches it.  A 4-char
// Maidenhead square (2°×1°) touches at most six cells, so a lookup considers a
// handful of countries instead of all 258.
const (
	neCellSize = 1.0 // degrees
	neCellsX   = int(360 / neCellSize)
	neCellsY   = int(180 / neCellSize)
)

// NaturalEarthService loads and queries the Natural Earth country boundary dataset.
type NaturalEarthService struct {
	countries []*NaturalEarthCountry

	// cellIndex[y*neCellsX+x] lists the indices into countries of every country
	// with a polygon overlapping that cell, in ascending order.  Built once at
	// load time, never mutated afterwards, so it needs no locking.
	cellIndex [][]int32

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
		c.prepared = prepareGeometry(feat.Geometry)
		svc.countries = append(svc.countries, c)
	}

	svc.buildCellIndex()

	svc.loaded = true
	globalNaturalEarth = svc
	log.Printf("NaturalEarth: loaded %d country features from %s", len(svc.countries), path)
	return nil
}

// prepareGeometry precomputes the per-polygon bounds and per-ring edge indexes
// used by the hot query paths.
func prepareGeometry(geom orb.Geometry) preparedGeometry {
	var p preparedGeometry

	addPolygon := func(poly orb.Polygon) {
		if len(poly) == 0 {
			return
		}
		rings := make([]preparedRing, 0, len(poly))
		for _, ring := range poly {
			rings = append(rings, prepareRing(ring))
		}
		p.polys = append(p.polys, preparedPolygon{rings: rings, bound: rings[0].bound})
	}

	switch g := geom.(type) {
	case orb.Polygon:
		addPolygon(g)
	case orb.MultiPolygon:
		for _, poly := range g {
			addPolygon(poly)
		}
	}

	p.bound = geom.Bound()
	return p
}

// ringEdge returns the edge with the given id: ids 0..len(ring)-2 are the
// consecutive edges ring[id]→ring[id+1], and the final id len(ring)-1 is the
// closing edge ring[0]→ring[len(ring)-1] that planar.RingContains tests
// separately.
func ringEdge(ring orb.Ring, id int32) (orb.Point, orb.Point) {
	if int(id) == len(ring)-1 {
		return ring[0], ring[len(ring)-1]
	}
	return ring[id], ring[id+1]
}

// ringSlabTarget is the average number of edges to aim for per longitude slab.
const ringSlabTarget = 8

// prepareRing builds the cached bound and longitude slab index for a ring.
func prepareRing(ring orb.Ring) preparedRing {
	pr := preparedRing{ring: ring, bound: ring.Bound()}
	if len(ring) < 2 {
		return pr // degenerate; ringContains falls back to planar.RingContains
	}

	nSlabs := len(ring) / ringSlabTarget
	if nSlabs < 1 {
		nSlabs = 1
	}
	if nSlabs > 4096 {
		nSlabs = 4096
	}

	width := pr.bound.Max[0] - pr.bound.Min[0]
	if width <= 0 {
		return pr // zero-width ring; leave slabs nil so we scan all edges
	}

	pr.minX = pr.bound.Min[0]
	pr.slabW = width / float64(nSlabs)

	slabOf := func(x float64) int {
		s := int((x - pr.minX) / pr.slabW)
		if s < 0 {
			return 0
		}
		if s >= nSlabs {
			return nSlabs - 1
		}
		return s
	}

	// edgeSlabs yields the inclusive slab range an edge spans. floor() is
	// monotonic, so any x within [lo, hi] lands between these two slabs.
	edgeSlabs := func(id int32) (int, int) {
		a, b := ringEdge(ring, id)
		lo, hi := a[0], b[0]
		if lo > hi {
			lo, hi = hi, lo
		}
		return slabOf(lo), slabOf(hi)
	}

	// Pass 1: count edges per slab. Pass 2: fill. Building the CSR arrays this
	// way avoids per-slab reallocation.
	counts := make([]int32, nSlabs+1)
	total := 0
	for id := int32(0); int(id) < len(ring); id++ {
		s0, s1 := edgeSlabs(id)
		for s := s0; s <= s1; s++ {
			counts[s]++
			total++
		}
	}

	pr.slabStart = make([]int32, nSlabs+1)
	var running int32
	for s := 0; s < nSlabs; s++ {
		pr.slabStart[s] = running
		running += counts[s]
	}
	pr.slabStart[nSlabs] = running

	pr.slabEdges = make([]int32, total)
	fill := make([]int32, nSlabs) // next free offset within each slab
	copy(fill, pr.slabStart[:nSlabs])
	for id := int32(0); int(id) < len(ring); id++ {
		s0, s1 := edgeSlabs(id)
		for s := s0; s <= s1; s++ {
			pr.slabEdges[fill[s]] = id
			fill[s]++
		}
	}
	return pr
}

// contains reports whether pt is inside the ring, matching planar.RingContains
// exactly (boundary points count as inside).
//
// Only edges whose longitude span brackets pt's longitude are visited. That is
// safe because planar.rayIntersect returns "no intersection, not on boundary"
// for every edge with p[0] < min(s[0], e[0]) or p[0] > max(s[0], e[0]): each of
// its early boundary returns is guarded by p[0] == s[0] or p[0] == e[0], both of
// which lie inside the span. The crossing count is a parity, so visiting the
// remaining edges in slab order rather than ring order does not change it.
func (pr *preparedRing) contains(pt orb.Point) bool {
	if !pr.bound.Contains(pt) {
		return false
	}
	if pr.slabStart == nil {
		return planar.RingContains(pr.ring, pt)
	}

	nSlabs := len(pr.slabStart) - 1
	s := int((pt[0] - pr.minX) / pr.slabW)
	if s < 0 {
		s = 0
	}
	if s >= nSlabs {
		s = nSlabs - 1
	}

	crossings := false
	for _, id := range pr.slabEdges[pr.slabStart[s]:pr.slabStart[s+1]] {
		a, b := ringEdge(pr.ring, id)
		inter, on := rayIntersect(pt, a, b)
		if on {
			return true
		}
		if inter {
			crossings = !crossings
		}
	}
	return crossings
}

// polygonContains reports whether pt is inside the polygon: inside the outer
// ring and outside every hole. Equivalent to planar.PolygonContains.
func (pp *preparedPolygon) contains(pt orb.Point) bool {
	if !pp.rings[0].contains(pt) {
		return false
	}
	for i := 1; i < len(pp.rings); i++ {
		if pp.rings[i].contains(pt) {
			return false
		}
	}
	return true
}

// rayIntersect is a verbatim copy of the unexported planar.rayIntersect from
// github.com/paulmach/orb (MIT licensed). It is duplicated here so that the
// slab-indexed ring test above produces bit-identical results to
// planar.RingContains; do not "clean it up" — the degenerate cases matter.
func rayIntersect(p, s, e orb.Point) (intersects, on bool) {
	if s[0] > e[0] {
		s, e = e, s
	}

	switch p[0] {
	case s[0]:
		if p[1] == s[1] {
			// p == start
			return false, true
		} else if s[0] == e[0] {
			// vertical segment (s -> e)
			// return true if within the line, check to see if start or end is greater.
			if s[1] > e[1] && s[1] >= p[1] && p[1] >= e[1] {
				return false, true
			}

			if e[1] > s[1] && e[1] >= p[1] && p[1] >= s[1] {
				return false, true
			}
		}

		// Move the y coordinate to deal with degenerate case
		p[0] = math.Nextafter(p[0], math.Inf(1))
	case e[0]:
		if p[1] == e[1] {
			// matching the end point
			return false, true
		}

		p[0] = math.Nextafter(p[0], math.Inf(1))
	}

	if p[0] < s[0] || p[0] > e[0] {
		return false, false
	}

	if s[1] > e[1] {
		if p[1] > s[1] {
			return false, false
		} else if p[1] < e[1] {
			return true, false
		}
	} else {
		if p[1] > e[1] {
			return false, false
		} else if p[1] < s[1] {
			return true, false
		}
	}

	rs := (p[1] - s[1]) / (p[0] - s[0])
	ds := (e[1] - s[1]) / (e[0] - s[0])

	if rs == ds {
		return false, true
	}

	return rs <= ds, false
}

// buildCellIndex populates the 1°×1° cell → country index.
func (svc *NaturalEarthService) buildCellIndex() {
	svc.cellIndex = make([][]int32, neCellsX*neCellsY)

	for ci, c := range svc.countries {
		// Track which cells this country has already claimed so a country with
		// many polygons in the same cell is only recorded once.
		seen := make(map[int]struct{})
		for _, pp := range c.prepared.polys {
			x0, y0, x1, y1 := cellRange(pp.bound)
			for y := y0; y <= y1; y++ {
				for x := x0; x <= x1; x++ {
					idx := y*neCellsX + x
					if _, dup := seen[idx]; dup {
						continue
					}
					seen[idx] = struct{}{}
					svc.cellIndex[idx] = append(svc.cellIndex[idx], int32(ci))
				}
			}
		}
	}
}

// cellRange returns the inclusive cell coordinates covered by a bound.
func cellRange(b orb.Bound) (x0, y0, x1, y1 int) {
	clamp := func(v, hi int) int {
		if v < 0 {
			return 0
		}
		if v > hi {
			return hi
		}
		return v
	}
	x0 = clamp(int(math.Floor((b.Min[0]+180)/neCellSize)), neCellsX-1)
	x1 = clamp(int(math.Floor((b.Max[0]+180)/neCellSize)), neCellsX-1)
	y0 = clamp(int(math.Floor((b.Min[1]+90)/neCellSize)), neCellsY-1)
	y1 = clamp(int(math.Floor((b.Max[1]+90)/neCellSize)), neCellsY-1)
	return
}

// candidatesForBound returns the indices of countries with a polygon whose
// bounding box may overlap the given bound, in ascending index order.
//
// This is a conservative superset filter: callers still apply the exact
// bounding-box and geometry tests, so results are identical to scanning every
// country.  Ascending order preserves the original first-match tie-breaking.
func (svc *NaturalEarthService) candidatesForBound(b orb.Bound) []int32 {
	seen := make([]bool, len(svc.countries))
	x0, y0, x1, y1 := cellRange(b)
	n := 0
	for y := y0; y <= y1; y++ {
		row := y * neCellsX
		for x := x0; x <= x1; x++ {
			for _, ci := range svc.cellIndex[row+x] {
				if !seen[ci] {
					seen[ci] = true
					n++
				}
			}
		}
	}
	out := make([]int32, 0, n)
	for i, ok := range seen {
		if ok {
			out = append(out, int32(i))
		}
	}
	return out
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
	gridBound := gridPoly.Bound()

	svc.mu.RLock()
	defer svc.mu.RUnlock()

	// Pass 1: find all countries whose geometry intersects the grid square.
	// Pick the one with the largest intersection area.
	// The sample points are shared across candidates so they are computed once.
	samples, cellArea := gridSamplePoints(gridBound)

	var (
		bestCountry *NaturalEarthCountry
		bestArea    float64
		nCandidates int
	)

	for _, ci := range svc.candidatesForBound(gridBound) {
		c := svc.countries[ci]
		if !boundingBoxOverlaps(c.prepared.bound, gridBound) {
			continue
		}
		area := intersectionArea(&c.prepared, gridBound, samples, cellArea)
		if area > 0 {
			nCandidates++
			// Strictly greater keeps the first candidate on ties, matching the
			// original scan order.
			if bestCountry == nil || area > bestArea {
				bestCountry, bestArea = c, area
			}
		}
	}

	if bestCountry != nil {
		method := "intersection"
		if nCandidates > 1 {
			method = "largest_overlap"
		}

		result := buildResult(locator, centreLat, centreLon, minLat, minLon, maxLat, maxLon, bestCountry, method)
		svc.cacheLocator(cacheKey, result)
		return result, nil
	}

	// Pass 2: no intersection — grid square is entirely in open ocean or unclaimed territory.
	// Fall back to the nearest country by distance from the grid square centre.
	centrePoint := orb.Point{centreLon, centreLat}
	nearest := svc.nearestCountry(centrePoint)

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
	for _, ci := range svc.candidatesForBound(ptBound) {
		c := svc.countries[ci]
		if !boundingBoxOverlaps(c.prepared.bound, ptBound) {
			continue
		}
		if pointInGeometry(&c.prepared, pt) {
			return buildResult("", lat, lon, lat, lon, lat, lon, c, "point_in_polygon"), nil
		}
	}

	// Pass 2: nearest land (point is in water or unclaimed territory)
	nearest := svc.nearestCountry(pt)
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

// gridSampleCount is the resolution of the sampling grid used to approximate
// the overlap area between a Maidenhead square and a country (10×10 = 100 points).
const gridSampleCount = 10

// gridSamplePoints returns the sample points at the centre of each sub-cell of
// the grid square, plus the area of one sub-cell.  The points depend only on the
// grid square, so they are computed once per lookup and reused for every country.
func gridSamplePoints(bound orb.Bound) ([]orb.Point, float64) {
	dLon := (bound.Max[0] - bound.Min[0]) / gridSampleCount
	dLat := (bound.Max[1] - bound.Min[1]) / gridSampleCount

	pts := make([]orb.Point, 0, gridSampleCount*gridSampleCount)
	for i := 0; i < gridSampleCount; i++ {
		lon := bound.Min[0] + (float64(i)+0.5)*dLon
		for j := 0; j < gridSampleCount; j++ {
			lat := bound.Min[1] + (float64(j)+0.5)*dLat
			pts = append(pts, orb.Point{lon, lat})
		}
	}
	return pts, dLon * dLat
}

// intersectionArea computes the approximate area of intersection between a country
// geometry and the grid square by counting how many sample points fall inside it.
//
// Polygons whose bounding box misses the grid square entirely are discarded once
// up front rather than re-tested for each of the 100 sample points.
func intersectionArea(prep *preparedGeometry, gridBound orb.Bound, samples []orb.Point, cellArea float64) float64 {
	// Collect the polygons that could contain any sample point. Sample points
	// all lie within gridBound, so a polygon whose bound misses gridBound cannot
	// contain any of them.
	var relevant []preparedPolygon
	for _, pp := range prep.polys {
		if boundingBoxOverlaps(pp.bound, gridBound) {
			relevant = append(relevant, pp)
		}
	}
	if len(relevant) == 0 {
		return 0
	}

	count := 0
	for _, pt := range samples {
		for _, pp := range relevant {
			if !pp.bound.Contains(pt) {
				continue
			}
			if pp.contains(pt) {
				count++
				break
			}
		}
	}

	return float64(count) * cellArea
}

// pointInGeometry tests whether a point is inside a prepared geometry.
//
// This is equivalent to planar.MultiPolygonContains, but skips polygons using the
// cached outer-ring bound instead of recomputing it on every call.
func pointInGeometry(prep *preparedGeometry, pt orb.Point) bool {
	for _, pp := range prep.polys {
		if !pp.bound.Contains(pt) {
			continue
		}
		if pp.contains(pt) {
			return true
		}
	}
	return false
}

// nearestCountry returns the country with the vertex closest to pt, or nil if the
// dataset is empty. Used only for the open-ocean fallback (nearest land).
// Distance is squared degrees — an approximation, good enough for ranking.
// The result is identical to scanning every vertex of every country: the
// distance from pt to a polygon's bounding box is a lower bound on the distance
// to any of its vertices, so a polygon whose box already sits further away than
// a known-achievable distance cannot hold the winning vertex.
func (svc *NaturalEarthService) nearestCountry(pt orb.Point) *NaturalEarthCountry {
	// limit is an upper bound on the true minimum distance. Seeding it with a
	// real measurement from the closest-looking polygon lets the scan below
	// discard the overwhelming majority of the dataset without touching it.
	limit := svc.seedNearestLimit(pt)

	var nearest *NaturalEarthCountry
	nearestDist := math.MaxFloat64

	for _, c := range svc.countries {
		if boundDistanceSq(c.prepared.bound, pt) > limit {
			continue
		}
		best := math.MaxFloat64
		for _, pp := range c.prepared.polys {
			if boundDistanceSq(pp.bound, pt) > limit {
				continue
			}
			if d := pp.verticesDistanceSq(pt); d < best {
				best = d
			}
		}
		// Strictly-less keeps the first country on ties, matching a plain scan.
		if best < nearestDist {
			nearestDist = best
			nearest = c
			if nearestDist < limit {
				limit = nearestDist
			}
		}
	}

	return nearest
}

// seedNearestLimit measures the true vertex distance to whichever polygon's
// bounding box lies closest to pt, giving a tight upper bound on the global
// minimum for a few thousand cheap box comparisons.
func (svc *NaturalEarthService) seedNearestLimit(pt orb.Point) float64 {
	var (
		bestPoly *preparedPolygon
		bestBox  = math.MaxFloat64
	)
	for _, c := range svc.countries {
		if boundDistanceSq(c.prepared.bound, pt) > bestBox {
			continue
		}
		for i := range c.prepared.polys {
			pp := &c.prepared.polys[i]
			if d := boundDistanceSq(pp.bound, pt); d < bestBox {
				bestBox, bestPoly = d, pp
			}
		}
	}
	if bestPoly == nil {
		return math.MaxFloat64
	}
	return bestPoly.verticesDistanceSq(pt)
}

// boundDistanceSq returns the squared distance from a point to a bounding box
// (zero if the point is inside).
func boundDistanceSq(b orb.Bound, pt orb.Point) float64 {
	dx := math.Max(math.Max(b.Min[0]-pt[0], pt[0]-b.Max[0]), 0)
	dy := math.Max(math.Max(b.Min[1]-pt[1], pt[1]-b.Max[1]), 0)
	return dx*dx + dy*dy
}

// verticesDistanceSq returns the minimum squared distance from pt to any vertex
// of the polygon, holes included.
func (pp *preparedPolygon) verticesDistanceSq(pt orb.Point) float64 {
	minDist := math.MaxFloat64
	px, py := pt[0], pt[1]
	for i := range pp.rings {
		for _, v := range pp.rings[i].ring {
			dx := v[0] - px
			dy := v[1] - py
			if d := dx*dx + dy*dy; d < minDist {
				minDist = d
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
