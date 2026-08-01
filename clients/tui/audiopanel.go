package main

import (
	"fmt"
	"strings"

	"github.com/gdamore/tcell/v2"
)

// AudioPanel is the modal audio settings overlay: output device, channel
// routing, volume, mode and exact filter edges. It edits the UI's audio state
// directly and reports when something changed so the caller can retune.
type AudioPanel struct {
	row     int
	devices []AudioDevice
	devErr  error

	// selectedDevice carries the device chosen while navigating back to the
	// caller, which owns the output stream and must reopen it.
	selectedDevice string

	// dspStep is a pending DSP cycle, applied by the caller because the DSP
	// command goes over the audio socket rather than into UI state alone.
	dspStep int

	// squelchChanged marks that the threshold moved and must be pushed to the
	// server, for the same reason.
	squelchChanged bool

	// stdoutStep asks the caller to step the second output, which it owns along
	// with the rest of the audio.
	stdoutStep int

	// stdoutMode and stdoutErr are what the caller last reported about that
	// output, since the panel cannot see it itself.
	stdoutMode StdoutMode
	stdoutErr  error
}

// filterStepHz is how far one keypress moves a filter edge. It matches the
// granularity of the mode defaults, whose narrowest edge is 50 Hz.
const filterStepHz = 50

// audioDeviceOff is the sentinel device meaning "no local playback". It heads
// the device list so switching the speakers off is the same control as choosing
// which ones to use — and it cannot collide with a real sink ID.
const audioDeviceOff = "\x00off"

// Panel rows, in display order.
const (
	rowDevice = iota
	rowStdout
	rowChannel
	rowVolume
	rowMode
	rowBandLow
	rowBandHigh
	rowDSP
	rowSquelch
	rowStream
	rowCount
)

func NewAudioPanel(devices []AudioDevice, devErr error) *AudioPanel {
	return &AudioPanel{devices: devices, devErr: devErr}
}

// HandleKey edits the UI state. It returns whether the audio channel needs
// retuning, whether the output device must be reopened, and whether to close.
func (p *AudioPanel) HandleKey(ev *tcell.EventKey, u *UI, deviceID string) (retune, reopen, done bool) {
	switch ev.Key() {
	case tcell.KeyEscape, tcell.KeyEnter:
		return false, false, true

	case tcell.KeyUp:
		p.row = (p.row + rowCount - 1) % rowCount
	case tcell.KeyDown:
		p.row = (p.row + 1) % rowCount

	case tcell.KeyLeft:
		return p.adjust(u, deviceID, -1)
	case tcell.KeyRight:
		return p.adjust(u, deviceID, +1)

	case tcell.KeyRune:
		switch ev.Rune() {
		case 'k':
			p.row = (p.row + rowCount - 1) % rowCount
		case 'j':
			p.row = (p.row + 1) % rowCount
		case 'h':
			return p.adjust(u, deviceID, -1)
		case 'l':
			return p.adjust(u, deviceID, +1)
		case 'm':
			u.muted = !u.muted
			return false, false, false
		case 'q', 'd':
			return false, false, true
		}
	}
	return false, false, false
}

// adjust applies a left/right step to the highlighted row.
func (p *AudioPanel) adjust(u *UI, deviceID string, dir int) (retune, reopen, done bool) {
	switch p.row {
	case rowDevice:
		list := p.deviceChoices()
		idx := 0
		for i, d := range list {
			if d.ID == deviceID {
				idx = i
				break
			}
		}
		idx = (idx + dir + len(list)) % len(list)
		p.selectedDevice = list[idx].ID
		return false, true, false

	case rowStdout:
		p.stdoutStep = dir
		return false, false, false

	case rowChannel:
		u.channel = Channel((int(u.channel) + dir + 3) % 3)
		return false, false, false

	case rowVolume:
		u.volume += float64(dir) * 0.1
		if u.volume < 0 {
			u.volume = 0
		}
		if u.volume > 4 {
			u.volume = 4
		}
		return false, false, false

	case rowMode:
		idx := (modeIndex(u.audioMode) + dir + len(modes)) % len(modes)
		u.ApplyMode(modes[idx].Name)
		return true, false, false

	case rowBandLow:
		u.bwLow, u.bwHigh = clampBandwidth(u.audioMode, u.bwLow+dir*filterStepHz, u.bwHigh)
		return true, false, false

	case rowBandHigh:
		u.bwLow, u.bwHigh = clampBandwidth(u.audioMode, u.bwLow, u.bwHigh+dir*filterStepHz)
		return true, false, false

	case rowDSP:
		p.dspStep = dir
		return false, false, false

	case rowSquelch:
		// One dB per press: the useful range is narrow, so coarse steps would
		// skip straight past the point where a channel opens.
		// Same rule as the t key: below the useful floor means off.
		if u.squelch <= 0 {
			if dir > 0 {
				u.squelch = squelchMin
			}
		} else {
			u.squelch += dir
			if u.squelch < squelchMin {
				u.squelch = 0
			}
			if u.squelch > squelchMax {
				u.squelch = squelchMax
			}
		}
		p.squelchChanged = true
		return false, false, false
	}
	return false, false, false
}

func (p *AudioPanel) Draw(s tcell.Screen, u *UI, deviceID string) {
	w, h := s.Size()
	if w < 40 || h < 12 {
		return
	}

	width := 62
	if width > w-4 {
		width = w - 4
	}
	height := rowCount + 6
	x0 := (w - width) / 2
	y0 := (h - height) / 2

	bg := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(220, 220, 235)).
		Background(tcell.NewRGBColor(28, 28, 38))
	title := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(255, 205, 90)).
		Background(tcell.NewRGBColor(28, 28, 38)).Bold(true)
	sel := tcell.StyleDefault.
		Foreground(tcell.ColorBlack).
		Background(tcell.NewRGBColor(255, 205, 90)).Bold(true)
	dim := tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(140, 140, 155)).
		Background(tcell.NewRGBColor(28, 28, 38))

	for y := y0; y < y0+height; y++ {
		drawText(s, x0, y, bg, strings.Repeat(" ", width))
	}
	drawText(s, x0, y0, title, padTo(" Audio", width))

	deviceName := "System default"
	for _, d := range p.deviceChoices() {
		if d.ID == deviceID {
			deviceName = d.Name
			break
		}
	}
	if p.devErr != nil && deviceID != audioDeviceOff {
		deviceName = "unavailable: " + p.devErr.Error()
	}

	dspValue := "off"
	switch {
	case len(u.dspFilters) == 0:
		dspValue = "not offered by this receiver"
	case u.dspFilter != "":
		dspValue = fmt.Sprintf("%s   (of %s)", dspName(u.dspFilter), strings.Join(dspNames(u.dspFilters), ", "))
	default:
		dspValue = fmt.Sprintf("off   (of %s)", strings.Join(dspNames(u.dspFilters), ", "))
	}

	rows := [rowCount]struct{ label, value string }{
		rowDevice:   {"Output device", deviceName},
		rowStdout:   {"Stdout", p.stdoutValue()},
		rowChannel:  {"Channel", u.channel.String()},
		rowVolume:   {"Volume", fmt.Sprintf("%.0f%%", u.volume*100)},
		rowMode:     {"Mode", modeLabel(u.audioMode)},
		rowBandLow:  {"Filter low", fmt.Sprintf("%+d Hz", u.bwLow)},
		rowBandHigh: {"Filter high", fmt.Sprintf("%+d Hz", u.bwHigh)},
		rowDSP:      {"Noise reduction", dspValue},
		rowSquelch:  {"Squelch (SNR)", squelchValue(u)},
		rowStream:   {"Stream", streamValue(u)},
	}

	for i, r := range rows {
		style := bg
		marker := "  "
		if i == p.row {
			style = sel
			marker = "▶ "
			drawText(s, x0, y0+2+i, sel, strings.Repeat(" ", width))
		}
		line := fmt.Sprintf("%s%-16s %s", marker, r.label, r.value)
		drawText(s, x0+1, y0+2+i, style, truncate(line, width-2))
	}

	// The note under the rows follows the selection, because the one row that
	// cannot simply be switched on is the one that needs to say why. A refusal
	// turns it red: pressing a key that cannot do anything has to look like
	// something, and the status line is behind this panel.
	note, noteStyle := fmt.Sprintf(" filter width %.1f kHz", float64(u.bwHigh-u.bwLow)/1000), dim
	if p.row == rowStdout {
		note = fmt.Sprintf(" pipe: ubersdr-tui -stdout | aplay -f %s -r %d -c %d",
			stdoutFormat, stdoutSampleRate, stdoutChannels)
		if p.stdoutErr != nil {
			noteStyle = tcell.StyleDefault.
				Foreground(tcell.NewRGBColor(235, 110, 100)).
				Background(tcell.NewRGBColor(28, 28, 38))
		}
	}
	drawText(s, x0+1, y0+height-2, noteStyle, truncate(note, width-2))
	drawText(s, x0, y0+height-1, tcell.StyleDefault.
		Foreground(tcell.NewRGBColor(200, 200, 210)).
		Background(tcell.NewRGBColor(45, 45, 55)),
		padTo(" ↑↓ select · ←→ change · m mute · esc close ", width))
}

// deviceChoices is the device list with "off" at its head, so the speakers are
// switched off by the same control that chooses them.
//
// Enumeration failing is not a reason to lose that: a machine with no sound
// server can still pipe audio to stdout, and the panel has to be able to say so.
func (p *AudioPanel) deviceChoices() []AudioDevice {
	out := make([]AudioDevice, 0, len(p.devices)+1)
	out = append(out, AudioDevice{ID: audioDeviceOff, Name: "Off — no local playback"})
	return append(out, p.devices...)
}

// stdoutValue describes the raw stream: what it is carrying, or why it is not.
func (p *AudioPanel) stdoutValue() string {
	switch {
	case p.stdoutErr != nil:
		return "off — " + p.stdoutErr.Error()
	case p.stdoutMode != StdoutOff:
		return p.stdoutMode.Label()
	case stdoutIsTerminal():
		// Kept short enough to survive the value column; the note below the
		// rows carries the command that fixes it.
		return "off — stdout is a terminal"
	default:
		return "off"
	}
}

// streamValue reports the channel's sample rate and the rate actually played.
// They differ by design: the radio channel runs at 12 or 24 kHz depending on
// mode, and Opus always reconstructs at 48 kHz.
func streamValue(u *UI) string {
	if u.signal.SourceRate <= 0 {
		return "—"
	}
	ch := "mono"
	if u.signal.Channels == 2 {
		ch = "stereo"
	} else if u.signal.Channels > 2 {
		ch = fmt.Sprintf("%d ch", u.signal.Channels)
	}
	return fmt.Sprintf("%.1f kHz %s from the radio, played at %.0f kHz",
		float64(u.signal.SourceRate)/1000, ch, float64(opusOutputRate)/1000)
}

// squelchValue describes the gate for the panel, including whether it is
// currently closed.
func squelchValue(u *UI) string {
	if u.squelch <= 0 {
		return "off"
	}
	if u.Squelched() {
		return fmt.Sprintf("%d dB SNR   — closed, audio muted", u.squelch)
	}
	return fmt.Sprintf("%d dB SNR   — open", u.squelch)
}

func modeLabel(name string) string {
	if m, ok := lookupMode(name); ok {
		return fmt.Sprintf("%s — %s", strings.ToUpper(m.Name), m.Desc)
	}
	return strings.ToUpper(name)
}
