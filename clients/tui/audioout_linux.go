//go:build linux

package main

import (
	"fmt"
	"sync"

	"github.com/jfreymuth/pulse"
	"github.com/jfreymuth/pulse/proto"
)

// PulseAudio backend. This is a pure-Go implementation of the PulseAudio wire
// protocol, which is what keeps the Linux build free of CGO — the usual audio
// bindings (ALSA, PortAudio) all need a C toolchain and would break
// cross-compiling to ARM. PipeWire's Pulse compatibility layer speaks the same
// protocol, so this covers effectively every modern desktop Linux.

type pulseBackend struct {
	client *pulse.Client
	stream *pulse.PlaybackStream

	once sync.Once
}

func openBackend(deviceID string, mix *mixer) (audioBackend, error) {
	client, err := pulse.NewClient(pulse.ClientApplicationName("UberSDR TUI"))
	if err != nil {
		return nil, fmt.Errorf("cannot reach PulseAudio: %w", err)
	}

	opts := []pulse.PlaybackOption{
		pulse.PlaybackSampleRate(opusOutputRate),
		pulse.PlaybackChannels(proto.ChannelMap{proto.ChannelLeft, proto.ChannelRight}),
		pulse.PlaybackMediaName("Radio audio"),
		// A short target latency keeps tuning responsive; the mixer pads with
		// silence rather than underrunning if the network hiccups.
		pulse.PlaybackLatency(0.1),
	}

	if deviceID != "" {
		sink, err := client.SinkByID(deviceID)
		if err != nil {
			client.Close()
			return nil, fmt.Errorf("output device %q unavailable: %w", deviceID, err)
		}
		opts = append(opts, pulse.PlaybackSink(sink))
	}

	reader := pulse.Int16Reader(func(out []int16) (int, error) {
		return mix.readStereo(out), nil
	})

	stream, err := client.NewPlayback(reader, opts...)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("cannot open playback stream: %w", err)
	}
	stream.Start()

	return &pulseBackend{client: client, stream: stream}, nil
}

func (b *pulseBackend) Close() error {
	b.once.Do(func() {
		if b.stream != nil {
			b.stream.Stop()
			b.stream.Close()
		}
		if b.client != nil {
			b.client.Close()
		}
	})
	return nil
}

func listDevices() ([]AudioDevice, error) {
	client, err := pulse.NewClient(pulse.ClientApplicationName("UberSDR TUI"))
	if err != nil {
		return nil, fmt.Errorf("cannot reach PulseAudio: %w", err)
	}
	defer client.Close()

	sinks, err := client.ListSinks()
	if err != nil {
		return nil, err
	}

	defaultID := ""
	if def, err := client.DefaultSink(); err == nil && def != nil {
		defaultID = def.ID()
	}

	out := make([]AudioDevice, 0, len(sinks)+1)
	// An explicit "system default" entry means the user can follow whatever the
	// desktop is set to rather than pinning one device.
	out = append(out, AudioDevice{ID: "", Name: "System default", Default: defaultID == ""})
	for _, s := range sinks {
		out = append(out, AudioDevice{
			ID:      s.ID(),
			Name:    s.Name(),
			Default: s.ID() == defaultID,
		})
	}
	return out, nil
}
