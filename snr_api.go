package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// /api/snr — on-demand SNR statistics for a frequency range, meant to be polled.
//
// It reads only the spectrum buffers the noise-floor monitor already keeps (60 s of
// samples per band channel and for the wideband channel), so it opens no radiod
// channel and keeps no history. A range that fits inside a monitored band is measured
// from that band's channel (~100-200 Hz bins); anything else is sliced from the
// wideband FFT (~7 kHz bins). The response names the source and bin width, because
// percentiles taken at different resolutions are not comparable.
//
// The figures match the KiwiSDR /snr emulation: SNR is p95 - p5 of the bins in range.

const (
	snrMaxAvgSec = 60               // the buffers keep 60 s of samples
	snrStaleAge  = 10 * time.Second // newest sample older than this → no data

	// snrMinBins is the fewest bins a range may cover. Any fewer and p5 and p95 are
	// just the min and max of a handful of bins. 10 still lets the narrowest
	// broadcast band (75m, 100 kHz) through on the ~7.3 kHz wideband bins.
	snrMinBins = 10
)

// snrBroadcastPresets are the ITU HF broadcast allocations plus LW and MW. Prefixed
// "bc" so they never collide with an amateur band name (both have a 60m).
var snrBroadcastPresets = []snrPreset{
	{Name: "bc-lw", LoHz: 148_500, HiHz: 283_500},
	{Name: "bc-mw", LoHz: 530_000, HiHz: 1_710_000},
	{Name: "bc120m", LoHz: 2_300_000, HiHz: 2_495_000},
	{Name: "bc90m", LoHz: 3_200_000, HiHz: 3_400_000},
	{Name: "bc75m", LoHz: 3_900_000, HiHz: 4_000_000},
	{Name: "bc60m", LoHz: 4_750_000, HiHz: 5_060_000},
	{Name: "bc49m", LoHz: 5_900_000, HiHz: 6_200_000},
	{Name: "bc41m", LoHz: 7_200_000, HiHz: 7_450_000},
	{Name: "bc31m", LoHz: 9_400_000, HiHz: 9_900_000},
	{Name: "bc25m", LoHz: 11_600_000, HiHz: 12_100_000},
	{Name: "bc22m", LoHz: 13_570_000, HiHz: 13_870_000},
	{Name: "bc19m", LoHz: 15_100_000, HiHz: 15_830_000},
	{Name: "bc16m", LoHz: 17_480_000, HiHz: 17_900_000},
	{Name: "bc15m", LoHz: 18_900_000, HiHz: 19_020_000},
	{Name: "bc13m", LoHz: 21_450_000, HiHz: 21_850_000},
	{Name: "bc11m", LoHz: 25_670_000, HiHz: 26_100_000},
}

// snrWidePresets match the two published wideband SNR figures (widebandSNRBands).
var snrWidePresets = []snrPreset{
	{Name: "all", LoHz: 0, HiHz: 30_000_000},
	{Name: "hf", LoHz: 1_800_000, HiHz: 30_000_000},
}

type snrPreset struct {
	Name string `json:"name"`
	LoHz uint64 `json:"-"`
	HiHz uint64 `json:"-"`
}

// snrSourceBand is the part of a monitored band snrResolveSource needs.
type snrSourceBand struct {
	Name     string
	StartHz  uint64
	EndHz    uint64
	BinWidth float64
}

// snrResolveSource picks the buffer to measure [loHz, hiHz] from: the narrowest
// monitored band containing the whole range, else the wideband buffer when the
// range lies inside it. Returns "" when nothing covers the range.
func snrResolveSource(loHz, hiHz uint64, bands []snrSourceBand, widebandEndHz uint64) string {
	best := ""
	bestWidth := uint64(math.MaxUint64)
	for _, b := range bands {
		if b.EndHz <= b.StartHz || loHz < b.StartHz || hiHz > b.EndHz {
			continue
		}
		if w := b.EndHz - b.StartHz; w < bestWidth {
			best, bestWidth = b.Name, w
		}
	}
	if best != "" {
		return best
	}
	if widebandEndHz > 0 && hiHz <= widebandEndHz {
		return "wideband"
	}
	return ""
}

// snrBinRange maps [loHz, hiHz] onto bin indices [start, end) of a buffer whose
// nBins bins evenly span [startHz, endHz]. Same mapping as calculateFT8SNR.
func snrBinRange(loHz, hiHz, startHz, endHz uint64, nBins int) (int, int) {
	if endHz <= startHz || nBins == 0 {
		return 0, 0
	}
	binsPerHz := float64(nBins) / float64(endHz-startHz)
	start := int(math.Floor((float64(loHz) - float64(startHz)) * binsPerHz))
	end := int(math.Ceil((float64(hiHz) - float64(startHz)) * binsPerHz))
	if start < 0 {
		start = 0
	}
	if end > nBins {
		end = nBins
	}
	if end < start {
		end = start
	}
	return start, end
}

// SNRStats is one /api/snr reading.
type SNRStats struct {
	Range        string    `json:"range,omitempty"`
	LoKHz        float64   `json:"lo_khz"`
	HiKHz        float64   `json:"hi_khz"`
	Source       string    `json:"source"`
	BinWidthHz   float64   `json:"bin_width_hz"`
	Bins         int       `json:"bins"`
	AvgSec       int       `json:"avg_sec"`
	Samples      int       `json:"samples"`
	Timestamp    time.Time `json:"timestamp"`
	MinDB        float32   `json:"min_db"`
	MaxDB        float32   `json:"max_db"`
	MeanDB       float32   `json:"mean_db"`
	P5DB         float32   `json:"p5_db"`
	P10DB        float32   `json:"p10_db"`
	P50DB        float32   `json:"p50_db"`
	P95DB        float32   `json:"p95_db"`
	SNRDB        float32   `json:"snr_db"`
	OccupancyPct float32   `json:"occupancy_pct"`
}

// snrComputeStats measures bins [start, end) of buf. avgSec 0 uses the newest sample
// alone; otherwise every sample within avgSec of the newest is averaged in the linear
// power domain, as GetAveragedFFT does, but over the requested bins only. The window
// is anchored on the newest sample rather than on now, so poll jitter between the
// ingest goroutine and the caller can never leave it empty.
func snrComputeStats(buf *FFTBuffer, start, end, avgSec int) (*SNRStats, error) {
	if len(buf.Samples) == 0 {
		return nil, fmt.Errorf("no spectrum samples yet")
	}
	newest := buf.Samples[len(buf.Samples)-1]
	if start < 0 || end > len(newest.Data) || start >= end {
		return nil, fmt.Errorf("range covers no bins")
	}

	cutoff := newest.Timestamp.Add(-time.Duration(avgSec) * time.Second)
	n := end - start
	linearSum := make([]float64, n)
	count := 0
	for i := len(buf.Samples) - 1; i >= 0; i-- {
		s := buf.Samples[i]
		if count > 0 && s.Timestamp.Before(cutoff) {
			break
		}
		if len(s.Data) != len(newest.Data) {
			continue
		}
		for j, v := range s.Data[start:end] {
			linearSum[j] += math.Pow(10, float64(v)/10)
		}
		count++
		if avgSec == 0 {
			break
		}
	}

	data := make([]float32, n)
	var sum float64
	for j := range data {
		data[j] = float32(10 * math.Log10(linearSum[j]/float64(count)))
		sum += float64(data[j])
	}
	sorted := make([]float32, n)
	copy(sorted, data)
	sort.Slice(sorted, func(a, b int) bool { return sorted[a] < sorted[b] })

	st := &SNRStats{
		BinWidthHz: buf.BinWidth,
		Bins:       n,
		AvgSec:     avgSec,
		Samples:    count,
		Timestamp:  newest.Timestamp.UTC(),
		MinDB:      sorted[0],
		MaxDB:      sorted[n-1],
		MeanDB:     float32(sum / float64(n)),
		P5DB:       sorted[n*5/100],
		P10DB:      sorted[n*10/100],
		P50DB:      sorted[n*50/100],
		P95DB:      sorted[n*95/100],
	}
	st.SNRDB = st.P95DB - st.P5DB
	threshold := st.P5DB + 10
	above := 0
	for _, v := range data {
		if v > threshold {
			above++
		}
	}
	st.OccupancyPct = float32(above) * 100 / float32(n)
	return st, nil
}

// snrCache shares one computation between every caller asking for the same bins and
// window within one background poll period — the underlying buffer cannot have
// changed in that time, so recomputing would only repeat the same answer.
type snrCache struct {
	mu      sync.Mutex
	entries map[string]snrCacheEntry
}

type snrCacheEntry struct {
	at    time.Time
	stats SNRStats
}

var snrResultCache = &snrCache{entries: make(map[string]snrCacheEntry)}

func (c *snrCache) get(key string, ttl time.Duration) (SNRStats, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Since(e.at) >= ttl {
		return SNRStats{}, false
	}
	return e.stats, true
}

// put stores a result and drops expired ones, so the map only ever holds the
// ranges asked for in the last tick.
func (c *snrCache) put(key string, st SNRStats, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, e := range c.entries {
		if now.Sub(e.at) >= ttl {
			delete(c.entries, k)
		}
	}
	c.entries[key] = snrCacheEntry{at: now, stats: st}
}

// snrSourceBands lists the monitored bands as snrResolveSource sees them.
func (nfm *NoiseFloorMonitor) snrSourceBands() []snrSourceBand {
	bands := make([]snrSourceBand, 0, len(nfm.config.NoiseFloor.Bands))
	for _, b := range nfm.config.NoiseFloor.Bands {
		bands = append(bands, snrSourceBand{Name: b.Name, StartHz: b.Start, EndHz: b.End, BinWidth: b.BinBandwidth})
	}
	return bands
}

// snrBufferSnapshot snapshots the named band buffer, or the wideband buffer.
func (nfm *NoiseFloorMonitor) snrBufferSnapshot(source string) *FFTBuffer {
	if source != "wideband" {
		buf, _ := nfm.fftBufferSnapshot(source)
		return buf
	}
	nfm.fftMu.RLock()
	defer nfm.fftMu.RUnlock()
	if nfm.wideBandFFTBuffer == nil {
		return nil
	}
	return nfm.wideBandFFTBuffer.snapshot()
}

// snrPresets returns every named range: the monitored amateur bands (whole channel),
// the broadcast bands, and all/hf.
func (nfm *NoiseFloorMonitor) snrPresets() []snrPreset {
	presets := make([]snrPreset, 0, len(nfm.config.NoiseFloor.Bands)+len(snrBroadcastPresets)+len(snrWidePresets))
	for _, b := range nfm.config.NoiseFloor.Bands {
		presets = append(presets, snrPreset{Name: b.Name, LoHz: b.Start, HiHz: b.End})
	}
	presets = append(presets, snrBroadcastPresets...)
	return append(presets, snrWidePresets...)
}

func snrWriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func snrError(w http.ResponseWriter, status int, msg string) {
	snrWriteJSON(w, status, map[string]string{"error": msg})
}

// snrMaxKHz bounds lo/hi before they are converted to Hz, so no input can overflow
// the conversion. The real limit is the receiver's coverage, checked afterwards.
const snrMaxKHz = 1_000_000

// snrAllowedParams are the only query parameters /api/snr accepts; anything else is
// rejected so a typo (lo_khz, average) fails loudly instead of being ignored.
var snrAllowedParams = map[string]bool{"range": true, "lo": true, "hi": true, "avg": true}

// parseKHz parses a kHz value in [0, snrMaxKHz] into Hz.
func parseKHz(s string) (uint64, error) {
	if s == "" || len(s) > 16 {
		return 0, fmt.Errorf("invalid frequency")
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || f < 0 || f > snrMaxKHz {
		return 0, fmt.Errorf("invalid frequency")
	}
	return uint64(math.Round(f * 1000)), nil
}

// snrParseRequest validates the query and returns the range name (empty for lo/hi),
// its bounds in Hz, and the averaging window. Coverage is checked by the caller.
func snrParseRequest(q url.Values, presets []snrPreset) (name string, loHz, hiHz uint64, avgSec int, err error) {
	for k, v := range q {
		if !snrAllowedParams[k] {
			return "", 0, 0, 0, fmt.Errorf("unknown parameter %q; accepted: range, lo, hi, avg", truncateForError(k))
		}
		if len(v) != 1 {
			return "", 0, 0, 0, fmt.Errorf("parameter %q given more than once", k)
		}
	}

	if s, ok := q["avg"]; ok {
		v, convErr := strconv.Atoi(s[0])
		if convErr != nil || v < 0 || v > snrMaxAvgSec {
			return "", 0, 0, 0, fmt.Errorf("avg must be a whole number of seconds from 0 to %d", snrMaxAvgSec)
		}
		avgSec = v
	}

	_, hasRange := q["range"]
	_, hasLo := q["lo"]
	_, hasHi := q["hi"]
	switch {
	case hasRange && (hasLo || hasHi):
		return "", 0, 0, 0, fmt.Errorf("give either range or lo/hi, not both")
	case hasRange:
		want := q.Get("range")
		for _, p := range presets {
			if strings.EqualFold(p.Name, want) {
				return p.Name, p.LoHz, p.HiHz, avgSec, nil
			}
		}
		return "", 0, 0, 0, fmt.Errorf("unknown range %q; see /api/snr/ranges", truncateForError(want))
	case hasLo && hasHi:
		lo, errLo := parseKHz(q.Get("lo"))
		hi, errHi := parseKHz(q.Get("hi"))
		if errLo != nil || errHi != nil {
			return "", 0, 0, 0, fmt.Errorf("lo and hi must be frequencies in kHz from 0 to %d", snrMaxKHz)
		}
		if hi <= lo {
			return "", 0, 0, 0, fmt.Errorf("hi must be above lo")
		}
		return "", lo, hi, avgSec, nil
	default:
		return "", 0, 0, 0, fmt.Errorf("give range=<name> or lo=<kHz>&hi=<kHz>")
	}
}

// truncateForError keeps client-supplied text echoed in an error message short.
func truncateForError(s string) string {
	if len(s) > 32 {
		return s[:32] + "..."
	}
	return s
}

// handleSNR serves GET /api/snr?range=<preset> or ?lo=<kHz>&hi=<kHz>, with an
// optional &avg=<seconds> (0-60, default 0 = newest sample only).
func handleSNR(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager, rateLimiter *FFTRateLimiter) {
	if checkIPBan(w, r, ipBanManager) {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		snrError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if nfm == nil {
		snrError(w, http.StatusServiceUnavailable, "noise floor monitoring is not enabled")
		return
	}
	if !rateLimiter.AllowRequest(getClientIP(r), "snr") {
		snrError(w, http.StatusTooManyRequests, "rate limit exceeded: at most 4 requests per second")
		return
	}

	name, loHz, hiHz, avgSec, err := snrParseRequest(r.URL.Query(), nfm.snrPresets())
	if err != nil {
		snrError(w, http.StatusBadRequest, err.Error())
		return
	}

	var widebandEnd uint64
	nfm.fftMu.RLock()
	if nfm.wideBandFFTBuffer != nil {
		widebandEnd = nfm.wideBandFFTBuffer.EndFreq
	}
	nfm.fftMu.RUnlock()

	source := snrResolveSource(loHz, hiHz, nfm.snrSourceBands(), widebandEnd)
	if source == "" {
		snrError(w, http.StatusBadRequest, "range is outside the receiver's coverage")
		return
	}

	ttl := time.Duration(nfm.config.Spectrum.BackgroundPollPeriodMs) * time.Millisecond
	if ttl <= 0 {
		ttl = time.Second
	}
	key := fmt.Sprintf("%s|%d|%d|%d", source, loHz, hiHz, avgSec)
	st, ok := snrResultCache.get(key, ttl)
	if !ok {
		buf := nfm.snrBufferSnapshot(source)
		if buf == nil || len(buf.Samples) == 0 {
			snrError(w, http.StatusServiceUnavailable, "no spectrum data yet")
			return
		}
		start, end := snrBinRange(loHz, hiHz, buf.StartFreq, buf.EndFreq, len(buf.Samples[len(buf.Samples)-1].Data))
		if end-start < snrMinBins {
			snrError(w, http.StatusBadRequest, fmt.Sprintf("range is too narrow: it covers %d bins of %.0f Hz on %s, at least %d are needed",
				end-start, buf.BinWidth, source, snrMinBins))
			return
		}
		computed, err := snrComputeStats(buf, start, end, avgSec)
		if err != nil {
			snrError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		st = *computed
		st.Source = source
		snrResultCache.put(key, st, ttl)
	}

	if time.Since(st.Timestamp) > snrStaleAge {
		snrError(w, http.StatusServiceUnavailable, "spectrum data is stale")
		return
	}
	st.Range = name
	st.LoKHz = float64(loHz) / 1000
	st.HiKHz = float64(hiHz) / 1000
	snrWriteJSON(w, http.StatusOK, st)
}

// handleSNRRanges serves GET /api/snr/ranges: every preset with its span, and the
// source and bin width it would be measured from.
func handleSNRRanges(w http.ResponseWriter, r *http.Request, nfm *NoiseFloorMonitor, ipBanManager *IPBanManager) {
	if checkIPBan(w, r, ipBanManager) {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		snrError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if nfm == nil {
		snrError(w, http.StatusServiceUnavailable, "noise floor monitoring is not enabled")
		return
	}

	var widebandEnd uint64
	var widebandBinWidth float64
	nfm.fftMu.RLock()
	if nfm.wideBandFFTBuffer != nil {
		widebandEnd = nfm.wideBandFFTBuffer.EndFreq
		widebandBinWidth = nfm.wideBandFFTBuffer.BinWidth
	}
	nfm.fftMu.RUnlock()

	bands := nfm.snrSourceBands()
	type rangeInfo struct {
		Name       string  `json:"name"`
		LoKHz      float64 `json:"lo_khz"`
		HiKHz      float64 `json:"hi_khz"`
		Source     string  `json:"source"`
		BinWidthHz float64 `json:"bin_width_hz"`
	}
	out := make([]rangeInfo, 0)
	for _, p := range nfm.snrPresets() {
		source := snrResolveSource(p.LoHz, p.HiHz, bands, widebandEnd)
		if source == "" {
			continue
		}
		binWidth := widebandBinWidth
		for _, b := range bands {
			if b.Name == source {
				binWidth = b.BinWidth
			}
		}
		out = append(out, rangeInfo{
			Name: p.Name, LoKHz: float64(p.LoHz) / 1000, HiKHz: float64(p.HiHz) / 1000,
			Source: source, BinWidthHz: binWidth,
		})
	}
	snrWriteJSON(w, http.StatusOK, out)
}
