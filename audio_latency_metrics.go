package main

import (
	"encoding/json"
	"log"
	"math/bits"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Audio latency: the time from the RX888 capturing a packet's first sample
// (AudioPacket.GPSTimeNs; see capture_time.go) to the WebSocket loop handing
// the encoded frame to WriteMessage.  It covers radiod's 20 ms block fill and
// processing, the multicast hop, queueing in the session's audio channel, the
// audio gate, encoding and header building, but not the write itself, so a
// slow client's TCP backpressure does not read as server latency.  A packet
// with no capture time (GPSTimeNs 0) is not counted.
//
// Buckets are fixed and half-octave (each boundary sqrt(2) above the last),
// from 2 µs up to about 1 s. The same layout suits a fast x86 box encoding in
// tens of microseconds and a loaded Pi taking milliseconds, and because every
// window shares it, minutes and hours can be summed and servers compared.
// The admin page chooses which span of buckets to show.

const (
	audioLatencyOpus    = 0
	audioLatencyPCMv4   = 1
	audioLatencyFormats = 2

	audioLatencyBuckets = 40 // last bucket starts at 2^20 µs (~1.05 s)
	audioLatencyMinutes = 60
	audioLatencyHours   = 24
)

var audioLatencyFormatNames = [audioLatencyFormats]string{"opus", "pcmv4"}

// audioLatencyBucket maps a latency in microseconds to its bucket. Bucket 0
// holds everything under 2 µs; above that the bit length gives the octave and
// the next bit down picks its lower or upper half.
func audioLatencyBucket(us uint64) int {
	if us < 2 {
		return 0
	}
	b := bits.Len64(us) // us is in [2^(b-1), 2^b), b >= 2
	half := int(us>>(b-2)) & 1
	idx := 2*(b-1) + half - 1
	if idx >= audioLatencyBuckets {
		idx = audioLatencyBuckets - 1
	}
	return idx
}

// audioLatencyBucketLowerUs is the inclusive lower bound of a bucket, in µs.
func audioLatencyBucketLowerUs(idx int) uint64 {
	if idx <= 0 {
		return 0
	}
	k := idx + 1
	octave := k / 2
	lower := uint64(1) << octave
	if k%2 == 1 {
		lower += uint64(1) << (octave - 1)
	}
	return lower
}

// audioLatencySlot holds one minute or one hour of samples. Fields are atomic
// so the per-packet path never takes a lock.
type audioLatencySlot struct {
	tag    atomic.Int64 // absolute minute or hour this slot holds
	counts [audioLatencyFormats][audioLatencyBuckets]atomic.Uint64
	sumNs  [audioLatencyFormats]atomic.Uint64
	maxNs  [audioLatencyFormats]atomic.Uint64
}

func (s *audioLatencySlot) reset() {
	for f := range s.counts {
		for i := range s.counts[f] {
			s.counts[f][i].Store(0)
		}
		s.sumNs[f].Store(0)
		s.maxNs[f].Store(0)
	}
}

// audioLatencyRing is a ring of slots, one per period. The mutex serialises
// only the reset when a slot is reused for a new period; recording into a
// current slot is lock-free.
type audioLatencyRing struct {
	periodSec int64
	mu        sync.Mutex
	slots     []audioLatencySlot
}

func newAudioLatencyRing(periodSec int64, n int) *audioLatencyRing {
	r := &audioLatencyRing{periodSec: periodSec, slots: make([]audioLatencySlot, n)}
	for i := range r.slots {
		r.slots[i].tag.Store(-1)
	}
	return r
}

func (r *audioLatencyRing) slotFor(nowSec int64) *audioLatencySlot {
	tag := nowSec / r.periodSec
	s := &r.slots[tag%int64(len(r.slots))]
	if s.tag.Load() != tag {
		r.mu.Lock()
		if s.tag.Load() != tag {
			s.reset()
			s.tag.Store(tag)
		}
		r.mu.Unlock()
	}
	return s
}

func (r *audioLatencyRing) record(nowSec int64, format, bucket int, ns uint64) {
	s := r.slotFor(nowSec)
	s.counts[format][bucket].Add(1)
	s.sumNs[format].Add(ns)
	for {
		cur := s.maxNs[format].Load()
		if ns <= cur || s.maxNs[format].CompareAndSwap(cur, ns) {
			break
		}
	}
}

// audioLatencyAgg is a window's samples for one format, summed across slots.
type audioLatencyAgg struct {
	counts [audioLatencyBuckets]uint64
	count  uint64
	sumNs  uint64
	maxNs  uint64
}

func (a *audioLatencyAgg) add(s *audioLatencySlot, format int) {
	for b := range a.counts {
		c := s.counts[format][b].Load()
		a.counts[b] += c
		a.count += c
	}
	a.sumNs += s.sumNs[format].Load()
	if m := s.maxNs[format].Load(); m > a.maxNs {
		a.maxNs = m
	}
}

// sum adds the slots covering the last n periods, the current one included.
func (r *audioLatencyRing) sum(nowSec int64, n int, format int) audioLatencyAgg {
	var a audioLatencyAgg
	cur := nowSec / r.periodSec
	for i := range r.slots {
		s := &r.slots[i]
		tag := s.tag.Load()
		if tag < 0 || tag > cur || tag <= cur-int64(n) {
			continue
		}
		a.add(s, format)
	}
	return a
}

// AudioLatencyPoint is one period of the chart series.
type AudioLatencyPoint struct {
	Count  uint64  `json:"count"`
	MeanUs float64 `json:"mean_us"`
	P95Us  float64 `json:"p95_us"`
	MaxUs  float64 `json:"max_us"`
}

// series returns one point per period for the last n periods, oldest first,
// each starting at start_ms. Periods with no packets have a zero count.
func (r *audioLatencyRing) series(nowSec int64, n int) []map[string]interface{} {
	cur := nowSec / r.periodSec
	out := make([]map[string]interface{}, 0, n)
	for tag := cur - int64(n) + 1; tag <= cur; tag++ {
		point := map[string]interface{}{"start_ms": tag * r.periodSec * 1000}
		s := &r.slots[tag%int64(len(r.slots))]
		live := s.tag.Load() == tag
		for f, name := range audioLatencyFormatNames {
			var a audioLatencyAgg
			if live {
				a.add(s, f)
			}
			st := a.stats()
			point[name] = AudioLatencyPoint{Count: st.Count, MeanUs: st.MeanUs, P95Us: st.P95Us, MaxUs: st.MaxUs}
		}
		out = append(out, point)
	}
	return out
}

// AudioLatencyMetrics records per-packet processing latency for the Opus and
// PCM v4 WebSocket paths.
type AudioLatencyMetrics struct {
	minutes *audioLatencyRing
	hours   *audioLatencyRing
}

func newAudioLatencyMetrics() *AudioLatencyMetrics {
	return &AudioLatencyMetrics{
		minutes: newAudioLatencyRing(60, audioLatencyMinutes),
		hours:   newAudioLatencyRing(3600, audioLatencyHours),
	}
}

var globalAudioLatency = newAudioLatencyMetrics()

// Record notes one packet about to be written. arrivalNs is when the packet's
// first sample was captured, 0 if unknown; now is passed in rather than read here because the
// send path already holds one, and on hosts whose clock source is HPET rather
// than TSC each time.Now costs microseconds. A negative latency can only come
// from the system clock stepping backwards, and is dropped as meaningless.
func (m *AudioLatencyMetrics) Record(format int, arrivalNs int64, now time.Time) {
	d := now.UnixNano() - arrivalNs
	if d < 0 || arrivalNs == 0 {
		return
	}
	ns := uint64(d)
	bucket := audioLatencyBucket(ns / 1000)
	sec := now.Unix()
	m.minutes.record(sec, format, bucket, ns)
	m.hours.record(sec, format, bucket, ns)
}

// AudioLatencyStats summarises one format over one window.
type AudioLatencyStats struct {
	Count   uint64   `json:"count"`
	MeanUs  float64  `json:"mean_us"`
	P50Us   float64  `json:"p50_us"`
	P95Us   float64  `json:"p95_us"`
	P99Us   float64  `json:"p99_us"`
	MaxUs   float64  `json:"max_us"`
	Buckets []uint64 `json:"buckets"`
}

// percentileUs interpolates linearly within the bucket the quantile falls in.
// The last bucket has no upper bound, so the window's maximum stands in.
func (a *audioLatencyAgg) percentileUs(q float64) float64 {
	if a.count == 0 {
		return 0
	}
	maxUs := float64(a.maxNs) / 1000
	target := q * float64(a.count)
	var cum float64
	for i, c := range a.counts {
		if c == 0 {
			continue
		}
		if cum+float64(c) >= target {
			lo := float64(audioLatencyBucketLowerUs(i))
			hi := maxUs
			if i+1 < audioLatencyBuckets {
				hi = float64(audioLatencyBucketLowerUs(i + 1))
			}
			v := lo + (hi-lo)*(target-cum)/float64(c)
			if v > maxUs {
				v = maxUs
			}
			return v
		}
		cum += float64(c)
	}
	return maxUs
}

func (a *audioLatencyAgg) stats() AudioLatencyStats {
	s := AudioLatencyStats{Count: a.count, Buckets: a.counts[:]}
	if a.count == 0 {
		return s
	}
	s.MeanUs = float64(a.sumNs) / float64(a.count) / 1000
	s.P50Us = a.percentileUs(0.50)
	s.P95Us = a.percentileUs(0.95)
	s.P99Us = a.percentileUs(0.99)
	s.MaxUs = float64(a.maxNs) / 1000
	return s
}

// Snapshot returns the last 5 minutes, the last hour and the last 24 hours,
// each split by format, with the bucket lower bounds needed to label them,
// plus per-minute and per-hour series for the charts.
func (m *AudioLatencyMetrics) Snapshot() map[string]interface{} {
	sec := time.Now().Unix()
	lower := make([]uint64, audioLatencyBuckets)
	for i := range lower {
		lower[i] = audioLatencyBucketLowerUs(i)
	}

	window := func(r *audioLatencyRing, n int) map[string]AudioLatencyStats {
		out := make(map[string]AudioLatencyStats, audioLatencyFormats)
		for f, name := range audioLatencyFormatNames {
			a := r.sum(sec, n, f)
			out[name] = a.stats()
		}
		return out
	}

	return map[string]interface{}{
		"bucket_lower_us": lower,
		"windows": map[string]interface{}{
			"5m":  window(m.minutes, 5),
			"1h":  window(m.minutes, audioLatencyMinutes),
			"24h": window(m.hours, audioLatencyHours),
		},
		"minutes": m.minutes.series(sec, audioLatencyMinutes),
		"hours":   m.hours.series(sec, audioLatencyHours),
	}
}

// HandleAudioLatency handles GET /admin/audio-latency.
func (ah *AdminHandler) HandleAudioLatency(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(globalAudioLatency.Snapshot()); err != nil {
		log.Printf("Error encoding audio latency response: %v", err)
	}
}
