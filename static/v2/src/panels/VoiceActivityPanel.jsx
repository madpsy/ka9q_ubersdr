// Voice activity — v1's speaker button and its popup, brought inline.
//
// v1 has no in-page view of this: the button on the band bar opens
// voice-activity.html in a separate window and that is the only place the
// detections appear. Here the same list is in the dock, so a glance is enough,
// and the button that opens the full page is kept alongside it — the popup has
// per-band stats, a confidence filter and marker navigation this panel does
// not try to reproduce.
//
// Clicking a row tunes to it, which is what clicking a row in the popup does.
//
// Polling only runs while this panel is mounted. A collapsed section is
// unmounted (see Section.jsx), so folding the panel away stops the requests —
// the same laziness v1's service has, for the same reason: this endpoint is
// rate-limited per IP and shared with the popup.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon, Segmented } from '../components/ui.jsx';
import { bandForFrequency } from '../lib/bands.js';
import { countryFlag } from '../lib/format.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { requestLookup } from '../lib/callsign.js';
import { confidenceTone, countActivities, dialFreq, subscribeVoiceActivity } from '../lib/voiceActivity.js';

// v1's popup geometry (app.js openAllBandsVoiceActivityPopup).
const POPUP_W = 550;
const POPUP_H = 650;

const SCOPES = [
    { value: 'band', label: 'This band' },
    { value: 'all', label: 'All bands' },
];

function openVoiceActivityPage(band) {
    const url = `/voice-activity.html?all=1&band=${encodeURIComponent(band || '40m')}`;
    const left = Math.round((screen.width - POPUP_W) / 2);
    const top = Math.round((screen.height - POPUP_H) / 2);
    window.open(
        url,
        'UberSDR_VoiceActivity',
        `width=${POPUP_W},height=${POPUP_H},left=${left},top=${top},resizable=yes,scrollbars=yes`,
    );
}

function Row({ activity, onTune, current }) {
    const hz = dialFreq(activity);
    const mode = (activity.mode || 'LSB').toUpperCase();
    const call = activity.dx_callsign || '';
    const flag = countryFlag(activity.dx_country_code);
    const tone = confidenceTone(activity.confidence);
    const pct = Math.round((activity.confidence || 0) * 100);
    const san = activity.signal_above_noise;

    return (
        <button
            type="button"
            className={`list__row va-row${current ? ' is-active' : ''}`}
            title={[
                `${(hz / 1000).toFixed(1)} kHz ${mode}`,
                activity.bandwidth ? `Bandwidth: ${activity.bandwidth} Hz` : null,
                `Confidence: ${pct}%`,
                san != null ? `Signal above noise: ${san.toFixed(1)} dB` : null,
                activity.dx_country ? `${call} — ${activity.dx_country}` : null,
            ].filter(Boolean).join('\n')}
            onClick={() => onTune(hz, (activity.mode || 'lsb').toLowerCase(), call)}
        >
            <div className="va-row__top">
                <span className="va-row__freq">{(hz / 1000).toFixed(1)}</span>
                <span className="va-row__mode">{mode}</span>
                {call && <span className="va-row__call">{flag ? `${flag} ${call}` : call}</span>}
                <span className={`va-row__conf va-row__conf--${tone || 'none'}`}>{pct}%</span>
            </div>
            <div className="list__meta va-row__meta">
                {activity.bandwidth ? `${activity.bandwidth} Hz` : '—'}
                {san != null && ` · ${san.toFixed(1)} dB`}
                {activity.dx_country && ` · ${activity.dx_country}`}
            </div>
        </button>
    );
}

// `minimal` drops the header — scope switch, signal count, the button to the
// full page — and leaves the detections. The scope keeps whatever it was set
// to. See the registry's `minimal`.
export default function VoiceActivityPanel({ minimal }) {
    const { tuning, actions, serverInfo } = useRadio();
    const [scope, setScope] = useState('band');
    const [groups, setGroups] = useState(null);   // null until the first reply
    const [error, setError] = useState('');

    const band = bandForFrequency(tuning.frequency);
    const lookups = !!(serverInfo && serverInfo.lookup_service);

    // One poll shared with the marker bar — see lib/voiceActivity.js. The
    // subscription is what starts it, and dropping it when this panel is
    // collapsed is what stops it (unless the markers are still watching).
    useEffect(() => subscribeVoiceActivity((state) => {
        setGroups(state.groups);
        setError(state.error || '');
    }), []);

    const tune = (hz, mode, callsign) => {
        // One tune, rather than a mode change that resets the passband followed
        // by a frequency change. v1's popup asks for the mode's default
        // passband too (setMode(mode, false)).
        actions.tuneTo({ frequency: hz, mode });
        // And look the callsign up, pairing tune-with-lookup as v1's popup rows
        // do. The in-app panel wins when it is open; otherwise the v1 popup gets
        // it, if that is open. Neither is ever opened by a click here.
        if (lookups && callsign && !requestLookup(callsign)) lookupCallsign(callsign);
    };

    const shown = scope === 'all'
        ? (groups || [])
        : (groups || []).filter((g) => g.band === band);
    const total = countActivities(groups || []);
    const count = countActivities(shown);

    return (
        <div className="stack va">
            {!minimal && (
                <div className="va__head">
                    <Segmented options={SCOPES} value={scope} onChange={setScope} size="sm" />
                    <span className="va__count">
                        {groups === null ? 'Loading…' : `${count} signal${count === 1 ? '' : 's'}`}
                        {scope === 'band' && total > count ? ` · ${total} all bands` : ''}
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.External />}
                        title="Open the full voice activity page"
                        onClick={() => openVoiceActivityPage(band)}
                    >
                        Open
                    </Button>
                </div>
            )}

            {error && <div className="note note--warn">Could not load voice activity: {error}</div>}

            <div className="list va__list">
                {/* The header carries "Loading…" in the full view; without it
                    the first poll would just be a blank panel. */}
                {minimal && groups === null && <Empty>Loading…</Empty>}

                {groups !== null && count === 0 && (
                    <Empty>
                        {scope === 'band' && !band
                            ? 'The dial is not on an amateur band — switch to All bands.'
                            : 'No voice activity detected.'}
                    </Empty>
                )}

                {shown.map((g) => (
                    <React.Fragment key={g.band}>
                        {scope === 'all' && (
                            <div className="va__band">
                                <span>{g.band}</span>
                                <span className="va__band-count">{g.activities.length}</span>
                            </div>
                        )}
                        {g.activities.map((a) => (
                            <Row
                                key={`${g.band}-${dialFreq(a)}-${a.start_freq}`}
                                activity={a}
                                onTune={tune}
                                current={Math.abs(dialFreq(a) - tuning.frequency) < 200}
                            />
                        ))}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}
