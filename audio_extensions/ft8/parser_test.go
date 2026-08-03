package ft8

import "testing"

// Which field of a message is the transmitter, and what survives to the CTY
// lookup. Both are silent when wrong: a message whose callsign is not
// recognised still shows in the table, just with no country, no distance and no
// bearing — which reads as "the decoder does not know that station" rather than
// "the parser dropped it".

func TestIsValidCallsign(t *testing.T) {
	valid := []string{
		"DM4KJ", "4X5JK", "8S7DL", "DP75BAC", "EG1UME", "3DA0XY",
		"TJ1GD/P", "R9KC/6", // suffix form: the operator's own call, qualified
		"OZ/DG1ATN", "ON/DL5RMH", "F/G4ABC", "VP2E/K1ABC", // prefix form: a visitor
	}
	for _, c := range valid {
		if !isValidCallsign(c) {
			t.Errorf("%q should be a callsign", c)
		}
	}

	// Things that share a message with a callsign and must never be taken for
	// one — grids and reports sit in the same fields.
	invalid := []string{
		"CQ", "RR73", "R-09", "R+05", "JN53", "IN97", "-12", "73",
		"...0556", "<...0556>", "POTA", "", "K",
	}
	for _, c := range invalid {
		if isValidCallsign(c) {
			t.Errorf("%q should not be a callsign", c)
		}
	}
}

func TestNormalizeCallsign(t *testing.T) {
	// CTY.DAT is built for whole callsigns: it holds exact entries for portable
	// calls and resolves a prefix call from its prefix. Cutting at the "/" threw
	// away the part that decides the country.
	cases := map[string]string{
		"<II0LOVE>": "II0LOVE",
		"OZ/DG1ATN": "OZ/DG1ATN",
		"R9KC/6":    "R9KC/6",
		"DM4KJ":     "DM4KJ",
	}
	for in, want := range cases {
		if got := normalizeCallsign(in); got != want {
			t.Errorf("normalizeCallsign(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractCallsignLocator(t *testing.T) {
	cases := []struct {
		message string
		call    string
		grid    string
	}{
		// The everyday shapes.
		{"CQ MM3NDH IO86", "MM3NDH", "IO86"},
		{"SV3AUW MM3NDH IO86", "MM3NDH", "IO86"},
		{"SV3AUW MM3NDH -15", "MM3NDH", ""},
		{"SV3AUW MM3NDH R-15", "MM3NDH", ""},
		{"SV3AUW MM3NDH RR73", "MM3NDH", ""},
		{"CQ DX DL9SFE JN48", "DL9SFE", "JN48"},

		// Compound calls. The prefix form is the one that used to be dropped.
		{"CQ OZ/DG1ATN", "OZ/DG1ATN", ""},
		{"CQ ON/DL5RMH", "ON/DL5RMH", ""},
		{"EA4CFT TJ1GD/P -10", "TJ1GD/P", ""},
		{"CQ F/G4ABC IN78", "F/G4ABC", "IN78"},

		// A hashed callsign is not a callsign we know: the station's full call
		// has not been decoded this session, so there is nothing to look up.
		// It must yield nothing rather than a fragment of the hash.
		{"F5RRS <...0556> -09", "", ""},
		{"ON1JP <...FB5E> R-12", "", ""},

		// A hash resolved from an earlier decode arrives in brackets, and is a
		// real callsign again.
		{"<PA1GLD> DP75BAC 73", "DP75BAC", ""},
	}

	for _, c := range cases {
		call, grid := extractCallsignLocator(c.message)
		if call != c.call {
			t.Errorf("%q: callsign = %q, want %q", c.message, call, c.call)
		}
		if grid != c.grid {
			t.Errorf("%q: grid = %q, want %q", c.message, grid, c.grid)
		}
	}
}
