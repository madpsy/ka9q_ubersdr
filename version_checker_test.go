package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	goversion "github.com/hashicorp/go-version"
)

// bumpVersion returns the running Version with the segment at index shifted by
// delta, e.g. bumpVersion(t, 2, +1) is the next patch release and
// bumpVersion(t, 2, -1) the previous one. Derived from the Version constant so
// these tests keep working across releases.
func bumpVersion(t *testing.T, index, delta int) string {
	t.Helper()

	v, err := goversion.NewVersion(Version)
	if err != nil {
		t.Fatalf("Version constant %q is not a valid semantic version: %v", Version, err)
	}

	segs := v.Segments()
	if index >= len(segs) {
		t.Fatalf("Version %q has no segment %d", Version, index)
	}
	segs[index] += delta
	if segs[index] < 0 {
		t.Skipf("Version %q segment %d cannot be decremented", Version, index)
	}

	return fmt.Sprintf("%d.%d.%d", segs[0], segs[1], segs[2])
}

func TestIsNewerVersionAvailable(t *testing.T) {
	newerPatch := bumpVersion(t, 2, +1)
	olderPatch := bumpVersion(t, 2, -1)
	newerMinor := bumpVersion(t, 1, +1)
	olderMinor := bumpVersion(t, 1, -1)
	newerMajor := bumpVersion(t, 0, +1)

	tests := []struct {
		name   string
		latest string
		want   bool
	}{
		{"empty (not yet checked)", "", false},
		{"same version", Version, false},
		{"same version with v prefix", "v" + Version, false},
		{"newer patch", newerPatch, true},
		{"newer minor", newerMinor, true},
		{"newer major", newerMajor, true},
		// The regression this guards: a local build ahead of what is published
		// on GitHub must NOT be reported as an available update.
		{"older patch (running ahead)", olderPatch, false},
		{"older minor (running ahead)", olderMinor, false},
		{"much older", "0.0.1", false},
		// Unparseable input falls back to string inequality.
		{"unparseable latest", "not-a-version", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsNewerVersionAvailable(tt.latest); got != tt.want {
				t.Errorf("IsNewerVersionAvailable(%q) with Version=%q = %v, want %v",
					tt.latest, Version, got, tt.want)
			}
		})
	}
}

// TestIsNewerVersionAvailableNumericOrdering guards against string comparison
// creeping back in: "0.1.9" sorts after "0.1.10" as a string but is older.
func TestIsNewerVersionAvailableNumericOrdering(t *testing.T) {
	v, err := goversion.NewVersion(Version)
	if err != nil {
		t.Fatalf("Version constant %q is not a valid semantic version: %v", Version, err)
	}
	segs := v.Segments()

	// A patch number with fewer digits but a higher value than the running one
	// is only detected as newer by a numeric comparison.
	if segs[2] < 10 {
		t.Skipf("Version %q patch %d is already single digit", Version, segs[2])
	}
	stringGreaterButOlder := fmt.Sprintf("%d.%d.9", segs[0], segs[1])
	if stringGreaterButOlder > Version {
		// sanity: this input would fool a naive string comparison
		t.Logf("%q sorts after %q as a string", stringGreaterButOlder, Version)
	}
	if IsNewerVersionAvailable(stringGreaterButOlder) {
		t.Errorf("IsNewerVersionAvailable(%q) with Version=%q = true, want false (numeric comparison)",
			stringGreaterButOlder, Version)
	}
}

// withLatestVersion sets the cached latest version for the duration of a test.
func withLatestVersion(t *testing.T, v string) {
	t.Helper()
	prev := GetLatestVersion()
	setLatestVersion(v)
	t.Cleanup(func() { setLatestVersion(prev) })
}

func TestHandleVersionHealth(t *testing.T) {
	newer := bumpVersion(t, 2, +1)
	older := bumpVersion(t, 2, -1)

	tests := []struct {
		name            string
		latest          string
		checkEnabled    bool
		wantUpdate      bool
		wantHealthy     bool
		wantCheckFailed bool
		wantLatest      string
	}{
		{"newer published", newer, true, true, false, false, newer},
		{"same version", Version, true, false, true, false, Version},
		// Reported bug: running 0.1.66 while GitHub still has 0.1.65.
		{"running ahead of published", older, true, false, true, false, older},
		{"not yet checked", "", true, false, true, true, ""},
		{"check disabled", newer, false, false, true, false, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			withLatestVersion(t, tt.latest)

			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/admin/version-health", nil)
			handleVersionHealth(rr, req, tt.checkEnabled)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
			}

			var got VersionHealthStatus
			if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
				t.Fatalf("decode response: %v", err)
			}

			if got.CurrentVersion != Version {
				t.Errorf("current_version = %q, want %q", got.CurrentVersion, Version)
			}
			if got.LatestVersion != tt.wantLatest {
				t.Errorf("latest_version = %q, want %q", got.LatestVersion, tt.wantLatest)
			}
			if got.UpdateAvailable != tt.wantUpdate {
				t.Errorf("update_available = %v, want %v", got.UpdateAvailable, tt.wantUpdate)
			}
			if got.Healthy != tt.wantHealthy {
				t.Errorf("healthy = %v, want %v", got.Healthy, tt.wantHealthy)
			}
			if got.CheckFailed != tt.wantCheckFailed {
				t.Errorf("check_failed = %v, want %v", got.CheckFailed, tt.wantCheckFailed)
			}
		})
	}
}
