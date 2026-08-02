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
// Nothing consumes this yet; it exists so the data (parsed and raw) is on hand
// for the admin UI / API / MCP later.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

// DefaultWhisperGPUStatsURL is used when whisper.gpu_stats is absent from
// config. Set the key to "" to disable polling entirely.
const DefaultWhisperGPUStatsURL = "http://localhost:8568/gpu"

// gpuStatsPollInterval is how often the endpoint is polled.
const gpuStatsPollInterval = 1 * time.Minute

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
}

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

// Start fetches once immediately and then every gpuStatsPollInterval.
func (g *GPUStatsMonitor) Start() {
	if g == nil {
		return
	}

	log.Printf("Starting whisper GPU stats poller (%s, every %s)", g.url, gpuStatsPollInterval)

	go func() {
		g.fetch()

		ticker := time.NewTicker(gpuStatsPollInterval)
		defer ticker.Stop()

		for {
			select {
			case <-g.ctx.Done():
				return
			case <-ticker.C:
				g.fetch()
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

// fetch retrieves one sample. Every failure path is silent by design: the
// endpoint is optional and a noisy log every minute on a CPU-only host would be
// worse than useless. The previous sample is left untouched on failure and ages
// out via gpuStatsMaxAge.
func (g *GPUStatsMonitor) fetch() {
	req, err := http.NewRequestWithContext(g.ctx, http.MethodGet, g.url, nil)
	if err != nil {
		return
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	// Anything other than 200 is not a payload — don't parse it.
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, gpuStatsMaxBody))
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, gpuStatsMaxBody))
	if err != nil {
		return
	}

	var stats GPUStats
	if err := json.Unmarshal(body, &stats); err != nil {
		return
	}

	g.mu.Lock()
	g.stats = &stats
	g.raw = json.RawMessage(body)
	g.fetchedAt = time.Now()
	g.mu.Unlock()
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
