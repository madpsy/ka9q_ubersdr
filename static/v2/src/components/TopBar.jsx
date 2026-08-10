import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { useRadio, useMeters } from '../radio/RadioContext.jsx';
import { useDisplay, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '../display/DisplayContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { Button, Icon, Slider } from './ui.jsx';
import LinksMenu from './LinksMenu.jsx';
import ShareMenu from './ShareMenu.jsx';
import { clockHint, nextClockMode, saveClockMode, savedClockMode } from '../lib/topClock.js';
import ThemeMenu from './ThemeMenu.jsx';
import {
    audioLevelColour, audioLevelPercent, formatFilterWidth, formatHz, sMeterColour,
    snrColour, snrFraction, sUnitFraction, sUnitLabel,
} from '../lib/format.js';
import {
    FILTER_WIDTH_MIN, FILTER_WIDTH_STEP, MODES, MODE_BY_ID,
    edgesForWidth, maxFilterWidth,
} from '../radio/constants.js';
import FreqEntry from './FreqEntry.jsx';
import Popover from './Popover.jsx';
import SpectrumMenu from './SpectrumMenu.jsx';
import { getSessionId } from '../radio/session.js';
import { openCallsignLookup } from '../compat/legacyBridge.js';
import { requestLookup } from '../lib/callsign.js';
import { onFreqEntry } from '../lib/freqEntry.js';
import { HOVER_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { useRoomFor } from '../lib/useRoomFor.js';
import { useFitScale } from '../lib/useFitScale.js';
import { gradeTone, subscribeSpaceWeather } from '../lib/spaceWeather.js';

// Widths to assume until each has been on screen once to measure. The order
// they are dropped in is the keep order passed to useRoomFor below, not the
// order they are declared here.
//
// "Unlimited" is the widest the countdown gets. The space weather block is five
// readings and a border.
const SESSION_W = 68;
const SPACE_WEATHER_W = 210;
const CLOCK_W = 96;
// "12.00k" a shade under the frequency's size, and a space.
const FILTER_W = 52;
// The volume slider without its mute button: the track, and the gap that
// separates the two. What is left when it goes is the button, which is a control
// of its own rather than a stump — see VolumeSlider.
const VOLUME_W = 124;

// UTC over receiver-local time, the pair v1 shows bottom-left. "Local" is the
// receiver's wall clock, not the browser's: timezone_offset is the server's
// DST-adjusted offset in minutes, so shifting the UTC epoch by it and reading
// the UTC fields back gives the operator's time wherever you are listening
// from. Until /api/description answers we fall back to the browser clock.
function Clock({ tzOffset }) {
    const [now, setNow] = useState(() => Date.now());
    // Both, UTC alone, or local alone — see lib/topClock.js for why three. Remembered,
    // because which clock somebody wants is about how they operate rather than what they
    // are doing this minute.
    const [mode, setMode] = useState(savedClockMode);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);

    const utc = new Date(now).toISOString().slice(11, 19);
    const local = typeof tzOffset === 'number'
        ? new Date(now + tzOffset * 60000).toISOString().slice(11, 19)
        : new Date(now).toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });

    const both = mode === 'both';
    const lines = both
        ? [[utc, 'UTC'], [local, 'Local']]
        : [mode === 'utc' ? [utc, 'UTC'] : [local, 'Local']];

    return (
        // A button because it does something, and the clock is the whole of the control:
        // a separate toggle beside it would be a second thing in a row that is already
        // the scarcest space in the interface.
        <button
            type="button"
            className={`topbar__clock${both ? '' : ' is-single'}`}
            data-optional="clock"
            title={clockHint(mode)}
            onClick={() => setMode((m) => saveClockMode(nextClockMode(m)))}
        >
            {lines.map(([time, tag]) => (
                <span className="topbar__clock-line" key={tag}>
                    <span className="topbar__clock-time">{time}</span>
                    <span className="topbar__clock-tag">{tag}</span>
                </span>
            ))}
        </button>
    );
}

// Same compact summary v1 pins to the bottom-right corner: solar flux, K, A,
// solar wind Bz and the derived propagation quality, refreshed every minute.
// /api/spaceweather is only meaningful when the operator enabled the monitor,
// so the caller mounts this on serverInfo.space_weather.
//
// Clicking it opens the Space weather panel, which is the same reply in full.
// The poll behind both lives in lib/spaceWeather.js — one request serves the
// summary and the panel, and the grade is coloured by the shared rule so the
// two can never call the same reading different things.
function SpaceWeather() {
    const { revealPanel } = useLayout();
    const [sw, setSw] = useState(null);

    useEffect(() => subscribeSpaceWeather((state) => setSw(state.data)), []);

    if (!sw) return null;

    const flux = sw.solar_flux != null ? Math.round(sw.solar_flux) : '--';
    const k = sw.k_index != null ? sw.k_index : '--';
    const a = sw.a_index != null ? sw.a_index : '--';
    const bz = sw.solar_wind_bz != null ? sw.solar_wind_bz.toFixed(1) : '--';
    const quality = sw.propagation_quality || '--';

    const tip = [
        `Solar Flux: ${flux} SFU`,
        `K-Index: ${k} (${sw.k_index_status || 'Unknown'})`,
        `A-Index: ${a}`,
        `Solar Wind Bz: ${bz} nT`,
        `Propagation Quality: ${quality}`,
        '\nClick for the full space weather panel',
    ].join('\n');

    // Reveal, then bring it into view: the panel is collapsed by default and
    // its dock scrolls, so opening it is no use if it opened below the fold.
    // The scroll waits a frame for the section to have been laid out.
    const open = () => {
        revealPanel('spaceweather');
        requestAnimationFrame(() => {
            const el = document.querySelector('[data-panel="spaceweather"]');
            if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
    };

    return (
        <div
            className="topbar__sw is-clickable"
            data-optional="spaceWeather"
            title={tip}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
        >
            <span>S:{flux}</span>
            <span>K:{k}</span>
            <span>A:{a}</span>
            <span>W:{bz}</span>
            <span className={`topbar__sw-p is-${gradeTone(quality)}`}>P:{quality}</span>
        </div>
    );
}

// Volume, and the output level it produces, as one control.
//
// Measured after the volume control (meters.outLevel), so it answers the
// question the slider raises — is anything actually coming out, and how hard —
// rather than reporting the stream regardless of where the slider is. Muting
// takes it to nothing, which is the point: a silent receiver and a silent band
// look the same until something says which.
//
// This was a slider with a separate VU bar underneath it, and the meter is now
// the slider itself: the filled part of the track rides with the output level
// and takes v1's VU colours as it goes, while the thumb stays where the volume
// is set. One bar says both — what you asked for, and what is coming out.
// Nothing sits under it and nothing has to be lined up by eye, and muting dims
// the two together for free because there is only one element and it is the
// disabled input.
//
// Sampled in its own component so the rest of the bar — the frequency, the
// clock — does not re-render with it, and fast enough to look like a meter: the
// fill is a gradient stop, which cannot be transitioned, so the sample rate is
// all the smoothing there is.
/**
 * Mute, and how loud.
 *
 * `slider` is whether the bar still has room for the fader. It is the one thing
 * in this row that degrades rather than disappearing: what is left is the mute
 * button, which is a complete control in its own right — the commonest thing
 * anybody does to the volume is silence it — and the level itself is still on
 * the Audio panel. Everything else the bar drops is all-or-nothing, which is why
 * this is a prop here rather than another entry rendered conditionally above.
 */
function VolumeSlider({ slider }) {
    const { audio, actions } = useRadio();
    // Ten a second, not the twenty-four this had.
    //
    // The fill is an output *level*, not a waveform: it is read as "is anything
    // coming out, and how hard", and that question is answered as well at 10 Hz
    // as at 24. What the extra fourteen bought was a repaint — the fill is a
    // gradient on the track, so every sample is a paint — and a repaint here is
    // charged against the whole strip. See the note on .topbar.
    const m = useMeters(10);

    // Unmuting with no fader on screen turns it up.
    //
    // Muted at 5% is a state you can see your way out of while the slider is
    // there and cannot while it is not: the button says "unmute", you press it,
    // and the receiver stays as silent as it was with nothing in the bar to say
    // why. So where the bar has dropped the fader, unmute means what somebody
    // pressing it in that state wants it to mean — audible — and the Audio panel
    // is where a quieter setting can be dialled back in.
    //
    // Only on the way out of mute, and only when the level is low enough to be
    // the problem: unmuting to something already audible must not overwrite a
    // level that was deliberately set while the fader was still on screen.
    const QUIET = 0.2;
    const toggleMute = () => {
        if (!slider && audio.muted && audio.volume < QUIET) actions.setVolume(1);
        actions.toggleMute();
    };

    return (
        // `is-ducked` is not `muted`: something else has silenced the audio for
        // a moment — a transmitting rig, an extension speaking — and the mute
        // setting is untouched. Without saying so, the audio stops while this
        // control sits there looking perfectly normal.
        <div className={`topbar__volume${audio.ducked ? ' is-ducked' : ''}`}>
            <Button
                variant="ghost"
                size="sm"
                icon={audio.muted || audio.ducked ? <Icon.Mute /> : <Icon.Volume />}
                onClick={toggleMute}
                active={audio.muted}
                title={audio.ducked
                    ? 'Silenced while the radio is transmitting — your mute is unchanged'
                    : (audio.muted
                        ? `Unmute${!slider && audio.volume < QUIET ? ' — the level is very low, so this turns it up' : ''}`
                        : 'Mute')}
            />
            {/* Disabled rather than hidden while muted: the level is still what
                you will hear when you unmute, and a control that vanishes takes
                the reading with it.

                The span is what useRoomFor measures and what it removes — the
                slider is a nested optional child, discounted from this box's
                own width, which is why the box has no fixed width of its own.
                See lib/roomFor.js. */}
            {slider && (
                <span className="topbar__vol-slider" data-optional="volume">
                    <Slider
                        value={Math.round(audio.volume * 100)}
                        min={0}
                        max={100}
                        disabled={audio.muted}
                        onChange={(v) => actions.setVolume(v / 100)}
                        level={audioLevelPercent(m.outLevel) / 100}
                        fillColor={audioLevelColour(audioLevelPercent(m.outLevel), m.clipping)}
                    />
                </span>
            )}
        </div>
    );
}

// Session countdown, the line v1 keeps bottom-left. `max_session_time` comes
// from the /connection reply: 0 means unlimited, anything else is the number of
// seconds this session may run, counted from when it started. Under five
// minutes it turns red, as v1 does.
function SessionClock() {
    const { session } = useRadio();
    const [, tick] = useState(0);

    useEffect(() => {
        if (session.maxSec == null || session.maxSec === 0) return undefined;
        const id = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [session.maxSec, session.startedAt]);

    if (session.maxSec == null) return null;

    if (session.maxSec === 0) {
        return <span className="topbar__session" data-optional="session" title="Session time">Unlimited</span>;
    }

    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
    const left = Math.max(0, session.maxSec - elapsed);
    const hh = String(Math.floor(left / 3600)).padStart(2, '0');
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');

    return (
        <span
            className={`topbar__session${left < 300 ? ' is-low' : ''}`}
            data-optional="session"
            title="Time left in this session"
        >
            {hh}:{mm}:{ss}
        </span>
    );
}

// The bar in the middle of the top bar, showing one reading at a time.
//
// Clicking it swaps which — the S-meter, or the SNR. Both were shown at once
// before, the S value one side of the bar and the SNR the other, which read as
// one measurement with two numbers attached rather than two measurements
// sharing a bar. Only one of them can be what the bar is drawing.
//
// The colour is the Signal panel's, not a gradient painted across the track.
// The track gradient ran green to red left to right, so a strong signal was
// coloured as a problem and the same reading was green up here and red down
// there. sMeterColour and snrColour are the ramps that panel uses — red at the
// bottom of the useful range through yellow to green — so a glance at either
// place says the same thing about the same signal.
//
// The mode is a display setting like the panel's bar/needle choice, so it
// survives a reload rather than resetting every time the tab is opened.
function TopMeter({ meters }) {
    const display = useDisplay();
    const snrMode = display.topMeter === 'snr';
    const power = meters.basebandPower;
    const snr = meters.snr;

    const fraction = snrMode ? snrFraction(snr) : sUnitFraction(power);
    const colour = snrMode ? snrColour(snr) : sMeterColour(power);
    // The S reading stays put whichever way the bar is set. It is the one
    // number an operator glances at without reading it, and swapping it for the
    // word "SNR" took that away to say something the value beside it already
    // says. Which reading the *bar* is drawing is the thing that changes.
    const value = snrMode
        ? (snr == null ? '—' : `${snr.toFixed(0)} dB SNR`)
        : (power == null || power <= -998 ? '—' : `${power.toFixed(0)} dBFS`);

    return (
        <button
            type="button"
            className="topbar__meter"
            onClick={() => display.set({ topMeter: snrMode ? 'signal' : 'snr' })}
            title={snrMode
                ? 'Signal-to-noise ratio — click for the S-meter'
                : 'Signal strength — click for SNR'}
        >
            <span className="topbar__s topbar__reading">{sUnitLabel(power)}</span>
            <div className="topbar__bar">
                <div
                    className="topbar__bar-fill"
                    style={{ width: `${fraction * 100}%`, background: colour }}
                />
            </div>
            <span className="topbar__snr topbar__reading">{value}</span>
        </button>
    );
}

export default function TopBar({ compact }) {
    const { tuning, running, actions, audioState, spectrumState, serverInfo } = useRadio();
    const display = useDisplay();
    const { docks, toggleDock } = useLayout();
    // Eight was already close to this; ten so the two live readings in this bar
    // tick together rather than beating against each other, which is visible as
    // the strip repainting at the sum of the two rates rather than at either.
    const meters = useMeters(10);

    // Text size: one clamped number, stored with the rest of the display
    // settings so it survives a reload like the theme does.
    const scale = display.uiScale ?? 1;
    const setScale = (v) => display.set({
        uiScale: Math.round(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v)) * 100) / 100,
    });

    // What the bar gives up first as it narrows, in the order it gives them up.
    //
    // Space weather goes first: it is a summary of five figures that the Space
    // weather panel shows in full, and the spectrum carries the propagation
    // grade too. The clocks next — the receiver's local time is worth having
    // and UTC is worth a lot to a log, but every machine running this already
    // has a clock on it somewhere. The countdown lasts longest of the three,
    // being the only place a session limit appears at all.
    //
    // All three go before anything else in the bar, because everything else
    // here is a control rather than a readout.
    const barRef = useRef(null);
    // Keep order: most important first, so the last listed is the first to go.
    // The filter width leads because it is part of the tuning readout — what you
    // are listening through, beside what you are listening to — and the Receiver
    // panel's own slider is dropped in minimal view, so this can be the only
    // place it is shown. The session countdown goes first: it matters once, when
    // it is nearly up, and the Session panel has it either way.
    const room = useRoomFor(barRef, [
        { key: 'width', width: FILTER_W },
        // Second, so the fader outlasts all three readouts: it is a control, and
        // the clock and the rest are things to glance at. Not first, because
        // losing it costs less than losing anything else here — the mute button
        // stays behind and the level is a panel away, where the filter width has
        // nowhere else to be shown at all.
        { key: 'volume', width: VOLUME_W },
        { key: 'clock', width: CLOCK_W },
        { key: 'spaceWeather', width: SPACE_WEATHER_W },
        { key: 'session', width: SESSION_W },
    ]);

    // ...and, on a phone, what the readout has to shrink to before any of that
    // applies. The filter width is the first thing the row above would drop, and
    // it is the one thing in the readout worth smaller type to keep: a passband
    // is not guessable from the mode, and with the Receiver panel shut — which
    // on a handset it usually is — this is the only place it is written down.
    //
    // Only compact. See useFitScale for why the desktop bar must not have this.
    const freqRef = useRef(null);
    const fit = useFitScale(barRef, freqRef, !!compact);

    // Whether anything in this bar may talk about hovering — see the dock
    // buttons at the foot of it.
    const canHover = useMediaQuery(HOVER_QUERY);

    // Tuning straight from the readout: the frequency swaps for an input, the
    // mode drops a menu at the point it was clicked.
    const [editingFreq, setEditingFreq] = useState(false);
    // The other way in: the `F` shortcut, or a pad mapped to "Type a frequency",
    // opening the same box a click on the readout does. The bar registers rather
    // than the box, because the box does not exist until this is asked for.
    useEffect(() => onFreqEntry(() => setEditingFreq(true)), []);
    const [modeAt, setModeAt] = useState(null);
    const modeClosedAt = useRef(0);
    const [widthAt, setWidthAt] = useState(null);
    const widthClosedAt = useRef(0);
    // The callsign box under the lookup button. Same three pieces as the filter-width
    // popover: where it opened, when it last closed (so the click that dismissed it does
    // not immediately reopen it), and what is in it.
    const [lookupAt, setLookupAt] = useState(null);
    const [lookupCall, setLookupCall] = useState('');
    const lookupClosedAt = useRef(0);
    const lookupRef = useRef(null);

    const closeLookup = useCallback(() => {
        lookupClosedAt.current = performance.now();
        setLookupAt(null);
    }, []);

    // Both surfaces, because either might be the one being looked at.
    //
    // requestLookup is the in-app route — the same one a click on a spot takes — so the
    // Callsign panel fills in where one is open, and the announcer says the callsign if
    // that is on. It does nothing at all when no panel is listening.
    //
    // openCallsignLookup is the page, which is what this button has always meant: the bio,
    // the map and the QSL details the panel does not carry. It opens one if there is none
    // and reuses the window if there is.
    //
    // The cost of doing both is one extra request for a callsign the server has just
    // answered, and its cache allows a repeat at ten times the rate of a new lookup —
    // which is the case this is.
    const submitLookup = useCallback(() => {
        const call = lookupCall.trim().toUpperCase();
        if (!call) return;
        requestLookup(call);
        openCallsignLookup({ uuid: getSessionId(), callsign: call });
        setLookupCall('');
        closeLookup();
    }, [closeLookup, lookupCall]);

    // The page with nothing in it, which is exactly what this button used to do: still
    // worth having, because the page has its own search box, its own history and the QSL
    // details, and sometimes the page itself is the destination.
    const openLookupPage = useCallback(() => {
        openCallsignLookup({ uuid: getSessionId() });
        closeLookup();
    }, [closeLookup]);

    const filterWidth = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);
    // The Receiver panel's slider does exactly this. Shared through
    // edgesForWidth so the two, and the spectrum's edge dragging, cannot
    // disagree about which way a lower-sideband filter opens.
    const setFilterWidth = (w) => actions.setBandwidth(...edgesForWidth(tuning.mode, w, tuning));

    const linkTone = audioState === 'open' ? 'good'
        : audioState === 'reconnecting' || audioState === 'connecting' ? 'warn'
            : audioState === 'rejected' ? 'bad' : 'idle';

    return (
        <header className={`topbar${compact ? ' topbar--compact' : ''}`} ref={barRef}>
            <div className="topbar__brand">
                <LinksMenu serverInfo={serverInfo} compact={compact} />
                <div className="topbar__id">
                    <span className="topbar__name">{serverInfo?.receiver?.callsign || 'UberSDR'}</span>
                    {!compact && <span className="topbar__sub">UberSDR</span>}
                </div>
            </div>

            {!compact && room.clock && <Clock tzOffset={serverInfo?.receiver?.timezone_offset} />}

            {/* The readout is also the shortest way to tune: the frequency
                opens the same type-in box as the Receiver panel's dial, the
                mode a picker. Both are here so the top bar alone is enough to
                retune with every panel closed. */}
            <div
                className="topbar__freq"
                ref={freqRef}
                /* The one number the three font sizes are multiplied by — see
                   .topbar__freq in the CSS. 1 everywhere but a narrow phone. */
                style={fit === 1 ? undefined : { '--fit': fit }}
            >
                {editingFreq ? (
                    <FreqEntry
                        frequency={tuning.frequency}
                        className="topbar__hz-input"
                        fitKey="hz"
                        onDone={(hz) => { setEditingFreq(false); if (hz != null) actions.setFrequency(hz); }}
                    />
                ) : (
                    <button
                        type="button"
                        className="topbar__hz"
                        /* The parts that scale, named so their widths survive
                           one of them being dropped — see lib/fitScale.js. The
                           type-in box above carries the same key, because while
                           it is open it *is* this part of the readout. */
                        data-fit="hz"
                        title="Type a frequency in kHz"
                        onClick={() => setEditingFreq(true)}
                    >
                        {formatHz(tuning.frequency)}
                    </button>
                )}
                <button
                    type="button"
                    className="topbar__mode"
                    data-fit="mode"
                    title="Change mode"
                    aria-haspopup="menu"
                    onClick={(e) => {
                        // A click on the button while the menu is open has
                        // already closed it on the way down — the menu dismisses
                        // itself on any pointerdown outside. Without this the
                        // second click would blink it shut and straight back
                        // open instead of toggling.
                        if (performance.now() - modeClosedAt.current < 250) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        setModeAt({ x: r.left, y: r.bottom + 4 });
                    }}
                >
                    {(MODE_BY_ID[tuning.mode] || {}).label || tuning.mode}
                </button>
                {/* The filter, beside the mode it belongs to. The Receiver
                    panel's minimal view drops its width slider, and the panel
                    can be collapsed entirely, so without this there is nowhere
                    to read the passband you are listening through — or, since
                    it opens the same slider, to change it.

                    Optional: still the first thing to go as the bar narrows,
                    because the mode beside it is the one that changes what you
                    hear — but on a phone the readout shrinks first and usually
                    keeps it. See useFitScale above; the floor there is the point
                    at which this is dropped after all. */}
                {room.width && (
                    <button
                        type="button"
                        className="topbar__bw"
                        data-optional="width"
                        data-fit="bw"
                        aria-haspopup="dialog"
                        title={`Filter width — passband ${tuning.bandwidthLow} to ${tuning.bandwidthHigh} Hz`}
                        onClick={(e) => {
                            // Same guard as the mode button: the press that
                            // opens the popover has already dismissed an open
                            // one on the way down, so without this a second
                            // click blinks it shut and straight back open.
                            if (performance.now() - widthClosedAt.current < 250) return;
                            const r = e.currentTarget.getBoundingClientRect();
                            setWidthAt({ x: r.left, y: r.bottom + 4 });
                        }}
                    >
                        {formatFilterWidth(tuning.bandwidthLow, tuning.bandwidthHigh)}
                    </button>
                )}

                {widthAt && (
                    <Popover
                        at={widthAt}
                        className="bwpop"
                        aria-label="Filter width"
                        onClose={() => {
                            widthClosedAt.current = performance.now();
                            setWidthAt(null);
                        }}
                    >
                        <div className="bwpop__head">
                            <span className="bwpop__label">Filter width</span>
                            <span className="bwpop__value">{(filterWidth / 1000).toFixed(2)} kHz</span>
                        </div>
                        <Slider
                            value={Math.min(filterWidth, maxFilterWidth(tuning.mode))}
                            min={FILTER_WIDTH_MIN}
                            max={maxFilterWidth(tuning.mode)}
                            step={FILTER_WIDTH_STEP}
                            onChange={setFilterWidth}
                        />
                        <div className="bwpop__edges">
                            <span>{tuning.bandwidthLow} Hz</span>
                            <span>{tuning.bandwidthHigh} Hz</span>
                        </div>
                    </Popover>
                )}

                {/* Inside the readout rather than a child of the bar itself:
                    it is position:fixed either way, but useRoomFor counts the
                    bar's own children and would take it for content. */}
                {modeAt && (
                    <SpectrumMenu
                        at={modeAt}
                        onClose={() => { modeClosedAt.current = performance.now(); setModeAt(null); }}
                        items={MODES.map((m) => ({
                            key: m.id,
                            label: m.label,
                            disabled: m.id === tuning.mode,
                            title: m.id === tuning.mode ? 'Current mode' : undefined,
                            onSelect: () => actions.setMode(m.id),
                        }))}
                    />
                )}
            </div>

            {!compact && <TopMeter meters={meters} />}

            <div className="topbar__spacer" data-slack="" />

            {!compact && room.spaceWeather && serverInfo?.space_weather && <SpaceWeather />}

            {!compact && (
                <div className="topbar__zoom" role="group" aria-label="Text size">
                    <Button
                        variant="ghost"
                        size="sm"
                        icon={<Icon.ZoomOut />}
                        title="Smaller text"
                        onClick={() => setScale(scale - UI_SCALE_STEP)}
                        disabled={scale <= UI_SCALE_MIN + 1e-6}
                    />
                    <button
                        type="button"
                        className="topbar__zoom-val"
                        title="Reset text size"
                        onClick={() => display.set({ uiScale: 1 })}
                    >
                        {Math.round(scale * 100)}%
                    </button>
                    <Button
                        variant="ghost"
                        size="sm"
                        icon={<Icon.ZoomIn />}
                        title="Larger text"
                        onClick={() => setScale(scale + UI_SCALE_STEP)}
                        disabled={scale >= UI_SCALE_MAX - 1e-6}
                    />
                </div>
            )}

            {!compact && <VolumeSlider slider={room.volume} />}

            {/* On a phone the icon says it on its own — a power symbol is the most
                universally read control there is, and the two buttons either side of it
                are icons too, so the word was the odd one out as well as the widest
                thing in the row. The width it gives back is what the theme menu needs
                to be here at all; the label is still in the tooltip either way. */}
            <Button
                variant={running ? 'danger' : 'primary'}
                icon={<Icon.Power />}
                title={running ? 'Stop listening' : 'Start listening'}
                onClick={() => (running ? actions.powerOff() : actions.powerOn())}
            >
                {compact ? undefined : (running ? 'Stop' : 'Listen')}
            </Button>

            {/* Not on mobile. The Status panel says the same thing in words,
                one tap away on the tab bar, and here it is a lit dot competing
                for the width the filter readout needs. */}
            {!compact && (
                <div className="topbar__status" title={`audio: ${audioState} · spectrum: ${spectrumState}`}>
                    <span className={`dot dot--${linkTone}`} />
                </div>
            )}

            {/* Never on mobile, where the bar is down to the frequency, the
                mode and Listen — and where the space this would take is the
                space those need. On the desktop bar it is still the first thing
                to go when the width runs out: it is the one readout among
                controls here, and a countdown that disappears costs less than a
                squeezed frequency or Listen button. */}
            {!compact && room.session && <SessionClock />}

            {/* v1 pins this next to the voice activity button on the band
                bar, on the same condition. The page it opens is a v1 one and
                talks to us through compat/LegacyBridge. */}
            {!compact && serverInfo?.lookup_service && (
                <>
                    {/* Asks who, then opens the lookup page for them. It used to open that
                        page empty, which made the button a way of getting to a search box
                        rather than a way of searching: a new window, and then the question.

                        Both surfaces get it: the page, which is what this control has
                        always meant, and the Callsign panel where one is open — see
                        submitLookup. Whichever of the two somebody is looking at has the
                        answer, and neither one being open is a reason for nothing to
                        happen. */}
                    <Button
                        variant="ghost"
                        size="sm"
                        icon={<Icon.Search />}
                        title="Look up a callsign"
                        aria-label="Look up a callsign"
                        onClick={(e) => {
                            if (performance.now() - lookupClosedAt.current < 250) return;
                            const r = e.currentTarget.getBoundingClientRect();
                            setLookupAt({ x: r.left, y: r.bottom + 4 });
                        }}
                    />
                    {lookupAt && (
                        <Popover
                            at={lookupAt}
                            className="callpop"
                            aria-label="Callsign lookup"
                            autoFocus
                            onClose={closeLookup}
                        >
                            <form
                                className="callpop__form"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    submitLookup();
                                }}
                            >
                                {/* Focused on open — by the Popover, once it has placed
                                    itself: it paints hidden until then, and a hidden input
                                    cannot take focus, so React's own autoFocus fires a
                                    frame too early and does nothing. A box you have to
                                    click first is a box that cost you a click. */}
                                <input
                                    ref={lookupRef}
                                    className="input callpop__input"
                                    placeholder="Callsign…"
                                    value={lookupCall}
                                    onChange={(e) => setLookupCall(e.target.value.toUpperCase())}
                                    autoComplete="off"
                                    spellCheck={false}
                                    data-autofocus=""
                                />
                                <Button
                                    type="submit"
                                    size="sm"
                                    variant="primary"
                                    icon={<Icon.Search />}
                                    title="Look up"
                                    disabled={!lookupCall.trim()}
                                />
                            </form>
                            {/* Exactly what this button used to do, kept for when the page
                                itself is the destination — it has its own search box and
                                its own history. */}
                            <button type="button" className="callpop__page" onClick={openLookupPage}>
                                Open without a callsign
                            </button>
                        </Popover>
                    )}
                </>
            )}

            {/* On a phone too, now that Listen is an icon and has the width to spare.
                It earns it: dark or light is the setting somebody changes because of the
                room they are in, which on a handset changes several times a day — a
                train, a shack, outside at night — and it is two taps away in the Display
                panel instead of one here.

                A menu rather than the toggle this was: dark or light is still one of the
                questions, but the colour schemes are the other, and a button cannot
                cycle nine of anything. */}
            <ThemeMenu />

            {!compact && (
                <div className="topbar__docks">
                    <Button size="sm" variant="ghost" active={!docks.left.collapsed} title="Left panels" icon={<Icon.ChevronLeft />} onClick={() => toggleDock('left')} />
                    <Button size="sm" variant="ghost" active={!docks.bottom.collapsed} title="Bottom panels" icon={<Icon.Chevron />} onClick={() => toggleDock('bottom')} />
                    <Button size="sm" variant="ghost" active={!docks.right.collapsed} title="Right panels" icon={<Icon.ChevronRight />} onClick={() => toggleDock('right')} />
                    {/* Beside the three dock buttons because it governs what
                        they leave behind: with the docks collapsed, this is
                        what decides whether resting on a rail opens it. Same
                        setting as the Display panel's switch.

                        Only where there is something to rest. This bar is
                        already desktop-only, but "desktop" here means wide
                        rather than pointed — a tablet gets the full layout,
                        docks and all, and cannot hover over any of it. The
                        setting it toggles is not wrong there, it is simply
                        unreachable, and a lit button offering to change
                        something that never happens is worse than no button. */}
                    {canHover && (
                        <Button
                            size="sm"
                            variant="ghost"
                            active={display.hoverPanels !== false}
                            title={display.hoverPanels !== false
                                ? 'Collapsed panels open on hover — click to turn that off'
                                : 'Collapsed panels stay shut until clicked — click to open them on hover'}
                            aria-label="Show panels on hover"
                            icon={<Icon.Eye />}
                            onClick={() => display.set({ hoverPanels: display.hoverPanels === false })}
                        />
                    )}
                </div>
            )}

            {/* Last in the bar, past the dock buttons, on the far right. A link
                to what you are hearing is the one control up here that is not
                about operating the receiver, and it is what you reach for when
                something interesting turns up — rarely, and never in a hurry, so
                the end of the row is exactly where it belongs.

                Kept on a phone, unlike most of what is up here: the sheet it
                opens there is the system's own, and sending somebody a frequency
                is likelier from a handset than from a desk. */}
            <ShareMenu />
        </header>
    );
}
