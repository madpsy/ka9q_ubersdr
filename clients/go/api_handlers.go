package main

import (
	"fmt"

	"github.com/gordonklaus/portaudio"
)

// getAudioDevices returns a list of available audio output devices
func getAudioDevices() ([]AudioDevice, error) {
	// Initialize PortAudio
	if err := portaudio.Initialize(); err != nil {
		return nil, fmt.Errorf("failed to initialize PortAudio: %w", err)
	}
	defer portaudio.Terminate()

	devices, err := portaudio.Devices()
	if err != nil {
		return nil, fmt.Errorf("failed to get device list: %w", err)
	}

	defaultOutput, err := portaudio.DefaultOutputDevice()
	var defaultName string
	if err == nil && defaultOutput != nil {
		defaultName = defaultOutput.Name
	}

	var audioDevices []AudioDevice
	for i, device := range devices {
		if device.MaxOutputChannels > 0 {
			audioDevices = append(audioDevices, AudioDevice{
				Index:       i,
				Name:        device.Name,
				MaxChannels: device.MaxOutputChannels,
				SampleRate:  device.DefaultSampleRate,
				Latency:     device.DefaultLowOutputLatency.Seconds() * 1000, // Convert to ms
				IsDefault:   device.Name == defaultName,
			})
		}
	}

	return audioDevices, nil
}
