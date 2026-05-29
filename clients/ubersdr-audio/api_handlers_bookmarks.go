package main

// api_handlers_bookmarks.go — handler for:
//   GET /api/v1/bookmarks
//
// Proxies GET /api/bookmarks from the currently connected SDR server.
// Returns the raw JSON array from the server, or 503 if not connected.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// bookmarkHTTPClient is a shared client with a short timeout for bookmark fetches.
var bookmarkHTTPClient = &http.Client{Timeout: 8 * time.Second}

func (s *APIServer) handleBookmarks(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	// Must be connected to an SDR server.
	if s.client.State() != StateConnected {
		apiError(w, http.StatusServiceUnavailable, "not connected to an SDR server")
		return
	}

	baseURL := strings.TrimRight(s.client.BaseURL, "/")
	if baseURL == "" {
		apiError(w, http.StatusServiceUnavailable, "no server URL configured")
		return
	}

	// Build the bookmark URL — pass through any query parameters the caller sent
	// (e.g. ?center=14200000&width=500000&limit=50).
	bookmarkURL := fmt.Sprintf("%s/api/bookmarks", baseURL)
	if r.URL.RawQuery != "" {
		bookmarkURL += "?" + r.URL.RawQuery
	}

	resp, err := bookmarkHTTPClient.Get(bookmarkURL)
	if err != nil {
		apiError(w, http.StatusBadGateway, "failed to fetch bookmarks from server: "+err.Error())
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20)) // 4 MB limit
	if err != nil {
		apiError(w, http.StatusBadGateway, "failed to read bookmark response: "+err.Error())
		return
	}

	if resp.StatusCode != http.StatusOK {
		apiError(w, http.StatusBadGateway,
			fmt.Sprintf("server returned %d for /api/bookmarks", resp.StatusCode))
		return
	}

	// Validate that the response is a JSON array (not an error object).
	var raw json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		apiError(w, http.StatusBadGateway, "server returned invalid JSON for bookmarks")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
