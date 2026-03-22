package main

import (
	"sync"
)

// FreeDVReporterUser holds the current known state for a single user on the
// FreeDV Reporter network. Fields are updated incrementally as events arrive.
type FreeDVReporterUser struct {
	SID          string  `json:"sid"`
	Callsign     string  `json:"callsign"`
	GridSquare   string  `json:"grid_square"`
	Version      string  `json:"version"`
	RxOnly       bool    `json:"rx_only"`
	FreqHz       uint64  `json:"freq_hz"`
	Mode         string  `json:"mode"`
	Transmitting bool    `json:"transmitting"`
	LastTx       string  `json:"last_tx,omitempty"`
	LastRxCall   string  `json:"last_rx_callsign,omitempty"`
	LastRxSNR    float32 `json:"last_rx_snr,omitempty"`
	LastRxMode   string  `json:"last_rx_mode,omitempty"`
	Message      string  `json:"message,omitempty"`
	ConnectTime  string  `json:"connect_time,omitempty"`
	LastUpdate   string  `json:"last_update,omitempty"`

	// Enriched fields — computed server-side, not sent by the FreeDV Reporter server.
	Country    string   `json:"country,omitempty"`
	Continent  string   `json:"continent,omitempty"`
	DistanceKm *float64 `json:"distance_km,omitempty"`
	BearingDeg *float64 `json:"bearing_deg,omitempty"`
}

// EnrichFreeDVUser populates the derived Country, Continent, DistanceKm and
// BearingDeg fields on a FreeDVReporterUser using the CTY database and the
// receiver's Maidenhead locator. Either argument may be nil/empty, in which
// case the corresponding fields are left unchanged.
func EnrichFreeDVUser(user *FreeDVReporterUser, receiverLocator string, ctyDB *CTYDatabase) {
	// Country / continent from callsign via CTY database
	if ctyDB != nil && user.Callsign != "" {
		if info := ctyDB.LookupCallsignFull(user.Callsign); info != nil {
			user.Country = info.Country
			user.Continent = info.Continent
		}
	}

	// Distance / bearing from grid square vs receiver locator
	if receiverLocator != "" && user.GridSquare != "" {
		if dist, bearing, err := CalculateDistanceAndBearingFromLocators(receiverLocator, user.GridSquare); err == nil {
			user.DistanceKm = &dist
			user.BearingDeg = &bearing
		}
	}
}

// FreeDVReporterStore is a thread-safe in-memory map of active FreeDV Reporter users,
// keyed by their Socket.IO session ID (sid).
type FreeDVReporterStore struct {
	mu    sync.RWMutex
	users map[string]*FreeDVReporterUser
}

// NewFreeDVReporterStore creates an empty store.
func NewFreeDVReporterStore() *FreeDVReporterStore {
	return &FreeDVReporterStore{
		users: make(map[string]*FreeDVReporterUser),
	}
}

// Clear removes all users from the store (called on disconnect so stale data
// is not served to new subscribers after a reconnect).
func (s *FreeDVReporterStore) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.users = make(map[string]*FreeDVReporterUser)
}

// AddOrUpdate inserts or replaces the base record for a user.
func (s *FreeDVReporterStore) AddOrUpdate(user FreeDVReporterUser) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Preserve mutable fields that arrive via separate events if the user already exists.
	if existing, ok := s.users[user.SID]; ok {
		user.FreqHz = existing.FreqHz
		user.Mode = existing.Mode
		user.Transmitting = existing.Transmitting
		user.LastTx = existing.LastTx
		user.LastRxCall = existing.LastRxCall
		user.LastRxSNR = existing.LastRxSNR
		user.LastRxMode = existing.LastRxMode
		user.Message = existing.Message
	}
	s.users[user.SID] = &user
}

// Remove deletes a user by SID.
func (s *FreeDVReporterStore) Remove(sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.users, sid)
}

// UpdateFrequency updates the frequency for a user.
func (s *FreeDVReporterStore) UpdateFrequency(sid string, freqHz uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.users[sid]; ok {
		u.FreqHz = freqHz
	}
}

// UpdateTx updates the transmit state for a user.
func (s *FreeDVReporterStore) UpdateTx(sid string, mode string, transmitting bool, lastTx string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.users[sid]; ok {
		u.Mode = mode
		u.Transmitting = transmitting
		u.LastTx = lastTx
	}
}

// UpdateRx updates the last-received-station info for a user.
func (s *FreeDVReporterStore) UpdateRx(sid string, receivedCallsign string, snr float32, mode string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.users[sid]; ok {
		u.LastRxCall = receivedCallsign
		u.LastRxSNR = snr
		u.LastRxMode = mode
	}
}

// UpdateMessage updates the status message for a user.
func (s *FreeDVReporterStore) UpdateMessage(sid string, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.users[sid]; ok {
		u.Message = message
	}
}

// Snapshot returns a copy of all current users as a slice.
func (s *FreeDVReporterStore) Snapshot() []FreeDVReporterUser {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]FreeDVReporterUser, 0, len(s.users))
	for _, u := range s.users {
		out = append(out, *u)
	}
	return out
}

// Get returns a copy of a single user by SID, and whether it was found.
func (s *FreeDVReporterStore) Get(sid string) (FreeDVReporterUser, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[sid]
	if !ok {
		return FreeDVReporterUser{}, false
	}
	return *u, true
}
