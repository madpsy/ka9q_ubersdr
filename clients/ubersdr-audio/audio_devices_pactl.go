//go:build !windows

package main

// audio_devices_pactl.go — PulseAudio/PipeWire sink listing and routing, shared
// by the ALSA output on Linux and the oto fallback elsewhere.

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ── Device enumeration ────────────────────────────────────────────────────────

// EnumerateAudioDevices returns the list of available audio output sinks.
// On Linux it queries PulseAudio/PipeWire via `pactl list short sinks`.
// Falls back to a single "Default Device" entry if pactl is unavailable.
func EnumerateAudioDevices() ([]AudioDevice, error) {
	devices := []AudioDevice{{ID: "", Name: "Default Device"}}

	out, err := exec.Command("pactl", "list", "short", "sinks").Output()
	if err != nil {
		// pactl not available or failed — the default and any direct devices
		return append(devices, alsaDirectDevices()...), nil
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		// pactl list short sinks output format:
		//   <index>\t<name>\t<module>\t<sample-spec>\t<state>
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := fields[1] // sink name, e.g. "alsa_output.pci-0000_00_1f.3.analog-stereo"
		devices = append(devices, AudioDevice{ID: name, Name: sinkDisplayName(name)})
	}

	return append(devices, alsaDirectDevices()...), nil
}

// sinkDisplayName turns a sink name into the one the device list shows.
func sinkDisplayName(name string) string {
	display := name
	for _, prefix := range []string{"alsa_output.", "bluez_sink.", "bluez_output."} {
		if strings.HasPrefix(display, prefix) {
			display = strings.TrimPrefix(display, prefix)
			break
		}
	}
	display = strings.NewReplacer(".", " ", "_", " ").Replace(display)
	if len(display) > 0 {
		display = strings.ToUpper(display[:1]) + display[1:]
	}
	return display
}

// moveSinkInput uses `pactl move-sink-input` to redirect this process's audio
// stream(s) to the named sink at runtime, without reopening the output.
// sinkName="" moves to the default sink (@DEFAULT_SINK@).
func moveSinkInput(sinkName string) {
	target := sinkName
	if target == "" {
		target = "@DEFAULT_SINK@"
	}

	pid := fmt.Sprintf("%d", os.Getpid())

	// Use verbose `pactl list sink-inputs` to find sink-input indices that
	// belong to this process, then move each one.
	verboseOut, err := exec.Command("pactl", "list", "sink-inputs").Output()
	if err != nil {
		// Fallback: move all sink-inputs (may affect other apps, but better
		// than nothing when verbose listing fails).
		shortOut, err2 := exec.Command("pactl", "list", "short", "sink-inputs").Output()
		if err2 != nil {
			return
		}
		for _, line := range strings.Split(strings.TrimSpace(string(shortOut)), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 1 {
				exec.Command("pactl", "move-sink-input", fields[0], target).Run() //nolint:errcheck
			}
		}
		return
	}

	// Parse verbose output blocks:
	//   Sink Input #42
	//       ...
	//       application.process.id = "1234"
	currentIdx := ""
	for _, line := range strings.Split(string(verboseOut), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Sink Input #") {
			currentIdx = strings.TrimPrefix(trimmed, "Sink Input #")
		} else if currentIdx != "" &&
			strings.Contains(trimmed, "application.process.id") &&
			strings.Contains(trimmed, `"`+pid+`"`) {
			exec.Command("pactl", "move-sink-input", currentIdx, target).Run() //nolint:errcheck
			currentIdx = ""                                                    // reset so we don't move it twice
		}
	}
}
