package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"regexp"
	"strings"
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

// BannedUserAgent represents a banned User-Agent, matched as a regular expression.
type BannedUserAgent struct {
	Pattern       string    `yaml:"pattern" json:"pattern"`
	CaseSensitive bool      `yaml:"case_sensitive,omitempty" json:"case_sensitive"`
	Reason        string    `yaml:"reason" json:"reason"`
	BannedAt      time.Time `yaml:"banned_at" json:"banned_at"`
	BannedBy      string    `yaml:"banned_by" json:"banned_by"`                       // Admin who banned
	ExpiresAt     time.Time `yaml:"expires_at,omitempty" json:"expires_at,omitempty"` // Optional expiration time for temporary bans
	Temporary     bool      `yaml:"temporary" json:"temporary"`                       // Whether this is a temporary ban

	// InactiveReason is set when a pattern loaded from disk is unusable —
	// either it does not compile, or it is a catch-all that would match every
	// client. Such entries never match anything but are kept (and re-saved) so
	// the operator can see and fix them in the admin UI rather than losing them.
	InactiveReason string `yaml:"-" json:"inactive_reason,omitempty"`
}

// bannedEntry is the internal representation of a ban, holding both the raw string
// and (for CIDR entries) the parsed network for efficient matching.
type bannedEntry struct {
	BannedIP
	network *net.IPNet // non-nil when IP field is a CIDR range
}

// bannedUAEntry is the internal representation of a User-Agent ban, holding the
// compiled regexp alongside the stored definition. re is nil when the pattern
// failed to compile.
type bannedUAEntry struct {
	BannedUserAgent
	re *regexp.Regexp
}

// banFile is the on-disk layout of banned_ips.yaml.
//
// IMPORTANT: saveToFile rewrites the whole file from this struct, so every
// top-level key that must survive a ban/unban/expiry has to be declared here.
// Anything else in the file is silently dropped on the next save.
type banFile struct {
	BannedIPs        []BannedIP        `yaml:"banned_ips"`
	BannedUserAgents []BannedUserAgent `yaml:"banned_user_agents,omitempty"`
}

// IPBanManager manages banned IP addresses, CIDR ranges and User-Agent patterns
type IPBanManager struct {
	entries   map[string]*bannedEntry   // keyed by the raw IP/CIDR string as entered
	uaEntries map[string]*bannedUAEntry // keyed by the raw regexp pattern as entered
	mu        sync.RWMutex
	filePath  string
}

// NewIPBanManager creates a new IP ban manager
func NewIPBanManager(filePath string) *IPBanManager {
	manager := &IPBanManager{
		entries:   make(map[string]*bannedEntry),
		uaEntries: make(map[string]*bannedUAEntry),
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

// CompileUserAgentPattern compiles a User-Agent ban pattern.
//
// Matching is an unanchored substring search — pattern "curl" matches
// "curl/8.5.0" — and is case-insensitive unless caseSensitive is set. Go's
// regexp is RE2, which has no backtracking, so an arbitrarily nasty pattern
// cannot blow up matching time; the only failure mode is a syntax error.
func CompileUserAgentPattern(pattern string, caseSensitive bool) (*regexp.Regexp, error) {
	if strings.TrimSpace(pattern) == "" {
		return nil, fmt.Errorf("pattern is empty")
	}

	expr := pattern
	if !caseSensitive {
		expr = "(?i)" + expr
	}

	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, err
	}
	return re, nil
}

// ValidateUserAgentPattern compiles a pattern and rejects catch-alls.
//
// A pattern that matches the empty string matches *every* possible User-Agent
// (matching is unanchored), which would block every client of the receiver.
// That is never what an operator means, so it is refused outright rather than
// saved. Patterns that are merely very broad (".", "Mozilla") still compile —
// the caller is expected to run them past the admin's own User-Agent first.
func ValidateUserAgentPattern(pattern string, caseSensitive bool) (*regexp.Regexp, error) {
	re, err := CompileUserAgentPattern(pattern, caseSensitive)
	if err != nil {
		return nil, err
	}

	if re.MatchString("") {
		return nil, fmt.Errorf("pattern matches an empty User-Agent, so it would match every client")
	}

	return re, nil
}

// parseUABanEntry validates a stored User-Agent ban. An unusable pattern is
// retained with a recorded reason instead of being dropped.
//
// The full validation (not just compilation) is applied here so that a
// hand-edited catch-all in banned_ips.yaml cannot lock every client out of the
// receiver — the same rule applies whether a pattern arrives via the admin UI
// or an editor.
func parseUABanEntry(ban BannedUserAgent) *bannedUAEntry {
	e := &bannedUAEntry{BannedUserAgent: ban}

	re, err := ValidateUserAgentPattern(ban.Pattern, ban.CaseSensitive)
	if err != nil {
		e.InactiveReason = err.Error()
		log.Printf("IPBanManager: User-Agent ban pattern %q is unusable (%v) — entry kept but inactive", ban.Pattern, err)
		return e
	}

	e.re = re
	e.InactiveReason = ""
	return e
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

	var config banFile

	if err := yaml.Unmarshal(data, &config); err != nil {
		return err
	}

	ibm.mu.Lock()
	defer ibm.mu.Unlock()

	for _, ban := range config.BannedIPs {
		ibm.entries[ban.IP] = parseBanEntry(ban)
	}

	for _, ban := range config.BannedUserAgents {
		if ban.Pattern == "" {
			continue
		}
		ibm.uaEntries[ban.Pattern] = parseUABanEntry(ban)
	}

	log.Printf("Loaded %d banned IP/CIDR entry(s) and %d banned User-Agent pattern(s) from %s",
		len(ibm.entries), len(ibm.uaEntries), ibm.filePath)
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

	uaList := make([]BannedUserAgent, 0, len(ibm.uaEntries))
	for _, e := range ibm.uaEntries {
		uaList = append(uaList, e.BannedUserAgent)
	}

	config := banFile{
		BannedIPs:        bannedList,
		BannedUserAgents: uaList,
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

// IsUserAgentBanned reports whether a User-Agent string matches an active ban.
func (ibm *IPBanManager) IsUserAgentBanned(userAgent string) bool {
	return ibm.MatchingUserAgentBan(userAgent) != nil
}

// MatchingUserAgentBan returns the first active ban whose pattern matches the
// given User-Agent, or nil if none does. Entries whose pattern failed to
// compile, and expired temporary bans, never match.
func (ibm *IPBanManager) MatchingUserAgentBan(userAgent string) *BannedUserAgent {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	if len(ibm.uaEntries) == 0 {
		return nil
	}

	now := time.Now()
	for _, e := range ibm.uaEntries {
		if e.re == nil {
			continue
		}
		if e.Temporary && !e.ExpiresAt.IsZero() && now.After(e.ExpiresAt) {
			continue
		}
		if e.re.MatchString(userAgent) {
			ban := e.BannedUserAgent
			return &ban
		}
	}

	return nil
}

// BanUserAgent bans a User-Agent pattern permanently
func (ibm *IPBanManager) BanUserAgent(pattern, reason, bannedBy string, caseSensitive bool) error {
	return ibm.BanUserAgentWithDuration(pattern, reason, bannedBy, caseSensitive, 0)
}

// BanUserAgentWithDuration bans a User-Agent pattern for a specific duration
// (0 = permanent). The pattern is validated before anything is stored, so an
// invalid or catch-all pattern is rejected without touching the ban list.
func (ibm *IPBanManager) BanUserAgentWithDuration(pattern, reason, bannedBy string, caseSensitive bool, duration time.Duration) error {
	re, err := ValidateUserAgentPattern(pattern, caseSensitive)
	if err != nil {
		return err
	}

	ban := BannedUserAgent{
		Pattern:       pattern,
		CaseSensitive: caseSensitive,
		Reason:        reason,
		BannedAt:      time.Now(),
		BannedBy:      bannedBy,
		Temporary:     duration > 0,
	}

	if duration > 0 {
		ban.ExpiresAt = time.Now().Add(duration)
	}

	ibm.mu.Lock()
	ibm.uaEntries[pattern] = &bannedUAEntry{BannedUserAgent: ban, re: re}
	ibm.mu.Unlock()

	if duration > 0 {
		log.Printf("User-Agent temporarily banned: %q (reason: %s, by: %s, duration: %v)", pattern, reason, bannedBy, duration)
	} else {
		log.Printf("User-Agent permanently banned: %q (reason: %s, by: %s)", pattern, reason, bannedBy)
	}

	if err := ibm.saveToFile(); err != nil {
		log.Printf("Error saving banned User-Agents to file: %v", err)
		return err
	}

	return nil
}

// UnbanUserAgent removes a User-Agent pattern from the ban list
func (ibm *IPBanManager) UnbanUserAgent(pattern string) error {
	ibm.mu.Lock()
	_, existed := ibm.uaEntries[pattern]
	delete(ibm.uaEntries, pattern)
	ibm.mu.Unlock()

	if !existed {
		return fmt.Errorf("no such banned User-Agent pattern: %s", pattern)
	}

	log.Printf("User-Agent unbanned: %q", pattern)

	if err := ibm.saveToFile(); err != nil {
		log.Printf("Error saving banned User-Agents after unban: %v", err)
		return err
	}

	return nil
}

// GetBannedUserAgents returns all banned User-Agent patterns
func (ibm *IPBanManager) GetBannedUserAgents() []BannedUserAgent {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	result := make([]BannedUserAgent, 0, len(ibm.uaEntries))
	for _, e := range ibm.uaEntries {
		result = append(result, e.BannedUserAgent)
	}

	return result
}

// GetUserAgentBanInfo returns information about a specific banned pattern
func (ibm *IPBanManager) GetUserAgentBanInfo(pattern string) (*BannedUserAgent, bool) {
	ibm.mu.RLock()
	defer ibm.mu.RUnlock()

	e, exists := ibm.uaEntries[pattern]
	if !exists {
		return nil, false
	}
	ban := e.BannedUserAgent
	return &ban, true
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

		for key, e := range ibm.uaEntries {
			if e.Temporary && !e.ExpiresAt.IsZero() && now.After(e.ExpiresAt) {
				delete(ibm.uaEntries, key)
				removed++
				log.Printf("Temporary ban expired for User-Agent pattern: %q", e.Pattern)
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
