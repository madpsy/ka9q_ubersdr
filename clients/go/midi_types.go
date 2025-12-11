package main

import (
	"encoding/json"
	"fmt"
)

// MIDIKey represents a unique MIDI control identifier
type MIDIKey struct {
	Type    uint8 `json:"type"`    // Message type (0x90=NoteOn, 0x80=NoteOff, 0xB0=CC, etc.)
	Channel uint8 `json:"channel"` // MIDI channel (0-15)
	Data1   uint8 `json:"data1"`   // Note number or CC number
}

// String returns a human-readable representation of the MIDI key
func (k MIDIKey) String() string {
	switch k.Type {
	case 0x90:
		return fmt.Sprintf("Note %d (Ch %d)", k.Data1, k.Channel+1)
	case 0x80:
		return fmt.Sprintf("Note Off %d (Ch %d)", k.Data1, k.Channel+1)
	case 0xB0:
		return fmt.Sprintf("CC %d (Ch %d)", k.Data1, k.Channel+1)
	case 0xE0:
		return fmt.Sprintf("Pitch Bend (Ch %d)", k.Channel+1)
	default:
		return fmt.Sprintf("Type %02X Data %d (Ch %d)", k.Type, k.Data1, k.Channel+1)
	}
}

// MarshalText implements encoding.TextMarshaler for use as map key in JSON
func (k MIDIKey) MarshalText() ([]byte, error) {
	return []byte(fmt.Sprintf("%d:%d:%d", k.Type, k.Channel, k.Data1)), nil
}

// UnmarshalText implements encoding.TextUnmarshaler for use as map key in JSON
func (k *MIDIKey) UnmarshalText(text []byte) error {
	var t, c, d uint8
	_, err := fmt.Sscanf(string(text), "%d:%d:%d", &t, &c, &d)
	if err != nil {
		return err
	}
	k.Type = t
	k.Channel = c
	k.Data1 = d
	return nil
}

// MIDIMapping represents a mapping from MIDI control to function
type MIDIMapping struct {
	Function   string `json:"function"`              // Function name to execute
	ThrottleMS int    `json:"throttle_ms,omitempty"` // Throttle time in milliseconds (0 = no throttle)
	Mode       string `json:"mode,omitempty"`        // Throttle mode: "debounce" or "rate_limit"
}

// MIDIDevice represents a MIDI input device
type MIDIDevice struct {
	Index int    `json:"index"` // Device index
	Name  string `json:"name"`  // Device name
}

// MIDIConfig represents the MIDI configuration
type MIDIConfig struct {
	Enabled      bool                    `json:"enabled"`
	DeviceName   string                  `json:"device_name"`
	Mappings     map[MIDIKey]MIDIMapping `json:"mappings"`
	LearningMode bool                    `json:"learning_mode,omitempty"`
}

// MIDIStatus represents the current MIDI controller status
type MIDIStatus struct {
	Connected    bool   `json:"connected"`
	DeviceName   string `json:"device_name,omitempty"`
	MappingCount int    `json:"mapping_count"`
	LearningMode bool   `json:"learning_mode"`
}

// MIDILearnResponse represents a learn mode response
type MIDILearnResponse struct {
	Type    string `json:"type"`              // "midi_learn_started", "midi_learn_captured", "midi_learn_completed"
	Control string `json:"control,omitempty"` // MIDI control captured
	Message string `json:"message,omitempty"` // Status message
}

// MIDIEvent represents a MIDI event for WebSocket broadcast
type MIDIEvent struct {
	Type    string  `json:"type"`    // "midi_event"
	Control MIDIKey `json:"control"` // MIDI control
	Value   uint8   `json:"value"`   // MIDI value (0-127)
}

// Available MIDI functions (matching Python client)
var AvailableMIDIFunctions = []string{
	"Frequency: Step Up",
	"Frequency: Step Down",
	"Frequency: Encoder (10 Hz)",
	"Frequency: Encoder (100 Hz)",
	"Frequency: Encoder (500 Hz)",
	"Frequency: Encoder (1 kHz)",
	"Frequency: Encoder (10 kHz)",
	"Frequency: Lock Toggle",
	"Mode: USB",
	"Mode: LSB",
	"Mode: AM",
	"Mode: FM",
	"Mode: CW",
	"Mode: Next",
	"Mode: Previous",
	"Mode: Lock Toggle",
	"Band: 160m",
	"Band: 80m",
	"Band: 60m",
	"Band: 40m",
	"Band: 30m",
	"Band: 20m",
	"Band: 17m",
	"Band: 15m",
	"Band: 12m",
	"Band: 10m",
	"Bandwidth: Low",
	"Bandwidth: High",
	"NR2: Toggle",
	"Mute: Toggle",
}

// MarshalJSON implements custom JSON marshaling for MIDIConfig
func (c *MIDIConfig) MarshalJSON() ([]byte, error) {
	type Alias MIDIConfig
	// Convert map to use string keys for JSON
	mappings := make(map[string]MIDIMapping)
	for k, v := range c.Mappings {
		key := fmt.Sprintf("%d:%d:%d", k.Type, k.Channel, k.Data1)
		mappings[key] = v
	}

	return json.Marshal(&struct {
		*Alias
		Mappings map[string]MIDIMapping `json:"mappings"`
	}{
		Alias:    (*Alias)(c),
		Mappings: mappings,
	})
}

// UnmarshalJSON implements custom JSON unmarshaling for MIDIConfig
func (c *MIDIConfig) UnmarshalJSON(data []byte) error {
	type Alias MIDIConfig
	aux := &struct {
		*Alias
		Mappings map[string]MIDIMapping `json:"mappings"`
	}{
		Alias: (*Alias)(c),
	}

	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	// Convert string keys back to MIDIKey
	c.Mappings = make(map[MIDIKey]MIDIMapping)
	for keyStr, mapping := range aux.Mappings {
		var key MIDIKey
		if err := key.UnmarshalText([]byte(keyStr)); err != nil {
			return err
		}
		c.Mappings[key] = mapping
	}

	return nil
}
