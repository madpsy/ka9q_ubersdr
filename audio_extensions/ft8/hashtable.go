package ft8

import (
	"sync"
	"time"
)

/*
 * Callsign Hash Table for FT8/FT4
 * Stores callsigns for hash resolution (22-bit, 12-bit, 10-bit hashes)
 * Based on KiwiSDR implementation
 */

// HashType represents the type of hash (22, 12, or 10 bits)
type HashType int

const (
	Hash22Bits HashType = iota
	Hash12Bits
	Hash10Bits
)

// HashEntry stores a callsign with its hash values and timestamp
type HashEntry struct {
	Callsign  string
	Hash22    uint32
	Hash12    uint16
	Hash10    uint16
	Timestamp time.Time
}

// CallsignHashTable stores callsigns for hash resolution
type CallsignHashTable struct {
	entries map[uint32]*HashEntry // Keyed by 22-bit hash
	mu      sync.RWMutex
	maxAge  time.Duration // Maximum age before cleanup
}

// NewCallsignHashTable creates a new callsign hash table
func NewCallsignHashTable(maxAge time.Duration) *CallsignHashTable {
	if maxAge == 0 {
		maxAge = 1 * time.Hour // Default: 1 hour
	}

	return &CallsignHashTable{
		entries: make(map[uint32]*HashEntry),
		maxAge:  maxAge,
	}
}

// SaveCallsign computes hash values for a callsign and stores it
// Returns the computed hash values
func (ht *CallsignHashTable) SaveCallsign(callsign string) (n22 uint32, n12 uint16, n10 uint16, ok bool) {
	// Compute 58-bit intermediate value
	n58 := uint64(0)
	i := 0

	// Process up to 11 characters
	for i < len(callsign) && i < 11 {
		j := Nchar(callsign[i], CharTableAlphanumSpaceSlash)
		if j < 0 {
			return 0, 0, 0, false // Invalid character
		}
		n58 = (38 * n58) + uint64(j)
		i++
	}

	// Pad with trailing spaces (j=0 for space)
	for i < 11 {
		n58 = 38 * n58
		i++
	}

	// Compute hash values
	// 22-bit hash using magic number multiplication
	n22 = uint32((47055833459 * n58) >> (64 - 22) & 0x3FFFFF)
	n12 = uint16(n22 >> 10)
	n10 = uint16(n22 >> 12)

	// Store in hash table
	ht.mu.Lock()
	defer ht.mu.Unlock()

	ht.entries[n22] = &HashEntry{
		Callsign:  callsign,
		Hash22:    n22,
		Hash12:    n12,
		Hash10:    n10,
		Timestamp: time.Now(),
	}

	return n22, n12, n10, true
}

// LookupHash looks up a callsign by its hash value
func (ht *CallsignHashTable) LookupHash(hashType HashType, hash uint32) (callsign string, found bool) {
	ht.mu.RLock()
	defer ht.mu.RUnlock()

	// Search through all entries for matching hash
	for _, entry := range ht.entries {
		var match bool
		switch hashType {
		case Hash22Bits:
			match = entry.Hash22 == hash
		case Hash12Bits:
			match = uint32(entry.Hash12) == hash
		case Hash10Bits:
			match = uint32(entry.Hash10) == hash
		}

		if match {
			return entry.Callsign, true
		}
	}

	return "", false
}

// Cleanup removes entries older than maxAge
func (ht *CallsignHashTable) Cleanup() int {
	ht.mu.Lock()
	defer ht.mu.Unlock()

	now := time.Now()
	removed := 0

	for hash, entry := range ht.entries {
		if now.Sub(entry.Timestamp) > ht.maxAge {
			delete(ht.entries, hash)
			removed++
		}
	}

	return removed
}

// Size returns the number of entries in the hash table
func (ht *CallsignHashTable) Size() int {
	ht.mu.RLock()
	defer ht.mu.RUnlock()
	return len(ht.entries)
}

// Clear removes all entries from the hash table
func (ht *CallsignHashTable) Clear() {
	ht.mu.Lock()
	defer ht.mu.Unlock()
	ht.entries = make(map[uint32]*HashEntry)
}
