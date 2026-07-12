package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/singleflight"
)

// imageCacheTTL is how long a proxied image is kept in /dev/shm and the
// in-memory metadata map.  Matches qrzCacheTTL so images expire together
// with their callsign cache entries.
const imageCacheTTL = 24 * time.Hour

// imageProxyDir is the tmpfs directory used to store proxied image bytes.
// /dev/shm is RAM-backed on Linux, so reads are fast and the OS cleans it
// up on reboot.  No Go heap pressure from large image buffers.
const imageProxyDir = "/dev/shm"

// imageProxyMaxBytes is the maximum size of a single image we will proxy.
// QRZ photos are typically <200 KB; this cap prevents abuse.
const imageProxyMaxBytes = 1 * 1024 * 1024 // 1 MiB

// allowedImageHosts is the set of hostnames we will fetch images from.
// Only QRZ CDN hosts are permitted — no open-proxy behaviour.
var allowedImageHosts = map[string]bool{
	"cdn-xml.qrz.com": true,
	"www.qrz.com":     true,
	"qrz.com":         true,
}

// imageCacheEntry holds metadata for one proxied image.
// The image bytes are stored in /dev/shm/<imageUUID> — not in this struct.
type imageCacheEntry struct {
	imageUUID   string // UUID used as the filename in /dev/shm/
	srcURL      string // original QRZ image URL (for fetching)
	contentType string // MIME type detected from the response
	expiresAt   time.Time
	ready       chan struct{} // closed when the file has been written (or err set)
	err         error         // non-nil if the fetch/write failed
}

// ImageProxyService manages the in-memory metadata map and background fetches.
type ImageProxyService struct {
	mu sync.RWMutex
	// byUUID maps image UUID → entry (used by the HTTP handler)
	byUUID map[string]*imageCacheEntry
	// byURL maps source URL → entry (used to deduplicate registrations)
	byURL map[string]*imageCacheEntry

	// cacheMaxSize is the maximum number of entries to hold at once
	// (0 = unlimited). This is independent of the QRZ callsign cache size —
	// images are much larger than a callsign record, so a smaller cap keeps
	// /dev/shm usage bounded even when many more callsigns are cached.
	cacheMaxSize int

	// sf deduplicates concurrent background fetches for the same source URL.
	sf singleflight.Group

	rateLimiter *ImageProxyRateLimiter
	httpClient  *http.Client
}

// globalImageProxy is the singleton instance, initialised in main.
var globalImageProxy *ImageProxyService

// NewImageProxyService creates a new ImageProxyService and starts the
// background cleanup goroutine.
// cacheMaxSize is the maximum number of proxied images to retain at once;
// pass 0 to disable the limit (not recommended for public instances).
func NewImageProxyService(cacheMaxSize int) *ImageProxyService {
	s := &ImageProxyService{
		byUUID:       make(map[string]*imageCacheEntry),
		byURL:        make(map[string]*imageCacheEntry),
		cacheMaxSize: cacheMaxSize,
		rateLimiter:  NewImageProxyRateLimiter(),
		httpClient: &http.Client{
			Timeout: 7 * time.Second,
		},
	}
	// Clean up any stale files left from a previous run.
	s.cleanupStaleFiles()
	// Periodic expiry sweep.
	go s.sweepLoop()
	return s
}

// Register ensures an image entry exists for srcURL and returns the UUID path
// that the browser should use to retrieve the image.  If an entry already
// exists (same source URL, not yet expired, and its file is still present on
// disk) the existing UUID is returned.  The actual image fetch happens in the
// background; the caller does not block.
//
// Returns "" if srcURL is empty or from a disallowed host.
//
// IMPORTANT: the image cache has its own size cap (independent of the QRZ
// callsign cache — see cacheMaxSize), so an entry's /dev/shm file can be
// evicted while the callsign itself is still cached and its in-memory
// imageCacheEntry (and TTL) has not yet expired. If that happens here, we
// already know srcURL from the caller (it came straight from the cached
// QRZCallsign) so we transparently discard the stale entry and kick off a
// fresh fetch — no QRZ XML API call is needed.
func (s *ImageProxyService) Register(srcURL string) string {
	if srcURL == "" {
		return ""
	}
	if !s.isAllowedURL(srcURL) {
		return ""
	}

	s.mu.Lock()
	// Reuse an existing non-expired entry for this URL, provided its file
	// is still on disk (or its fetch is still in flight).
	if entry, ok := s.byURL[srcURL]; ok && time.Now().Before(entry.expiresAt) {
		select {
		case <-entry.ready:
			// Fetch has completed. Verify the file is still present on disk —
			// it may have been evicted independently of this map entry (e.g.
			// by the image cache size cap) even though the TTL hasn't expired.
			if entry.err == nil && s.fileExists(entry.imageUUID) {
				s.mu.Unlock()
				return "/api/lookup/image/" + entry.imageUUID
			}
			// Stale/missing on disk — remove the dead entry and fall through
			// to create + fetch a fresh one below (same srcURL, no XML call).
			delete(s.byUUID, entry.imageUUID)
			delete(s.byURL, srcURL)
		default:
			// Fetch still in flight — safe to hand out as-is.
			s.mu.Unlock()
			return "/api/lookup/image/" + entry.imageUUID
		}
	}

	// Create a new entry.
	imgUUID := uuid.New().String()
	entry := &imageCacheEntry{
		imageUUID: imgUUID,
		srcURL:    srcURL,
		expiresAt: time.Now().Add(imageCacheTTL),
		ready:     make(chan struct{}),
	}
	s.byUUID[imgUUID] = entry
	s.byURL[srcURL] = entry
	s.enforceCacheLimitLocked()
	s.mu.Unlock()

	// Fetch in the background; singleflight deduplicates concurrent calls
	// for the same source URL (e.g. two callsigns sharing the same photo).
	go func() {
		s.sf.Do(srcURL, func() (interface{}, error) {
			s.fetchAndStore(entry)
			return nil, nil
		})
	}()

	return "/api/lookup/image/" + imgUUID
}

// fileExists reports whether a non-empty file for the given image UUID is
// currently present in imageProxyDir.
func (s *ImageProxyService) fileExists(imgUUID string) bool {
	info, err := os.Stat(filepath.Join(imageProxyDir, imgUUID))
	return err == nil && info.Size() > 0
}

// enforceCacheLimitLocked evicts entries once the configured cacheMaxSize is
// exceeded (0 = unlimited). Expired entries are evicted first; if still over
// the limit, entries closest to expiry are removed next. Must be called with
// s.mu held (write lock).
func (s *ImageProxyService) enforceCacheLimitLocked() {
	if s.cacheMaxSize <= 0 || len(s.byUUID) <= s.cacheMaxSize {
		return
	}

	// Phase 1: evict all expired entries.
	now := time.Now()
	for imgUUID, entry := range s.byUUID {
		if now.After(entry.expiresAt) {
			delete(s.byUUID, imgUUID)
			delete(s.byURL, entry.srcURL)
			_ = os.Remove(filepath.Join(imageProxyDir, imgUUID))
		}
	}
	if len(s.byUUID) <= s.cacheMaxSize {
		return
	}

	// Phase 2: still over limit — evict the entries closest to expiry
	// (least remaining value) until we're back under the cap.
	type kv struct {
		uuid      string
		expiresAt time.Time
	}
	entries := make([]kv, 0, len(s.byUUID))
	for imgUUID, entry := range s.byUUID {
		entries = append(entries, kv{imgUUID, entry.expiresAt})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].expiresAt.Before(entries[j].expiresAt)
	})
	for _, e := range entries {
		if len(s.byUUID) <= s.cacheMaxSize {
			break
		}
		if entry, ok := s.byUUID[e.uuid]; ok {
			delete(s.byUUID, e.uuid)
			delete(s.byURL, entry.srcURL)
			_ = os.Remove(filepath.Join(imageProxyDir, e.uuid))
		}
	}
}

// CacheSize returns the number of entries currently tracked by the image
// proxy cache.
func (s *ImageProxyService) CacheSize() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.byUUID)
}

// CacheMaxSize returns the configured maximum image cache size (0 = unlimited).
func (s *ImageProxyService) CacheMaxSize() int {
	return s.cacheMaxSize
}

// fetchAndStore downloads the image from entry.srcURL and writes it to
// /dev/shm/<uuid>.  It always closes entry.ready when done (success or fail).
// If the file already exists on disk (e.g. from a previous run that left it
// in /dev/shm), it is served directly without a network fetch.
func (s *ImageProxyService) fetchAndStore(entry *imageCacheEntry) {
	defer close(entry.ready)

	path := filepath.Join(imageProxyDir, entry.imageUUID)

	// If the file already exists on disk, detect its content type and return
	// immediately — no network fetch needed.
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		// Sniff content type from the first 512 bytes.
		if f, err := os.Open(path); err == nil {
			buf := make([]byte, 512)
			n, _ := f.Read(buf)
			f.Close()
			entry.contentType = http.DetectContentType(buf[:n])
		}
		return
	}

	req, err := http.NewRequest(http.MethodGet, entry.srcURL, nil) //nolint:gosec // URL validated by isAllowedURL
	if err != nil {
		entry.err = fmt.Errorf("image-proxy: build request: %w", err)
		log.Printf("[image-proxy] request build error for %s: %v", entry.srcURL, err)
		return
	}
	req.Header.Set("User-Agent", "UberSDR/"+Version)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		entry.err = fmt.Errorf("image-proxy: fetch failed: %w", err)
		log.Printf("[image-proxy] fetch error for %s: %v", entry.srcURL, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		entry.err = fmt.Errorf("image-proxy: upstream returned %d", resp.StatusCode)
		log.Printf("[image-proxy] upstream %d for %s", resp.StatusCode, entry.srcURL)
		return
	}

	// Detect content type from the response header; fall back to sniffing.
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	// Keep only the MIME type, strip parameters (e.g. "; charset=utf-8").
	if idx := strings.Index(ct, ";"); idx >= 0 {
		ct = strings.TrimSpace(ct[:idx])
	}
	entry.contentType = ct

	// Read the body with a size cap.
	body, err := io.ReadAll(io.LimitReader(resp.Body, imageProxyMaxBytes))
	if err != nil {
		entry.err = fmt.Errorf("image-proxy: reading body: %w", err)
		log.Printf("[image-proxy] read error for %s: %v", entry.srcURL, err)
		return
	}

	// Write to /dev/shm/<uuid>.
	if err := os.WriteFile(path, body, 0600); err != nil {
		entry.err = fmt.Errorf("image-proxy: writing to %s: %w", path, err)
		log.Printf("[image-proxy] write error: %v", err)
		// os.WriteFile creates (and truncates) the file before writing, so a
		// failure part-way (e.g. /dev/shm full) can leave a zero-byte or
		// partial file behind.  Remove it so it isn't picked up as a valid
		// cached image on a later run and doesn't waste space until the sweep.
		_ = os.Remove(path)
		return
	}
}

// HandleImageRequest serves GET /api/lookup/image/{uuid}.
// It waits (with a timeout) for the background fetch to complete, then
// serves the file from /dev/shm with long-lived cache headers.
func (s *ImageProxyService) HandleImageRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Rate limit: 3 requests per second per IP.
	// Images are cached by the browser for 24 h so legitimate clients only
	// hit this endpoint once per callsign per session.
	clientIP := getClientIP(r)
	if !s.rateLimiter.Allow(clientIP) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	// Extract UUID from the URL path: /api/lookup/image/<uuid>
	imgUUID := strings.TrimPrefix(r.URL.Path, "/api/lookup/image/")
	imgUUID = strings.Trim(imgUUID, "/")
	if imgUUID == "" {
		http.Error(w, "missing image UUID", http.StatusBadRequest)
		return
	}

	// Validate UUID format to prevent path traversal.
	if _, err := uuid.Parse(imgUUID); err != nil {
		http.Error(w, "invalid image UUID", http.StatusBadRequest)
		return
	}

	s.mu.RLock()
	entry, ok := s.byUUID[imgUUID]
	s.mu.RUnlock()

	if !ok || time.Now().After(entry.expiresAt) {
		http.NotFound(w, r)
		return
	}

	// Wait for the background fetch to complete (up to 5 s).
	select {
	case <-entry.ready:
	case <-time.After(5 * time.Second):
		http.Error(w, "image fetch timed out", http.StatusGatewayTimeout)
		return
	}

	if entry.err != nil {
		http.Error(w, "image unavailable", http.StatusBadGateway)
		return
	}

	path := filepath.Join(imageProxyDir, imgUUID)
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "image not found on disk", http.StatusNotFound)
		return
	}

	ct := entry.contentType
	if ct == "" {
		ct = "application/octet-stream"
	}

	w.Header().Set("Content-Type", ct)
	// Same-origin response: browser will cache this normally.
	// immutable because the UUID is unique per fetch — content never changes.
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// isAllowedURL returns true if the URL's host is in allowedImageHosts.
func (s *ImageProxyService) isAllowedURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return allowedImageHosts[host]
}

// EvictBySourceURL removes the image proxy entry for the given QRZ source URL
// (if any) and deletes the corresponding file from /dev/shm.
// Called by the QRZService eviction callback when a callsign cache entry is
// removed due to expiry or the size cap being exceeded.
func (s *ImageProxyService) EvictBySourceURL(srcURL string) {
	if srcURL == "" {
		return
	}
	s.mu.Lock()
	entry, ok := s.byURL[srcURL]
	if ok {
		delete(s.byURL, srcURL)
		delete(s.byUUID, entry.imageUUID)
	}
	s.mu.Unlock()

	if ok {
		path := filepath.Join(imageProxyDir, entry.imageUUID)
		_ = os.Remove(path)
	}
}

// sweepLoop runs every hour and removes expired entries from the maps and
// their corresponding files from /dev/shm.
func (s *ImageProxyService) sweepLoop() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		s.sweep()
	}
}

func (s *ImageProxyService) sweep() {
	now := time.Now()
	s.mu.Lock()
	for imgUUID, entry := range s.byUUID {
		if now.After(entry.expiresAt) {
			delete(s.byUUID, imgUUID)
			delete(s.byURL, entry.srcURL)
			path := filepath.Join(imageProxyDir, imgUUID)
			_ = os.Remove(path)
		}
	}
	s.mu.Unlock()
	// Also clean up stale rate limiter entries.
	s.rateLimiter.Cleanup()
}

// cleanupStaleFiles removes any /dev/shm files that look like UUIDs but have
// no corresponding in-memory entry (left over from a previous process run).
func (s *ImageProxyService) cleanupStaleFiles() {
	entries, err := os.ReadDir(imageProxyDir)
	if err != nil {
		return // /dev/shm may not exist on non-Linux systems
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, de := range entries {
		name := de.Name()
		if _, err := uuid.Parse(name); err != nil {
			continue // not one of ours
		}
		if _, ok := s.byUUID[name]; !ok {
			_ = os.Remove(filepath.Join(imageProxyDir, name))
		}
	}
}
