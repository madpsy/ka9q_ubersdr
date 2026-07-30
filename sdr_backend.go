package main

import (
	"fmt"
	"sort"
	"sync"
)

// SDRCapabilities declares the limits that planning, validation, and the UI
// need before opening a receiver. Values are in Hz; a zero maximum means the
// backend cannot state a reliable limit.
type SDRCapabilities struct {
	MinFrequencyHz uint64
	MaxFrequencyHz uint64
	MaxSampleRate  uint64
	Channels       int
	SupportsIQ     bool
	SupportsGPSDO  bool
	SupportsGain   bool
}

// SDRBackend is a hardware or receiver-service adapter. It intentionally
// describes capability and configuration validation separately from UberSDR's
// session/channel API; direct-IQ backends can be added without making USB or
// network details leak into SessionManager.
type SDRBackend interface {
	ID() string
	DisplayName() string
	Capabilities() SDRCapabilities
	ValidateConfig(map[string]any) error
}

type SDRBackendRegistry struct {
	mu       sync.RWMutex
	backends map[string]SDRBackend
}

func NewSDRBackendRegistry() *SDRBackendRegistry {
	return &SDRBackendRegistry{backends: make(map[string]SDRBackend)}
}

func (r *SDRBackendRegistry) Register(backend SDRBackend) error {
	if backend == nil || backend.ID() == "" {
		return fmt.Errorf("SDR backend must have an ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.backends[backend.ID()]; exists {
		return fmt.Errorf("SDR backend %q is already registered", backend.ID())
	}
	r.backends[backend.ID()] = backend
	return nil
}

func (r *SDRBackendRegistry) Lookup(id string) (SDRBackend, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	backend, ok := r.backends[id]
	return backend, ok
}

func (r *SDRBackendRegistry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.backends))
	for id := range r.backends {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// radiodBackend is the initial adapter. It represents the existing KA9Q
// receiver service, preserving its multicast control/data model while giving
// new source adapters a stable catalog entry point.
type radiodBackend struct{}

func (radiodBackend) ID() string          { return "ka9q-radiod" }
func (radiodBackend) DisplayName() string { return "KA9Q radiod receiver service" }
func (radiodBackend) Capabilities() SDRCapabilities {
	return SDRCapabilities{Channels: 1, SupportsIQ: true, SupportsGain: true}
}
func (radiodBackend) ValidateConfig(config map[string]any) error {
	if config == nil {
		return fmt.Errorf("ka9q-radiod requires status_group, data_group, and interface configuration")
	}
	for _, key := range []string{"status_group", "data_group", "interface"} {
		if value, ok := config[key].(string); !ok || value == "" {
			return fmt.Errorf("ka9q-radiod requires %s", key)
		}
	}
	return nil
}

var defaultSDRBackends = newBuiltinSDRBackendRegistry()

func newBuiltinSDRBackendRegistry() *SDRBackendRegistry {
	registry := NewSDRBackendRegistry()
	if err := registry.Register(radiodBackend{}); err != nil {
		panic(err)
	}
	return registry
}
