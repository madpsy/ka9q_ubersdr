package main

// whisper_gpu_stats.go — periodic poll of the GPU statistics endpoint exposed
// alongside the WhisperLive server.
//
// The endpoint (whisper.gpu_stats, default http://localhost:8568/gpu) reports
// nvidia-smi style figures for the machine doing the transcription. Polling is
// deliberately quiet: a missing or broken endpoint is the normal case on a CPU
// or OpenVINO box, so failures are never logged — GetGPUStats simply reports
// nothing available. Only 200 responses are parsed.
//
// The poll rate adapts: 10 s while the endpoint is answering (worth the detail,
// since it is what the graphs are made of), backing off to 60 s the moment it
// stops. A host with no GPU stats service therefore costs one request a minute
// forever, while a working one is sampled finely.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"math"
	"net/http"
	"sync"
	"time"
)

// DefaultWhisperGPUStatsURL is used when whisper.gpu_stats is absent from
// config. Set the key to "" to disable polling entirely.
const DefaultWhisperGPUStatsURL = "http://localhost:8568/gpu"

// Poll intervals. The fast rate applies after a 200, the slow rate after any
// failure, so an endpoint that is not there is barely touched while a live one
// gives six samples a minute to average over.
const (
	gpuStatsFastInterval = 10 * time.Second
	gpuStatsSlowInterval = 1 * time.Minute
)

// gpuStatsMaxBody caps the response body read. The payload is a few hundred
// bytes per GPU; 1 MB is a generous ceiling that still bounds a misbehaving
// endpoint.
const gpuStatsMaxBody = 1 << 20

// gpuStatsMaxAge is how long a successful sample stays usable. A GPU host that
// stops answering should stop being reported rather than freezing its last
// reading forever, but a single missed poll must not blank the display.
const gpuStatsMaxAge = 5 * time.Minute

// GPUStats is the decoded /gpu payload.
//
// Numeric fields that nvidia-smi can report as "N/A" (and which the endpoint
// then emits as null) are pointers so "unknown" is distinguishable from zero —
// power.draw is null on the GTX 1650, for instance, which is not the same as
// drawing no power.
type GPUStats struct {
	Timestamp     string `json:"timestamp"`
	DriverVersion string `json:"driver_version"`
	GPUCount      int    `json:"gpu_count"`
	GPUs          []GPU  `json:"gpus"`

	// Processes is left untyped: the endpoint's per-process shape is not part
	// of the contract we rely on, and keeping it as maps loses nothing.
	Processes []map[string]interface{} `json:"processes"`

	MemoryUnits      string `json:"memory_units"`
	PowerUnits       string `json:"power_units"`
	TemperatureUnits string `json:"temperature_units"`
}

// GPU is one entry of GPUStats.GPUs.
type GPU struct {
	Index         int    `json:"index"`
	Name          string `json:"name"`
	UUID          string `json:"uuid"`
	DriverVersion string `json:"driver_version"`
	PState        string `json:"pstate"`
	ComputeMode   string `json:"compute_mode"`

	TemperatureGPU    *float64 `json:"temperature.gpu"`
	UtilizationGPU    *float64 `json:"utilization.gpu"`
	UtilizationMemory *float64 `json:"utilization.memory"`

	MemoryTotal       *float64 `json:"memory.total"`
	MemoryUsed        *float64 `json:"memory.used"`
	MemoryFree        *float64 `json:"memory.free"`
	MemoryUsedPercent *float64 `json:"memory.used_percent"`

	PowerDraw  *float64 `json:"power.draw"`
	PowerLimit *float64 `json:"power.limit"`
	FanSpeed   *float64 `json:"fan.speed"`

	ClocksCurrentSM     *float64 `json:"clocks.current.sm"`
	ClocksCurrentMemory *float64 `json:"clocks.current.memory"`
}

// GPUStatsMonitor polls the GPU statistics endpoint and caches the last good
// sample. All methods are safe on a nil receiver, so callers that never
// constructed one (whisper disabled) need no nil checks.
type GPUStatsMonitor struct {
	url    string
	client *http.Client

	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.RWMutex
	stats     *GPUStats
	raw       json.RawMessage
	fetchedAt time.Time

	// In-memory history, same three tiers as LoadHistoryTracker: raw samples for
	// the minute in progress, minute means for the 60-minute chart, hour means
	// for the 24-hour chart. Nothing is persisted — a restart legitimately
	// starts the graphs over.
	historyMu     sync.RWMutex
	samples       []GPUHistoryEntry // this minute's polls (6 at the fast rate)
	history       []GPUHistoryEntry // up to 60 minute means
	hourlyHistory []GPUHistoryEntry // up to 24 hour means
}

// GPUHistoryEntry is one minute (or one hour) of GPU metrics, averaged across
// every GPU that reported the field.
//
// Pointers, not sentinels: 0% utilisation and 0°C are legitimate readings, so
// "no data" has to be distinguishable. Absent metrics marshal to null and the
// charts span the gap rather than plotting a dip to zero.
type GPUHistoryEntry struct {
	UtilizationGPU    *float64  `json:"utilization_gpu"`     // %
	MemoryUsedPercent *float64  `json:"memory_used_percent"` // %
	FanSpeed          *float64  `json:"fan_speed"`           // %
	TemperatureC      *float64  `json:"temperature_c"`       // °C
	GPUCount          int       `json:"gpu_count"`
	Timestamp         time.Time `json:"timestamp"`
}

// gpuHistoryMinutes / gpuHistoryHours bound the two rings, matching the system
// load charts: 60 minutes and 24 hours. gpuHistorySamples is a safety cap on
// the in-progress minute — the fast rate yields 6, so anything near this ceiling
// means aggregation has stalled.
const (
	gpuHistorySamples = 60
	gpuHistoryMinutes = 60
	gpuHistoryHours   = 24
)

// globalGPUStats is the singleton set by main at startup, so handlers that are
// not threaded the monitor explicitly (the admin system-load endpoint) can read
// the cached sample. Nil when GPU stats polling is off, which every method
// tolerates.
var globalGPUStats *GPUStatsMonitor

// NewGPUStatsMonitor creates a monitor for url. Returns nil when url is empty,
// which is the "feature off" case.
func NewGPUStatsMonitor(url string) *GPUStatsMonitor {
	if url == "" {
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	return &GPUStatsMonitor{
		url:    url,
		client: &http.Client{Timeout: 10 * time.Second},
		ctx:    ctx,
		cancel: cancel,
	}
}

// Start fetches once immediately and then keeps polling, at the fast rate while
// the endpoint answers and the slow rate while it does not.
func (g *GPUStatsMonitor) Start() {
	if g == nil {
		return
	}

	log.Printf("Starting whisper GPU stats poller (%s, every %s while answering, %s otherwise)",
		g.url, gpuStatsFastInterval, gpuStatsSlowInterval)

	go func() {
		timer := time.NewTimer(0)
		defer timer.Stop()

		for {
			select {
			case <-g.ctx.Done():
				return
			case <-timer.C:
			}

			// Rate follows the last outcome: a 200 earns the fast rate, anything
			// else drops straight back to the slow one. No hysteresis — a single
			// good response is enough to resume detailed sampling.
			if g.fetch() {
				timer.Reset(gpuStatsFastInterval)
			} else {
				timer.Reset(gpuStatsSlowInterval)
			}
		}
	}()

	// Fold this minute's samples into a minute mean, every minute.
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-g.ctx.Done():
				return
			case <-ticker.C:
				g.aggregateMinute()
			}
		}
	}()

	// Roll the minute entries up into an hour mean, on the hour.
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-g.ctx.Done():
				return
			case <-ticker.C:
				g.aggregateHour()
			}
		}
	}()
}

// Stop ends the polling loop.
func (g *GPUStatsMonitor) Stop() {
	if g == nil || g.cancel == nil {
		return
	}
	g.cancel()
}

// fetch retrieves one sample and reports whether it was usable, which is what
// drives the poll rate. Every failure path is silent by design: the endpoint is
// optional and a noisy log on a CPU-only host would be worse than useless. The
// previous sample is left untouched on failure and ages out via gpuStatsMaxAge.
func (g *GPUStatsMonitor) fetch() bool {
	req, err := http.NewRequestWithContext(g.ctx, http.MethodGet, g.url, nil)
	if err != nil {
		return false
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	// Anything other than 200 is not a payload — don't parse it.
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, gpuStatsMaxBody))
		return false
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, gpuStatsMaxBody))
	if err != nil {
		return false
	}

	var stats GPUStats
	if err := json.Unmarshal(body, &stats); err != nil {
		return false
	}

	now := time.Now()

	g.mu.Lock()
	g.stats = &stats
	g.raw = json.RawMessage(body)
	g.fetchedAt = now
	g.mu.Unlock()

	g.recordSample(&stats, now)
	return true
}

// recordSample adds one poll to the minute in progress, averaging each metric
// across the GPUs that reported it. A single-GPU host — the normal case —
// therefore charts that GPU's own numbers.
func (g *GPUStatsMonitor) recordSample(stats *GPUStats, at time.Time) {
	if len(stats.GPUs) == 0 {
		return
	}

	var util, mem, fan, temp gpuMean
	for i := range stats.GPUs {
		gpu := &stats.GPUs[i]
		util.add(gpu.UtilizationGPU)
		fan.add(gpu.FanSpeed)
		temp.add(gpu.TemperatureGPU)

		// Prefer the endpoint's own percentage; fall back to used/total for
		// endpoints that report the raw figures but not the ratio.
		if gpu.MemoryUsedPercent != nil {
			mem.add(gpu.MemoryUsedPercent)
		} else if gpu.MemoryUsed != nil && gpu.MemoryTotal != nil && *gpu.MemoryTotal > 0 {
			pct := (*gpu.MemoryUsed / *gpu.MemoryTotal) * 100
			mem.add(&pct)
		}
	}

	entry := GPUHistoryEntry{
		UtilizationGPU:    util.mean(1),
		MemoryUsedPercent: mem.mean(1),
		FanSpeed:          fan.mean(1),
		TemperatureC:      temp.mean(0),
		GPUCount:          len(stats.GPUs),
		Timestamp:         at,
	}

	g.historyMu.Lock()
	defer g.historyMu.Unlock()

	g.samples = append(g.samples, entry)
	if len(g.samples) > gpuHistorySamples {
		g.samples = g.samples[len(g.samples)-gpuHistorySamples:]
	}
}

// aggregateMinute folds this minute's samples into one minute mean and clears
// them. A minute in which every poll failed contributes no entry at all, so the
// charts show a gap rather than a flat line through an outage.
func (g *GPUStatsMonitor) aggregateMinute() {
	g.historyMu.Lock()
	defer g.historyMu.Unlock()

	entry, ok := meanOfEntries(g.samples, time.Now())
	if !ok {
		return
	}
	g.samples = g.samples[:0]

	g.history = append(g.history, entry)
	if len(g.history) > gpuHistoryMinutes {
		g.history = g.history[len(g.history)-gpuHistoryMinutes:]
	}
}

// aggregateHour folds the retained minute entries into one hour mean. Called
// hourly; a no-op until at least one minute entry exists.
func (g *GPUStatsMonitor) aggregateHour() {
	g.historyMu.Lock()
	defer g.historyMu.Unlock()

	entry, ok := meanOfEntries(g.history, time.Now())
	if !ok {
		return
	}

	g.hourlyHistory = append(g.hourlyHistory, entry)
	if len(g.hourlyHistory) > gpuHistoryHours {
		g.hourlyHistory = g.hourlyHistory[len(g.hourlyHistory)-gpuHistoryHours:]
	}
}

// gpuMean accumulates the values that were actually present, so a metric no card
// reports (fan speed on a passively cooled card) stays null instead of averaging
// to zero.
type gpuMean struct {
	sum   float64
	count int
}

func (m *gpuMean) add(v *float64) {
	if v == nil {
		return
	}
	m.sum += *v
	m.count++
}

// mean returns the average rounded to the given number of decimals, or nil when
// nothing was recorded.
func (m *gpuMean) mean(decimals int) *float64 {
	if m.count == 0 {
		return nil
	}
	scale := math.Pow(10, float64(decimals))
	v := math.Round((m.sum/float64(m.count))*scale) / scale
	return &v
}

// meanOfEntries averages a run of history entries into one, carrying the largest
// GPU count seen. Returns ok=false for an empty run.
func meanOfEntries(entries []GPUHistoryEntry, at time.Time) (GPUHistoryEntry, bool) {
	if len(entries) == 0 {
		return GPUHistoryEntry{}, false
	}

	var util, mem, fan, temp gpuMean
	gpuCount := 0
	for _, e := range entries {
		util.add(e.UtilizationGPU)
		mem.add(e.MemoryUsedPercent)
		fan.add(e.FanSpeed)
		temp.add(e.TemperatureC)
		if e.GPUCount > gpuCount {
			gpuCount = e.GPUCount
		}
	}

	return GPUHistoryEntry{
		UtilizationGPU:    util.mean(1),
		MemoryUsedPercent: mem.mean(1),
		FanSpeed:          fan.mean(1),
		TemperatureC:      temp.mean(0),
		GPUCount:          gpuCount,
		Timestamp:         at,
	}, true
}

// GetHistory returns up to 60 minute entries, oldest first, plus a partial entry
// for the minute in progress. Without the partial entry the 60-minute chart
// would stay empty for the first minute after a restart.
func (g *GPUStatsMonitor) GetHistory() []GPUHistoryEntry {
	if g == nil {
		return nil
	}

	g.historyMu.RLock()
	defer g.historyMu.RUnlock()

	// Entries are immutable once appended, so copying the slice header's
	// contents is enough — no deep copy of the pointer fields is needed.
	out := make([]GPUHistoryEntry, len(g.history))
	copy(out, g.history)

	if partial, ok := meanOfEntries(g.samples, time.Now()); ok {
		out = append(out, partial)
		if len(out) > gpuHistoryMinutes {
			out = out[len(out)-gpuHistoryMinutes:]
		}
	}

	return out
}

// GetHourlyHistory returns up to 24 hour entries, oldest first, with a partial
// entry for the hour in progress appended from the retained minute data (plus
// the minute still being collected). The partial entry is what makes the
// 24-hour chart show something before the server has been up a full hour.
func (g *GPUStatsMonitor) GetHourlyHistory() []GPUHistoryEntry {
	if g == nil {
		return nil
	}

	g.historyMu.RLock()
	defer g.historyMu.RUnlock()

	out := make([]GPUHistoryEntry, len(g.hourlyHistory))
	copy(out, g.hourlyHistory)

	// Mean over complete minutes plus the in-progress one. Weighting every
	// minute equally is what the completed-hour rollup does too, so the partial
	// entry does not jump when it is finalised.
	partialSource := g.history
	if partial, ok := meanOfEntries(g.samples, time.Now()); ok {
		partialSource = append(append([]GPUHistoryEntry(nil), g.history...), partial)
	}

	if partial, ok := meanOfEntries(partialSource, time.Now()); ok {
		out = append(out, partial)
		if len(out) > gpuHistoryHours {
			out = out[len(out)-gpuHistoryHours:]
		}
	}

	return out
}

// GetGPUStats returns the last successful sample and when it was taken, or
// (nil, zero time) when nothing usable is cached — never polled, every poll
// failed, or the last success is older than gpuStatsMaxAge.
func (g *GPUStatsMonitor) GetGPUStats() (*GPUStats, time.Time) {
	if g == nil {
		return nil, time.Time{}
	}

	g.mu.RLock()
	defer g.mu.RUnlock()

	if g.stats == nil || time.Since(g.fetchedAt) > gpuStatsMaxAge {
		return nil, time.Time{}
	}

	// Copy the struct so callers cannot mutate the cache. The slices inside are
	// replaced wholesale by each fetch and never written in place, so sharing
	// their backing arrays is safe.
	statsCopy := *g.stats
	return &statsCopy, g.fetchedAt
}

// GetGPUStatsRaw returns the raw JSON body of the last successful sample, for
// callers that want to pass it through verbatim (an API proxy, say) rather than
// work with the decoded struct. Nil when nothing usable is cached.
func (g *GPUStatsMonitor) GetGPUStatsRaw() (json.RawMessage, time.Time) {
	if g == nil {
		return nil, time.Time{}
	}

	g.mu.RLock()
	defer g.mu.RUnlock()

	if g.raw == nil || time.Since(g.fetchedAt) > gpuStatsMaxAge {
		return nil, time.Time{}
	}
	return g.raw, g.fetchedAt
}

// Available reports whether a usable sample is cached.
func (g *GPUStatsMonitor) Available() bool {
	stats, _ := g.GetGPUStats()
	return stats != nil
}
