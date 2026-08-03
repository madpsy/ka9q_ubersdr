package ft8

import "testing"

// What reaches the CTY database.
//
// The lookup goes through reflection (the decoder must not import the main
// package), so nothing here is checked at compile time: a change to the
// callsign handling shows up as decodes with no country rather than as an
// error. This pins the string that is actually asked for.

type ctyInfo struct {
	Country     string
	CountryCode string
	Continent   string
	Latitude    float64
	Longitude   float64
}

type ctyStub struct {
	asked   []string
	answers map[string]*ctyInfo
}

func (s *ctyStub) LookupCallsignFull(callsign string) *ctyInfo {
	s.asked = append(s.asked, callsign)
	if info, ok := s.answers[callsign]; ok {
		return info
	}
	return nil
}

func TestEnrichLooksUpTheWholeCallsign(t *testing.T) {
	cases := []struct {
		name     string
		callsign string
		want     string
	}{
		// A visitor's call: the entity comes from the prefix, so the lookup has
		// to see it. Cutting at the "/" asked CTY about DG1ATN and answered
		// Germany for a station in Denmark.
		{"prefix compound", "OZ/DG1ATN", "OZ/DG1ATN"},
		// CTY.DAT carries exact entries for portable calls (=R9KC/6 is European
		// Russia; R9KC alone is Asiatic Russia), which only match whole.
		{"suffix compound", "R9KC/6", "R9KC/6"},
		{"plain call", "DM4KJ", "DM4KJ"},
		// A hash resolved from an earlier decode arrives in brackets; those are
		// printing, not part of the callsign.
		{"resolved hash", "<II0LOVE>", "II0LOVE"},
	}

	for _, c := range cases {
		stub := &ctyStub{answers: map[string]*ctyInfo{
			c.want: {Country: "Testland", CountryCode: "TL", Continent: "EU"},
		}}
		d := NewFT8Decoder(12000, DefaultFT8Config(), "", stub)
		result := DecodeResult{Callsign: c.callsign}
		d.enrichResult(&result)

		if len(stub.asked) != 1 || stub.asked[0] != c.want {
			t.Errorf("%s: asked CTY for %v, want [%q]", c.name, stub.asked, c.want)
		}
		if result.TxCallsign != c.want {
			t.Errorf("%s: TxCallsign = %q, want %q", c.name, result.TxCallsign, c.want)
		}
		if result.Country != "Testland" || result.Continent != "EU" {
			t.Errorf("%s: enrichment did not reach the result: %+v", c.name, result)
		}
	}
}

func TestEnrichSkipsWhatItCannotKnow(t *testing.T) {
	// An unresolved hash never becomes a callsign, so there is nothing to look
	// up — the row shows the message and no country, which is the truth.
	stub := &ctyStub{answers: map[string]*ctyInfo{}}
	d := NewFT8Decoder(12000, DefaultFT8Config(), "", stub)
	result := DecodeResult{Callsign: ""}
	d.enrichResult(&result)

	if len(stub.asked) != 0 {
		t.Errorf("looked up %v for a decode with no callsign", stub.asked)
	}
	if result.TxCallsign != "" || result.Country != "" {
		t.Errorf("invented a station: %+v", result)
	}
}
