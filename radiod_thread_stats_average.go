package main

// Averaging radiod's per-thread CPU figures over time.
//
// thread-stats.py samples /proc/<pid>/task/<tid>/stat twice across a 2-second window
// and reports the utime+stime difference. CLK_TCK is 100 on every Linux that matters,
// so a 2-second window holds 200 jiffies and ONE jiffy is 0.5% of a core. Every reading
// is therefore rounded to a multiple of 0.5%, whatever the thread is really doing.
//
// That is not a rounding nicety on this scale. A noise-floor band costing 1.2% of a core
// reads as 1.0% or 1.5% depending on where the tick boundary happens to fall -- ±20% of
// the value -- and two channels configured identically routinely differ by a whole tick.
// It makes the measured column unusable for the one thing it is there for: checking the
// cost model, and calibrating it.
//
// The fix is free: the CSV is rewritten every ~2 seconds with an independent window, and
// the tick boundary lands in an uncorrelated place each time. Averaging N of them pulls
// the quantisation error down as 1/sqrt(N) -- 30 samples takes 0.5% steps to under 0.1%
// of a core -- while measuring exactly the same quantity. Nothing else changes: no
// change to radiod, no change to the sampler, no extra load beyond re-reading a small
// file that is being written anyway.

import (
	"os"
	"sync"
	"time"
)

const (
	// threadStatsPollInterval is how often the CSV is checked. The file is replaced
	// roughly every 2 seconds; polling faster than that costs a stat() and finds
	// nothing new, which is cheaper than missing samples when the writer drifts.
	threadStatsPollInterval = time.Second

	// threadStatsWindow is how many samples are averaged, ~1 minute at the writer's
	// 2-second cadence. Long enough to bury the jiffy, short enough that adding a
	// band shows up in the column while the operator is still looking at it.
	threadStatsWindow = 30

	// threadStatsMinSamples is how many samples must have accumulated before the
	// average is offered as better than the latest raw reading. Below this the mean
	// is quantised almost as coarsely as one sample, and pretending otherwise would
	// invite exactly the false precision this exists to remove.
	threadStatsMinSamples = 4
)

// threadStatsAverager keeps a rolling mean of each radiod thread's CPU percentage.
//
// Keyed by thread name, like the CSV itself: SSRC attribution happens above this, and a
// thread that goes away simply stops being refreshed until it ages out of the window.
type threadStatsAverager struct {
	mu   sync.Mutex
	hist map[string]*threadStatHistory

	// lastSample identifies the CSV generation already counted, so a file read twice
	// between writer cycles does not enter the mean twice and make it look
	// artificially steady. Modification time is what os.replace() gives us to work
	// with; size breaks a tie when two writes land inside one timestamp tick.
	lastModTime time.Time
	lastSize    int64
	started     bool
}

// threadStatHistory is one thread's ring of recent readings.
type threadStatHistory struct {
	vals   [threadStatsWindow]float64
	idx    int
	n      int // how many of vals are populated, up to threadStatsWindow
	sum    float64
	cpuNum int // the core it was last seen on; instantaneous by nature
	fresh  bool
}

func (h *threadStatHistory) add(pct float64, cpuNum int) {
	if h.n == threadStatsWindow {
		h.sum -= h.vals[h.idx]
	} else {
		h.n++
	}
	h.vals[h.idx] = pct
	h.sum += pct
	h.idx = (h.idx + 1) % threadStatsWindow
	h.cpuNum = cpuNum
	h.fresh = true
}

func (h *threadStatHistory) mean() float64 {
	if h.n == 0 {
		return 0
	}
	return h.sum / float64(h.n)
}

// globalThreadStats is the singleton, started at boot from main.
var globalThreadStats = &threadStatsAverager{hist: map[string]*threadStatHistory{}}

// Start begins sampling in the background. Safe to call more than once.
func (a *threadStatsAverager) Start() {
	a.mu.Lock()
	if a.started {
		a.mu.Unlock()
		return
	}
	a.started = true
	a.mu.Unlock()

	go func() {
		ticker := time.NewTicker(threadStatsPollInterval)
		defer ticker.Stop()
		for range ticker.C {
			a.sample()
		}
	}()
}

// sample reads the CSV and folds it into the rolling means, if it is a generation that
// has not been counted yet.
func (a *threadStatsAverager) sample() {
	info, err := os.Stat(threadStatsPath)
	if err != nil {
		return
	}
	a.mu.Lock()
	if info.ModTime().Equal(a.lastModTime) && info.Size() == a.lastSize {
		a.mu.Unlock()
		return // same generation we already counted
	}
	a.mu.Unlock()

	stats, ok := readThreadStats()
	if !ok {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.lastModTime, a.lastSize = info.ModTime(), info.Size()
	for _, h := range a.hist {
		h.fresh = false
	}
	for name, st := range stats {
		h := a.hist[name]
		if h == nil {
			h = &threadStatHistory{}
			a.hist[name] = h
		}
		h.add(st.cpuPct, st.cpuNum)
	}
	// A thread absent from this generation has ended, or its name changed. Drop it
	// rather than let a stale mean sit in the map for the rest of the process's life.
	for name, h := range a.hist {
		if !h.fresh {
			delete(a.hist, name)
		}
	}
}

// Averaged returns the rolling mean per thread, and how many samples the shortest-lived
// entry is built from. ok is false when there is nothing worth averaging yet, in which
// case the caller should fall back to a single raw reading.
//
// The sample count is returned rather than buried because it changes how the numbers
// should be read: four samples still carry a visible jiffy, thirty do not, and a page
// showing two decimal places has no other way to say which it is holding.
func (a *threadStatsAverager) Averaged() (stats map[string]threadStat, samples int, ok bool) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if len(a.hist) == 0 {
		return nil, 0, false
	}
	samples = threadStatsWindow
	stats = make(map[string]threadStat, len(a.hist))
	for name, h := range a.hist {
		stats[name] = threadStat{cpuPct: h.mean(), cpuNum: h.cpuNum}
		if h.n < samples {
			samples = h.n
		}
	}
	if samples < threadStatsMinSamples {
		return nil, samples, false
	}
	return stats, samples, true
}

// threadStatsForReport is the accessor a report should use: the rolling mean when one
// has built up, and the latest raw CSV otherwise, so a freshly started server still
// shows measured CPU instead of an empty column.
func threadStatsForReport() (stats map[string]threadStat, samples int, available bool) {
	if avg, n, ok := globalThreadStats.Averaged(); ok {
		return avg, n, true
	}
	raw, ok := readThreadStats()
	return raw, 1, ok
}
