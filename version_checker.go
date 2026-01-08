package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	versionURL          = "https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/version.go"
	versionCheckTimeout = 10 * time.Second
	versionFileDir      = "/var/run/updater"
	versionFilePath     = "/var/run/updater/latest"
)

var (
	// LatestVersion holds the latest version fetched from GitHub
	LatestVersion string
	// latestVersionMu protects access to LatestVersion
	latestVersionMu sync.RWMutex
	// versionRegex matches the version constant in version.go
	versionRegex = regexp.MustCompile(`const\s+Version\s*=\s*"([^"]+)"`)
	// sessionManager is used to check for active regular users before writing version file
	sessionManager *SessionManager
)

// GetLatestVersion returns the latest version fetched from GitHub
// Returns empty string if no version has been fetched yet
func GetLatestVersion() string {
	latestVersionMu.RLock()
	defer latestVersionMu.RUnlock()
	return LatestVersion
}

// setLatestVersion safely sets the latest version
func setLatestVersion(version string) {
	latestVersionMu.Lock()
	defer latestVersionMu.Unlock()
	LatestVersion = version
}

// fetchVersionFromGitHub fetches the version.go file from GitHub and extracts the version
func fetchVersionFromGitHub() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), versionCheckTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", versionURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", fmt.Sprintf("UberSDR/%s", Version))

	client := &http.Client{
		Timeout: versionCheckTimeout,
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to fetch version file: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	// Read and parse the file line by line
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Look for the version constant
		matches := versionRegex.FindStringSubmatch(line)
		if len(matches) == 2 {
			return matches[1], nil
		}
	}

	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("error reading response: %w", err)
	}

	return "", fmt.Errorf("version constant not found in file")
}

// WriteVersionFile writes the version string to /var/run/updater/latest
// This function is exported so it can be called by the admin API to force updates
func WriteVersionFile(version string) error {
	// Create directory if it doesn't exist
	if err := os.MkdirAll(versionFileDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", versionFileDir, err)
	}

	// Write version to file (overwrite if exists)
	if err := os.WriteFile(versionFilePath, []byte(version), 0644); err != nil {
		return fmt.Errorf("failed to write version file: %w", err)
	}

	return nil
}

// checkVersion fetches the latest version and updates the global variable
func checkVersion() {
	version, err := fetchVersionFromGitHub()
	if err != nil {
		log.Printf("Version check failed: %v (Current version: %s)", err, Version)
		return
	}

	setLatestVersion(version)

	// Always log both current and latest version
	if version != Version {
		log.Printf("Version check: Current=%s, Latest=%s ⚠️ UPDATE AVAILABLE", Version, version)

		// Check for regular (non-bypassed) users before writing file
		regularUserCount := 0
		if sessionManager != nil {
			regularUserCount = sessionManager.GetNonBypassedUserCount()
		}

		if regularUserCount > 0 {
			// Don't write version file while regular users are connected
			log.Printf("Version file NOT written: %d regular user(s) connected (bypassed/internal users excluded). Will retry on next check to avoid disrupting active users.", regularUserCount)
		} else {
			// Safe to write version file - no regular users connected
			if err := WriteVersionFile(version); err != nil {
				log.Printf("Warning: Failed to write version file: %v", err)
			} else {
				log.Printf("Version file updated: %s (no regular users connected - safe to update)", versionFilePath)
			}
		}
	} else {
		log.Printf("Version check: Current=%s, Latest=%s ✓ Up to date", Version, version)
	}
}

// StartVersionChecker starts a goroutine that periodically checks for new versions
// It performs an initial check at startup and then checks at the configured interval
// If enabled is false, the version checker will not start
func StartVersionChecker(enabled bool, intervalMinutes int, sessions *SessionManager) {
	if !enabled {
		log.Printf("Version checker disabled in configuration")
		return
	}

	// Store session manager reference for checking active users
	sessionManager = sessions

	// Validate interval (minimum 60 minutes)
	if intervalMinutes < 60 {
		log.Printf("Warning: version_check_interval must be at least 60 minutes, using 60")
		intervalMinutes = 60
	}

	interval := time.Duration(intervalMinutes) * time.Minute
	log.Printf("Starting version checker (checking every %v)", interval)

	// Remove any existing version file at startup
	if err := os.Remove(versionFilePath); err != nil && !os.IsNotExist(err) {
		log.Printf("Warning: Failed to remove existing version file: %v", err)
	}

	// Perform initial check at startup
	go checkVersion()

	// Start periodic checker
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for range ticker.C {
			checkVersion()
		}
	}()
}
