package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Passband handling for the KiwiSDR emulation.
//
// A Kiwi client describes what it wants to hear with "SET mod=<mode>
// low_cut=<lo> high_cut=<hi> freq=<kHz>". The modes come in families that
// differ only in their filter -- am/amn/amw, usb/usn, cw/cwn -- so they all map
// onto one radiod preset (kiwiModeToRadiod) and the family member is carried
// entirely by the edges. Getting the edges to radiod, and keeping them there,
// is therefore the whole of mode handling.
//
// Keeping them there matters as much as sending them: checkAudioParameterMismatch
// (user_spectrum.go) re-sends the session's stored BandwidthLow/High to radiod
// whenever radiod reports something else. Every edge the emulation sends must
// therefore also be the edge it stores, which UpdateSessionChannel does by
// construction; anything that bypassed it would be reverted within a second.

// kiwiPassband is a filter in Kiwi's terms: edges in Hz relative to the
// frequency the client sends.
type kiwiPassband struct {
	Lo, Hi int
}

// kiwiDefaultPassbands are the passbands a stock KiwiSDR seeds into its
// configuration (kiwisdr cfg/cfg.cpp, the "passbands" block added when
// kiwi.json has none; web/openwebrx/openwebrx.js passbands_fallback carries the
// same values). The client starts each mode from these, and the emulation uses
// them when a command arrives without edges of its own.
var kiwiDefaultPassbands = map[string]kiwiPassband{
	"am":   {-4900, 4900},
	"amn":  {-2500, 2500},
	"amw":  {-6000, 6000},
	"sam":  {-4900, 4900},
	"sal":  {-4900, 0},
	"sau":  {0, 4900},
	"sas":  {-4900, 4900},
	"qam":  {-4900, 4900},
	"drm":  {-5000, 5000},
	"lsb":  {-2700, -300},
	"lsn":  {-2400, -300},
	"usb":  {300, 2700},
	"usn":  {300, 2400},
	"cw":   {300, 700},
	"cwn":  {470, 530},
	"nbfm": {-6000, 6000},
	"nnfm": {-3000, 3000},
	"iq":   {-5000, 5000},
}

// kiwiPassbandOrder is the order cfg.cpp writes the passbands in, so the
// configuration the client receives reads like a real one.
var kiwiPassbandOrder = []string{
	"am", "amn", "amw", "sam", "sal", "sau", "sas", "qam", "drm",
	"lsb", "lsn", "usb", "usn", "cw", "cwn", "nbfm", "nnfm", "iq",
}

// kiwiPassbandsJSON renders kiwiDefaultPassbands as the "passbands" object of
// the client configuration.
func kiwiPassbandsJSON() string {
	var b strings.Builder
	b.WriteByte('{')
	for i, mode := range kiwiPassbandOrder {
		pb := kiwiDefaultPassbands[mode]
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `"%s":{"lo":%d,"hi":%d}`, mode, pb.Lo, pb.Hi)
	}
	b.WriteByte('}')
	return b.String()
}

// kiwiIsCW reports whether mode uses Kiwi's CW tuning convention.
func kiwiIsCW(mode string) bool {
	return mode == "cw" || mode == "cwn"
}

// kiwiIsAMEnvelope reports whether mode is one of Kiwi's envelope-detected AM
// modes, which a real KiwiSDR low-passes after the detector.
func kiwiIsAMEnvelope(mode string) bool {
	return mode == "am" || mode == "amn" || mode == "amw"
}

// kiwiTuning is what a Kiwi client has asked for, in its own terms.
type kiwiTuning struct {
	Mode      string // Kiwi mode name, e.g. "amn"
	CarrierHz uint64 // the "freq" of SET mod
	Pass      kiwiPassband
}

// radiodTuning is a kiwiTuning as radiod has to be told it.
type radiodTuning struct {
	Mode      string // radiod preset
	FreqHz    uint64
	Low, High int
}

// radiod converts the client's request into radiod terms.
//
// Everything but CW passes straight through. A KiwiSDR demodulates CW as
// upper sideband: the client sends the carrier, 500 Hz below the signal, with a
// 300-700 Hz passband, and the signal comes out as a 500 Hz tone. radiod's cwu
// preset expects the signal on the tuned frequency instead, with a narrow
// filter around zero and a fixed +500 Hz shift -- and its tighter CW filtering
// (FILTER2) is why the emulation keeps it. The two agree once the passband
// centre moves from the edges into the frequency: tune to carrier + centre and
// filter centre-relative. With Kiwi's defaults that is the signal frequency,
// +/-200 Hz (+/-30 for cwn) and a 500 Hz tone, exactly as on a KiwiSDR. The one
// difference left is that dragging the passband centre changes the pitch on a
// KiwiSDR, while cwu's tone stays at 500 Hz.
func (t kiwiTuning) radiod() radiodTuning {
	r := radiodTuning{
		Mode:   kiwiModeToRadiod[t.Mode],
		FreqHz: t.CarrierHz,
		Low:    t.Pass.Lo,
		High:   t.Pass.Hi,
	}
	if kiwiIsCW(t.Mode) {
		centre := (t.Pass.Lo + t.Pass.Hi) / 2
		f := int64(t.CarrierHz) + int64(centre)
		if f < 0 {
			f = 0
		}
		r.FreqHz = uint64(f)
		r.Low = t.Pass.Lo - centre
		r.High = t.Pass.Hi - centre
	}
	return r
}

// amPostFilterHz is the bandwidth of the low pass a KiwiSDR applies after the
// AM envelope detector (m_AM_FIR in rx/rx_sound_cmd.cpp: the larger of the two
// edge magnitudes), or 0 for any mode that has none.
func (t kiwiTuning) amPostFilterHz() int {
	if !kiwiIsAMEnvelope(t.Mode) {
		return 0
	}
	lo, hi := t.Pass.Lo, t.Pass.Hi
	if lo < 0 {
		lo = -lo
	}
	if hi < 0 {
		hi = -hi
	}
	if lo > hi {
		return lo
	}
	return hi
}

// nextKiwiTuning applies one "SET mod" to the tuning in force.
//
// It follows the real server (rx/rx_sound_cmd.cpp, CMD_TUNE):
//   - mod=x leaves the mode alone;
//   - low_cut=0 high_cut=0 leaves the passband alone -- both zero, not either,
//     since sal (-4900..0) and sau (0..4900) legitimately have a zero edge;
//   - edges are clamped to the announced Nyquist, maxEdge.
//
// Where the server would fall back to its own state and there is none yet --
// the first command of a connection -- the mode's default passband is used. A
// passband with no width (low >= high after clamping) is treated as no change,
// since radiod refuses one and the session would then disagree with it forever.
// An unknown mode is an error: the client stays where it was, as on a KiwiSDR
// whose extension is missing.
func nextKiwiTuning(prev kiwiTuning, havePrev bool, params map[string]string, maxEdge int) (kiwiTuning, error) {
	next := prev

	mode := strings.ToLower(params["mod"])
	if mode == "x" {
		if !havePrev {
			return prev, fmt.Errorf("mod=x before any mode was set")
		}
	} else {
		if _, ok := kiwiModeToRadiod[mode]; !ok {
			return prev, fmt.Errorf("unsupported mode '%s'", params["mod"])
		}
		next.Mode = mode
	}

	if s, ok := params["freq"]; ok {
		if kHz, err := strconv.ParseFloat(s, 64); err == nil && kHz > 0 && !math.IsInf(kHz, 0) {
			next.CarrierHz = uint64(math.Round(kHz * 1000))
		}
	}

	lo, loErr := strconv.Atoi(params["low_cut"])
	hi, hiErr := strconv.Atoi(params["high_cut"])
	if loErr != nil || hiErr != nil {
		// Kiwi sends the edges as integers, but nothing stops another client
		// sending "-2500.0"; take those as well rather than dropping them.
		lf, lErr := strconv.ParseFloat(params["low_cut"], 64)
		hf, hErr := strconv.ParseFloat(params["high_cut"], 64)
		if lErr == nil && hErr == nil && !math.IsNaN(lf) && !math.IsNaN(hf) {
			lo, hi = int(math.Round(lf)), int(math.Round(hf))
			loErr, hiErr = nil, nil
		}
	}
	edgesGiven := loErr == nil && hiErr == nil && !(lo == 0 && hi == 0)
	if edgesGiven && maxEdge > 0 {
		if lo < -maxEdge {
			lo = -maxEdge
		}
		if hi > maxEdge {
			hi = maxEdge
		}
	}
	switch {
	case edgesGiven && lo < hi:
		next.Pass = kiwiPassband{lo, hi}
	case !havePrev:
		next.Pass = kiwiDefaultPassbands[next.Mode]
	}
	return next, nil
}

// kiwiAGCForPreset is the stored "SET agc" to carry with a preset load, or nil.
// A preset load resets radiod's AGC, so whatever the listener chose has to go
// with it; IQ and FM take no AGC from the Kiwi layer, as applyAGC explains.
func kiwiAGCForPreset(agc *AGCParams, radiodMode string) *AGCParams {
	if agc == nil || strings.HasPrefix(radiodMode, "iq") || radiodMode == "fm" || radiodMode == "nfm" {
		return nil
	}
	return agc
}
