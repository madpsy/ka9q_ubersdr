package signalling

import (
	"fmt"
	"sort"
	"strings"
)

// Profile is an allowlisted multimon-ng decoder set. Browser clients select a
// profile but can never supply executable paths, decoder names, or arguments.
type Profile struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Description          string   `json:"description"`
	Demodulators         []string `json:"demodulators"`
	RecommendedMode      string   `json:"recommended_mode"`
	RecommendedBandwidth int      `json:"recommended_bandwidth_hz"`
	AlphaPOCSAG          bool     `json:"-"`
}

var profiles = map[string]Profile{
	"paging": {
		ID: "paging", Name: "Paging", Description: "POCSAG 512/1200/2400 and FLEX paging",
		Demodulators:    []string{"POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"},
		RecommendedMode: "nfm", RecommendedBandwidth: 15000, AlphaPOCSAG: true,
	},
	"pocsag": {
		ID: "pocsag", Name: "POCSAG", Description: "POCSAG 512, 1200 and 2400 baud paging",
		Demodulators:    []string{"POCSAG512", "POCSAG1200", "POCSAG2400"},
		RecommendedMode: "nfm", RecommendedBandwidth: 15000, AlphaPOCSAG: true,
	},
	"flex": {
		ID: "flex", Name: "FLEX", Description: "Motorola FLEX paging",
		Demodulators:    []string{"FLEX"},
		RecommendedMode: "nfm", RecommendedBandwidth: 15000,
	},
	"eas": {
		ID: "eas", Name: "SAME / EAS", Description: "Emergency Alert System SAME headers",
		Demodulators:    []string{"EAS"},
		RecommendedMode: "nfm", RecommendedBandwidth: 15000,
	},
	"dtmf": {
		ID: "dtmf", Name: "DTMF", Description: "Dual-tone multi-frequency digits",
		Demodulators:    []string{"DTMF"},
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"twotone": {
		ID: "twotone", Name: "Two-tone signalling", Description: "ZVEI, CCIR, EEA and EIA selective calling",
		Demodulators:    []string{"ZVEI1", "ZVEI2", "ZVEI3", "DZVEI", "PZVEI", "CCIR", "EEA", "EIA"},
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"telemetry": {
		ID: "telemetry", Name: "Legacy telemetry", Description: "UFSK, CLIPFSK and FMSFSK signalling",
		Demodulators:    []string{"UFSK1200", "CLIPFSK", "FMSFSK"},
		RecommendedMode: "nfm", RecommendedBandwidth: 15000,
	},
	"all": {
		ID: "all", Name: "Auto / all signalling", Description: "Paging, SAME/EAS, DTMF, two-tone and legacy telemetry",
		Demodulators: []string{
			"POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX", "EAS", "DTMF",
			"ZVEI1", "ZVEI2", "ZVEI3", "DZVEI", "PZVEI", "CCIR", "EEA", "EIA",
			"UFSK1200", "CLIPFSK", "FMSFSK",
		},
		RecommendedMode: "nfm", RecommendedBandwidth: 15000, AlphaPOCSAG: true,
	},
}

func LookupProfile(id string) (Profile, error) {
	id = strings.ToLower(strings.TrimSpace(id))
	profile, ok := profiles[id]
	if !ok {
		return Profile{}, fmt.Errorf("unsupported signalling profile %q", id)
	}
	profile.Demodulators = append([]string(nil), profile.Demodulators...)
	return profile, nil
}

func Profiles() []Profile {
	ids := make([]string, 0, len(profiles))
	for id := range profiles {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	result := make([]Profile, 0, len(ids))
	for _, id := range ids {
		profile, _ := LookupProfile(id)
		result = append(result, profile)
	}
	return result
}

func BuildArgs(profile Profile) []string {
	args := []string{"-t", "raw", "-q", "--timestamp"}
	if profile.AlphaPOCSAG {
		args = append(args, "-f", "alpha")
	}
	for _, demodulator := range profile.Demodulators {
		args = append(args, "-a", demodulator)
	}
	return append(args, "-")
}
