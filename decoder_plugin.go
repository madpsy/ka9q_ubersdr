package main

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// DecoderPlugin describes one decoder integration. Implementations may use an
// external process, a streaming service, or an in-process decoder; callers only
// need the timing and input requirements exposed by ModeInfo.
//
// The existing built-ins are registered at startup. This registry deliberately
// does not load arbitrary shared libraries: decoder integrations are compiled
// into a trusted UberSDR build or supplied by a future out-of-process adapter.
type DecoderPlugin interface {
	ID() string
	Mode() DecoderMode
	ModeInfo() ModeInfo
}

type builtinDecoderPlugin struct {
	id   string
	mode DecoderMode
	info ModeInfo
}

func (p builtinDecoderPlugin) ID() string         { return p.id }
func (p builtinDecoderPlugin) Mode() DecoderMode  { return p.mode }
func (p builtinDecoderPlugin) ModeInfo() ModeInfo { return p.info }

// DecoderPluginRegistry is safe for startup-time registration and concurrent
// reads by decoder workers. One plugin owns each DecoderMode.
type DecoderPluginRegistry struct {
	mu      sync.RWMutex
	plugins map[DecoderMode]DecoderPlugin
}

func NewDecoderPluginRegistry() *DecoderPluginRegistry {
	return &DecoderPluginRegistry{plugins: make(map[DecoderMode]DecoderPlugin)}
}

func (r *DecoderPluginRegistry) Register(plugin DecoderPlugin) error {
	if plugin == nil || plugin.ID() == "" {
		return fmt.Errorf("decoder plugin must have an ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.plugins[plugin.Mode()]; ok {
		return fmt.Errorf("decoder mode %s is already owned by %s", plugin.Mode(), existing.ID())
	}
	r.plugins[plugin.Mode()] = plugin
	return nil
}

func (r *DecoderPluginRegistry) Lookup(mode DecoderMode) (DecoderPlugin, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	plugin, ok := r.plugins[mode]
	return plugin, ok
}

func (r *DecoderPluginRegistry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.plugins))
	for _, plugin := range r.plugins {
		ids = append(ids, plugin.ID())
	}
	sort.Strings(ids)
	return ids
}

var defaultDecoderPlugins = newBuiltinDecoderPluginRegistry()

func newBuiltinDecoderPluginRegistry() *DecoderPluginRegistry {
	registry := NewDecoderPluginRegistry()
	for _, plugin := range []DecoderPlugin{
		builtinDecoderPlugin{id: "wspr", mode: ModeWSPR, info: ModeInfo{CycleTime: 120 * time.Second, TransmissionTime: 114 * time.Second, DecoderCommand: "wsprd", DecoderArgs: []string{"-f", "{freq}", "-C", "{depth}", "-w", "{file}"}, Preset: "usb"}},
		builtinDecoderPlugin{id: "ft8", mode: ModeFT8, info: ModeInfo{DecoderCommand: "jt9_wrapper", DecoderArgs: []string{"-m", "FT8", "-j", "{jt9_path}", "-s", "-d", "{depth}"}, Preset: "usb", IsStreaming: true}},
		builtinDecoderPlugin{id: "ft4", mode: ModeFT4, info: ModeInfo{DecoderCommand: "jt9_wrapper", DecoderArgs: []string{"-m", "FT4", "-j", "{jt9_path}", "-s", "-d", "{depth}"}, Preset: "usb", IsStreaming: true}},
		builtinDecoderPlugin{id: "js8", mode: ModeJS8, info: ModeInfo{DecoderCommand: "js8", DecoderArgs: []string{"--stdin", "-d", "{depth}"}, Preset: "usb", IsStreaming: true}},
		builtinDecoderPlugin{id: "ft2", mode: ModeFT2, info: ModeInfo{DecoderCommand: "jt9_wrapper", DecoderArgs: []string{"-m", "FT2", "-j", "{jt9_path}", "-s", "-d", "{depth}"}, Preset: "usb", IsStreaming: true}},
	} {
		if err := registry.Register(plugin); err != nil {
			panic(err)
		}
	}
	return registry
}
