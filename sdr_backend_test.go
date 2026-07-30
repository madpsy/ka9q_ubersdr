package main

import (
	"strings"
	"testing"
)

func TestBuiltInRadiodBackendConfiguration(t *testing.T) {
	backend, ok := defaultSDRBackends.Lookup("ka9q-radiod")
	if !ok {
		t.Fatal("ka9q-radiod backend is not registered")
	}
	if err := backend.ValidateConfig(map[string]any{
		"status_group": "hf-status.local",
		"data_group":   "pcm.local",
		"interface":    "eth0",
	}); err != nil {
		t.Fatalf("valid radiod configuration rejected: %v", err)
	}
	if err := backend.ValidateConfig(map[string]any{"status_group": "hf-status.local"}); err == nil {
		t.Fatal("incomplete radiod configuration was accepted")
	}
}

func TestBuiltInReceiverCatalog(t *testing.T) {
	required := []string{
		"airspy", "airspyhf", "bladerf", "fobos", "funcube", "hackrf",
		"hydrasdr", "rtlsdr", "rx888", "sdrplay",
	}
	for _, driver := range required {
		if _, ok := defaultSDRDeviceProfiles.Lookup(driver); !ok {
			t.Errorf("expected built-in receiver profile %q", driver)
		}
	}
	if _, ok := defaultSDRBackends.Lookup("external-radiod"); !ok {
		t.Error("external radiod adapter is not registered")
	}
}

func TestReceiverConfigValidation(t *testing.T) {
	receiver := ReceiverConfig{
		Backend:        "ka9q-radiod",
		Driver:         "rtlsdr",
		FrequencyMinHz: 24_000_000,
		FrequencyMaxHz: 1_766_000_000,
		Options:        map[string]string{"agc": "true"},
	}
	if err := receiver.Validate(); err != nil {
		t.Fatalf("valid receiver rejected: %v", err)
	}

	receiver.Driver = "not-a-driver"
	if err := receiver.Validate(); err == nil {
		t.Fatal("unknown native driver was accepted")
	}

	receiver.Backend = "external-radiod"
	if err := receiver.Validate(); err != nil {
		t.Fatalf("external radiod should accept bridge-specific drivers: %v", err)
	}

	receiver.Options = map[string]string{"bad\nkey": "value"}
	if err := receiver.Validate(); err == nil {
		t.Fatal("unsafe radiod option name was accepted")
	}
}

func TestSpectrumRangeUsesInstantaneousSampleRate(t *testing.T) {
	config := Config{Receiver: ReceiverConfig{
		FrequencyMinHz:  24_000_000,
		FrequencyMaxHz:  1_766_000_000,
		SampleRate:      2_400_000,
		CenterFrequency: 145_000_000,
	}}
	minHz, maxHz := config.SpectrumRange()
	if minHz != 143_800_000 || maxHz != 146_200_000 {
		t.Fatalf("unexpected instantaneous spectrum range: %d-%d", minHz, maxHz)
	}

	config.Receiver.CenterFrequency = 24_000_000
	minHz, maxHz = config.SpectrumRange()
	if minHz != 24_000_000 || maxHz != 26_400_000 {
		t.Fatalf("spectrum range was not clamped to receiver edge: %d-%d", minHz, maxHz)
	}
}

func TestBuildRadiodConfig(t *testing.T) {
	receiver := ReceiverConfig{
		Backend:         "ka9q-radiod",
		Driver:          "hackrf",
		Device:          "hackrf",
		Description:     "Wideband receiver",
		Serial:          "00000001",
		SampleRate:      20_000_000,
		CenterFrequency: 145_000_000,
		FrequencyMinHz:  1_000_000,
		FrequencyMaxHz:  6_000_000_000,
		Options: map[string]string{
			"vga-gain": "20",
			"lna-gain": "16",
		},
	}
	got, err := BuildRadiodConfig(receiver, RadiodConfig{
		StatusGroup: "239.1.2.3:5006",
		DataGroup:   "239.1.2.4:5004",
	})
	if err != nil {
		t.Fatalf("BuildRadiodConfig failed: %v", err)
	}
	for _, want := range []string{
		"hardware = hackrf",
		"status = 239.1.2.3",
		"data = 239.1.2.4",
		"[hackrf]",
		"samprate = 20000000",
		"frequency = 145000000",
		"lna-gain = 16",
		"vga-gain = 20",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("generated config does not contain %q:\n%s", want, got)
		}
	}
	if strings.Index(got, "lna-gain") > strings.Index(got, "vga-gain") {
		t.Error("driver options are not emitted deterministically")
	}
}
