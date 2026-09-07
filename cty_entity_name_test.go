package main

import "testing"

// The guard on normaliseEntityName's aggressive noise list.
//
// LookupEntityByName folds "Lord Howe Island" and "Lord Howe I" to one key by
// dropping tokens that carry no identity — including bare "i" and "1", which is
// what makes "Peter I" and "Peter 1 Island" the same entity. That is only safe
// while the fold stays injective over the real data: if a CTY update ever
// introduces two entities separated ONLY by a dropped token, a name lookup
// would silently answer with whichever was parsed last.
//
// This test is the thing that catches that. A failure means a token has to come
// back out of entityNameNoise, not that the expectation should be relaxed.
func TestCTYEntityNamesNormaliseUniquely(t *testing.T) {
	if err := InitCTYDatabase("cty/cty.dat"); err != nil {
		t.Fatalf("InitCTYDatabase: %v", err)
	}
	seen := make(map[string]string, len(globalCTY.entities))
	for _, e := range globalCTY.entities {
		key := normaliseEntityName(e.Name)
		if key == "" {
			t.Errorf("entity %q normalised to an empty key", e.Name)
			continue
		}
		if other, clash := seen[key]; clash {
			t.Errorf("entities %q and %q both normalise to %q — a name lookup can no longer tell them apart",
				other, e.Name, key)
			continue
		}
		seen[key] = e.Name
	}
	if len(seen) != len(globalCTY.entities) {
		t.Errorf("%d entities folded to %d keys", len(globalCTY.entities), len(seen))
	}
}

func TestCTYLookupEntityByName(t *testing.T) {
	if err := InitCTYDatabase("cty/cty.dat"); err != nil {
		t.Fatalf("InitCTYDatabase: %v", err)
	}

	// The spellings that differ between CTY.DAT and the way announcements write
	// them. Each of these is taken from the live NG3K feed.
	for _, c := range []struct{ given, want string }{
		{"Lord Howe I", "Lord Howe Island"},
		{"Peter I", "Peter 1 Island"},
		{"Dem Rep Congo", "Dem. Rep. of the Congo"},
		{"Mariana Is", "Mariana Islands"},
		{"Namibia", "Namibia"},
	} {
		got := GetEntityInfo(c.given)
		if got == nil {
			t.Errorf("GetEntityInfo(%q) = nil, want %q", c.given, c.want)
			continue
		}
		if got.Country != c.want {
			t.Errorf("GetEntityInfo(%q) = %q, want %q", c.given, got.Country, c.want)
		}
	}

	// Shorthand the source invented is expected to MISS rather than to guess.
	// The caller falls back to the callsign, which is right in each of these.
	for _, miss := range []string{"Antigua", "Sint Maartin", "San Andres I", "", "   "} {
		if got := GetEntityInfo(miss); got != nil {
			t.Errorf("GetEntityInfo(%q) = %q, want no match", miss, got.Country)
		}
	}

	// A name lookup carries no prefix, so it must not inherit prefix overrides.
	lh := GetEntityInfo("Lord Howe Island")
	if lh == nil || lh.Latitude == 0 {
		t.Fatal("Lord Howe Island did not resolve to a position")
	}
	if lh.Latitude < -32 || lh.Latitude > -31 || lh.Longitude < 158 || lh.Longitude > 160 {
		t.Errorf("Lord Howe at %.2f,%.2f — not where Lord Howe is", lh.Latitude, lh.Longitude)
	}
}
