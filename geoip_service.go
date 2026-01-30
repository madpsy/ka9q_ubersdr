package main

import (
	"fmt"
	"log"
	"net"
	"sync"

	"github.com/oschwald/geoip2-golang"
)

// GeoIPService provides IP geolocation functionality using MaxMind GeoIP2 database
// This service is for internal use only and admin API access
type GeoIPService struct {
	db      *geoip2.Reader
	mu      sync.RWMutex
	enabled bool
}

// GeoIPResult contains geolocation information for an IP address
type GeoIPResult struct {
	IP          string `json:"ip"`
	Country     string `json:"country"`
	CountryCode string `json:"country_code"`
	Continent   string `json:"continent,omitempty"`
}

// NewGeoIPService creates a new GeoIP service instance
// If dbPath is empty or the database cannot be loaded, returns a disabled service
func NewGeoIPService(dbPath string) (*GeoIPService, error) {
	if dbPath == "" {
		log.Println("GeoIP: Database path not configured, service disabled")
		return &GeoIPService{enabled: false}, nil
	}

	db, err := geoip2.Open(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open GeoIP database at %s: %w", dbPath, err)
	}

	log.Printf("GeoIP: Service initialized successfully (database: %s)", dbPath)
	return &GeoIPService{
		db:      db,
		enabled: true,
	}, nil
}

// IsEnabled returns whether the GeoIP service is enabled
func (g *GeoIPService) IsEnabled() bool {
	return g.enabled
}

// GetCountry returns the country name for an IP address
func (g *GeoIPService) GetCountry(ipStr string) (string, error) {
	if !g.enabled {
		return "", fmt.Errorf("GeoIP service not enabled")
	}

	g.mu.RLock()
	defer g.mu.RUnlock()

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
	if !g.enabled {
		return "", fmt.Errorf("GeoIP service not enabled")
	}

	g.mu.RLock()
	defer g.mu.RUnlock()

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

// Lookup performs a full geolocation lookup for an IP address
func (g *GeoIPService) Lookup(ipStr string) (*GeoIPResult, error) {
	if !g.enabled {
		return nil, fmt.Errorf("GeoIP service not enabled")
	}

	g.mu.RLock()
	defer g.mu.RUnlock()

	ip := net.ParseIP(ipStr)
	if ip == nil {
		return nil, fmt.Errorf("invalid IP address: %s", ipStr)
	}

	record, err := g.db.Country(ip)
	if err != nil {
		return nil, fmt.Errorf("country lookup failed for %s: %w", ipStr, err)
	}

	result := &GeoIPResult{
		IP:          ipStr,
		CountryCode: record.Country.IsoCode,
		Continent:   record.Continent.Code,
	}

	// Get English country name if available
	if name, ok := record.Country.Names["en"]; ok && name != "" {
		result.Country = name
	} else {
		result.Country = record.Country.IsoCode
	}

	return result, nil
}

// LookupSafe performs a lookup and returns empty strings on error
// Useful for non-critical enrichment where failures should be silent
func (g *GeoIPService) LookupSafe(ipStr string) (country, countryCode string) {
	if !g.enabled || ipStr == "" {
		return "", ""
	}

	result, err := g.Lookup(ipStr)
	if err != nil {
		return "", ""
	}

	return result.Country, result.CountryCode
}

// Close closes the GeoIP database
func (g *GeoIPService) Close() error {
	if g.db != nil {
		log.Println("GeoIP: Closing database")
		return g.db.Close()
	}
	return nil
}
