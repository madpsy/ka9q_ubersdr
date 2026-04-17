package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	spectrogramBins           = 4096 // Must match wideband FFT bin count
	spectrogramMaxRows        = 1440 // One row per minute, 24 hours
	spectrogramMagic          = "SGRM"
	spectrogramVersion        = uint32(1)
	spectrogramDefaultDBMin   = float32(-130) // fallback noise floor when insufficient data
	spectrogramDefaultDBMax   = float32(-60)  // fallback signal peak when insufficient data
	spectrogramDefaultPalette = "jet"         // default colour palette
)

// noDataSentinel marks bins with no data (rendered as black).
var noDataSentinel = float32(math.Inf(-1))

// SpectrogramRecorder records the 0-30 MHz wideband spectrum as a daily PNG image.
// One row is appended per minute. At UTC midnight the completed day is archived
// and a new image begins. The in-memory PNG is always valid and served via HTTP.
type SpectrogramRecorder struct {
	nfm    *NoiseFloorMonitor
	config SpectrogramConfig

	// Ring buffer — fixed size, allocated once at startup
	rows     [spectrogramMaxRows][spectrogramBins]float32
	rowCount int       // rows written so far today (0..1440)
	lastRow  time.Time // UTC timestamp of the last written row

	// Cached PNG — atomically swapped after each render
	cachedPNG    atomic.Pointer[[]byte]
	lastModified time.Time
	mu           sync.Mutex // protects rows, rowCount, lastRow, lastModified

	// latestComplete caches the most recent archived date string ("YYYY-MM-DD").
	// Updated at startup and after each midnight rollover. Zero value = no complete day yet.
	latestComplete atomic.Value // stores string

	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewSpectrogramRecorder creates a new recorder. Returns nil if disabled or nfm is nil.
func NewSpectrogramRecorder(nfm *NoiseFloorMonitor, config SpectrogramConfig) *SpectrogramRecorder {
	if !config.IsEnabled() || nfm == nil {
		return nil
	}
	return &SpectrogramRecorder{
		nfm:      nfm,
		config:   config,
		stopChan: make(chan struct{}),
	}
}

// Start loads today's existing data (if any) and begins the background ticker.
func (sr *SpectrogramRecorder) Start() error {
	if err := os.MkdirAll(sr.config.DataDir, 0755); err != nil {
		return err
	}

	// Initialise all rows to sentinel (black)
	sr.mu.Lock()
	for i := range sr.rows {
		for j := range sr.rows[i] {
			sr.rows[i][j] = noDataSentinel
		}
	}
	sr.mu.Unlock()

	sr.loadTodayFromDisk()

	// Render initial PNG so the endpoint is immediately valid
	sr.renderAndCache()

	// Populate latestComplete from disk so /api/spectrogram/latest works immediately.
	today := time.Now().UTC().Format("2006-01-02")
	for _, d := range sr.AvailableDates() {
		if d != today {
			sr.latestComplete.Store(d)
			break
		}
	}

	sr.wg.Add(1)
	go sr.loop()
	log.Printf("Spectrogram recorder started (dir: %s, rows so far today: %d)", sr.config.DataDir, sr.rowCount)
	return nil
}

// Stop shuts down the recorder gracefully.
func (sr *SpectrogramRecorder) Stop() {
	close(sr.stopChan)
	sr.wg.Wait()
	log.Println("Spectrogram recorder stopped")
}

// GetCachedPNG returns the current in-memory PNG bytes (nil if not yet ready).
func (sr *SpectrogramRecorder) GetCachedPNG() []byte {
	p := sr.cachedPNG.Load()
	if p == nil {
		return nil
	}
	return *p
}

// LastModified returns the time the cached PNG was last updated.
func (sr *SpectrogramRecorder) LastModified() time.Time {
	sr.mu.Lock()
	defer sr.mu.Unlock()
	return sr.lastModified
}

// AvailableDates returns a list of dates (newest first) that have archived PNGs.
// Today's date is always first if the recorder is running.
func (sr *SpectrogramRecorder) AvailableDates() []string {
	today := time.Now().UTC().Format("2006-01-02")
	dates := []string{today}

	entries, err := os.ReadDir(sr.config.DataDir)
	if err != nil {
		return dates
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "spectrogram_") || !strings.HasSuffix(name, ".png") {
			continue
		}
		dateStr := strings.TrimSuffix(strings.TrimPrefix(name, "spectrogram_"), ".png")
		if dateStr == today {
			continue
		}
		if _, err := time.Parse("2006-01-02", dateStr); err != nil {
			continue
		}
		dates = append(dates, dateStr)
	}
	// Reverse so newest archived dates come first (after today)
	for i, j := 1, len(dates)-1; i < j; i, j = i+1, j-1 {
		dates[i], dates[j] = dates[j], dates[i]
	}
	return dates
}

// ArchivedPNGPath returns the filesystem path for a given date's archived PNG.
func (sr *SpectrogramRecorder) ArchivedPNGPath(dateStr string) string {
	return filepath.Join(sr.config.DataDir, "spectrogram_"+dateStr+".png")
}

// ─── background loop ──────────────────────────────────────────────────────────

func (sr *SpectrogramRecorder) loop() {
	defer sr.wg.Done()

	// Align to the next whole minute boundary before starting the ticker
	now := time.Now().UTC()
	nextMinute := now.Truncate(time.Minute).Add(time.Minute)
	select {
	case <-time.After(time.Until(nextMinute)):
	case <-sr.stopChan:
		return
	}

	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-sr.stopChan:
			return
		case t := <-ticker.C:
			sr.tick(t.UTC())
		}
	}
}

func (sr *SpectrogramRecorder) tick(t time.Time) {
	today := t.Format("2006-01-02")

	sr.mu.Lock()
	needsRollover := sr.rowCount > 0 && sr.lastRow.UTC().Format("2006-01-02") != today
	sr.mu.Unlock()

	if needsRollover {
		sr.rollover(t)
	}

	// Sample the wideband FFT (10-second average — already smoothed)
	fft := sr.nfm.GetWideBandFFT()

	sr.mu.Lock()
	var newRowIndex int = -1
	var noiseFloor float32
	if sr.rowCount < spectrogramMaxRows {
		row := &sr.rows[sr.rowCount]
		if fft == nil || len(fft.Data) == 0 {
			// No data — black row
			for i := range row {
				row[i] = noDataSentinel
			}
		} else {
			n := len(fft.Data)
			if n > spectrogramBins {
				n = spectrogramBins
			}
			copy(row[:n], fft.Data[:n])
			for i := n; i < spectrogramBins; i++ {
				row[i] = noDataSentinel
			}
		}
		noiseFloor = rowP5(row)
		newRowIndex = sr.rowCount
		sr.rowCount++
		sr.lastRow = t
	}
	sr.mu.Unlock()

	// Append row metadata to JSONL (outside lock)
	if newRowIndex >= 0 {
		sr.appendRowToJSONL(today, newRowIndex, t, noiseFloor)
	}

	// Render PNG and persist to disk (outside lock — CPU-bound work)
	sr.renderAndCache()
	sr.persistToDisk(today)
}

// rollover archives the completed day and resets state for the new day.
func (sr *SpectrogramRecorder) rollover(newDayTime time.Time) {
	sr.mu.Lock()
	oldDate := sr.lastRow.UTC().Format("2006-01-02")
	sr.mu.Unlock()

	log.Printf("Spectrogram: UTC day rollover — archiving %s", oldDate)

	// Render final PNG for the completed day and archive it
	sr.renderAndCache()
	pngBytes := sr.GetCachedPNG()
	if len(pngBytes) > 0 {
		archivePath := sr.ArchivedPNGPath(oldDate)
		if err := atomicWriteFile(archivePath, pngBytes); err != nil {
			log.Printf("Spectrogram: failed to archive PNG for %s: %v", oldDate, err)
		} else {
			log.Printf("Spectrogram: archived %s (%d bytes)", archivePath, len(pngBytes))
		}
	}

	// Delete the working .bin for the old day (no longer needed after archiving)
	oldBin := filepath.Join(sr.config.DataDir, "spectrogram_"+oldDate+".bin")
	os.Remove(oldBin)
	// The .jsonl is kept as the archived metadata for the completed day

	// Run retention cleanup
	sr.runCleanup(newDayTime)

	// Update the cached latest-complete date (used by /api/spectrogram/latest)
	sr.latestComplete.Store(oldDate)

	// Reset state for new day
	sr.mu.Lock()
	sr.rowCount = 0
	sr.lastRow = time.Time{}
	for i := range sr.rows {
		for j := range sr.rows[i] {
			sr.rows[i][j] = noDataSentinel
		}
	}
	sr.mu.Unlock()
}

// ─── disk persistence ─────────────────────────────────────────────────────────

// persistToDisk writes the current .bin file atomically.
func (sr *SpectrogramRecorder) persistToDisk(today string) {
	sr.mu.Lock()
	rowCount := sr.rowCount
	lastRow := sr.lastRow
	rowData := make([]float32, rowCount*spectrogramBins)
	for i := 0; i < rowCount; i++ {
		copy(rowData[i*spectrogramBins:(i+1)*spectrogramBins], sr.rows[i][:])
	}
	sr.mu.Unlock()

	if rowCount == 0 {
		return
	}

	binPath := filepath.Join(sr.config.DataDir, "spectrogram_"+today+".bin")

	// Header: magic(4) + version(4) + rowCount(4) + lastRowUnix(8) + binCount(4) = 24 bytes
	headerSize := 24
	dataSize := rowCount * spectrogramBins * 4
	buf := make([]byte, headerSize+dataSize)

	copy(buf[0:4], spectrogramMagic)
	binary.LittleEndian.PutUint32(buf[4:8], spectrogramVersion)
	binary.LittleEndian.PutUint32(buf[8:12], uint32(rowCount))
	binary.LittleEndian.PutUint64(buf[12:20], uint64(lastRow.Unix()))
	binary.LittleEndian.PutUint32(buf[20:24], uint32(spectrogramBins))

	offset := headerSize
	for _, v := range rowData {
		binary.LittleEndian.PutUint32(buf[offset:offset+4], math.Float32bits(v))
		offset += 4
	}

	if err := atomicWriteFile(binPath, buf); err != nil {
		log.Printf("Spectrogram: failed to write .bin: %v", err)
	}
}

// jsonlPath returns the path to the JSONL metadata file for a given date.
func (sr *SpectrogramRecorder) jsonlPath(dateStr string) string {
	return filepath.Join(sr.config.DataDir, "spectrogram_"+dateStr+".jsonl")
}

// appendRowToJSONL appends one row's metadata as a JSON line to the daily .jsonl file.
// The file is opened in append mode so each call adds exactly one line.
func (sr *SpectrogramRecorder) appendRowToJSONL(dateStr string, rowIndex int, t time.Time, noiseFloor float32) {
	type rowEntry struct {
		Row        int     `json:"row"`
		UTCTime    string  `json:"utc_time"`
		Unix       int64   `json:"unix"`
		NoiseFloor float32 `json:"noise_floor"`
	}
	entry := rowEntry{
		Row:        rowIndex,
		UTCTime:    t.UTC().Format("15:04"),
		Unix:       t.Unix(),
		NoiseFloor: noiseFloor,
	}
	line, err := json.Marshal(entry)
	if err != nil {
		log.Printf("Spectrogram: failed to marshal JSONL entry: %v", err)
		return
	}

	f, err := os.OpenFile(sr.jsonlPath(dateStr), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Printf("Spectrogram: failed to open JSONL file: %v", err)
		return
	}
	defer f.Close()
	f.Write(line)
	f.Write([]byte{'\n'})
}

// readJSONL reads all row entries from a .jsonl file for a given date.
// Returns nil if the file does not exist.
func (sr *SpectrogramRecorder) readJSONL(dateStr string) []SpectrogramRowMeta {
	type rawEntry struct {
		Row        int     `json:"row"`
		UTCTime    string  `json:"utc_time"`
		Unix       int64   `json:"unix"`
		NoiseFloor float32 `json:"noise_floor"`
	}

	data, err := os.ReadFile(sr.jsonlPath(dateStr))
	if err != nil {
		return nil
	}

	var rows []SpectrogramRowMeta
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e rawEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		rows = append(rows, SpectrogramRowMeta{
			Row:        e.Row,
			UTCTime:    e.UTCTime,
			Unix:       e.Unix,
			NoiseFloor: e.NoiseFloor,
		})
	}
	return rows
}

// loadTodayFromDisk attempts to restore today's data from the .bin file.
func (sr *SpectrogramRecorder) loadTodayFromDisk() {
	today := time.Now().UTC().Format("2006-01-02")
	binPath := filepath.Join(sr.config.DataDir, "spectrogram_"+today+".bin")

	data, err := os.ReadFile(binPath)
	if err != nil {
		return // No file — fresh start
	}

	if len(data) < 24 || string(data[0:4]) != spectrogramMagic {
		log.Printf("Spectrogram: corrupt or missing magic in %s, starting fresh", binPath)
		return
	}

	version := binary.LittleEndian.Uint32(data[4:8])
	if version != spectrogramVersion {
		log.Printf("Spectrogram: unknown .bin version %d, starting fresh", version)
		return
	}

	rowCount := int(binary.LittleEndian.Uint32(data[8:12]))
	lastRowUnix := int64(binary.LittleEndian.Uint64(data[12:20]))
	binCount := int(binary.LittleEndian.Uint32(data[20:24]))
	lastRowTime := time.Unix(lastRowUnix, 0).UTC()

	if rowCount < 0 || rowCount > spectrogramMaxRows {
		log.Printf("Spectrogram: invalid rowCount %d in .bin, starting fresh", rowCount)
		return
	}
	if binCount != spectrogramBins {
		log.Printf("Spectrogram: bin count mismatch (%d vs %d), starting fresh", binCount, spectrogramBins)
		return
	}

	expectedSize := 24 + rowCount*spectrogramBins*4
	if len(data) < expectedSize {
		rowCount = (len(data) - 24) / (spectrogramBins * 4)
		log.Printf("Spectrogram: truncated .bin, loading %d rows", rowCount)
	}

	sr.mu.Lock()
	for i := 0; i < rowCount; i++ {
		offset := 24 + i*spectrogramBins*4
		for j := 0; j < spectrogramBins; j++ {
			bits := binary.LittleEndian.Uint32(data[offset : offset+4])
			sr.rows[i][j] = math.Float32frombits(bits)
			offset += 4
		}
	}
	sr.rowCount = rowCount
	sr.lastRow = lastRowTime
	sr.mu.Unlock()

	// Fill gap since last row with black (sentinel) rows
	now := time.Now().UTC()
	gapMinutes := int(now.Sub(lastRowTime).Minutes())
	if gapMinutes > 0 {
		maxGap := spectrogramMaxRows - rowCount
		if gapMinutes > maxGap {
			gapMinutes = maxGap
		}
		log.Printf("Spectrogram: filling %d-minute gap (program was down since %s)",
			gapMinutes, lastRowTime.Format("15:04 UTC"))
		sr.mu.Lock()
		for i := 0; i < gapMinutes && sr.rowCount < spectrogramMaxRows; i++ {
			for j := range sr.rows[sr.rowCount] {
				sr.rows[sr.rowCount][j] = noDataSentinel
			}
			sr.rowCount++
		}
		sr.mu.Unlock()
	}

	log.Printf("Spectrogram: resumed %s with %d rows (last row: %s)",
		today, sr.rowCount, lastRowTime.Format("15:04 UTC"))
}

// ─── PNG rendering ────────────────────────────────────────────────────────────

// renderAndCache renders the current ring buffer to a PNG and atomically swaps
// the cached pointer. Safe to call from any goroutine.
func (sr *SpectrogramRecorder) renderAndCache() {
	sr.mu.Lock()
	rowCount := sr.rowCount
	if rowCount == 0 {
		sr.mu.Unlock()
		return
	}
	// Snapshot rows under lock
	snapshot := make([][]float32, rowCount)
	for i := 0; i < rowCount; i++ {
		row := make([]float32, spectrogramBins)
		copy(row, sr.rows[i][:])
		snapshot[i] = row
	}
	sr.mu.Unlock()

	// Auto-range from actual data; fall back to hardcoded defaults if insufficient data.
	dbMin, dbMax := autoRangeRows(snapshot, spectrogramDefaultDBMin, spectrogramDefaultDBMax)

	// Fixed 4096×1440 image — unfilled rows are black
	img := image.NewNRGBA(image.Rect(0, 0, spectrogramBins, spectrogramMaxRows))

	black := color.NRGBA{0, 0, 0, 255}

	// Fill unfilled rows with black
	for y := rowCount; y < spectrogramMaxRows; y++ {
		for x := 0; x < spectrogramBins; x++ {
			img.SetNRGBA(x, y, black)
		}
	}

	// Render filled rows — row 0 = UTC midnight (top), newest = bottom
	palette := spectrogramDefaultPalette
	for y, row := range snapshot {
		for x, val := range row {
			if math.IsInf(float64(val), -1) || math.IsNaN(float64(val)) {
				img.SetNRGBA(x, y, black)
			} else {
				img.SetNRGBA(x, y, paletteColour(palette, val, dbMin, dbMax))
			}
		}
	}

	// Draw watermark at bottom-right: "UberSDR <callsign> <date>"
	watermarkText := "UberSDR"
	if sr.config.Callsign != "" {
		watermarkText += " " + sr.config.Callsign
	}
	watermarkText += " " + time.Now().UTC().Format("2006-01-02")
	drawWatermark(img, watermarkText)

	// Encode to PNG using a bytes.Buffer (no goroutine needed)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		log.Printf("Spectrogram: PNG encode error: %v", err)
		return
	}

	pngBytes := buf.Bytes()

	sr.mu.Lock()
	sr.lastModified = time.Now().UTC()
	sr.mu.Unlock()

	sr.cachedPNG.Store(&pngBytes)
}

// ─── retention cleanup ────────────────────────────────────────────────────────

func (sr *SpectrogramRecorder) runCleanup(today time.Time) {
	if sr.config.RetentionDays <= 0 {
		return // keep forever
	}
	cutoff := today.UTC().Truncate(24*time.Hour).AddDate(0, 0, -sr.config.RetentionDays)

	entries, err := os.ReadDir(sr.config.DataDir)
	if err != nil {
		log.Printf("Spectrogram cleanup: failed to read dir: %v", err)
		return
	}

	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "spectrogram_") || !strings.HasSuffix(name, ".png") {
			continue
		}
		dateStr := strings.TrimSuffix(strings.TrimPrefix(name, "spectrogram_"), ".png")
		fileDate, err := time.Parse("2006-01-02", dateStr)
		if err != nil {
			continue
		}
		if fileDate.Before(cutoff) {
			pngPath := filepath.Join(sr.config.DataDir, name)
			binPath := filepath.Join(sr.config.DataDir, "spectrogram_"+dateStr+".bin")
			jsonlPath := filepath.Join(sr.config.DataDir, "spectrogram_"+dateStr+".jsonl")
			os.Remove(pngPath)
			os.Remove(binPath)
			os.Remove(jsonlPath)
			log.Printf("Spectrogram: deleted old files for %s (older than %d days)", dateStr, sr.config.RetentionDays)
		}
	}
}

// ─── Watermark ────────────────────────────────────────────────────────────────

// drawWatermark renders text at the bottom-right of the image using a 5×7 pixel font.
// The text is drawn with a dark shadow for readability over any background colour,
// including the black no-data area.
func drawWatermark(img *image.NRGBA, text string) {
	const (
		charW = 6  // glyph width including 1px spacing
		charH = 7  // glyph height
		padX  = 12 // right padding
		padY  = 12 // bottom padding
		scale = 5  // pixel scale factor — large enough to read when image is scaled to browser width
	)

	textW := len(text) * charW * scale
	textH := charH * scale

	bounds := img.Bounds()
	startX := bounds.Max.X - textW - padX
	startY := bounds.Max.Y - textH - padY

	shadow := color.NRGBA{0, 0, 0, 180}
	white := color.NRGBA{255, 255, 255, 210}

	for ci, ch := range text {
		glyph, ok := font5x7[byte(ch)]
		if !ok {
			glyph = font5x7[' ']
		}
		bx := startX + ci*charW*scale
		for row := 0; row < charH; row++ {
			for col := 0; col < 5; col++ {
				if glyph[row]&(1<<uint(4-col)) != 0 {
					for sy := 0; sy < scale; sy++ {
						for sx := 0; sx < scale; sx++ {
							px := bx + col*scale + sx
							py := startY + row*scale + sy
							// Shadow (offset by 1 scaled pixel)
							spx, spy := px+scale, py+scale
							if spx >= 0 && spy >= 0 && spx < bounds.Max.X && spy < bounds.Max.Y {
								img.SetNRGBA(spx, spy, shadow)
							}
							// Foreground
							if px >= 0 && py >= 0 && px < bounds.Max.X && py < bounds.Max.Y {
								img.SetNRGBA(px, py, white)
							}
						}
					}
				}
			}
		}
	}
}

// font5x7 is a minimal 5×7 pixel bitmap font for printable ASCII.
// Each entry is 7 bytes; each byte is a 5-bit row (MSB = leftmost pixel).
var font5x7 = map[byte][7]byte{
	' ': {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
	'A': {0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
	'B': {0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E},
	'C': {0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E},
	'D': {0x1E, 0x09, 0x09, 0x09, 0x09, 0x09, 0x1E},
	'E': {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F},
	'F': {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10},
	'G': {0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F},
	'H': {0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
	'I': {0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E},
	'J': {0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C},
	'K': {0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11},
	'L': {0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F},
	'M': {0x11, 0x1B, 0x15, 0x11, 0x11, 0x11, 0x11},
	'N': {0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11},
	'O': {0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},
	'P': {0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10},
	'Q': {0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D},
	'R': {0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11},
	'S': {0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E},
	'T': {0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04},
	'U': {0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},
	'V': {0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04},
	'W': {0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11},
	'X': {0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11},
	'Y': {0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04},
	'Z': {0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F},
	'a': {0x00, 0x00, 0x0E, 0x01, 0x0F, 0x11, 0x0F},
	'b': {0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x1E},
	'c': {0x00, 0x00, 0x0E, 0x10, 0x10, 0x11, 0x0E},
	'd': {0x01, 0x01, 0x0F, 0x11, 0x11, 0x11, 0x0F},
	'e': {0x00, 0x00, 0x0E, 0x11, 0x1F, 0x10, 0x0E},
	'f': {0x06, 0x09, 0x08, 0x1C, 0x08, 0x08, 0x08},
	'g': {0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x0E},
	'h': {0x10, 0x10, 0x1E, 0x11, 0x11, 0x11, 0x11},
	'i': {0x04, 0x00, 0x0C, 0x04, 0x04, 0x04, 0x0E},
	'j': {0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0C},
	'k': {0x10, 0x10, 0x11, 0x12, 0x1C, 0x12, 0x11},
	'l': {0x0C, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E},
	'm': {0x00, 0x00, 0x1A, 0x15, 0x15, 0x11, 0x11},
	'n': {0x00, 0x00, 0x1E, 0x11, 0x11, 0x11, 0x11},
	'o': {0x00, 0x00, 0x0E, 0x11, 0x11, 0x11, 0x0E},
	'p': {0x00, 0x00, 0x1E, 0x11, 0x1E, 0x10, 0x10},
	'q': {0x00, 0x00, 0x0F, 0x11, 0x0F, 0x01, 0x01},
	'r': {0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10},
	's': {0x00, 0x00, 0x0E, 0x10, 0x0E, 0x01, 0x1E},
	't': {0x08, 0x08, 0x1C, 0x08, 0x08, 0x09, 0x06},
	'u': {0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0D},
	'v': {0x00, 0x00, 0x11, 0x11, 0x11, 0x0A, 0x04},
	'w': {0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0A},
	'x': {0x00, 0x00, 0x11, 0x0A, 0x04, 0x0A, 0x11},
	'y': {0x00, 0x00, 0x11, 0x11, 0x0F, 0x01, 0x0E},
	'z': {0x00, 0x00, 0x1F, 0x02, 0x04, 0x08, 0x1F},
	'0': {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E},
	'1': {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},
	'2': {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F},
	'3': {0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E},
	'4': {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02},
	'5': {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},
	'6': {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E},
	'7': {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
	'8': {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E},
	'9': {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C},
	'-': {0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00},
	'.': {0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C},
	'/': {0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10},
}

// ─── atomic file write ────────────────────────────────────────────────────────

// atomicWriteFile writes data to path atomically using a temp file + rename.
func atomicWriteFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".spectrogram_tmp_*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

// ─── Colour palettes ──────────────────────────────────────────────────────────

// paletteColour maps a dB value in [dbMin, dbMax] to a colour using the named palette.
// Supported palettes: "viridis" (default), "plasma", "jet".
func paletteColour(palette string, db, dbMin, dbMax float32) color.NRGBA {
	t := (db - dbMin) / (dbMax - dbMin)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	idx := int(t * 255.0)
	if idx > 255 {
		idx = 255
	}
	var lut *[256][3]uint8
	switch palette {
	case "plasma":
		lut = &plasmaLUT
	case "jet":
		lut = &jetLUT
	default:
		lut = &viridisLUT
	}
	return color.NRGBA{lut[idx][0], lut[idx][1], lut[idx][2], 255}
}

// ─── viridis colour palette ───────────────────────────────────────────────────

// viridisColour maps a dB value in [dbMin, dbMax] to a viridis palette colour.
// Values outside the range are clamped.
func viridisColour(db, dbMin, dbMax float32) color.NRGBA {
	t := (db - dbMin) / (dbMax - dbMin)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	idx := int(t * 255.0)
	if idx > 255 {
		idx = 255
	}
	r, g, b := viridisLUT[idx][0], viridisLUT[idx][1], viridisLUT[idx][2]
	return color.NRGBA{r, g, b, 255}
}

// viridisLUT is the exact 256-entry viridis colour lookup table.
// From matplotlib viridis colormap (perceptually uniform, colour-blind friendly).
// Index 0 = darkest purple (noise floor), index 255 = bright yellow (strongest signal).
var viridisLUT = [256][3]uint8{
	{68, 1, 84}, {68, 2, 86}, {69, 4, 87}, {69, 5, 89}, {70, 7, 90},
	{70, 8, 92}, {70, 10, 93}, {70, 11, 94}, {71, 13, 96}, {71, 14, 97},
	{71, 16, 99}, {71, 17, 100}, {71, 19, 101}, {72, 20, 103}, {72, 22, 104},
	{72, 23, 105}, {72, 24, 106}, {72, 26, 108}, {72, 27, 109}, {72, 28, 110},
	{72, 30, 111}, {72, 31, 112}, {72, 32, 113}, {72, 34, 115}, {72, 35, 116},
	{72, 36, 117}, {72, 38, 118}, {72, 39, 119}, {72, 40, 120}, {72, 42, 121},
	{72, 43, 122}, {71, 44, 122}, {71, 46, 123}, {71, 47, 124}, {71, 48, 125},
	{71, 50, 126}, {70, 51, 127}, {70, 52, 128}, {70, 54, 128}, {70, 55, 129},
	{69, 56, 130}, {69, 58, 131}, {69, 59, 131}, {68, 60, 132}, {68, 62, 133},
	{68, 63, 133}, {67, 64, 134}, {67, 66, 135}, {67, 67, 135}, {66, 68, 136},
	{66, 70, 137}, {65, 71, 137}, {65, 72, 138}, {65, 74, 138}, {64, 75, 139},
	{64, 76, 140}, {63, 78, 140}, {63, 79, 141}, {62, 80, 141}, {62, 82, 142},
	{61, 83, 142}, {61, 84, 143}, {60, 86, 143}, {60, 87, 144}, {59, 88, 144},
	{59, 90, 145}, {58, 91, 145}, {58, 92, 146}, {57, 94, 146}, {57, 95, 146},
	{56, 96, 147}, {56, 98, 147}, {55, 99, 148}, {55, 100, 148}, {54, 102, 148},
	{54, 103, 149}, {53, 104, 149}, {53, 106, 149}, {52, 107, 150}, {52, 108, 150},
	{51, 110, 150}, {51, 111, 151}, {50, 112, 151}, {50, 114, 151}, {49, 115, 152},
	{49, 116, 152}, {48, 118, 152}, {48, 119, 152}, {47, 120, 153}, {47, 122, 153},
	{46, 123, 153}, {46, 124, 153}, {45, 126, 154}, {45, 127, 154}, {44, 128, 154},
	{44, 130, 154}, {43, 131, 154}, {43, 132, 155}, {42, 134, 155}, {42, 135, 155},
	{41, 136, 155}, {41, 138, 155}, {40, 139, 155}, {40, 140, 156}, {39, 142, 156},
	{39, 143, 156}, {38, 144, 156}, {38, 146, 156}, {37, 147, 156}, {37, 148, 156},
	{36, 150, 156}, {36, 151, 156}, {35, 152, 157}, {35, 154, 157}, {34, 155, 157},
	{34, 156, 157}, {33, 158, 157}, {33, 159, 157}, {32, 160, 157}, {32, 162, 157},
	{31, 163, 157}, {31, 164, 157}, {30, 166, 157}, {30, 167, 157}, {29, 168, 157},
	{29, 170, 157}, {28, 171, 157}, {28, 172, 157}, {27, 174, 157}, {27, 175, 157},
	{26, 176, 157}, {26, 178, 157}, {25, 179, 157}, {25, 180, 157}, {24, 182, 157},
	{24, 183, 157}, {23, 184, 157}, {23, 186, 157}, {22, 187, 157}, {22, 188, 157},
	{21, 190, 157}, {21, 191, 157}, {20, 192, 157}, {20, 194, 157}, {19, 195, 157},
	{19, 196, 157}, {18, 198, 157}, {18, 199, 157}, {17, 200, 157}, {17, 202, 157},
	{16, 203, 157}, {16, 204, 157}, {15, 206, 157}, {15, 207, 157}, {14, 208, 157},
	{14, 210, 157}, {13, 211, 157}, {13, 212, 157}, {12, 214, 157}, {12, 215, 157},
	{11, 216, 157}, {11, 218, 157}, {10, 219, 157}, {10, 220, 157}, {9, 222, 157},
	{9, 223, 157}, {8, 224, 157}, {8, 226, 157}, {7, 227, 157}, {7, 228, 157},
	{6, 230, 157}, {6, 231, 157}, {5, 232, 157}, {5, 234, 157}, {4, 235, 157},
	{4, 236, 157}, {3, 238, 157}, {3, 239, 157}, {2, 240, 157}, {2, 242, 157},
	{1, 243, 157}, {1, 244, 157}, {0, 246, 157}, {0, 247, 157}, {0, 248, 157},
	{0, 250, 157}, {0, 251, 157}, {0, 252, 157}, {0, 254, 157}, {1, 255, 157},
	{3, 255, 156}, {5, 255, 154}, {8, 255, 152}, {11, 255, 150}, {14, 255, 148},
	{17, 255, 146}, {20, 255, 144}, {23, 255, 142}, {26, 255, 140}, {29, 255, 138},
	{32, 255, 136}, {35, 255, 134}, {38, 255, 132}, {41, 255, 130}, {44, 255, 128},
	{47, 255, 126}, {50, 255, 124}, {53, 255, 122}, {56, 255, 120}, {59, 255, 118},
	{62, 255, 116}, {65, 255, 114}, {68, 255, 112}, {71, 255, 110}, {74, 255, 108},
	{77, 255, 106}, {80, 255, 104}, {83, 255, 102}, {86, 255, 100}, {89, 255, 98},
	{92, 255, 96}, {95, 255, 94}, {98, 255, 92}, {101, 255, 90}, {104, 255, 88},
	{107, 255, 86}, {110, 255, 84}, {113, 255, 82}, {116, 255, 80}, {119, 255, 78},
	{122, 255, 76}, {125, 255, 74}, {128, 255, 72}, {131, 255, 70}, {134, 255, 68},
	{137, 255, 66}, {140, 255, 64}, {143, 255, 62}, {146, 255, 60}, {149, 255, 58},
	{152, 255, 56}, {155, 255, 54}, {158, 255, 52}, {161, 255, 50}, {164, 255, 48},
	{167, 255, 46}, {170, 255, 44}, {173, 255, 42}, {176, 255, 40}, {179, 255, 38},
	{182, 255, 36}, {185, 255, 34}, {188, 255, 32}, {191, 255, 30}, {194, 255, 28},
	{253, 231, 37},
}

// plasmaLUT is a 256-entry plasma colour lookup table.
// Matches the plasma colour scheme in spectrum-display.js (5-point interpolation).
// Index 0 = dark blue (noise floor), index 255 = bright yellow (strongest signal).
var plasmaLUT = [256][3]uint8{
	{13, 8, 135}, {14, 9, 138}, {15, 10, 141}, {16, 11, 144}, {17, 12, 147},
	{18, 13, 150}, {19, 14, 153}, {20, 15, 156}, {21, 16, 159}, {22, 17, 162},
	{24, 18, 165}, {25, 19, 168}, {27, 20, 170}, {29, 21, 172}, {31, 22, 174},
	{33, 23, 176}, {35, 24, 178}, {37, 25, 180}, {39, 26, 182}, {41, 27, 184},
	{43, 28, 186}, {45, 29, 188}, {47, 30, 190}, {49, 31, 192}, {51, 32, 194},
	{53, 33, 196}, {55, 34, 198}, {57, 35, 200}, {59, 36, 202}, {61, 37, 204},
	{63, 38, 206}, {65, 39, 208}, {67, 40, 210}, {69, 41, 212}, {71, 42, 214},
	{73, 43, 216}, {75, 44, 218}, {77, 45, 220}, {79, 46, 222}, {81, 47, 224},
	{83, 48, 226}, {85, 49, 228}, {87, 50, 230}, {89, 51, 232}, {91, 52, 234},
	{93, 53, 236}, {95, 54, 238}, {97, 55, 240}, {99, 56, 242}, {101, 57, 244},
	{103, 58, 246}, {105, 59, 248}, {107, 60, 250}, {109, 61, 252}, {111, 62, 254},
	{113, 63, 255}, {114, 64, 254}, {115, 65, 252}, {116, 66, 250}, {117, 67, 248},
	{118, 68, 246}, {119, 69, 244}, {120, 70, 242}, {121, 71, 240}, {122, 72, 238},
	{123, 73, 236}, {124, 74, 234}, {125, 75, 232}, {126, 76, 230}, {127, 77, 228},
	{128, 78, 226}, {129, 79, 224}, {130, 80, 222}, {131, 81, 220}, {132, 82, 218},
	{133, 83, 216}, {134, 84, 214}, {135, 85, 212}, {136, 86, 210}, {137, 87, 208},
	{138, 88, 206}, {139, 89, 204}, {140, 90, 202}, {141, 91, 200}, {142, 92, 198},
	{143, 93, 196}, {144, 94, 194}, {145, 95, 192}, {146, 96, 190}, {147, 97, 188},
	{148, 98, 186}, {149, 99, 184}, {150, 100, 182}, {151, 101, 180}, {152, 102, 178},
	{153, 103, 176}, {154, 104, 174}, {155, 105, 172}, {156, 106, 170}, {157, 107, 168},
	{158, 108, 166}, {159, 109, 164}, {160, 110, 162}, {161, 111, 160}, {162, 112, 158},
	{163, 113, 156}, {164, 114, 154}, {165, 115, 152}, {166, 116, 150}, {167, 117, 148},
	{168, 118, 146}, {169, 119, 144}, {170, 120, 142}, {171, 121, 140}, {172, 122, 138},
	{173, 123, 136}, {174, 124, 134}, {175, 125, 132}, {176, 126, 130}, {177, 127, 128},
	{178, 128, 126}, {179, 129, 124}, {180, 130, 122}, {181, 131, 120}, {182, 132, 118},
	{183, 133, 116}, {184, 134, 114}, {185, 135, 112}, {186, 136, 110}, {187, 137, 108},
	{188, 138, 106}, {189, 139, 104}, {190, 140, 102}, {191, 141, 100}, {192, 142, 98},
	{193, 143, 96}, {194, 144, 94}, {195, 145, 92}, {196, 146, 90}, {197, 147, 88},
	{198, 148, 86}, {199, 149, 84}, {200, 150, 82}, {201, 151, 80}, {202, 152, 78},
	{203, 153, 76}, {204, 154, 74}, {205, 155, 72}, {206, 156, 70}, {207, 157, 68},
	{208, 158, 66}, {209, 159, 64}, {210, 160, 62}, {211, 161, 60}, {212, 162, 58},
	{213, 163, 56}, {214, 164, 54}, {215, 165, 52}, {216, 166, 50}, {217, 167, 48},
	{218, 168, 46}, {219, 169, 44}, {220, 170, 42}, {221, 171, 40}, {222, 172, 38},
	{223, 173, 36}, {224, 174, 34}, {225, 175, 32}, {226, 176, 30}, {227, 177, 28},
	{228, 178, 26}, {229, 179, 24}, {230, 180, 22}, {231, 181, 20}, {232, 182, 18},
	{233, 183, 16}, {234, 184, 14}, {235, 185, 12}, {236, 186, 10}, {237, 187, 8},
	{238, 188, 6}, {239, 189, 4}, {240, 190, 2}, {241, 191, 1}, {242, 192, 1},
	{243, 193, 2}, {244, 194, 4}, {245, 195, 6}, {246, 196, 8}, {247, 197, 10},
	{248, 198, 12}, {248, 199, 14}, {249, 200, 16}, {249, 201, 18}, {249, 202, 20},
	{249, 203, 22}, {249, 204, 24}, {249, 205, 26}, {249, 206, 28}, {249, 207, 30},
	{249, 208, 32}, {249, 209, 33}, {249, 210, 33}, {249, 211, 33}, {249, 212, 33},
	{249, 213, 33}, {249, 214, 33}, {249, 215, 33}, {249, 216, 33}, {249, 217, 33},
	{249, 218, 33}, {249, 219, 33}, {249, 220, 33}, {249, 221, 33}, {249, 222, 33},
	{249, 223, 33}, {249, 224, 33}, {249, 225, 33}, {249, 226, 33}, {249, 227, 33},
	{249, 228, 33}, {249, 229, 33}, {249, 230, 33}, {249, 231, 33}, {249, 232, 33},
	{249, 233, 33}, {249, 234, 33}, {249, 235, 33}, {249, 236, 33}, {249, 237, 33},
	{249, 238, 33}, {249, 239, 33}, {249, 240, 33}, {249, 241, 33}, {249, 242, 33},
	{249, 243, 33}, {249, 244, 33}, {249, 245, 33}, {249, 246, 33}, {249, 247, 33},
	{249, 248, 33}, {249, 249, 33}, {249, 250, 33}, {249, 251, 33}, {240, 249, 33},
}

// jetLUT is a 256-entry jet colour lookup table.
// Matches the jet colour scheme in spectrum-display.js (6-point interpolation).
// Index 0 = dark blue (noise floor), index 255 = dark red (strongest signal).
var jetLUT = [256][3]uint8{
	{0, 0, 143}, {0, 0, 147}, {0, 0, 151}, {0, 0, 155}, {0, 0, 159},
	{0, 0, 163}, {0, 0, 167}, {0, 0, 171}, {0, 0, 175}, {0, 0, 179},
	{0, 0, 183}, {0, 0, 187}, {0, 0, 191}, {0, 0, 195}, {0, 0, 199},
	{0, 0, 203}, {0, 0, 207}, {0, 0, 211}, {0, 0, 215}, {0, 0, 219},
	{0, 0, 223}, {0, 0, 227}, {0, 0, 231}, {0, 0, 235}, {0, 0, 239},
	{0, 0, 243}, {0, 0, 247}, {0, 0, 251}, {0, 0, 255}, {0, 4, 255},
	{0, 8, 255}, {0, 12, 255}, {0, 16, 255}, {0, 20, 255}, {0, 24, 255},
	{0, 28, 255}, {0, 32, 255}, {0, 36, 255}, {0, 40, 255}, {0, 44, 255},
	{0, 48, 255}, {0, 52, 255}, {0, 56, 255}, {0, 60, 255}, {0, 64, 255},
	{0, 68, 255}, {0, 72, 255}, {0, 76, 255}, {0, 80, 255}, {0, 84, 255},
	{0, 88, 255}, {0, 92, 255}, {0, 96, 255}, {0, 100, 255}, {0, 104, 255},
	{0, 108, 255}, {0, 112, 255}, {0, 116, 255}, {0, 120, 255}, {0, 124, 255},
	{0, 128, 255}, {0, 132, 255}, {0, 136, 255}, {0, 140, 255}, {0, 144, 255},
	{0, 148, 255}, {0, 152, 255}, {0, 156, 255}, {0, 160, 255}, {0, 164, 255},
	{0, 168, 255}, {0, 172, 255}, {0, 176, 255}, {0, 180, 255}, {0, 184, 255},
	{0, 188, 255}, {0, 192, 255}, {0, 196, 255}, {0, 200, 255}, {0, 204, 255},
	{0, 208, 255}, {0, 212, 255}, {0, 216, 255}, {0, 220, 255}, {0, 224, 255},
	{0, 228, 255}, {0, 232, 255}, {0, 236, 255}, {0, 240, 255}, {0, 244, 255},
	{0, 248, 255}, {0, 252, 255}, {2, 255, 253}, {6, 255, 249}, {10, 255, 245},
	{14, 255, 241}, {18, 255, 237}, {22, 255, 233}, {26, 255, 229}, {30, 255, 225},
	{34, 255, 221}, {38, 255, 217}, {42, 255, 213}, {46, 255, 209}, {50, 255, 205},
	{54, 255, 201}, {58, 255, 197}, {62, 255, 193}, {66, 255, 189}, {70, 255, 185},
	{74, 255, 181}, {78, 255, 177}, {82, 255, 173}, {86, 255, 169}, {90, 255, 165},
	{94, 255, 161}, {98, 255, 157}, {102, 255, 153}, {106, 255, 149}, {110, 255, 145},
	{114, 255, 141}, {118, 255, 137}, {122, 255, 133}, {126, 255, 129}, {130, 255, 125},
	{134, 255, 121}, {138, 255, 117}, {142, 255, 113}, {146, 255, 109}, {150, 255, 105},
	{154, 255, 101}, {158, 255, 97}, {162, 255, 93}, {166, 255, 89}, {170, 255, 85},
	{174, 255, 81}, {178, 255, 77}, {182, 255, 73}, {186, 255, 69}, {190, 255, 65},
	{194, 255, 61}, {198, 255, 57}, {202, 255, 53}, {206, 255, 49}, {210, 255, 45},
	{214, 255, 41}, {218, 255, 37}, {222, 255, 33}, {226, 255, 29}, {230, 255, 25},
	{234, 255, 21}, {238, 255, 17}, {242, 255, 13}, {246, 255, 9}, {250, 255, 5},
	{254, 255, 1}, {255, 251, 0}, {255, 247, 0}, {255, 243, 0}, {255, 239, 0},
	{255, 235, 0}, {255, 231, 0}, {255, 227, 0}, {255, 223, 0}, {255, 219, 0},
	{255, 215, 0}, {255, 211, 0}, {255, 207, 0}, {255, 203, 0}, {255, 199, 0},
	{255, 195, 0}, {255, 191, 0}, {255, 187, 0}, {255, 183, 0}, {255, 179, 0},
	{255, 175, 0}, {255, 171, 0}, {255, 167, 0}, {255, 163, 0}, {255, 159, 0},
	{255, 155, 0}, {255, 151, 0}, {255, 147, 0}, {255, 143, 0}, {255, 139, 0},
	{255, 135, 0}, {255, 131, 0}, {255, 127, 0}, {255, 123, 0}, {255, 119, 0},
	{255, 115, 0}, {255, 111, 0}, {255, 107, 0}, {255, 103, 0}, {255, 99, 0},
	{255, 95, 0}, {255, 91, 0}, {255, 87, 0}, {255, 83, 0}, {255, 79, 0},
	{255, 75, 0}, {255, 71, 0}, {255, 67, 0}, {255, 63, 0}, {255, 59, 0},
	{255, 55, 0}, {255, 51, 0}, {255, 47, 0}, {255, 43, 0}, {255, 39, 0},
	{255, 35, 0}, {255, 31, 0}, {255, 27, 0}, {255, 23, 0}, {255, 19, 0},
	{255, 15, 0}, {255, 11, 0}, {255, 7, 0}, {255, 3, 0}, {252, 0, 0},
	{248, 0, 0}, {244, 0, 0}, {240, 0, 0}, {236, 0, 0}, {232, 0, 0},
	{228, 0, 0}, {224, 0, 0}, {220, 0, 0}, {216, 0, 0}, {212, 0, 0},
	{208, 0, 0}, {204, 0, 0}, {200, 0, 0}, {196, 0, 0}, {192, 0, 0},
	{188, 0, 0}, {184, 0, 0}, {180, 0, 0}, {176, 0, 0}, {172, 0, 0},
	{168, 0, 0}, {164, 0, 0}, {160, 0, 0}, {156, 0, 0}, {152, 0, 0},
	{148, 0, 0}, {144, 0, 0}, {140, 0, 0}, {136, 0, 0}, {132, 0, 0},
	{128, 0, 0},
}

// ─── Statistics helpers ───────────────────────────────────────────────────────

// autoRangeRows computes the P5 (noise floor) and P95 (signal peak) dBFS values
// across all valid bins in all rows. Used to auto-scale the colour range when
// no explicit db_min/db_max is provided by the caller.
// Returns (dbMin, dbMax). If no valid data is found, returns the config defaults.
func autoRangeRows(rows [][]float32, configMin, configMax float32) (float32, float32) {
	// Collect a sample of valid values — cap at 500 k to keep memory bounded
	const maxSamples = 500_000
	valid := make([]float32, 0, min(len(rows)*spectrogramBins, maxSamples))
	for _, row := range rows {
		for _, v := range row {
			if math.IsInf(float64(v), -1) || math.IsNaN(float64(v)) {
				continue
			}
			valid = append(valid, v)
			if len(valid) >= maxSamples {
				goto done
			}
		}
	}
done:
	if len(valid) < 10 {
		return configMin, configMax
	}
	sortFloat32Slice(valid)
	p5idx := len(valid) * 5 / 100
	p95idx := len(valid) * 95 / 100
	if p5idx >= len(valid) {
		p5idx = len(valid) - 1
	}
	if p95idx >= len(valid) {
		p95idx = len(valid) - 1
	}
	dbMin := valid[p5idx]
	dbMax := valid[p95idx]
	// Ensure a minimum 10 dB spread to avoid degenerate images
	if dbMax-dbMin < 10 {
		dbMax = dbMin + 10
	}
	return dbMin, dbMax
}

// min returns the smaller of two ints (Go 1.20 added a builtin but keep compat).
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// parseAndValidateDBRange parses optional ?db_min= and ?db_max= query parameters.
// Rules:
//   - Values must be finite floats in the range [-300, 0] dBFS.
//   - db_max must be at least 5 dB above db_min.
//   - If either param is absent or invalid, both are returned as (0, 0, false)
//     to signal "use auto-range".
//
// Returns (dbMin, dbMax, ok). ok=true means both values are valid and should be used.
func parseAndValidateDBRange(q url.Values) (float32, float32, bool) {
	minStr := q.Get("db_min")
	maxStr := q.Get("db_max")
	if minStr == "" && maxStr == "" {
		return 0, 0, false // caller should auto-range
	}
	if minStr == "" || maxStr == "" {
		return 0, 0, false // partial params — ignore both
	}
	minVal, err1 := strconv.ParseFloat(minStr, 32)
	maxVal, err2 := strconv.ParseFloat(maxStr, 32)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	// Clamp to sane dBFS range
	if minVal < -300 || minVal > 0 || maxVal < -300 || maxVal > 0 {
		return 0, 0, false
	}
	if math.IsNaN(minVal) || math.IsInf(minVal, 0) || math.IsNaN(maxVal) || math.IsInf(maxVal, 0) {
		return 0, 0, false
	}
	if float32(maxVal)-float32(minVal) < 5 {
		return 0, 0, false // spread too small
	}
	return float32(minVal), float32(maxVal), true
}

// rowP5 returns the 5th-percentile dBFS value of a spectrogram row,
// skipping sentinel (no-data) values. Used as a per-minute noise floor estimate.
func rowP5(row *[spectrogramBins]float32) float32 {
	// Collect valid (non-sentinel) values
	valid := make([]float32, 0, spectrogramBins)
	for _, v := range row {
		if !math.IsInf(float64(v), -1) && !math.IsNaN(float64(v)) {
			valid = append(valid, v)
		}
	}
	if len(valid) == 0 {
		return 0
	}
	// Partial sort to find P5 without full sort (use nth-element approximation via sort)
	// For 4096 bins this is fast enough
	sortFloat32Slice(valid)
	idx := len(valid) * 5 / 100
	if idx >= len(valid) {
		idx = len(valid) - 1
	}
	return valid[idx]
}

// sortFloat32Slice sorts a []float32 in ascending order using stdlib sort.
func sortFloat32Slice(s []float32) {
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────

// renderRowsAsPNG renders a set of float32 rows as a PNG using the specified palette.
// Used for on-the-fly palette switching.
func renderRowsAsPNG(rows [][]float32, palette string, dbMin, dbMax float32, dateStr string, callsign string) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, spectrogramBins, spectrogramMaxRows))
	black := color.NRGBA{0, 0, 0, 255}

	rowCount := len(rows)
	for y := rowCount; y < spectrogramMaxRows; y++ {
		for x := 0; x < spectrogramBins; x++ {
			img.SetNRGBA(x, y, black)
		}
	}
	for y, row := range rows {
		for x, val := range row {
			if math.IsInf(float64(val), -1) || math.IsNaN(float64(val)) {
				img.SetNRGBA(x, y, black)
			} else {
				img.SetNRGBA(x, y, paletteColour(palette, val, dbMin, dbMax))
			}
		}
	}

	// Watermark
	wm := "UberSDR"
	if callsign != "" {
		wm += " " + callsign
	}
	wm += " " + dateStr
	drawWatermark(img, wm)

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

// ── Spectrogram HTTP API ─────────────────────────────────────────────────────
//
// Image endpoints (PNG):
//
//	GET /api/spectrogram                                    → today's PNG (Jet palette, auto-range)
//	GET /api/spectrogram?palette=plasma                     → today's PNG re-rendered with Plasma palette
//	GET /api/spectrogram?db_min=-110&db_max=-65             → today's PNG with explicit dB range
//	GET /api/spectrogram?date=YYYY-MM-DD                    → archived PNG for a past date
//	GET /api/spectrogram?date=...&palette=jet               → archived PNG re-rendered with Jet palette
//	GET /api/spectrogram?date=...&db_min=...&db_max=...     → archived PNG with explicit dB range
//	GET /api/spectrogram/latest                             → 302 → most recent complete day's PNG
//
// Metadata endpoints (JSON):
//
//	GET /api/spectrogram/meta                               → today's metadata (db_min/db_max, row count, per-row noise floor)
//	GET /api/spectrogram/meta?date=YYYY-MM-DD               → metadata for a past date
//	GET /api/spectrogram/meta/latest                        → 302 → metadata for the most recent complete day
//	GET /api/spectrogram/list                               → JSON list of available dates (newest first)
//
// Caching:
//
//	Today's PNG:          Cache-Control: max-age=60,    ETag: W/"<lastModified-ms>"
//	Re-rendered PNG:      Cache-Control: max-age=3600,  ETag: W/"<date>-<palette>-<dbMin>-<dbMax>"
//	Archived disk PNG:    Cache-Control: max-age=86400, ETag: W/"<mtime>-<size>"
//	/latest redirect:     Cache-Control: max-age=3600,  ETag: "<YYYY-MM-DD>"
//	/meta/latest redirect:Cache-Control: max-age=3600,  ETag: "<YYYY-MM-DD>-meta"
//	Today's meta:         Cache-Control: max-age=60
//	Archived meta:        Cache-Control: max-age=3600
//
// When db_min/db_max are absent the range is auto-computed from the actual data
// (P5 noise floor → P95 signal peak) so the full palette is always utilised.
//
// handleSpectrogram serves the spectrogram PNG for a given UTC date.
func handleSpectrogram(w http.ResponseWriter, r *http.Request, recorder *SpectrogramRecorder, rateLimiter *FFTRateLimiter, ipBanManager *IPBanManager) {
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	if recorder == nil {
		http.Error(w, "spectrogram recording is not enabled", http.StatusServiceUnavailable)
		return
	}

	q := r.URL.Query()

	// Rate limit: use "spectrogram-palette" key (2s) when a re-render is needed
	// (palette/range changes are CPU-only, no disk I/O), otherwise "spectrogram" (10s).
	clientIP := getClientIP(r)
	rateLimitKey := "spectrogram"
	if q.Get("palette") != "" || q.Get("db_min") != "" || q.Get("db_max") != "" {
		rateLimitKey = "spectrogram-palette"
	}
	if !rateLimiter.AllowRequest(clientIP, rateLimitKey) {
		w.WriteHeader(http.StatusTooManyRequests)
		http.Error(w, "rate limit exceeded for spectrogram — please wait before requesting again", http.StatusTooManyRequests)
		return
	}

	today := time.Now().UTC().Format("2006-01-02")
	dateStr := q.Get("date")

	// Validate and sanitise palette param
	requestedPalette := q.Get("palette")
	switch requestedPalette {
	case "viridis", "plasma", "jet":
		// valid
	default:
		requestedPalette = spectrogramDefaultPalette // fall back to default palette
	}

	// Parse and validate optional db_min / db_max query params.
	// If absent or invalid, dbRangeExplicit=false → auto-compute from data.
	dbMin, dbMax, dbRangeExplicit := parseAndValidateDBRange(q)

	// needsRerender is true whenever we cannot serve the pre-cached PNG as-is.
	needsRerender := requestedPalette != spectrogramDefaultPalette || dbRangeExplicit

	if dateStr == "" || dateStr == today {
		var pngBytes []byte
		if needsRerender {
			// Snapshot today's rows under lock
			recorder.mu.Lock()
			rowCount := recorder.rowCount
			rows := make([][]float32, rowCount)
			for i := 0; i < rowCount; i++ {
				row := make([]float32, spectrogramBins)
				copy(row, recorder.rows[i][:])
				rows[i] = row
			}
			recorder.mu.Unlock()
			if rowCount == 0 {
				http.Error(w, "spectrogram not yet available — waiting for first data", http.StatusServiceUnavailable)
				return
			}
			if !dbRangeExplicit {
				// Auto-compute range from actual data
				dbMin, dbMax = autoRangeRows(rows, spectrogramDefaultDBMin, spectrogramDefaultDBMax)
			}
			pngBytes = renderRowsAsPNG(rows, requestedPalette, dbMin, dbMax, today, recorder.config.Callsign)
		} else {
			// No palette or range change — serve the pre-cached PNG directly.
			// The cached PNG was rendered with config db_min/db_max; if the user
			// wants auto-range they must pass db_min/db_max explicitly (the JS
			// frontend always does this after receiving the meta response).
			pngBytes = recorder.GetCachedPNG()
		}
		if len(pngBytes) == 0 {
			http.Error(w, "spectrogram not yet available — waiting for first data", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=60")
		w.Header().Set("Content-Disposition", `inline; filename="spectrogram_`+today+`.png"`)
		lm := recorder.LastModified()
		if !lm.IsZero() {
			w.Header().Set("Last-Modified", lm.UTC().Format(http.TimeFormat))
			etag := `W/"` + strconv.FormatInt(lm.UnixMilli(), 10) + `"`
			w.Header().Set("ETag", etag)
			if r.Header.Get("If-None-Match") == etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		w.Write(pngBytes)
		return
	}

	// Validate date format
	requestedDate, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		http.Error(w, "invalid date format — use YYYY-MM-DD", http.StatusBadRequest)
		return
	}

	// Reject future dates
	if requestedDate.After(time.Now().UTC()) {
		http.Error(w, "date is in the future", http.StatusBadRequest)
		return
	}

	safeDateStr := requestedDate.Format("2006-01-02")

	if needsRerender {
		// Re-render archived day from .bin file with requested palette / range
		binPath := filepath.Join(recorder.config.DataDir, "spectrogram_"+safeDateStr+".bin")
		binData, err := os.ReadFile(binPath)
		if err != nil || len(binData) < 24 || string(binData[0:4]) != spectrogramMagic {
			// .bin not available — fall through to serve disk PNG
			goto serveDiskPNG
		}
		rowCount := int(binary.LittleEndian.Uint32(binData[8:12]))
		if rowCount <= 0 || rowCount > spectrogramMaxRows {
			goto serveDiskPNG
		}
		rows := make([][]float32, rowCount)
		for i := 0; i < rowCount; i++ {
			row := make([]float32, spectrogramBins)
			offset := 24 + i*spectrogramBins*4
			if offset+spectrogramBins*4 > len(binData) {
				break
			}
			for j := 0; j < spectrogramBins; j++ {
				bits := binary.LittleEndian.Uint32(binData[offset : offset+4])
				row[j] = math.Float32frombits(bits)
				offset += 4
			}
			rows[i] = row
		}
		if !dbRangeExplicit {
			// Auto-compute range from actual archived data
			dbMin, dbMax = autoRangeRows(rows, spectrogramDefaultDBMin, spectrogramDefaultDBMax)
		}
		pngBytes := renderRowsAsPNG(rows, requestedPalette, dbMin, dbMax, safeDateStr, recorder.config.Callsign)
		if len(pngBytes) == 0 {
			goto serveDiskPNG
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=3600") // re-rendered, not immutable
		w.Header().Set("Content-Disposition", `inline; filename="spectrogram_`+safeDateStr+`.png"`)
		// Weak ETag: date + rendering params — changes if palette or range changes
		etag := `W/"` + safeDateStr + "-" + requestedPalette + "-" +
			strconv.FormatFloat(float64(dbMin), 'f', 1, 32) + "-" +
			strconv.FormatFloat(float64(dbMax), 'f', 1, 32) + `"`
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Write(pngBytes)
		return
	}

serveDiskPNG:
	// Serve archived PNG from disk (use re-formatted date to prevent path traversal)
	path := recorder.ArchivedPNGPath(safeDateStr)
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "no spectrogram available for "+safeDateStr, http.StatusNotFound)
		return
	}
	defer f.Close()

	stat, _ := f.Stat()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "max-age=86400") // archived days are immutable
	w.Header().Set("Content-Disposition", `inline; filename="spectrogram_`+safeDateStr+`.png"`)
	if stat != nil {
		w.Header().Set("Last-Modified", stat.ModTime().UTC().Format(http.TimeFormat))
		// Weak ETag: mtime + size — stable for immutable archived files
		etag := `W/"` + strconv.FormatInt(stat.ModTime().Unix(), 10) + "-" + strconv.FormatInt(stat.Size(), 10) + `"`
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	io.Copy(w, f)
}

// handleSpectrogramLatest redirects to the most recent *complete* spectrogram PNG.
// "Complete" means any archived day (not today). The redirect target is the
// date-specific PNG URL which carries Cache-Control: max-age=86400, so browsers
// and CDNs cache the image for 24 hours without re-fetching.
// The redirect itself is cached for 1 hour so clients re-check after midnight.
//
// The latest-complete date is cached in an atomic.Value updated at startup and
// after each midnight rollover — no directory scan on every request.
//
//	GET /api/spectrogram/latest → 302 /api/spectrogram?date=YYYY-MM-DD
func handleSpectrogramLatest(w http.ResponseWriter, r *http.Request, recorder *SpectrogramRecorder, rateLimiter *FFTRateLimiter, ipBanManager *IPBanManager) {
	if checkIPBan(w, r, ipBanManager) {
		return
	}
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "spectrogram-latest") {
		http.Error(w, "rate limit exceeded for spectrogram/latest — please wait before requesting again", http.StatusTooManyRequests)
		return
	}
	if recorder == nil {
		http.Error(w, "spectrogram recording is not enabled", http.StatusServiceUnavailable)
		return
	}

	// Read from atomic cache — zero-cost, no I/O
	v := recorder.latestComplete.Load()
	latestComplete, _ := v.(string)
	if latestComplete == "" {
		http.Error(w, "no complete spectrogram available yet", http.StatusNotFound)
		return
	}

	// Redirect to the date-specific PNG endpoint.
	// Cache the redirect for 1 hour — re-check after midnight when a new day completes.
	// ETag is the target date string — stable until a new day completes at midnight.
	target := "/api/spectrogram?date=" + latestComplete
	etag := `"` + latestComplete + `"`
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// handleSpectrogramMetaLatest redirects to the metadata for the most recent *complete* day.
// Mirrors handleSpectrogramLatest but targets /api/spectrogram/meta?date=YYYY-MM-DD instead
// of the PNG endpoint, so clients can discover the latest date and its metadata in one step.
//
//	GET /api/spectrogram/meta/latest → 302 /api/spectrogram/meta?date=YYYY-MM-DD
func handleSpectrogramMetaLatest(w http.ResponseWriter, r *http.Request, recorder *SpectrogramRecorder, rateLimiter *FFTRateLimiter, ipBanManager *IPBanManager) {
	if checkIPBan(w, r, ipBanManager) {
		return
	}
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "spectrogram-latest") {
		http.Error(w, "rate limit exceeded for spectrogram/meta/latest — please wait before requesting again", http.StatusTooManyRequests)
		return
	}
	if recorder == nil {
		http.Error(w, "spectrogram recording is not enabled", http.StatusServiceUnavailable)
		return
	}

	// Read from atomic cache — zero-cost, no I/O
	v := recorder.latestComplete.Load()
	latestComplete, _ := v.(string)
	if latestComplete == "" {
		http.Error(w, "no complete spectrogram available yet", http.StatusNotFound)
		return
	}

	// Redirect to the date-specific meta endpoint.
	// Same ETag and cache lifetime as the image latest redirect.
	target := "/api/spectrogram/meta?date=" + latestComplete
	etag := `"` + latestComplete + `-meta"`
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// handleSpectrogramList returns a JSON list of available spectrogram dates (newest first).
//
//	GET /api/spectrogram/list
func handleSpectrogramList(w http.ResponseWriter, r *http.Request, recorder *SpectrogramRecorder) {
	if recorder == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"enabled":   false,
			"available": []string{},
		})
		return
	}

	dates := recorder.AvailableDates()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "max-age=60")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled":   true,
		"today":     time.Now().UTC().Format("2006-01-02"),
		"available": dates,
	})
}

// SpectrogramRowMeta holds the UTC timestamp and noise floor for a single spectrogram row.
type SpectrogramRowMeta struct {
	Row        int     `json:"row"`
	UTCTime    string  `json:"utc_time"` // "HH:MM"
	Unix       int64   `json:"unix"`
	NoiseFloor float32 `json:"noise_floor"` // P5 percentile dBFS (noise floor estimate)
}

// SpectrogramMeta is the JSON response for GET /api/spectrogram/meta.
type SpectrogramMeta struct {
	Date               string               `json:"date"`
	StartFreqHz        float64              `json:"start_freq_hz"`
	EndFreqHz          float64              `json:"end_freq_hz"`
	BinWidthHz         float64              `json:"bin_width_hz"`
	BinCount           int                  `json:"bin_count"`
	RowCount           int                  `json:"row_count"`
	MaxRows            int                  `json:"max_rows"`
	RowIntervalSeconds int                  `json:"row_interval_seconds"`
	DBMin              float64              `json:"db_min"`
	DBMax              float64              `json:"db_max"`
	Palette            string               `json:"palette"`
	ImageURL           string               `json:"image_url"`
	ListURL            string               `json:"list_url"`
	Complete           bool                 `json:"complete"`
	Rows               []SpectrogramRowMeta `json:"rows"`
}

// handleSpectrogramMeta returns JSON metadata for a spectrogram image.
//
//	GET /api/spectrogram/meta              → today's metadata
//	GET /api/spectrogram/meta?date=YYYY-MM-DD → metadata for a past date
//
// The response includes db_min/db_max reflecting the auto-computed range from
// the actual data (P5/P95), so the frontend can display accurate legend labels
// and pass the same values back as ?db_min=&db_max= when requesting the PNG.
func handleSpectrogramMeta(w http.ResponseWriter, r *http.Request, recorder *SpectrogramRecorder, rateLimiter *FFTRateLimiter, ipBanManager *IPBanManager) {
	w.Header().Set("Content-Type", "application/json")

	if checkIPBan(w, r, ipBanManager) {
		return
	}
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "spectrogram-meta") {
		http.Error(w, `{"error":"rate limit exceeded for spectrogram/meta"}`, http.StatusTooManyRequests)
		return
	}

	if recorder == nil {
		http.Error(w, `{"error":"spectrogram recording is not enabled"}`, http.StatusServiceUnavailable)
		return
	}

	today := time.Now().UTC().Format("2006-01-02")
	dateStr := r.URL.Query().Get("date")
	if dateStr == "" {
		dateStr = today
	}

	// Validate date
	requestedDate, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		http.Error(w, `{"error":"invalid date format — use YYYY-MM-DD"}`, http.StatusBadRequest)
		return
	}
	if requestedDate.After(time.Now().UTC()) {
		http.Error(w, `{"error":"date is in the future"}`, http.StatusBadRequest)
		return
	}
	safeDateStr := requestedDate.Format("2006-01-02")

	// Primary source: read per-row metadata from the .jsonl file (available for all dates)
	rows := recorder.readJSONL(safeDateStr)

	var rowCount int
	var complete bool

	// Snapshot of float32 rows used for auto-range computation
	var dataRows [][]float32

	if safeDateStr == today {
		// For today, fall back to ring buffer if JSONL is missing or has fewer rows
		// (e.g. first minute before any row has been written)
		recorder.mu.Lock()
		liveRowCount := recorder.rowCount
		recorder.mu.Unlock()

		if len(rows) < liveRowCount {
			// JSONL is behind — fill missing rows from ring buffer
			midnight := time.Date(requestedDate.Year(), requestedDate.Month(), requestedDate.Day(), 0, 0, 0, 0, time.UTC)
			recorder.mu.Lock()
			for i := len(rows); i < liveRowCount; i++ {
				t := midnight.Add(time.Duration(i) * time.Minute)
				nf := rowP5(&recorder.rows[i])
				rows = append(rows, SpectrogramRowMeta{
					Row:        i,
					UTCTime:    t.Format("15:04"),
					Unix:       t.Unix(),
					NoiseFloor: nf,
				})
			}
			recorder.mu.Unlock()
		}
		rowCount = len(rows)
		complete = false

		// Snapshot data rows for auto-range
		recorder.mu.Lock()
		dataRows = make([][]float32, recorder.rowCount)
		for i := 0; i < recorder.rowCount; i++ {
			row := make([]float32, spectrogramBins)
			copy(row, recorder.rows[i][:])
			dataRows[i] = row
		}
		recorder.mu.Unlock()
	} else {
		// Archived day — use JSONL row count; if JSONL missing, assume full day
		if rows == nil {
			rowCount = spectrogramMaxRows
		} else {
			rowCount = len(rows)
		}
		complete = true

		// Load data rows from .bin for auto-range computation
		binPath := filepath.Join(recorder.config.DataDir, "spectrogram_"+safeDateStr+".bin")
		if binData, binErr := os.ReadFile(binPath); binErr == nil && len(binData) >= 24 && string(binData[0:4]) == spectrogramMagic {
			binRowCount := int(binary.LittleEndian.Uint32(binData[8:12]))
			if binRowCount > 0 && binRowCount <= spectrogramMaxRows {
				dataRows = make([][]float32, binRowCount)
				for i := 0; i < binRowCount; i++ {
					row := make([]float32, spectrogramBins)
					offset := 24 + i*spectrogramBins*4
					if offset+spectrogramBins*4 > len(binData) {
						break
					}
					for j := 0; j < spectrogramBins; j++ {
						bits := binary.LittleEndian.Uint32(binData[offset : offset+4])
						row[j] = math.Float32frombits(bits)
						offset += 4
					}
					dataRows[i] = row
				}
			}
		}
	}

	// If rows is still nil (no JSONL, archived day), build synthetic rows with zero noise floor
	if rows == nil {
		midnight := time.Date(requestedDate.Year(), requestedDate.Month(), requestedDate.Day(), 0, 0, 0, 0, time.UTC)
		rows = make([]SpectrogramRowMeta, rowCount)
		for i := 0; i < rowCount; i++ {
			t := midnight.Add(time.Duration(i) * time.Minute)
			rows[i] = SpectrogramRowMeta{
				Row:     i,
				UTCTime: t.Format("15:04"),
				Unix:    t.Unix(),
			}
		}
	}

	// Compute auto-range from actual data; fall back to hardcoded defaults if no data available.
	autoMin, autoMax := autoRangeRows(dataRows, spectrogramDefaultDBMin, spectrogramDefaultDBMax)

	// image_url does NOT include db_min/db_max — the frontend uses the meta values
	// to populate the contrast sliders and only adds db_min/db_max to the image URL
	// when the user has moved the sliders away from the auto-range defaults.
	// This avoids a re-render on every page load.
	imageURL := "/api/spectrogram"
	if safeDateStr != today {
		imageURL += "?date=" + safeDateStr
	}

	cacheControl := "max-age=60"
	if complete {
		cacheControl = "max-age=3600"
	}
	w.Header().Set("Cache-Control", cacheControl)

	meta := SpectrogramMeta{
		Date:               safeDateStr,
		StartFreqHz:        0,
		EndFreqHz:          30000000,
		BinWidthHz:         7324.21875,
		BinCount:           spectrogramBins,
		RowCount:           rowCount,
		MaxRows:            spectrogramMaxRows,
		RowIntervalSeconds: 60,
		DBMin:              float64(autoMin),
		DBMax:              float64(autoMax),
		Palette:            spectrogramDefaultPalette,
		ImageURL:           imageURL,
		ListURL:            "/api/spectrogram/list",
		Complete:           complete,
		Rows:               rows,
	}

	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(meta)
}
