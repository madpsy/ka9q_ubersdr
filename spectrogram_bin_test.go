package main

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newBinTestRecorder builds a bare recorder over a temp dir with `binCount` bins
// and no FFT source. Rows are left unallocated; each test fills what it needs.
func newBinTestRecorder(t *testing.T, binCount int) *SpectrogramRecorder {
	t.Helper()
	return newSpectrogramRecorderForBand(nil, SpectrogramConfig{DataDir: t.TempDir()},
		"wideband", 0, 30_000_000, binCount, func() *BandFFT { return nil })
}

// TestSpectrogramBinWriterReaderAgree pins the .bin layout down from both ends: what
// persistToDisk writes must come back out of spectrogramBinRows bin for bin.
//
// The header has grown once already (v1 → v2 added the frequency axis) and readers
// were left behind, decoding every row four float32s early. Nothing about that fails
// loudly — the rows are all still float32s, just the wrong ones — so the only thing
// that catches it is checking the two halves against each other.
func TestSpectrogramBinWriterReaderAgree(t *testing.T) {
	const (
		binCount = 16
		rowCount = 5
	)
	sr := newBinTestRecorder(t, binCount)

	// Values unique in both axes, so a shift of any size in either direction lands
	// on a value that identifies where it came from.
	want := make([][]float32, rowCount)
	for m := 0; m < rowCount; m++ {
		row := make([]float32, binCount)
		for j := range row {
			row[j] = float32(m*100 + j)
		}
		sr.rows[m] = row
		want[m] = row
	}
	sr.rowCount = rowCount
	sr.lastRow = time.Now().UTC()

	const date = "2026-09-08"
	sr.persistToDisk(date)

	data, err := os.ReadFile(filepath.Join(sr.config.DataDir, "spectrogram_"+date+".bin"))
	if err != nil {
		t.Fatalf("read .bin: %v", err)
	}
	if wantLen := spectrogramHeaderSize + rowCount*binCount*4; len(data) != wantLen {
		t.Fatalf("file size = %d, want %d — writer and header constant disagree", len(data), wantLen)
	}

	got, gotBins := spectrogramBinRows(data)
	if gotBins != binCount {
		t.Fatalf("bin count = %d, want %d", gotBins, binCount)
	}
	if len(got) != rowCount {
		t.Fatalf("row count = %d, want %d", len(got), rowCount)
	}
	for m := range want {
		for j := range want[m] {
			if got[m][j] != want[m][j] {
				t.Fatalf("row %d bin %d = %v, want %v (rows are decoded at the wrong offset)",
					m, j, got[m][j], want[m][j])
			}
		}
	}
}

// TestSpectrogramBinRowsRejectsUnusableFiles covers what the readers must refuse
// rather than misread. A v1 file is the important one: its header is shorter, so
// decoding it against the current layout would slide every row the other way.
func TestSpectrogramBinRowsRejectsUnusableFiles(t *testing.T) {
	const binCount = 4
	header := func(version uint32, rowCount, bins int) []byte {
		buf := make([]byte, spectrogramHeaderSize+rowCount*bins*4)
		copy(buf[0:4], spectrogramMagic)
		binary.LittleEndian.PutUint32(buf[4:8], version)
		binary.LittleEndian.PutUint32(buf[8:12], uint32(rowCount))
		binary.LittleEndian.PutUint32(buf[20:24], uint32(bins))
		return buf
	}

	cases := []struct {
		name string
		data []byte
	}{
		{"empty", nil},
		{"short", make([]byte, spectrogramHeaderSize-1)},
		{"bad magic", append([]byte("NOPE"), make([]byte, spectrogramHeaderSize)...)},
		{"v1", header(1, 2, binCount)},
		{"zero rows", header(spectrogramVersion, 0, binCount)},
		{"zero bins", header(spectrogramVersion, 2, 0)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if rows, bins := spectrogramBinRows(tc.data); rows != nil || bins != 0 {
				t.Errorf("got %d rows / %d bins, want the file to be refused", len(rows), bins)
			}
		})
	}
}

// TestSpectrogramBinRowsTruncated checks a half-written file yields the rows that
// are actually there and nil for the rest, rather than reading off the end.
func TestSpectrogramBinRowsTruncated(t *testing.T) {
	const (
		binCount = 8
		rowCount = 4
	)
	sr := newBinTestRecorder(t, binCount)
	for m := 0; m < rowCount; m++ {
		row := make([]float32, binCount)
		for j := range row {
			row[j] = float32(m)
		}
		sr.rows[m] = row
	}
	sr.rowCount = rowCount
	sr.lastRow = time.Now().UTC()

	const date = "2026-09-08"
	sr.persistToDisk(date)
	path := filepath.Join(sr.config.DataDir, "spectrogram_"+date+".bin")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read .bin: %v", err)
	}

	// Chop the last two rows off, leaving one of them half present.
	rows, _ := spectrogramBinRows(data[:spectrogramHeaderSize+2*binCount*4+binCount*2])
	if len(rows) != rowCount {
		t.Fatalf("row count = %d, want %d (header row count is authoritative)", len(rows), rowCount)
	}
	for m := 0; m < 2; m++ {
		if rows[m] == nil {
			t.Fatalf("row %d is nil, want it decoded", m)
		}
		if rows[m][0] != float32(m) {
			t.Errorf("row %d = %v, want %v", m, rows[m][0], float32(m))
		}
	}
	for m := 2; m < rowCount; m++ {
		if rows[m] != nil {
			t.Errorf("row %d decoded past the end of the file", m)
		}
	}
}

// TestRollingWindowNoFrequencyShiftAtMidnight is the regression test for the step in
// the spectrogram at 00:00 UTC.
//
// The rolling 24-hour window is stitched from two sources: yesterday's rows come off
// disk, today's out of the ring buffer. While the reader assumed a header the writer
// had outgrown, everything before midnight was decoded four float32s early and so was
// drawn four bins up the frequency axis — on the wideband recorder, 4 × 7.3 kHz ≈
// 30 kHz. A carrier that never moved appeared to jump sideways at the midnight row.
func TestRollingWindowNoFrequencyShiftAtMidnight(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Hour()*60 + now.Minute()
	if cutoff == 0 {
		t.Skip("running exactly at UTC midnight — no rows for today")
	}

	const (
		binCount = 32
		peakBin  = 20
		floorDB  = float32(-120)
		peakDB   = float32(-20)
	)
	// One carrier, parked in the same bin all day, on both sides of midnight.
	carrier := func(_, bin int) float32 {
		if bin == peakBin {
			return peakDB
		}
		return floorDB
	}

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

	writeTestDay(t, dir, yesterday.Format("2006-01-02"), yesterdayMidnight,
		spectrogramMaxRows, binCount, carrier)

	for m := 0; m < cutoff; m++ {
		for j := range sr.rows[m] {
			sr.rows[m][j] = carrier(m, j)
		}
		sr.appendRowToJSONL(now.Format("2006-01-02"), m, todayMidnight.Add(time.Duration(m)*time.Minute), floorDB)
	}
	sr.rowCount = cutoff
	sr.lastRow = todayMidnight.Add(time.Duration(cutoff) * time.Minute)

	rr := sr.getRolling24hRows()
	if len(rr.rows) == 0 {
		t.Fatal("rolling window is empty")
	}

	// The carrier must sit in the same bin in every row of the window — the rows
	// before the midnight seam came off disk, the ones after it did not.
	seen := 0
	for i, row := range rr.rows {
		if row == nil {
			continue
		}
		seen++
		peak, peakIdx := float32(math.Inf(-1)), -1
		for j, v := range row {
			if v > peak {
				peak, peakIdx = v, j
			}
		}
		if peakIdx != peakBin {
			side := "before"
			if i >= spectrogramMaxRows-cutoff {
				side = "after"
			}
			t.Fatalf("window row %d (%s the midnight seam): carrier in bin %d, want %d — "+
				"archived rows are shifted %d bins", i, side, peakIdx, peakBin, peakBin-peakIdx)
		}
	}
	if seen < spectrogramMaxRows/2 {
		t.Fatalf("only %d rows populated, want most of the 24-hour window", seen)
	}
}
