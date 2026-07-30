package main

import "testing"

func TestBuiltinDecoderPluginsPreserveModeInfo(t *testing.T) {
	tests := []struct {
		mode      DecoderMode
		command   string
		streaming bool
	}{
		{ModeWSPR, "wsprd", false},
		{ModeFT8, "jt9_wrapper", true},
		{ModeFT4, "jt9_wrapper", true},
		{ModeJS8, "js8", true},
		{ModeFT2, "jt9_wrapper", true},
	}
	for _, test := range tests {
		info := GetModeInfo(test.mode)
		if info.DecoderCommand != test.command || info.IsStreaming != test.streaming {
			t.Fatalf("mode %s: got command=%q streaming=%v", test.mode, info.DecoderCommand, info.IsStreaming)
		}
	}
}

func TestDecoderPluginRegistryRejectsDuplicateMode(t *testing.T) {
	registry := NewDecoderPluginRegistry()
	plugin := builtinDecoderPlugin{id: "first", mode: ModeFT8}
	if err := registry.Register(plugin); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register(builtinDecoderPlugin{id: "second", mode: ModeFT8}); err == nil {
		t.Fatal("expected duplicate mode registration to fail")
	}
}
