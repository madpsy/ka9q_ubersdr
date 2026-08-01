package main

import (
	"sync"
	"time"
)

// voice_activity_dxloc.go — a small, non-blocking cache of precise per-operator
// coordinates for DX-cluster-spotted callsigns, used by voice activity
// enrichment (see enrichWithDXCallsigns).
//
// WHY THIS EXISTS
//
// Voice activity enrichment runs on a per-viewer hot path: every open Band
// Activity page polls GET /api/noisefloor/voice-activity/all every 5 seconds
// (static/band_activity.html), and that handler loops over every configured
// band (GetAllBandsVoiceActivity).  Calling QRZService.Lookup() directly from
// there makes lookup volume scale with connected-viewer count — each viewer
// contributes one lookup per spotted activity per band every 5 s, so a few
// hundred viewers means millions of lookups an hour.
//
// Worse than the volume: a lookup that misses the QRZ cache BLOCKS inside the
// HTTP handler.  It enters singleflight, waits on QRZService's outbound-request
// semaphore, then on a TLS round-trip to QRZ.com.  A single cold callsign
// therefore stalls request goroutines in proportion to how many viewers are
// polling at that moment.
//
// This cache decouples the two concerns: readers never block and never touch
// QRZService, and each callsign is resolved once on a small background worker
// pool regardless of viewer count.
//
// DEGRADATION ON MISS
//
// A miss returns "no coordinates" rather than waiting.  Callers have already
// applied the CTY/DXCC prefix centroid by that point, so a miss simply leaves
// the coarse centroid in place for that one response, and the next poll (5 s
// later) picks up the precise position.  That coarse→precise progression is the
// same preference order CW skimmer spots already use, so it is a state clients
// handle today rather than a new one.

const (
	// dxLocPositiveTTL is how long a resolved position is reused.  Operator
	// coordinates effectively never change, and QRZService keeps its own 24 h
	// cache behind this one, so the TTL only needs to be short enough that a
	// corrected QRZ record is eventually picked up.
	dxLocPositiveTTL = 6 * time.Hour

	// dxLocNegativeTTL is how long a "no usable position" answer is reused.
	// Negative caching is essential here: without it, every callsign with no
	// QRZ record — or a record carrying no coordinates — would re-queue a fill
	// on every poll from every viewer, which is precisely the load this cache
	// exists to remove.  Matched to the DX cluster spot TTL
	// (DXClusterClient.spotTTL, 30 min) so a re-spotted callsign gets a fresh
	// attempt roughly once per spot lifetime.
	dxLocNegativeTTL = 30 * time.Minute

	// dxLocMaxEntries bounds the map.  The live working set is bounded by the
	// number of distinct callsigns in the DX cluster frequency index, which
	// prunes at spotTTL — realistically low hundreds.  This is headroom, not a
	// limit expected to bind.
	dxLocMaxEntries = 5000

	// dxLocFillWorkers caps concurrent outbound resolutions.  QRZService has its
	// own outbound semaphore, but capping here keeps goroutines from piling up
	// when a large batch of unseen callsigns appears at once (first polls after
	// startup, or a contest weekend flooding the cluster).
	dxLocFillWorkers = 4
)

// dxLocEntry is one cached resolution result.  A zero-value position with
// have == false is a valid, deliberately cached answer ("QRZ has nothing usable
// for this callsign"), not an absence of data.
type dxLocEntry struct {
	lat, lon float64
	have     bool // true when QRZ returned usable coordinates
	expires  time.Time
}

// dxLocationCache maps callsign → resolved position, with background fills.
type dxLocationCache struct {
	mu       sync.RWMutex
	entries  map[string]dxLocEntry
	inflight map[string]struct{} // callsigns currently being resolved
	fillSem  chan struct{}       // bounds concurrent resolutions
}

// dxLocCache is the process-wide instance used by enrichWithDXCallsigns.
var dxLocCache = newDXLocationCache()

func newDXLocationCache() *dxLocationCache {
	return &dxLocationCache{
		entries:  make(map[string]dxLocEntry),
		inflight: make(map[string]struct{}),
		fillSem:  make(chan struct{}, dxLocFillWorkers),
	}
}

// Get returns the cached precise position for a callsign.
//
// It never blocks on the network.  On a miss or an expired entry it returns
// ok == false immediately and schedules a background resolution so the answer
// is ready for subsequent callers.  Returning "don't know" is deliberate: the
// caller falls back to the CTY centroid it has already applied.
func (c *dxLocationCache) Get(call string) (lat, lon float64, ok bool) {
	if call == "" || globalQRZService == nil {
		return 0, 0, false
	}

	c.mu.RLock()
	e, found := c.entries[call]
	c.mu.RUnlock()

	if found && time.Now().Before(e.expires) {
		return e.lat, e.lon, e.have
	}

	c.scheduleFill(call)
	return 0, 0, false
}

// scheduleFill starts a background resolution for call unless one is already
// running.  Fills are dropped rather than queued when every worker is busy:
// callers poll again within seconds, so a dropped fill costs one extra poll of
// coarse position instead of an unbounded backlog of stale work.
func (c *dxLocationCache) scheduleFill(call string) {
	c.mu.Lock()
	if _, busy := c.inflight[call]; busy {
		c.mu.Unlock()
		return
	}
	c.inflight[call] = struct{}{}
	c.mu.Unlock()

	select {
	case c.fillSem <- struct{}{}:
	default:
		// All workers busy — abandon this attempt so the next poll can retry.
		c.mu.Lock()
		delete(c.inflight, call)
		c.mu.Unlock()
		return
	}

	go func() {
		defer func() {
			<-c.fillSem
			c.mu.Lock()
			delete(c.inflight, call)
			c.mu.Unlock()
		}()

		qrz, err := globalQRZService.LookupFrom(qrzSourceVoiceActivity, call)
		if err != nil {
			// Transport or auth failure — cache nothing so the next poll
			// retries.  QRZService already applies its own retry/backoff, so
			// reaching here means the failure outlived those attempts.
			return
		}

		// Cache the negative case too: qrz == nil (not in QRZ) and a record
		// with no coordinates are both durable answers, not transient ones.
		e := dxLocEntry{expires: time.Now().Add(dxLocNegativeTTL)}
		if qrz != nil && (qrz.Lat != 0 || qrz.Lon != 0) {
			e = dxLocEntry{
				lat:     qrz.Lat,
				lon:     qrz.Lon,
				have:    true,
				expires: time.Now().Add(dxLocPositiveTTL),
			}
		}
		c.store(call, e)
	}()
}

// store inserts an entry, keeping the map under dxLocMaxEntries.
func (c *dxLocationCache) store(call string, e dxLocEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries[call] = e
	if len(c.entries) <= dxLocMaxEntries {
		return
	}

	// Over capacity: sweep expired entries first.
	now := time.Now()
	for k, v := range c.entries {
		if !now.Before(v.expires) {
			delete(c.entries, k)
		}
	}

	// Still over capacity — every remaining entry is live and equally valid, so
	// drop arbitrary ones (Go randomises map iteration order) until back under
	// the cap.  Reaching this at all means the working set has far exceeded the
	// spot-bounded estimate above; an evicted callsign simply gets re-resolved
	// on a later poll.
	for k := range c.entries {
		if len(c.entries) <= dxLocMaxEntries {
			break
		}
		delete(c.entries, k)
	}
}

// Size returns the number of cached entries, for diagnostics.
func (c *dxLocationCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}
