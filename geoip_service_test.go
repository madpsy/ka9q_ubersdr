package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Minimal MaxMind DB builder
//
// The real GeoLite2 files are gitignored (the operator downloads them), but
// these tests have to exercise the memory-mapped lifecycle — that is where the
// shutdown crash lived, and an in-memory fake would not reproduce it.  So the
// tests build a tiny but genuinely valid .mmdb on disk and let geoip2.Open
// mmap it.
//
// Layout, per the MaxMind DB spec:
//   [search tree][16 zero bytes][data section][\xab\xcd\xefMaxMind.com][metadata]
// ---------------------------------------------------------------------------

const (
	testMMDBNodeCount           = 1
	testMMDBRecordSize          = 32
	testMMDBDataSectionSepBytes = 16
)

type mmdbEntry struct {
	key   string
	value []byte
}

func mmdbKV(key string, value []byte) mmdbEntry { return mmdbEntry{key: key, value: value} }

// mmdbControl encodes a control byte for the given data type and payload size.
// Types above 7 use the extended form: the control byte carries a zero type
// field and is followed by a byte holding type-7.  Sizes of 29..284 spill one
// extra byte after that; larger payloads are not needed here.
func mmdbControl(typ byte, size int) []byte {
	var sizeField byte
	var sizeExtra []byte

	switch {
	case size < 29:
		sizeField = byte(size)
	case size < 29+256:
		sizeField = 29
		sizeExtra = []byte{byte(size - 29)}
	default:
		panic("test MMDB builder: payload too large")
	}

	if typ <= 7 {
		return append([]byte{typ<<5 | sizeField}, sizeExtra...)
	}
	return append([]byte{sizeField, typ - 7}, sizeExtra...)
}

func mmdbString(s string) []byte {
	return append(mmdbControl(2, len(s)), s...)
}

// mmdbUint encodes an unsigned integer with the given MaxMind type number
// (5 = uint16, 6 = uint32, 9 = uint64) using the minimum number of bytes.
func mmdbUint(typ byte, v uint64) []byte {
	var full [8]byte
	binary.BigEndian.PutUint64(full[:], v)
	trimmed := bytes.TrimLeft(full[:], "\x00")
	return append(mmdbControl(typ, len(trimmed)), trimmed...)
}

func mmdbMap(entries ...mmdbEntry) []byte {
	out := mmdbControl(7, len(entries))
	for _, e := range entries {
		out = append(out, mmdbString(e.key)...)
		out = append(out, e.value...)
	}
	return out
}

func mmdbArray(items ...[]byte) []byte {
	out := mmdbControl(11, len(items))
	for _, item := range items {
		out = append(out, item...)
	}
	return out
}

// buildTestMMDB assembles a one-node IPv4 database in which every address in
// 0.0.0.0/1 resolves to record and everything else is "not found".
func buildTestMMDB(dbType string, record []byte) []byte {
	// The single node holds two records.  The left one (taken when the first
	// address bit is 0) points into the data section: data pointers are the
	// data offset plus node_count plus the separator size, so the first byte of
	// the data section is node_count+16.  The right record equals node_count,
	// which the reader interprets as "no data here".
	tree := make([]byte, testMMDBRecordSize*2/8)
	binary.BigEndian.PutUint32(tree[0:4], testMMDBNodeCount+testMMDBDataSectionSepBytes)
	binary.BigEndian.PutUint32(tree[4:8], testMMDBNodeCount)

	metadata := mmdbMap(
		mmdbKV("binary_format_major_version", mmdbUint(5, 2)),
		mmdbKV("binary_format_minor_version", mmdbUint(5, 0)),
		mmdbKV("build_epoch", mmdbUint(9, 0)),
		mmdbKV("database_type", mmdbString(dbType)),
		mmdbKV("description", mmdbMap(mmdbKV("en", mmdbString("ubersdr test db")))),
		mmdbKV("ip_version", mmdbUint(5, 4)),
		mmdbKV("languages", mmdbArray(mmdbString("en"))),
		mmdbKV("node_count", mmdbUint(6, testMMDBNodeCount)),
		mmdbKV("record_size", mmdbUint(5, testMMDBRecordSize)),
	)

	var buf bytes.Buffer
	buf.Write(tree)
	buf.Write(make([]byte, testMMDBDataSectionSepBytes))
	buf.Write(record)
	buf.WriteString("\xab\xcd\xefMaxMind.com")
	buf.Write(metadata)
	return buf.Bytes()
}

func writeTestMMDB(t *testing.T, name, dbType string, record []byte) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, buildTestMMDB(dbType, record), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	return path
}

// testGeoIPAddr is inside 0.0.0.0/1, so the one-node tree resolves it.
const testGeoIPAddr = "1.2.3.4"

// newTestGeoIPService returns a service backed by a country database and an
// ASN database, both memory-mapped from real files under t.TempDir().
func newTestGeoIPService(t *testing.T) *GeoIPService {
	t.Helper()

	countryPath := writeTestMMDB(t, "country.mmdb", "GeoLite2-Country", mmdbMap(
		mmdbKV("continent", mmdbMap(
			mmdbKV("code", mmdbString("EU")),
			mmdbKV("names", mmdbMap(mmdbKV("en", mmdbString("Europe")))),
		)),
		mmdbKV("country", mmdbMap(
			mmdbKV("iso_code", mmdbString("GB")),
			mmdbKV("names", mmdbMap(mmdbKV("en", mmdbString("United Kingdom")))),
		)),
	))

	asnPath := writeTestMMDB(t, "asn.mmdb", "GeoLite2-ASN", mmdbMap(
		mmdbKV("autonomous_system_number", mmdbUint(6, 64500)),
		mmdbKV("autonomous_system_organization", mmdbString("UberSDR Test Net")),
	))

	svc, err := NewGeoIPService(countryPath, asnPath)
	if err != nil {
		t.Fatalf("NewGeoIPService: %v", err)
	}
	return svc
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestGeoIPTestDatabaseIsUsable checks the hand-built database first, so that a
// failure in the tests below means the service is broken rather than the
// fixture.
func TestGeoIPTestDatabaseIsUsable(t *testing.T) {
	svc := newTestGeoIPService(t)
	defer svc.Close()

	if !svc.IsEnabled() {
		t.Fatal("service should be enabled")
	}
	if !svc.IsASNEnabled() {
		t.Fatal("ASN database should be loaded")
	}

	result, err := svc.Lookup(testGeoIPAddr, false)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if result.CountryCode != "GB" || result.Country != "United Kingdom" {
		t.Errorf("country = %q/%q, want GB/United Kingdom", result.CountryCode, result.Country)
	}
	if result.ContinentCode != "EU" || result.Continent != "Europe" {
		t.Errorf("continent = %q/%q, want EU/Europe", result.ContinentCode, result.Continent)
	}
	if result.ASN == nil || *result.ASN != 64500 {
		t.Errorf("ASN = %v, want 64500", result.ASN)
	}
	if result.ISP != "UberSDR Test Net" {
		t.Errorf("ISP = %q, want UberSDR Test Net", result.ISP)
	}

	if name, err := svc.GetCountry(testGeoIPAddr); err != nil || name != "United Kingdom" {
		t.Errorf("GetCountry = %q, %v", name, err)
	}
	if code, err := svc.GetCountryCode(testGeoIPAddr); err != nil || code != "GB" {
		t.Errorf("GetCountryCode = %q, %v", code, err)
	}
	if asn, org, err := svc.GetASN(testGeoIPAddr); err != nil || asn != 64500 || org != "UberSDR Test Net" {
		t.Errorf("GetASN = %d, %q, %v", asn, org, err)
	}
	if country, code := svc.LookupSafe(testGeoIPAddr); country != "United Kingdom" || code != "GB" {
		t.Errorf("LookupSafe = %q/%q", country, code)
	}
}

// TestGeoIPClosedServiceRejectsLookups is the contract the shutdown path relies
// on: once Close has run, every entry point reports the service as unavailable
// instead of reaching for the unmapped database.
func TestGeoIPClosedServiceRejectsLookups(t *testing.T) {
	svc := newTestGeoIPService(t)

	if err := svc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if svc.IsEnabled() {
		t.Error("IsEnabled should report false after Close")
	}
	if svc.IsASNEnabled() {
		t.Error("IsASNEnabled should report false after Close")
	}

	if _, err := svc.Lookup(testGeoIPAddr, false); !errors.Is(err, ErrGeoIPUnavailable) {
		t.Errorf("Lookup error = %v, want ErrGeoIPUnavailable", err)
	}
	if _, err := svc.GetCountry(testGeoIPAddr); !errors.Is(err, ErrGeoIPUnavailable) {
		t.Errorf("GetCountry error = %v, want ErrGeoIPUnavailable", err)
	}
	if _, err := svc.GetCountryCode(testGeoIPAddr); !errors.Is(err, ErrGeoIPUnavailable) {
		t.Errorf("GetCountryCode error = %v, want ErrGeoIPUnavailable", err)
	}
	if _, _, err := svc.GetASN(testGeoIPAddr); !errors.Is(err, ErrGeoIPUnavailable) {
		t.Errorf("GetASN error = %v, want ErrGeoIPUnavailable", err)
	}
	if country, code := svc.LookupSafe(testGeoIPAddr); country != "" || code != "" {
		t.Errorf("LookupSafe = %q/%q, want empty", country, code)
	}

	// main registers Close as a defer and the group teardown may reach it too,
	// so a second call must not double-unmap.
	if err := svc.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}

// TestGeoIPServiceWithoutDatabase covers the disabled service main constructs
// when GeoIP is off or the database fails to load: the guards are checked under
// the lock, so a nil reader must produce an error rather than a nil dereference.
func TestGeoIPServiceWithoutDatabase(t *testing.T) {
	for name, svc := range map[string]*GeoIPService{
		"disabled":      {enabled: false},
		"enabled_no_db": {enabled: true},
		"nil_asn_only":  {enabled: true, db: nil, asnDB: nil},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := svc.Lookup(testGeoIPAddr, false); !errors.Is(err, ErrGeoIPUnavailable) {
				t.Errorf("Lookup error = %v, want ErrGeoIPUnavailable", err)
			}
			if _, err := svc.GetCountry(testGeoIPAddr); !errors.Is(err, ErrGeoIPUnavailable) {
				t.Errorf("GetCountry error = %v, want ErrGeoIPUnavailable", err)
			}
			if _, err := svc.GetCountryCode(testGeoIPAddr); !errors.Is(err, ErrGeoIPUnavailable) {
				t.Errorf("GetCountryCode error = %v, want ErrGeoIPUnavailable", err)
			}
			if _, _, err := svc.GetASN(testGeoIPAddr); err == nil {
				t.Error("GetASN should fail without an ASN database")
			}
			if country, code := svc.LookupSafe(testGeoIPAddr); country != "" || code != "" {
				t.Errorf("LookupSafe = %q/%q, want empty", country, code)
			}
			if err := svc.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		})
	}
}

// TestGeoIPLookupRacingClose is the regression test for the shutdown SIGSEGV.
//
// Closing a geoip2 reader munmaps the database, and the decoder holds raw
// pointers into that mapping, so a lookup running concurrently with Close used
// to fault the process ("unexpected fault address", inside
// maxminddb.nodeReader28.readRight) rather than return an error.  Worth running
// under -race too: the old code also read the enabled flag and the reader
// pointers without holding the lock.
func TestGeoIPLookupRacingClose(t *testing.T) {
	const workers = 16

	svc := newTestGeoIPService(t)

	var (
		wg       sync.WaitGroup
		ready    sync.WaitGroup
		stop     atomic.Bool
		closed   atomic.Bool
		problems = make(chan string, workers*4)
	)

	ready.Add(workers)
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		go func(i int) {
			defer wg.Done()

			first := true
			for !stop.Load() {
				// Sampled before the call: if the service was already fully
				// closed when this lookup started, it must not succeed.
				startedAfterClose := closed.Load()

				switch i % 4 {
				case 0:
					result, err := svc.Lookup(testGeoIPAddr, false)
					switch {
					case err == nil && startedAfterClose:
						problems <- "Lookup succeeded after Close returned"
					case err == nil && result.CountryCode != "GB":
						problems <- "Lookup returned country " + result.CountryCode
					case err != nil && !errors.Is(err, ErrGeoIPUnavailable):
						problems <- "Lookup error " + err.Error()
					}
				case 1:
					code, err := svc.GetCountryCode(testGeoIPAddr)
					switch {
					case err == nil && startedAfterClose:
						problems <- "GetCountryCode succeeded after Close returned"
					case err == nil && code != "GB":
						problems <- "GetCountryCode returned " + code
					case err != nil && !errors.Is(err, ErrGeoIPUnavailable):
						problems <- "GetCountryCode error " + err.Error()
					}
				case 2:
					asn, _, err := svc.GetASN(testGeoIPAddr)
					switch {
					case err == nil && startedAfterClose:
						problems <- "GetASN succeeded after Close returned"
					case err == nil && asn != 64500:
						problems <- "GetASN returned an unexpected ASN"
					}
				default:
					if _, code := svc.LookupSafe(testGeoIPAddr); code != "" && code != "GB" {
						problems <- "LookupSafe returned " + code
					}
					svc.IsEnabled()
					svc.IsASNEnabled()
				}

				if first {
					first = false
					ready.Done()
				}
			}
		}(i)
	}

	// Only close once every worker is actually hammering the database, so the
	// unmap lands in the middle of live lookups.
	ready.Wait()
	if err := svc.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	closed.Store(true)

	// Keep the workers going for a moment against the closed service.
	time.Sleep(50 * time.Millisecond)
	stop.Store(true)
	wg.Wait()
	close(problems)

	for p := range problems {
		t.Error(p)
	}
}

// TestGeoIPCloseWaitsForInFlightLookups pins the ordering guarantee that makes
// the unmap safe: Close cannot complete while a lookup holds the read lock.
func TestGeoIPCloseWaitsForInFlightLookups(t *testing.T) {
	svc := newTestGeoIPService(t)

	// Stand in for a lookup that is inside the mapped database.
	svc.mu.RLock()

	closeReturned := make(chan struct{})
	go func() {
		_ = svc.Close()
		close(closeReturned)
	}()

	select {
	case <-closeReturned:
		t.Fatal("Close unmapped the database while a lookup held the read lock")
	case <-time.After(100 * time.Millisecond):
	}

	svc.mu.RUnlock()

	select {
	case <-closeReturned:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not return after the lookup released the read lock")
	}
}
