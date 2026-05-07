package main

import (
	"log"
	"os"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// BannedASN represents a banned Autonomous System Number
type BannedASN struct {
	ASN       uint      `yaml:"asn" json:"asn"`           // Autonomous System Number (e.g. 62044)
	OrgName   string    `yaml:"org_name" json:"org_name"` // Human-readable organisation name
	Reason    string    `yaml:"reason" json:"reason"`
	BannedAt  time.Time `yaml:"banned_at" json:"banned_at"`
	BannedBy  string    `yaml:"banned_by" json:"banned_by"`
	ExpiresAt time.Time `yaml:"expires_at,omitempty" json:"expires_at,omitempty"`
	Temporary bool      `yaml:"temporary" json:"temporary"`
}

// ASNBanManager manages banned ASNs
type ASNBanManager struct {
	bannedASNs   map[uint]*BannedASN // map[asn]*BannedASN
	mu           sync.RWMutex
	filePath     string
	geoIPService *GeoIPService
}

// NewASNBanManager creates a new ASN ban manager
func NewASNBanManager(filePath string, geoIPService *GeoIPService) *ASNBanManager {
	manager := &ASNBanManager{
		bannedASNs:   make(map[uint]*BannedASN),
		filePath:     filePath,
		geoIPService: geoIPService,
	}

	if err := manager.loadFromFile(); err != nil {
		log.Printf("Warning: Could not load banned ASNs: %v", err)
	}

	go manager.cleanupExpiredBans()

	return manager
}

// loadFromFile loads banned ASNs from YAML file
func (abm *ASNBanManager) loadFromFile() error {
	data, err := os.ReadFile(abm.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var config struct {
		BannedASNs []BannedASN `yaml:"banned_asns"`
	}

	if err := yaml.Unmarshal(data, &config); err != nil {
		return err
	}

	abm.mu.Lock()
	defer abm.mu.Unlock()

	for _, ban := range config.BannedASNs {
		b := ban // copy
		abm.bannedASNs[ban.ASN] = &b
	}

	log.Printf("Loaded %d banned ASN(s) from %s", len(abm.bannedASNs), abm.filePath)
	return nil
}

// saveToFile saves banned ASNs to YAML file
func (abm *ASNBanManager) saveToFile() error {
	abm.mu.RLock()
	defer abm.mu.RUnlock()

	list := make([]BannedASN, 0, len(abm.bannedASNs))
	for _, ban := range abm.bannedASNs {
		list = append(list, *ban)
	}

	config := struct {
		BannedASNs []BannedASN `yaml:"banned_asns"`
	}{BannedASNs: list}

	data, err := yaml.Marshal(config)
	if err != nil {
		return err
	}

	return os.WriteFile(abm.filePath, data, 0644)
}

// IsBannedByIP checks if an IP address belongs to a banned ASN
func (abm *ASNBanManager) IsBannedByIP(ip string) bool {
	if abm.geoIPService == nil || !abm.geoIPService.IsEnabled() || !abm.geoIPService.IsASNEnabled() {
		return false
	}

	asn, _, err := abm.geoIPService.GetASN(ip)
	if err != nil || asn == 0 {
		return false
	}

	return abm.IsBannedByASN(asn)
}

// IsBannedByASN checks if an ASN number is banned (and not expired)
func (abm *ASNBanManager) IsBannedByASN(asn uint) bool {
	abm.mu.RLock()
	defer abm.mu.RUnlock()

	ban, exists := abm.bannedASNs[asn]
	if !exists {
		return false
	}

	if ban.Temporary && !ban.ExpiresAt.IsZero() && time.Now().After(ban.ExpiresAt) {
		return false
	}

	return true
}

// BanASN bans an ASN permanently
func (abm *ASNBanManager) BanASN(asn uint, orgName, reason, bannedBy string) error {
	return abm.BanASNWithDuration(asn, orgName, reason, bannedBy, 0)
}

// BanASNWithDuration bans an ASN for a specific duration (0 = permanent)
func (abm *ASNBanManager) BanASNWithDuration(asn uint, orgName, reason, bannedBy string, duration time.Duration) error {
	abm.mu.Lock()

	ban := &BannedASN{
		ASN:       asn,
		OrgName:   orgName,
		Reason:    reason,
		BannedAt:  time.Now(),
		BannedBy:  bannedBy,
		Temporary: duration > 0,
	}

	if duration > 0 {
		ban.ExpiresAt = time.Now().Add(duration)
	}

	abm.bannedASNs[asn] = ban
	abm.mu.Unlock()

	if duration > 0 {
		log.Printf("ASN temporarily banned: AS%d (%s) reason: %s by: %s duration: %v", asn, orgName, reason, bannedBy, duration)
	} else {
		log.Printf("ASN permanently banned: AS%d (%s) reason: %s by: %s", asn, orgName, reason, bannedBy)
	}

	return abm.saveToFile()
}

// UnbanASN removes an ASN from the ban list
func (abm *ASNBanManager) UnbanASN(asn uint) error {
	abm.mu.Lock()
	delete(abm.bannedASNs, asn)
	abm.mu.Unlock()

	log.Printf("ASN unbanned: AS%d", asn)

	return abm.saveToFile()
}

// GetBannedASNs returns all banned ASNs
func (abm *ASNBanManager) GetBannedASNs() []BannedASN {
	abm.mu.RLock()
	defer abm.mu.RUnlock()

	result := make([]BannedASN, 0, len(abm.bannedASNs))
	for _, ban := range abm.bannedASNs {
		result = append(result, *ban)
	}

	return result
}

// GetBanInfo returns information about a specific banned ASN
func (abm *ASNBanManager) GetBanInfo(asn uint) (*BannedASN, bool) {
	abm.mu.RLock()
	defer abm.mu.RUnlock()
	ban, exists := abm.bannedASNs[asn]
	return ban, exists
}

// cleanupExpiredBans periodically removes expired temporary bans
func (abm *ASNBanManager) cleanupExpiredBans() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		abm.mu.Lock()
		now := time.Now()
		removed := 0

		for asn, ban := range abm.bannedASNs {
			if ban.Temporary && !ban.ExpiresAt.IsZero() && now.After(ban.ExpiresAt) {
				delete(abm.bannedASNs, asn)
				removed++
				log.Printf("Temporary ASN ban expired: AS%d (%s)", asn, ban.OrgName)
			}
		}

		abm.mu.Unlock()

		if removed > 0 {
			if err := abm.saveToFile(); err != nil {
				log.Printf("Error saving banned ASNs after cleanup: %v", err)
			}
		}
	}
}
