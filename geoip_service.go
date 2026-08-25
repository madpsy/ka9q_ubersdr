package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/oschwald/geoip2-golang"
)

// GeoIPService provides IP geolocation functionality using MaxMind GeoIP2 database
// This service is for internal use only and admin API access
//
// The geoip2 readers are memory-mapped files.  Closing one unmaps its pages,
// so a lookup racing with Close does not get an error, it faults (SIGSEGV) —
// the decoder holds raw pointers into the mapping.  Every method that touches
// db/asnDB therefore does so under mu (read side), and Close takes mu for
// writing, which blocks until the in-flight lookups have finished.  The check
// for usability happens *inside* the lock, never before taking it.
type GeoIPService struct {
	db      *geoip2.Reader
	asnDB   *geoip2.Reader
	mu      sync.RWMutex
	enabled bool
}

// ErrGeoIPUnavailable is returned by every lookup when the service is disabled
// or has been closed.  Callers should treat it as "no geolocation data", not
// as something to retry: after Close the databases are gone for good.
var ErrGeoIPUnavailable = errors.New("GeoIP service not enabled")

// GeoIPResult contains geolocation information for an IP address
type GeoIPResult struct {
	IP            string `json:"ip"`
	Hostname      string `json:"hostname,omitempty"` // Reverse DNS hostname (only populated when requested)
	Country       string `json:"country"`
	CountryCode   string `json:"country_code"`
	Continent     string `json:"continent,omitempty"`
	ContinentCode string `json:"continent_code,omitempty"`

	// City information (only available with City database)
	City       string `json:"city,omitempty"`
	PostalCode string `json:"postal_code,omitempty"`

	// Subdivision/Region information (only available with City database)
	Subdivisions []struct {
		Name    string `json:"name,omitempty"`
		IsoCode string `json:"iso_code,omitempty"`
	} `json:"subdivisions,omitempty"`

	// Geographic coordinates (only available with City database)
	Latitude  *float64 `json:"latitude,omitempty"`
	Longitude *float64 `json:"longitude,omitempty"`

	// Accuracy and time zone (only available with City database)
	AccuracyRadius *uint16 `json:"accuracy_radius_km,omitempty"`
	TimeZone       string  `json:"time_zone,omitempty"`

	// Network information (only available with City database)
	MetroCode *uint `json:"metro_code,omitempty"`

	// Registered and represented country (may differ from country)
	RegisteredCountry      string `json:"registered_country,omitempty"`
	RegisteredCountryCode  string `json:"registered_country_code,omitempty"`
	RepresentedCountry     string `json:"represented_country,omitempty"`
	RepresentedCountryCode string `json:"represented_country_code,omitempty"`

	// Traits
	IsAnonymousProxy    bool `json:"is_anonymous_proxy,omitempty"`
	IsSatelliteProvider bool `json:"is_satellite_provider,omitempty"`

	// ASN / ISP information (only available when ASN database is loaded)
	ASN *uint  `json:"asn,omitempty"` // Autonomous System Number
	ISP string `json:"isp,omitempty"` // Organisation name from ASN database
}

// NewGeoIPService creates a new GeoIP service instance
// If dbPath is empty or the database cannot be loaded, returns a disabled service.
// asnDBPath is optional; if provided and valid the ASN database is loaded for ISP lookups.
func NewGeoIPService(dbPath string, asnDBPath string) (*GeoIPService, error) {
	if dbPath == "" {
		log.Println("GeoIP: Database path not configured, service disabled")
		return &GeoIPService{enabled: false}, nil
	}

	db, err := geoip2.Open(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open GeoIP database at %s: %w", dbPath, err)
	}

	svc := &GeoIPService{
		db:      db,
		enabled: true,
	}

	if asnDBPath != "" {
		asnDB, err := geoip2.Open(asnDBPath)
		if err != nil {
			log.Printf("GeoIP: Warning - failed to open ASN database at %s: %v (ISP info will be unavailable)", asnDBPath, err)
		} else {
			svc.asnDB = asnDB
			log.Printf("GeoIP: ASN database loaded successfully (database: %s)", asnDBPath)
		}
	}

	log.Printf("GeoIP: Service initialized successfully (database: %s)", dbPath)
	return svc, nil
}

// IsASNEnabled returns whether the ASN database is loaded
func (g *GeoIPService) IsASNEnabled() bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.asnDB != nil
}

// IsEnabled returns whether the GeoIP service is enabled.  Returns false once
// Close has been called, so callers that gate on it stop issuing lookups
// during shutdown.
func (g *GeoIPService) IsEnabled() bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.enabled
}

// available reports whether the city/country database can be read.
// Must be called with g.mu held (either side).
func (g *GeoIPService) available() bool {
	return g.enabled && g.db != nil
}

// GetCountry returns the country name for an IP address
func (g *GeoIPService) GetCountry(ipStr string) (string, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()

	if !g.available() {
		return "", ErrGeoIPUnavailable
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return "", fmt.Errorf("invalid IP address: %s", ipStr)
	}

	record, err := g.db.Country(ip)
	if err != nil {
		return "", fmt.Errorf("country lookup failed for %s: %w", ipStr, err)
	}

	// Return English name if available, otherwise return ISO code
	if name, ok := record.Country.Names["en"]; ok && name != "" {
		return name, nil
	}

	return record.Country.IsoCode, nil
}

// GetCountryCode returns the ISO country code for an IP address
func (g *GeoIPService) GetCountryCode(ipStr string) (string, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()

	if !g.available() {
		return "", ErrGeoIPUnavailable
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return "", fmt.Errorf("invalid IP address: %s", ipStr)
	}

	record, err := g.db.Country(ip)
	if err != nil {
		return "", fmt.Errorf("country lookup failed for %s: %w", ipStr, err)
	}

	return record.Country.IsoCode, nil
}

// Lookup performs a full geolocation lookup for an IP address.
// If reverseDNS is true, a reverse DNS lookup is attempted with a 2 second timeout.
func (g *GeoIPService) Lookup(ipStr string, reverseDNS bool) (*GeoIPResult, error) {
	result, err := g.lookupDatabases(ipStr)
	if err != nil {
		return nil, err
	}

	// Deliberately outside the database lock: a PTR resolve can take the full
	// 2 second timeout, and Close (i.e. shutdown) blocks on that lock.
	if reverseDNS {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		resolver := &net.Resolver{}
		if names, err := resolver.LookupAddr(ctx, ipStr); err == nil && len(names) > 0 {
			// Strip trailing dot from PTR record if present
			hostname := names[0]
			if len(hostname) > 0 && hostname[len(hostname)-1] == '.' {
				hostname = hostname[:len(hostname)-1]
			}
			result.Hostname = hostname
		}
	}

	return result, nil
}

// lookupDatabases performs the memory-mapped part of a lookup: the city or
// country record plus ASN enrichment.  Everything that dereferences the mapped
// databases happens here, under the read lock.
func (g *GeoIPService) lookupDatabases(ipStr string) (*GeoIPResult, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()

	if !g.available() {
		return nil, ErrGeoIPUnavailable
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return nil, fmt.Errorf("invalid IP address: %s", ipStr)
	}

	// Try City database first (has all fields), fall back to Country database
	cityRecord, cityErr := g.db.City(ip)

	result := &GeoIPResult{
		IP: ipStr,
	}

	// Enrich with ASN/ISP data if available
	g.lookupASN(ip, result)

	if cityErr == nil {
		// City database available - populate all fields
		result.CountryCode = cityRecord.Country.IsoCode
		result.ContinentCode = cityRecord.Continent.Code

		// Get English country name
		if name, ok := cityRecord.Country.Names["en"]; ok && name != "" {
			result.Country = name
		} else {
			result.Country = cityRecord.Country.IsoCode
		}

		// Get English continent name
		if name, ok := cityRecord.Continent.Names["en"]; ok && name != "" {
			result.Continent = name
		} else {
			result.Continent = cityRecord.Continent.Code
		}

		// City information
		if cityName, ok := cityRecord.City.Names["en"]; ok && cityName != "" {
			result.City = cityName
		}
		result.PostalCode = cityRecord.Postal.Code

		// Subdivisions (states/provinces)
		if len(cityRecord.Subdivisions) > 0 {
			result.Subdivisions = make([]struct {
				Name    string `json:"name,omitempty"`
				IsoCode string `json:"iso_code,omitempty"`
			}, len(cityRecord.Subdivisions))

			for i, sub := range cityRecord.Subdivisions {
				result.Subdivisions[i].IsoCode = sub.IsoCode
				if name, ok := sub.Names["en"]; ok && name != "" {
					result.Subdivisions[i].Name = name
				}
			}
		}

		// Geographic coordinates
		if cityRecord.Location.Latitude != 0 || cityRecord.Location.Longitude != 0 {
			lat := cityRecord.Location.Latitude
			lon := cityRecord.Location.Longitude
			result.Latitude = &lat
			result.Longitude = &lon
		}

		// Accuracy and time zone
		if cityRecord.Location.AccuracyRadius != 0 {
			result.AccuracyRadius = &cityRecord.Location.AccuracyRadius
		}
		result.TimeZone = cityRecord.Location.TimeZone

		// Metro code
		if cityRecord.Location.MetroCode != 0 {
			result.MetroCode = &cityRecord.Location.MetroCode
		}

		// Registered country
		if cityRecord.RegisteredCountry.IsoCode != "" {
			result.RegisteredCountryCode = cityRecord.RegisteredCountry.IsoCode
			if name, ok := cityRecord.RegisteredCountry.Names["en"]; ok && name != "" {
				result.RegisteredCountry = name
			} else {
				result.RegisteredCountry = cityRecord.RegisteredCountry.IsoCode
			}
		}

		// Represented country
		if cityRecord.RepresentedCountry.IsoCode != "" {
			result.RepresentedCountryCode = cityRecord.RepresentedCountry.IsoCode
			if name, ok := cityRecord.RepresentedCountry.Names["en"]; ok && name != "" {
				result.RepresentedCountry = name
			} else {
				result.RepresentedCountry = cityRecord.RepresentedCountry.IsoCode
			}
		}

		// Traits
		result.IsAnonymousProxy = cityRecord.Traits.IsAnonymousProxy
		result.IsSatelliteProvider = cityRecord.Traits.IsSatelliteProvider

	} else {
		// Fall back to Country database (limited fields)
		countryRecord, err := g.db.Country(ip)
		if err != nil {
			return nil, fmt.Errorf("lookup failed for %s: %w", ipStr, err)
		}

		result.CountryCode = countryRecord.Country.IsoCode
		result.ContinentCode = countryRecord.Continent.Code

		// Get English country name
		if name, ok := countryRecord.Country.Names["en"]; ok && name != "" {
			result.Country = name
		} else {
			result.Country = countryRecord.Country.IsoCode
		}

		// Get English continent name
		if name, ok := countryRecord.Continent.Names["en"]; ok && name != "" {
			result.Continent = name
		} else {
			result.Continent = countryRecord.Continent.Code
		}

		// Registered country
		if countryRecord.RegisteredCountry.IsoCode != "" {
			result.RegisteredCountryCode = countryRecord.RegisteredCountry.IsoCode
			if name, ok := countryRecord.RegisteredCountry.Names["en"]; ok && name != "" {
				result.RegisteredCountry = name
			} else {
				result.RegisteredCountry = countryRecord.RegisteredCountry.IsoCode
			}
		}

		// Represented country
		if countryRecord.RepresentedCountry.IsoCode != "" {
			result.RepresentedCountryCode = countryRecord.RepresentedCountry.IsoCode
			if name, ok := countryRecord.RepresentedCountry.Names["en"]; ok && name != "" {
				result.RepresentedCountry = name
			} else {
				result.RepresentedCountry = countryRecord.RepresentedCountry.IsoCode
			}
		}

		// Traits
		result.IsAnonymousProxy = countryRecord.Traits.IsAnonymousProxy
		result.IsSatelliteProvider = countryRecord.Traits.IsSatelliteProvider
	}

	return result, nil
}

// GetASN returns the ASN number and organisation name for an IP address.
// Returns (0, "", error) if the ASN database is not loaded or lookup fails.
func (g *GeoIPService) GetASN(ipStr string) (uint, string, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()

	if !g.enabled {
		return 0, "", ErrGeoIPUnavailable
	}

	if g.asnDB == nil {
		return 0, "", fmt.Errorf("ASN database not loaded")
	}

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return 0, "", fmt.Errorf("invalid IP address: %s", ipStr)
	}

	record, err := g.asnDB.ASN(ip)
	if err != nil {
		return 0, "", fmt.Errorf("ASN lookup failed for %s: %w", ipStr, err)
	}

	return uint(record.AutonomousSystemNumber), record.AutonomousSystemOrganization, nil
}

// lookupASN enriches result with ASN/ISP data if the ASN database is available.
// Must be called with g.mu read-locked.
func (g *GeoIPService) lookupASN(ip net.IP, result *GeoIPResult) {
	if g.asnDB == nil {
		return
	}
	asnRecord, err := g.asnDB.ASN(ip)
	if err != nil {
		return
	}
	if asnRecord.AutonomousSystemNumber != 0 {
		asn := uint(asnRecord.AutonomousSystemNumber)
		result.ASN = &asn
	}
	if asnRecord.AutonomousSystemOrganization != "" {
		result.ISP = asnRecord.AutonomousSystemOrganization
	}
}

// LookupSafe performs a lookup and returns empty strings on error
// Useful for non-critical enrichment where failures should be silent
func (g *GeoIPService) LookupSafe(ipStr string) (country, countryCode string) {
	if ipStr == "" {
		return "", ""
	}

	result, err := g.Lookup(ipStr, false)
	if err != nil {
		return "", ""
	}

	return result.Country, result.CountryCode
}

// Close closes the GeoIP database(s).
//
// Closing a geoip2 reader munmaps the database file, so this must never run
// while another goroutine is inside a lookup: the decoder would read unmapped
// pages and the process would take a SIGSEGV rather than an error.  Taking the
// write lock waits for every in-flight lookup to return, and clearing the
// fields before unmapping means no lookup started afterwards can reach the
// mapping — it sees an unavailable service and gets ErrGeoIPUnavailable.
//
// Close is idempotent; calling it on an already-closed or disabled service is
// a no-op that returns nil.
func (g *GeoIPService) Close() error {
	g.mu.Lock()
	defer g.mu.Unlock()

	db, asnDB := g.db, g.asnDB
	g.db, g.asnDB = nil, nil
	g.enabled = false

	var firstErr error
	if asnDB != nil {
		if err := asnDB.Close(); err != nil {
			log.Printf("GeoIP: Error closing ASN database: %v", err)
			firstErr = err
		}
	}
	if db != nil {
		log.Println("GeoIP: Closing database")
		if err := db.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
