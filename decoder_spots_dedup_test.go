package main

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"
	"time"
)

// refDedup is the deduplication the Go path performs, written out
// independently: one row per callsign, locator, band, mode and UTC day, the
// newest decode's fields, SeenCount the number of raw decodes, newest first.
func refDedup(raw []SpotRecord) []SpotRecord {
	type acc struct {
		spot  SpotRecord
		count int
	}
	groups := map[string]*acc{}
	for _, s := range raw {
		key := fmt.Sprintf("%s|%s|%s|%s|%s", s.Callsign, s.Locator, s.Band, s.Mode, s.Timestamp[:10])
		a := groups[key]
		if a == nil {
			a = &acc{spot: s}
			groups[key] = a
		} else if s.Timestamp > a.spot.Timestamp {
			a.spot = s
		}
		a.count++
	}
	out := make([]SpotRecord, 0, len(groups))
	for _, a := range groups {
		a.spot.SeenCount = a.count
		out = append(out, a.spot)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp > out[j].Timestamp })
	return out
}

func spotKey(s SpotRecord) string {
	f := func(p *float64) string {
		if p == nil {
			return "nil"
		}
		return fmt.Sprintf("%.3f", *p)
	}
	return fmt.Sprintf("%s %s %s %d %d %s %s %s %d %d %s %s %s %s %s %d",
		s.Timestamp, s.Callsign, s.Locator, s.SNR, s.Frequency, s.Band, s.Message, s.Country,
		s.CQZone, s.ITUZone, s.Continent, f(s.DistanceKm), f(s.BearingDeg), s.Mode, s.Name, s.SeenCount)
}

func TestSpotsDedupSQLMatchesGo(t *testing.T) {
	sl := newTestSpotsLogger(t)
	rng := rand.New(rand.NewSource(7))
	base := time.Date(2026, 3, 1, 22, 0, 0, 0, time.UTC) // spans three UTC days
	calls := []string{"K1ABC", "DL1XYZ", "JA1AAA", "VK2BBB", "G4CCC", "W9DDD"}
	locs := []string{"FN42", "JO31", "PM95", "QF56", ""}
	freqs := []uint64{7_074_000, 14_074_000, 21_074_000}
	modes := []string{"FT8", "FT4"}
	for i := 0; i < 3000; i++ {
		d := &DecodeInfo{
			Callsign: calls[rng.Intn(len(calls))], Locator: locs[rng.Intn(len(locs))],
			SNR: -25 + rng.Intn(35), Frequency: freqs[rng.Intn(len(freqs))] + uint64(rng.Intn(3000)),
			Mode: modes[rng.Intn(2)], BandName: fmt.Sprintf("b%d", rng.Intn(3)), Message: fmt.Sprintf("m%d", i),
			Country: "C", Continent: "EU", CQZone: rng.Intn(40), ITUZone: rng.Intn(90),
			Timestamp: base.Add(time.Duration(i) * 61 * time.Second), // unique times: no ties
		}
		if rng.Intn(3) > 0 {
			v, b := rng.Float64()*10000, rng.Float64()*360
			d.DistanceKm, d.BearingDeg = &v, &b
		}
		if err := sl.LogSpot(d); err != nil {
			t.Fatal(err)
		}
	}
	from, to := base.Format("2006-01-02"), base.AddDate(0, 0, 2).Format("2006-01-02")

	for _, c := range []struct {
		name                 string
		mode, band, callsign string
		locatorsOnly         bool
		minSNR, limit        int
	}{
		{name: "everything", minSNR: -999},
		{name: "locators only", locatorsOnly: true, minSNR: -999},
		{name: "mode and band", mode: "FT8", band: "20m", minSNR: -999},
		{name: "callsign, snr", callsign: "K1ABC", minSNR: -5},
		{name: "limited", minSNR: -999, limit: 25},
	} {
		raw, err := sl.GetHistoricalSpotsRange(c.mode, c.band, "", c.callsign, "", "", "", "", from, to, "", "",
			false, c.locatorsOnly, 0, c.minSNR, 0, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		want := refDedup(raw)
		if c.limit > 0 && len(want) > c.limit {
			want = want[:c.limit]
		}
		got, err := sl.GetHistoricalSpotsRange(c.mode, c.band, "", c.callsign, "", "", "", "", from, to, "", "",
			true, c.locatorsOnly, 0, c.minSNR, 0, 0, c.limit)
		if err != nil {
			t.Fatal(err)
		}
		if len(raw) == 0 || len(want) == len(raw) {
			t.Fatalf("%s: fixture has %d raw rows and %d groups; it must have duplicates to test anything", c.name, len(raw), len(want))
		}
		if len(got) != len(want) {
			t.Fatalf("%s: %d spots, want %d", c.name, len(got), len(want))
		}
		for i := range want {
			if spotKey(got[i]) != spotKey(want[i]) {
				t.Fatalf("%s: spot %d\n got %s\nwant %s", c.name, i, spotKey(got[i]), spotKey(want[i]))
			}
		}
	}
}

// The count agrees with the deduplicated spots themselves, including over a
// window that crosses UTC midnight, which the old time-of-day filter missed.
func TestCountSpotsByMode(t *testing.T) {
	sl := newTestSpotsLogger(t)
	midnight := time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)
	rng := rand.New(rand.NewSource(3))
	for i := 0; i < 600; i++ {
		d := &DecodeInfo{
			Callsign: fmt.Sprintf("K%dX", rng.Intn(40)), Locator: []string{"FN42", "JO31", ""}[rng.Intn(3)],
			SNR: -10, Frequency: []uint64{7_074_000, 14_074_000}[rng.Intn(2)], Mode: []string{"FT8", "FT4", "WSPR"}[rng.Intn(3)],
			BandName: "b", Timestamp: midnight.Add(time.Duration(rng.Intn(7200)-3600) * time.Second),
		}
		if err := sl.LogSpot(d); err != nil {
			t.Fatal(err)
		}
	}
	from, to := midnight.Add(-30*time.Minute), midnight.Add(30*time.Minute)
	counts, total, err := sl.CountSpotsByMode(from.Unix(), to.Unix())
	if err != nil {
		t.Fatal(err)
	}
	spots, err := sl.GetHistoricalSpotsRange("", "", "", "", "", "", "", "", from.Format("2006-01-02"), to.Format("2006-01-02"),
		"", "", true, true, 0, -999, from.Unix(), to.Unix(), 0)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{}
	for _, s := range spots {
		want[s.Mode]++
	}
	if total != len(spots) || fmt.Sprint(counts) != fmt.Sprint(want) || total == 0 {
		t.Errorf("counts %v (total %d), want %v (total %d)", counts, total, want, len(spots))
	}
}

// CW deduplication in SQL (one row per callsign, band and UTC day, the newest
// spot, seen_count) gives what an independent grouping of the raw rows gives.
func TestCWSpotsDedupSQLMatchesGo(t *testing.T) {
	sl := newTestCWSpotsLogger(t)
	rng := rand.New(rand.NewSource(11))
	base := time.Date(2026, 3, 1, 22, 0, 0, 0, time.UTC)
	calls := []string{"G3AAA", "JA1BBB", "W1CCC", "VK2DDD"}
	bands := []string{"20m", "40m", "15m"}
	for i := 0; i < 1500; i++ {
		sl.insertForTest(t, &CWSkimmerSpot{DXCall: calls[rng.Intn(len(calls))], Spotter: "S", SNR: rng.Intn(40),
			Frequency: float64(14_000_000 + rng.Intn(70_000)), Band: bands[rng.Intn(3)], WPM: 20 + rng.Intn(10), Mode: "CW",
			Time: base.Add(time.Duration(i) * 97 * time.Second), Latitude: rng.Float64() * 60, Longitude: rng.Float64() * 100})
	}
	from, to := base.Format("2006-01-02"), base.AddDate(0, 0, 2).Format("2006-01-02")
	for _, limit := range []int{0, 17} {
		raw, err := sl.GetCWHistoricalSpotsRange("", "", nil, "", "", "", from, to, "", "", false, 0, -999, nil, 0, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		type acc struct {
			s CWSpotRecord
			n int
		}
		groups := map[string]*acc{}
		for _, s := range raw {
			k := s.Callsign + "|" + s.Band + "|" + s.Timestamp[:10]
			if a := groups[k]; a == nil {
				groups[k] = &acc{s, 1}
			} else {
				a.n++
				if s.Timestamp > a.s.Timestamp {
					a.s = s
				}
			}
		}
		var want []CWSpotRecord
		for _, a := range groups {
			a.s.SeenCount = a.n
			want = append(want, a.s)
		}
		sort.Slice(want, func(i, j int) bool { return want[i].Timestamp > want[j].Timestamp })
		if limit > 0 {
			want = want[:limit]
		}
		got, err := sl.GetCWHistoricalSpotsRange("", "", nil, "", "", "", from, to, "", "", true, 0, -999, nil, 0, 0, limit)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(want) || len(want) == len(raw) {
			t.Fatalf("limit %d: %d spots, want %d (from %d raw)", limit, len(got), len(want), len(raw))
		}
		for i := range want {
			g, w := got[i], want[i]
			if g.Timestamp != w.Timestamp || g.Callsign != w.Callsign || g.Band != w.Band || g.SNR != w.SNR ||
				g.Frequency != w.Frequency || g.WPM != w.WPM || g.SeenCount != w.SeenCount || *g.Latitude != *w.Latitude {
				t.Fatalf("limit %d, spot %d:\n got %+v\nwant %+v", limit, i, g, w)
			}
		}
	}
}
