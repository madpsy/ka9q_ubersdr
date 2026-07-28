package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestRouter returns a router with a single "/addon/demo/" route whose
// handler records the path the backend would have seen.
func newTestRouter(seen *string) *AddonProxyRouter {
	r := NewAddonProxyRouter()
	r.routes["/addon/demo/"] = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		*seen = req.URL.Path
		w.WriteHeader(http.StatusOK)
	})
	return r
}

// A bare /addon/<name> must redirect to the slashed form rather than 404.
// Addon pages resolve assets relatively, which only works from /addon/<name>/.
func TestRouterRedirectsBareAddonPath(t *testing.T) {
	var seen string
	r := newTestRouter(&seen)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/addon/demo", nil))

	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusPermanentRedirect)
	}
	if got := rec.Header().Get("Location"); got != "/addon/demo/" {
		t.Errorf("Location = %q, want %q", got, "/addon/demo/")
	}
	if seen != "" {
		t.Errorf("backend was invoked (saw %q); the redirect should not reach it", seen)
	}
}

// The query string must survive the redirect.
func TestRouterRedirectPreservesQuery(t *testing.T) {
	var seen string
	r := newTestRouter(&seen)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/addon/demo?n=5&since=1h", nil))

	if got, want := rec.Header().Get("Location"), "/addon/demo/?n=5&since=1h"; got != want {
		t.Errorf("Location = %q, want %q", got, want)
	}
}

// 308 (not 301) so a POST to an addon API keeps its method and body.
func TestRouterRedirectPreservesMethod(t *testing.T) {
	var seen string
	r := newTestRouter(&seen)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/addon/demo", nil))

	if rec.Code != http.StatusPermanentRedirect {
		t.Errorf("status = %d, want %d (method-preserving)", rec.Code, http.StatusPermanentRedirect)
	}
}

// The normal slashed path still reaches the handler untouched.
func TestRouterServesSlashedPath(t *testing.T) {
	var seen string
	r := newTestRouter(&seen)

	for _, path := range []string{"/addon/demo/", "/addon/demo/api/events"} {
		seen = ""
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", path, rec.Code)
		}
		if seen != path {
			t.Errorf("%s: backend saw %q, want %q", path, seen, path)
		}
	}
}

// An unknown addon still 404s — the redirect must not turn every miss into one.
func TestRouterUnknownAddonStill404s(t *testing.T) {
	var seen string
	r := newTestRouter(&seen)

	for _, path := range []string{"/addon/nope", "/addon/nope/", "/addon/", "/addon/demo-x"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, rec.Code)
		}
	}
}
