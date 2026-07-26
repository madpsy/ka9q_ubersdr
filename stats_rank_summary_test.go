package main

import (
	"testing"
	"time"
)

func testPSKFetcher(data *PSKRankData) *PSKRankFetcher {
	return &PSKRankFetcher{cached: data}
}

func testWSPRFetcher(data *WSPRRankResponse) *WSPRRankFetcher {
	return &WSPRRankFetcher{cached: data}
}

func testRBNStore(counts map[string]int) *RBNDataStore {
	store := NewRBNDataStore()
	entries := make(map[string]RBNStatisticsEntry, len(counts))
	for cs, n := range counts {
		entries[cs] = RBNStatisticsEntry{Callsign: cs, SpotCount: n}
	}
	at := time.Now().UTC()
	store.setStats(entries, "# test", &at)
	return store
}

func TestRankSummaryReadsEveryLeaderboard(t *testing.T) {
	psk := testPSKFetcher(&PSKRankData{
		FetchedAt: time.Now().UTC(),
		ReportResult: PSKMonitorsByBand{"All": {
			{Callsign: "AA1AA", Day: 5000},
			{Callsign: "m0abc", Day: 4000}, // lower case: matching is case-insensitive
			{Callsign: "CC3CC", Day: 3000},
		}},
		CountryResult: PSKMonitorsByBand{"All": {
			{Callsign: "AA1AA", Day: 120},
			{Callsign: "BB2BB", Day: 110},
			{Callsign: "CC3CC", Day: 100},
			{Callsign: "M0ABC", Day: 90},
		}},
	})

	wspr := testWSPRFetcher(&WSPRRankResponse{
		GeneratedAt: time.Now().UTC(),
		Rolling24h:  WSPRRankWindow{Data: []WSPRRankRow{{RxSign: "M0ABC", Unique: 900}, {RxSign: "AA1AA", Unique: 800}}},
		Yesterday:   WSPRRankWindow{Data: []WSPRRankRow{{RxSign: "AA1AA", Unique: 700}, {RxSign: "M0ABC", Unique: 650}}},
		Today:       WSPRRankWindow{Data: []WSPRRankRow{{RxSign: "AA1AA", Unique: 10}}}, // we are absent
	})

	rbn := testRBNStore(map[string]int{"AA1AA": 900000, "M0ABC-1": 500000, "CC3CC": 100000})

	got := BuildRankSummary(psk, wspr, rbn, "M0ABC", "M0ABC-1")

	if !got.PSK.Available || !got.WSPR.Available || !got.RBN.Available {
		t.Fatalf("expected all three sections available, got psk=%v wspr=%v rbn=%v",
			got.PSK.Available, got.WSPR.Available, got.RBN.Available)
	}

	checks := []struct {
		name string
		pos  RankPosition
		want RankPosition
	}{
		{"psk reports", got.PSK.Reports, RankPosition{Rank: 2, Value: 4000, Total: 3}},
		{"psk countries", got.PSK.Countries, RankPosition{Rank: 4, Value: 90, Total: 4}},
		{"wspr rolling_24h", got.WSPR.Rolling24h, RankPosition{Rank: 1, Value: 900, Total: 2}},
		{"wspr yesterday", got.WSPR.Yesterday, RankPosition{Rank: 2, Value: 650, Total: 2}},
		// Absent from the leaderboard: rank 0, but the total still says how big it is.
		{"wspr today", got.WSPR.Today, RankPosition{Rank: 0, Value: 0, Total: 1}},
		{"rbn spots", got.RBN.Spots, RankPosition{Rank: 2, Value: 500000, Total: 3}},
	}
	for _, c := range checks {
		if c.pos != c.want {
			t.Errorf("%s = %+v, want %+v", c.name, c.pos, c.want)
		}
	}

	if got.ReceiverCallsign != "M0ABC" || got.CWSkimmerCallsign != "M0ABC-1" {
		t.Errorf("callsigns = %q/%q, want M0ABC/M0ABC-1", got.ReceiverCallsign, got.CWSkimmerCallsign)
	}
}

func TestRankSummaryHandlesMissingComponents(t *testing.T) {
	// Every fetcher disabled.
	got := BuildRankSummary(nil, nil, nil, "M0ABC", "M0ABC-1")
	if got.PSK.Available || got.WSPR.Available || got.RBN.Available {
		t.Fatalf("expected nothing available with nil fetchers, got %+v", got)
	}
	if got.GeneratedAt.IsZero() {
		t.Error("generated_at was not set")
	}

	// Fetchers present but nothing fetched yet.
	got = BuildRankSummary(testPSKFetcher(nil), testWSPRFetcher(nil), NewRBNDataStore(), "M0ABC", "M0ABC-1")
	if got.PSK.Available || got.WSPR.Available || got.RBN.Available {
		t.Fatalf("expected nothing available before the first fetch, got %+v", got)
	}

	// No callsign configured: nothing to look up, even with data present.
	got = BuildRankSummary(
		testPSKFetcher(&PSKRankData{ReportResult: PSKMonitorsByBand{"All": {{Callsign: "AA1AA", Day: 1}}}}),
		testWSPRFetcher(&WSPRRankResponse{}),
		testRBNStore(map[string]int{"AA1AA": 10}),
		"", "")
	if got.PSK.Available || got.WSPR.Available || got.RBN.Available {
		t.Fatalf("expected nothing available without callsigns, got %+v", got)
	}

	// A failed PSK fetch is reported, not silently shown as a rank of 0.
	got = BuildRankSummary(testPSKFetcher(&PSKRankData{Error: "scrape failed"}), nil, nil, "M0ABC", "")
	if got.PSK.Available {
		t.Error("a cached PSK error should not report as available")
	}
	if got.PSK.Error != "scrape failed" {
		t.Errorf("PSK error = %q, want %q", got.PSK.Error, "scrape failed")
	}
}

func TestRBNRankForIsPrecomputedAndOrdered(t *testing.T) {
	rbn := testRBNStore(map[string]int{
		"AA1AA": 500,
		"BB2BB": 500, // tie — broken by callsign so the order is stable
		"CC3CC": 900,
		"DD4DD": 100,
	})

	for _, tc := range []struct {
		callsign string
		wantRank int
		wantSpot int
	}{
		{"CC3CC", 1, 900},
		{"AA1AA", 2, 500},
		{"BB2BB", 3, 500},
		{"DD4DD", 4, 100},
		{"aa1aa", 2, 500}, // case-insensitive
		{"ZZ9ZZ", 0, 0},   // not a skimmer
		{"", 0, 0},
	} {
		rank, spots, total := rbn.RankFor(tc.callsign)
		if rank != tc.wantRank || spots != tc.wantSpot {
			t.Errorf("RankFor(%q) = rank %d, spots %d; want rank %d, spots %d",
				tc.callsign, rank, spots, tc.wantRank, tc.wantSpot)
		}
		if tc.callsign != "" && total != 4 {
			t.Errorf("RankFor(%q) total = %d, want 4", tc.callsign, total)
		}
	}

	// A refetch must rebuild the ranking, not leave the old one in place.
	at := time.Now().UTC()
	rbn.setStats(map[string]RBNStatisticsEntry{
		"AA1AA": {Callsign: "AA1AA", SpotCount: 10},
		"DD4DD": {Callsign: "DD4DD", SpotCount: 99},
	}, "# refetched", &at)
	if rank, spots, total := rbn.RankFor("DD4DD"); rank != 1 || spots != 99 || total != 2 {
		t.Errorf("after refetch DD4DD = rank %d, spots %d, total %d; want 1/99/2", rank, spots, total)
	}
	if rank, _, _ := rbn.RankFor("CC3CC"); rank != 0 {
		t.Errorf("a callsign dropped by the refetch still ranks %d, want 0", rank)
	}
}
