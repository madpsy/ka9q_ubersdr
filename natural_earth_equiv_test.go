package main

import (
	"fmt"
	"math"
	"math/rand"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/paulmach/orb"
	"github.com/paulmach/orb/planar"
)

// This file contains a faithful reimplementation of the ORIGINAL (pre-optimisation)
// Natural Earth lookup algorithm — full linear scans, orb's planar helpers, no
// caches or indexes — and checks the optimised implementation against it.
//
// The optimised code is only allowed to be faster, never different.

// ---------------------------------------------------- reference implementation

func refPointInGeometry(geom orb.Geometry, pt orb.Point) bool {
	switch g := geom.(type) {
	case orb.Polygon:
		return planar.PolygonContains(g, pt)
	case orb.MultiPolygon:
		return planar.MultiPolygonContains(g, pt)
	default:
		return false
	}
}

func refIntersectionArea(geom orb.Geometry, grid orb.Polygon) float64 {
	bound := grid.Bound()
	const samples = 10
	dLon := (bound.Max[0] - bound.Min[0]) / samples
	dLat := (bound.Max[1] - bound.Min[1]) / samples
	cellArea := dLon * dLat

	count := 0
	for i := 0; i < samples; i++ {
		for j := 0; j < samples; j++ {
			lon := bound.Min[0] + (float64(i)+0.5)*dLon
			lat := bound.Min[1] + (float64(j)+0.5)*dLat
			if refPointInGeometry(geom, orb.Point{lon, lat}) {
				count++
			}
		}
	}
	return float64(count) * cellArea
}

func refGeometryDistance(geom orb.Geometry, pt orb.Point) float64 {
	minDist := math.MaxFloat64
	visitRing := func(ring orb.Ring) {
		for _, v := range ring {
			dx := v[0] - pt[0]
			dy := v[1] - pt[1]
			if d := dx*dx + dy*dy; d < minDist {
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

func refBoundsOverlap(a, b orb.Bound) bool {
	return a.Min[0] <= b.Max[0] && a.Max[0] >= b.Min[0] &&
		a.Min[1] <= b.Max[1] && a.Max[1] >= b.Min[1]
}

// refLookupMaidenhead is the original LookupMaidenhead, minus the cache.
func refLookupMaidenhead(svc *NaturalEarthService, locator string) (*MaidenheadCountryResult, error) {
	minLat, minLon, maxLat, maxLon, err := maidenheadToBBox(locator)
	if err != nil {
		return nil, err
	}
	centreLat := (minLat + maxLat) / 2
	centreLon := (minLon + maxLon) / 2

	gridPoly := orb.Polygon{orb.Ring{
		{minLon, minLat}, {maxLon, minLat}, {maxLon, maxLat}, {minLon, maxLat}, {minLon, minLat},
	}}

	type candidate struct {
		country *NaturalEarthCountry
		area    float64
	}
	var candidates []candidate
	for _, c := range svc.countries {
		if !refBoundsOverlap(c.Geometry.Bound(), gridPoly.Bound()) {
			continue
		}
		if area := refIntersectionArea(c.Geometry, gridPoly); area > 0 {
			candidates = append(candidates, candidate{c, area})
		}
	}

	if len(candidates) > 0 {
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
		return buildResult(locator, centreLat, centreLon, minLat, minLon, maxLat, maxLon, best.country, method), nil
	}

	centrePoint := orb.Point{centreLon, centreLat}
	var nearest *NaturalEarthCountry
	nearestDist := math.MaxFloat64
	for _, c := range svc.countries {
		if d := refGeometryDistance(c.Geometry, centrePoint); d < nearestDist {
			nearestDist = d
			nearest = c
		}
	}
	if nearest != nil {
		return buildResult(locator, centreLat, centreLon, minLat, minLon, maxLat, maxLon, nearest, "nearest_land"), nil
	}
	return nil, fmt.Errorf("no country found for locator %s", locator)
}

// refLookupLatLon is the original LookupLatLon.
func refLookupLatLon(svc *NaturalEarthService, lat, lon float64) (*MaidenheadCountryResult, error) {
	pt := orb.Point{lon, lat}
	ptBound := orb.Bound{Min: pt, Max: pt}

	for _, c := range svc.countries {
		if !refBoundsOverlap(c.Geometry.Bound(), ptBound) {
			continue
		}
		if refPointInGeometry(c.Geometry, pt) {
			return buildResult("", lat, lon, lat, lon, lat, lon, c, "point_in_polygon"), nil
		}
	}

	var nearest *NaturalEarthCountry
	nearestDist := math.MaxFloat64
	for _, c := range svc.countries {
		if d := refGeometryDistance(c.Geometry, pt); d < nearestDist {
			nearestDist = d
			nearest = c
		}
	}
	if nearest != nil {
		return buildResult("", lat, lon, lat, lon, lat, lon, nearest, "nearest_land"), nil
	}
	return nil, fmt.Errorf("no country found for coordinates (%g, %g)", lat, lon)
}

// ---------------------------------------------------------------- comparisons

func sameResult(a, b *MaidenheadCountryResult) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// TestNEEquivRingContains checks the slab-indexed ring test against
// planar.RingContains on adversarial points: every vertex of every ring, every
// edge midpoint, and random points across each ring's bounding box.  Vertices and
// edge midpoints exercise the exact boundary cases that rayIntersect treats
// specially.
func TestNEEquivRingContains(t *testing.T) {
	svc := testService(t)

	var rings []preparedRing
	for _, c := range svc.countries {
		for _, pp := range c.prepared.polys {
			rings = append(rings, pp.rings...)
		}
	}
	t.Logf("checking %d rings", len(rings))

	var checked, mismatches atomic.Int64
	var wg sync.WaitGroup
	work := make(chan int, len(rings))
	for i := range rings {
		work <- i
	}
	close(work)

	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rnd := rand.New(rand.NewSource(seed))
			for i := range work {
				pr := &rings[i]
				var pts []orb.Point

				// Every vertex, and every edge midpoint.
				for j := 0; j < len(pr.ring); j++ {
					pts = append(pts, pr.ring[j])
					if j+1 < len(pr.ring) {
						pts = append(pts, orb.Point{
							(pr.ring[j][0] + pr.ring[j+1][0]) / 2,
							(pr.ring[j][1] + pr.ring[j+1][1]) / 2,
						})
					}
				}
				// Random points over the ring's bound, slightly expanded.
				w := pr.bound.Max[0] - pr.bound.Min[0]
				h := pr.bound.Max[1] - pr.bound.Min[1]
				for k := 0; k < 200; k++ {
					pts = append(pts, orb.Point{
						pr.bound.Min[0] - 0.05*w + rnd.Float64()*1.1*w,
						pr.bound.Min[1] - 0.05*h + rnd.Float64()*1.1*h,
					})
				}

				for _, pt := range pts {
					got := pr.contains(pt)
					want := planar.RingContains(pr.ring, pt)
					checked.Add(1)
					if got != want {
						if mismatches.Add(1) <= 10 {
							t.Errorf("ring %d point %v: fast=%v orb=%v", i, pt, got, want)
						}
					}
				}
			}
		}(int64(w) + 1)
	}
	wg.Wait()
	t.Logf("checked %d point/ring tests, %d mismatches", checked.Load(), mismatches.Load())
}

// TestNEEquivAllSquares4 compares the optimised LookupMaidenhead against the
// reference implementation for every one of the 32,400 4-character locators.
// Slow (reference is ~50ms per lookup); run with NE_EXHAUSTIVE=1.
func TestNEEquivAllSquares4(t *testing.T) {
	svc := testService(t)
	locs := allSquares4()
	if testing.Short() {
		locs = locs[:200]
	}
	t.Logf("comparing %d locators against the reference implementation", len(locs))

	start := time.Now()
	var mismatches atomic.Int64
	var done atomic.Int64
	var wg sync.WaitGroup
	work := make(chan string, 256)

	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for loc := range work {
				want, errW := refLookupMaidenhead(svc, loc)
				got, errG := svc.LookupMaidenhead(loc)
				if (errW == nil) != (errG == nil) || !sameResult(want, got) {
					if mismatches.Add(1) <= 20 {
						t.Errorf("%s: fast=%+v (%v) ref=%+v (%v)", loc, got, errG, want, errW)
					}
				}
				done.Add(1)
			}
		}()
	}
	for _, l := range locs {
		work <- l
	}
	close(work)
	wg.Wait()
	t.Logf("compared %d locators in %v, %d mismatches", done.Load(), time.Since(start), mismatches.Load())
}

// TestNEEquivLatLon compares LookupLatLon against the reference over a dense
// global grid plus random points.
func TestNEEquivLatLon(t *testing.T) {
	svc := testService(t)

	var pts [][2]float64
	step := 2.0
	if testing.Short() {
		step = 20.0
	}
	for lat := -89.0; lat <= 89.0; lat += step {
		for lon := -179.0; lon <= 179.0; lon += step {
			pts = append(pts, [2]float64{lat, lon})
		}
	}
	rnd := rand.New(rand.NewSource(99))
	n := 5000
	if testing.Short() {
		n = 200
	}
	for i := 0; i < n; i++ {
		pts = append(pts, [2]float64{rnd.Float64()*180 - 90, rnd.Float64()*360 - 180})
	}
	t.Logf("comparing %d points against the reference implementation", len(pts))

	start := time.Now()
	var mismatches atomic.Int64
	var wg sync.WaitGroup
	work := make(chan [2]float64, 256)
	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range work {
				want, _ := refLookupLatLon(svc, p[0], p[1])
				got, _ := svc.LookupLatLon(p[0], p[1])
				if !sameResult(want, got) {
					if mismatches.Add(1) <= 20 {
						t.Errorf("(%g,%g): fast=%+v ref=%+v", p[0], p[1], got, want)
					}
				}
			}
		}()
	}
	for _, p := range pts {
		work <- p
	}
	close(work)
	wg.Wait()
	t.Logf("compared %d points in %v, %d mismatches", len(pts), time.Since(start), mismatches.Load())
}

// TestNEEquivRandomLocators compares longer (6/8-char) locators against the reference.
func TestNEEquivRandomLocators(t *testing.T) {
	svc := testService(t)
	n := 6000
	if testing.Short() {
		n = 100
	}
	locs := sampleLocators(n)

	start := time.Now()
	var mismatches atomic.Int64
	var wg sync.WaitGroup
	work := make(chan string, 256)
	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for loc := range work {
				want, _ := refLookupMaidenhead(svc, loc)
				got, _ := svc.LookupMaidenhead(loc)
				if !sameResult(want, got) {
					if mismatches.Add(1) <= 20 {
						t.Errorf("%s: fast=%+v ref=%+v", loc, got, want)
					}
				}
			}
		}()
	}
	for _, l := range locs {
		work <- l
	}
	close(work)
	wg.Wait()
	t.Logf("compared %d locators in %v, %d mismatches", len(locs), time.Since(start), mismatches.Load())
}
