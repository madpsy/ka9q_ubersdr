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
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	spectrogramBins    = 4096 // Must match wideband FFT bin count
	spectrogramMaxRows = 1440 // One row per minute, 24 hours
	spectrogramMagic   = "SGRM"
	spectrogramVersion = uint32(1)
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

	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewSpectrogramRecorder creates a new recorder. Returns nil if disabled or nfm is nil.
func NewSpectrogramRecorder(nfm *NoiseFloorMonitor, config SpectrogramConfig) *SpectrogramRecorder {
	if !config.Enabled || nfm == nil {
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

	dbMin := float32(sr.config.DBMin)
	dbMax := float32(sr.config.DBMax)
	if dbMax <= dbMin {
		dbMax = dbMin + 70
	}

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
	for y, row := range snapshot {
		for x, val := range row {
			if math.IsInf(float64(val), -1) || math.IsNaN(float64(val)) {
				img.SetNRGBA(x, y, black)
			} else {
				img.SetNRGBA(x, y, viridisColour(val, dbMin, dbMax))
			}
		}
	}

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

// ─── Statistics helpers ───────────────────────────────────────────────────────

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

// handleSpectrogram serves the spectrogram PNG for a given UTC date.
//
//	GET /api/spectrogram          → today's in-progress PNG (from memory)
//	GET /api/spectrogram?date=YYYY-MM-DD → archived PNG for that date (from disk)
func handleSpectrogram(w http.ResponseWriter, r *http.Request, recorder *SpectrogramRecorder, rateLimiter *FFTRateLimiter, ipBanManager *IPBanManager) {
	if checkIPBan(w, r, ipBanManager) {
		return
	}

	if recorder == nil {
		http.Error(w, "spectrogram recording is not enabled", http.StatusServiceUnavailable)
		return
	}

	// Rate limit: 1 request per 10 seconds per IP (PNG is 1-3 MB)
	clientIP := getClientIP(r)
	if !rateLimiter.AllowRequest(clientIP, "spectrogram") {
		w.WriteHeader(http.StatusTooManyRequests)
		http.Error(w, "rate limit exceeded for spectrogram — please wait 10 seconds between requests", http.StatusTooManyRequests)
		return
	}

	today := time.Now().UTC().Format("2006-01-02")
	dateStr := r.URL.Query().Get("date")

	if dateStr == "" || dateStr == today {
		// Serve today's in-progress PNG from memory
		pngBytes := recorder.GetCachedPNG()
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

	// Serve archived PNG from disk (use re-formatted date to prevent path traversal)
	safeDateStr := requestedDate.Format("2006-01-02")
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
	}
	io.Copy(w, f)
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
func handleSpectrogramMeta(w http.ResponseWriter, r *http.Request, recorder *SpectrogramRecorder) {
	w.Header().Set("Content-Type", "application/json")

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
	} else {
		// Archived day — use JSONL row count; if JSONL missing, assume full day
		if rows == nil {
			rowCount = spectrogramMaxRows
		} else {
			rowCount = len(rows)
		}
		complete = true
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
		DBMin:              recorder.config.DBMin,
		DBMax:              recorder.config.DBMax,
		Palette:            "viridis",
		ImageURL:           imageURL,
		ListURL:            "/api/spectrogram/list",
		Complete:           complete,
		Rows:               rows,
	}

	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(meta)
}
