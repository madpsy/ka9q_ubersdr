package main

import "time"

// NotificationEventType identifies which kind of event is being published.
type NotificationEventType string

const (
	EventTypeCWSpot        NotificationEventType = "cw_spot"
	EventTypeDXSpot        NotificationEventType = "dx_spot"
	EventTypeDigitalDecode NotificationEventType = "digital_decode"
	EventTypeSpaceWeather  NotificationEventType = "space_weather"
	EventTypeAntennaSwitch NotificationEventType = "antenna_switch"
	EventTypeRotator       NotificationEventType = "rotator"
	EventTypeSystemMonitor NotificationEventType = "system_monitor"
	EventTypeUserSession   NotificationEventType = "user_session"
	EventTypeServerStartup NotificationEventType = "server_startup"
	EventTypeVoiceActivity NotificationEventType = "voice_activity"
)

// NotificationEvent is the interface implemented by every event type.
// The manager uses Type() to look up matching rules and Data() to pass
// the concrete value to the filter and template engines.
type NotificationEvent interface {
	EventType() NotificationEventType
}

// ─── CW Spot ────────────────────────────────────────────────────────────────

// CWSpotEvent wraps a CWSkimmerSpot for the notification system.
type CWSpotEvent struct {
	DXCall      string    `json:"dx_call"`
	Spotter     string    `json:"spotter"`
	Frequency   float64   `json:"frequency"` // Hz
	Band        string    `json:"band"`
	SNR         int       `json:"snr"`
	WPM         int       `json:"wpm"`
	Mode        string    `json:"mode"` // "CW" or "RTTY"
	Comment     string    `json:"comment"`
	Time        time.Time `json:"time"`
	Country     string    `json:"country"`
	CountryCode string    `json:"country_code"`
	CQZone      int       `json:"cq_zone"`
	ITUZone     int       `json:"itu_zone"`
	Continent   string    `json:"continent"`
	Latitude    float64   `json:"latitude"`
	Longitude   float64   `json:"longitude"`
	DistanceKm  *float64  `json:"distance_km,omitempty"`
	BearingDeg  *float64  `json:"bearing_deg,omitempty"`
	Name        string    `json:"name,omitempty"`
	Grid        string    `json:"grid,omitempty"`
}

func (e CWSpotEvent) EventType() NotificationEventType { return EventTypeCWSpot }

// newCWSpotEvent converts a CWSkimmerSpot to a CWSpotEvent.
func newCWSpotEvent(s CWSkimmerSpot) CWSpotEvent {
	return CWSpotEvent{
		DXCall:      s.DXCall,
		Spotter:     s.Spotter,
		Frequency:   s.Frequency,
		Band:        s.Band,
		SNR:         s.SNR,
		WPM:         s.WPM,
		Mode:        s.Mode,
		Comment:     s.Comment,
		Time:        s.Time,
		Country:     s.Country,
		CountryCode: s.CountryCode,
		CQZone:      s.CQZone,
		ITUZone:     s.ITUZone,
		Continent:   s.Continent,
		Latitude:    s.Latitude,
		Longitude:   s.Longitude,
		DistanceKm:  s.DistanceKm,
		BearingDeg:  s.BearingDeg,
		Name:        s.Name,
		Grid:        s.Grid,
	}
}

// ─── DX Spot ─────────────────────────────────────────────────────────────────

// DXSpotEvent wraps a DXSpot for the notification system.
type DXSpotEvent struct {
	DXCall      string    `json:"dx_call"`
	Spotter     string    `json:"spotter"`
	Frequency   float64   `json:"frequency"` // Hz
	Band        string    `json:"band"`
	Comment     string    `json:"comment"`
	Time        time.Time `json:"time"`
	Country     string    `json:"country"`
	CountryCode string    `json:"country_code"`
	Continent   string    `json:"continent"`
	TimeOffset  float64   `json:"time_offset"`
}

func (e DXSpotEvent) EventType() NotificationEventType { return EventTypeDXSpot }

// newDXSpotEvent converts a DXSpot to a DXSpotEvent.
func newDXSpotEvent(s DXSpot) DXSpotEvent {
	return DXSpotEvent{
		DXCall:      s.DXCall,
		Spotter:     s.Spotter,
		Frequency:   s.Frequency,
		Band:        s.Band,
		Comment:     s.Comment,
		Time:        s.Time,
		Country:     s.Country,
		CountryCode: s.CountryCode,
		Continent:   s.Continent,
		TimeOffset:  s.TimeOffset,
	}
}

// ─── Digital Decode ──────────────────────────────────────────────────────────

// DigitalDecodeEvent wraps a DecodeInfo for the notification system.
type DigitalDecodeEvent struct {
	Callsign      string    `json:"callsign"`
	Locator       string    `json:"locator"`
	Country       string    `json:"country"`
	CountryCode   string    `json:"country_code"`
	CQZone        int       `json:"cq_zone"`
	ITUZone       int       `json:"itu_zone"`
	Continent     string    `json:"continent"`
	SNR           int       `json:"snr"`
	Frequency     uint64    `json:"frequency"` // Hz
	DialFrequency uint64    `json:"dial_frequency"`
	Timestamp     time.Time `json:"timestamp"`
	Mode          string    `json:"mode"` // "FT8", "FT4", "WSPR", "JS8"
	Message       string    `json:"message"`
	Band          string    `json:"band"`
	DistanceKm    *float64  `json:"distance_km,omitempty"`
	BearingDeg    *float64  `json:"bearing_deg,omitempty"`
	// WSPR-specific
	DBm         int    `json:"dbm,omitempty"`
	TxFrequency uint64 `json:"tx_frequency,omitempty"`
}

func (e DigitalDecodeEvent) EventType() NotificationEventType { return EventTypeDigitalDecode }

// newDigitalDecodeEvent converts a DecodeInfo to a DigitalDecodeEvent.
func newDigitalDecodeEvent(d DecodeInfo) DigitalDecodeEvent {
	return DigitalDecodeEvent{
		Callsign:      d.Callsign,
		Locator:       d.Locator,
		Country:       d.Country,
		CountryCode:   d.CountryCode,
		CQZone:        d.CQZone,
		ITUZone:       d.ITUZone,
		Continent:     d.Continent,
		SNR:           d.SNR,
		Frequency:     d.Frequency,
		DialFrequency: d.DialFrequency,
		Timestamp:     d.Timestamp,
		Mode:          d.Mode,
		Message:       d.Message,
		Band:          d.BandName,
		DistanceKm:    d.DistanceKm,
		BearingDeg:    d.BearingDeg,
		DBm:           d.DBm,
		TxFrequency:   d.TxFrequency,
	}
}

// ─── Space Weather ───────────────────────────────────────────────────────────

// SpaceWeatherEvent is published when space weather data is updated and a
// threshold has been crossed (K-index, A-index, or SFI).
type SpaceWeatherEvent struct {
	SFI                float64 `json:"sfi"`
	KIndex             int     `json:"k_index"`
	KIndexStatus       string  `json:"k_index_status"`
	AIndex             int     `json:"a_index"`
	SolarWindBz        float64 `json:"solar_wind_bz"`
	PropagationQuality string  `json:"propagation_quality"`
	// Previous values so templates can show direction of change
	PreviousKIndex int     `json:"previous_k_index"`
	PreviousSFI    float64 `json:"previous_sfi"`
}

func (e SpaceWeatherEvent) EventType() NotificationEventType { return EventTypeSpaceWeather }

// ─── Antenna Switch ──────────────────────────────────────────────────────────

// AntennaSwitchEvent is published whenever the antenna switch changes state.
type AntennaSwitchEvent struct {
	Action   string    `json:"action"`   // "select", "ground", "add", "remove", "default"
	Antenna  int       `json:"antenna"`  // 0 for ground/default
	Label    string    `json:"label"`    // human-readable antenna name
	Selected []int     `json:"selected"` // resulting selected antennas
	Grounded bool      `json:"grounded"`
	Source   string    `json:"source"` // "public", "admin", "startup", "scheduler"
	Time     time.Time `json:"time"`
}

func (e AntennaSwitchEvent) EventType() NotificationEventType { return EventTypeAntennaSwitch }

// newAntennaSwitchEvent converts an AntSwitchLogEntry to an AntennaSwitchEvent.
func newAntennaSwitchEvent(e AntSwitchLogEntry) AntennaSwitchEvent {
	return AntennaSwitchEvent{
		Action:   e.Action,
		Antenna:  e.Antenna,
		Label:    e.Label,
		Selected: e.Selected,
		Grounded: e.Grounded,
		Source:   e.Source,
		Time:     e.Time,
	}
}

// ─── Rotator ─────────────────────────────────────────────────────────────────

// RotatorEvent is published when the rotator position or moving state changes.
type RotatorEvent struct {
	Azimuth         float64   `json:"azimuth"`
	Elevation       float64   `json:"elevation"`
	Moving          bool      `json:"moving"`
	TargetAzimuth   float64   `json:"target_azimuth,omitempty"`
	TargetElevation float64   `json:"target_elevation,omitempty"`
	Time            time.Time `json:"time"`
}

func (e RotatorEvent) EventType() NotificationEventType { return EventTypeRotator }

// ─── System Monitor ──────────────────────────────────────────────────────────

// SystemMonitorEvent is published when a subsystem transitions between
// healthy and unhealthy states.
type SystemMonitorEvent struct {
	Component         string    `json:"component"` // e.g. "decoder", "cw_skimmer", "mqtt"
	Healthy           bool      `json:"healthy"`
	PreviouslyHealthy bool      `json:"previously_healthy"`
	Issues            []string  `json:"issues"`
	Status            string    `json:"status"` // "degraded" | "recovered" | "unknown"
	Time              time.Time `json:"time"`
}

func (e SystemMonitorEvent) EventType() NotificationEventType { return EventTypeSystemMonitor }

// ─── User Session ─────────────────────────────────────────────────────────────

// UserSessionAction describes what happened to a user session.
type UserSessionAction string

const (
	UserSessionConnected    UserSessionAction = "connected"
	UserSessionDisconnected UserSessionAction = "disconnected"
)

// UserSessionEvent is published when a user connects or disconnects.
type UserSessionEvent struct {
	Action        UserSessionAction `json:"action"`
	ClientIP      string            `json:"client_ip"`
	Country       string            `json:"country"`
	CountryCode   string            `json:"country_code"`
	Continent     string            `json:"continent"`
	UserAgent     string            `json:"user_agent"`
	UserSessionID string            `json:"user_session_id"`
	Frequency     uint64            `json:"frequency"`
	Mode          string            `json:"mode"`
	Time          time.Time         `json:"time"`
}

func (e UserSessionEvent) EventType() NotificationEventType { return EventTypeUserSession }

// ─── Server Startup ───────────────────────────────────────────────────────────

// ServerStartupEvent is published once when the server finishes initialising.
// Useful for detecting restarts after crashes or deployments.
type ServerStartupEvent struct {
	Version   string    `json:"version"`
	Callsign  string    `json:"callsign"`
	Name      string    `json:"name"`
	StartTime time.Time `json:"start_time"`
}

func (e ServerStartupEvent) EventType() NotificationEventType { return EventTypeServerStartup }

// ─── Voice Activity ───────────────────────────────────────────────────────────

// VoiceActivityEvent is published when a new voice signal is detected on a band.
// "New" means the (band, dial-frequency bucket) was not present in the previous scan.
type VoiceActivityEvent struct {
	Band              string  `json:"band"`
	CenterFreq        uint64  `json:"center_freq"`         // Hz
	EstimatedDialFreq uint64  `json:"estimated_dial_freq"` // Hz
	StartFreq         uint64  `json:"start_freq"`
	EndFreq           uint64  `json:"end_freq"`
	Bandwidth         uint64  `json:"bandwidth"`
	Mode              string  `json:"mode"`
	SNR               float32 `json:"snr"`
	Confidence        float32 `json:"confidence"`
	// DX cluster enrichment (populated when a callsign has been spotted nearby)
	DXCallsign    string    `json:"dx_callsign,omitempty"`
	DXCountry     string    `json:"dx_country,omitempty"`
	DXCountryCode string    `json:"dx_country_code,omitempty"`
	DXContinent   string    `json:"dx_continent,omitempty"`
	Time          time.Time `json:"time"`
}

func (e VoiceActivityEvent) EventType() NotificationEventType { return EventTypeVoiceActivity }
