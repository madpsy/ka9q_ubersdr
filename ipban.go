package main

import (
	"log"
	"os"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// BannedIP represents a banned IP address
type BannedIP struct {
	IP        string    `yaml:"ip" json:"ip"`
	Reason    string    `yaml:"reason" json:"reason"`
	BannedAt  time.Time `yaml:"banned_at" json:"banned_at"`
	BannedBy  string    `yaml:"banned_by" json:"banned_by"`                       // Admin who banned
	ExpiresAt time.Time `yaml:"expires_at,omitempty" json:"expires_at,omitempty"` // Optional expiration time for temporary bans
	Temporary bool      `yaml:"temporary" json:"temporary"`                       // Whether this is a temporary ban
}

// IPBanManager manages banned IP addresses
type IPBanManager struct {
	bannedIPs map[string]*BannedIP
	mu        sync.RWMutex
	filePath  string
}

// NewIPBanManager creates a new IP ban manager
func NewIPBanManager(filePath string) *IPBanManager {
	manager := &IPBanManager{
		bannedIPs: make(map[string]*BannedIP),
		filePath:  filePath,
	}

	// Load existing bans from file
	if err := manager.loadFromFile(); err != nil {
		log.Printf("Warning: Could not load banned IPs: %v", err)
	}

	// Start cleanup goroutine for expired temporary bans
	go manager.cleanupExpiredBans()

	return manager
}

// loadFromFile loads banned IPs from YAML file
func (ibm *IPBanManager) loadFromFile() error {
	data, err := os.ReadFile(ibm.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			// File doesn't exist yet, that's okay
			return nil
		}
		return err
	}

	var config struct {
		BannedIPs []BannedIP `yaml:"banned_ips"`
	}

	if err := yaml.Unmarshal(data, &config); err != nil {
		return err
	}

	ibm.mu.Lock()
	defer ibm.mu.Unlock()

	for _, ban := range config.BannedIPs {
		ibm.bannedIPs[ban.IP] = &BannedIP{
			IP:       ban.IP,
			Reason:   ban.Reason,
			BannedAt: ban.BannedAt,
			BannedBy: ban.BannedBy,
		}
	}

	log.Printf("Loaded %d banned IP(s) from %s", len(ibm.bannedIPs), ibm.filePath)
	return nil
}

// saveToFile saves banned IPs to YAML file
func (ibm *IPBanManager) saveToFile() error {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	bannedList := make([]BannedIP, 0, len(ibm.bannedIPs))
	for _, ban := range ibm.bannedIPs {
		bannedList = append(bannedList, *ban)
	}

	config := struct {
		BannedIPs []BannedIP `yaml:"banned_ips"`
	}{
		BannedIPs: bannedList,
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return err
	}

	return os.WriteFile(ibm.filePath, data, 0644)
}

// IsBanned checks if an IP address is banned (and not expired)
func (ibm *IPBanManager) IsBanned(ip string) bool {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	ban, exists := ibm.bannedIPs[ip]
	if !exists {
		return false
	}

	// Check if temporary ban has expired
	if ban.Temporary && !ban.ExpiresAt.IsZero() && time.Now().After(ban.ExpiresAt) {
		return false
	}

	return true
}

// BanIP bans an IP address permanently
func (ibm *IPBanManager) BanIP(ip, reason, bannedBy string) error {
	return ibm.BanIPWithDuration(ip, reason, bannedBy, 0)
}

// BanIPWithDuration bans an IP address for a specific duration (0 = permanent)
func (ibm *IPBanManager) BanIPWithDuration(ip, reason, bannedBy string, duration time.Duration) error {
	ibm.mu.Lock()

	ban := &BannedIP{
		IP:        ip,
		Reason:    reason,
		BannedAt:  time.Now(),
		BannedBy:  bannedBy,
		Temporary: duration > 0,
	}

	if duration > 0 {
		ban.ExpiresAt = time.Now().Add(duration)
	}

	ibm.bannedIPs[ip] = ban
	ibm.mu.Unlock()

	if duration > 0 {
		log.Printf("IP temporarily banned: %s (reason: %s, by: %s, duration: %v)", ip, reason, bannedBy, duration)
	} else {
		log.Printf("IP permanently banned: %s (reason: %s, by: %s)", ip, reason, bannedBy)
	}

	// Save to file
	if err := ibm.saveToFile(); err != nil {
		log.Printf("Error saving banned IPs to file: %v", err)
		return err
	}

	return nil
}

// UnbanIP removes an IP from the ban list
func (ibm *IPBanManager) UnbanIP(ip string) error {
	ibm.mu.Lock()
	delete(ibm.bannedIPs, ip)
	ibm.mu.Unlock()

	log.Printf("IP unbanned: %s", ip)

	// Save to file
	if err := ibm.saveToFile(); err != nil {
		log.Printf("Error saving banned IPs to file: %v", err)
		return err
	}

	return nil
}

// GetBannedIPs returns all banned IPs
func (ibm *IPBanManager) GetBannedIPs() []BannedIP {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	result := make([]BannedIP, 0, len(ibm.bannedIPs))
	for _, ban := range ibm.bannedIPs {
		result = append(result, *ban)
	}

	return result
}

// GetBanInfo returns information about a specific banned IP
func (ibm *IPBanManager) GetBanInfo(ip string) (*BannedIP, bool) {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()
	ban, exists := ibm.bannedIPs[ip]
	return ban, exists
}

// cleanupExpiredBans periodically removes expired temporary bans
func (ibm *IPBanManager) cleanupExpiredBans() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		ibm.mu.Lock()
		now := time.Now()
		removed := 0

		for ip, ban := range ibm.bannedIPs {
			if ban.Temporary && !ban.ExpiresAt.IsZero() && now.After(ban.ExpiresAt) {
				delete(ibm.bannedIPs, ip)
				removed++
				log.Printf("Temporary ban expired for IP: %s", ip)
			}
		}

		ibm.mu.Unlock()

		// Save to file if any bans were removed
		if removed > 0 {
			if err := ibm.saveToFile(); err != nil {
				log.Printf("Error saving banned IPs after cleanup: %v", err)
			}
		}
	}
}
