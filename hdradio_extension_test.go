package main

import (
	"testing"

	"github.com/cwsl/ka9q_ubersdr/audio_extensions/hdradio"
)

// fakeHDInner stands in for the hdradio package's extension behind the
// wrapper, recording what reaches it.
type fakeHDInner struct {
	programs []int
	retunes  []uint64
	crash    chan error
}

func (f *fakeHDInner) Start(<-chan hdradio.AudioSample, chan<- []byte) error { return nil }
func (f *fakeHDInner) Stop() error                                           { return nil }
func (f *fakeHDInner) GetName() string                                       { return "hdradio" }
func (f *fakeHDInner) CrashChan() <-chan error                               { return f.crash }
func (f *fakeHDInner) Retune(hz uint64)                                      { f.retunes = append(f.retunes, hz) }
func (f *fakeHDInner) SetProgram(p int) error {
	f.programs = append(f.programs, p)
	return nil
}

// The manager only ever sees the wrapper, and type-asserts it for these; one
// not forwarded is silently never called.
func TestHDRadioWrapperForwardsWhatTheManagerAsksFor(t *testing.T) {
	inner := &fakeHDInner{crash: make(chan error, 1)}
	var ext AudioExtension = &hdradioExtensionWrapper{ext: inner}

	if _, ok := ext.(CrashReporter); !ok {
		t.Error("wrapper is not a CrashReporter")
	} else if ext.(CrashReporter).CrashChan() != (<-chan error)(inner.crash) {
		t.Error("CrashChan not forwarded")
	}
	if r, ok := ext.(AudioExtensionRetuner); !ok {
		t.Error("wrapper is not an AudioExtensionRetuner")
	} else {
		r.Retune(830000)
	}
	if s, ok := ext.(interface{ SetProgram(int) error }); !ok {
		t.Error("wrapper has no SetProgram")
	} else if err := s.SetProgram(3); err != nil {
		t.Error(err)
	}
	if len(inner.retunes) != 1 || inner.retunes[0] != 830000 {
		t.Errorf("Retune reached the extension as %v", inner.retunes)
	}
	if len(inner.programs) != 1 || inner.programs[0] != 3 {
		t.Errorf("SetProgram reached the extension as %v", inner.programs)
	}
}

func TestSetProgramControlReachesTheExtension(t *testing.T) {
	s := newPrivateIQManagerSetup(t, "iq48", nil)
	inner := &fakeHDInner{crash: make(chan error, 1)}
	s.aem.registry.Register("hdtest", func(AudioExtensionParams, map[string]interface{}) (AudioExtension, error) {
		return &hdradioExtensionWrapper{ext: inner}, nil
	}, AudioExtensionInfo{Name: "hdtest", PrivateIQ: "iq48"})
	_ = s.aem.handleAttach(privateIQOwnerUUID, nil, map[string]interface{}{"extension_name": "hdtest"})
	defer s.aem.RemoveSession(privateIQOwnerUUID)
	if s.active() == nil {
		t.Fatal("not attached")
	}

	control := func(program interface{}) {
		_ = s.aem.handleControl(privateIQOwnerUUID, nil, map[string]interface{}{
			"type": "audio_extension_control", "control_type": "set_program", "program": program,
		})
	}
	control(float64(2))
	control(1.5)     // not a whole number: refused before the extension
	control("three") // not a number: refused before the extension
	if len(inner.programs) != 1 || inner.programs[0] != 2 {
		t.Errorf("SetProgram calls %v, want just [2]", inner.programs)
	}
}
