package main

import "testing"

// TestSanitizeMessageURLs covers the stored-XSS fix: clients linkify
// `https?://\S+` into an <a href="...">, and HTML-escaping on the client leaves
// quotes alone, so a quote inside a URL span can close the attribute and hang an
// event handler off the anchor. The server must neutralise that before the
// message is ever broadcast.
func TestSanitizeMessageURLs(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "plain message untouched",
			in:   "it's a nice signal, isn't it?",
			want: "it's a nice signal, isn't it?",
		},
		{
			name: "ordinary url untouched",
			in:   "see https://example.com/path?a=1&b=2 for details",
			want: "see https://example.com/path?a=1&b=2 for details",
		},
		{
			name: "double quote breakout encoded",
			in:   `https://x.com/" onmouseover="alert(1)`,
			want: `https://x.com/%22 onmouseover="alert(1)`,
		},
		{
			name: "single quote breakout encoded",
			in:   `https://x.com/' onmouseover='alert(1)`,
			want: `https://x.com/%27 onmouseover='alert(1)`,
		},
		{
			name: "tag breakout encoded",
			in:   `https://x.com/"><img src=x onerror=alert(1)>`,
			want: `https://x.com/%22%3E%3Cimg src=x onerror=alert(1)>`,
		},
		{
			name: "scheme mid-token still matched",
			in:   `foohttps://x.com/"onmouseover="alert(1)`,
			want: `foohttps://x.com/%22onmouseover=%22alert(1)`,
		},
		{
			name: "uppercase scheme matched",
			in:   `HTTPS://x.com/"onmouseover="alert(1)`,
			want: `HTTPS://x.com/%22onmouseover=%22alert(1)`,
		},
		{
			name: "quotes outside a url are left alone",
			in:   `he said "hello" then left`,
			want: `he said "hello" then left`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeMessageURLs(tt.in); got != tt.want {
				t.Errorf("sanitizeMessageURLs(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestSanitizeMessageEncodesURLQuotes checks the full message pipeline, which is
// what SendMessage and InjectMessage actually call.
func TestSanitizeMessageEncodesURLQuotes(t *testing.T) {
	got := sanitizeMessage("check https://x.com/\" onmouseover=\"alert(1) out")
	want := `check https://x.com/%22 onmouseover="alert(1) out`
	if got != want {
		t.Errorf("sanitizeMessage() = %q, want %q", got, want)
	}
}
