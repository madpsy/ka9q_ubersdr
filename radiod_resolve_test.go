package main

import (
	"context"
	"errors"
	"testing"
)

func TestSplitGroupAddr(t *testing.T) {
	tests := []struct {
		in       string
		wantHost string
		wantPort string
	}{
		{"hf-status.local:5006", "hf-status.local", "5006"},
		{"hf-status.local", "hf-status.local", "0"},
		{"239.1.2.3:5004", "239.1.2.3", "5004"},
		{"239.1.2.3", "239.1.2.3", "0"},
		// Splitting on ":" used to cut these at the first colon.
		{"[ff02::1]:5006", "ff02::1", "5006"},
		{"[ff02::1]", "ff02::1", "0"},
		{"ff02::1", "ff02::1", "0"},
	}
	for _, tt := range tests {
		host, port := splitGroupAddr(tt.in)
		if host != tt.wantHost || port != tt.wantPort {
			t.Errorf("splitGroupAddr(%q) = (%q, %q), want (%q, %q)", tt.in, host, port, tt.wantHost, tt.wantPort)
		}
	}
}

// The hash address only works if it is the one radiod itself derives from the
// same name. 239.185.143.241 is what a live radiod published over mDNS for
// hf-status.local, so a change to the hash that breaks compatibility fails here.
func TestMakeMaddrMatchesRadiod(t *testing.T) {
	if got := makeMaddr("hf-status.local"); got != "239.185.143.241" {
		t.Errorf("makeMaddr(\"hf-status.local\") = %s, want 239.185.143.241", got)
	}
}

func TestResolveMulticastAddr(t *testing.T) {
	hashStatus := makeMaddr("hf-status.local")
	errNoSuchHost := errors.New("no such host")

	tests := []struct {
		name      string
		in        string
		useDNS    bool
		answer    []string // what the stubbed DNS returns
		answerErr error
		want      string
		wantErr   bool
	}{
		{
			// The case seen in the field: a search-domain wildcard answering
			// hf-status.local.<domain> with a Cloudflare edge address. Without
			// use_dns the answer is never even asked for.
			name:   "name is hashed without DNS, as radiod does",
			in:     "hf-status.local:5006",
			answer: []string{"104.21.12.92"},
			want:   hashStatus + ":5006",
		},
		{
			name: "missing port defaults to 0",
			in:   "hf-status.local",
			want: hashStatus + ":0",
		},
		{
			name:    "bad port is an error",
			in:      "hf-status.local:abc",
			wantErr: true,
		},
		{
			name: "literal multicast IPv4 used as given",
			in:   "239.9.9.9:5004",
			want: "239.9.9.9:5004",
		},
		{
			// Deliberate config: kept even though it is not multicast.
			name: "literal unicast IPv4 used as given",
			in:   "192.168.1.5:5004",
			want: "192.168.1.5:5004",
		},
		{
			name: "literal IPv6 used as given",
			in:   "[ff02::1]:5006",
			want: "[ff02::1]:5006",
		},
		{
			name:   "use_dns: multicast answer is used",
			in:     "hf-status.local:5006",
			useDNS: true,
			answer: []string{"239.1.2.3"},
			want:   "239.1.2.3:5006",
		},
		{
			name:   "use_dns: unicast-only answer falls back to the hash",
			in:     "hf-status.local:5006",
			useDNS: true,
			answer: []string{"104.21.12.92", "172.67.194.5", "2606:4700:3031::6815:c5c"},
			want:   hashStatus + ":5006",
		},
		{
			name:   "use_dns: multicast picked out of a mixed answer",
			in:     "hf-status.local:5006",
			useDNS: true,
			answer: []string{"192.168.1.10", "239.1.2.3"},
			want:   "239.1.2.3:5006",
		},
		{
			name:   "use_dns: IPv4 multicast preferred over IPv6",
			in:     "hf-status.local:5006",
			useDNS: true,
			answer: []string{"ff15::1", "239.1.2.3"},
			want:   "239.1.2.3:5006",
		},
		{
			name:   "use_dns: IPv6 multicast used when it is all there is",
			in:     "hf-status.local:5006",
			useDNS: true,
			answer: []string{"ff15::1"},
			want:   "[ff15::1]:5006",
		},
		{
			name:      "use_dns: lookup error falls back to the hash",
			in:        "hf-status.local:5006",
			useDNS:    true,
			answerErr: errNoSuchHost,
			want:      hashStatus + ":5006",
		},
	}

	orig := lookupHost
	t.Cleanup(func() { lookupHost = orig })

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			looked := false
			lookupHost = func(ctx context.Context, host string) ([]string, error) {
				looked = true
				return tt.answer, tt.answerErr
			}

			got, err := resolveMulticastAddr(tt.in, tt.useDNS)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("resolveMulticastAddr(%q) = %v, want an error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveMulticastAddr(%q) error: %v", tt.in, err)
			}
			if got.String() != tt.want {
				t.Errorf("resolveMulticastAddr(%q) = %s, want %s", tt.in, got, tt.want)
			}
			// DNS is consulted only with use_dns (every such case is a name).
			if looked != tt.useDNS {
				t.Errorf("resolveMulticastAddr(%q): DNS lookup made = %v, want %v", tt.in, looked, tt.useDNS)
			}
		})
	}
}
