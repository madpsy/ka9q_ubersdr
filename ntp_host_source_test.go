package main

import "testing"

func TestParseHostTimeSource(t *testing.T) {
	tests := []struct {
		name, out, source string
		ok                bool
	}{
		{"chrony ubersdr-ntp", "^,*,127.0.0.1,1,4,377,10,0.0000012,0.0000015,0.0000102\n^,+,162.159.200.1,3,6,377,40,0.0001,0.0001,0.004\n", "127.0.0.1", true},
		{"chrony cloudflare", "^,-,127.0.0.1,1,4,0,-,0,0,0\n^,*,162.159.200.1,3,6,377,40,0.0001,0.0001,0.004\n", "162.159.200.1", true},
		{"chrony none selected", "^,?,127.0.0.1,0,4,0,-,0,0,0\n", "", true},
		{"ntpq", "     remote           refid      st t when poll reach   delay   offset   jitter\n==============================================================================\n*91.189.91.157   194.58.204.20    2 u   33   64  377   12.345   -0.123   0.456\n", "91.189.91.157", true},
		{"ntpq none selected", "     remote           refid      st t when poll reach   delay   offset   jitter\n==============================================================================\n 91.189.91.157   .INIT.          16 u    -   64    0    0.000   +0.000   0.000\n", "", true},
		{"empty", "", "", false},
	}
	for _, tt := range tests {
		source, ok := parseHostTimeSource(tt.out)
		if source != tt.source || ok != tt.ok {
			t.Errorf("%s: got (%q, %v), want (%q, %v)", tt.name, source, ok, tt.source, tt.ok)
		}
	}
}
