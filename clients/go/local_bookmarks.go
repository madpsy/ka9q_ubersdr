package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// LocalBookmark represents a user-saved bookmark
type LocalBookmark struct {
	Name          string `json:"name"`
	Frequency     int    `json:"frequency"`
	Mode          string `json:"mode"`
	BandwidthLow  *int   `json:"bandwidth_low,omitempty"`
	BandwidthHigh *int   `json:"bandwidth_high,omitempty"`
}

// LocalBookmarkManager manages local bookmarks storage
type LocalBookmarkManager struct {
	bookmarks []LocalBookmark
	filePath  string
	mu        sync.RWMutex
}

// NewLocalBookmarkManager creates a new local bookmark manager
func NewLocalBookmarkManager(configDir string) (*LocalBookmarkManager, error) {
	// Ensure config directory exists
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create config directory: %w", err)
	}

	filePath := filepath.Join(configDir, "local_bookmarks.json")

	manager := &LocalBookmarkManager{
		bookmarks: []LocalBookmark{},
		filePath:  filePath,
	}

	// Load existing bookmarks
	if err := manager.Load(); err != nil {
		// If file doesn't exist, that's okay - we'll create it on first save
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("failed to load bookmarks: %w", err)
		}
	}

	return manager, nil
}

// Load loads bookmarks from the JSON file
func (m *LocalBookmarkManager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, err := os.ReadFile(m.filePath)
	if err != nil {
		return err
	}

	if len(data) == 0 {
		m.bookmarks = []LocalBookmark{}
		return nil
	}

	if err := json.Unmarshal(data, &m.bookmarks); err != nil {
		return fmt.Errorf("failed to parse bookmarks: %w", err)
	}

	return nil
}

// Save saves bookmarks to the JSON file
func (m *LocalBookmarkManager) Save() error {
	m.mu.RLock()
	defer m.mu.RUnlock()

	data, err := json.MarshalIndent(m.bookmarks, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal bookmarks: %w", err)
	}

	if err := os.WriteFile(m.filePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write bookmarks file: %w", err)
	}

	return nil
}

// GetAll returns all local bookmarks
func (m *LocalBookmarkManager) GetAll() []LocalBookmark {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// Return a copy to prevent external modification
	bookmarks := make([]LocalBookmark, len(m.bookmarks))
	copy(bookmarks, m.bookmarks)
	return bookmarks
}

// Add adds a new bookmark or updates existing one with the same name
func (m *LocalBookmarkManager) Add(bookmark LocalBookmark) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if bookmark with this name already exists
	for i, existing := range m.bookmarks {
		if existing.Name == bookmark.Name {
			// Update existing bookmark
			m.bookmarks[i] = bookmark
			return m.saveUnlocked()
		}
	}

	// Add new bookmark
	m.bookmarks = append(m.bookmarks, bookmark)
	return m.saveUnlocked()
}

// Delete removes a bookmark by name
func (m *LocalBookmarkManager) Delete(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for i, bookmark := range m.bookmarks {
		if bookmark.Name == name {
			// Remove bookmark
			m.bookmarks = append(m.bookmarks[:i], m.bookmarks[i+1:]...)
			return m.saveUnlocked()
		}
	}

	return fmt.Errorf("bookmark not found: %s", name)
}

// Update updates an existing bookmark
func (m *LocalBookmarkManager) Update(oldName string, newBookmark LocalBookmark) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for i, bookmark := range m.bookmarks {
		if bookmark.Name == oldName {
			m.bookmarks[i] = newBookmark
			return m.saveUnlocked()
		}
	}

	return fmt.Errorf("bookmark not found: %s", oldName)
}

// Exists checks if a bookmark with the given name exists
func (m *LocalBookmarkManager) Exists(name string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, bookmark := range m.bookmarks {
		if bookmark.Name == name {
			return true
		}
	}
	return false
}

// saveUnlocked saves without locking (caller must hold lock)
func (m *LocalBookmarkManager) saveUnlocked() error {
	data, err := json.MarshalIndent(m.bookmarks, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal bookmarks: %w", err)
	}

	if err := os.WriteFile(m.filePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write bookmarks file: %w", err)
	}

	return nil
}
