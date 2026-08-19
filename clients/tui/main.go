package main

import (
	"context"
	"flag"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gdamore/tcell/v2"
)

const (
	minSpan = 10000.0    // 10 kHz — matches the web UI's zoom floor
	maxSpan = 30000000.0 // full HF coverage
	minFreq = 10000.0    // server rejects centers below 10 kHz
	maxFreq = 30000000.0 // …and above 30 MHz
)

func main() {
	server := flag.String("server", "", "receiver: a public callsign or name, host:port, or a full http(s):// URL (empty opens the receiver picker)")
	useTLS := flag.Bool("tls", false, "use TLS (wss/https); implied by an https:// URL")
	password := flag.String("password", "", "optional bypass password")
	freq := flag.Float64("freq", 0, "initial frequency in kHz (0 = the receiver's own default)")
	span := flag.Float64("span", 0, "initial span in kHz (0 = server default)")
	bars := flag.Bool("bars", false, "draw block bars instead of the higher-resolution braille spectrum")
	view := flag.String("view", "split", "initial view: spectrum, waterfall or split")
	audioMode := flag.String("mode", "", "initial demodulation mode (empty = the receiver's own default)")
	bandwidth := flag.String("bw", "", "filter edges in Hz as low:high (empty = the mode's own default)")
	headless := flag.Bool("headless", false, "no display: tune and stream the audio, for scripts and services (needs -server)")
	squelch := flag.Int("squelch", 0, "squelch threshold in dB of SNR (0 = off)")
	noAudio := flag.Bool("no-audio", false, "watch the spectrum without opening an audio channel")
	toStdout := flag.Bool("stdout", false, "write the demodulated audio to stdout as raw PCM (48 kHz mono S16_LE) for piping")
	toStdoutWAV := flag.Bool("stdout-wav", false, "as -stdout, but with a WAV header, so a redirected file plays anywhere")
	noDevice := flag.Bool("no-device", false, "do not open a sound device; useful with -stdout")
	device := flag.String("device", "", "output device: an index from -device list, or part of its name (empty = system default)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	ipv4Only := flag.Bool("4", false, "IPv4 only: never dial a receiver or the directory over IPv6 (LAN discovery is always IPv4)")
	flag.Parse()

	forceIPv4 = *ipv4Only

	if *showVersion {
		fmt.Printf("ubersdr-tui %s\n", version)
		return
	}

	mode, err := parseView(*view)
	if err != nil {
		fatal("%v", err)
	}

	// An unknown mode is worth refusing outright: silently falling back would
	// leave the user listening on something they did not ask for.
	if *audioMode != "" {
		if _, ok := lookupMode(*audioMode); !ok {
			fatal("unknown mode %q (want one of %s)", *audioMode, strings.Join(modeNames(), ", "))
		}
	}

	// -device list is a question, not a setting: answer it and stop. It goes to
	// stderr like everything else that is not audio, so it stays readable when
	// stdout is being piped.
	if deviceListSpecs[strings.ToLower(strings.TrimSpace(*device))] {
		fmt.Fprintln(os.Stderr, describeDevices())
		return
	}

	deviceID := ""
	if *device != "" {
		var err error
		if deviceID, err = resolveDevice(*device); err != nil {
			fatal("-device %q: %v\n%s", *device, err, describeDevices())
		}
	}

	// The same flags serve both modes, so they are checked once here rather
	// than differently in each.
	if *squelch != 0 && (*squelch < squelchMin || *squelch > squelchMax) {
		fatal("-squelch %d is outside %d–%d dB SNR (0 turns it off)", *squelch, squelchMin, squelchMax)
	}

	var bwLow, bwHigh int
	if *bandwidth != "" {
		var err error
		if bwLow, bwHigh, err = parseBandwidth(*bandwidth); err != nil {
			fatal("-bw %q: %v", *bandwidth, err)
		}
	}

	// WAV is the same stream with a header, so asking for both is not a
	// conflict: the header wins.
	stdoutMode := StdoutOff
	switch {
	case *toStdoutWAV:
		stdoutMode = StdoutWAV
	case *toStdout:
		stdoutMode = StdoutRaw
	}

	// Refusing here rather than starting without it: someone who asked for the
	// stream wants the stream, and writing PCM to a terminal would wreck it.
	if stdoutMode != StdoutOff && stdoutIsTerminal() {
		fatal("-stdout needs somewhere to write: pipe it, e.g. %s -stdout | aplay -f %s -r %d -c %d\n"+
			"       or redirect it, e.g. %s -stdout-wav > radio.wav",
			os.Args[0], stdoutFormat, stdoutSampleRate, stdoutChannels, os.Args[0])
	}

	opts := options{
		password:      *password,
		initialFreq:   *freq * 1000,
		initialSpan:   *span * 1000,
		initialMode:   strings.ToLower(*audioMode),
		braille:       !*bars,
		mode:          mode,
		noAudio:       *noAudio,
		stdoutMode:    stdoutMode,
		noDevice:      *noDevice,
		headless:      *headless,
		deviceID:      deviceID,
		squelch:       *squelch,
		bwLow:         bwLow,
		bwHigh:        bwHigh,
		haveBandwidth: *bandwidth != "",
	}
	// An explicit -server connects straight away; otherwise the picker opens so
	// the user can browse public, local or manually entered receivers. It takes
	// an address or the name of a public receiver, so -server m9psy works.
	if *server != "" {
		ctx, cancel := context.WithTimeout(context.Background(), directoryTimeout)
		inst, err := resolveTarget(ctx, *server, *useTLS)
		cancel()
		if err != nil {
			fatal("%v", err)
		}
		opts.target = &inst
	}

	// Headless has nowhere to show a picker, so it needs to be told where to
	// listen.
	if opts.headless {
		if opts.target == nil {
			fatal("-headless needs -server: a receiver name, host:port or URL")
		}
		if opts.noAudio {
			fatal("-no-audio leaves -headless with nothing to do")
		}
		if err := runHeadless(opts); err != nil {
			fatal("%v", err)
		}
		return
	}

	if err := run(opts); err != nil {
		fatal("%v", err)
	}
}

// options carries start-up settings into the UI.
type options struct {
	target      *Instance // nil opens the picker instead
	password    string
	initialFreq float64
	initialSpan float64
	// initialMode is the demodulation mode asked for on the command line, empty
	// to take whatever the receiver names as its own default.
	initialMode string
	braille     bool
	mode        ViewMode
	noAudio     bool
	// The two outputs are independent: either, both or neither.
	stdoutMode StdoutMode
	noDevice   bool

	// Headless drops the display entirely: tune, stream, and say nothing but
	// what stderr needs to hear.
	headless bool
	// deviceID is the sound device chosen by -device, empty for the system
	// default. It is resolved before anything starts, so a name that matches
	// nothing is refused while there is still a terminal to say so.
	deviceID string
	squelch  int
	// The filter edges, when the command line named them rather than leaving
	// the mode's own defaults in place.
	bwLow, bwHigh int
	haveBandwidth bool
}

func parseView(s string) (ViewMode, error) {
	switch strings.ToLower(s) {
	case "spectrum", "spec":
		return ViewSpectrum, nil
	case "waterfall", "wf", "water":
		return ViewWaterfall, nil
	case "split", "both":
		return ViewSplit, nil
	default:
		return 0, fmt.Errorf("unknown view %q (want spectrum, waterfall or split)", s)
	}
}

func fatal(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}

// parseServer accepts either host:port or a full URL, returning the bare
// host:port and whether TLS should be used.
func parseServer(s string, useTLS bool) (string, bool) {
	switch {
	case strings.HasPrefix(s, "https://"):
		return strings.TrimSuffix(strings.TrimPrefix(s, "https://"), "/"), true
	case strings.HasPrefix(s, "http://"):
		return strings.TrimSuffix(strings.TrimPrefix(s, "http://"), "/"), useTLS
	default:
		return strings.TrimSuffix(s, "/"), useTLS
	}
}

func run(opts options) error {
	screen, err := tcell.NewScreen()
	if err != nil {
		return fmt.Errorf("cannot open terminal: %w", err)
	}
	if err := screen.Init(); err != nil {
		return fmt.Errorf("cannot initialise terminal: %w", err)
	}
	// Restore the terminal even if we panic partway through drawing.
	defer screen.Fini()

	screen.SetStyle(tcell.StyleDefault)
	// Motion events drive the crosshair readout, so the pointer reports even
	// with no button held.
	screen.EnableMouse(tcell.MouseButtonEvents | tcell.MouseDragEvents | tcell.MouseMotionEvents)
	screen.Clear()

	ui := NewUI("")
	ui.braille = opts.braille
	ui.mode = opts.mode
	ui.squelch = opts.squelch

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Local discovery runs for the whole session so the picker's Local tab is
	// already populated whenever the user opens it.
	local := NewLocalDiscovery()
	go func() {
		if err := local.Run(ctx); err != nil {
			ui.status = "local discovery unavailable: " + err.Error()
		}
	}()

	events := make(chan tcell.Event, 32)
	go screen.ChannelEvents(events, ctx.Done())

	loop := &eventLoop{
		screen:   screen,
		ui:       ui,
		cancel:   cancel,
		rootCtx:  ctx,
		opts:     opts,
		local:    local,
		wake:     make(chan struct{}, 1),
		deviceID: opts.deviceID,
		// -no-device starts with the speakers off, which is what makes
		// -stdout on its own useful.
		deviceOff: opts.noDevice,
	}

	// Shut the outputs down on the way out. It matters for more than tidiness:
	// a WAV capture only gets the real sizes in its header when the stream is
	// closed properly, and an abandoned PulseAudio stream lingers.
	defer func() {
		if loop.out != nil {
			loop.out.Close()
		}
	}()

	if opts.target != nil {
		loop.connectTo(*opts.target)
	} else {
		loop.openPicker(true)
	}
	return loop.run(ctx, events)
}

type eventLoop struct {
	screen  tcell.Screen
	client  *Client
	ui      *UI
	cancel  context.CancelFunc
	rootCtx context.Context
	opts    options
	local   *LocalDiscovery

	// Cancels only the current connection, leaving the UI and discovery alive
	// so the user can switch receivers without restarting.
	clientCancel context.CancelFunc

	picker        *Picker
	audioPanel    *AudioPanel
	bookmarkPanel *BookmarkPanel
	chatPanel     *ChatPanel

	// Chat exists only on receivers that run one; the client is created either
	// way so the UI has something to read, and connects only when it does.
	chat *ChatClient

	// Audio shares the spectrum session's UUID but needs its own socket.
	audio    *AudioClient
	out      *AudioOutput
	deviceID string
	// deviceOff switches local playback off without touching the stream, so a
	// session can feed stdout alone.
	deviceOff bool
	// stdoutErr is why the raw stream is not running. It is kept here because
	// the panel covers the status line: a refusal reported there would be
	// invisible at exactly the moment the user asked for it.
	stdoutErr   error
	audioFailed bool // output could not be opened; do not retry automatically

	// wake lets background work (directory fetches, failed prechecks) ask for
	// a redraw without waiting on a keypress.
	wake chan struct{}

	// pickerHeld marks the mouse button as already down in the receiver picker,
	// so one physical click is one click however many reports it generates.
	pickerHeld bool

	// Drag state, captured on button press so panning stays anchored even as
	// the server echoes new centre frequencies mid-drag.
	dragging    bool
	dragStartX  int
	dragStartHz float64
	dragMoved   bool

	lastFrame time.Time
}

// openPicker shows the receiver chooser, kicking off a public directory fetch.
// mustChoose marks the case where there is no connection to fall back to, so
// cancelling should quit instead of leaving a blank screen.
func (e *eventLoop) openPicker(mustChoose bool) {
	p := NewPicker(e.local)
	p.mustChoose = mustChoose
	p.publicBusy = true
	e.picker = p

	go func() {
		list, err := FetchPublicInstances(e.rootCtx)
		p.public, p.publicErr, p.publicBusy = list, err, false
		// Nudge the loop so the list appears without waiting for a keypress.
		select {
		case e.wake <- struct{}{}:
		default:
		}
	}()
}

// connectTo tears down any existing connection and starts a new one. The
// /connection precheck runs on a background goroutine so a slow or unreachable
// receiver never freezes the UI.
func (e *eventLoop) connectTo(inst Instance) {
	if e.clientCancel != nil {
		e.clientCancel()
	}

	client, err := NewClient(inst.Host, inst.TLS, e.opts.password)
	if err != nil {
		e.ui.status = "cannot initialise client: " + err.Error()
		return
	}

	ctx, cancel := context.WithCancel(e.rootCtx)
	e.clientCancel = cancel
	e.client = client

	name := inst.Label()
	if name == "" {
		name = inst.Host
	}
	e.ui.serverName = name
	e.ui.Reset()
	// A chat panel belongs to the receiver it was opened on.
	e.chatPanel = nil
	e.ui.status = "connecting to " + inst.Host + "…"

	var initialBinBW float64
	if e.opts.initialSpan > 0 {
		// Bin count isn't known until the first config arrives, so assume the
		// common default; the server snaps and echoes back the real value.
		initialBinBW = e.opts.initialSpan / 1024
	}

	// Audio and chat ride the same session UUID on their own sockets, so the
	// server sees one user rather than three.
	audio := NewAudioClient(inst.Host, inst.TLS, e.opts.password, client.sessionID)
	e.audio = audio
	chat := NewChatClient(inst.Host, inst.TLS, client.sessionID)
	e.chat = chat

	go func() {
		// Ask what this receiver offers and where it wants a listener to start.
		// Failure is not fatal: each feature simply reports itself as absent,
		// and the view falls back to whatever the spectrum socket opens on.
		desc, descErr := client.FetchDescription()
		if descErr == nil {
			// Applied by the event loop rather than from here, so the UI is
			// only ever written from its own goroutine.
			select {
			case client.Info <- desc:
			default:
			}
		}

		// The receiver's default frequency is where the view opens too, unless
		// -freq said otherwise.
		initialFreq := e.opts.initialFreq
		if initialFreq <= 0 && descErr == nil {
			initialFreq, _ = desc.Defaults()
		}

		// The server requires this handshake before it will accept a spectrum
		// socket, and it carries the rejection reason when it declines.
		if err := client.CheckConnection(); err != nil {
			client.report("refused: " + err.Error())
			select {
			case e.wake <- struct{}{}:
			default:
			}
			return
		}
		go client.Run(ctx, initialFreq, initialBinBW)
		// The band plan and bookmarks come off the HTTP API, so they neither
		// wait for nor block the spectrum socket.
		go client.RunMarkers(ctx)

		// Chat connects on its own so the header can report who is in it
		// before anyone opens the panel. Joining is still explicit.
		chat.SetAvailable(desc.ChatEnabled)
		if desc.ChatEnabled {
			go chat.Run(ctx)
		}

		// Audio only starts once the user asks for it, so a spectrum-only
		// session costs the server nothing extra.
		<-ctx.Done()
	}()
}

// maybeStartAudio brings audio up as soon as there is a frequency to tune to.
// Audio is on by default — this is a receiver — so the only reasons to skip it
// are the -no-audio flag or a failure the user can retry with m.
func (e *eventLoop) maybeStartAudio() {
	if e.opts.noAudio || e.ui.audioOn || e.audioFailed || e.ui.vfo <= 0 {
		return
	}
	e.startAudio()
}

// startAudio opens the output device and the audio socket.
func (e *eventLoop) startAudio() {
	if e.audio == nil || e.ui.audioOn {
		return
	}
	if e.out == nil {
		e.out = NewAudioOutput()
	}

	// stdout first: it is the sink that decides whether a failed sound device
	// is fatal to the session or merely one output short.
	if e.opts.stdoutMode != StdoutOff && !e.out.StdoutOn() {
		if err := e.out.SetStdout(e.opts.stdoutMode); err != nil {
			e.stdoutErr = err
			e.ui.status = "stdout: " + err.Error()
		}
	}

	if e.deviceOff {
		e.audioFailed = false
	} else if err := e.out.Start(e.deviceID); err != nil {
		e.ui.status = "audio output: " + err.Error()
		// Remember the failure so a missing or busy device is not retried on
		// every config message; m clears this and tries again.
		e.audioFailed = true
		// With nothing to play through there is no reason to hold a channel
		// open — unless stdout is taking the audio, in which case the session
		// is fine and the speakers simply are not.
		if !e.out.StdoutOn() {
			return
		}
	} else {
		e.audioFailed = false
	}

	e.ui.audioOn = true
	e.ui.SyncSideband()
	e.audio.SetTuning(e.ui.vfo, e.ui.audioMode, e.ui.bwLow, e.ui.bwHigh)
	e.audio.SetSquelch(e.ui.squelch)
	e.out.SetChannel(e.ui.channel)
	e.out.SetVolume(e.ui.volume)
	e.out.SetMuted(e.ui.muted)

	go e.audio.Run(e.rootCtx)
	e.ui.status = "audio on"
}

// currentDeviceID is what the panel should show as selected: the chosen device,
// or the sentinel when local playback is switched off.
func (e *eventLoop) currentDeviceID() string {
	if e.deviceOff {
		return audioDeviceOff
	}
	return e.deviceID
}

// applyDeviceChoice switches local playback between off and a device, which is
// one control: the device list has "off" at its head.
func (e *eventLoop) applyDeviceChoice(id string) {
	if id == audioDeviceOff {
		e.deviceOff = true
		e.audioFailed = false
		if e.out != nil {
			e.out.StopDevice()
		}
		e.ui.status = "local playback off"
		return
	}

	e.deviceOff, e.deviceID = false, id
	if e.out == nil || !e.ui.audioOn {
		return
	}
	if err := e.out.Start(e.deviceID); err != nil {
		e.ui.status = "audio output: " + err.Error()
		return
	}
	e.audioFailed = false
	e.ui.status = "output device changed"
}

// cycleStdout steps the second output through off, raw PCM and WAV. It is
// independent of the sound device: either, both or neither may be running.
func (e *eventLoop) cycleStdout(dir int) {
	if e.out == nil {
		e.out = NewAudioOutput()
	}
	const modes = 3
	next := StdoutMode((int(e.out.StdoutMode()) + dir + modes) % modes)

	if err := e.out.SetStdout(next); err != nil {
		e.stdoutErr = err
		e.ui.status = "stdout: " + err.Error()
		return
	}
	e.opts.stdoutMode, e.stdoutErr = next, nil
	if next == StdoutOff {
		e.ui.status = "stdout off"
		return
	}
	e.ui.status = fmt.Sprintf("stdout: %s, %s %d Hz mono", next, stdoutFormat, stdoutSampleRate)
}

// stdoutState is what the panel shows for the second output: what it carries,
// and whatever went wrong with it.
func (e *eventLoop) stdoutState() (StdoutMode, error) {
	if e.out == nil {
		return StdoutOff, e.stdoutErr
	}
	// A write that failed describes the stream better than a refusal to open
	// one, so it wins.
	if _, _, err := e.out.StdoutStats(); err != nil {
		return e.out.StdoutMode(), err
	}
	return e.out.StdoutMode(), e.stdoutErr
}

// cycleDSP steps through off and each DSP insert the receiver offers. Off is
// first, so the cycle always starts from the default.
func (e *eventLoop) cycleDSP(dir int) {
	ui := e.ui
	if len(ui.dspFilters) == 0 {
		ui.status = "this receiver offers no server-side DSP"
		return
	}

	// Position 0 is off; 1..n are the filters.
	cur := 0
	for i, f := range ui.dspFilters {
		if f == ui.dspFilter {
			cur = i + 1
			break
		}
	}
	n := len(ui.dspFilters) + 1
	next := ((cur+dir)%n + n) % n

	if next == 0 {
		ui.dspFilter = ""
		ui.status = "noise reduction off"
	} else {
		ui.dspFilter = ui.dspFilters[next-1]
		ui.status = "noise reduction: " + dspName(ui.dspFilter)
	}
	if e.audio != nil {
		e.audio.SetDSP(ui.dspFilter)
	}
}

// adjustSquelch moves the threshold by delta dB. Stepping below the useful
// floor turns the gate off rather than leaving it at a value that can never
// fire, and stepping up from off starts at that floor.
func (e *eventLoop) adjustSquelch(delta int) {
	ui := e.ui
	switch {
	case ui.squelch <= 0 && delta > 0:
		ui.squelch = squelchMin
	case ui.squelch <= 0 && delta < 0:
		// Already off; nothing below it.
	default:
		ui.squelch += delta
		if ui.squelch < squelchMin {
			ui.squelch = 0 // off
		}
		if ui.squelch > squelchMax {
			ui.squelch = squelchMax
		}
	}
	e.applySquelch()
}

// applySquelch pushes the threshold to the server and reports it.
func (e *eventLoop) applySquelch() {
	ui := e.ui
	if ui.squelch <= 0 {
		ui.status = "squelch off"
	} else {
		ui.status = fmt.Sprintf("squelch %d dB SNR", ui.squelch)
	}
	// Assume the gate is open until the next silent frame says otherwise, so
	// the indicator does not stick from a previous threshold.
	ui.lastAudioAt = time.Now()
	if e.audio != nil {
		e.audio.SetSquelch(ui.squelch)
	}
}

// retune pushes the current VFO, mode and filter to the audio channel.
func (e *eventLoop) retune() {
	if e.audio == nil || !e.ui.audioOn {
		return
	}
	e.audio.Tune(e.ui.vfo, e.ui.audioMode, e.ui.bwLow, e.ui.bwHigh)
}

func (e *eventLoop) run(ctx context.Context, events <-chan tcell.Event) error {
	// Cap redraws so a fast server (or a burst after a stall) can't spend all
	// our time in the renderer.
	redraw := time.NewTicker(33 * time.Millisecond)
	defer redraw.Stop()

	// The session clock counts in seconds, and a stalled or disconnected
	// receiver sends nothing to redraw on — so the clock gets its own tick
	// rather than relying on the spectrum to keep it honest.
	clock := time.NewTicker(time.Second)
	defer clock.Stop()

	dirty := true
	for {
		// Channels are re-read each iteration because switching receivers
		// swaps the client. A nil channel simply never fires, which is exactly
		// what we want while the picker is open with no connection.
		var frames chan Frame
		var configs chan SpectrumConfig
		var status chan string
		var markers chan Markers
		if e.client != nil {
			frames, configs, status = e.client.Frames, e.client.Configs, e.client.Status
			markers = e.client.Markers
		}
		var info chan Description
		if e.client != nil {
			info = e.client.Info
		}
		var chatUpdates chan ChatState
		if e.chat != nil {
			chatUpdates = e.chat.Updates
		}
		var pcm chan []int16
		var level chan Signal
		var audioStatus chan string
		var dspStatus chan DSPState
		var silence chan bool
		if e.audio != nil && e.ui.audioOn {
			pcm, level, audioStatus = e.audio.PCM, e.audio.Level, e.audio.Status
			dspStatus, silence = e.audio.DSP, e.audio.Silence
		}

		select {
		case <-ctx.Done():
			return nil

		case <-e.wake:
			dirty = true

		case <-clock.C:
			if e.ui.connected {
				dirty = true
			}

		case <-e.local.Updates:
			dirty = true

		case ev, ok := <-events:
			if !ok {
				return nil
			}
			if quit := e.handleEvent(ev); quit {
				return nil
			}
			dirty = true

		case frame := <-frames:
			e.ui.SetFrame(frame.Bins, frame.Center, frame.Span)
			e.ui.connected = true
			now := time.Now()
			if !e.lastFrame.IsZero() {
				if dt := now.Sub(e.lastFrame).Seconds(); dt > 0 {
					inst := 1 / dt
					if e.ui.fps == 0 {
						e.ui.fps = inst
					} else {
						e.ui.fps += (inst - e.ui.fps) * 0.1
					}
				}
			}
			e.lastFrame = now
			dirty = true

		case cfg := <-configs:
			e.ui.cfg = cfg
			// Park the marker at the centre until the user moves it.
			if e.ui.vfo == 0 {
				e.ui.vfo = cfg.CenterFreq
				e.ui.SyncSideband()
			}
			// The first config is the earliest point at which there is a
			// frequency to tune audio to.
			e.maybeStartAudio()
			dirty = true

		case desc := <-info:
			e.applyDescription(desc)
			dirty = true

		case m := <-markers:
			e.ui.bands, e.ui.bookmarks = m.Bands, m.Bookmarks
			dirty = true

		case st := <-chatUpdates:
			e.noteChatUpdate(st)
			dirty = true

		case msg := <-status:
			e.ui.status = msg
			e.ui.connected = e.client != nil && e.client.Connected()
			dirty = true

		case samples := <-pcm:
			// Audio must keep flowing regardless of redraw pacing, so this
			// path never touches the renderer.
			if e.out != nil {
				e.out.Push(samples)
			}

		case sig := <-level:
			e.ui.signal = sig
			dirty = true

		case silent := <-silence:
			was := e.ui.Squelched()
			e.ui.NoteAudio(silent)
			if e.ui.Squelched() != was {
				dirty = true
			}

		case st := <-dspStatus:
			// The server is authoritative: it may refuse an insert when the
			// DSP is at its user limit, so follow what it reports.
			if st.Enabled {
				e.ui.dspFilter = st.Filter
			} else {
				e.ui.dspFilter = ""
			}
			dirty = true

		case msg := <-audioStatus:
			e.ui.audioStatus = msg
			e.ui.status = msg
			dirty = true

		case <-redraw.C:
			if dirty {
				e.ui.connected = e.client != nil && e.client.Connected()
				if e.client != nil {
					e.ui.sessionEnd, e.ui.sessionLimited = e.client.SessionDeadline()
				}
				// Publishing where this receiver is tuned is part of being in a
				// receiver's chat. The client itself decides what is worth
				// sending, so calling it per redraw is free until something
				// actually moves.
				if e.chat != nil {
					e.chat.SetRadio(e.ui.vfo, e.ui.audioMode, e.ui.bwLow, e.ui.bwHigh, e.ui.cfg.BinBandwidth)
				}
				e.draw()
				dirty = false
			}
		}
	}
}

// draw renders whichever surface is on top: the picker replaces the spectrum
// display entirely while it is open.
func (e *eventLoop) draw() {
	if e.picker != nil {
		e.screen.Clear()
		e.picker.Draw(e.screen)
		e.screen.Show()
		return
	}

	// Render the display and any overlay into the buffer, then present exactly
	// once. Presenting between the two would show a frame of the bare display
	// on every redraw, which looks like the overlay flickering.
	e.ui.render(e.screen)
	// Drawn over the live display so the spectrum keeps updating behind them.
	if e.audioPanel != nil {
		e.audioPanel.Draw(e.screen, e.ui, e.currentDeviceID())
	}
	if e.bookmarkPanel != nil {
		e.bookmarkPanel.Draw(e.screen, e.ui)
	}
	if e.chatPanel != nil {
		e.chatPanel.Draw(e.screen, e.ui)
	}
	e.screen.Show()
}

// setVFO moves the tuned frequency, applying the sideband convention and
// retuning the audio channel.
func (e *eventLoop) setVFO(freq float64) {
	e.ui.vfo = clampFreq(freq)
	// Tuning somewhere hands the sideband convention back: a mode that came
	// from the command line or the receiver's own default was chosen for the
	// frequency it came with, not for wherever the user goes next.
	e.ui.modePinned = false
	e.ui.SyncSideband()
	e.retune()
}

// tuneToBookmark takes the frequency, mode and filter from a bookmark.
//
// The mode is applied after the VFO has moved, and deliberately without
// SyncSideband: a bookmark states which sideband its station uses, and the
// 10 MHz convention must not overrule it — the web and Python clients skip the
// automatic switch for bookmarks for the same reason.
func (e *eventLoop) tuneToBookmark(bm Bookmark) {
	ui := e.ui
	ui.vfo = clampFreq(bm.Frequency)

	if _, ok := lookupMode(bm.Mode); ok {
		ui.ApplyMode(bm.Mode)
		// Holds against the convention until the user tunes away, including
		// when audio starts later and would otherwise re-apply it.
		ui.modePinned = true
		// A bookmark's own filter, when it carries one, beats the mode default.
		if bm.BandwidthLow != nil && bm.BandwidthHigh != nil {
			ui.bwLow, ui.bwHigh = clampBandwidth(ui.audioMode, *bm.BandwidthLow, *bm.BandwidthHigh)
		}
	}

	e.retune()
	ui.status = fmt.Sprintf("%s — %s MHz %s", bm.Name,
		formatFreq(ui.vfo, ui.cfg.TotalBandwidth), strings.ToUpper(ui.audioMode))

	// Bring the view along when the bookmark is off-screen, which it usually is
	// when it was chosen from the browser rather than clicked on the strip.
	// Same margin as stepVFO, so the marker never lands right on the edge.
	start, span := ui.viewRange()
	if span > 0 && (ui.vfo < start+span*0.05 || ui.vfo > start+span*0.95) {
		e.pan(clampCenter(ui.vfo, span))
	}
}

func (e *eventLoop) handleEvent(ev tcell.Event) (quit bool) {
	switch ev := ev.(type) {
	case *tcell.EventResize:
		// tcell has already updated its size; Sync repaints the whole screen
		// so no stale cells survive the reflow.
		e.screen.Sync()

	case *tcell.EventKey:
		if e.picker != nil {
			return e.handlePickerKey(ev)
		}
		if e.bookmarkPanel != nil {
			return e.handleBookmarkKey(ev)
		}
		if e.chatPanel != nil {
			return e.handleChatKey(ev)
		}
		if e.audioPanel != nil {
			return e.handleAudioPanelKey(ev)
		}
		return e.handleKey(ev)

	case *tcell.EventMouse:
		if e.picker != nil {
			// Same shape as the key handler: the picker decides, the loop acts.
			if choice := e.handlePickerMouse(ev); choice != nil {
				e.picker = nil
				e.connectTo(*choice)
			}
			return false
		}
		// The help overlay is a modal like the others: the wheel scrolls it
		// rather than reaching the radio underneath.
		if e.ui.showHelp {
			buttons := ev.Buttons()
			if buttons&tcell.WheelUp != 0 {
				e.ui.helpScroll -= 3
			}
			if buttons&tcell.WheelDown != 0 {
				e.ui.helpScroll += 3
			}
			return false
		}
		// A modal owns the screen it covers, so a click behind it must not
		// tune the radio.
		if e.bookmarkPanel == nil && e.chatPanel == nil {
			e.handleMouse(ev)
		}
	}
	return false
}

func (e *eventLoop) handleBookmarkKey(ev *tcell.EventKey) (quit bool) {
	bm, done := e.bookmarkPanel.HandleKey(ev, e.ui)
	if bm != nil {
		e.tuneToBookmark(*bm)
	}
	if done || bm != nil {
		e.bookmarkPanel = nil
	}
	return false
}

func (e *eventLoop) handleChatKey(ev *tcell.EventKey) (quit bool) {
	cmd, done := e.chatPanel.HandleKey(ev, e.ui)
	if e.chat != nil {
		switch {
		case cmd.join != "":
			e.chat.Join(cmd.join)
		case cmd.say != "":
			e.chat.Say(cmd.say)
		case cmd.leave:
			e.chat.Leave()
		}
	}
	if done {
		e.chatPanel = nil
	}
	return false
}

// applyDescription takes what a receiver says about itself: the DSP inserts it
// offers, and where its operator wants a listener to start.
//
// The starting point is advisory and loses to anything the user asked for on
// the command line, which is the order the Python client uses too: CLI, then
// the receiver's configuration, then the built-in fallback.
func (e *eventLoop) applyDescription(desc Description) {
	if desc.DSP.Enabled {
		e.ui.dspFilters = desc.DSP.Filters
	}

	freq, mode := desc.Defaults()
	if e.opts.initialMode != "" {
		mode = e.opts.initialMode
	}
	if e.opts.initialFreq > 0 {
		freq = e.opts.initialFreq
	}

	// Only for the receiver this session opened on: switching receivers keeps
	// the VFO where the user left it rather than jumping to the new one's
	// default, and a VFO the user has already moved is theirs.
	if e.ui.vfo <= 0 {
		e.ui.vfo = clampFreq(freq)
	}
	e.ui.ApplyMode(mode)
	// A filter named on the command line outlives the mode default that
	// ApplyMode just installed.
	if e.opts.haveBandwidth {
		e.ui.bwLow, e.ui.bwHigh = clampBandwidth(e.ui.audioMode, e.opts.bwLow, e.opts.bwHigh)
	}
	// The sideband convention must not overrule a mode that was asked for
	// before the user has tuned anywhere: a receiver whose default is USB on
	// 40 m means it. The first tune hands the convention back.
	e.ui.modePinned = true
	e.retune()
}

// noteChatUpdate adopts a fresh chat snapshot.
//
// Anything that arrived while the panel was shut is unread, and a message
// naming us earns an actual interruption: the status line says who it was from
// and the terminal bell rings once. Nothing interrupts while the panel is open,
// where the message is already on screen.
func (e *eventLoop) noteChatUpdate(st ChatState) {
	// Only a member has anything unread: a listener who never joined cannot be
	// addressed, and the header says so by showing the count alone.
	if !st.Joined {
		e.ui.chatUnread, e.ui.chatMention = 0, false
	}
	if e.chatPanel == nil && st.Joined {
		if n := st.Received - e.ui.chat.Received; n > 0 {
			e.ui.chatUnread += n
		}
		if st.Mentions > e.ui.chat.Mentions {
			e.ui.chatMention = true
			if line, ok := st.LastMention(); ok {
				e.ui.status = line.Username + " mentioned you in chat — C to open"
			}
			if e.screen != nil {
				e.screen.Beep()
			}
		}
	}
	e.ui.chat = st
}

// openChat shows the chat panel and clears the unread marks, since the messages
// are about to be on screen.
func (e *eventLoop) openChat() {
	if !e.ui.chat.Available {
		e.ui.status = "this receiver does not run a chat"
		return
	}
	e.chatPanel = NewChatPanel()
	e.ui.chatUnread, e.ui.chatMention = 0, false
}

func (e *eventLoop) handleAudioPanelKey(ev *tcell.EventKey) (quit bool) {
	retune, reopen, done := e.audioPanel.HandleKey(ev, e.ui, e.currentDeviceID())

	if step := e.audioPanel.dspStep; step != 0 {
		e.audioPanel.dspStep = 0
		e.cycleDSP(step)
	}
	if e.audioPanel.squelchChanged {
		e.audioPanel.squelchChanged = false
		e.applySquelch()
	}
	if step := e.audioPanel.stdoutStep; step != 0 {
		e.audioPanel.stdoutStep = 0
		e.cycleStdout(step)
	}

	if reopen && e.audioPanel.selectedDevice != e.currentDeviceID() {
		e.applyDeviceChoice(e.audioPanel.selectedDevice)
	}
	e.audioPanel.stdoutMode, e.audioPanel.stdoutErr = e.stdoutState()
	if e.out != nil {
		e.out.SetChannel(e.ui.channel)
		e.out.SetVolume(e.ui.volume)
		e.out.SetMuted(e.ui.muted)
	}
	if retune {
		e.retune()
	}
	if done {
		e.audioPanel = nil
	}
	return false
}

// handlePickerMouse works the receiver list with the mouse: the wheel scrolls
// it, the first click highlights an entry and a second click on the entry
// already highlighted connects to it.
//
// Two clicks rather than one, because connecting tears down the current session
// and opens another — too much to hang on a single stray click, and the same
// reason the keyboard asks for enter after the arrows.
func (e *eventLoop) handlePickerMouse(ev *tcell.EventMouse) *Instance {
	_, h := e.screen.Size()
	buttons := ev.Buttons()

	switch {
	case buttons&tcell.WheelUp != 0:
		e.picker.cursor--
		e.picker.clampCursor()
		return nil
	case buttons&tcell.WheelDown != 0:
		e.picker.cursor++
		e.picker.clampCursor()
		return nil
	}

	// Act on the press, once: a held button keeps reporting, and every report
	// would otherwise count as another click.
	if buttons&tcell.ButtonPrimary == 0 {
		e.pickerHeld = false
		return nil
	}
	if e.pickerHeld {
		return nil
	}
	e.pickerHeld = true

	_, y := ev.Position()
	idx, ok := e.picker.EntryAt(h, y)
	if !ok {
		return nil
	}
	if idx != e.picker.cursor {
		e.picker.cursor = idx
		return nil
	}

	list := e.picker.entries()
	if idx >= len(list) {
		return nil
	}
	return &list[idx]
}

func (e *eventLoop) handlePickerKey(ev *tcell.EventKey) (quit bool) {
	choice, done := e.picker.HandleKey(ev)
	if choice != nil {
		e.picker = nil
		e.connectTo(*choice)
		return false
	}
	if done {
		// Cancelling with nothing connected means there is nothing to return
		// to, so quit rather than showing an empty display.
		if e.picker.mustChoose || e.client == nil {
			e.cancel()
			return true
		}
		e.picker = nil
	}
	return false
}

func (e *eventLoop) handleKey(ev *tcell.EventKey) (quit bool) {
	ui := e.ui

	if ui.prompting {
		switch ev.Key() {
		case tcell.KeyEnter:
			e.commitPrompt()
		case tcell.KeyEscape:
			ui.prompting = false
			ui.promptBuf = ""
		case tcell.KeyBackspace, tcell.KeyBackspace2:
			if n := len(ui.promptBuf); n > 0 {
				ui.promptBuf = ui.promptBuf[:n-1]
			}
		case tcell.KeyCtrlC:
			e.cancel()
			return true
		case tcell.KeyRune:
			ui.promptBuf += string(ev.Rune())
		}
		return false
	}

	// Any key dismisses the help overlay, bar the ones that scroll it — see
	// handleHelpKey. Kept a separate function because the arrows mean something
	// else while it is up, and a mode that reuses keys does not belong in the
	// switch below.
	if ui.showHelp {
		return e.handleHelpKey(ev)
	}

	switch ev.Key() {
	case tcell.KeyCtrlC, tcell.KeyEscape:
		e.cancel()
		return true

	case tcell.KeyLeft:
		// Shift gives a fine step. The filter keys used to double as fine pan,
		// which collided once audio arrived and needed them.
		if ev.Modifiers()&tcell.ModShift != 0 {
			e.panBy(-0.01)
		} else {
			e.panBy(-0.10)
		}
	case tcell.KeyRight:
		if ev.Modifiers()&tcell.ModShift != 0 {
			e.panBy(0.01)
		} else {
			e.panBy(0.10)
		}
	// Up/down tune, as on a radio. Zoom keeps +/-, which already covered it, so
	// nothing is lost by giving the arrows to the VFO.
	case tcell.KeyUp:
		e.stepVFO(+1)
	case tcell.KeyDown:
		e.stepVFO(-1)
	case tcell.KeyPgUp:
		e.stepVFO(+10)
	case tcell.KeyPgDn:
		e.stepVFO(-10)

	case tcell.KeyRune:
		switch ev.Rune() {
		case 'q', 'Q':
			e.cancel()
			return true
		case 'f', 'F':
			ui.prompting = true
			ui.promptBuf = ""
		case '+', '=':
			e.zoomStep(-1, 0)
		case '-', '_':
			e.zoomStep(+1, 0)
		case '0':
			if e.client != nil {
				e.client.Reset()
			}
			ui.status = "reset to full span"
		case 'p', 'P':
			ui.showPeaks = !ui.showPeaks
			ui.peaks = nil
			ui.status = fmt.Sprintf("peak hold %s", onOff(ui.showPeaks))
		case 'b':
			e.bookmarkPanel = NewBookmarkPanel()
		case 'B':
			// The trace style moved to shift so that b, the obvious key for
			// bookmarks, could have it.
			ui.braille = !ui.braille
			ui.status = fmt.Sprintf("style: %s", styleName(ui.braille))
		case 'c':
			if ui.vfo > 0 {
				e.pan(clampFreq(ui.vfo))
				ui.status = "centred on VFO"
			}
		case 'C':
			e.openChat()
		case 'v', 'V':
			ui.mode = (ui.mode + 1) % 3
			ui.status = "view: " + ui.mode.String()
		case 'i', 'I':
			e.openPicker(false)

		case 'm':
			if !ui.audioOn {
				// Audio normally comes up by itself; getting here means it was
				// turned off or the device could not be opened, so retry.
				ui.muted = false
				e.audioFailed = false
				e.startAudio()
			} else {
				ui.muted = !ui.muted
				if e.out != nil {
					e.out.SetMuted(ui.muted)
				}
				ui.status = map[bool]string{true: "muted", false: "unmuted"}[ui.muted]
			}
		case 'M':
			e.cycleAudioMode()
		case 'A':
			ui.autoSideband = !ui.autoSideband
			if ui.autoSideband {
				ui.SyncSideband()
				e.retune()
			}
			ui.status = fmt.Sprintf("auto sideband %s", onOff(ui.autoSideband))
		case 'd', 'D':
			// Enumerate on open rather than at startup, so devices plugged in
			// mid-session appear.
			devices, err := listDevices()
			e.audioPanel = NewAudioPanel(devices, err)
			e.audioPanel.selectedDevice = e.currentDeviceID()
			e.audioPanel.stdoutMode, e.audioPanel.stdoutErr = e.stdoutState()
		case 'n', 'N':
			e.cycleDSP(+1)
		case 't':
			e.adjustSquelch(+1)
		case 'T':
			e.adjustSquelch(-1)
		case 'g', 'G':
			ui.meterSNR = !ui.meterSNR
			ui.status = "meter: " + meterModeName(ui.meterSNR)
		case 'x', 'X':
			ui.channel = Channel((int(ui.channel) + 1) % 3)
			if e.out != nil {
				e.out.SetChannel(ui.channel)
			}
			ui.status = "audio channel: " + ui.channel.String()
		case 'w', 'W':
			ui.wheelTunes = !ui.wheelTunes
			if ui.wheelTunes {
				ui.status = "wheel tunes the VFO (" + formatStep(ui.StepHz()) + " steps)"
			} else {
				ui.status = "wheel zooms"
			}
		case 'z', 'Z':
			ui.zoomOnVFO = !ui.zoomOnVFO
			if ui.zoomOnVFO {
				ui.status = "zoom holds the dial"
			} else {
				ui.status = "zoom holds the centre"
			}
		case 's':
			ui.stepIdx = (ui.stepIdx + 1) % len(tuningSteps)
			ui.status = "step " + formatStep(ui.StepHz())
		case 'S':
			ui.stepIdx = (ui.stepIdx + len(tuningSteps) - 1) % len(tuningSteps)
			ui.status = "step " + formatStep(ui.StepHz())
		case 'a':
			ui.autoScale = !ui.autoScale
			if ui.autoScale {
				ui.status = "auto scaling"
			} else {
				ui.status = fmt.Sprintf("manual scale %.0f … %.0f dB", ui.minDB, ui.maxDB)
			}
		case '[':
			ui.AdjustScale(-5, 0)
		case ']':
			ui.AdjustScale(5, 0)
		case '{':
			ui.AdjustScale(0, -5)
		case '}':
			ui.AdjustScale(0, 5)
		case '<':
			ui.splitRatio = math.Max(0.15, ui.splitRatio-0.05)
		case '>':
			ui.splitRatio = math.Min(0.85, ui.splitRatio+0.05)
		case '?', 'h', 'H':
			ui.showHelp = true
			// From the top, so the second look at the keys starts where the
			// first one did rather than wherever it was left.
			ui.helpScroll = 0
		case ',':
			ui.AdjustBandwidth(-100)
			ui.status = fmt.Sprintf("filter %+d/%+d Hz", ui.bwLow, ui.bwHigh)
			e.retune()
		case '.':
			ui.AdjustBandwidth(+100)
			ui.status = fmt.Sprintf("filter %+d/%+d Hz", ui.bwLow, ui.bwHigh)
			e.retune()
		}
	}
	return false
}

// cycleAudioMode steps to the next demodulation mode. Shared by the M key and
// by a click on the mode in the header, so the two cannot drift apart.
func (e *eventLoop) cycleAudioMode() {
	ui := e.ui
	idx := (modeIndex(ui.audioMode) + 1) % len(modes)
	ui.ApplyMode(modes[idx].Name)
	// Choosing a mode by hand means the 10 MHz convention should stop
	// overriding it, unless the choice is itself a sideband.
	ui.status = "mode " + strings.ToUpper(ui.audioMode)
	e.retune()
}

// handleHelpKey drives the help overlay while it is up. Returns whether the
// loop should stop, like handleKey.
//
// The overlay scrolls because it is taller than most terminals — over fifty
// lines of keys — and the bottom of it was otherwise unreachable: the box was
// clipped at the screen edge with nothing to say that there was more.
//
// Only the scrolling keys are taken. Every other key still dismisses it, so it
// cannot trap somebody who does not know which those are, and q still quits.
// The page and end keys ask for more than they can know is there: drawHelp
// clamps whatever lands in helpScroll against the box it actually drew, which
// is also why helpViewport is only a hint here — it is zero until the first
// frame, and a page falls back to one line.
func (e *eventLoop) handleHelpKey(ev *tcell.EventKey) bool {
	ui := e.ui
	page := ui.helpViewport - 1
	if page < 1 {
		page = 1
	}

	switch ev.Key() {
	case tcell.KeyUp:
		ui.helpScroll--
		return false
	case tcell.KeyDown:
		ui.helpScroll++
		return false
	case tcell.KeyPgUp:
		ui.helpScroll -= page
		return false
	case tcell.KeyPgDn:
		ui.helpScroll += page
		return false
	case tcell.KeyHome:
		ui.helpScroll = 0
		return false
	case tcell.KeyEnd:
		// Past the end on purpose: drawHelp pulls it back to the last page.
		ui.helpScroll = len(helpLines)
		return false
	case tcell.KeyRune:
		switch ev.Rune() {
		case 'k':
			ui.helpScroll--
			return false
		case 'j':
			ui.helpScroll++
			return false
		}
	}

	ui.showHelp = false
	if ev.Key() == tcell.KeyRune && (ev.Rune() == 'q' || ev.Rune() == 'Q') {
		e.cancel()
		return true
	}
	return false
}

func (e *eventLoop) handleMouse(ev *tcell.EventMouse) {
	ui := e.ui
	w, h := e.screen.Size()
	l := computeLayout(w, h, ui.mode, ui.splitRatio, ui.markerRows())
	x, y := ev.Position()
	buttons := ev.Buttons()

	// Track the pointer for the crosshair readout regardless of buttons.
	if x >= l.PlotX && y >= l.BodyY && y < l.AxisY {
		ui.cursorX, ui.cursorY = x, y
	} else {
		ui.cursorX, ui.cursorY = -1, -1
	}

	// The wheel either zooms about the cursor — keeping the signal under the
	// pointer fixed — or steps the VFO, depending on the mode.
	if buttons&tcell.WheelUp != 0 {
		if ui.wheelTunes {
			e.stepVFO(1)
		} else {
			e.zoomStep(-1, ui.FreqAt(l, x))
		}
		return
	}
	if buttons&tcell.WheelDown != 0 {
		if ui.wheelTunes {
			e.stepVFO(-1)
		} else {
			e.zoomStep(+1, ui.FreqAt(l, x))
		}
		return
	}

	// Both panes accept click and drag, so the whole body is interactive.
	inPlot := y >= l.BodyY && y < l.AxisY && x >= l.PlotX

	if buttons&tcell.ButtonPrimary != 0 {
		if !e.dragging {
			// The header fields that carry a setting act as buttons for it,
			// which is how somebody finds the key without reading the help.
			if what, ok := ui.HeaderAt(x, y); ok {
				switch what {
				case headerVFO:
					ui.prompting = true
					ui.promptBuf = ""
				case headerMode:
					e.cycleAudioMode()
				}
				return
			}
			// Clicking the signal meter switches its scale, which is the
			// discoverable way to find the g key.
			if ui.MeterHit(l, x, y) {
				ui.meterSNR = !ui.meterSNR
				ui.status = "meter: " + meterModeName(ui.meterSNR)
				return
			}
			// A bookmark label is a tuning target, as in the other clients.
			if bm, ok := ui.BookmarkAt(l, x, y); ok {
				e.tuneToBookmark(bm)
				return
			}
			if !inPlot {
				return
			}
			e.dragging = true
			e.dragStartX = x
			e.dragStartHz = ui.cfg.CenterFreq
			e.dragMoved = false
			return
		}

		// Held and moved — pan relative to where the press landed.
		if x != e.dragStartX {
			e.dragMoved = true
			_, span := ui.viewRange()
			if span > 0 {
				hzPerCol := span / float64(l.PlotW)
				newCenter := e.dragStartHz - float64(x-e.dragStartX)*hzPerCol
				e.pan(clampCenter(newCenter, span))
			}
		}
		return
	}

	// Button released: a press that never moved is a click-to-tune.
	if e.dragging {
		if !e.dragMoved && inPlot {
			// Snap to the tuning step: one character cell can span many kHz at
			// a wide span, so the raw click frequency is far more precise than
			// the pointing was. Snapping lands on channel boundaries instead of
			// an arbitrary offset.
			e.setVFO(ui.snapToStep(ui.FreqAt(l, x)))
			ui.status = fmt.Sprintf("VFO %s MHz", formatFreq(ui.vfo, ui.cfg.TotalBandwidth))
		}
		e.dragging = false
	}
}

// pan and zoom funnel every view command through a single nil check, so a
// keypress arriving with no live connection is ignored rather than panicking.
func (e *eventLoop) pan(freq float64) {
	if e.client != nil {
		e.client.Pan(freq)
	}
}

func (e *eventLoop) zoom(freq, span float64) {
	if e.client != nil {
		e.client.Zoom(freq, span)
	}
}

// stepVFO moves the VFO by `steps` tuning increments, snapped to the step grid,
// and pans the view only when the VFO would otherwise leave the screen. Callers
// pass a larger multiple for coarse tuning.
func (e *eventLoop) stepVFO(steps int) {
	ui := e.ui
	step := ui.StepHz()
	if ui.vfo == 0 {
		ui.vfo = ui.cfg.CenterFreq
	}

	target := ui.vfo + float64(steps)*step
	e.setVFO(math.Round(target/step) * step)
	ui.status = fmt.Sprintf("VFO %.6f MHz", ui.vfo/1e6)

	start, span := ui.viewRange()
	if span <= 0 || e.client == nil {
		return
	}
	// Keep a small margin so the marker doesn't sit right on the edge.
	margin := span * 0.05
	if ui.vfo < start+margin || ui.vfo > start+span-margin {
		e.pan(clampCenter(ui.vfo, span))
	}
}

func (e *eventLoop) panBy(fraction float64) {
	_, span := e.ui.viewRange()
	if span <= 0 {
		return
	}
	e.pan(clampCenter(e.ui.cfg.CenterFreq+span*fraction, span))
}

// serverBinBWLadder mirrors the rounding ladder in user_spectrum_websocket.go.
// The server snaps every requested bin bandwidth to one of these rungs.
//
// Zooming by multiplying the span by an arbitrary factor does not work against
// that: the request can land in a bucket that rounds back to the rung it came
// from, which pins the view. 2000 Hz/bin is the trap — a x1.5 step asks for
// 3000, and the server's `< 3500` rule rounds it straight back to 2000, so the
// span never changes while the centre keeps moving. Stepping rung to rung
// guarantees each zoom actually changes the span.
var serverBinBWLadder = []float64{
	0.5, 1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000,
}

// zoomRungs returns the selectable bin bandwidths, widest last. Above
// 5000 Hz/bin the server passes values through unrounded, so the ladder is
// extended by doubling up to the receiver's full-span bin bandwidth, which
// becomes the zoom-out limit.
func zoomRungs(defaultBinBW float64) []float64 {
	rungs := append([]float64(nil), serverBinBWLadder...)
	if defaultBinBW <= rungs[len(rungs)-1] {
		return rungs
	}
	for v := rungs[len(rungs)-1] * 2; v < defaultBinBW; v *= 2 {
		rungs = append(rungs, v)
	}
	return append(rungs, defaultBinBW)
}

// nextRung steps one place along the ladder from whichever rung is closest to
// the current bin bandwidth. direction is -1 to zoom in, +1 to zoom out.
func nextRung(rungs []float64, current float64, direction int) (float64, bool) {
	idx, best := 0, math.Inf(1)
	for i, r := range rungs {
		if d := math.Abs(r - current); d < best {
			best, idx = d, i
		}
	}
	next := idx + direction
	if next < 0 || next >= len(rungs) {
		return 0, false
	}
	return rungs[next], true
}

// zoomStep moves one rung along the server's zoom ladder. direction is -1 to
// zoom in and +1 to zoom out. anchor is the frequency to hold still, or 0 for
// the keyboard, which has no pointer to hold anything with — see zoomCentre.
func (e *eventLoop) zoomStep(direction int, anchor float64) {
	cfg := e.ui.cfg
	if cfg.BinCount <= 0 || cfg.BinBandwidth <= 0 || cfg.TotalBandwidth <= 0 {
		return
	}

	fullBinBW := cfg.DefaultBinBandwidth
	if fullBinBW <= 0 {
		fullBinBW = cfg.BinBandwidth
	}

	newBinBW, ok := nextRung(zoomRungs(fullBinBW), cfg.BinBandwidth, direction)
	if !ok {
		if direction < 0 {
			e.ui.status = "maximum zoom"
		} else {
			e.ui.status = "full span"
		}
		return
	}

	newSpan := newBinBW * float64(cfg.BinCount)
	if newSpan < minSpan {
		e.ui.status = "maximum zoom"
		return
	}
	if newSpan > maxSpan {
		newSpan = maxSpan
	}

	e.zoom(clampCenter(e.ui.zoomCentre(direction, anchor, newSpan), newSpan), newSpan)
}

// zoomCentre is where a zoom step lands the middle of the view.
//
// Zooming in keeps `anchor` at the same screen position, so pointing the mouse
// at a signal and zooming dives into it. Zooming out instead holds the centre,
// so the view widens symmetrically and converges on the full 0-30 MHz span —
// anchoring a zoom-out to an off-centre cursor would slide the view sideways
// instead of revealing more spectrum.
//
// The keyboard has no pointer, so it passes anchor 0 and gets whichever the `z`
// toggle selects: the view centre, which is how + and - have always behaved, or
// the dial. The dial is held on the way out as well as in — that it stays put
// is the whole point of the toggle, and it is a frequency the operator chose
// rather than wherever the mouse was left, so it does not slide the view the
// way an arbitrary cursor position would.
//
// A dial outside the current view is centred on rather than held: holding keeps
// the anchor at a fixed fraction across the screen, and a fraction outside 0..1
// stays outside it, so the one thing the toggle promises — that zooming closes
// in on what the radio is listening to — would never happen. Panning away and
// then zooming brings the dial back instead of magnifying empty spectrum.
func (u *UI) zoomCentre(direction int, anchor, newSpan float64) float64 {
	cfg := u.cfg
	if cfg.TotalBandwidth <= 0 {
		return cfg.CenterFreq
	}

	dial := false
	if anchor <= 0 && u.zoomOnVFO && u.vfo > 0 {
		anchor, dial = u.vfo, true
	}
	if anchor <= 0 {
		anchor = cfg.CenterFreq
	}

	if direction > 0 && !dial {
		return cfg.CenterFreq
	}

	if dial {
		start, span := u.viewRange()
		if anchor < start || anchor > start+span {
			return anchor
		}
	}

	return anchor - (anchor-cfg.CenterFreq)*(newSpan/cfg.TotalBandwidth)
}

func (e *eventLoop) commitPrompt() {
	ui := e.ui
	text := strings.TrimSpace(ui.promptBuf)
	ui.prompting = false
	ui.promptBuf = ""
	if text == "" {
		return
	}

	hz, err := parseFrequency(text)
	if err != nil {
		ui.status = err.Error()
		return
	}
	if hz < minFreq || hz > maxFreq {
		ui.status = fmt.Sprintf("%.3f MHz is outside 0.01–30 MHz", hz/1e6)
		return
	}

	e.setVFO(hz)
	_, span := ui.viewRange()
	if span <= 0 {
		span = minSpan
	}
	e.pan(clampCenter(hz, span))
	ui.status = fmt.Sprintf("tuned %.6f MHz", hz/1e6)
}

// parseFrequency reads a user-typed frequency. A bare number is kHz (the
// convention on this band plan); an M/k/Hz suffix overrides that.
func parseFrequency(text string) (float64, error) {
	s := strings.ToLower(strings.ReplaceAll(text, ",", ""))
	s = strings.TrimSpace(s)

	multiplier := 1000.0 // bare numbers are kHz
	switch {
	case strings.HasSuffix(s, "mhz"):
		s, multiplier = strings.TrimSuffix(s, "mhz"), 1e6
	case strings.HasSuffix(s, "khz"):
		s, multiplier = strings.TrimSuffix(s, "khz"), 1e3
	case strings.HasSuffix(s, "hz"):
		s, multiplier = strings.TrimSuffix(s, "hz"), 1
	case strings.HasSuffix(s, "m"):
		s, multiplier = strings.TrimSuffix(s, "m"), 1e6
	case strings.HasSuffix(s, "k"):
		s, multiplier = strings.TrimSuffix(s, "k"), 1e3
	}

	value, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, fmt.Errorf("cannot parse %q as a frequency", text)
	}
	return value * multiplier, nil
}

// clampCenter keeps the whole view inside the receiver's 10 kHz–30 MHz range.
//
// When the span is too wide to fit inside that range at all — which is exactly
// the fully-zoomed-out case — there is no centre that satisfies both edges, so
// the view is centred on the middle of the receiver's range. Clamping the
// centre instead would leave the full-span view lopsided, showing negative
// frequencies on the left and stopping short of 30 MHz on the right.
func clampCenter(center, span float64) float64 {
	half := span / 2
	lo, hi := minFreq+half, maxFreq-half
	if lo > hi {
		return (minFreq + maxFreq) / 2
	}
	return math.Max(lo, math.Min(hi, center))
}

func clampFreq(f float64) float64 {
	return math.Max(minFreq, math.Min(maxFreq, f))
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func styleName(braille bool) string {
	if braille {
		return "braille (2x resolution)"
	}
	return "filled bars"
}

// version is overridden at build time via -ldflags "-X main.version=…".
var version = "dev"
