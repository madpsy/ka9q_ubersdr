package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
func writeTestDay(t testing.TB, dir, date string, midnight time.Time, rowCount, binCount int, value func(m int) float32) {
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

// TestRollingThumbnail checks the memory-only rolling thumbnail: correct size,
// cached per view, and kept in its own cache so it cannot evict the full render.
func TestRollingThumbnail(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	sr := newTestRollingRecorder(t, now, cutoff)
	rr := sr.getRolling24hRows()

	a := sr.rollingThumb(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0)
	if len(a) == 0 {
		t.Fatal("rollingThumb returned no data")
	}
	img, err := png.Decode(bytes.NewReader(a))
	if err != nil {
		t.Fatalf("decode thumbnail: %v", err)
	}
	if got := img.Bounds(); got.Dx() != spectrogramThumbW || got.Dy() != spectrogramThumbH {
		t.Errorf("thumbnail is %dx%d, want %dx%d", got.Dx(), got.Dy(), spectrogramThumbW, spectrogramThumbH)
	}
	// The window is full of data, so the thumbnail must not be all black.
	lit := 0
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			if r, g, b, _ := img.At(x, y).RGBA(); r|g|b != 0 {
				lit++
			}
		}
	}
	if lit == 0 {
		t.Error("thumbnail is entirely black")
	}

	if b := sr.rollingThumb(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0); &a[0] != &b[0] {
		t.Error("identical thumbnail was re-rendered instead of served from the cache")
	}

	// Thumbnails and full renders are cached separately.
	full := sr.rollingPNG(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0)
	if len(full) == 0 {
		t.Fatal("rollingPNG returned no data")
	}
	if len(sr.rolling.thumbs) != 1 || len(sr.rolling.pngs) != 1 {
		t.Errorf("cache holds %d thumbs / %d renders, want 1 / 1", len(sr.rolling.thumbs), len(sr.rolling.pngs))
	}

	// When the window moves on, a recent render is still served immediately
	// (stale by at most rollingMaxStaleMinutes) rather than blocking the caller,
	// and the background refresh brings it up to date.
	sr.mu.Lock()
	sr.rowCount++
	sr.mu.Unlock()
	rr2 := sr.getRolling24hRows()
	if rr2 == rr {
		t.Fatal("snapshot was not rebuilt after a new row")
	}
	if c := sr.rollingThumb(rr2, spectrogramDefaultPalette, 0, 0, false, 0, 0); len(c) == 0 {
		t.Error("no thumbnail served while the render was stale")
	}

	sr.refreshRollingCache()
	sr.rolling.mu.Lock()
	entry := sr.rolling.thumbs[0]
	fresh := entry.builtMinute == sr.rolling.builtMinute && entry.png != nil
	sr.rolling.mu.Unlock()
	if !fresh {
		t.Error("background refresh did not re-render the thumbnail against the new snapshot")
	}
}

// TestRollingRenderDoesNotBlockOnLock is the regression test for the live
// finding that a request could wait seconds behind the per-minute re-render:
// rendering must never happen with the cache lock held.
func TestRollingRenderDoesNotBlockOnLock(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	sr := newTestRollingRecorder(t, now, cutoff)
	rr := sr.getRolling24hRows()
	// Warm both views so the refresh below has real work to do.
	sr.rollingPNG(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0)
	sr.rollingThumb(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0)

	sr.mu.Lock()
	sr.rowCount++
	sr.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		sr.refreshRollingCache()
	}()

	// While the refresh runs, requests must still be answered.
	deadline := time.Now().Add(5 * time.Second)
	for i := 0; i < 50; i++ {
		start := time.Now()
		snap := sr.getRolling24hRows()
		if b := sr.rollingThumb(snap, spectrogramDefaultPalette, 0, 0, false, 0, 0); len(b) == 0 {
			t.Fatal("request served no thumbnail during a background refresh")
		}
		if time.Since(start) > time.Second {
			t.Fatalf("request took %v during a background refresh — it blocked on the render", time.Since(start))
		}
		if time.Now().After(deadline) {
			break
		}
	}
	<-done
}

// TestRollingConcurrentAccess exercises the sharing contract: published
// snapshots alias the ring buffer, so readers must never see a row change while
// the recorder keeps appending. Run with -race.
func TestRollingConcurrentAccess(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	sr := newTestRollingRecorder(t, now, cutoff)
	today := now.Format("2006-01-02")
	todayMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	done := make(chan struct{})
	// Writer: append rows the way tick() does, then refresh the cache.
	go func() {
		defer close(done)
		for i := 0; i < 20; i++ {
			sr.mu.Lock()
			if sr.rowCount < spectrogramMaxRows {
				row := sr.rows[sr.rowCount]
				for j := range row {
					row[j] = float32(2000 + sr.rowCount)
				}
				sr.rowCount++
			}
			idx := sr.rowCount - 1
			sr.mu.Unlock()
			sr.appendRowToJSONL(today, idx, todayMidnight.Add(time.Duration(idx)*time.Minute), -100)
			sr.refreshRollingCache()
		}
	}()

	readers := make(chan struct{}, 4)
	for r := 0; r < 4; r++ {
		go func() {
			defer func() { readers <- struct{}{} }()
			for i := 0; i < 20; i++ {
				rr := sr.getRolling24hRows()
				// Every row must stay readable and self-consistent.
				for _, row := range rr.rows {
					if len(row) != rr.binCount {
						t.Errorf("row width = %d, want %d", len(row), rr.binCount)
						return
					}
					v := row[0]
					for _, x := range row {
						if x != v {
							t.Errorf("row changed under the reader: %v vs %v", v, x)
							return
						}
					}
				}
				sr.rollingAutoRange(rr, 0, 0)
				sr.rollingPNG(rr, spectrogramDefaultPalette, 0, 0, false, 0, 0)
			}
		}()
	}
	for r := 0; r < 4; r++ {
		<-readers
	}
	<-done
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

// TestRollingThumbnailEndpoint checks the ?rolling=1 parameter on
// /api/spectrogram/thumb: no date required, and no file on disk behind it.
func TestRollingThumbnailEndpoint(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	sr := newTestRollingRecorder(t, now, cutoff)

	rec := httptest.NewRecorder()
	handleSpectrogramThumbnail(rec, httptest.NewRequest("GET", "/api/spectrogram/thumb?rolling=1", nil), sr)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", got)
	}
	img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if b := img.Bounds(); b.Dx() != spectrogramThumbW || b.Dy() != spectrogramThumbH {
		t.Errorf("thumbnail is %dx%d, want %dx%d", b.Dx(), b.Dy(), spectrogramThumbW, spectrogramThumbH)
	}

	// Nothing was written to disk for it.
	entries, err := os.ReadDir(sr.config.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), "thumb") {
			t.Errorf("rolling thumbnail was persisted to disk as %s", e.Name())
		}
	}

	// A date-based request still requires the file to exist.
	rec = httptest.NewRecorder()
	handleSpectrogramThumbnail(rec, httptest.NewRequest("GET", "/api/spectrogram/thumb?date="+now.Format("2006-01-02"), nil), sr)
	if rec.Code != http.StatusNotFound {
		t.Errorf("archived thumb status = %d, want 404", rec.Code)
	}
}
