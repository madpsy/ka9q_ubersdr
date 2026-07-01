package main

import (
	"encoding/json"
	"net/http"

	goversion "github.com/hashicorp/go-version"
)

// VersionHealthStatus represents the health status of the software version check
type VersionHealthStatus struct {
	Healthy         bool   `json:"healthy"`
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	CheckEnabled    bool   `json:"check_enabled"`
	CheckFailed     bool   `json:"check_failed"`
}

// handleVersionHealth returns the current software version health status.
// It uses the cached latest version from the background version checker
// (version_checker.go) so it never blocks or makes outbound requests.
func handleVersionHealth(w http.ResponseWriter, r *http.Request, versionCheckEnabled bool) {
	w.Header().Set("Content-Type", "application/json")

	latestVersion := GetLatestVersion()
	checkFailed := versionCheckEnabled && latestVersion == ""

	status := &VersionHealthStatus{
		CurrentVersion: Version,
		LatestVersion:  latestVersion,
		CheckEnabled:   versionCheckEnabled,
		CheckFailed:    checkFailed,
	}

	if !versionCheckEnabled {
		// Version checking disabled — report healthy, no update info
		status.Healthy = true
		status.LatestVersion = ""
	} else if checkFailed {
		// Checker is enabled but hasn't fetched a version yet (startup) or all checks failed
		status.Healthy = true // don't alarm on a transient check failure
	} else {
		// Compare semantically
		currentVer, err1 := goversion.NewVersion(Version)
		latestVer, err2 := goversion.NewVersion(latestVersion)
		if err1 == nil && err2 == nil {
			status.UpdateAvailable = latestVer.GreaterThan(currentVer)
		} else {
			// Fall back to string comparison
			status.UpdateAvailable = latestVersion != Version
		}
		// Healthy = no update pending
		status.Healthy = !status.UpdateAvailable
	}

	if err := json.NewEncoder(w).Encode(status); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
	}
}
