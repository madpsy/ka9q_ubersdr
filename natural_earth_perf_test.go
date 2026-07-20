package main

import (
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

const testGeoJSONPath = "natural_earth/ne_10m_admin_0_countries.geojson"

var testSvcOnce sync.Once

func testService(tb testing.TB) *NaturalEarthService {
	tb.Helper()
	testSvcOnce.Do(func() {
		if err := InitNaturalEarthService(testGeoJSONPath); err != nil {
			tb.Fatalf("load: %v", err)
		}
	})
	if globalNaturalEarth == nil {
		tb.Fatal("service not loaded")
	}
	return globalNaturalEarth
}

// clearCache drops the memoised results so we always measure the cold path.
func clearCache(svc *NaturalEarthService) {
	svc.locatorCache = sync.Map{}
	svc.locatorCacheN.Store(0)
}

// allSquares4 enumerates every syntactically valid 4-character locator (32,400).
func allSquares4() []string {
	out := make([]string, 0, 18*18*10*10)
	for a := 'A'; a <= 'R'; a++ {
		for b := 'A'; b <= 'R'; b++ {
			for c := '0'; c <= '9'; c++ {
				for d := '0'; d <= '9'; d++ {
					out = append(out, string([]rune{a, b, c, d}))
				}
			}
		}
	}
	return out
}

// sampleLocators returns a deterministic pseudo-random mix of 4/6/8-char locators.
func sampleLocators(n int) []string {
	r := rand.New(rand.NewSource(0x5EED))
	sq := allSquares4()
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		base := sq[r.Intn(len(sq))]
		switch i % 3 {
		case 0:
			out = append(out, base)
		case 1:
			out = append(out, fmt.Sprintf("%s%c%c", base, 'A'+rune(r.Intn(24)), 'A'+rune(r.Intn(24))))
		case 2:
			out = append(out, fmt.Sprintf("%s%c%c%c%c", base,
				'A'+rune(r.Intn(24)), 'A'+rune(r.Intn(24)),
				'0'+rune(r.Intn(10)), '0'+rune(r.Intn(10))))
		}
	}
	return out
}

// ---------------------------------------------------------------- timing ----

// TestNETiming reports cold-lookup latency over a mixed locator sample.
func TestNETiming(t *testing.T) {
	svc := testService(t)
	n := 300
	if s := os.Getenv("NE_TIMING_N"); s != "" {
		fmt.Sscanf(s, "%d", &n)
	}
	locs := sampleLocators(n)

	clearCache(svc)
	durs := make([]time.Duration, 0, len(locs))
	start := time.Now()
	for _, l := range locs {
		t0 := time.Now()
		if _, err := svc.LookupMaidenhead(l); err != nil {
			t.Fatalf("%s: %v", l, err)
		}
		durs = append(durs, time.Since(t0))
		clearCache(svc) // force cold every time
	}
	total := time.Since(start)

	sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
	p := func(f float64) time.Duration { return durs[int(f*float64(len(durs)-1))] }
	t.Logf("COLD LookupMaidenhead over %d locators: total=%v mean=%v", len(locs), total, total/time.Duration(len(locs)))
	t.Logf("  p50=%v  p90=%v  p99=%v  min=%v  max=%v", p(0.50), p(0.90), p(0.99), durs[0], durs[len(durs)-1])

	// Warm-cache timing for reference.
	clearCache(svc)
	for _, l := range locs {
		svc.LookupMaidenhead(l)
	}
	t1 := time.Now()
	for i := 0; i < 10; i++ {
		for _, l := range locs {
			svc.LookupMaidenhead(l)
		}
	}
	warm := time.Since(t1) / time.Duration(10*len(locs))
	t.Logf("WARM (cached) LookupMaidenhead: mean=%v", warm)
}

// TestNETimingLatLon reports cold latency for the uncached point lookup.
func TestNETimingLatLon(t *testing.T) {
	svc := testService(t)
	r := rand.New(rand.NewSource(0xC0FFEE))
	const n = 300
	pts := make([][2]float64, n)
	for i := range pts {
		pts[i] = [2]float64{r.Float64()*180 - 90, r.Float64()*360 - 180}
	}
	start := time.Now()
	for _, p := range pts {
		if _, err := svc.LookupLatLon(p[0], p[1]); err != nil {
			t.Fatalf("%v: %v", p, err)
		}
	}
	total := time.Since(start)
	t.Logf("LookupLatLon over %d random points: total=%v mean=%v", n, total, total/n)
}

// ---------------------------------------------------------------- golden ----

// resultLine renders a lookup result as a stable one-line record.
func resultLine(loc string, r *MaidenheadCountryResult, err error) string {
	if err != nil {
		return fmt.Sprintf("%s\tERR\t%v", loc, err)
	}
	return fmt.Sprintf("%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s",
		loc, r.Country, r.ISOA2, r.ISOA3, r.ContinentCode, r.Region, r.Subregion, r.Method)
}

// TestNEGolden writes a golden file of lookup results.
// NE_GOLDEN=<path> selects the output file; NE_GOLDEN_N sets the sample size
// (or "all4" to enumerate every 4-character square).
func TestNEGolden(t *testing.T) {
	out := os.Getenv("NE_GOLDEN")
	if out == "" {
		t.Skip("set NE_GOLDEN=<path> to generate")
	}
	svc := testService(t)

	var locs []string
	switch v := os.Getenv("NE_GOLDEN_N"); v {
	case "all4":
		locs = allSquares4()
	case "":
		locs = sampleLocators(1000)
	default:
		var n int
		fmt.Sscanf(v, "%d", &n)
		locs = sampleLocators(n)
	}

	var sb strings.Builder
	start := time.Now()
	for _, l := range locs {
		r, err := svc.LookupMaidenhead(l)
		sb.WriteString(resultLine(l, r, err))
		sb.WriteByte('\n')
	}
	t.Logf("generated %d golden records in %v", len(locs), time.Since(start))

	// Point lookups too, on a fixed grid, to cover LookupLatLon.
	for lat := -85.0; lat <= 85.0; lat += 5 {
		for lon := -175.0; lon <= 175.0; lon += 5 {
			r, err := svc.LookupLatLon(lat, lon)
			sb.WriteString(resultLine(fmt.Sprintf("PT(%.1f,%.1f)", lat, lon), r, err))
			sb.WriteByte('\n')
		}
	}

	if err := os.WriteFile(out, []byte(sb.String()), 0644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s", out)
}

// TestNETimingByMethod breaks cold latency down by which code path answered.
func TestNETimingByMethod(t *testing.T) {
	svc := testService(t)
	locs := sampleLocators(300)
	clearCache(svc)

	type acc struct {
		n     int
		total time.Duration
		max   time.Duration
		worst string
	}
	byMethod := map[string]*acc{}
	for _, l := range locs {
		t0 := time.Now()
		r, err := svc.LookupMaidenhead(l)
		d := time.Since(t0)
		clearCache(svc)
		if err != nil {
			continue
		}
		a := byMethod[r.Method]
		if a == nil {
			a = &acc{}
			byMethod[r.Method] = a
		}
		a.n++
		a.total += d
		if d > a.max {
			a.max, a.worst = d, l+" -> "+r.Country
		}
	}
	for m, a := range byMethod {
		t.Logf("%-16s n=%3d mean=%-14v max=%-14v worst=%s", m, a.n, a.total/time.Duration(a.n), a.max, a.worst)
	}
}
