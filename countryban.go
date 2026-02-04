package main

import (
	"log"
	"os"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// BannedCountry represents a banned country by its ISO alpha-2 code
type BannedCountry struct {
	CountryCode string    `yaml:"country_code" json:"country_code"` // ISO alpha-2 code (e.g., "CN", "RU")
	CountryName string    `yaml:"country_name" json:"country_name"` // Human-readable name (e.g., "China", "Russia")
	Reason      string    `yaml:"reason" json:"reason"`
	BannedAt    time.Time `yaml:"banned_at" json:"banned_at"`
	BannedBy    string    `yaml:"banned_by" json:"banned_by"`                       // Admin who banned
	ExpiresAt   time.Time `yaml:"expires_at,omitempty" json:"expires_at,omitempty"` // Optional expiration time for temporary bans
	Temporary   bool      `yaml:"temporary" json:"temporary"`                       // Whether this is a temporary ban
}

// CountryBanManager manages banned countries
type CountryBanManager struct {
	bannedCountries map[string]*BannedCountry // map[countryCode]*BannedCountry
	mu              sync.RWMutex
	filePath        string
	geoIPService    *GeoIPService // For country lookups
}

// NewCountryBanManager creates a new country ban manager
func NewCountryBanManager(filePath string, geoIPService *GeoIPService) *CountryBanManager {
	manager := &CountryBanManager{
		bannedCountries: make(map[string]*BannedCountry),
		filePath:        filePath,
		geoIPService:    geoIPService,
	}

	// Load existing bans from file
	if err := manager.loadFromFile(); err != nil {
		log.Printf("Warning: Could not load banned countries: %v", err)
	}

	// Start cleanup goroutine for expired temporary bans
	go manager.cleanupExpiredBans()

	return manager
}

// loadFromFile loads banned countries from YAML file
func (cbm *CountryBanManager) loadFromFile() error {
	data, err := os.ReadFile(cbm.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			// File doesn't exist yet, that's okay
			return nil
		}
		return err
	}

	var config struct {
		BannedCountries []BannedCountry `yaml:"banned_countries"`
	}

	if err := yaml.Unmarshal(data, &config); err != nil {
		return err
	}

	cbm.mu.Lock()
	defer cbm.mu.Unlock()

	for _, ban := range config.BannedCountries {
		cbm.bannedCountries[ban.CountryCode] = &BannedCountry{
			CountryCode: ban.CountryCode,
			CountryName: ban.CountryName,
			Reason:      ban.Reason,
			BannedAt:    ban.BannedAt,
			BannedBy:    ban.BannedBy,
			ExpiresAt:   ban.ExpiresAt,
			Temporary:   ban.Temporary,
		}
	}

	log.Printf("Loaded %d banned country(ies) from %s", len(cbm.bannedCountries), cbm.filePath)
	return nil
}

// saveToFile saves banned countries to YAML file
func (cbm *CountryBanManager) saveToFile() error {
	cbm.mu.RLock()
	defer cbm.mu.RUnlock()

	bannedList := make([]BannedCountry, 0, len(cbm.bannedCountries))
	for _, ban := range cbm.bannedCountries {
		bannedList = append(bannedList, *ban)
	}

	config := struct {
		BannedCountries []BannedCountry `yaml:"banned_countries"`
	}{
		BannedCountries: bannedList,
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return err
	}

	return os.WriteFile(cbm.filePath, data, 0644)
}

// IsBannedByIP checks if an IP address belongs to a banned country (and not expired)
func (cbm *CountryBanManager) IsBannedByIP(ip string) bool {
	if cbm.geoIPService == nil || !cbm.geoIPService.IsEnabled() {
		return false
	}

	// Lookup country code for the IP
	countryCode, err := cbm.geoIPService.GetCountryCode(ip)
	if err != nil || countryCode == "" {
		return false
	}

	return cbm.IsBannedByCountryCode(countryCode)
}

// IsBannedByCountryCode checks if a country code is banned (and not expired)
func (cbm *CountryBanManager) IsBannedByCountryCode(countryCode string) bool {
	cbm.mu.RLock()
	defer cbm.mu.RUnlock()

	ban, exists := cbm.bannedCountries[countryCode]
	if !exists {
		return false
	}

	// Check if temporary ban has expired
	if ban.Temporary && !ban.ExpiresAt.IsZero() && time.Now().After(ban.ExpiresAt) {
		return false
	}

	return true
}

// BanCountry bans a country permanently
func (cbm *CountryBanManager) BanCountry(countryCode, countryName, reason, bannedBy string) error {
	return cbm.BanCountryWithDuration(countryCode, countryName, reason, bannedBy, 0)
}

// BanCountryWithDuration bans a country for a specific duration (0 = permanent)
func (cbm *CountryBanManager) BanCountryWithDuration(countryCode, countryName, reason, bannedBy string, duration time.Duration) error {
	cbm.mu.Lock()

	ban := &BannedCountry{
		CountryCode: countryCode,
		CountryName: countryName,
		Reason:      reason,
		BannedAt:    time.Now(),
		BannedBy:    bannedBy,
		Temporary:   duration > 0,
	}

	if duration > 0 {
		ban.ExpiresAt = time.Now().Add(duration)
	}

	cbm.bannedCountries[countryCode] = ban
	cbm.mu.Unlock()

	if duration > 0 {
		log.Printf("Country temporarily banned: %s (%s) (reason: %s, by: %s, duration: %v)", countryCode, countryName, reason, bannedBy, duration)
	} else {
		log.Printf("Country permanently banned: %s (%s) (reason: %s, by: %s)", countryCode, countryName, reason, bannedBy)
	}

	// Save to file
	if err := cbm.saveToFile(); err != nil {
		log.Printf("Error saving banned countries to file: %v", err)
		return err
	}

	return nil
}

// UnbanCountry removes a country from the ban list
func (cbm *CountryBanManager) UnbanCountry(countryCode string) error {
	cbm.mu.Lock()
	delete(cbm.bannedCountries, countryCode)
	cbm.mu.Unlock()

	log.Printf("Country unbanned: %s", countryCode)

	// Save to file
	if err := cbm.saveToFile(); err != nil {
		log.Printf("Error saving banned countries to file: %v", err)
		return err
	}

	return nil
}

// GetBannedCountries returns all banned countries
func (cbm *CountryBanManager) GetBannedCountries() []BannedCountry {
	cbm.mu.RLock()
	defer cbm.mu.RUnlock()

	result := make([]BannedCountry, 0, len(cbm.bannedCountries))
	for _, ban := range cbm.bannedCountries {
		result = append(result, *ban)
	}

	return result
}

// GetBanInfo returns information about a specific banned country
func (cbm *CountryBanManager) GetBanInfo(countryCode string) (*BannedCountry, bool) {
	cbm.mu.RLock()
	defer cbm.mu.RUnlock()
	ban, exists := cbm.bannedCountries[countryCode]
	return ban, exists
}

// cleanupExpiredBans periodically removes expired temporary bans
func (cbm *CountryBanManager) cleanupExpiredBans() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		cbm.mu.Lock()
		now := time.Now()
		removed := 0

		for countryCode, ban := range cbm.bannedCountries {
			if ban.Temporary && !ban.ExpiresAt.IsZero() && now.After(ban.ExpiresAt) {
				delete(cbm.bannedCountries, countryCode)
				removed++
				log.Printf("Temporary ban expired for country: %s (%s)", countryCode, ban.CountryName)
			}
		}

		cbm.mu.Unlock()

		// Save to file if any bans were removed
		if removed > 0 {
			if err := cbm.saveToFile(); err != nil {
				log.Printf("Error saving banned countries after cleanup: %v", err)
			}
		}
	}
}
