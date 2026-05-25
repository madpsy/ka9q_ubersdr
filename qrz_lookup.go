package main

import (
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// qrzAPIBase is the QRZ.com XML API endpoint.
const qrzAPIBase = "https://xmldata.qrz.com/xml/current/"

// qrzUserAgent is sent as the "agent" parameter in every QRZ API request.
// QRZ uses this to identify the calling application.
var qrzUserAgent = "UberSDR/" + Version

// qrzSessionTTL is how long a QRZ session key is considered valid before
// we proactively re-authenticate (QRZ keys expire after ~24 h of inactivity).
const qrzSessionTTL = 20 * time.Hour

// qrzCacheTTL is how long a callsign lookup result is cached.
const qrzCacheTTL = 24 * time.Hour

// ---------------------------------------------------------------------------
// XML response types
// ---------------------------------------------------------------------------

// qrzDatabase is the top-level XML envelope returned by every QRZ API call.
// QRZ responses carry xmlns="http://xmldata.qrz.com" which would require every
// leaf field tag to be namespace-qualified.  We strip the xmlns attribute before
// parsing (see qrzStripNamespace) so plain unqualified tags work throughout.
type qrzDatabase struct {
	XMLName  xml.Name     `xml:"QRZDatabase"`
	Callsign *QRZCallsign `xml:"Callsign"`
	Session  *qrzSession  `xml:"Session"`
}

// qrzSession carries the session key and any error message from QRZ.
type qrzSession struct {
	Key    string `xml:"Key"`
	Error  string `xml:"Error"`
	SubExp string `xml:"SubExp"`
	GMTime string `xml:"GMTime"`
	Count  int    `xml:"Count"`
	Remark string `xml:"Remark"`
}

// QRZCallsign contains the operator data returned for a callsign lookup.
// All fields are optional — QRZ only returns fields that are populated in
// the database for that callsign.
type QRZCallsign struct {
	// Core identification
	Call    string `xml:"call"    json:"call"`
	Aliases string `xml:"aliases" json:"aliases,omitempty"`
	DXCC    int    `xml:"dxcc"    json:"dxcc,omitempty"`

	// Operator name
	FName    string `xml:"fname"    json:"fname,omitempty"`
	Name     string `xml:"name"     json:"name,omitempty"`
	NameFmt  string `xml:"name_fmt" json:"name_fmt,omitempty"`
	Nickname string `xml:"nickname" json:"nickname,omitempty"`
	ATTN     string `xml:"attn"     json:"attn,omitempty"`

	// Address
	Addr1   string `xml:"addr1"   json:"-"` // street address — never serialised to the public API
	Addr2   string `xml:"addr2"   json:"addr2,omitempty"`
	State   string `xml:"state"   json:"state,omitempty"`
	Zip     string `xml:"zip"     json:"-"` // postcode — never serialised to the public API
	Country string `xml:"country" json:"country,omitempty"`
	Land    string `xml:"land"    json:"land,omitempty"`
	CCode   int    `xml:"ccode"   json:"ccode,omitempty"`
	FIPS    string `xml:"fips"    json:"fips,omitempty"`
	County  string `xml:"county"  json:"county,omitempty"`

	// Geography
	Lat  float64 `xml:"lat"  json:"lat,omitempty"`
	Lon  float64 `xml:"lon"  json:"lon,omitempty"`
	Grid string  `xml:"grid" json:"grid,omitempty"`

	// Licence
	EfDate  string `xml:"efdate"  json:"efdate,omitempty"`
	ExpDate string `xml:"expdate" json:"expdate,omitempty"`
	Trustee string `xml:"trustee" json:"trustee,omitempty"`
	Class   string `xml:"class"   json:"class,omitempty"`
	Codes   string `xml:"codes"   json:"codes,omitempty"`

	// Contact / profile
	Email     string `xml:"email"     json:"-"` // never serialised to the public API
	URL       string `xml:"url"       json:"url,omitempty"`
	QSLMgr    string `xml:"qslmgr"   json:"qslmgr,omitempty"`
	Image     string `xml:"image"     json:"image,omitempty"`
	ImageInfo string `xml:"imageinfo" json:"imageinfo,omitempty"`
	Bio       int    `xml:"bio"       json:"bio,omitempty"`
	BioDate   string `xml:"biodate"   json:"biodate,omitempty"`
	ModDate   string `xml:"moddate"   json:"moddate,omitempty"`
	UViews    int    `xml:"u_views"   json:"u_views,omitempty"`
	Serial    int    `xml:"serial"    json:"serial,omitempty"`

	// Time zone
	TimeZone  string `xml:"TimeZone"  json:"timezone,omitempty"`
	GMTOffset int    `xml:"GMTOffset" json:"gmtoffset,omitempty"`
	DST       string `xml:"DST"       json:"dst,omitempty"`

	// US geography
	MSA      int `xml:"MSA"      json:"msa,omitempty"`
	AreaCode int `xml:"AreaCode" json:"area_code,omitempty"`

	// QSL / awards
	EqSL string `xml:"eqsl" json:"eqsl,omitempty"`
	MqSL string `xml:"mqsl" json:"mqsl,omitempty"`
	LoTW string `xml:"lotw" json:"lotw,omitempty"`

	// Zones
	CQZone  int `xml:"cqzone"  json:"cqzone,omitempty"`
	ITUZone int `xml:"ituzone" json:"ituzone,omitempty"`

	// Miscellaneous
	Born   int    `xml:"born"   json:"born,omitempty"`
	User   string `xml:"user"   json:"user,omitempty"`
	IOTA   string `xml:"iota"   json:"iota,omitempty"`
	GeoLoc string `xml:"geoloc" json:"geoloc,omitempty"`
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

type qrzCacheEntry struct {
	callsign  *QRZCallsign
	expiresAt time.Time
}

// ---------------------------------------------------------------------------
// QRZService
// ---------------------------------------------------------------------------

// qrzMaxConcurrentFetches is the maximum number of simultaneous outbound HTTP
// requests that QRZService will make to the QRZ.com API at any one time.
// singleflight already ensures at most one in-flight request per callsign, so
// this cap applies across distinct callsigns.
const qrzMaxConcurrentFetches = 5

// QRZService provides callsign lookups via the QRZ.com XML Data API.
// It manages session key lifecycle and caches results for 24 hours.
// All public methods are safe for concurrent use.
type QRZService struct {
	cfg          QRZConfig
	cacheMaxSize int // maximum number of entries; 0 = unlimited (not recommended)

	mu         sync.Mutex
	sessionKey string
	sessionExp time.Time

	cacheMu sync.RWMutex
	cache   map[string]*qrzCacheEntry // key: normalised uppercase callsign

	// sf deduplicates concurrent in-flight lookups for the same callsign.
	// When N goroutines all miss the cache for the same key simultaneously,
	// only one HTTP request is made to QRZ; the rest wait and share the result.
	sf singleflight.Group

	// authSf deduplicates concurrent session-refresh attempts.  When the QRZ
	// session expires and multiple goroutines detect it simultaneously, only
	// one re-authentication HTTP call is made; all others wait and share the
	// new session key.  This is kept separate from sf so that a session refresh
	// does not hold any callsign's singleflight key while the auth HTTP call is
	// in flight.
	authSf singleflight.Group

	// fetchSem is a semaphore that caps the number of simultaneous outbound
	// HTTP requests to QRZ.com.  A token is acquired by the singleflight
	// leader just before the HTTP call and released immediately after,
	// so waiters sharing a flight never consume a slot.
	fetchSem chan struct{}

	httpClient *http.Client
}

// NewQRZService creates a new QRZService.  It does NOT authenticate immediately;
// the first lookup will trigger authentication.
// cacheMaxSize is the maximum number of callsign entries to hold in memory;
// pass 0 to disable the limit (not recommended for public instances).
func NewQRZService(cfg QRZConfig, cacheMaxSize int) *QRZService {
	return &QRZService{
		cfg:          cfg,
		cacheMaxSize: cacheMaxSize,
		cache:        make(map[string]*qrzCacheEntry),
		// sf is a zero-value singleflight.Group — no initialisation needed.
		fetchSem: make(chan struct{}, qrzMaxConcurrentFetches),
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

// ---------------------------------------------------------------------------
// Callsign normalisation
// ---------------------------------------------------------------------------

// knownSuffixes lists portable/mobile/special suffixes that should be stripped
// before a callsign is looked up.  All comparisons are done in uppercase.
var knownSuffixes = []string{
	"PORTABLE", "MOBILE", "QRP",
	"MM", "AM", "PM",
	"P", "M", "A", "B",
}

// NormaliseCallsign strips portable/mobile suffixes and country-prefix overlays
// from a callsign so that e.g. "MM3NDH/P", "G/MM3NDH", "W1AW/QRP" all resolve
// to the base callsign before the cache key is checked.
//
// Rules applied in order:
//  1. Uppercase the input.
//  2. Split on "/".
//  3. If there are exactly two parts:
//     a. If the right part is a known suffix → keep the left part.
//     b. If the left part looks like a country prefix (1–3 letters, no digits)
//     → keep the right part.
//     c. Otherwise keep the longer part (heuristic for e.g. "W1AW/KH6").
//  4. Return the result.
func NormaliseCallsign(call string) string {
	call = strings.ToUpper(strings.TrimSpace(call))
	if call == "" {
		return call
	}

	parts := strings.SplitN(call, "/", 2)
	if len(parts) == 1 {
		return call
	}

	left, right := parts[0], parts[1]

	// Rule 3a — right part is a known portable/mobile suffix
	for _, sfx := range knownSuffixes {
		if right == sfx {
			return left
		}
	}

	// Rule 3b — left part is a pure-alpha country prefix (e.g. "G", "VK", "OE")
	if isAlphaOnly(left) && len(left) <= 3 {
		return right
	}

	// Rule 3c — keep the longer part
	if len(right) > len(left) {
		return right
	}
	return left
}

// isAlphaOnly returns true if s contains only ASCII letters.
func isAlphaOnly(s string) bool {
	for _, c := range s {
		if c < 'A' || c > 'Z' {
			return false
		}
	}
	return len(s) > 0
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// lookupResult is the value type stored inside the singleflight group so that
// both the callsign pointer and any error can be returned together.
type lookupResult struct {
	cs  *QRZCallsign
	err error
}

// Lookup returns QRZ data for the given callsign.
// The callsign is normalised before the cache is checked or the API is called.
// Returns (nil, nil) when the callsign is not found in the QRZ database.
// Returns a non-nil error only for network/auth failures.
//
// Concurrent calls for the same callsign that all miss the cache are
// deduplicated via a singleflight group: exactly one HTTP request is made to
// QRZ and the result is shared with all waiting callers.  The winning goroutine
// writes the result to the cache; the others return the shared value directly
// without a redundant cache write.
func (s *QRZService) Lookup(rawCallsign string) (*QRZCallsign, error) {
	call := NormaliseCallsign(rawCallsign)
	if call == "" {
		return nil, fmt.Errorf("qrz: empty callsign after normalisation")
	}

	// Fast path: cache hit (shared read lock, no singleflight overhead).
	// cacheGet returns (result, true) on hit (result may be nil = cached not-found),
	// and (nil, false) on miss.
	if cs, hit := s.cacheGet(call); hit {
		return cs, nil
	}

	// Slow path: deduplicate concurrent misses for the same callsign.
	//
	// sf.Do blocks all callers with the same key until the first one completes.
	// The closure is executed by exactly one goroutine ("the leader"); all
	// others ("waiters") receive the same return value once the leader finishes.
	//
	// Safety notes:
	//   • The returned *QRZCallsign is never mutated after creation, so sharing
	//     the pointer across goroutines is safe.
	//   • Only the leader writes to the cache (shared == false).  Waiters skip
	//     the cache write to avoid redundant lock contention.
	//   • If the leader's goroutine panics, singleflight re-panics in all
	//     waiters — this is the correct behaviour for an unrecoverable error.
	v, err, _ := s.sf.Do(call, func() (interface{}, error) {
		// Re-check the cache inside the flight: a previous flight for this
		// key may have just finished and populated the cache while we were
		// waiting to enter sf.Do.
		if cs, hit := s.cacheGet(call); hit {
			return &lookupResult{cs: cs}, nil
		}

		// Acquire a semaphore slot before making the outbound HTTP request.
		// This caps the total number of simultaneous QRZ API calls across all
		// distinct callsigns.  The slot is released as soon as fetchWithRetry
		// returns, before the result is written to the cache or returned to
		// waiters — so the slot is held for the minimum possible time.
		s.fetchSem <- struct{}{}
		result, fetchErr := s.fetchWithRetry(call)
		<-s.fetchSem

		if fetchErr != nil {
			return nil, fetchErr
		}

		// Cache the result (even nil = "not found") to avoid hammering the API.
		// Only the leader reaches here; waiters share this cached value.
		s.cachePut(call, result)
		return &lookupResult{cs: result}, nil
	})

	if err != nil {
		return nil, err
	}

	return v.(*lookupResult).cs, nil
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

// cacheGet returns (callsign, true) on a valid cache hit, or (nil, false) on miss/expiry.
// A hit with a nil callsign means the callsign was previously looked up and not found.
func (s *QRZService) cacheGet(call string) (*QRZCallsign, bool) {
	s.cacheMu.RLock()
	entry, ok := s.cache[call]
	s.cacheMu.RUnlock()
	if !ok {
		return nil, false
	}
	if time.Now().After(entry.expiresAt) {
		// Expired — delete under write lock
		s.cacheMu.Lock()
		delete(s.cache, call)
		s.cacheMu.Unlock()
		return nil, false
	}
	return entry.callsign, true // callsign may be nil (cached "not found")
}

func (s *QRZService) cachePut(call string, cs *QRZCallsign) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()

	// Always write the entry first.
	s.cache[call] = &qrzCacheEntry{
		callsign:  cs,
		expiresAt: time.Now().Add(qrzCacheTTL),
	}

	// Enforce the size cap (0 = unlimited).
	if s.cacheMaxSize <= 0 || len(s.cache) <= s.cacheMaxSize {
		return
	}

	// Phase 1: evict all expired entries.
	now := time.Now()
	for k, e := range s.cache {
		if now.After(e.expiresAt) {
			delete(s.cache, k)
		}
	}
	if len(s.cache) <= s.cacheMaxSize {
		return
	}

	// Phase 2: still over limit — evict the entries closest to expiry
	// (they have the least remaining value) until we're back under the cap.
	type kv struct {
		key       string
		expiresAt time.Time
	}
	entries := make([]kv, 0, len(s.cache))
	for k, e := range s.cache {
		entries = append(entries, kv{k, e.expiresAt})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].expiresAt.Before(entries[j].expiresAt)
	})
	for _, e := range entries {
		if len(s.cache) <= s.cacheMaxSize {
			break
		}
		delete(s.cache, e.key)
	}
}

// CacheSize returns the number of entries currently in the cache.
func (s *QRZService) CacheSize() int {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()
	return len(s.cache)
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

// sessionKeyValid returns true if we have a non-expired session key.
// Must be called with s.mu held.
func (s *QRZService) sessionKeyValid() bool {
	return s.sessionKey != "" && time.Now().Before(s.sessionExp)
}

// qrzStripNamespace removes the xmlns attribute from QRZ XML responses before
// parsing.  QRZ returns xmlns="http://xmldata.qrz.com" on the root element,
// which causes Go's xml package to require namespace-qualified tags on every
// field.  Stripping it lets us use plain unqualified tags throughout.
func qrzStripNamespace(b []byte) []byte {
	return []byte(strings.ReplaceAll(string(b), ` xmlns="http://xmldata.qrz.com"`, ""))
}

// testQRZCredentials performs a one-shot QRZ login with the supplied credentials
// and returns the subscription expiry string on success, or an error on failure.
// It does NOT affect the global QRZService session state.
func testQRZCredentials(username, password string) (subExp string, err error) {
	params := url.Values{}
	params.Set("username", username)
	params.Set("password", password)
	params.Set("agent", qrzUserAgent)

	apiURL := qrzAPIBase + "?" + params.Encode()
	resp, err := http.Get(apiURL) //nolint:gosec // URL is constructed from admin-supplied credentials
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", fmt.Errorf("reading response: %w", err)
	}
	body = qrzStripNamespace(body)

	var db qrzDatabase
	if err := xml.Unmarshal(body, &db); err != nil {
		return "", fmt.Errorf("parsing response: %w", err)
	}
	if db.Session == nil {
		return "", fmt.Errorf("no Session element in response")
	}
	if db.Session.Error != "" {
		return "", fmt.Errorf("%s", db.Session.Error)
	}
	if db.Session.Key == "" {
		return "", fmt.Errorf("login succeeded but no session key returned")
	}
	return db.Session.SubExp, nil
}

// doAuthHTTP performs the QRZ login HTTP request and returns the new session
// key and subscription expiry.  It does NOT touch any QRZService state and
// must NOT be called with s.mu held, since it makes a network call.
func (s *QRZService) doAuthHTTP() (key, subExp string, err error) {
	params := url.Values{}
	params.Set("username", s.cfg.Username)
	params.Set("password", s.cfg.Password)
	params.Set("agent", qrzUserAgent)

	apiURL := qrzAPIBase + "?" + params.Encode()
	resp, err := s.httpClient.Get(apiURL)
	if err != nil {
		return "", "", fmt.Errorf("qrz: auth request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", "", fmt.Errorf("qrz: reading auth response: %w", err)
	}
	body = qrzStripNamespace(body)

	var db qrzDatabase
	if err := xml.Unmarshal(body, &db); err != nil {
		return "", "", fmt.Errorf("qrz: parsing auth response: %w", err)
	}
	if db.Session == nil {
		return "", "", fmt.Errorf("qrz: no Session element in auth response")
	}
	if db.Session.Error != "" {
		return "", "", fmt.Errorf("qrz: auth error: %s", db.Session.Error)
	}
	if db.Session.Key == "" {
		return "", "", fmt.Errorf("qrz: auth succeeded but no session key returned")
	}
	return db.Session.Key, db.Session.SubExp, nil
}

// refreshSession obtains a fresh session key, deduplicating concurrent
// refresh attempts via authSf so that only one HTTP auth call is made even
// when many goroutines detect an expired session simultaneously.
// It must NOT be called with s.mu held.
func (s *QRZService) refreshSession() error {
	_, err, _ := s.authSf.Do("__session__", func() (interface{}, error) {
		// Re-check before making the network call: a concurrent goroutine may
		// have already refreshed the session while we were waiting to enter
		// authSf.Do.
		s.mu.Lock()
		valid := s.sessionKeyValid()
		s.mu.Unlock()
		if valid {
			return nil, nil
		}

		// HTTP call is made WITHOUT holding s.mu so other goroutines can still
		// read the (old) session key while the auth request is in flight.
		newKey, subExp, err := s.doAuthHTTP()
		if err != nil {
			return nil, err
		}

		// Write the new session key under the lock.
		s.mu.Lock()
		s.sessionKey = newKey
		s.sessionExp = time.Now().Add(qrzSessionTTL)
		s.mu.Unlock()

		log.Printf("QRZ: authenticated successfully (sub expires: %s)", subExp)
		return nil, nil
	})
	return err
}

// ---------------------------------------------------------------------------
// API fetch with session-timeout retry
// ---------------------------------------------------------------------------

// fetchWithRetry performs a callsign lookup, re-authenticating once if the
// session has expired.  Session refresh is handled via authSf so that the
// callsign's singleflight key is never held during the auth HTTP call —
// preventing cached-callsign lookups from blocking behind a session refresh.
func (s *QRZService) fetchWithRetry(call string) (*QRZCallsign, error) {
	// Ensure we have a valid session before the first fetch attempt.
	// refreshSession uses authSf internally, so concurrent callers share one
	// auth HTTP call rather than each making their own.
	if err := s.refreshSession(); err != nil {
		return nil, err
	}

	s.mu.Lock()
	key := s.sessionKey
	s.mu.Unlock()

	cs, sessionExpired, err := s.fetchCallsign(call, key)
	if err != nil && !sessionExpired {
		return nil, err
	}

	if sessionExpired {
		// The session expired between our check and the actual API call.
		// Force a refresh (authSf deduplicates concurrent attempts) and retry.
		if authErr := s.refreshSession(); authErr != nil {
			return nil, fmt.Errorf("qrz: re-auth after session timeout failed: %w", authErr)
		}

		s.mu.Lock()
		key = s.sessionKey
		s.mu.Unlock()

		cs, _, err = s.fetchCallsign(call, key)
		if err != nil {
			return nil, err
		}
	}

	return cs, nil
}

// fetchCallsign performs a single callsign lookup using the provided session key.
// Returns (callsign, sessionExpired, error).
// sessionExpired=true means the caller should re-authenticate and retry.
func (s *QRZService) fetchCallsign(call, sessionKey string) (*QRZCallsign, bool, error) {
	params := url.Values{}
	params.Set("s", sessionKey)
	params.Set("callsign", call)

	apiURL := qrzAPIBase + "?" + params.Encode()
	resp, err := s.httpClient.Get(apiURL)
	if err != nil {
		return nil, false, fmt.Errorf("qrz: lookup request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return nil, false, fmt.Errorf("qrz: reading lookup response: %w", err)
	}
	body = qrzStripNamespace(body)

	var db qrzDatabase
	if err := xml.Unmarshal(body, &db); err != nil {
		return nil, false, fmt.Errorf("qrz: parsing lookup response: %w", err)
	}

	if db.Session != nil && db.Session.Error != "" {
		errMsg := db.Session.Error
		// Detect session expiry errors
		if strings.Contains(strings.ToLower(errMsg), "session timeout") ||
			strings.Contains(strings.ToLower(errMsg), "invalid session") {
			return nil, true, fmt.Errorf("qrz: session expired: %s", errMsg)
		}
		// "Not found" is not an error — return nil callsign
		if strings.HasPrefix(strings.ToLower(errMsg), "not found") {
			return nil, false, nil
		}
		// Subscription required
		if strings.Contains(strings.ToLower(errMsg), "subscription") {
			return nil, false, fmt.Errorf("qrz: %s (XML Data subscription required)", errMsg)
		}
		return nil, false, fmt.Errorf("qrz: lookup error: %s", errMsg)
	}

	// Update session key if QRZ rotated it
	if db.Session != nil && db.Session.Key != "" && db.Session.Key != sessionKey {
		s.mu.Lock()
		s.sessionKey = db.Session.Key
		s.sessionExp = time.Now().Add(qrzSessionTTL)
		s.mu.Unlock()
	}

	return db.Callsign, false, nil
}
