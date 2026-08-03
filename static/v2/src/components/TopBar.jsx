import React, { useEffect, useState } from '../react.js';
import { useRadio, useMeters } from '../radio/RadioContext.jsx';
import { useDisplay, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '../display/DisplayContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { Button, Icon, Slider } from './ui.jsx';
import LinksMenu from './LinksMenu.jsx';
import { formatHz, sUnitFraction, sUnitLabel } from '../lib/format.js';
import { MODE_BY_ID } from '../radio/constants.js';
import { getSessionId } from '../radio/session.js';
import { openCallsignLookup } from '../compat/legacyBridge.js';

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
const SW_TONE = { Poor: 'bad', Fair: 'warn', Good: 'good', Excellent: 'good' };

function SpaceWeather({ clickable }) {
    const [sw, setSw] = useState(null);

    useEffect(() => {
        let cancelled = false;
        const load = () => fetch('/api/spaceweather')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
            .then((d) => { if (!cancelled) setSw(d); })
            .catch(() => { /* non-fatal — the summary just stays as it was */ });
        load();
        const id = setInterval(load, 60000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

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
        clickable ? '\nClick for band conditions' : '',
    ].filter(Boolean).join('\n');

    return (
        <div
            className={`topbar__sw${clickable ? ' is-clickable' : ''}`}
            title={tip}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => window.open('/bandconditions.html', '_blank') : undefined}
        >
            <span>S:{flux}</span>
            <span>K:{k}</span>
            <span>A:{a}</span>
            <span>W:{bz}</span>
            <span className={`topbar__sw-p is-${SW_TONE[quality] || 'idle'}`}>P:{quality}</span>
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
        return <span className="topbar__session" title="Session time">Unlimited</span>;
    }

    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
    const left = Math.max(0, session.maxSec - elapsed);
    const hh = String(Math.floor(left / 3600)).padStart(2, '0');
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');

    return (
        <span
            className={`topbar__session${left < 300 ? ' is-low' : ''}`}
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

    const linkTone = audioState === 'open' ? 'good'
        : audioState === 'reconnecting' || audioState === 'connecting' ? 'warn'
            : audioState === 'rejected' ? 'bad' : 'idle';

    return (
        <header className={`topbar${compact ? ' topbar--compact' : ''}`}>
            <div className="topbar__brand">
                <LinksMenu serverInfo={serverInfo} compact={compact} />
                <div className="topbar__id">
                    <span className="topbar__name">{serverInfo?.receiver?.callsign || 'UberSDR'}</span>
                    {!compact && <span className="topbar__sub">UberSDR</span>}
                </div>
            </div>

            {!compact && <Clock tzOffset={serverInfo?.receiver?.timezone_offset} />}

            <div className="topbar__freq">
                <span className="topbar__hz">{formatHz(tuning.frequency)}</span>
                <span className="topbar__mode">{(MODE_BY_ID[tuning.mode] || {}).label || tuning.mode}</span>
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

            <div className="topbar__spacer" />

            {!compact && serverInfo?.space_weather && (
                <SpaceWeather clickable={!!serverInfo?.noise_floor} />
            )}

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
                    <Slider value={Math.round(audio.volume * 100)} min={0} max={100} onChange={(v) => actions.setVolume(v / 100)} />
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

            <SessionClock />

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
