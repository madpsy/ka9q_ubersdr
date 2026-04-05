package main

import (
	"encoding/json"
	"sort"
	"strings"

	"fyne.io/fyne/v2"
)

// Profile holds every configurable setting that can be saved and recalled.
type Profile struct {
	Name        string  `json:"name"`
	URL         string  `json:"url"`
	Password    string  `json:"password"`
	FrequencyHz int     `json:"frequency_hz"`
	Mode        string  `json:"mode"`
	Bandwidth   float64 `json:"bandwidth"`
	Format      string  `json:"format"` // "Compressed" or "Uncompressed"
	StepIndex   int     `json:"step_index"`
	DeviceID    string  `json:"device_id"`
	Volume      float64 `json:"volume"`
	Channel     string  `json:"channel"` // "Left & Right", "Left", "Right"
	Callsign    string  `json:"callsign,omitempty"` // station callsign from /api/description
}

const (
	prefKeyProfileNames = "profile_names" // JSON array of profile name strings
	prefKeyProfileData  = "profile_data_" // prefix; full key = prefix + name
)

// SaveProfile persists a profile to Fyne preferences.
// If a profile with the same name already exists it is overwritten.
func SaveProfile(prefs fyne.Preferences, p Profile) {
	// Encode the profile data.
	data, err := json.Marshal(p)
	if err != nil {
		return
	}
	prefs.SetString(prefKeyProfileData+p.Name, string(data))

	// Add the name to the index if not already present.
	names := loadProfileNames(prefs)
	found := false
	for _, n := range names {
		if n == p.Name {
			found = true
			break
		}
	}
	if !found {
		names = append(names, p.Name)
		sort.Strings(names)
		saveProfileNames(prefs, names)
	}
}

// DeleteProfile removes a profile from Fyne preferences.
func DeleteProfile(prefs fyne.Preferences, name string) {
	prefs.RemoveValue(prefKeyProfileData + name)

	names := loadProfileNames(prefs)
	filtered := names[:0]
	for _, n := range names {
		if n != name {
			filtered = append(filtered, n)
		}
	}
	saveProfileNames(prefs, filtered)
}

// LoadProfile retrieves a single profile by name.
// Returns false if the profile does not exist or cannot be decoded.
func LoadProfile(prefs fyne.Preferences, name string) (Profile, bool) {
	raw := prefs.String(prefKeyProfileData + name)
	if raw == "" {
		return Profile{}, false
	}
	var p Profile
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return Profile{}, false
	}
	return p, true
}

// ListProfiles returns all saved profile names in alphabetical order.
func ListProfiles(prefs fyne.Preferences) []string {
	return loadProfileNames(prefs)
}

// loadProfileNames reads the JSON-encoded name index from preferences.
func loadProfileNames(prefs fyne.Preferences) []string {
	raw := prefs.String(prefKeyProfileNames)
	if raw == "" {
		return nil
	}
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil {
		return nil
	}
	return names
}

// saveProfileNames writes the name index back to preferences.
func saveProfileNames(prefs fyne.Preferences, names []string) {
	data, err := json.Marshal(names)
	if err != nil {
		return
	}
	prefs.SetString(prefKeyProfileNames, string(data))
}

// profileNameValid returns true if the name is non-empty and contains no
// characters that would break the preference key.
func profileNameValid(name string) bool {
	name = strings.TrimSpace(name)
	return name != ""
}
