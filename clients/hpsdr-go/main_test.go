package main

import "testing"

func TestParseRates(t *testing.T) {
	got, err := parseRates("48, 96k,384")
	if err != nil || len(got) != 3 || got[0] != 48 || got[1] != 96 || got[2] != 384 {
		t.Fatalf("%v %v", got, err)
	}
	for _, bad := range []string{"", "12", "48,,96", "fast"} {
		if _, err := parseRates(bad); err == nil {
			t.Errorf("parseRates(%q) accepted", bad)
		}
	}
}

func TestClip(t *testing.T) {
	if clip("short", 10) != "short" || clip("a very long name", 8) != "a very.." {
		t.Fatal(clip("a very long name", 8))
	}
}
