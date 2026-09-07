package main

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Announced DX Operations — which DXpeditions are on the air now, which are
// coming, on what bands and in what modes, and where they are relative to this
// receiver. Served at /api/dxpeditions for the calendar panel.
//
// Source: NG3K's ADXO feed (https://www.ng3k.com/adxo.xml), Bill Feidt's
// long-running announcement list, published as RSS 2.0.
//
// The same shape of thing as drm_schedule.go and eibi.go, and deliberately
// built the same way: a background goroutine fetches a public feed on an
// interval, parses it into memory, and never writes it to disk. Nothing here
// blocks startup, and a failed fetch keeps whatever was already loaded rather
// than emptying the list.
//
// Why the XML and not the HTML page: ADXO also publishes as a table at
// /Misc/adxo.html, which is what most consumers scrape. The RSS carries the
// same data with the row structure already explicit, and the operation's own
// website arrives as <link> rather than as an anchor buried in a table cell.
// Fetching it server-side is also the only option available — ng3k.com sends
// no CORS header, so the page itself could never have read either form.
//
// ── The feed's shape, and what can be trusted in it ─────────────────────────
//
// Every <item> carries a <description> of exactly six lines, positional, the
// first five ending in " --":
//
//	Aug 25-Oct 10, 2026 --            the announced run
//	Namibia --                        DXCC entity
//	V51WH --                          callsign, OR a bare prefix (see below)
//	QSL: DK2WH --                     QSL route
//	Source: MM0NDX (Jul 5, 2026) --   who announced it, and when
//	By DK2WH fm nr Omaruru; 160-6m, incl 60m; QRV as V55Y in CQWW RTTY Contest
//
// That last line is free text typed by a human. Bands, modes, grid square, IOTA
// reference and secondary callsigns are pulled out of it on a best-effort
// basis, and the raw line is ALWAYS shipped alongside them as `info`. When the
// parse misses something — "80-10m, perhaps 160m" yields 80m through 10m and
// drops the 160m — the client can still show what the announcement actually
// said. Parse for filtering and sorting; display the original.
//
// Roughly a third of the entries name a bare PREFIX rather than a callsign
// ("TF", "J3", "9N", "HK0"), because an operation is announced before its call
// is issued. Those carry prefix_only=true, and nothing downstream may match
// them against spots: a bare "FO" would tag every unrelated FO4BM on the band.
//
// The feed carries no <pubDate> and no <guid>, so items have neither a stable
// identity nor a per-item timestamp. It does send ETag and Last-Modified, so
// the refresh is a conditional GET and usually costs a 304 and no body.

const (
	adxoURL = "https://www.ng3k.com/adxo.xml"

	// The announcements move at the pace of someone typing them up, so six
	// hours is already far more often than the data changes. It stays this
	// frequent because the fetch is conditional: an unchanged feed answers 304
	// with no body, which costs ng3k a header round-trip.
	adxoRefreshInt = 6 * time.Hour

	adxoHTTPTimeout = 30 * time.Second

	// Hard ceiling on the transfer. The feed is ~20 KB; 2 MB is four orders of
	// margin and still bounds what a redirected or hijacked URL can hand us.
	adxoMaxBytes = 2 * 1024 * 1024

	// The same startup delay EiBi and DRM use, for the same reason: a server in
	// a crash loop must not hammer someone else's site on every restart.
	adxoStartDelay = 2 * time.Minute

	// Retries after the first attempt — four transfers in all, waiting 2s, 4s
	// then 8s between them. Only the TRANSFER is retried: a parse failure means
	// the format has changed and will fail identically every time.
	adxoRetries = 3

	// When every attempt of a refresh fails and we have data already, the next
	// refresh is simply the next scheduled one — the previous dataset is served
	// in the meantime and a calendar that changes weekly is not worth a hurried
	// retry. When we have NOTHING, that reasoning does not hold: a receiver that
	// came up before its network settled would show an empty calendar for six
	// hours, which is the failure most likely to actually happen. So that case
	// alone comes back sooner.
	adxoEmptyRetry = 30 * time.Minute

	// Past this, data that did load is no longer presented as current. Announced
	// operations are published weeks ahead, so a two-day-old copy is still
	// right; this is about telling the client that nobody has been able to
	// reach ng3k for two days, not about hiding the list.
	adxoStaleAfter = 48 * time.Hour
)

// adxoRetryDelay is the first backoff step, doubling on each retry: 2s, 4s, 8s.
// A var rather than a const only so the failure paths can be tested without
// spending fourteen seconds asleep.
var adxoRetryDelay = 2 * time.Second

// DXpedition is one announced operation, as parsed from the feed and then
// enriched with what this receiver can say about it.
type DXpedition struct {
	// Call is the callsign to listen for, uppercased.
	//
	// Usually the announcement's own callsign field. When that field is only a
	// DXCC prefix — the operation announced before its licence came through —
	// and the free text goes on to say what will actually be on the air, this is
	// the RECOVERED callsign and AnnouncedAs carries the prefix. Call is then
	// always the best identity available and a consumer never has to know which
	// of the two it got.
	Call string `json:"call"`
	// AnnouncedAs is the source's own callsign field, present only when it is
	// not Call — that is, only when a callsign was recovered from the free text.
	// Kept so a row can still be matched against the announcement it came from.
	AnnouncedAs string `json:"announced_as,omitempty"`
	// PrefixOnly says Call is STILL a bare prefix: the field was one, and
	// nothing in the announcement said what the callsign would be. Two entries
	// in a sampled feed of 57.
	//
	// Never match one of these against spots or logs — a bare "FO" would tag
	// every unrelated FO4BM on the band. Note that this is the whole of that
	// warning: an entry whose callsign was recovered is NOT prefix-only, because
	// there is now something real to match.
	PrefixOnly bool `json:"prefix_only"`
	// Entity is the DXCC entity as the announcement names it ("Namibia").
	Entity string `json:"entity"`

	// StartUnix is 00:00:00 UTC on the first announced day; EndUnix is
	// 23:59:59 UTC on the last, so the range is INCLUSIVE of both days and
	// start <= now <= end is the whole of the "on the air" test.
	StartUnix int64 `json:"start_unix"`
	EndUnix   int64 `json:"end_unix"`
	// Dates is the source's own printed range ("Aug 25-Oct 10, 2026"), kept so
	// a client can show what was announced rather than a re-formatting of it.
	Dates string `json:"dates"`
	// Active is start <= now <= end, evaluated when the request is served.
	Active bool `json:"active"`

	// Bands and Modes are best-effort extractions from Info. An empty list
	// means "the announcement did not say, or did not say in a form we read" —
	// never "none".
	Bands []string `json:"bands,omitempty"`
	Modes []string `json:"modes,omitempty"`
	// Grid is a 6-character Maidenhead locator when the announcement carries
	// one, which places the operation exactly rather than at its entity's
	// centroid. IOTA is an island reference ("OC-008") when named.
	Grid string `json:"grid,omitempty"`
	IOTA string `json:"iota,omitempty"`
	// OperatingCalls are the callsigns expected on the air, recovered from the
	// free text when Call is only a prefix.
	//
	// An announcement made before the operation's call was issued still very
	// often SAYS what it will be, a line later: "PJ2 … By K5SL as PJ2/K5SL".
	// Fifteen of the twenty-one prefix-only entries in a sampled feed name one,
	// and a few name several because several operators are going. Empty when the
	// announcement really has not said — which is the only case where nothing
	// can be listened for.
	//
	// The first of these IS Call — the same fact, promoted. The list is here for
	// the operations sending several operators, where the others are worth
	// listening for too. Empty when the announcement already carried a
	// callsign, because then there was nothing to recover.
	OperatingCalls []string `json:"operating_calls,omitempty"`
	// AlsoCalls are further callsigns the announcement mentions that are NOT
	// this operation's own ("QRV as V55Y in CQWW RTTY Contest"). Secondary by
	// definition — a contest call, a home call, a second operation — so they are
	// listed, never substituted for Call.
	AlsoCalls []string `json:"also_calls,omitempty"`

	QSL    string `json:"qsl,omitempty"`
	Source string `json:"source,omitempty"`
	// Info is the announcement's free-text line, verbatim and always present.
	Info string `json:"info"`
	// Website is the operation's own page, present only when the feed linked
	// somewhere other than the generic ADXO page.
	Website string `json:"website,omitempty"`

	// ── Derived here, not carried by the feed ──────────────────────────────
	Country string `json:"country,omitempty"`
	// CountryCode is ISO 3166-1 alpha-2, which is what a client turns into a
	// flag. Empty for the entities that have no country code of their own —
	// Antarctica, the international waters callsigns, and the handful of
	// entities CTY.DAT carries without an ISO mapping.
	CountryCode string `json:"country_code,omitempty"`
	Continent   string `json:"continent,omitempty"`
	// Latitude/Longitude are null when neither a grid nor a CTY match placed
	// the operation. Pointers because 0,0 is a real position in the Gulf of
	// Guinea and must not be indistinguishable from "unknown".
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
	// Approx says the position is a DXCC entity's centroid rather than the
	// announcement's own grid square — a whole country wide, not a locator.
	Approx bool `json:"approx"`
	// PositionSource is what placed it: "grid" (a locator in the announcement),
	// "entity" (the centroid of the entity the announcement names) or
	// "callsign" (the centroid of the entity the CALL belongs to, which for a
	// DXpedition is the weakest of the three). Empty when unplaced. Shipped so
	// a client can say how much to trust a pin rather than having to guess from
	// `approx` alone.
	PositionSource string `json:"position_source,omitempty"`
	// DistanceKm and BearingDeg are from this receiver, null when unplaced or
	// when the receiver has no coordinates configured.
	DistanceKm *float64 `json:"distance_km"`
	BearingDeg *float64 `json:"bearing_deg"`
	// InRange is true when at least one announced band overlaps this
	// receiver's tuning range — and also when no bands were announced, since
	// "we could not read the bands" is not the same as "you cannot hear it".
	InRange bool `json:"in_range"`
}

// ── The feed as XML ─────────────────────────────────────────────────────────

type adxoFeed struct {
	XMLName xml.Name   `xml:"rss"`
	Items   []adxoItem `xml:"channel>item"`
}

type adxoItem struct {
	Title       string `xml:"title"`
	Description string `xml:"description"`
	Link        string `xml:"link"`
}

// DXpeditions holds the parsed calendar and refreshes it every six hours.
type DXpeditions struct {
	mu          sync.RWMutex
	entries     []DXpedition
	loadedAt    time.Time
	lastAttempt time.Time
	lastError   string
	failures    int // consecutive failed refreshes, reset by a success
	// Validators from the last successful transfer, replayed as If-None-Match /
	// If-Modified-Since so an unchanged feed answers 304 with no body.
	etag         string
	lastModified string

	// Receiver context, captured at construction. All of it is immutable for
	// the life of the process (Config.Receiver is resolved once in LoadConfig
	// and then frozen), so entries can be enriched at refresh time — once every
	// six hours — rather than on every request.
	siteLat, siteLon float64
	minFreq, maxFreq uint64

	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewDXpeditions returns a calendar fetcher, or nil (disabled) when the config
// turns it off. A nil *DXpeditions is safe to Start, Stop and hand to the
// handler; it simply reports enabled=false.
func NewDXpeditions(config *Config) *DXpeditions {
	if config == nil {
		return nil
	}
	if config.DXpeditions.Enabled != nil && !*config.DXpeditions.Enabled {
		return nil
	}
	return &DXpeditions{
		siteLat:  config.Admin.GPS.Lat,
		siteLon:  config.Admin.GPS.Lon,
		minFreq:  config.Receiver.MinFreq(),
		maxFreq:  config.Receiver.MaxFreq(),
		stopChan: make(chan struct{}),
	}
}

// Start launches the background refresh and returns immediately.
func (d *DXpeditions) Start() error {
	if d == nil {
		log.Printf("DXpeditions: disabled — /api/dxpeditions will report no calendar")
		return nil
	}
	log.Printf("DXpeditions: starting (initial fetch in %s, refresh interval: %s)",
		adxoStartDelay, adxoRefreshInt)
	d.wg.Add(1)
	go d.refreshLoop()
	return nil
}

// Stop shuts the refresh goroutine down.
func (d *DXpeditions) Stop() {
	if d == nil {
		return
	}
	close(d.stopChan)
	d.wg.Wait()
	log.Printf("DXpeditions: stopped")
}

// refreshLoop fetches after the startup delay and then every six hours.
//
// A timer rather than a ticker, because the interval is not quite fixed: a
// refresh that failed with nothing yet loaded comes back sooner than one that
// failed with a calendar already in hand.
func (d *DXpeditions) refreshLoop() {
	defer d.wg.Done()

	delay := adxoStartDelay
	for {
		select {
		case <-d.stopChan:
			return
		case <-time.After(delay):
		}

		if err := d.refresh(); err != nil {
			d.mu.RLock()
			had := len(d.entries)
			d.mu.RUnlock()
			if had == 0 {
				delay = adxoEmptyRetry
				log.Printf("DXpeditions: load failed: %v — nothing to show, retrying in %s", err, delay)
			} else {
				delay = adxoRefreshInt
				log.Printf("DXpeditions: refresh failed: %v — serving the %d entries already loaded, next try in %s",
					err, had, delay)
			}
			continue
		}
		delay = adxoRefreshInt
	}
}

// refresh fetches the feed and, when it has changed, replaces the calendar.
// On any failure the previous dataset is left exactly as it is.
func (d *DXpeditions) refresh() error {
	return d.refreshFrom(adxoURL)
}

// refreshFrom is refresh against a given URL, so the failure and 304 paths can
// be tested without waiting on the real one.
func (d *DXpeditions) refreshFrom(url string) error {
	d.mu.RLock()
	etag, lastMod := d.etag, d.lastModified
	d.mu.RUnlock()

	data, notModified, newETag, newLastMod, err := d.fetchWithRetry(url, etag, lastMod)
	if err != nil {
		d.mu.Lock()
		d.lastAttempt = time.Now()
		d.lastError = err.Error()
		d.failures++
		d.mu.Unlock()
		return err
	}

	if notModified {
		// The feed has not changed since the last successful fetch. loadedAt
		// deliberately stays where it was — it stamps the DATA, and the data is
		// the same data. lastAttempt is what says we just checked, and it is
		// what the staleness test reads for exactly this reason.
		d.mu.Lock()
		recovered := d.failures
		d.lastAttempt = time.Now()
		d.lastError = ""
		d.failures = 0
		n := len(d.entries)
		d.mu.Unlock()
		if recovered > 0 {
			log.Printf("DXpeditions: recovered after %d failed refresh(es)", recovered)
		}
		log.Printf("DXpeditions: unchanged (HTTP 304) — keeping %d entries", n)
		return nil
	}

	entries, err := parseADXO(data)
	if err != nil {
		d.mu.Lock()
		d.lastAttempt = time.Now()
		d.lastError = err.Error()
		d.failures++
		d.mu.Unlock()
		return err
	}

	// Enrich once here rather than per request: the list is read far more often
	// than it is fetched, and none of the inputs (CTY, the receiver span, the
	// site coordinates) change between refreshes.
	for i := range entries {
		d.enrich(&entries[i])
	}

	// Sorted once here for the same reason. Chronological is what a calendar
	// wants; the callsign breaks ties so the order is stable across refreshes
	// rather than following the feed's own arrangement.
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].StartUnix != entries[j].StartUnix {
			return entries[i].StartUnix < entries[j].StartUnix
		}
		return entries[i].Call < entries[j].Call
	})

	d.mu.Lock()
	prev := len(d.entries)
	recovered := d.failures
	d.entries = entries
	d.loadedAt = time.Now()
	d.lastAttempt = d.loadedAt
	d.lastError = ""
	d.failures = 0
	d.etag = newETag
	d.lastModified = newLastMod
	d.mu.Unlock()

	if recovered > 0 {
		log.Printf("DXpeditions: recovered after %d failed refresh(es)", recovered)
	}
	if prev == 0 {
		log.Printf("DXpeditions: loaded %d announced operations from %s", len(entries), url)
	} else {
		log.Printf("DXpeditions: refreshed from %s — %d operations (was %d)", url, len(entries), prev)
	}
	return nil
}

// fetchWithRetry downloads url, retrying a failed transfer with an exponential
// backoff. Returns the last error once the attempts are spent.
//
// The wait is abortable: a shutdown during the backoff must not hold Stop()
// open for the quarter-minute the retries can add up to.
func (d *DXpeditions) fetchWithRetry(url, etag, lastMod string) (data []byte, notModified bool, newETag, newLastMod string, err error) {
	delay := adxoRetryDelay
	var lastErr error

	// One initial attempt plus adxoRetries retries.
	for attempt := 1; attempt <= adxoRetries+1; attempt++ {
		data, notModified, newETag, newLastMod, err = d.fetchOnce(url, etag, lastMod)
		if err == nil {
			if attempt > 1 {
				log.Printf("DXpeditions: %s succeeded on attempt %d", url, attempt)
			}
			return data, notModified, newETag, newLastMod, nil
		}
		lastErr = err

		if attempt == adxoRetries+1 {
			break
		}
		log.Printf("DXpeditions: attempt %d/%d for %s failed (%v) — retrying in %s",
			attempt, adxoRetries+1, url, err, delay)
		select {
		case <-d.stopChan:
			return nil, false, "", "", fmt.Errorf("shutting down: %w", err)
		case <-time.After(delay):
		}
		delay *= 2
	}

	return nil, false, "", "", fmt.Errorf("%d attempts failed, last error: %w", adxoRetries+1, lastErr)
}

// fetchOnce is one attempt at the transfer, enforcing the size limit and
// carrying the cache validators from the last success.
func (d *DXpeditions) fetchOnce(url, etag, lastMod string) ([]byte, bool, string, string, error) {
	client := &http.Client{Timeout: adxoHTTPTimeout}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, false, "", "", fmt.Errorf("building request for %s: %w", url, err)
	}
	// Named rather than anonymous: this is a repeated fetch of someone else's
	// site and they should be able to tell who is doing it.
	req.Header.Set("User-Agent", "UberSDR/1.0 (DXpedition calendar; https://github.com/cwsl/ka9q_ubersdr)")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if lastMod != "" {
		req.Header.Set("If-Modified-Since", lastMod)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, false, "", "", fmt.Errorf("network error fetching %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		// Keep the validators we sent: a 304 need not repeat them, and dropping
		// them would make the next fetch unconditional.
		return nil, true, etag, lastMod, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, "", "", fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}

	limited := io.LimitReader(resp.Body, int64(adxoMaxBytes)+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, false, "", "", fmt.Errorf("error reading response body from %s: %w", url, err)
	}
	if len(data) > adxoMaxBytes {
		return nil, false, "", "", fmt.Errorf("response from %s exceeds %d byte limit — rejected", url, adxoMaxBytes)
	}
	return data, false, resp.Header.Get("ETag"), resp.Header.Get("Last-Modified"), nil
}

// ── Parsing ─────────────────────────────────────────────────────────────────

// parseADXO turns the RSS body into announced operations.
//
// A feed that yields no usable entries is an ERROR rather than an empty list.
// The item structure is positional and hand-maintained, so "everything failed
// to parse" is what a format change looks like from here — and the caller's
// contract on error is to keep the previous dataset, which is exactly right.
func parseADXO(data []byte) ([]DXpedition, error) {
	var feed adxoFeed
	if err := xml.Unmarshal(data, &feed); err != nil {
		return nil, fmt.Errorf("parsing ADXO XML: %w", err)
	}
	if len(feed.Items) == 0 {
		return nil, fmt.Errorf("ADXO feed carried no items")
	}

	out := make([]DXpedition, 0, len(feed.Items))
	skipped := 0
	for _, item := range feed.Items {
		p, ok := dxpeditionFromItem(item)
		if !ok {
			skipped++
			continue
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("ADXO feed had %d items but none could be parsed", len(feed.Items))
	}
	if skipped > 0 {
		// Individually skipped rows are worth a line: a handful is the feed
		// having a bad day, a sudden majority is the format having moved.
		log.Printf("DXpeditions: %d of %d items could not be parsed", skipped, len(feed.Items))
	}
	return out, nil
}

// adxoLines splits a <description> into its trimmed field lines, dropping the
// " --" each of the first five carries.
func adxoLines(desc string) []string {
	raw := strings.Split(strings.ReplaceAll(desc, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		s := strings.TrimSpace(line)
		s = strings.TrimSpace(strings.TrimSuffix(s, "--"))
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func dxpeditionFromItem(item adxoItem) (DXpedition, bool) {
	lines := adxoLines(item.Description)
	if len(lines) < 6 {
		return DXpedition{}, false
	}

	start, end, ok := parseADXODates(lines[0])
	if !ok {
		return DXpedition{}, false
	}
	entity := lines[1]
	callField := strings.Fields(lines[2])
	if entity == "" || len(callField) == 0 {
		return DXpedition{}, false
	}
	call := strings.ToUpper(callField[0])
	info := lines[5]

	// Recovery is only asked for when the callsign field is a prefix: when it
	// already carries a callsign, that IS the operating call.
	announced := call
	prefixOnly := adxoPrefixOnly(announced)
	announcedAs := ""
	var operating []string
	if prefixOnly {
		operating = parseADXOOperatingCalls(info, announced)
		if len(operating) > 0 {
			// Promoted into Call rather than reported beside it. An operation
			// whose callsign the announcement went on to state is not
			// "prefix only" in any sense a consumer cares about — there is
			// something real to listen for and to match spots against — and
			// leaving the prefix in Call would mean every one of them had to
			// be special-cased downstream to be usable at all.
			call = operating[0]
			announcedAs = announced
			prefixOnly = false
		}
	}

	p := DXpedition{
		Call:           call,
		AnnouncedAs:    announcedAs,
		PrefixOnly:     prefixOnly,
		Entity:         entity,
		StartUnix:      start,
		EndUnix:        end,
		Dates:          lines[0],
		Bands:          parseADXOBands(info),
		Modes:          parseADXOModes(info),
		Grid:           adxoGridRe.FindString(info),
		IOTA:           adxoIOTARe.FindString(info),
		OperatingCalls: operating,
		AlsoCalls:      parseADXOAlsoCalls(info, announced, operating),
		QSL:            strings.TrimSpace(strings.TrimPrefix(lines[3], "QSL:")),
		Source:         strings.TrimSpace(strings.TrimPrefix(lines[4], "Source:")),
		Info:           info,
		Website:        adxoWebsite(item.Link),
	}
	return p, true
}

// adxoWebsite returns the operation's own page, or "" when the feed only
// pointed back at the generic ADXO listing.
//
// The scheme is checked here rather than at the point of use: this is
// third-party content and a javascript: or file: URL must never reach a
// browser, whatever a future client does with the field.
func adxoWebsite(link string) string {
	link = strings.TrimSpace(link)
	if link == "" || strings.ContainsAny(link, " \t\n") {
		return ""
	}
	lower := strings.ToLower(link)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return ""
	}
	if strings.Contains(lower, "ng3k.com/misc/adxo") {
		return ""
	}
	return link
}

// adxoCallRe matches the shape of a real callsign: up to three leading
// characters, then a digit, then at least one letter. V51WH, 3W9C, 8R1TM.
var adxoCallRe = regexp.MustCompile(`^[A-Z0-9]{1,3}[0-9][A-Z]+`)

// adxoPrefixOnly reports whether the call field is a bare DXCC prefix rather
// than an issued callsign — about a third of the feed, because operations are
// announced before their calls exist.
//
// The shape test alone, and it is worth saying why there is no length floor
// beside it. There used to be one, on the reasoning that "9N" is a digit
// followed by a letter and is Nepal — but adxoCallRe cannot match "9N" anyway:
// it wants at least one character BEFORE the digit and at least one letter
// after, and "9N" has nothing before. The floor was guarding something the
// regex already handled, and it cost three real callsigns: S9R (Sao Tome),
// C8K (Mozambique) and C5H (Gambia) are three characters and every one of them
// is an issued DXpedition call, reported as a prefix and so never matched
// against a spot.
//
// Checked against the whole feed: the regex on its own classifies all 28
// distinct call fields correctly, prefixes and callsigns alike.
func adxoPrefixOnly(call string) bool {
	return !adxoCallRe.MatchString(call)
}

var adxoMonths = map[string]time.Month{
	"jan": time.January, "feb": time.February, "mar": time.March,
	"apr": time.April, "may": time.May, "jun": time.June,
	"jul": time.July, "aug": time.August, "sep": time.September,
	"oct": time.October, "nov": time.November, "dec": time.December,
}

// parseADXODayPart reads one half of a date range: "Sep 1", "Oct 10, 2026",
// "12, 2026". A zero month or year means the half did not carry one, which is
// normal and is resolved by the caller against the other half.
func parseADXODayPart(s string) (mon time.Month, day, year int, ok bool) {
	fields := strings.Fields(strings.ReplaceAll(s, ",", " "))
	i := 0
	if i < len(fields) {
		if m, found := adxoMonths[strings.ToLower(fields[i])]; found {
			mon = m
			i++
		}
	}
	if i >= len(fields) {
		return 0, 0, 0, false
	}
	d, err := strconv.Atoi(fields[i])
	if err != nil || d < 1 || d > 31 {
		return 0, 0, 0, false
	}
	day = d
	i++
	if i < len(fields) {
		if y, err := strconv.Atoi(fields[i]); err == nil && y >= 2000 && y < 2100 {
			year = y
		}
	}
	return mon, day, year, true
}

// parseADXODates parses the announced run into an inclusive pair of unix
// stamps: midnight UTC on the first day, and one second short of midnight on
// the day AFTER the last, so that start <= now <= end is the whole of the "on
// the air" test and the final day is not silently dropped.
//
// Three shapes appear in the feed and all three are live today:
//
//	Sep 1-12, 2026            one month, the year on the right
//	Aug 25-Oct 10, 2026       two months, still one year
//	Dec 23, 2026-Jan 6, 2027  two years, so both halves carry one
//
// The split is on the FIRST hyphen, which works for all three because no month
// name contains one and the year is only ever written in full.
func parseADXODates(s string) (int64, int64, bool) {
	s = strings.TrimSpace(s)
	left, right, hasRange := strings.Cut(s, "-")
	if !hasRange {
		// A single day, which the feed does not currently produce but which
		// costs nothing to accept.
		mon, day, year, ok := parseADXODayPart(s)
		if !ok || mon == 0 || year == 0 {
			return 0, 0, false
		}
		start := time.Date(year, mon, day, 0, 0, 0, 0, time.UTC)
		return start.Unix(), start.AddDate(0, 0, 1).Add(-time.Second).Unix(), true
	}

	sMon, sDay, sYear, sOK := parseADXODayPart(left)
	eMon, eDay, eYear, eOK := parseADXODayPart(right)
	if !sOK || !eOK || sMon == 0 || eYear == 0 {
		return 0, 0, false
	}
	if eMon == 0 {
		eMon = sMon // "Sep 1-12, 2026" — the right half is a day alone
	}
	if sYear == 0 {
		sYear = eYear
		// "Dec 28-Jan 8, 2027" would otherwise start eleven months after it
		// ends. The feed writes that case with both years today, but a
		// backwards range is not a thing we should ever emit.
		if sMon > eMon {
			sYear = eYear - 1
		}
	}

	start := time.Date(sYear, sMon, sDay, 0, 0, 0, 0, time.UTC)
	end := time.Date(eYear, eMon, eDay, 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1).Add(-time.Second)
	if end.Before(start) {
		return 0, 0, false
	}
	return start.Unix(), end.Unix(), true
}

// adxoBand is one amateur allocation: its label, its wavelength in metres as
// the announcements write it, and the range a receiver has to cover to hear it.
type adxoBand struct {
	Label  string
	Meters int
	LoHz   uint64
	HiHz   uint64
}

// The ladder, in frequency order. Announcements say "160-6m" and mean every
// band between the two, so the ladder's ORDER is what expands a range — not
// arithmetic on the wavelengths.
var adxoBandLadder = []adxoBand{
	{"2200m", 2200, 135700, 137800},
	{"630m", 630, 472000, 479000},
	{"160m", 160, 1800000, 2000000},
	{"80m", 80, 3500000, 4000000},
	{"60m", 60, 5250000, 5450000},
	{"40m", 40, 7000000, 7300000},
	{"30m", 30, 10100000, 10150000},
	{"20m", 20, 14000000, 14350000},
	{"17m", 17, 18068000, 18168000},
	{"15m", 15, 21000000, 21450000},
	{"12m", 12, 24890000, 24990000},
	{"10m", 10, 28000000, 29700000},
	{"6m", 6, 50000000, 54000000},
	{"4m", 4, 70000000, 70500000},
	{"2m", 2, 144000000, 148000000},
}

func adxoBandIndex(meters int) int {
	for i, b := range adxoBandLadder {
		if b.Meters == meters {
			return i
		}
	}
	return -1
}

var (
	// "160-6m", "80-10m" — a run across the ladder.
	adxoBandRangeRe = regexp.MustCompile(`(\d{1,4})\s*-\s*(\d{1,4})\s*m\b`)
	// "20m", "40 15 10m" — one band, or several sharing a trailing "m".
	adxoBandListRe = regexp.MustCompile(`((?:\d{1,4}[\s,]+)*\d{1,4})\s*m\b`)
	// A 6-character Maidenhead locator. Matched case-SENSITIVELY: the trailing
	// lowercase pair is what stops it swallowing an all-caps callsign.
	adxoGridRe = regexp.MustCompile(`\b[A-R]{2}[0-9]{2}[a-x]{2}\b`)
	adxoIOTARe = regexp.MustCompile(`\b(?:AF|AN|AS|EU|NA|OC|SA)-[0-9]{3}\b`)
	// "QRV as V55Y", "By OM0GA as 9N/OM0GA". Lowercase "as" and an uppercase
	// token, so "FT8 FT4 as needed" does not read as a callsign.
	adxoAlsoCallRe = regexp.MustCompile(`\bas ([A-Z0-9]+(?:/[A-Z0-9]+)*)`)
	// Every callsign-shaped token in the free text, wherever it sits. Wider than
	// the "as" pattern on purpose: an operation's own call is usually introduced
	// with "as", but not always ("By ops fm Berbera", "By J6/KB4YKC and
	// J6/KB4PML"), and the relatedness test below is what makes a wide scan safe.
	adxoTokenRe = regexp.MustCompile(`\b[A-Z0-9]+(?:/[A-Z0-9]+)*\b`)
)

// parseADXOBands extracts the announced bands from the free-text info line.
//
// Ranges are consumed first and removed, so "160-6m" is one run rather than
// also being read as a bare "6m" by the list pass. "HF" is expanded to the nine
// HF bands, which is what an announcement saying "HF + 6m" means.
func parseADXOBands(info string) []string {
	seen := make(map[int]bool)

	if strings.Contains(strings.ToUpper(info), "HF") {
		for _, m := range []int{160, 80, 40, 30, 20, 17, 15, 12, 10} {
			seen[m] = true
		}
	}

	rest := adxoBandRangeRe.ReplaceAllStringFunc(info, func(match string) string {
		parts := adxoBandRangeRe.FindStringSubmatch(match)
		a, errA := strconv.Atoi(parts[1])
		b, errB := strconv.Atoi(parts[2])
		if errA != nil || errB != nil {
			return " "
		}
		ia, ib := adxoBandIndex(a), adxoBandIndex(b)
		if ia < 0 || ib < 0 {
			return " "
		}
		if ia > ib {
			ia, ib = ib, ia
		}
		for i := ia; i <= ib; i++ {
			seen[adxoBandLadder[i].Meters] = true
		}
		return " " // consumed, so the list pass cannot see it again
	})

	for _, match := range adxoBandListRe.FindAllStringSubmatch(rest, -1) {
		for _, tok := range strings.FieldsFunc(match[1], func(r rune) bool {
			return r == ' ' || r == ',' || r == '\t'
		}) {
			if m, err := strconv.Atoi(tok); err == nil && adxoBandIndex(m) >= 0 {
				seen[m] = true
			}
		}
	}

	out := make([]string, 0, len(seen))
	for _, b := range adxoBandLadder {
		if seen[b.Meters] {
			out = append(out, b.Label)
		}
	}
	return out
}

// adxoModeTokens are matched case-SENSITIVELY, which is not fussiness: every
// entry in the feed begins "By <CALL> fm <place>", where "fm" means "from". An
// uppercasing match would report FM on all fifty-seven of them.
var adxoModeTokens = []string{
	"CW", "SSB", "USB", "LSB", "FM", "AM", "RTTY",
	"FT8", "FT4", "JS8", "PSK31", "PSK", "SSTV",
	"JT65", "MSK144", "Q65", "FST4W", "FST4", "WSPR", "EME",
}

var (
	adxoModeRes    = buildADXOModeRes()
	adxoDigitalRe  = regexp.MustCompile(`(?i)\b(?:digital|digi|data)\b`)
	adxoModeSuffix = "DIGITAL"
)

func buildADXOModeRes() []*regexp.Regexp {
	out := make([]*regexp.Regexp, len(adxoModeTokens))
	for i, tok := range adxoModeTokens {
		out[i] = regexp.MustCompile(`\b` + tok + `\b`)
	}
	return out
}

// parseADXOModes extracts the announced modes, in the order they are listed in
// adxoModeTokens so two announcements naming the same modes agree.
func parseADXOModes(info string) []string {
	var out []string
	for i, re := range adxoModeRes {
		if re.MatchString(info) {
			out = append(out, adxoModeTokens[i])
		}
	}
	// "+ digital", "some digi" — written in lower case, and a category rather
	// than a mode, so it is folded in as one entry at the end.
	if adxoDigitalRe.MatchString(info) {
		out = append(out, adxoModeSuffix)
	}
	return out
}

// callForPrefix reports whether a token is this operation's own callsign, given
// the DXCC prefix the announcement named instead of one.
//
// The convention it is reading is the standard portable one: an operator working
// from another country signs the country's prefix, an oblique, and their own
// call. So an announcement that could only say "PJ2" in its callsign field says
// "By K5SL as PJ2/K5SL" a line later, and the operation is perfectly
// identifiable after all.
//
// Three forms, and the third is the one that is easy to leave out:
//
//	PJ2/K5SL   prefix first — the common form, and the one the convention names
//	W9HT/VP9   prefix appended instead, which some countries issue that way
//	           ("VP9 … By W9HT as W9HT/VP9")
//	J38LD      not portable at all: a call actually ISSUED in that prefix, which
//	           is what a planned operation gets once the licence comes through
//
// The bare prefix itself never counts — that is the thing being replaced.
func callForPrefix(token, prefix string) bool {
	if token == prefix || token == "" || prefix == "" {
		return false
	}
	if strings.HasPrefix(token, prefix+"/") || strings.HasSuffix(token, "/"+prefix) {
		return true
	}
	// An issued call in the prefix. It has to be callsign-SHAPED as well as
	// starting with the right letters, or a mode or a band would qualify: "FT8"
	// starts with "FT", and there is an FT prefix.
	return !strings.Contains(token, "/") &&
		strings.HasPrefix(token, prefix) &&
		adxoCallRe.MatchString(token)
}

// parseADXOOperatingCalls recovers the callsigns that will actually be on the
// air, for an announcement whose callsign field is only a prefix.
//
// Several, when several operators are going: "J3 … By MM8IJU as J38LD and
// GM5RDX as J38DX" is two calls and both are worth listening for.
func parseADXOOperatingCalls(info, prefix string) []string {
	var out []string
	seen := map[string]bool{}
	for _, token := range adxoTokenRe.FindAllString(info, -1) {
		if !callForPrefix(token, prefix) || seen[token] {
			continue
		}
		seen[token] = true
		out = append(out, token)
	}
	return out
}

// parseADXOAlsoCalls pulls the secondary callsigns an announcement mentions.
// Anything without a digit is a word, not a call ("as needed"); the announced
// call, and any call already recovered as this operation's own, are not
// repeated back — one list saying a thing is enough.
func parseADXOAlsoCalls(info, announced string, operating []string) []string {
	var out []string
	seen := map[string]bool{announced: true}
	for _, c := range operating {
		seen[c] = true
	}
	for _, m := range adxoAlsoCallRe.FindAllStringSubmatch(info, -1) {
		call := m[1]
		if len(call) < 3 || !strings.ContainsAny(call, "0123456789") {
			continue
		}
		if seen[call] {
			continue
		}
		seen[call] = true
		out = append(out, call)
	}
	return out
}

// ── Enrichment ──────────────────────────────────────────────────────────────

// enrich adds what this receiver can say about an operation: where it is, how
// far away and in what direction, and whether we could tune any of its bands.
//
// Three sources of position, weakest first, each overriding the last:
//
//	callsign  — CTY on the call. Resolves prefixes as well as full callsigns,
//	            so a prefix-only entry is still placed. But it says where the
//	            CALL was issued, which for a DXpedition is not always where the
//	            operation is: VK2LHW is a mainland-Australia call operating from
//	            Lord Howe, 600 km away and a different DXCC entity.
//	entity    — CTY on the entity name the announcement itself states. That is a
//	            direct claim about location rather than an inference from a
//	            callsign, so it wins when the two disagree. Measured against the
//	            live feed it resolves 53 of 57 announcements; the misses are the
//	            source's own shorthand ("Antigua" for "Antigua & Barbuda"), and
//	            they fall back to the callsign, which is right in every one.
//	grid      — a Maidenhead locator in the free text. An actual position rather
//	            than any kind of centroid, so it beats both.
func (d *DXpeditions) enrich(p *DXpedition) {
	setPos := func(lat, lon float64, approx bool, source string) {
		la, lo := lat, lon
		p.Latitude, p.Longitude = &la, &lo
		p.Approx = approx
		p.PositionSource = source
	}

	if info := GetCallsignInfo(p.Call); info != nil {
		p.Country = info.Country
		p.CountryCode = info.CountryCode
		p.Continent = info.Continent
		if info.Latitude != 0 || info.Longitude != 0 {
			setPos(info.Latitude, info.Longitude, true, "callsign")
		}
	}
	// The announcement names the entity in words. When that resolves to a
	// DIFFERENT entity than the callsign did, the announcement is the one
	// making a claim about where the operation is, so it wins — and Country is
	// corrected with it, because a row saying "Australia" over a Lord Howe
	// operation is wrong in the field the reader actually looks at.
	if ent := GetEntityInfo(p.Entity); ent != nil && ent.Country != p.Country {
		p.Country = ent.Country
		// The code goes with the name. Carrying the callsign's code under the
		// entity's name would fly the wrong flag — an Australian one over a
		// Lord Howe operation, which is exactly the error this branch exists
		// to correct.
		p.CountryCode = ent.CountryCode
		p.Continent = ent.Continent
		if ent.Latitude != 0 || ent.Longitude != 0 {
			setPos(ent.Latitude, ent.Longitude, true, "entity")
		}
	}
	if p.Grid != "" {
		if lat, lon, err := MaidenheadToLatLon(p.Grid); err == nil {
			setPos(lat, lon, false, "grid")
		}
	}
	if p.Latitude != nil && p.Longitude != nil && (d.siteLat != 0 || d.siteLon != 0) {
		km, brg := CalculateDistanceAndBearing(d.siteLat, d.siteLon, *p.Latitude, *p.Longitude)
		p.DistanceKm, p.BearingDeg = &km, &brg
	}
	p.InRange = d.bandsInRange(p.Bands)
}

// bandsInRange reports whether any announced band overlaps this receiver's
// tuning range. An operation whose bands could not be read is IN range: not
// knowing what someone announced is not evidence that we cannot hear them, and
// hiding the row would be the worse error of the two.
func (d *DXpeditions) bandsInRange(bands []string) bool {
	if len(bands) == 0 {
		return true
	}
	for _, label := range bands {
		for _, b := range adxoBandLadder {
			if b.Label != label {
				continue
			}
			if b.HiHz >= d.minFreq && b.LoHz <= d.maxFreq {
				return true
			}
		}
	}
	return false
}

// ── Reading it back ─────────────────────────────────────────────────────────

// Entries returns a copy of the current calendar.
func (d *DXpeditions) Entries() []DXpedition {
	if d == nil {
		return nil
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]DXpedition, len(d.entries))
	copy(out, d.entries)
	return out
}

// staleLocked reports whether it has been too long since anyone could reach the
// feed. It reads lastAttempt rather than loadedAt on purpose: a feed that keeps
// answering 304 is current, however old the bytes are.
func (d *DXpeditions) staleLocked() bool {
	if len(d.entries) == 0 {
		return false // nothing loaded is reported as not-loaded, not as stale
	}
	ref := d.lastAttempt
	if ref.IsZero() {
		ref = d.loadedAt
	}
	return time.Since(ref) > adxoStaleAfter
}

// Status is the fetcher's own health, for the handler and the admin panel.
func (d *DXpeditions) Status() map[string]interface{} {
	if d == nil {
		return map[string]interface{}{"enabled": false}
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	st := map[string]interface{}{
		"enabled":   true,
		"entries":   len(d.entries),
		"loaded":    len(d.entries) > 0,
		"loaded_at": d.loadedAt,
		"source":    adxoURL,
		"stale":     d.staleLocked(),
	}
	if d.lastError != "" {
		st["last_error"] = d.lastError
		st["failures"] = d.failures
	}
	if !d.lastAttempt.IsZero() {
		st["last_attempt"] = d.lastAttempt
	}
	return st
}

// handleDXpeditions serves GET /api/dxpeditions.
//
//	?active=1     only operations on the air right now
//	?days=N       only operations starting within N days (and not yet ended)
//	?in_range=1   only operations announcing a band this receiver can tune
//	?limit=N      cap the number of entries returned
//
// The envelope carries the fetcher's state as well as the list, so a client can
// tell an empty calendar apart from a calendar nobody could fetch — "not tried
// yet", "ng3k unreachable from here" and "genuinely nothing announced" all look
// identical without it. last_error is present only while the last attempt
// failed, and is cleared by the next success.
func handleDXpeditions(w http.ResponseWriter, r *http.Request, dx *DXpeditions) {
	now := time.Now().UTC()

	resp := map[string]interface{}{
		"now_utc": now.Format(time.RFC3339),
		"entries": []DXpedition{},
		"count":   0,
	}

	if dx == nil {
		resp["enabled"] = false
		resp["loaded"] = false
		writeDXpeditionsJSON(w, resp)
		return
	}

	status := dx.Status()
	for _, k := range []string{"enabled", "loaded", "loaded_at", "source", "stale", "last_error", "last_attempt"} {
		if v, ok := status[k]; ok {
			resp[k] = v
		}
	}

	q := r.URL.Query()
	activeOnly := q.Get("active") == "1"
	inRangeOnly := q.Get("in_range") == "1"

	// A window of days, measured from now rather than from midnight: "what is
	// on in the next week" is a question about the next seven days, not about
	// the calendar week the seventh day lands in.
	var horizon int64
	if v := q.Get("days"); v != "" {
		days, err := strconv.Atoi(v)
		if err != nil || days < 0 {
			http.Error(w, "days must be a non-negative integer", http.StatusBadRequest)
			return
		}
		horizon = now.Unix() + int64(days)*86400
	}
	limit := 0
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			http.Error(w, "limit must be a non-negative integer", http.StatusBadRequest)
			return
		}
		limit = n
	}

	nowUnix := now.Unix()
	entries := dx.Entries()
	rows := make([]DXpedition, 0, len(entries))
	for _, p := range entries {
		p.Active = p.StartUnix <= nowUnix && nowUnix <= p.EndUnix
		if activeOnly && !p.Active {
			continue
		}
		if inRangeOnly && !p.InRange {
			continue
		}
		// An operation already over is never in a forward window, however wide.
		if horizon > 0 && (p.EndUnix < nowUnix || p.StartUnix > horizon) {
			continue
		}
		rows = append(rows, p)
		if limit > 0 && len(rows) >= limit {
			break
		}
	}
	resp["entries"] = rows
	resp["count"] = len(rows)

	writeDXpeditionsJSON(w, resp)
}

func writeDXpeditionsJSON(w http.ResponseWriter, resp map[string]interface{}) {
	w.Header().Set("Content-Type", "application/json")
	// Five minutes of caching: the data changes at most a few times a day, and
	// a panel reopened repeatedly should not re-serialise the list every time.
	w.Header().Set("Cache-Control", "public, max-age=300")
	json.NewEncoder(w).Encode(resp)
}
