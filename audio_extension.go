package main

import (
	"fmt"
	"sync"
)

// AudioExtensionParams contains audio stream parameters (from session, not user-configurable)
type AudioExtensionParams struct {
	SampleRate    int // Hz (e.g., 48000)
	Channels      int // Always 1 (mono)
	BitsPerSample int // Always 16
}

// AudioExtension interface for extensible audio processors
// These receive the same PCM audio stream as the user hears
type AudioExtension interface {
	// Start begins processing audio and sending results
	// audioChan: receives PCM audio samples ([]int16)
	// resultChan: sends binary results back to user
	Start(audioChan <-chan []int16, resultChan chan<- []byte) error

	// Stop stops the extension
	Stop() error

	// GetName returns the extension name
	GetName() string
}

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// AudioExtensionInfo contains metadata about a registered extension
type AudioExtensionInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

// AudioExtensionRegistry manages available audio extension types
type AudioExtensionRegistry struct {
	factories map[string]AudioExtensionFactory
	info      map[string]AudioExtensionInfo
	mu        sync.RWMutex
}

// NewAudioExtensionRegistry creates a new audio extension registry
func NewAudioExtensionRegistry() *AudioExtensionRegistry {
	return &AudioExtensionRegistry{
		factories: make(map[string]AudioExtensionFactory),
		info:      make(map[string]AudioExtensionInfo),
	}
}

// Register registers a new audio extension type
func (aer *AudioExtensionRegistry) Register(name string, factory AudioExtensionFactory, info AudioExtensionInfo) {
	aer.mu.Lock()
	defer aer.mu.Unlock()

	aer.factories[name] = factory
	aer.info[name] = info
}

// Create creates a new audio extension instance
func (aer *AudioExtensionRegistry) Create(name string, audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	aer.mu.RLock()
	factory, exists := aer.factories[name]
	aer.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("audio extension not found: %s", name)
	}

	return factory(audioParams, extensionParams)
}

// List returns information about all registered audio extensions
func (aer *AudioExtensionRegistry) List() []AudioExtensionInfo {
	aer.mu.RLock()
	defer aer.mu.RUnlock()

	list := make([]AudioExtensionInfo, 0, len(aer.info))
	for _, info := range aer.info {
		list = append(list, info)
	}

	return list
}

// Exists checks if an audio extension is registered
func (aer *AudioExtensionRegistry) Exists(name string) bool {
	aer.mu.RLock()
	defer aer.mu.RUnlock()

	_, exists := aer.factories[name]
	return exists
}
