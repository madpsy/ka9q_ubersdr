package digitalvoice

import (
	"reflect"
	"testing"
	"time"
)

func TestBuildArgsDMR(t *testing.T) {
	profile, err := LookupProfile("dmr")
	if err != nil {
		t.Fatal(err)
	}
	got, err := BuildArgs(profile, 23456, true)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"-fs", "-xr", "-i", "-", "-s", "48000", "-o", "udp:127.0.0.1:23456"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BuildArgs() = %#v, want %#v", got, want)
	}
}

func TestBuildArgsRejectsUnsupportedInversion(t *testing.T) {
	profile, err := LookupProfile("p25p1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := BuildArgs(profile, 23456, true); err == nil {
		t.Fatal("expected unsupported inversion error")
	}
}

func TestProfilesContainPriorityProtocols(t *testing.T) {
	for _, id := range []string{"dmr", "p25p1", "p25p2", "nxdn48", "nxdn96", "dstar", "ysf", "m17", "dpmr"} {
		if _, err := LookupProfile(id); err != nil {
			t.Errorf("priority protocol %q missing: %v", id, err)
		}
	}
}

func TestResamplerMaintainsPacketBoundary(t *testing.T) {
	resampler := newLinearResampler(24000, 48000)
	first := resampler.process([]int16{0, 1000, 2000})
	second := resampler.process([]int16{3000, 4000})
	got := append(first, second...)
	want := []int16{0, 500, 1000, 1500, 2000, 2500, 3000, 3500}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resampled output = %v, want %v", got, want)
	}
}

func TestParseDMREvent(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	event, ok := parseEvent("auto", "Sync: +DMR slot1 | Color Code=03 | Source=123 Target=456 ENC", now)
	if !ok {
		t.Fatal("expected event")
	}
	if event.Protocol != "dmr" || event.Slot != 1 || event.ColorCode != 3 ||
		event.SourceID != 123 || event.TargetID != 456 || !event.Encrypted {
		t.Fatalf("unexpected parsed event: %+v", event)
	}
}
