package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newTestRollingRecorder builds a recorder backed by a temp data dir with a
// full day of data on disk for yesterday and `todayRows` rows in the ring
// buffer for today. Row values are unique per minute so placement can be
// verified: yesterday row m = -m, today row m = 1000+m.
func newTestRollingRecorder(t *testing.T, now time.Time, todayRows int) *SpectrogramRecorder {
	t.Helper()

	const binCount = 4
	dir := t.TempDir()
	sr := newSpectrogramRecorderForBand(nil, SpectrogramConfig{DataDir: dir},
		"wideband", 0, 30_000_000, binCount, func() *BandFFT { return nil })

	for i := range sr.rows {
		row := make([]float32, binCount)
		for j := range row {
			row[j] = noDataSentinel
		}
		sr.rows[i] = row
	}

	yesterday := now.AddDate(0, 0, -1)
	yesterdayMidnight := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 0, 0, 0, 0, time.UTC)
	todayMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	// Yesterday: a complete day on disk, row index == minute-of-day.
	writeTestDay(t, dir, yesterday.Format("2006-01-02"), yesterdayMidnight, spectrogramMaxRows, binCount,
		func(m int) float32 { return float32(-m) })

	// Today: ring buffer plus the matching JSONL.
	for m := 0; m < todayRows; m++ {
		for j := range sr.rows[m] {
			sr.rows[m][j] = float32(1000 + m)
		}
		sr.appendRowToJSONL(now.Format("2006-01-02"), m, todayMidnight.Add(time.Duration(m)*time.Minute), -100)
	}
	sr.rowCount = todayRows
	sr.lastRow = todayMidnight.Add(time.Duration(todayRows) * time.Minute)

	return sr
}

// writeTestDay writes a .bin + .jsonl pair for one complete UTC day.
func writeTestDay(t *testing.T, dir, date string, midnight time.Time, rowCount, binCount int, value func(m int) float32) {
	t.Helper()

	buf := make([]byte, 24+rowCount*binCount*4)
	copy(buf[0:4], spectrogramMagic)
	binary.LittleEndian.PutUint32(buf[4:8], spectrogramVersion)
	binary.LittleEndian.PutUint32(buf[8:12], uint32(rowCount))
	binary.LittleEndian.PutUint64(buf[12:20], uint64(midnight.Add(time.Duration(rowCount)*time.Minute).Unix()))
	binary.LittleEndian.PutUint32(buf[20:24], uint32(binCount))
	offset := 24
	for m := 0; m < rowCount; m++ {
		for j := 0; j < binCount; j++ {
			binary.LittleEndian.PutUint32(buf[offset:offset+4], math.Float32bits(value(m)))
			offset += 4
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "spectrogram_"+date+".bin"), buf, 0644); err != nil {
		t.Fatalf("write .bin: %v", err)
	}

	f, err := os.Create(filepath.Join(dir, "spectrogram_"+date+".jsonl"))
	if err != nil {
		t.Fatalf("create .jsonl: %v", err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for m := 0; m < rowCount; m++ {
		entry := map[string]interface{}{
			"row":         m,
			"utc_time":    midnight.Add(time.Duration(m) * time.Minute).Format("15:04"),
			"unix":        midnight.Add(time.Duration(m) * time.Minute).Unix(),
			"noise_floor": -100,
		}
		if err := enc.Encode(entry); err != nil {
			t.Fatalf("write .jsonl: %v", err)
		}
	}
}

// TestRollingWindowPlacement checks that the assembled window puts yesterday's
// tail first and today's head second, with the correct per-row metadata.
func TestRollingWindowPlacement(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}
	tailLen := spectrogramMaxRows - cutoff

	sr := newTestRollingRecorder(t, now, cutoff)
	rr := sr.getRolling24hRows()

	if len(rr.rows) != spectrogramMaxRows {
		t.Fatalf("row count = %d, want %d", len(rr.rows), spectrogramMaxRows)
	}

	// First row of the window is yesterday's minute `cutoff`.
	if got, want := rr.rows[0][0], float32(-cutoff); got != want {
		t.Errorf("rows[0] = %v, want %v (yesterday minute %d)", got, want, cutoff)
	}
	// Last row of yesterday's tail is minute 1439.
	if got, want := rr.rows[tailLen-1][0], float32(-(spectrogramMaxRows - 1)); got != want {
		t.Errorf("rows[%d] = %v, want %v", tailLen-1, got, want)
	}
	// First row of today's head is minute 0.
	if got, want := rr.rows[tailLen][0], float32(1000); got != want {
		t.Errorf("rows[%d] = %v, want %v (today minute 0)", tailLen, got, want)
	}
	// Last row is the most recent minute.
	if got, want := rr.rows[spectrogramMaxRows-1][0], float32(1000+cutoff-1); got != want {
		t.Errorf("last row = %v, want %v", got, want)
	}

	// Metadata timestamps must be one minute apart across the whole window.
	for i := 1; i < len(rr.metaRows); i++ {
		if d := rr.metaRows[i].Unix - rr.metaRows[i-1].Unix; d != 60 {
			t.Fatalf("metaRows[%d].Unix - metaRows[%d].Unix = %d, want 60", i, i-1, d)
		}
	}
	// PeakDB is derived from the row data (all bins equal, so P95 == the value).
	if got, want := rr.metaRows[0].PeakDB, float32(-cutoff); got != want {
		t.Errorf("metaRows[0].PeakDB = %v, want %v", got, want)
	}
	if got, want := rr.metaRows[tailLen].PeakDB, float32(1000); got != want {
		t.Errorf("metaRows[%d].PeakDB = %v, want %v", tailLen, got, want)
	}
}

// TestRollingWindowServedFromMemory checks that repeat requests reuse the
// assembled snapshot and that appending a row invalidates it.
func TestRollingWindowServedFromMemory(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	sr := newTestRollingRecorder(t, now, cutoff)

	first := sr.getRolling24hRows()
	if second := sr.getRolling24hRows(); second != first {
		t.Error("second request reassembled the window instead of serving the cached snapshot")
	}

	// Removing yesterday's files must not change what is served — the decoded
	// rows are held in memory for the rest of the UTC day.
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")
	os.Remove(filepath.Join(sr.config.DataDir, "spectrogram_"+yesterday+".bin"))
	os.Remove(filepath.Join(sr.config.DataDir, "spectrogram_"+yesterday+".jsonl"))

	// A new row makes the snapshot stale.
	sr.mu.Lock()
	sr.rowCount++
	sr.mu.Unlock()

	third := sr.getRolling24hRows()
	if third == first {
		t.Fatal("appending a row did not invalidate the cached snapshot")
	}
	if got, want := third.rows[0][0], float32(-cutoff); got != want {
		t.Errorf("rows[0] after rebuild = %v, want %v (yesterday should still be in memory)", got, want)
	}
}

// TestRollingPNGCached checks that the rendered rolling image is reused for
// repeat requests of the same view and dropped when the snapshot changes.
func TestRollingPNGCached(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	sr := newTestRollingRecorder(t, now, cutoff)
	rr := sr.getRolling24hRows()

	a := sr.rollingPNG(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0)
	if len(a) == 0 {
		t.Fatal("rollingPNG returned no data")
	}
	b := sr.rollingPNG(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0)
	if &a[0] != &b[0] {
		t.Error("identical view was re-rendered instead of served from the render cache")
	}
	// A different palette is a different view.
	c := sr.rollingPNG(rr, "plasma", 0, 0, false, 0, 0)
	if len(c) > 0 && &a[0] == &c[0] {
		t.Error("different palette returned the cached render")
	}
	if len(sr.rolling.pngs) != 2 {
		t.Errorf("render cache holds %d entries, want 2", len(sr.rolling.pngs))
	}
}

// TestRollingSnapshotSurvivesRollover checks that a snapshot handed to a
// request is not corrupted when the recorder rolls over to a new UTC day.
func TestRollingSnapshotSurvivesRollover(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	sr := newTestRollingRecorder(t, now, cutoff)
	rr := sr.getRolling24hRows()
	before := rr.rows[len(rr.rows)-1][0]

	sr.rollover(now.AddDate(0, 0, 1))

	if got := rr.rows[len(rr.rows)-1][0]; got != before {
		t.Errorf("snapshot row changed under the caller after rollover: %v → %v", before, got)
	}
	sr.mu.Lock()
	live := sr.rows[0][0]
	rowCount := sr.rowCount
	sr.mu.Unlock()
	if rowCount != 0 {
		t.Errorf("rowCount after rollover = %d, want 0", rowCount)
	}
	if !math.IsInf(float64(live), -1) {
		t.Errorf("ring buffer row 0 after rollover = %v, want sentinel", live)
	}
	if sr.rolling.result != nil {
		t.Error("rolling cache was not invalidated at rollover")
	}
}
