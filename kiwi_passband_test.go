package main

import (
	"encoding/json"
	"math"
	"sync"
	"testing"
)

// ── nextKiwiTuning: the real server's SET mod rules ──────────────────────────

func setMod(mode, lo, hi, freq string) map[string]string {
	p := map[string]string{"mod": mode}
	if lo != "" {
		p["low_cut"] = lo
	}
	if hi != "" {
		p["high_cut"] = hi
	}
	if freq != "" {
		p["freq"] = freq
	}
	return p
}

// The first command's edges are the ones used, not a placeholder.
func TestNextKiwiTuningFirstCommandKeepsItsEdges(t *testing.T) {
	got, err := nextKiwiTuning(kiwiTuning{}, false, setMod("usb", "300", "1500", "5250.000"), 6000)
	if err != nil {
		t.Fatal(err)
	}
	want := kiwiTuning{Mode: "usb", CarrierHz: 5250000, Pass: kiwiPassband{300, 1500}}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

// With nothing to fall back on, a command without edges gets the mode's default.
func TestNextKiwiTuningFirstCommandWithoutEdgesUsesDefault(t *testing.T) {
	for _, p := range []map[string]string{
		setMod("amn", "0", "0", "198"),
		setMod("amn", "", "", "198"),
	} {
		got, err := nextKiwiTuning(kiwiTuning{}, false, p, 6000)
		if err != nil {
			t.Fatal(err)
		}
		if got.Pass != (kiwiPassband{-2500, 2500}) {
			t.Errorf("%v: passband %+v, want amn's default -2500..2500", p, got.Pass)
		}
	}
}

// Both edges zero means "no passband change", even across a mode change, as on
// the real server.
func TestNextKiwiTuningZeroZeroKeepsPassband(t *testing.T) {
	prev := kiwiTuning{Mode: "am", CarrierHz: 198000, Pass: kiwiPassband{-3000, 3000}}
	got, err := nextKiwiTuning(prev, true, setMod("amw", "0", "0", "198"), 6000)
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != "amw" || got.Pass != prev.Pass {
		t.Errorf("got %+v, want mode amw with the previous passband kept", got)
	}
}

// One zero edge is a real passband: SAL is -4900..0 and SAU 0..4900. These
// used to be dropped, leaving both on SAM's double sideband.
func TestNextKiwiTuningOneZeroEdgeIsAPassband(t *testing.T) {
	prev := kiwiTuning{Mode: "sam", CarrierHz: 6000000, Pass: kiwiPassband{-4900, 4900}}
	for _, tc := range []struct {
		mode   string
		lo, hi string
		want   kiwiPassband
	}{
		{"sal", "-4900", "0", kiwiPassband{-4900, 0}},
		{"sau", "0", "4900", kiwiPassband{0, 4900}},
	} {
		got, err := nextKiwiTuning(prev, true, setMod(tc.mode, tc.lo, tc.hi, "6000"), 6000)
		if err != nil {
			t.Fatal(err)
		}
		if got.Pass != tc.want {
			t.Errorf("%s: passband %+v, want %+v", tc.mode, got.Pass, tc.want)
		}
	}
}

func TestNextKiwiTuningClampsToAnnouncedNyquist(t *testing.T) {
	got, err := nextKiwiTuning(kiwiTuning{}, false, setMod("amw", "-9000", "9000", "6000"), 6000)
	if err != nil {
		t.Fatal(err)
	}
	if got.Pass != (kiwiPassband{-6000, 6000}) {
		t.Errorf("passband %+v, want clamped to +/-6000", got.Pass)
	}
}

// radiod refuses a passband with no width, and the session would then disagree
// with radiod for ever; such a command changes nothing.
func TestNextKiwiTuningRejectsEmptyPassband(t *testing.T) {
	prev := kiwiTuning{Mode: "usb", CarrierHz: 7100000, Pass: kiwiPassband{300, 2700}}
	for _, p := range []map[string]string{
		setMod("usb", "2000", "1000", "7100"),
		setMod("usb", "1000", "1000", "7100"),
		setMod("usb", "7000", "9000", "7100"), // both clamp to 6000
	} {
		got, err := nextKiwiTuning(prev, true, p, 6000)
		if err != nil {
			t.Fatal(err)
		}
		if got.Pass != prev.Pass {
			t.Errorf("%v: passband %+v, want the previous %+v", p, got.Pass, prev.Pass)
		}
	}
}

func TestNextKiwiTuningModeX(t *testing.T) {
	prev := kiwiTuning{Mode: "cwn", CarrierHz: 7020000, Pass: kiwiPassband{470, 530}}
	got, err := nextKiwiTuning(prev, true, setMod("x", "0", "0", "7021.5"), 6000)
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != "cwn" || got.CarrierHz != 7021500 || got.Pass != prev.Pass {
		t.Errorf("mod=x gave %+v, want a frequency change only", got)
	}
	if _, err := nextKiwiTuning(kiwiTuning{}, false, setMod("x", "0", "0", "7020"), 6000); err == nil {
		t.Error("mod=x with no mode yet should be refused")
	}
}

func TestNextKiwiTuningUnknownModeChangesNothing(t *testing.T) {
	prev := kiwiTuning{Mode: "usb", CarrierHz: 7100000, Pass: kiwiPassband{300, 2700}}
	got, err := nextKiwiTuning(prev, true, setMod("drm", "-5000", "5000", "9000"), 6000)
	if err == nil {
		t.Fatal("unmapped mode accepted")
	}
	if got != prev {
		t.Errorf("got %+v, want the previous tuning untouched", got)
	}
}

// Kiwi sends frequencies to three decimals; truncating 7020.001 kHz used to
// land a hertz low.
func TestNextKiwiTuningRoundsFrequency(t *testing.T) {
	got, err := nextKiwiTuning(kiwiTuning{}, false, setMod("usb", "300", "2700", "7020.001"), 6000)
	if err != nil {
		t.Fatal(err)
	}
	if got.CarrierHz != 7020001 {
		t.Errorf("CarrierHz = %d, want 7020001", got.CarrierHz)
	}
}

// ── radiod(): mapping onto presets, and the CW convention ───────────────────

func TestKiwiTuningRadiodPassesNonCWThrough(t *testing.T) {
	for _, mode := range []string{"am", "amn", "amw"} {
		r := kiwiTuning{Mode: mode, CarrierHz: 198000, Pass: kiwiDefaultPassbands[mode]}.radiod()
		pb := kiwiDefaultPassbands[mode]
		if r.Mode != "am" || r.FreqHz != 198000 || r.Low != pb.Lo || r.High != pb.Hi {
			t.Errorf("%s -> %+v, want preset am at 198000 with %+v", mode, r, pb)
		}
	}
}

// Kiwi's CW is USB with the passband 300..700 Hz above the carrier; radiod's
// cwu wants the signal on frequency and a filter centred on zero.
func TestKiwiTuningRadiodTranslatesCW(t *testing.T) {
	for _, tc := range []struct {
		mode string
		pass kiwiPassband
		want radiodTuning
	}{
		{"cw", kiwiPassband{300, 700}, radiodTuning{"cwu", 7020000, -200, 200}},
		{"cwn", kiwiPassband{470, 530}, radiodTuning{"cwu", 7020000, -30, 30}},
		// A passband already centred on zero (this emulation's old defaults)
		// is left exactly where it was.
		{"cw", kiwiPassband{-400, 400}, radiodTuning{"cwu", 7019500, -400, 400}},
	} {
		got := kiwiTuning{Mode: tc.mode, CarrierHz: 7019500, Pass: tc.pass}.radiod()
		if got != tc.want {
			t.Errorf("%s %+v -> %+v, want %+v", tc.mode, tc.pass, got, tc.want)
		}
	}
}

func TestKiwiAMPostFilterHz(t *testing.T) {
	for _, tc := range []struct {
		mode string
		pass kiwiPassband
		want int
	}{
		{"am", kiwiPassband{-4900, 4900}, 4900},
		{"amn", kiwiPassband{-2500, 2500}, 2500},
		{"amw", kiwiPassband{-6000, 6000}, 6000},
		{"am", kiwiPassband{-1000, 3000}, 3000}, // the larger edge, as m_AM_FIR uses
		{"sam", kiwiPassband{-4900, 4900}, 0},   // coherent: no post filter on a Kiwi
		{"usb", kiwiPassband{300, 2700}, 0},
	} {
		if got := (kiwiTuning{Mode: tc.mode, Pass: tc.pass}).amPostFilterHz(); got != tc.want {
			t.Errorf("%s %+v: %d, want %d", tc.mode, tc.pass, got, tc.want)
		}
	}
}

// The client configuration carries exactly the stock KiwiSDR passbands
// (kiwisdr cfg/cfg.cpp).
func TestKiwiPassbandsJSONMatchesStockKiwi(t *testing.T) {
	var got map[string]struct{ Lo, Hi int }
	if err := json.Unmarshal([]byte(kiwiPassbandsJSON()), &got); err != nil {
		t.Fatalf("not valid JSON: %v\n%s", err, kiwiPassbandsJSON())
	}
	stock := map[string][2]int{
		"am": {-4900, 4900}, "amn": {-2500, 2500}, "amw": {-6000, 6000},
		"sam": {-4900, 4900}, "sal": {-4900, 0}, "sau": {0, 4900}, "sas": {-4900, 4900},
		"qam": {-4900, 4900}, "drm": {-5000, 5000},
		"lsb": {-2700, -300}, "lsn": {-2400, -300}, "usb": {300, 2700}, "usn": {300, 2400},
		"cw": {300, 700}, "cwn": {470, 530},
		"nbfm": {-6000, 6000}, "nnfm": {-3000, 3000}, "iq": {-5000, 5000},
	}
	if len(got) != len(stock) {
		t.Errorf("%d passbands, want %d", len(got), len(stock))
	}
	for mode, pb := range stock {
		if g, ok := got[mode]; !ok || g.Lo != pb[0] || g.Hi != pb[1] {
			t.Errorf("%s: got %+v, want lo=%d hi=%d", mode, g, pb[0], pb[1])
		}
	}
}

func TestKiwiAGCForPreset(t *testing.T) {
	on := true
	agc := &AGCParams{Enable: &on}
	if kiwiAGCForPreset(agc, "am") != agc || kiwiAGCForPreset(agc, "cwu") != agc {
		t.Error("linear presets should carry the listener's AGC")
	}
	for _, m := range []string{"iq", "iq48", "nfm", "fm"} {
		if kiwiAGCForPreset(agc, m) != nil {
			t.Errorf("%s should not take Kiwi AGC", m)
		}
	}
	if kiwiAGCForPreset(nil, "am") != nil {
		t.Error("no stored AGC should send none")
	}
}

// ── applySetMod against a recording radiod ──────────────────────────────────

type radiodUpdate struct {
	freq          uint64
	mode          string
	low, high     int
	sendBandwidth bool
	agc           *AGCParams
}

// recordingRadiod is stubRadiod plus a log of the audio commands sent.
type recordingRadiod struct {
	stubRadiod
	mu      sync.Mutex
	creates []string // preset per create
	updates []radiodUpdate
	agcs    []AGCParams
}

func (r *recordingRadiod) CreateChannelWithBandwidth(name string, frequency uint64, mode string, sampleRate int, ssrc uint32, bandwidth int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.creates = append(r.creates, mode)
	return nil
}

func (r *recordingRadiod) UpdateChannelWithAGC(ssrc uint32, frequency uint64, mode string, bandwidthLow, bandwidthHigh int, sendBandwidth bool, agc *AGCParams) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.updates = append(r.updates, radiodUpdate{frequency, mode, bandwidthLow, bandwidthHigh, sendBandwidth, agc})
	return nil
}

func (r *recordingRadiod) SetAGC(ssrc uint32, params AGCParams) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.agcs = append(r.agcs, params)
	return nil
}

func (r *recordingRadiod) lastUpdate(t *testing.T) radiodUpdate {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.updates) == 0 {
		t.Fatal("no update sent to radiod")
	}
	return r.updates[len(r.updates)-1]
}

func newKiwiModeTestConn(t *testing.T) (*kiwiConn, *recordingRadiod) {
	t.Helper()
	cfg := &Config{}
	cfg.Audio.DefaultSampleRate = 12000
	cfg.Server.MaxSessions = 4
	rec := &recordingRadiod{}
	sm := NewSessionManager(cfg, rec, nil)
	kc := &kiwiConn{
		connType:      "SND",
		sessions:      sm,
		config:        cfg,
		userSessionID: "kiwi-mode-test",
	}
	t.Cleanup(func() {
		if kc.session != nil {
			_ = sm.DestroySession(kc.session.ID)
		}
	})
	return kc, rec
}

func sessionEdges(s *Session) (int, int, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.BandwidthLow, s.BandwidthHigh, s.Mode
}

// The bug this all started from: the session was created with placeholder
// edges of 50..3000 and the first command's passband was thrown away, so
// checkAudioParameterMismatch held every Kiwi AM channel at 50..3000 Hz.
func TestKiwiSetModFirstCommandSetsAndStoresEdges(t *testing.T) {
	kc, rec := newKiwiModeTestConn(t)
	kc.applySetMod(setMod("am", "-4900", "4900", "198.000"))

	if kc.session == nil {
		t.Fatal("no session created")
	}
	if len(rec.creates) != 1 || rec.creates[0] != "am" {
		t.Fatalf("creates = %v, want one am channel", rec.creates)
	}
	u := rec.lastUpdate(t)
	if !u.sendBandwidth || u.low != -4900 || u.high != 4900 || u.mode != "" {
		t.Errorf("follow-up update %+v, want edges -4900..4900 with no preset reload", u)
	}
	// What the reconciler enforces must be what was asked for.
	if lo, hi, _ := sessionEdges(kc.session); lo != -4900 || hi != 4900 {
		t.Errorf("session stores %d..%d, want -4900..4900", lo, hi)
	}
}

// AM, AMN and AMW are one radiod preset: the buttons move the filter and must
// not reload the preset (which would reset AGC and blank audio).
func TestKiwiSetModSameFamilyMovesOnlyTheFilter(t *testing.T) {
	kc, rec := newKiwiModeTestConn(t)
	kc.applySetMod(setMod("am", "-4900", "4900", "198"))

	for _, tc := range []struct {
		mode   string
		lo, hi int
	}{{"amn", -2500, 2500}, {"amw", -6000, 6000}, {"am", -4900, 4900}} {
		kc.applySetMod(setMod(tc.mode, itoa(tc.lo), itoa(tc.hi), "198"))
		u := rec.lastUpdate(t)
		if u.mode != "" {
			t.Errorf("%s: preset %q reloaded, want none", tc.mode, u.mode)
		}
		if u.low != tc.lo || u.high != tc.hi || !u.sendBandwidth {
			t.Errorf("%s: sent %+v, want %d..%d", tc.mode, u, tc.lo, tc.hi)
		}
		if lo, hi, _ := sessionEdges(kc.session); lo != tc.lo || hi != tc.hi {
			t.Errorf("%s: session stores %d..%d", tc.mode, lo, hi)
		}
		if kc.tuning.Mode != tc.mode {
			t.Errorf("tuning mode %q, want %q", kc.tuning.Mode, tc.mode)
		}
	}
}

// Every family of UI buttons sharing a preset -- USB/USN, LSB/LSN, CW/CWN,
// NBFM/NNFM as well as AM/AMN/AMW -- moves only the filter, using Kiwi's
// default edges for the button pressed. Moving between families does load the
// new preset.
func TestKiwiSetModEveryFamilyMovesOnlyTheFilter(t *testing.T) {
	for _, family := range []struct {
		preset string
		modes  []string
	}{
		{"usb", []string{"usb", "usn", "usb"}},
		{"lsb", []string{"lsb", "lsn", "lsb"}},
		{"cwu", []string{"cw", "cwn", "cw"}},
		{"nfm", []string{"nbfm", "nnfm", "nbfm"}},
		{"am", []string{"am", "amn", "amw"}},
	} {
		kc, rec := newKiwiModeTestConn(t)
		for i, mode := range family.modes {
			pb := kiwiDefaultPassbands[mode]
			kc.applySetMod(setMod(mode, itoa(pb.Lo), itoa(pb.Hi), "7100"))
			want := kiwiTuning{Mode: mode, CarrierHz: 7100000, Pass: pb}.radiod()

			u := rec.lastUpdate(t)
			if u.mode != "" {
				t.Errorf("%s (step %d): preset %q reloaded, want none", mode, i, u.mode)
			}
			if u.low != want.Low || u.high != want.High || !u.sendBandwidth {
				t.Errorf("%s: sent %d..%d, want %d..%d", mode, u.low, u.high, want.Low, want.High)
			}
			if lo, hi, preset := sessionEdges(kc.session); lo != want.Low || hi != want.High || preset != family.preset {
				t.Errorf("%s: session stores %s %d..%d, want %s %d..%d",
					mode, preset, lo, hi, family.preset, want.Low, want.High)
			}
		}
		if len(rec.creates) != 1 || rec.creates[0] != family.preset {
			t.Errorf("%s family: creates %v, want one %s channel", family.preset, rec.creates, family.preset)
		}
	}

	kc, rec := newKiwiModeTestConn(t)
	kc.applySetMod(setMod("usb", "300", "2700", "7100"))
	kc.applySetMod(setMod("lsn", "-2400", "-300", "7100"))
	if u := rec.lastUpdate(t); u.mode != "lsb" || u.low != -2400 || u.high != -300 {
		t.Errorf("usb -> lsn sent %+v, want preset lsb with -2400..-300", u)
	}
}

// A change of preset carries the listener's AGC, since the preset load resets
// radiod's; manual gain, which the update packet cannot carry, follows it.
func TestKiwiSetModPresetChangeRestoresAGC(t *testing.T) {
	kc, rec := newKiwiModeTestConn(t)
	kc.applySetMod(setMod("am", "-4900", "4900", "198"))
	kc.applyAGC(map[string]string{"agc": "0", "manGain": "42"})

	kc.applySetMod(setMod("usb", "300", "2700", "7100"))
	u := rec.lastUpdate(t)
	if u.mode != "usb" {
		t.Fatalf("preset %q, want usb", u.mode)
	}
	if u.agc == nil || u.agc.Enable == nil || *u.agc.Enable {
		t.Errorf("update AGC %+v, want the stored manual (AGC off) setting", u.agc)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	last := rec.agcs[len(rec.agcs)-1]
	if last.Gain == nil || *last.Gain != 42 {
		t.Errorf("last AGC command %+v, want manual gain 42 restored after the preset load", last)
	}
}

// CW goes to radiod's cwu preset, retuned so the signal is on frequency.
func TestKiwiSetModCWStoresTranslatedEdges(t *testing.T) {
	kc, rec := newKiwiModeTestConn(t)
	kc.applySetMod(setMod("cw", "300", "700", "7019.500"))

	if rec.creates[0] != "cwu" {
		t.Fatalf("created %q, want cwu", rec.creates[0])
	}
	kc.session.mu.RLock()
	freq := kc.session.Frequency
	kc.session.mu.RUnlock()
	if freq != 7020000 {
		t.Errorf("session frequency %d, want 7020000 (carrier + 500 Hz centre)", freq)
	}
	if lo, hi, _ := sessionEdges(kc.session); lo != -200 || hi != 200 {
		t.Errorf("session stores %d..%d, want the translated -200..200", lo, hi)
	}

	kc.applySetMod(setMod("cwn", "470", "530", "7019.500"))
	if u := rec.lastUpdate(t); u.mode != "" || u.low != -30 || u.high != 30 || u.freq != 7020000 {
		t.Errorf("cwn update %+v, want -30..30 at 7020000 and no preset reload", u)
	}
}

// AGC sent before the first SET mod is applied once there is a session.
func TestKiwiSetModAppliesEarlyAGC(t *testing.T) {
	kc, rec := newKiwiModeTestConn(t)
	kc.applyAGC(map[string]string{"agc": "1", "hang": "0", "decay": "500"})
	kc.applySetMod(setMod("usb", "300", "2700", "7100"))

	u := rec.lastUpdate(t)
	if u.agc == nil || u.agc.Enable == nil || !*u.agc.Enable || u.agc.RecoveryRate == nil {
		t.Errorf("first update AGC %+v, want the early SET agc", u.agc)
	}
}

// ── the AM post-detection filter ─────────────────────────────────────────────

// toneGainDB runs a tone at freq through d and returns the output level relative
// to the input, in dB, ignoring the filter's start-up.
func toneGainDB(d *kiwiDecimator, inRate int, freq float64) float64 {
	const amp = 8000.0
	n := inRate // one second
	pcm := make([]byte, 2*n)
	for i := 0; i < n; i++ {
		v := int16(amp * math.Sin(2*math.Pi*freq*float64(i)/float64(inRate)))
		pcm[2*i] = byte(uint16(v) >> 8)
		pcm[2*i+1] = byte(uint16(v))
	}
	out := d.Process(pcm)
	var sum float64
	samples := len(out) / 2
	skip := samples / 4
	for i := skip; i < samples; i++ {
		v := float64(int16(uint16(out[2*i])<<8 | uint16(out[2*i+1])))
		sum += v * v
	}
	rms := math.Sqrt(sum / float64(samples-skip))
	return 20 * math.Log10(rms/(amp/math.Sqrt2)+1e-12)
}

// Each AM width gets Kiwi's post-detector response: flat to its passband and
// well down beyond it. Tones above 6 kHz would alias into the audio band, so
// they must be gone too.
func TestKiwiAMDecimatorResponse(t *testing.T) {
	for _, tc := range []struct {
		name       string
		pass       int
		flatTo     float64 // within 1 dB up to here
		stopFrom   float64 // at least 50 dB down from here
		aliasProbe float64 // above the output Nyquist
	}{
		{"amn", 2500, 2400, 4600, 7000},
		{"am", 4900, 4800, 6100, 7000},
		{"amw", 6000, 5500, 6500, 7000},
	} {
		for _, f := range []float64{500, 1000, tc.flatTo} {
			d := newKiwiAMDecimator(24000, 12000, tc.pass)
			if g := toneGainDB(d, 24000, f); g < -1 || g > 0.5 {
				t.Errorf("%s: %.0f Hz at %.1f dB, want flat", tc.name, f, g)
			}
		}
		for _, f := range []float64{tc.stopFrom, tc.aliasProbe, 10000} {
			d := newKiwiAMDecimator(24000, 12000, tc.pass)
			if g := toneGainDB(d, 24000, f); g > -50 {
				t.Errorf("%s: %.0f Hz only %.1f dB down, want <= -50", tc.name, f, g)
			}
		}
	}
}

// AMN must now be audibly narrower than AM: what passes AM is cut by AMN.
func TestKiwiAMDecimatorAMNNarrowerThanAM(t *testing.T) {
	// 4.5 kHz is inside AM's passband and at AMN's stop edge (1.8 x 2500,
	// as Kiwi's m_AM_FIR places it).
	am := toneGainDB(newKiwiAMDecimator(24000, 12000, 4900), 24000, 4500)
	amn := toneGainDB(newKiwiAMDecimator(24000, 12000, 2500), 24000, 4500)
	if am < -1 || amn > -45 {
		t.Errorf("4.5 kHz: AM %.1f dB, AMN %.1f dB; want AM flat and AMN well down", am, amn)
	}
}

// A passband drag rebuilds the filter mid-stream. Carrying the history over
// means a steady input stays steady across the swap instead of dipping toward
// zero while the new filter fills.
func TestKiwiDecimatorCarryHistoryAvoidsDip(t *testing.T) {
	const level = 10000
	v := uint16(level)
	dc := make([]byte, 2*480)
	for i := 0; i < 480; i++ {
		dc[2*i] = byte(v >> 8)
		dc[2*i+1] = byte(v)
	}
	first := func(d *kiwiDecimator) float64 {
		out := d.Process(dc)
		return float64(int16(uint16(out[0])<<8 | uint16(out[1])))
	}

	old := newKiwiAMDecimator(24000, 12000, 4900)
	for i := 0; i < 5; i++ {
		old.Process(dc)
	}
	carried := newKiwiAMDecimator(24000, 12000, 2500)
	carried.carryHistory(old)
	if got := first(carried); math.Abs(got-level) > level*0.02 {
		t.Errorf("first sample after a carried swap = %.0f, want ~%d", got, level)
	}

	fresh := newKiwiAMDecimator(24000, 12000, 2500)
	if got := first(fresh); got > level*0.9 {
		t.Errorf("control: a fresh filter started at %.0f; the test no longer shows the dip", got)
	}
}

// The shared decimator (also used by the WebSDR emulation) must not have changed.
func TestKiwiPlainDecimatorUnchanged(t *testing.T) {
	d := newKiwiDecimator(24000, 12000)
	if len(d.taps) != 63 {
		t.Errorf("plain decimator has %d taps, want the original 63", len(d.taps))
	}
}
