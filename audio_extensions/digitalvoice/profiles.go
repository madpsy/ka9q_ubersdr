package digitalvoice

import (
	"fmt"
	"sort"
	"strings"
)

// Profile describes a protocol mode exposed by the digital-voice extension.
// DecoderArgs are intentionally fixed. Client-supplied command-line arguments
// are never accepted, which keeps DSD-FME privacy/decryption key options out of
// the public extension API.
type Profile struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Description          string   `json:"description"`
	DecoderArgs          []string `json:"-"`
	InversionArg         string   `json:"-"`
	OutputSampleRate     int      `json:"output_sample_rate"`
	OutputChannels       int      `json:"output_channels"`
	RecommendedMode      string   `json:"recommended_mode"`
	RecommendedBandwidth int      `json:"recommended_bandwidth_hz"`
}

var profiles = map[string]Profile{
	"auto": {
		ID: "auto", Name: "Auto", Description: "Automatic DMR, P25, YSF, D-Star and X2-TDMA detection",
		DecoderArgs: []string{"-fa"}, OutputSampleRate: 8000, OutputChannels: 2,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"dmr": {
		ID: "dmr", Name: "DMR", Description: "DMR Tier II conventional/base-station and mobile simplex",
		DecoderArgs: []string{"-fs"}, InversionArg: "-xr", OutputSampleRate: 8000, OutputChannels: 2,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"p25p1": {
		ID: "p25p1", Name: "P25 Phase 1", Description: "APCO Project 25 Phase 1 FDMA",
		DecoderArgs: []string{"-f1"}, OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"p25p2": {
		ID: "p25p2", Name: "P25 Phase 2", Description: "APCO Project 25 Phase 2 TDMA traffic channels",
		DecoderArgs: []string{"-f2"}, OutputSampleRate: 8000, OutputChannels: 2,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"nxdn48": {
		ID: "nxdn48", Name: "NXDN48 / IDAS", Description: "6.25 kHz NXDN and IDAS",
		DecoderArgs: []string{"-fi"}, InversionArg: "-xn", OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 7000,
	},
	"nxdn96": {
		ID: "nxdn96", Name: "NXDN96", Description: "12.5 kHz NXDN",
		DecoderArgs: []string{"-fn"}, InversionArg: "-xn", OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"dstar": {
		ID: "dstar", Name: "D-Star", Description: "D-Star digital voice",
		DecoderArgs: []string{"-fd"}, OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"ysf": {
		ID: "ysf", Name: "YSF", Description: "Yaesu System Fusion",
		DecoderArgs: []string{"-fy"}, OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"m17": {
		ID: "m17", Name: "M17", Description: "M17 digital voice",
		DecoderArgs: []string{"-fz"}, InversionArg: "-xz", OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
	"dpmr": {
		ID: "dpmr", Name: "dPMR", Description: "dPMR digital voice",
		DecoderArgs: []string{"-fm"}, InversionArg: "-xd", OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 7000,
	},
	"provoice": {
		ID: "provoice", Name: "ProVoice", Description: "Conventional ProVoice",
		DecoderArgs: []string{"-fp"}, OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 24000,
	},
	"edacs": {
		ID: "edacs", Name: "EDACS / ProVoice", Description: "EDACS Standard control and ProVoice",
		DecoderArgs: []string{"-fh"}, OutputSampleRate: 8000, OutputChannels: 1,
		RecommendedMode: "nfm", RecommendedBandwidth: 24000,
	},
	"x2tdma": {
		ID: "x2tdma", Name: "X2-TDMA", Description: "Motorola X2-TDMA",
		DecoderArgs: []string{"-fx"}, OutputSampleRate: 8000, OutputChannels: 2,
		RecommendedMode: "nfm", RecommendedBandwidth: 12000,
	},
}

// LookupProfile returns a copy of an allowlisted protocol profile.
func LookupProfile(id string) (Profile, error) {
	id = strings.ToLower(strings.TrimSpace(id))
	profile, ok := profiles[id]
	if !ok {
		return Profile{}, fmt.Errorf("unsupported digital voice protocol %q", id)
	}
	profile.DecoderArgs = append([]string(nil), profile.DecoderArgs...)
	return profile, nil
}

// Profiles returns the allowlisted profiles in stable display order.
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

// BuildArgs constructs the complete, non-decrypting DSD-FME command line.
func BuildArgs(profile Profile, udpPort int, inverted bool) ([]string, error) {
	if udpPort < 1 || udpPort > 65535 {
		return nil, fmt.Errorf("invalid UDP output port %d", udpPort)
	}
	if inverted && profile.InversionArg == "" {
		return nil, fmt.Errorf("%s does not expose an inverted-signal mode", profile.Name)
	}

	args := append([]string(nil), profile.DecoderArgs...)
	if inverted {
		args = append(args, profile.InversionArg)
	}
	// DSD-FME accepts raw signed 16-bit little-endian mono PCM from stdin when
	// "-" is selected as the input. Its UDP output is raw decoded 8 kHz PCM.
	args = append(args,
		"-i", "-",
		"-s", "48000",
		"-o", fmt.Sprintf("udp:127.0.0.1:%d", udpPort),
	)
	return args, nil
}
