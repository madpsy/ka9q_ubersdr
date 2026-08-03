import React from '../react.js';
import { useRadio, useMeters } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { Button, Icon, Slider } from './ui.jsx';
import { formatHz, sUnitFraction, sUnitLabel } from '../lib/format.js';
import { MODE_BY_ID } from '../radio/constants.js';

export default function TopBar({ compact }) {
    const { tuning, running, actions, audioState, spectrumState, serverInfo, audio } = useRadio();
    const display = useDisplay();
    const { docks, toggleDock } = useLayout();
    const meters = useMeters(8);

    const linkTone = audioState === 'open' ? 'good'
        : audioState === 'reconnecting' || audioState === 'connecting' ? 'warn'
            : audioState === 'rejected' ? 'bad' : 'idle';

    return (
        <header className={`topbar${compact ? ' topbar--compact' : ''}`}>
            <div className="topbar__brand">
                <span className="topbar__logo"><Icon.Radio size={18} /></span>
                <div className="topbar__id">
                    <span className="topbar__name">{serverInfo?.receiver?.callsign || 'UberSDR'}</span>
                    {!compact && <span className="topbar__sub">WebSDR</span>}
                </div>
            </div>

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
