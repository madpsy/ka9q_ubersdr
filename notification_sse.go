package main

// notification_sse.go — the public notification stream: a single, built-in
// Server-Sent Events endpoint that streams notifications to anyone holding its
// password.
//
// Unlike the other channel types there is only ever one of these — there is one
// server and one endpoint, so a name is not a useful degree of freedom. It is
// always offered by the admin UI under the fixed channel name "sse_stream" and
// becomes active the moment a password is set; clearing the password removes it
// again. While active it behaves exactly like any other channel: rules target it
// by name, and its rate limits, statistics and response log all work the same.
//
// Endpoint:
//
//	GET /api/notifications/stream?password=<password>
//
// The password may also be supplied as "Authorization: Bearer <password>",
// which is preferred for server-to-server consumers because query strings leak
// into access logs, proxy logs, and browser history. Browsers cannot set headers
// on EventSource, so the query parameter exists for them.
//
// Each notification is delivered as:
//
//	event: notification
//	data: {"id":"42","channel":"sse_stream","event":"system_monitor",
//	       "rule":"Decoder health","message":"…","timestamp":"2026-07-25T10:00:00Z"}
//
// A heartbeat is sent every sse_heartbeat_seconds (default 30) so consumers can
// tell "no alerts" apart from "the connection died" — important for a feed whose
// normal state is silence:
//
//	event: heartbeat
//	data: {"channel":"sse_stream","timestamp":"…","last_message":"…"|null,
//	       "dropped":0,"sent":17}
//
// Nothing is replayed on connect: this is a live alert feed, so a subscriber
// receives what happens from the moment it connects and nothing that came
// before.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─── Tunables ─────────────────────────────────────────────────────────────────

const (
	// sseChannelName is the fixed channel name of the public notification
	// stream. Rules reference it by this name.
	sseChannelName = "sse_stream"

	// sseStreamPath is the public endpoint path.
	sseStreamPath = "/api/notifications/stream"

	// minSSEPasswordAlnum is the minimum number of alphanumeric characters the
	// stream password must contain. The endpoint is public, so this is a floor,
	// not a recommendation — longer is better.
	minSSEPasswordAlnum = 12

	// Heartbeat bounds. Below 5 s the traffic outweighs the benefit; above
	// 300 s intermediaries start dropping idle connections.
	minSSEHeartbeatSeconds     = 5
	maxSSEHeartbeatSeconds     = 300
	defaultSSEHeartbeatSeconds = 30

	// Concurrent subscriber bounds for the stream.
	maxSSEMaxClients     = 1000
	defaultSSEMaxClients = 10

	// sseClientQueue is the per-client outbound buffer. A client that cannot
	// keep up drops messages rather than stalling the publisher; the drop count
	// is reported in the next heartbeat.
	sseClientQueue = 64

	// Failed-auth throttle: at most sseAuthMaxFailures wrong passwords per IP
	// within sseAuthWindow before that IP is refused outright.
	sseAuthMaxFailures = 10
	sseAuthWindow      = 5 * time.Minute

	// sseReasonHeader names the condition behind a rejection. Both 503s
	// (disabled / full) and both 429s (auth-throttled / ip-limited) are
	// otherwise indistinguishable, which leaves a client unable to tell a
	// problem with its credentials from a problem with the server's capacity.
	sseReasonHeader = "X-Stream-Reason"

	sseReasonDisabled      = "disabled"       // no stream configured
	sseReasonFull          = "full"           // sse_max_clients reached
	sseReasonAuthThrottled = "auth-throttled" // too many failed passwords from this IP
	sseReasonIPLimited     = "ip-limited"     // too many concurrent connections from this IP
	sseReasonUnauthorized  = "unauthorized"   // missing or wrong password
)

// ─── Password policy ──────────────────────────────────────────────────────────

// validateSSEPassword reports whether pw meets the stream password policy:
// at least minSSEPasswordAlnum alphanumeric characters, at least one letter and
// one digit, and no characters outside the URL-unreserved set (alphanumerics
// plus - . _ ~) so the password survives a query string without escaping.
// Returns a human-readable reason when the password is unacceptable, or "" when
// it is acceptable.
func validateSSEPassword(pw string) string {
	if pw == "" {
		return "is required"
	}
	alnum, letters, digits := 0, 0, 0
	for _, c := range pw {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
			alnum++
			letters++
		case c >= '0' && c <= '9':
			alnum++
			digits++
		case c == '-' || c == '.' || c == '_' || c == '~':
			// Allowed, but does not count towards the alphanumeric minimum.
		default:
			return "may only contain letters, digits, and - . _ ~ (it travels in a URL query string)"
		}
	}
	if alnum < minSSEPasswordAlnum {
		return fmt.Sprintf("must contain at least %d alphanumeric characters (has %d)", minSSEPasswordAlnum, alnum)
	}
	if letters == 0 || digits == 0 {
		return "must contain both letters and digits"
	}
	return ""
}

// generateSSEPassword returns a fresh random password that satisfies the policy:
// 24 characters drawn from an unambiguous alphanumeric alphabet (no 0/O/1/l/I),
// guaranteed to contain both a letter and a digit.
func generateSSEPassword() (string, error) {
	const (
		letters  = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
		digits   = "23456789"
		alphabet = letters + digits
		length   = 24
	)
	for attempt := 0; attempt < 10; attempt++ {
		buf := make([]byte, length)
		if _, err := rand.Read(buf); err != nil {
			return "", fmt.Errorf("failed to read random bytes: %w", err)
		}
		out := make([]byte, length)
		for i, b := range buf {
			out[i] = alphabet[int(b)%len(alphabet)]
		}
		// Reject (and retry) the vanishingly rare all-letters or all-digits draw
		// rather than biasing the output by patching characters in place.
		if validateSSEPassword(string(out)) == "" {
			return string(out), nil
		}
	}
	return "", fmt.Errorf("failed to generate a compliant password")
}

// ─── Message ──────────────────────────────────────────────────────────────────

// NotificationSSEMessage is the JSON payload of one "notification" SSE event.
type NotificationSSEMessage struct {
	// ID is the monotonic sequence number of this message on the stream, as a
	// string. Subscribers can use it to spot a gap caused by a slow connection.
	ID string `json:"id"`
	// Channel is the notification channel name that produced the message
	// (always sseChannelName).
	Channel string `json:"channel"`
	// Event is the triggering event type (e.g. "dx_spot", "system_monitor",
	// "test"). Empty when the send path carries no event context.
	Event string `json:"event,omitempty"`
	// Rule is the name of the notification rule that matched. Empty for tests.
	Rule string `json:"rule,omitempty"`
	// Message is the fully rendered notification text.
	Message string `json:"message"`
	// Timestamp is when the message was published, UTC RFC3339.
	Timestamp string `json:"timestamp"`
}

// ─── Client ───────────────────────────────────────────────────────────────────

// notificationSSEClient is one connected subscriber.
type notificationSSEClient struct {
	ch      chan string
	closed  chan struct{} // closed when the stream evicts this client
	once    sync.Once
	dropped atomic.Uint64 // messages discarded because ch was full
}

// kick asks the client's handler goroutine to disconnect. Safe to call more
// than once and from multiple goroutines.
func (c *notificationSSEClient) kick() {
	c.once.Do(func() { close(c.closed) })
}

// ─── Stream ───────────────────────────────────────────────────────────────────

// notificationSSEStream owns the subscribers and credentials of the public
// notification stream. It is a package-level singleton because the
// HTTP handler is registered once at startup while the channel configuration
// comes and goes with every config reload — subscribers survive a config save.
type notificationSSEStream struct {
	mu       sync.RWMutex
	clients  map[*notificationSSEClient]struct{}
	active   bool
	password string
	// heartbeat is the interval at which connected clients receive a heartbeat
	// event. Read when a client connects; existing clients keep the interval
	// they connected with.
	heartbeat  time.Duration
	maxClients int

	seq        atomic.Uint64
	totalSent  atomic.Uint64
	lastSentAt atomic.Int64 // UnixNano of the last published message; 0 = none
}

// notificationSSE is the process-wide notification stream.
var notificationSSE = &notificationSSEStream{
	clients:    make(map[*notificationSSEClient]struct{}),
	heartbeat:  defaultSSEHeartbeatSeconds * time.Second,
	maxClients: defaultSSEMaxClients,
}

// activate enables the stream and applies cfg to it. Changing the password
// disconnects everyone: a rotated password must stop granting access to sessions
// opened with the old one.
func (s *notificationSSEStream) activate(cfg NotificationChannelConfig) {
	heartbeat := cfg.SSEHeartbeatSeconds
	if heartbeat <= 0 {
		heartbeat = defaultSSEHeartbeatSeconds
	}
	maxClients := cfg.SSEMaxClients
	if maxClients <= 0 {
		maxClients = defaultSSEMaxClients
	}
	s.mu.Lock()
	passwordChanged := s.active && s.password != cfg.SSEPassword
	s.active = true
	s.password = cfg.SSEPassword
	s.heartbeat = time.Duration(heartbeat) * time.Second
	s.maxClients = maxClients
	evicted := s.takeClientsLocked(passwordChanged)
	s.mu.Unlock()

	for _, c := range evicted {
		c.kick()
	}
	if len(evicted) > 0 {
		log.Printf("[NotificationSSE] password changed — disconnected %d subscriber(s)", len(evicted))
	}
}

// deactivate disables the stream and disconnects every subscriber. Called when
// the channel is removed from the configuration (or notifications are disabled).
func (s *notificationSSEStream) deactivate() {
	s.mu.Lock()
	wasActive := s.active
	s.active = false
	s.password = ""
	evicted := s.takeClientsLocked(true)
	s.mu.Unlock()

	for _, c := range evicted {
		c.kick()
	}
	if wasActive {
		log.Printf("[NotificationSSE] stream disabled — disconnected %d subscriber(s)", len(evicted))
	}
}

// takeClientsLocked returns and clears the client set when drop is true, and
// returns nil otherwise. Callers must hold s.mu for writing.
func (s *notificationSSEStream) takeClientsLocked(drop bool) []*notificationSSEClient {
	if !drop || len(s.clients) == 0 {
		return nil
	}
	evicted := make([]*notificationSSEClient, 0, len(s.clients))
	for c := range s.clients {
		evicted = append(evicted, c)
	}
	s.clients = make(map[*notificationSSEClient]struct{})
	return evicted
}

// register adds a client, refusing it when the stream is inactive or at its
// subscriber cap.
func (s *notificationSSEStream) register(c *notificationSSEClient) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active || len(s.clients) >= s.maxClients {
		return false
	}
	s.clients[c] = struct{}{}
	return true
}

// unregister removes a client. The client's channel is never closed — the
// handler owns the read side and exits on its own.
func (s *notificationSSEStream) unregister(c *notificationSSEClient) {
	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
}

// ClientCount returns the number of connected subscribers.
func (s *notificationSSEStream) ClientCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.clients)
}

// hasCapacity reports whether another subscriber could be accepted right now.
// Used by probes, which answer "would this be accepted?" without reserving a
// slot — so the answer is a snapshot, not a promise.
func (s *notificationSSEStream) hasCapacity() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.active && len(s.clients) < s.maxClients
}

// IsActive reports whether the stream is configured and serving.
func (s *notificationSSEStream) IsActive() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.active
}

// heartbeatInterval returns the current heartbeat interval.
func (s *notificationSSEStream) heartbeatInterval() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.heartbeat
}

// authorise reports whether pw matches the stream password. The comparison is
// constant-time so a wrong password reveals nothing through timing.
func (s *notificationSSEStream) authorise(pw string) bool {
	s.mu.RLock()
	active, want := s.active, s.password
	s.mu.RUnlock()
	if !active || want == "" || pw == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(pw), []byte(want)) == 1
}

// broadcast publishes a message to every subscriber and returns how many
// received it. Slow clients are skipped (and counted) rather than blocking the
// notification pipeline.
func (s *notificationSSEStream) broadcast(message, eventType, rule string) int {
	seq := s.seq.Add(1)
	now := time.Now().UTC()

	payload := NotificationSSEMessage{
		ID:        strconv.FormatUint(seq, 10),
		Channel:   sseChannelName,
		Event:     eventType,
		Rule:      rule,
		Message:   message,
		Timestamp: now.Format(time.RFC3339),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		// Cannot happen for this struct, but never publish a malformed frame.
		log.Printf("[NotificationSSE] failed to marshal message: %v", err)
		return 0
	}
	frame := fmt.Sprintf("event: notification\ndata: %s\n\n", data)

	s.lastSentAt.Store(now.UnixNano())
	s.totalSent.Add(1)

	s.mu.Lock()
	clients := make([]*notificationSSEClient, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.mu.Unlock()

	delivered := 0
	for _, c := range clients {
		select {
		case c.ch <- frame:
			delivered++
		default:
			c.dropped.Add(1)
		}
	}
	return delivered
}

// heartbeatFrame builds the heartbeat event for a client.
func (s *notificationSSEStream) heartbeatFrame(c *notificationSSEClient) string {
	payload := struct {
		Channel   string `json:"channel"`
		Timestamp string `json:"timestamp"`
		// Interval is the heartbeat period in seconds, so a subscriber can tell
		// how long silence has to last before the connection is really dead
		// without hard-coding this server's configuration.
		Interval    int     `json:"interval"`
		LastMessage *string `json:"last_message"`
		Dropped     uint64  `json:"dropped"`
		Sent        uint64  `json:"sent"`
	}{
		Channel:   sseChannelName,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Interval:  int(s.heartbeatInterval() / time.Second),
		Dropped:   c.dropped.Load(),
		Sent:      s.totalSent.Load(),
	}
	if ns := s.lastSentAt.Load(); ns != 0 {
		t := time.Unix(0, ns).UTC().Format(time.RFC3339)
		payload.LastMessage = &t
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "event: heartbeat\ndata: {}\n\n"
	}
	return fmt.Sprintf("event: heartbeat\ndata: %s\n\n", data)
}

// sseConnectedClients returns the live subscriber count for an "sse" channel
// and 0 for every other channel type. Used by the admin config endpoint to show
// the stream's runtime state alongside its configuration.
func sseConnectedClients(channelType string) int {
	if channelType != "sse" {
		return 0
	}
	return notificationSSE.ClientCount()
}

// syncSSEStream reconciles the stream with cfg: it stays active only while the
// configuration still contains an enabled sse channel. The channel itself is
// (re-)activated by NewSSEChannel as the channels are built, so this only has to
// handle removal.
func syncSSEStream(cfg *NotificationsConfig) {
	if cfg != nil && cfg.Enabled {
		if ch, ok := cfg.Channels[sseChannelName]; ok && ch.Type == "sse" {
			return
		}
	}
	notificationSSE.deactivate()
}

// ─── Channel implementation ───────────────────────────────────────────────────

// SSEChannel implements NotificationChannel by fanning messages out to the
// subscribers of the public SSE endpoint. Delivery is best-effort and never
// blocks: a slow subscriber misses messages rather than stalling the
// notification pipeline, and a message with no subscribers is simply dropped.
type SSEChannel struct {
	name string
}

// NewSSEChannel activates the public stream with cfg and returns the channel
// wrapper the notification manager dispatches through.
func NewSSEChannel(name string, cfg NotificationChannelConfig) *SSEChannel {
	notificationSSE.activate(cfg)
	return &SSEChannel{name: name}
}

func (s *SSEChannel) Name() string { return s.name }
func (s *SSEChannel) Type() string { return "sse" }

// Send publishes message to all subscribers.
func (s *SSEChannel) Send(message string) (ChannelResponse, error) {
	return s.SendWithEvent(message, "", "")
}

// SendWithEvent publishes message along with the triggering event type and rule
// name, which subscribers receive as the "event" and "rule" JSON fields.
// Implements eventAwareSender.
func (s *SSEChannel) SendWithEvent(message, eventType, rule string) (ChannelResponse, error) {
	if !notificationSSE.IsActive() {
		return ChannelResponse{StatusCode: http.StatusServiceUnavailable},
			fmt.Errorf("sse: stream is not active (no password set)")
	}
	delivered := notificationSSE.broadcast(message, eventType, rule)
	body := fmt.Sprintf("delivered to %d subscriber(s)", delivered)
	if delivered == 0 {
		body = "no subscribers connected"
	}
	// SSE delivery is local fan-out with no remote status; report 200 so the
	// admin channel log renders consistently with the HTTP-based channels.
	return ChannelResponse{StatusCode: http.StatusOK, Body: body}, nil
}

// ─── Failed-auth throttle ─────────────────────────────────────────────────────

// sseAuthThrottle counts recent failed password attempts per IP so the public
// endpoint cannot be used to brute-force the stream password.
type sseAuthThrottle struct {
	mu      sync.Mutex
	entries map[string][]time.Time
}

var sseAuthFailures = &sseAuthThrottle{entries: make(map[string][]time.Time)}

// blocked reports whether ip has exhausted its failed-attempt budget.
func (t *sseAuthThrottle) blocked(ip string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.pruneLocked(ip, time.Now())) >= sseAuthMaxFailures
}

// fail records a failed attempt from ip.
func (t *sseAuthThrottle) fail(ip string) {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.entries[ip] = append(t.pruneLocked(ip, now), now)
}

// succeed clears the failure history for ip.
func (t *sseAuthThrottle) succeed(ip string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, ip)
}

// pruneLocked drops expired attempts for ip and returns the surviving ones. It
// also opportunistically evicts other IPs whose history has fully expired,
// keeping the map bounded without a background sweeper.
// Callers must hold t.mu.
func (t *sseAuthThrottle) pruneLocked(ip string, now time.Time) []time.Time {
	cutoff := now.Add(-sseAuthWindow)
	for other, times := range t.entries {
		if other == ip {
			continue
		}
		if len(times) == 0 || times[len(times)-1].Before(cutoff) {
			delete(t.entries, other)
		}
	}
	times := t.entries[ip]
	n := 0
	for _, ts := range times {
		if ts.After(cutoff) {
			times[n] = ts
			n++
		}
	}
	times = times[:n]
	if n == 0 {
		delete(t.entries, ip)
		return nil
	}
	t.entries[ip] = times
	return times
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

// HandleNotificationStream serves the public notification SSE endpoint:
//
//	GET /api/notifications/stream?password=<password>
//
// The password may instead be sent as "Authorization: Bearer <password>".
// limiter caps concurrent connections per IP; sse_max_clients caps the total
// number of subscribers.
func HandleNotificationStream(stream *notificationSSEStream, limiter *SSEIPLimiter, serverConfig *ServerConfig) http.HandlerFunc {
	// reject answers with a status and a machine-readable reason, so a client can
	// tell a capacity problem from a credentials problem.
	reject := func(w http.ResponseWriter, status int, reason, msg string) {
		w.Header().Set(sseReasonHeader, reason)
		http.Error(w, msg, status)
	}

	return func(w http.ResponseWriter, r *http.Request) {
		// A probe (HEAD, or ?probe=1) asks "would a subscription be accepted?"
		// and gets the answer without opening a stream. Without it a client has
		// to open a real connection to discover the status — EventSource never
		// exposes one — and that probe would itself occupy a subscriber slot and
		// a per-IP connection slot, which can turn a healthy stream into a
		// spurious "too many connections".
		probe := r.Method == http.MethodHead || r.URL.Query().Get("probe") == "1"

		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "GET required", http.StatusMethodNotAllowed)
			return
		}

		if !stream.IsActive() {
			reject(w, http.StatusServiceUnavailable, sseReasonDisabled, "notification stream is not enabled")
			return
		}

		ip := getClientIP(r)

		// Refuse IPs that have burned through their failed-attempt budget.
		if sseAuthFailures.blocked(ip) {
			w.Header().Set("Retry-After", strconv.Itoa(int(sseAuthWindow.Seconds())))
			reject(w, http.StatusTooManyRequests, sseReasonAuthThrottled, "too many failed authentication attempts")
			return
		}

		// Password from the Authorization header (preferred) or the query string.
		password := r.URL.Query().Get("password")
		if auth := r.Header.Get("Authorization"); auth != "" {
			if token, ok := strings.CutPrefix(auth, "Bearer "); ok {
				password = strings.TrimSpace(token)
			}
		}

		if !stream.authorise(password) {
			// Only an actual guess counts against the brute-force budget. A
			// request with no password at all is a client asking whether the
			// stream exists, not attacking it — and every page load from a
			// visitor who has not subscribed would otherwise spend one of the
			// ten attempts this IP gets, locking out real subscribers behind the
			// same NAT or proxy.
			if password != "" {
				sseAuthFailures.fail(ip)
				log.Printf("[NotificationSSE] authentication failed from %s", ip)
			}
			reject(w, http.StatusUnauthorized, sseReasonUnauthorized, "unauthorized")
			return
		}
		sseAuthFailures.succeed(ip)

		// Authenticated. A probe reports whether there is room and stops here,
		// holding nothing.
		if probe {
			if !stream.hasCapacity() {
				reject(w, http.StatusServiceUnavailable, sseReasonFull, "subscriber limit reached")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Per-IP concurrent connection limit (bypassed IPs are exempt, matching
		// the other public SSE feeds).
		if serverConfig == nil || !serverConfig.IsIPTimeoutBypassed(ip) {
			release, ok := limiter.Acquire(ip)
			if !ok {
				reject(w, http.StatusTooManyRequests, sseReasonIPLimited, "too many connections from your IP")
				return
			}
			defer release()
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		heartbeat := stream.heartbeatInterval()

		client := &notificationSSEClient{
			ch:     make(chan string, sseClientQueue),
			closed: make(chan struct{}),
		}
		if !stream.register(client) {
			reject(w, http.StatusServiceUnavailable, sseReasonFull, "subscriber limit reached")
			return
		}
		defer stream.unregister(client)

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		log.Printf("[NotificationSSE] subscriber connected (ip=%s, total=%d)", ip, stream.ClientCount())
		defer func() {
			log.Printf("[NotificationSSE] subscriber disconnected (ip=%s)", ip)
		}()

		fmt.Fprint(w, ": connected to the UberSDR notification stream\nretry: 5000\n\n") //nolint:errcheck
		flusher.Flush()

		ticker := time.NewTicker(heartbeat)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-client.closed:
				// Stream disabled or password rotated.
				fmt.Fprint(w, "event: closed\ndata: {\"reason\":\"stream reconfigured\"}\n\n") //nolint:errcheck
				flusher.Flush()
				return
			case frame := <-client.ch:
				if _, err := fmt.Fprint(w, frame); err != nil {
					return
				}
				flusher.Flush()
			case <-ticker.C:
				if _, err := fmt.Fprint(w, stream.heartbeatFrame(client)); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}
}
