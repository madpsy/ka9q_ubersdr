package main

import (
	"log"
	"net"
	"os"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// BannedIP represents a banned IP address or CIDR range
type BannedIP struct {
	IP        string    `yaml:"ip" json:"ip"`
	Reason    string    `yaml:"reason" json:"reason"`
	BannedAt  time.Time `yaml:"banned_at" json:"banned_at"`
	BannedBy  string    `yaml:"banned_by" json:"banned_by"`                       // Admin who banned
	ExpiresAt time.Time `yaml:"expires_at,omitempty" json:"expires_at,omitempty"` // Optional expiration time for temporary bans
	Temporary bool      `yaml:"temporary" json:"temporary"`                       // Whether this is a temporary ban
}

// bannedEntry is the internal representation of a ban, holding both the raw string
// and (for CIDR entries) the parsed network for efficient matching.
type bannedEntry struct {
	BannedIP
	network *net.IPNet // non-nil when IP field is a CIDR range
}

// IPBanManager manages banned IP addresses and CIDR ranges
type IPBanManager struct {
	entries  map[string]*bannedEntry // keyed by the raw IP/CIDR string as entered
	mu       sync.RWMutex
	filePath string
}

// NewIPBanManager creates a new IP ban manager
func NewIPBanManager(filePath string) *IPBanManager {
	manager := &IPBanManager{
		entries:  make(map[string]*bannedEntry),
		filePath: filePath,
	}

	// Load existing bans from file
	if err := manager.loadFromFile(); err != nil {
		log.Printf("Warning: Could not load banned IPs: %v", err)
	}

	// Start cleanup goroutine for expired temporary bans
	go manager.cleanupExpiredBans()

	return manager
}

// parseBanEntry parses a raw IP/CIDR string into a bannedEntry.
// For plain IPs the network field is nil; for CIDRs it is set.
func parseBanEntry(ban BannedIP) *bannedEntry {
	e := &bannedEntry{BannedIP: ban}

	// Try CIDR first
	if _, network, err := net.ParseCIDR(ban.IP); err == nil {
		e.network = network
		return e
	}

	// Plain IP — validate but don't store a network
	if net.ParseIP(ban.IP) == nil {
		log.Printf("IPBanManager: ignoring unrecognised IP/CIDR entry %q", ban.IP)
	}
	return e
}

// ipMatchesEntry reports whether the given (real) IP address matches a ban entry,
// handling both exact-IP and CIDR-range entries.
func ipMatchesEntry(ip string, e *bannedEntry) bool {
	if e.network != nil {
		// CIDR entry — parse the candidate IP and test containment
		parsed := net.ParseIP(ip)
		if parsed == nil {
			return false
		}
		return e.network.Contains(parsed)
	}
	// Plain IP — exact match
	return e.IP == ip
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
		ibm.entries[ban.IP] = parseBanEntry(ban)
	}

	log.Printf("Loaded %d banned IP/CIDR entry(s) from %s", len(ibm.entries), ibm.filePath)
	return nil
}

// saveToFile saves banned IPs to YAML file
func (ibm *IPBanManager) saveToFile() error {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	bannedList := make([]BannedIP, 0, len(ibm.entries))
	for _, e := range ibm.entries {
		bannedList = append(bannedList, e.BannedIP)
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

// IsBanned checks if an IP address is banned (and not expired).
// It handles both exact-IP bans and CIDR-range bans.
func (ibm *IPBanManager) IsBanned(ip string) bool {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	now := time.Now()

	for _, e := range ibm.entries {
		// Check expiry first (cheap)
		if e.Temporary && !e.ExpiresAt.IsZero() && now.After(e.ExpiresAt) {
			continue
		}
		if ipMatchesEntry(ip, e) {
			return true
		}
	}

	return false
}

// BanIP bans an IP address or CIDR range permanently
func (ibm *IPBanManager) BanIP(ip, reason, bannedBy string) error {
	return ibm.BanIPWithDuration(ip, reason, bannedBy, 0)
}

// BanIPWithDuration bans an IP address or CIDR range for a specific duration (0 = permanent)
func (ibm *IPBanManager) BanIPWithDuration(ip, reason, bannedBy string, duration time.Duration) error {
	ban := BannedIP{
		IP:        ip,
		Reason:    reason,
		BannedAt:  time.Now(),
		BannedBy:  bannedBy,
		Temporary: duration > 0,
	}

	if duration > 0 {
		ban.ExpiresAt = time.Now().Add(duration)
	}

	entry := parseBanEntry(ban)

	ibm.mu.Lock()
	ibm.entries[ip] = entry
	ibm.mu.Unlock()

	if duration > 0 {
		log.Printf("IP/CIDR temporarily banned: %s (reason: %s, by: %s, duration: %v)", ip, reason, bannedBy, duration)
	} else {
		log.Printf("IP/CIDR permanently banned: %s (reason: %s, by: %s)", ip, reason, bannedBy)
	}

	// Save to file
	if err := ibm.saveToFile(); err != nil {
		log.Printf("Error saving banned IPs to file: %v", err)
		return err
	}

	return nil
}

// UnbanIP removes an IP or CIDR range from the ban list
func (ibm *IPBanManager) UnbanIP(ip string) error {
	ibm.mu.Lock()
	delete(ibm.entries, ip)
	ibm.mu.Unlock()

	log.Printf("IP/CIDR unbanned: %s", ip)

	// Save to file
	if err := ibm.saveToFile(); err != nil {
		log.Printf("Error saving banned IPs after unban: %v", err)
		return err
	}

	return nil
}

// GetBannedIPs returns all banned IPs/CIDRs
func (ibm *IPBanManager) GetBannedIPs() []BannedIP {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	result := make([]BannedIP, 0, len(ibm.entries))
	for _, e := range ibm.entries {
		result = append(result, e.BannedIP)
	}

	return result
}

// GetBanInfo returns information about a specific banned IP/CIDR entry
func (ibm *IPBanManager) GetBanInfo(ip string) (*BannedIP, bool) {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()
	e, exists := ibm.entries[ip]
	if !exists {
		return nil, false
	}
	ban := e.BannedIP
	return &ban, true
}

// MatchingBanEntry returns the first active ban entry that matches the given IP,
// or nil if the IP is not banned. Useful for kick operations that need to iterate
// all sessions and check each real IP against all ban entries (including CIDRs).
func (ibm *IPBanManager) MatchingBanEntry(ip string) *BannedIP {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	now := time.Now()
	for _, e := range ibm.entries {
		if e.Temporary && !e.ExpiresAt.IsZero() && now.After(e.ExpiresAt) {
			continue
		}
		if ipMatchesEntry(ip, e) {
			ban := e.BannedIP
			return &ban
		}
	}
	return nil
}

// cleanupExpiredBans periodically removes expired temporary bans
func (ibm *IPBanManager) cleanupExpiredBans() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		ibm.mu.Lock()
		now := time.Now()
		removed := 0

		for key, e := range ibm.entries {
			if e.Temporary && !e.ExpiresAt.IsZero() && now.After(e.ExpiresAt) {
				delete(ibm.entries, key)
				removed++
				log.Printf("Temporary ban expired for IP/CIDR: %s", e.IP)
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
