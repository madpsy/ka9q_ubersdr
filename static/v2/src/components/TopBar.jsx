import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio, useMeters } from '../radio/RadioContext.jsx';
import { useDisplay, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '../display/DisplayContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { Button, Icon, Slider } from './ui.jsx';
import LinksMenu from './LinksMenu.jsx';
import { audioLevelPercent, formatHz, sUnitFraction, sUnitLabel } from '../lib/format.js';
import { MODES, MODE_BY_ID } from '../radio/constants.js';
import FreqEntry from './FreqEntry.jsx';
import SpectrumMenu from './SpectrumMenu.jsx';
import { getSessionId } from '../radio/session.js';
import { openCallsignLookup } from '../compat/legacyBridge.js';
import { useRoomFor } from '../lib/useRoomFor.js';
import { gradeTone, subscribeSpaceWeather } from '../lib/spaceWeather.js';

// Width to assume for the session countdown until it has been on screen once —
// "Unlimited" is the widest it gets. See useRoomFor.
const SESSION_W = 68;

// UTC over receiver-local time, the pair v1 shows bottom-left. "Local" is the
// receiver's wall clock, not the browser's: timezone_offset is the server's
// DST-adjusted offset in minutes, so shifting the UTC epoch by it and reading
// the UTC fields back gives the operator's time wherever you are listening
// from. Until /api/description answers we fall back to the browser clock.
function Clock({ tzOffset }) {
    const [now, setNow] = useState(() => Date.now());

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

    return (
        <div className="topbar__clock" title="Receiver time">
            <span className="topbar__clock-line">
                <span className="topbar__clock-time">{utc}</span>
                <span className="topbar__clock-tag">UTC</span>
            </span>
            <span className="topbar__clock-line">
                <span className="topbar__clock-time">{local}</span>
                <span className="topbar__clock-tag">Local</span>
            </span>
        </div>
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

// The output VU, tucked under the volume slider it belongs to.
//
// Measured after the volume control (meters.outLevel), so it answers the
// question the slider raises — is anything actually coming out, and how hard —
// rather than reporting the stream regardless of where the slider is. Muting
// takes it to nothing, which is the point: a silent receiver and a silent band
// look the same until something says which.
//
// Sampled at its own rate rather than the S-meter's: this is a 3px bar, and
// re-rendering it faster than the eye resolves buys nothing. The zone colours
// are v1's VU (app.js updateVUMeter) — green to −20 dBFS, yellow, orange, then
// red over the last 5 dB — and they live in the stylesheet, so the fill is one
// number and no per-frame colour arithmetic.
function VuBar({ muted }) {
    const m = useMeters(10);
    const pct = audioLevelPercent(m.outLevel);

    return (
        <div
            className={`topbar__vu${m.clipping ? ' is-clip' : ''}${muted ? ' is-muted' : ''}`}
            title={m.clipping
                ? 'Output is hitting full scale — turn the volume, makeup or EQ boost down'
                : muted ? 'Output level — muted' : 'Output level'}
        >
            {/* The colours are painted across the whole track and this covers
                what the level has not reached, so a zone boundary stays at the
                same place on the bar instead of sliding with the reading. */}
            <span className="topbar__vu-mask" style={{ left: `${pct}%` }} />
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
        return <span className="topbar__session" data-optional="" title="Session time">Unlimited</span>;
    }

    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
    const left = Math.max(0, session.maxSec - elapsed);
    const hh = String(Math.floor(left / 3600)).padStart(2, '0');
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');

    return (
        <span
            className={`topbar__session${left < 300 ? ' is-low' : ''}`}
            data-optional=""
            title="Time left in this session"
        >
            {hh}:{mm}:{ss}
        </span>
    );
}

export default function TopBar({ compact }) {
    const { tuning, running, actions, audioState, spectrumState, serverInfo, audio } = useRadio();
    const display = useDisplay();
    const { docks, toggleDock } = useLayout();
    const meters = useMeters(8);

    // Text size: one clamped number, stored with the rest of the display
    // settings so it survives a reload like the theme does.
    const scale = display.uiScale ?? 1;
    const setScale = (v) => display.set({
        uiScale: Math.round(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v)) * 100) / 100,
    });

    // The countdown only goes up while the bar has width to spare for it.
    const barRef = useRef(null);
    const roomForSession = useRoomFor(barRef, SESSION_W);

    // Tuning straight from the readout: the frequency swaps for an input, the
    // mode drops a menu at the point it was clicked.
    const [editingFreq, setEditingFreq] = useState(false);
    const [modeAt, setModeAt] = useState(null);
    const modeClosedAt = useRef(0);

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

            {!compact && <Clock tzOffset={serverInfo?.receiver?.timezone_offset} />}

            {/* The readout is also the shortest way to tune: the frequency
                opens the same type-in box as the Receiver panel's dial, the
                mode a picker. Both are here so the top bar alone is enough to
                retune with every panel closed. */}
            <div className="topbar__freq">
                {editingFreq ? (
                    <FreqEntry
                        frequency={tuning.frequency}
                        className="topbar__hz-input"
                        onDone={(hz) => { setEditingFreq(false); if (hz != null) actions.setFrequency(hz); }}
                    />
                ) : (
                    <button
                        type="button"
                        className="topbar__hz"
                        title="Type a frequency in kHz"
                        onClick={() => setEditingFreq(true)}
                    >
                        {formatHz(tuning.frequency)}
                    </button>
                )}
                <button
                    type="button"
                    className="topbar__mode"
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

            {!compact && (
                <div className="topbar__meter">
                    <span className="topbar__s">{sUnitLabel(meters.basebandPower)}</span>
                    <div className="topbar__bar">
                        <div
                            className="topbar__bar-fill"
                            style={{ width: `${sUnitFraction(meters.basebandPower) * 100}%` }}
                        />
                    </div>
                    <span className="topbar__snr">{meters.snr == null ? '—' : `${meters.snr.toFixed(0)} dB`}</span>
                </div>
            )}

            <div className="topbar__spacer" data-slack="" />

            {!compact && serverInfo?.space_weather && <SpaceWeather />}

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

            {!compact && (
                <div className="topbar__volume">
                    <Button
                        variant="ghost"
                        size="sm"
                        icon={audio.muted ? <Icon.Mute /> : <Icon.Volume />}
                        onClick={actions.toggleMute}
                        active={audio.muted}
                        title={audio.muted ? 'Unmute' : 'Mute'}
                    />
                    <div className="topbar__vol-stack">
                        {/* Disabled rather than hidden while muted: the level is
                            still what you will hear when you unmute, and a
                            control that vanishes takes the reading with it. */}
                        <Slider
                            value={Math.round(audio.volume * 100)}
                            min={0}
                            max={100}
                            disabled={audio.muted}
                            onChange={(v) => actions.setVolume(v / 100)}
                        />
                        <VuBar muted={audio.muted} />
                    </div>
                </div>
            )}

            <Button
                variant={running ? 'danger' : 'primary'}
                icon={<Icon.Power />}
                onClick={() => (running ? actions.powerOff() : actions.powerOn())}
            >
                {running ? 'Stop' : 'Listen'}
            </Button>

            <div className="topbar__status" title={`audio: ${audioState} · spectrum: ${spectrumState}`}>
                <span className={`dot dot--${linkTone}`} />
            </div>

            {/* Never on mobile, where the bar is down to the frequency, the
                mode and Listen — and where the space this would take is the
                space those need. On the desktop bar it is still the first thing
                to go when the width runs out: it is the one readout among
                controls here, and a countdown that disappears costs less than a
                squeezed frequency or Listen button. */}
            {!compact && roomForSession && <SessionClock />}

            {/* v1 pins this next to the voice activity button on the band
                bar, on the same condition. The page it opens is a v1 one and
                talks to us through compat/LegacyBridge. */}
            {!compact && serverInfo?.lookup_service && (
                <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon.Search />}
                    title="Callsign lookup"
                    onClick={() => openCallsignLookup({ uuid: getSessionId() })}
                />
            )}

            <Button
                variant="ghost"
                size="sm"
                icon={display.theme === 'dark' ? <Icon.Sun /> : <Icon.Moon />}
                title="Toggle theme"
                onClick={() => display.set({ theme: display.theme === 'dark' ? 'light' : 'dark' })}
            />

            {!compact && (
                <div className="topbar__docks">
                    <Button size="sm" variant="ghost" active={!docks.left.collapsed} title="Left panels" icon={<Icon.ChevronLeft />} onClick={() => toggleDock('left')} />
                    <Button size="sm" variant="ghost" active={!docks.bottom.collapsed} title="Bottom panels" icon={<Icon.Chevron />} onClick={() => toggleDock('bottom')} />
                    <Button size="sm" variant="ghost" active={!docks.right.collapsed} title="Right panels" icon={<Icon.ChevronRight />} onClick={() => toggleDock('right')} />
                </div>
            )}
        </header>
    );
}
