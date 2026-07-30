package signalling

import (
	"reflect"
	"testing"
)

func TestBuildArgsPaging(t *testing.T) {
	profile, err := LookupProfile("paging")
	if err != nil {
		t.Fatal(err)
	}
	got := BuildArgs(profile)
	want := []string{
		"-t", "raw", "-q", "--timestamp", "-f", "alpha",
		"-a", "POCSAG512", "-a", "POCSAG1200", "-a", "POCSAG2400", "-a", "FLEX", "-",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BuildArgs() = %#v, want %#v", got, want)
	}
}

func TestPriorityProfiles(t *testing.T) {
	for _, id := range []string{"paging", "pocsag", "flex", "eas", "dtmf", "twotone", "telemetry", "all"} {
		if _, err := LookupProfile(id); err != nil {
			t.Errorf("profile %q missing: %v", id, err)
		}
	}
}

func TestResamplerProduces22050HzRatio(t *testing.T) {
	resampler := newLinearResampler(24000, 22050)
	input := make([]int16, 24000)
	got := resampler.process(input)
	if len(got) < 22048 || len(got) > 22051 {
		t.Fatalf("resampled length = %d, expected approximately 22050", len(got))
	}
}
