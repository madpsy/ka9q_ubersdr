package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeLegacyJSONL reproduces the file layout the pre-migration StatsLogger
// wrote: <statsDir>/<source>/YYYY/MM/DD/<name>, one JSON document per line.
func writeLegacyJSONL(t *testing.T, statsDir, source, name string, ts time.Time, v interface{}) {
	t.Helper()
	dir := filepath.Join(statsDir, source,
		fmt.Sprintf("%04d", ts.Year()),
		fmt.Sprintf("%02d", int(ts.Month())),
		fmt.Sprintf("%02d", ts.Day()))
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), append(b, '\n'), 0644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

// TestStatsBackfillFromJSONL runs the importer over a legacy JSONL tree and
// verifies the DB read path returns the same data — the migration scenario for
// an instance upgrading from the file-based stats logger.
func TestStatsBackfillFromJSONL(t *testing.T) {
	statsDir := t.TempDir()
	// Relative to now, not a fixed date: the importers skip day directories
	// older than importStatsDays, so a hardcoded timestamp would silently stop
	// being imported once it aged past the cutoff.
	ts := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Hour)

	// Phase 1 — lay down the legacy tree.
	writeLegacyJSONL(t, statsDir, "wspr", "rolling_24h.jsonl", ts, &WSPRRankResponse{
		GeneratedAt: ts,
		Rolling24h: WSPRRankWindow{
			FetchedAt: ts, FetchedMs: 300, Rows: 1,
			Data: []WSPRRankRow{{
				RxSign: "G0ABC", RxLoc: "IO91", Raw: 10, Dupe: 1, Unique: 9,
				Bands: []int16{14}, Uniques: []uint64{9}, Gross: []uint64{10}, Dupes: []uint64{1},
			}},
		},
		// A window whose fetch failed: zero rows, but an error the API must keep.
		Yesterday: WSPRRankWindow{FetchedAt: ts, Error: "boom"},
	})
	writeLegacyJSONL(t, statsDir, "psk", "report_result.jsonl", ts, &PSKRankData{
		FetchedAt:    ts,
		FetchedMs:    99,
		ReportResult: PSKMonitorsByBand{"20m": {{Callsign: "G0ABC", Day: 5, Week: 30}}},
		SoftwareInUse: map[string][]PSKSoftwareEntry{
			"G0ABC": {{Name: "UberSDR", Version: "0.1.58"}},
		},
	})
	writeLegacyJSONL(t, statsDir, "rbn", "skew.jsonl", ts, rbnSkewRecord{
		FetchedAt:     ts,
		SourceComment: "# calc",
		Entries:       []RBNSkewEntry{{Callsign: "G0ABC", Skew: -1.5, Spots: 12, CorrectionFactor: 0.99}},
	})
	writeLegacyJSONL(t, statsDir, "rbn", "statistics.jsonl", ts, rbnStatsRecord{
		FetchedAt:     ts,
		SourceComment: "# calc",
		Entries:       []RBNStatisticsEntry{{Callsign: "G0ABC", EpochDate: 20657, SpotCount: 12}},
	})

	// Phase 2 — fresh DB, run the backfill over the tree just written.
	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	defer mgr.Close()

	imp := &DBImporter{db: mgr.DB(), StatsDir: statsDir}
	for name, fn := range map[string]func(context.Context) error{
		"wspr": imp.importWSPRRank,
		"psk":  imp.importPSKRank,
		"rbn":  imp.importRBN,
	} {
		if err := fn(context.Background()); err != nil {
			t.Fatalf("import %s: %v", name, err)
		}
	}

	// Phase 3 — read back through the DB.
	sl := NewStatsLogger()
	sl.SetReadDB(mgr.ReadDB())
	p := paramsFor(ts)

	gotWSPR, err := sl.ReadWSPR(p)
	if err != nil {
		t.Fatalf("ReadWSPR: %v", err)
	}
	if len(gotWSPR) != 1 {
		t.Fatalf("ReadWSPR: got %d snapshots, want 1", len(gotWSPR))
	}
	if r := gotWSPR[0].Rolling24h; len(r.Data) != 1 || r.Data[0].RxSign != "G0ABC" || r.Data[0].Unique != 9 {
		t.Errorf("rolling_24h not backfilled correctly: %+v", r)
	}
	if got := gotWSPR[0].Rolling24h.Data[0].Bands; len(got) != 1 || got[0] != 14 {
		t.Errorf("bands = %v, want [14]", got)
	}
	if gotWSPR[0].Yesterday.Error != "boom" {
		t.Errorf("yesterday.error = %q, want boom — the failed window was dropped", gotWSPR[0].Yesterday.Error)
	}

	gotPSK, err := sl.ReadPSK(p)
	if err != nil {
		t.Fatalf("ReadPSK: %v", err)
	}
	if len(gotPSK) != 1 {
		t.Fatalf("ReadPSK: got %d snapshots, want 1", len(gotPSK))
	}
	if e := gotPSK[0].ReportResult["20m"]; len(e) != 1 || e[0].Callsign != "G0ABC" || e[0].Week != 30 {
		t.Errorf("report_result not backfilled correctly: %+v", e)
	}
	if sw := gotPSK[0].SoftwareInUse["G0ABC"]; len(sw) != 1 || sw[0].Version != "0.1.58" {
		t.Errorf("software_in_use not backfilled correctly: %+v", sw)
	}

	gotRBN, err := sl.ReadRBN(p)
	if err != nil {
		t.Fatalf("ReadRBN: %v", err)
	}
	if len(gotRBN) != 1 {
		t.Fatalf("ReadRBN: got %d records, want 1", len(gotRBN))
	}
	if len(gotRBN[0].SkewEntries) != 1 || len(gotRBN[0].StatsEntries) != 1 {
		t.Errorf("RBN not backfilled correctly: %+v", gotRBN[0])
	}

	// Re-running the import must be idempotent (INSERT OR IGNORE + UNIQUE).
	if err := imp.importWSPRRank(context.Background()); err != nil {
		t.Fatalf("second importWSPRRank: %v", err)
	}
	again, err := sl.ReadWSPR(p)
	if err != nil {
		t.Fatalf("ReadWSPR after re-import: %v", err)
	}
	if len(again) != 1 || len(again[0].Rolling24h.Data) != 1 {
		t.Errorf("re-import duplicated rows: %d snapshots, %d rows", len(again), len(again[0].Rolling24h.Data))
	}
}

// TestStatsBackfillSkipsOldDays verifies the importStatsDays cutoff: day
// directories older than the window are skipped without being opened, matching
// the behaviour the spots importers already had. Without this the backfill
// walks every snapshot since the instance was installed — the stats tree was
// never pruned on disk — only for the retention loop to delete the old rows.
func TestStatsBackfillSkipsOldDays(t *testing.T) {
	statsDir := t.TempDir()
	now := time.Now().UTC()

	recent := now.Add(-24 * time.Hour).Truncate(time.Hour)
	old := now.AddDate(0, 0, -(importStatsDays + 5)).Truncate(time.Hour)

	// Two snapshots per source: one inside the window, one well outside it.
	for _, ts := range []time.Time{recent, old} {
		writeLegacyJSONL(t, statsDir, "wspr", "rolling_24h.jsonl", ts, &WSPRRankResponse{
			GeneratedAt: ts,
			Rolling24h: WSPRRankWindow{
				FetchedAt: ts, Rows: 1,
				Data: []WSPRRankRow{{RxSign: "G0ABC", RxLoc: "IO91", Unique: 9}},
			},
		})
		writeLegacyJSONL(t, statsDir, "psk", "report_result.jsonl", ts, &PSKRankData{
			FetchedAt:    ts,
			ReportResult: PSKMonitorsByBand{"20m": {{Callsign: "G0ABC", Day: 5, Week: 30}}},
		})
		writeLegacyJSONL(t, statsDir, "rbn", "skew.jsonl", ts, rbnSkewRecord{
			FetchedAt: ts,
			Entries:   []RBNSkewEntry{{Callsign: "G0ABC", Skew: -1.5}},
		})
	}

	mgr, err := NewDBManager(t.TempDir())
	if err != nil {
		t.Fatalf("NewDBManager: %v", err)
	}
	defer mgr.Close()

	imp := &DBImporter{db: mgr.DB(), StatsDir: statsDir}
	for name, fn := range map[string]func(context.Context) error{
		"wspr": imp.importWSPRRank,
		"psk":  imp.importPSKRank,
		"rbn":  imp.importRBN,
	} {
		if err := fn(context.Background()); err != nil {
			t.Fatalf("import %s: %v", name, err)
		}
	}

	// Each table must hold exactly the recent snapshot and nothing older.
	for _, c := range []struct{ table, tsCol string }{
		{"wspr_rank_rows", "ts"},
		{"psk_rank_entries", "ts"},
		{"rbn_skew", "ts"},
	} {
		var n int
		if err := mgr.DB().QueryRow(
			`SELECT COUNT(*) FROM `+c.table+` WHERE `+c.tsCol+` = ?`, old.Unix()).Scan(&n); err != nil {
			t.Fatalf("count old %s: %v", c.table, err)
		}
		if n != 0 {
			t.Errorf("%s: imported %d row(s) from %s, which is older than the %d-day cutoff",
				c.table, n, old.Format("2006-01-02"), importStatsDays)
		}

		if err := mgr.DB().QueryRow(
			`SELECT COUNT(*) FROM `+c.table+` WHERE `+c.tsCol+` = ?`, recent.Unix()).Scan(&n); err != nil {
			t.Fatalf("count recent %s: %v", c.table, err)
		}
		if n == 0 {
			t.Errorf("%s: the in-window snapshot from %s was not imported",
				c.table, recent.Format("2006-01-02"))
		}
	}
}

// dayDirBefore must only skip real YYYY/MM/DD directories. Anything it does not
// recognise has to be walked, or an unexpected layout would silently drop data.
func TestDayDirBefore(t *testing.T) {
	root := filepath.Join("stats", "wspr")
	cutoff := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		path string
		want bool
		why  string
	}{
		{filepath.Join(root, "2026", "06", "30"), true, "day before cutoff"},
		{filepath.Join(root, "2026", "07", "01"), false, "day on cutoff is kept"},
		{filepath.Join(root, "2026", "07", "22"), false, "day after cutoff"},
		{filepath.Join(root, "2026"), false, "year dir — not deep enough to judge"},
		{filepath.Join(root, "2026", "06"), false, "month dir — not deep enough to judge"},
		{filepath.Join(root, "2026", "06", "30", "extra"), false, "deeper than a day dir"},
		{filepath.Join(root, "not", "a", "date"), false, "unparseable components"},
	}
	for _, c := range cases {
		if got := dayDirBefore(root, c.path, cutoff); got != c.want {
			t.Errorf("dayDirBefore(%q) = %v, want %v — %s", c.path, got, c.want, c.why)
		}
	}
}

// The stats backfills must run before cw_spots and spots, which are last by
// design (they are the largest tables and would delay everything behind them).
func TestStatsImportsOrderedBeforeSpots(t *testing.T) {
	order := dbImportOrder(&DBImporter{})

	pos := make(map[string]int, len(order))
	for i, t := range order {
		pos[t.table] = i
	}

	for _, stats := range []string{"rbn_skew", "psk_rank_snapshots", "wspr_rank_windows"} {
		i, ok := pos[stats]
		if !ok {
			t.Fatalf("%s is not registered for import", stats)
		}
		for _, spots := range []string{"cw_spots", "spots"} {
			if j := pos[spots]; i > j {
				t.Errorf("%s (position %d) runs after %s (position %d)", stats, i, spots, j)
			}
		}
	}
}
