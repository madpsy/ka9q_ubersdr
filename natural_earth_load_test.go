package main

import (
	"runtime"
	"testing"
	"time"
)

// TestNELoadCost reports the load time and resident cost of the prepared
// geometry and spatial indexes.
func TestNELoadCost(t *testing.T) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	start := time.Now()
	if err := InitNaturalEarthService(testGeoJSONPath); err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)

	runtime.GC()
	runtime.ReadMemStats(&after)

	svc := globalNaturalEarth
	var polys, rings, slabEntries, cellEntries int
	for _, c := range svc.countries {
		polys += len(c.prepared.polys)
		for _, pp := range c.prepared.polys {
			rings += len(pp.rings)
			for _, pr := range pp.rings {
				slabEntries += len(pr.slabEdges)
			}
		}
	}
	for _, cell := range svc.cellIndex {
		cellEntries += len(cell)
	}

	t.Logf("load time: %v", elapsed)
	t.Logf("heap after load: %.1f MB (delta %.1f MB)",
		float64(after.HeapAlloc)/1e6, float64(after.HeapAlloc-before.HeapAlloc)/1e6)
	t.Logf("polygons=%d rings=%d slab entries=%d (%.1f MB) cell entries=%d (%.1f MB)",
		polys, rings, slabEntries, float64(slabEntries*4)/1e6, cellEntries, float64(cellEntries*4)/1e6)
}
