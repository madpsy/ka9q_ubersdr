package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"gopkg.in/yaml.v3"
)

// ChatModerationStore owns chat_moderation.yaml: it loads it at start-up, saves
// it when an admin changes the settings, and hands out the compiled filter. The
// file is written by the program only (like banned_ips.yaml); a missing file
// means the defaults.
type ChatModerationStore struct {
	path  string
	mu    sync.Mutex // serialises Update
	state atomic.Pointer[chatModerationState]
}

type chatModerationState struct {
	settings ChatModerationSettings
	filter   *ChatFilter
}

// NewChatModerationStore loads the settings at path. A missing file gives the
// defaults; an unreadable or invalid file is logged and the defaults are used.
func NewChatModerationStore(path string) *ChatModerationStore {
	s := &ChatModerationStore{path: path}
	settings := DefaultChatModerationSettings()
	if loaded, err := loadChatModerationFile(path); err != nil {
		log.Printf("Warning: chat moderation settings in %s could not be read, using defaults: %v", path, err)
	} else if loaded != nil {
		settings = *loaded
	}
	s.swap(settings)
	return s
}

func loadChatModerationFile(path string) (*ChatModerationSettings, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	in := DefaultChatModerationSettings()
	if err := yaml.Unmarshal(data, &in); err != nil {
		return nil, err
	}
	out, _, rejected, err := normaliseChatModerationSettings(in)
	if err != nil {
		return nil, err
	}
	for _, r := range rejected {
		log.Printf("Warning: chat moderation: ignoring %q from %s: %s", r.Word, path, r.Reason)
	}
	return &out, nil
}

func (s *ChatModerationStore) swap(settings ChatModerationSettings) {
	s.state.Store(&chatModerationState{settings: settings, filter: NewChatFilter(settings)})
}

// Settings returns a copy of the current settings.
func (s *ChatModerationStore) Settings() ChatModerationSettings {
	return s.state.Load().settings.clone()
}

// Filter returns the current compiled filter. It never returns nil.
func (s *ChatModerationStore) Filter() *ChatFilter {
	return s.state.Load().filter
}

// Update validates and tidies the settings, saves them to the file and makes
// them live. On error (bad mode/links value, or the file can't be written) the
// current settings stay in force.
func (s *ChatModerationStore) Update(in ChatModerationSettings) (ChatModerationSettings, []string, []RejectedWord, error) {
	out, notes, rejected, err := normaliseChatModerationSettings(in)
	if err != nil {
		return s.Settings(), nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.save(out); err != nil {
		return s.Settings(), nil, nil, fmt.Errorf("could not save chat moderation settings: %w", err)
	}
	s.swap(out)
	return out.clone(), notes, rejected, nil
}

// save writes the whole file via a temporary file and a rename, so a crash
// mid-write never leaves a half-written file behind.
func (s *ChatModerationStore) save(settings ChatModerationSettings) error {
	data, err := yaml.Marshal(settings)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".chat_moderation-*.yaml")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmpName, 0644)
	}
	if werr == nil {
		werr = os.Rename(tmpName, s.path)
	}
	if werr != nil {
		os.Remove(tmpName)
	}
	return werr
}
