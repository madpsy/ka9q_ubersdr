package main

// skimmer_feed.go — consumes the skimmer addon's spot feed (GET /api/feed).
//
// The skimmer (container "skimmer", not the older "cwskimmer") decodes CW,
// RTTY, JTTY, FT8/FT4/FT2, WSPR/FST4W and JS8 from wideband IQ and publishes
// every spot it validates as a Server-Sent Events stream, documented in the
// skimmer repository's docs/feed.md.  This client reads that stream and turns
// each spot into the types UberSDR's own sources produce — CWSkimmerSpot for
// CW, RTTY and JTTY, DecodeInfo for the digital modes — and hands them to the
// registered callbacks, which deliver them exactly as local spots are
// delivered (database, UIs, SSE, MQTT, notifications).
//
// Reporting is deliberately absent: the skimmer uploads to PSK Reporter,
// wsprnet and RBN itself, so nothing here may reach UberSDR's uploaders.  The
// client holds no reference to them, and skimmer_feed_test.go fails the build
// if one appears in this file.
//
// No lookups either: the feed carries cty.dat's entity, ISO country code,
// zones and UTC offset, the sender's position with where it came from,
// distance and bearing from the receiver, and the QRZ record (including the
// IANA time zone) when the skimmer has one cached.
//
// Wire format (docs/feed.md, message version v=1):
//
//	id: 1791639174496
//	event: spot
//	data: {"type":"spot","seq":1791639174496,"v":1,...}
//
// "spot" events carry an id and are resumed with Last-Event-ID after a
// reconnect; "health" (every 10 s) and "gap" carry none.  A comment line keeps
// the connection open every 15 s, so 30 s of silence means the skimmer is gone.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// skimmerFeedIdleTimeout: health comes every 10 s and a keep-alive comment
	// every 15 s, so a feed silent this long is dead (docs/feed.md).
	skimmerFeedIdleTimeout = 30 * time.Second

	// skimmerFeedHealthTimeout: a new health message comes every 10 s.  A
	// skimmer whose connection stays open (its keep-alive comments still
	// coming) but whose health has stopped is stuck, and the connection is
	// made again.  Only a health message newer than the last one seen counts:
	// a reconnect is sent the latest at once, which may be the stale one.
	skimmerFeedHealthTimeout = 30 * time.Second

	skimmerFeedBackoffMin = 1 * time.Second
	skimmerFeedBackoffMax = 30 * time.Second

	// skimmerFeedVersion is the message form this client understands.  A
	// higher v means a field changed meaning or went away.
	skimmerFeedVersion = 1

	// skimmerFeedCWHold: a CW, RTTY or JTTY call spotted again on the same
	// band within this long of its last spot let through is held back.  The
	// feed sends every spot the skimmer validates, before its own hold, so a
	// station calling CQ would otherwise be spotted every few seconds; the
	// CW Skimmer telnet path gave the server's held stream.
	skimmerFeedCWHold = 10 * time.Minute

	// skimmerFeedMaxLine bounds one SSE line; a spot with a full QRZ record is
	// around 1–2 KB.
	skimmerFeedMaxLine = 1 << 20
)

// skimmerFeedSpot is a "spot" message as the skimmer sends it.  Optional
// fields are pointers where zero is a meaningful value.
type skimmerFeedSpot struct {
	Type      string   `json:"type"`
	Seq       int64    `json:"seq"`
	V         int      `json:"v"`
	T         int64    `json:"t"` // UTC Unix seconds; FT/WSPR/JS8: start of the cycle
	Spotter   string   `json:"spotter"`
	Family    string   `json:"family"` // CW, RTTY, JTTY, FT, WSPR, JS8
	Mode      string   `json:"mode"`   // FT8, WSPR-2, FST4W-300, JS8-Turbo...; CW/RTTY/JTTY: the family
	Band      string   `json:"band"`   // metres without the m: "20", "630"
	FreqHz    float64  `json:"freq_hz"`
	Call      string   `json:"call"`
	SNR       int      `json:"snr"`
	SpotType  string   `json:"spot_type"` // CQ, DE, BEACON, NCDXF, HEARD
	WPM       int      `json:"wpm"`
	Baud      int      `json:"baud"`
	Locator   string   `json:"locator"`
	DBm       *int     `json:"dbm"`
	SpreadHz  *float64 `json:"spread_hz"`
	Message   string   `json:"message"`
	DT        *float64 `json:"dt"`
	Drift     *int     `json:"drift"`
	DialHz    float64  `json:"dial_hz"`
	Entity    string   `json:"entity"`
	Continent string   `json:"continent"`

	CountryCode string   `json:"country_code"`
	CQZone      int      `json:"cq_zone"`
	ITUZone     int      `json:"itu_zone"`
	UTCOffset   *float64 `json:"utc_offset"`
	Lat         *float64 `json:"lat"`
	Lon         *float64 `json:"lon"`
	LocSource   string   `json:"loc_source"` // locator, qrz, cty
	Km          *float64 `json:"km"`
	Bearing     *float64 `json:"bearing"`

	QRZ *skimmerFeedQRZ `json:"qrz"`
}

// skimmerFeedQRZ is the QRZ record a spot carries when the skimmer has it.
type skimmerFeedQRZ struct {
	Call     string   `json:"call"`
	Name     string   `json:"name"`
	City     string   `json:"city"`
	County   string   `json:"county"`
	State    string   `json:"state"`
	Country  string   `json:"country"`
	Grid     string   `json:"grid"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	GeoLoc   string   `json:"geoloc"`
	TZIana   string   `json:"tz_iana"`
	HomeOnly bool     `json:"home_only"`
}

// SkimmerFeedProblem is one entry of a health message's problems.
type SkimmerFeedProblem struct {
	Level string `json:"level"` // warn, error
	Part  string `json:"part"`  // cpu, receivers, rbn, pskreporter, wsprnet...
	Text  string `json:"text"`
}

// SkimmerFeedHealth is the skimmer's latest "health" message.  Raw keeps the
// whole message (CPU, memory, receivers, per-family spot counts, and the
// reporters' counts) for display as the skimmer sent it.
type SkimmerFeedHealth struct {
	V        int                  `json:"v"`
	T        int64                `json:"t"`
	Status   string               `json:"status"` // ok, warn, error
	Problems []SkimmerFeedProblem `json:"problems"`
	Spotter  string               `json:"spotter"`
	Version  string               `json:"version"`
	UptimeS  int64                `json:"uptime_s"`
	Raw      json.RawMessage      `json:"-"`
}

// SkimmerFeedStatus is a snapshot of the client for admin pages and logs.
type SkimmerFeedStatus struct {
	URL         string           `json:"url"`
	Connected   bool             `json:"connected"`
	LastEventID string           `json:"last_event_id,omitempty"`
	LastSpot    time.Time        `json:"last_spot,omitempty"`
	LastError   string           `json:"last_error,omitempty"`
	Spots       map[string]int64 `json:"spots"` // by family
	Skipped     int64            `json:"skipped"`
	Held        int64            `json:"held"` // CW-family repeats held back (cwHold)
	Gaps        int64            `json:"gaps"`
	// Stalled: the last connection was dropped for want of a new health
	// message while it stayed open (the skimmer stuck), until one comes.
	Stalled   bool      `json:"stalled"`
	StartedAt time.Time `json:"started_at"`
	// ChangedAt: when Connected last changed, so how long it has been
	// connected or not (StartedAt until the first connection).
	ChangedAt  time.Time          `json:"changed_at"`
	Reconnects int64              `json:"reconnects"`
	HealthAt   time.Time          `json:"health_at,omitempty"` // when the latest new health message came
	Health     *SkimmerFeedHealth `json:"health,omitempty"`
}

// SkimmerFeedClient reads the skimmer's feed and delivers its spots.
type SkimmerFeedClient struct {
	url string
	// maxFrequency is the top of the receiver's range: spots above it cannot
	// be tuned, so they are dropped as the CW Skimmer client drops them.
	maxFrequency  uint64
	idleTimeout   time.Duration
	healthTimeout time.Duration
	cwHold        time.Duration
	backoffMin    time.Duration
	backoffMax    time.Duration
	httpClient    *http.Client

	onCW      func(CWSkimmerSpot)
	onDigital func(DecodeInfo)
	onHealth  func(SkimmerFeedHealth)

	cancel context.CancelFunc
	done   chan struct{}

	connected atomic.Bool

	mu            sync.Mutex
	lastID        string
	lastSpot      time.Time
	lastError     string
	stalled       bool
	startedAt     time.Time // Start
	changedAt     time.Time // when connected last changed (connected or lost)
	reconnects    int64
	health        *SkimmerFeedHealth
	healthAt      time.Time // when the latest new health message arrived (our clock)
	spots         map[string]int64
	skipped       int64
	held          int64
	cwLast        map[string]int64 // family|band|call -> the spot time (Unix s) last let through
	cwNewest      int64            // the newest CW spot time seen, for pruning cwLast
	cwPruned      int64
	gaps          int64
	warnedVersion bool
}

// NewSkimmerFeedClient makes a client for cfg.URL.  maxFrequency (Hz, 0 for
// none) is the receiver's top frequency.
func NewSkimmerFeedClient(cfg SkimmerFeedConfig, maxFrequency uint64) *SkimmerFeedClient {
	feedURL := cfg.URL
	if feedURL == "" {
		feedURL = skimmerFeedDefaultURL
	}
	return &SkimmerFeedClient{
		url:           feedURL,
		maxFrequency:  maxFrequency,
		idleTimeout:   skimmerFeedIdleTimeout,
		healthTimeout: skimmerFeedHealthTimeout,
		cwHold:        skimmerFeedCWHold,
		cwLast:        make(map[string]int64),
		backoffMin:    skimmerFeedBackoffMin,
		backoffMax:    skimmerFeedBackoffMax,
		httpClient: &http.Client{
			// No overall Timeout: the response is a stream that never ends.
			// The watchdogs in connectOnce bound a dead or stuck one.
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				TLSHandshakeTimeout:   10 * time.Second,
				ResponseHeaderTimeout: 15 * time.Second,
			},
		},
		spots: make(map[string]int64),
	}
}

// OnCWSpot registers the handler for CW, RTTY and JTTY spots.
func (c *SkimmerFeedClient) OnCWSpot(fn func(CWSkimmerSpot)) { c.onCW = fn }

// OnDigitalSpot registers the handler for FT8/FT4/FT2, WSPR/FST4W and JS8 spots.
func (c *SkimmerFeedClient) OnDigitalSpot(fn func(DecodeInfo)) { c.onDigital = fn }

// OnHealth registers the handler for the skimmer's health messages.
func (c *SkimmerFeedClient) OnHealth(fn func(SkimmerFeedHealth)) { c.onHealth = fn }

// Start connects in the background and keeps reconnecting until Stop.
// Handlers must be registered before Start; they run on the client's
// goroutine, one message at a time, in the feed's order.
func (c *SkimmerFeedClient) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.done = make(chan struct{})
	c.mu.Lock()
	c.startedAt = time.Now()
	c.changedAt = c.startedAt
	c.mu.Unlock()
	log.Printf("Skimmer feed: consuming %s", c.url)
	go func() {
		defer close(c.done)
		c.run(ctx)
	}()
}

// Stop disconnects and waits for the client's goroutine to finish.
func (c *SkimmerFeedClient) Stop() {
	if c.cancel == nil {
		return
	}
	c.cancel()
	<-c.done
}

// Status returns a snapshot of the client's state.
func (c *SkimmerFeedClient) Status() SkimmerFeedStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := SkimmerFeedStatus{
		URL:         c.url,
		Connected:   c.connected.Load(),
		LastEventID: c.lastID,
		LastSpot:    c.lastSpot,
		LastError:   c.lastError,
		Spots:       make(map[string]int64, len(c.spots)),
		Skipped:     c.skipped,
		Held:        c.held,
		Gaps:        c.gaps,
		Stalled:     c.stalled,
		StartedAt:   c.startedAt,
		ChangedAt:   c.changedAt,
		Reconnects:  c.reconnects,
		HealthAt:    c.healthAt,
	}
	for k, v := range c.spots {
		s.Spots[k] = v
	}
	if c.health != nil {
		h := *c.health
		s.Health = &h
	}
	return s
}

// run is the reconnect loop.  The delay before each attempt starts at
// backoffMin and doubles to backoffMax; it goes back to backoffMin only after
// a connection made progress (a new health message, or with health not asked
// for, any message), so a skimmer that accepts and then stalls is not
// hammered.
func (c *SkimmerFeedClient) run(ctx context.Context) {
	backoff := c.backoffMin
	for attempt := 0; ; attempt++ {
		if attempt > 0 {
			c.mu.Lock()
			c.reconnects++
			c.mu.Unlock()
		}
		progress, err := c.connectOnce(ctx)
		c.setConnected(false)
		if ctx.Err() != nil {
			return
		}
		if progress {
			backoff = c.backoffMin
		}
		if err != nil {
			c.mu.Lock()
			c.lastError = err.Error()
			c.mu.Unlock()
			log.Printf("Skimmer feed: %v; reconnecting in %v", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > c.backoffMax {
			backoff = c.backoffMax
		}
	}
}

// requestURL is the feed's URL asking for spots and health, unless the
// configured URL already chooses its types.  wantsHealth says whether health
// messages will come, which arms the health watchdog.
func (c *SkimmerFeedClient) requestURL() (reqURL string, wantsHealth bool, err error) {
	u, err := url.Parse(c.url)
	if err != nil {
		return "", false, fmt.Errorf("invalid skimmer_feed.url %q: %w", c.url, err)
	}
	q := u.Query()
	types := q.Get("types")
	if types == "" {
		// Appended as written, its comma unescaped: skimmers before v2.4
		// do not percent-decode the query, and would read "spot%2Chealth"
		// as a type of that name and send nothing but keep-alives.
		if u.RawQuery != "" {
			u.RawQuery += "&"
		}
		u.RawQuery += "types=spot,health"
		return u.String(), true, nil
	}
	for _, t := range strings.Split(types, ",") {
		if t = strings.TrimSpace(strings.ToLower(t)); t == "health" || t == "all" {
			wantsHealth = true
		}
	}
	return u.String(), wantsHealth, nil
}

// connectOnce makes one connection and reads it until it ends.  progress
// reports whether it delivered anything new (see run).
//
// Two watchdogs close a connection that is open but no use:
//   - idle: no line at all (not even the 15 s keep-alive comment) for
//     idleTimeout — the network or the skimmer is gone;
//   - health: no new health message for healthTimeout while lines still come —
//     the skimmer is up but stuck.
func (c *SkimmerFeedClient) connectOnce(ctx context.Context) (progress bool, err error) {
	reqURL, wantsHealth, err := c.requestURL()
	if err != nil {
		return false, err
	}
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	req, err := http.NewRequestWithContext(connCtx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	c.mu.Lock()
	lastID := c.lastID
	c.mu.Unlock()
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return false, fmt.Errorf("HTTP %d from %s", resp.StatusCode, c.url)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		return false, fmt.Errorf("%s is not an event stream (Content-Type %q): is skimmer_feed.url the skimmer's /api/feed?", c.url, ct)
	}

	c.setConnected(true)
	if lastID != "" {
		log.Printf("Skimmer feed: connected to %s, resuming after %s", c.url, lastID)
	} else {
		log.Printf("Skimmer feed: connected to %s", c.url)
	}

	var idle, stalled atomic.Bool
	var lastLine atomic.Int64 // UnixNano of the last line read
	lastLine.Store(time.Now().UnixNano())
	idleTimer := time.AfterFunc(c.idleTimeout, func() {
		idle.Store(true)
		cancel()
	})
	defer idleTimer.Stop()
	var healthTimer *time.Timer
	if wantsHealth {
		healthTimer = time.AfterFunc(c.healthTimeout, func() {
			stalled.Store(true)
			cancel()
		})
		defer healthTimer.Stop()
	}

	err = readSSE(resp.Body, func() {
		lastLine.Store(time.Now().UnixNano())
		idleTimer.Reset(c.idleTimeout)
	}, func(ev sseEvent) {
		fresh := c.handleEvent(ev)
		if !wantsHealth {
			fresh = true
		}
		if !fresh {
			return
		}
		if !progress {
			progress = true
			c.mu.Lock()
			wasStalled := c.stalled
			c.stalled = false
			c.lastError = ""
			c.mu.Unlock()
			if wasStalled {
				log.Printf("Skimmer feed: the skimmer's health messages have resumed")
			}
		}
		if healthTimer != nil {
			healthTimer.Reset(c.healthTimeout)
		}
	})
	// Stuck means lines still coming but no health; with nothing at all for
	// a while the skimmer is down (or frozen), whichever watchdog fired.
	silent := time.Since(time.Unix(0, lastLine.Load()))
	if stalled.Load() && silent >= c.healthTimeout/2 {
		stalled.Store(false)
		idle.Store(true)
	}
	switch {
	case ctx.Err() != nil:
		return progress, nil
	case stalled.Load():
		c.mu.Lock()
		c.stalled = true
		c.mu.Unlock()
		return progress, fmt.Errorf("no new health message for %v though the connection is open: the skimmer may be stuck", c.healthTimeout)
	case idle.Load():
		return progress, fmt.Errorf("nothing for %v, not even a keep-alive: the skimmer is down or unreachable", silent.Round(time.Second))
	case err == nil:
		return progress, errors.New("the skimmer closed the feed")
	default:
		return progress, err
	}
}

// sseEvent is one dispatched Server-Sent Event.
type sseEvent struct {
	ID    string
	Event string
	Data  string
}

// readSSE reads an event stream per the HTML spec's rules, calling onLine for
// every line read (comments included) and onEvent for each complete event.
// It returns nil at EOF and the read error otherwise.
func readSSE(r io.Reader, onLine func(), onEvent func(sseEvent)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), skimmerFeedMaxLine)
	var ev sseEvent
	var data []string
	for sc.Scan() {
		if onLine != nil {
			onLine()
		}
		line := strings.TrimSuffix(sc.Text(), "\r")
		if line == "" {
			if len(data) > 0 {
				ev.Data = strings.Join(data, "\n")
				onEvent(ev)
			}
			ev = sseEvent{}
			data = data[:0]
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // comment / keep-alive
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "id":
			ev.ID = value
		case "event":
			ev.Event = value
		case "data":
			data = append(data, value)
		}
	}
	return sc.Err()
}

// handleEvent dispatches one message by its type.  Types this client does not
// know are ignored, as docs/feed.md asks of a reader.  It reports whether the
// message was a new health message (the health watchdog's sign of life).
func (c *SkimmerFeedClient) handleEvent(ev sseEvent) bool {
	typ := ev.Event
	if typ == "" {
		var probe struct {
			Type string `json:"type"`
		}
		if json.Unmarshal([]byte(ev.Data), &probe) == nil {
			typ = probe.Type
		}
	}
	switch typ {
	case "spot":
		c.handleSpot(ev)
	case "health":
		return c.handleHealth(ev.Data)
	case "gap":
		var g struct {
			Since  int64 `json:"since"`
			Oldest int64 `json:"oldest"`
		}
		_ = json.Unmarshal([]byte(ev.Data), &g)
		c.mu.Lock()
		c.gaps++
		c.mu.Unlock()
		log.Printf("Skimmer feed: spots after %d and before %d were lost (no longer kept by the skimmer)", g.Since, g.Oldest)
	}
	return false
}

func (c *SkimmerFeedClient) handleSpot(ev sseEvent) {
	// The id is taken whatever becomes of the spot, so a reconnect never asks
	// for it again.
	defer func() {
		if ev.ID != "" {
			c.mu.Lock()
			c.lastID = ev.ID
			c.mu.Unlock()
		}
	}()

	var s skimmerFeedSpot
	if err := json.Unmarshal([]byte(ev.Data), &s); err != nil {
		c.skip()
		log.Printf("Skimmer feed: unreadable spot: %v", err)
		return
	}
	if s.V != skimmerFeedVersion {
		c.skip()
		c.mu.Lock()
		warn := !c.warnedVersion
		c.warnedVersion = true
		c.mu.Unlock()
		if warn {
			log.Printf("Skimmer feed: spot message version %d, this UberSDR reads %d: such spots are skipped (update UberSDR)", s.V, skimmerFeedVersion)
		}
		return
	}
	if s.Call == "" || s.FreqHz <= 0 || (c.maxFrequency > 0 && s.FreqHz > float64(c.maxFrequency)) {
		c.skip()
		return
	}

	switch s.Family {
	case "CW", "RTTY", "JTTY":
		if c.holdCW(&s) {
			return
		}
		spot := skimmerFeedCWSpot(&s)
		c.count(s.Family)
		if c.onCW != nil {
			c.onCW(spot)
		}
	case "FT", "WSPR", "JS8":
		decode := skimmerFeedDecode(&s)
		c.count(s.Family)
		if c.onDigital != nil {
			c.onDigital(decode)
		}
	default:
		c.skip() // a family this UberSDR does not know
	}
}

// handleHealth keeps a health message and reports whether it is new: later
// than the last one (by the skimmer's own t), or from a restarted skimmer.  The latest is sent again to each new connection,
// and that replay is not news.
func (c *SkimmerFeedClient) handleHealth(data string) bool {
	var h SkimmerFeedHealth
	if err := json.Unmarshal([]byte(data), &h); err != nil {
		log.Printf("Skimmer feed: unreadable health message: %v", err)
		return false
	}
	h.Raw = json.RawMessage(data)
	c.mu.Lock()
	prev := c.health
	// A restart shows as a later start (t less uptime); the same run's
	// messages, a replay among them, share one.
	fresh := prev == nil || h.T > prev.T || h.T-h.UptimeS > prev.T-prev.UptimeS
	if fresh {
		c.health = &h
		c.healthAt = time.Now()
	}
	c.mu.Unlock()
	if !fresh {
		return false
	}
	if prev == nil || prev.Status != h.Status {
		log.Printf("Skimmer feed: skimmer %s %s health %s", h.Spotter, h.Version, h.Status)
	}
	if c.onHealth != nil {
		c.onHealth(h)
	}
	return true
}

// holdCW reports whether a CW-family spot is a repeat to hold back: the same
// call, band and family let through within cwHold of it, either way in time
// (a resumed backlog comes in the feed's order, but a restarted skimmer's
// clock is not to be trusted).  Times are the spots' own, so replays and
// backlogs are judged as when heard.
func (c *SkimmerFeedClient) holdCW(s *skimmerFeedSpot) bool {
	if c.cwHold <= 0 {
		return false
	}
	key := s.Family + "|" + s.Band + "|" + strings.ToUpper(s.Call)
	hold := int64(c.cwHold / time.Second)
	c.mu.Lock()
	defer c.mu.Unlock()
	if s.T > c.cwNewest {
		c.cwNewest = s.T
	}
	if last, ok := c.cwLast[key]; ok {
		d := s.T - last
		if d < 0 {
			d = -d
		}
		if d < hold {
			c.held++
			return true
		}
	}
	c.cwLast[key] = s.T
	// Forget calls not heard for a hold, now and then (a busy contest
	// weekend is tens of thousands of call and band pairs).
	if c.cwNewest-c.cwPruned >= hold {
		for k, t := range c.cwLast {
			if c.cwNewest-t >= hold {
				delete(c.cwLast, k)
			}
		}
		c.cwPruned = c.cwNewest
	}
	return false
}

// setConnected records the connection's state, and when it changed.
func (c *SkimmerFeedClient) setConnected(up bool) {
	if c.connected.Swap(up) != up {
		c.mu.Lock()
		c.changedAt = time.Now()
		c.mu.Unlock()
	}
}

func (c *SkimmerFeedClient) count(family string) {
	c.mu.Lock()
	c.spots[family]++
	c.lastSpot = time.Now()
	c.mu.Unlock()
}

func (c *SkimmerFeedClient) skip() {
	c.mu.Lock()
	c.skipped++
	c.mu.Unlock()
}

// skimmerFeedCWSpot maps a CW, RTTY or JTTY spot as the CW Skimmer telnet
// client would have produced it, with the feed's enrichment in place of
// UberSDR's own CTY and QRZ lookups.
func skimmerFeedCWSpot(s *skimmerFeedSpot) CWSkimmerSpot {
	spot := CWSkimmerSpot{
		Frequency:   s.FreqHz,
		DXCall:      s.Call,
		Spotter:     s.Spotter,
		SNR:         s.SNR,
		Mode:        s.Family,
		Comment:     s.SpotType,
		Time:        time.Unix(s.T, 0).UTC(),
		Band:        frequencyToBand(s.FreqHz),
		Country:     s.Entity,
		CountryCode: s.CountryCode,
		CQZone:      s.CQZone,
		ITUZone:     s.ITUZone,
		Continent:   s.Continent,
		LocSource:   s.LocSource,
		DistanceKm:  s.Km,
		BearingDeg:  s.Bearing,
	}
	// WPM holds the speed: words a minute for CW, baud for RTTY and JTTY (the
	// telnet client's convention, from its "BPS" lines).
	if s.Family == "CW" {
		spot.WPM = s.WPM
	} else {
		spot.WPM = s.Baud
		// The telnet client keeps the mode word in the comment ("CQ RTTY") so
		// log readers can tell the modes apart; the same here.
		spot.Comment = strings.TrimSpace(s.SpotType + " " + s.Family)
	}
	if s.Lat != nil && s.Lon != nil {
		spot.Latitude = *s.Lat
		spot.Longitude = *s.Lon
	}
	if q := s.QRZ; q != nil {
		spot.Name = q.Name
		spot.State = q.State
		spot.Grid = q.Grid
		// GeoLoc and the time zone describe QRZ's position, so they are kept
		// only when that is the position the spot uses (not for a call
		// signing away from home, whose QRZ place is the home station's).
		if s.LocSource == "qrz" {
			spot.GeoLoc = q.GeoLoc
			spot.Timezone = q.TZIana
		}
	}
	return spot
}

// skimmerFeedDecode maps an FT, WSPR or JS8 spot as UberSDR's own decoders
// produce DecodeInfo, so feed spots and local ones read the same.
func skimmerFeedDecode(s *skimmerFeedSpot) DecodeInfo {
	mode, submode := skimmerFeedDigitalMode(s.Family, s.Mode)
	freq := uint64(s.FreqHz + 0.5)
	dial := uint64(s.DialHz + 0.5)
	d := DecodeInfo{
		Callsign:      s.Call,
		Locator:       s.Locator,
		Country:       s.Entity,
		CountryCode:   s.CountryCode,
		CQZone:        s.CQZone,
		ITUZone:       s.ITUZone,
		Continent:     s.Continent,
		SNR:           s.SNR,
		Frequency:     freq,
		DialFrequency: dial,
		Timestamp:     time.Unix(s.T, 0).UTC(),
		Mode:          mode,
		Submode:       submode,
		Message:       s.Message,
		BandName:      "skimmer_" + s.Band + "m_" + mode,
		HasCallsign:   isValidCallsign(s.Call),
		HasLocator:    s.Locator != "" && isValidGridLocator(s.Locator),
		IsWSPR:        s.Family == "WSPR",
	}
	if s.UTCOffset != nil {
		d.TimeOffset = *s.UTCOffset + 0 // + 0: an older skimmer's -0.0 as 0
	}
	if s.DT != nil {
		d.DT = float32(*s.DT)
	}
	if s.Family == "WSPR" {
		// As the WSPR decoder fills it: Frequency the receiver's (dial),
		// TxFrequency the transmitter's.
		d.TxFrequency = freq
		if dial > 0 {
			d.Frequency = dial
		}
		if s.DBm != nil {
			d.DBm = *s.DBm
		}
		if s.Drift != nil {
			d.Drift = *s.Drift
		}
	}
	// UberSDR's decoders give a distance only from the sender's own locator;
	// a country's middle (loc_source "cty") would be presented as precise.
	if s.LocSource == "locator" {
		d.DistanceKm = s.Km
		d.BearingDeg = s.Bearing
	}
	return d
}

// skimmerFeedDigitalMode is UberSDR's mode and submode for a feed spot's.
// JS8's speeds become submodes A/B/C/E as the JS8 decoder gives them.  Every
// WSPR-family mode is WSPR (UberSDR's filters, notifications and UIs know no
// other), WSPR-15 and FST4W-* kept as its submode ("WSPR/FST4W-300" in the
// UIs); WSPR-2, the plain one, has none.
func skimmerFeedDigitalMode(family, mode string) (string, string) {
	switch family {
	case "JS8":
		switch mode {
		case "JS8-Normal":
			return "JS8", "A"
		case "JS8-Fast":
			return "JS8", "B"
		case "JS8-Turbo":
			return "JS8", "C"
		case "JS8-Slow":
			return "JS8", "E"
		}
		return "JS8", ""
	case "WSPR":
		if mode == "WSPR-2" || mode == "WSPR" {
			return "WSPR", ""
		}
		return "WSPR", mode
	}
	return mode, ""
}
