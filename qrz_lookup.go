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
	Addr1   string `xml:"addr1"   json:"addr1,omitempty"`
	Addr2   string `xml:"addr2"   json:"addr2,omitempty"`
	State   string `xml:"state"   json:"state,omitempty"`
	Zip     string `xml:"zip"     json:"zip,omitempty"`
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
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
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

// Lookup returns QRZ data for the given callsign.
// The callsign is normalised before the cache is checked or the API is called.
// Returns (nil, nil) when the callsign is not found in the QRZ database.
// Returns a non-nil error only for network/auth failures.
func (s *QRZService) Lookup(rawCallsign string) (*QRZCallsign, error) {
	call := NormaliseCallsign(rawCallsign)
	if call == "" {
		return nil, fmt.Errorf("qrz: empty callsign after normalisation")
	}

	// Check cache first (read lock).
	// cacheGet returns (result, true) on hit (result may be nil = cached not-found),
	// and (nil, false) on miss.
	if cs, hit := s.cacheGet(call); hit {
		return cs, nil
	}

	// Fetch from API
	result, err := s.fetchWithRetry(call)
	if err != nil {
		return nil, err
	}

	// Cache the result (even nil = "not found") to avoid hammering the API
	s.cachePut(call, result)
	return result, nil
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

// authenticate logs in to QRZ and stores the session key.
// Must be called with s.mu held.
func (s *QRZService) authenticate() error {
	params := url.Values{}
	params.Set("username", s.cfg.Username)
	params.Set("password", s.cfg.Password)
	params.Set("agent", qrzUserAgent)

	apiURL := qrzAPIBase + "?" + params.Encode()
	resp, err := s.httpClient.Get(apiURL)
	if err != nil {
		return fmt.Errorf("qrz: auth request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return fmt.Errorf("qrz: reading auth response: %w", err)
	}
	body = qrzStripNamespace(body)

	var db qrzDatabase
	if err := xml.Unmarshal(body, &db); err != nil {
		return fmt.Errorf("qrz: parsing auth response: %w", err)
	}

	if db.Session == nil {
		return fmt.Errorf("qrz: no Session element in auth response")
	}
	if db.Session.Error != "" {
		return fmt.Errorf("qrz: auth error: %s", db.Session.Error)
	}
	if db.Session.Key == "" {
		return fmt.Errorf("qrz: auth succeeded but no session key returned")
	}

	s.sessionKey = db.Session.Key
	s.sessionExp = time.Now().Add(qrzSessionTTL)
	log.Printf("QRZ: authenticated successfully (sub expires: %s)", db.Session.SubExp)
	return nil
}

// ensureSession ensures a valid session key exists, authenticating if needed.
// Must be called with s.mu held.
func (s *QRZService) ensureSession() error {
	if s.sessionKeyValid() {
		return nil
	}
	return s.authenticate()
}

// ---------------------------------------------------------------------------
// API fetch with session-timeout retry
// ---------------------------------------------------------------------------

// fetchWithRetry performs a callsign lookup, re-authenticating once if the
// session has expired.
func (s *QRZService) fetchWithRetry(call string) (*QRZCallsign, error) {
	s.mu.Lock()
	if err := s.ensureSession(); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	key := s.sessionKey
	s.mu.Unlock()

	cs, sessionExpired, err := s.fetchCallsign(call, key)
	if err != nil && !sessionExpired {
		return nil, err
	}

	if sessionExpired {
		// Re-authenticate and retry once
		s.mu.Lock()
		s.sessionKey = "" // force re-auth
		if authErr := s.authenticate(); authErr != nil {
			s.mu.Unlock()
			return nil, fmt.Errorf("qrz: re-auth after session timeout failed: %w", authErr)
		}
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
