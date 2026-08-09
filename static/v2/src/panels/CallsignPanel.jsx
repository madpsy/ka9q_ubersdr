// Callsign lookup — the same job as v1's qrz_lookup widget, in the dock.
//
// Type a callsign, get who it is, where they are, how far away and which way to
// point. The widget is a draggable HUD with its own chrome and its own copy of
// the geometry; this reuses v2's controls and keeps the maths in lib/callsign.js
// where it can be tested.
//
// Two server rules drive most of the states here:
//
//   * /api/lookup needs an *active audio session*, not just a registered UUID,
//     so nothing works until the receiver is running. The panel says that
//     rather than showing the raw 401.
//   * lookups are rate limited per UUID, with cache hits allowed ten times the
//     rate. Repeating a callsign is nearly free; a burst of new ones is not.
//
// Only mounted when /api/description reports lookup_service — see registry.jsx.
//
// The announcer's *settings* are here rather than in the audio or display settings for
// the same reason the photo toggle is: the thing you want to turn it off from is the
// callsign in front of you. The announcing itself is not here at all — it is
// CallsignAnnounceWatch, which hears every lookup in the app rather than only the ones
// this panel made, and which is still mounted when this panel is collapsed.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { getSessionId } from '../radio/session.js';
import { Button, Empty, Icon, Modal } from '../components/ui.jsx';
import CallsignMap from '../components/CallsignMap.jsx';
import { countryFlag } from '../lib/format.js';
import { onPhotoShown, photoShown, photoUrl, setPhotoShown } from '../lib/operatorPhoto.js';
import {
    displayName, distanceBearing, identified, isValidCallsign, lookupCallsignData,
    normaliseCallsign, onLookupRequest, positionOf,
} from '../lib/callsign.js';
import { openCallsignLookup } from '../compat/legacyBridge.js';
import {
    CALL_CW, CALL_OFF, CALL_TTS, TTS_RATES, announceCall, callAnnounceSettings,
    callTtsAvailable, onCallAnnounce, setCallAnnounce,
} from '../lib/callsignAnnounce.js';
import { listVoices, speechAvailable } from '../lib/announce.js';
import { TONE_PITCHES, TONE_SPEEDS } from '../lib/morseTone.js';

const ROTCTL_PW = 'rotctl_password';

// Local time at the operator's position.
//
// tz_iana is only supplied when the provider's position is precise enough to
// sit inside the right zone — a DXCC or state centroid is refused server-side —
// so its absence means "do not claim to know their local time". The provider's
// own gmtoffset is deliberately unused: it is a whole-hour integer that cannot
// express +5:30 or +5:45, and its DST flag carries no switchover dates.
function LocalTime({ tz }) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!tz) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [tz]);

    if (!tz) return null;

    let time = '';
    let offset = '';
    try {
        time = new Intl.DateTimeFormat([], {
            timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(now);
        // Intl reports this as "GMT+5:45"; ham convention is UTC.
        const parts = new Intl.DateTimeFormat([], { timeZone: tz, timeZoneName: 'shortOffset' })
            .formatToParts(now);
        const tzName = parts.find((p) => p.type === 'timeZoneName');
        if (tzName) offset = tzName.value.replace(/^GMT/, 'UTC');
    } catch (e) {
        return null;   // unknown zone, or a browser without shortOffset
    }

    return (
        <div className="kv">
            <span className="kv__k">Local time</span>
            <span className="kv__v" title={tz}>{time}{offset ? ` (${offset})` : ''}</span>
        </div>
    );
}

// Distance and bearing from this receiver, plus a one-click rotate when the
// rotator is enabled and a password is already stored. No password prompt here:
// the widget gates the button the same way, and the Rotator panel is where
// authenticating belongs.
function Beam({ position, serverInfo }) {
    const [sent, setSent] = useState(false);
    const gps = (serverInfo && serverInfo.receiver && serverInfo.receiver.gps) || {};
    const rotator = !!(serverInfo && serverInfo.rotator && serverInfo.rotator.enabled);

    let stored = '';
    try { stored = localStorage.getItem(ROTCTL_PW) || ''; } catch (e) { /* private mode */ }

    // 0,0 is the config default, not a position — a bearing from it is fiction.
    if (!position || (!gps.lat && !gps.lon)) return null;
    const db = distanceBearing(gps.lat, gps.lon, position.lat, position.lon);
    if (!db) return null;

    const rotate = () => {
        fetch('/api/rotctl/position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: stored, azimuth: db.bearing }),
        }).then((r) => {
            if (r.status === 401) localStorage.removeItem(ROTCTL_PW);
            else setSent(true);
        }).catch(() => { /* the rotator panel is where errors are surfaced */ });
    };

    return (
        <div className="kv">
            <span className="kv__k">Distance</span>
            <span className="kv__v cs-beam">
                <span title={position.fromGrid ? 'Estimated from the grid square' : undefined}>
                    {db.distKm.toLocaleString()} km · {db.bearing}°{position.fromGrid ? ' ~' : ''}
                </span>
                {rotator && stored && (
                    <button
                        type="button"
                        className="chip chip--button"
                        title={`Rotate the antenna to ${db.bearing}°`}
                        onClick={rotate}
                    >
                        {sent ? '✓' : 'Point'}
                    </button>
                )}
            </span>
        </div>
    );
}

function Result({ call, data, serverInfo, showPhoto, showMap }) {
    const [photo, setPhoto] = useState(false);
    // Whether there is a picture to show is one decision, made in
    // lib/operatorPhoto.js. `showPhoto` is passed in only so this re-renders
    // when the setting changes — the answer still comes from there.
    const photoSrc = showPhoto ? photoUrl(data.image) : '';
    const name = displayName(data);
    const cty = data.cty || {};
    const country = data.country || cty.country || '';
    const flag = countryFlag(cty.country_code);
    const position = positionOf(data);

    return (
        <div className="cs-result">
            <div className="cs-result__head">
                <a
                    className="cs-result__call"
                    href={`https://www.qrz.com/db/${encodeURIComponent(call)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open on QRZ.com"
                >
                    {call}
                </a>
                {/* Ellipsized when it does not fit — operator names run to
                    three or four words and the header shares its row with the
                    callsign — so the whole of it is on hover. */}
                {name && <span className="cs-result__name" title={name}>{name}</span>}
            </div>

            <div className="kv-list">
                {country && (
                    <div className="kv">
                        <span className="kv__k">Country</span>
                        <span className="kv__v">{flag ? `${flag} ${country}` : country}</span>
                    </div>
                )}
                {data.grid && (
                    <div className="kv">
                        <span className="kv__k">Grid</span>
                        <span className="kv__v">{data.grid}</span>
                    </div>
                )}
                {cty.continent && (
                    <div className="kv">
                        <span className="kv__k">Continent</span>
                        <span className="kv__v">
                            {cty.continent}
                            {cty.cq_zone ? ` · CQ ${cty.cq_zone}` : ''}
                            {cty.itu_zone ? ` · ITU ${cty.itu_zone}` : ''}
                        </span>
                    </div>
                )}
                <LocalTime tz={data.tz_iana} />
                <Beam position={position} serverInfo={serverInfo} />
                {data.class && (
                    <div className="kv">
                        <span className="kv__k">Licence</span>
                        <span className="kv__v">{data.class}</span>
                    </div>
                )}
            </div>

            {/* Served through the same origin: the server rewrites the
                provider's URL to /api/lookup/image/<uuid> (lookup_image_proxy.go),
                so no request leaves for a third party.

                The thumbnail is deliberately small — most of these are portraits
                or shack photos and the panel is not a gallery — so clicking
                opens it full size rather than sending anyone to a new tab. */}
            {photoSrc && (
                <button
                    type="button"
                    className="cs-photo"
                    title="Show full size"
                    onClick={() => setPhoto(true)}
                >
                    <img src={photoSrc} alt={call} loading="lazy" />
                </button>
            )}

            {photoSrc && photo && (
                <Modal onClose={() => setPhoto(false)} label={`${call} photo`}>
                    <img className="cs-photo-full" src={photoSrc} alt={call} />
                </Modal>
            )}

            {/* Last in the result, under the photo. A map is the largest thing
                here and the least specific — the details above it are what the
                lookup was for, and a picture of a county between them and the
                photo would be furniture in front of the answer.

                Only where the answer carried a position. A lookup that came back
                without one shows nothing rather than a map of the middle of the
                Atlantic, which is where 0,0 is. */}
            {showMap && position && <CallsignMap call={call} position={position} />}
        </div>
    );
}

// `minimal` hides the search form and leaves the result. The panel still fills:
// clicking a callsign in the spots or voice-activity lists routes here through
// onLookupRequest, so it becomes a read-out of whoever you last clicked on.
// See the registry's `minimal`.
const MAP_KEY = 'ubersdr.v2.callsignMap';

const mapShown = () => {
    try { return localStorage.getItem(MAP_KEY) !== 'off'; } catch (e) { return true; }
};

export default function CallsignPanel({ minimal }) {
    const [showPhoto, setShowPhoto] = useState(photoShown);
    // On, and remembered once it has been touched. Where a station is is a fact
    // about the contact — it is what the distance and bearing above it are
    // derived from, drawn rather than stated — where the operator photo it
    // replaced as the default is a fact about the operator. It costs requests to
    // OpenStreetMap, which is the one thing in this panel that goes anywhere but
    // this receiver, and the button turns it off for anyone who would rather it
    // did not.
    //
    // Not shared with the other copy of the panel, unlike the photo and the
    // announcer: those are about what a lookup *does*, this is about how much
    // room one is given, and a floating window and a dock column do not have the
    // same amount.
    const [showMap, setShowMap] = useState(mapShown);
    const toggleMap = () => setShowMap((on) => {
        try { localStorage.setItem(MAP_KEY, on ? 'off' : 'on'); } catch (e) { /* private mode */ }
        return !on;
    });
    // As with the photo: shared, so the other copy of this panel agrees.
    const [cw, setCw] = useState(callAnnounceSettings);
    useEffect(() => onCallAnnounce(setCw), []);
    // The browser's voices, which arrive after the page does: Chrome returns an empty
    // list until it has loaded them and fires voiceschanged when it has. The
    // Announcements panel listens the same way — a picker that was empty on load and
    // stayed empty was the bug that put the listener in both.
    const [voices, setVoices] = useState(listVoices);
    useEffect(() => {
        if (!speechAvailable()) return undefined;
        const on = () => setVoices(listVoices());
        window.speechSynthesis.addEventListener('voiceschanged', on);
        // Once more now, in case they landed between the first render and this.
        on();
        return () => window.speechSynthesis.removeEventListener('voiceschanged', on);
    }, []);
    // Another copy of this panel — a floating one, or the mobile sheet — has
    // its own state, so the change has to reach it.
    useEffect(() => onPhotoShown(setShowPhoto), []);
    const { serverInfo, running } = useRadio();
    const [entry, setEntry] = useState('');
    const [call, setCall] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const inputRef = useRef(null);
    // Guards against an earlier, slower lookup overwriting a later one.
    const seq = useRef(0);
    // What `run` needs to see *now*. The lookup-request listener is registered
    // once, so without this it would judge everything by the state of the very
    // first render: never running, nothing looked up yet.
    const live = useRef({});
    live.current = { running, call, data };

    /**
     * Look a callsign up and show it.
     *
     * `auto` means nobody asked: the Markers panel offers whatever the dial has
     * landed on. Those are shown when they succeed and are silent when they do
     * not — no error, and no clearing of what is already on screen. The failure
     * that made this necessary is the ordinary one: powerOn() flips `running`
     * and *then* registers the audio session, and /api/lookup wants the session,
     * so an automatic lookup on the way up reliably lost the race and put "Start
     * the receiver first" on screen for someone who just had.
     */
    // Off → Morse → Speech → off, in one button. Three states is the most a cycling
    // control can carry and still be predictable, and these three are one question
    // — how should a lookup be announced — rather than three switches.
    //
    // Speech is skipped when the browser has no voices, rather than being a stop on
    // the way round that does nothing.
    const nextAnnounce = () => {
        if (cw.mode === CALL_OFF) return CALL_CW;
        if (cw.mode === CALL_CW) return callTtsAvailable() ? CALL_TTS : CALL_OFF;
        return CALL_OFF;
    };
    const ANNOUNCE_SAID = {
        [CALL_OFF]: 'Lookups are not announced',
        [CALL_CW]: 'Lookups are sent in Morse',
        [CALL_TTS]: 'Lookups are spoken',
    };
    const ANNOUNCE_NEXT = {
        [CALL_OFF]: 'send them in Morse',
        [CALL_CW]: callTtsAvailable() ? 'speak them' : 'stop announcing them',
        [CALL_TTS]: 'stop announcing them',
    };

    const run = (raw, { auto = false } = {}) => {
        const c = normaliseCallsign(raw);
        if (!auto) setEntry(c);
        if (!c) return;
        if (!isValidCallsign(c)) {
            if (auto) return;
            setError('That does not look like a callsign.');
            setData(null);
            setCall('');
            return;
        }
        // Already showing this one. Clicking the same marker again, or landing
        // on it a second time while tuning around, is not a reason to ask
        // again — the answer is on screen and the server's copy is a day old
        // at worst. A failed lookup is not skipped: retrying that is the point
        // of pressing it twice.
        if (c === live.current.call && live.current.data) {
            // Announced from here, and this is the one place the panel does its own
            // announcing rather than leaving it to CallsignAnnounceWatch: this path
            // deliberately does not ask the server, so there is no answer for the
            // watch to hear. Asking again for what is already on screen is the only
            // gesture there is for "say that once more" — the search button beside
            // the box, or the same spot clicked twice — and it is the reason the
            // announcer needs no replay control of its own.
            if (!auto && identified(live.current.data)) announceCall(c);
            return;
        }

        // /api/lookup needs an active audio session, not merely a registered
        // UUID. Said when a lookup is actually asked for rather than as a
        // standing notice: the panel is docked by default, and a permanent line
        // telling you to press Start was the first thing on screen every load.
        if (!live.current.running) {
            if (auto) return;
            setError('Start the receiver — lookups need an active audio session.');
            setData(null);
            setCall(c);
            return;
        }

        const mine = ++seq.current;
        // "Looking up …" belongs to a lookup somebody is waiting on. An
        // automatic one announces itself only by its answer.
        if (!auto) {
            setBusy(true);
            setError('');
            setCall(c);
        }
        lookupCallsignData(c, getSessionId())
            .then((d) => {
                if (mine !== seq.current) return;
                setCall(c);
                setEntry(c);
                setData(d);
                setError('');
            })
            .catch((err) => {
                if (mine !== seq.current || auto) return;
                setData(null);
                setError(err.message || String(err));
            })
            .finally(() => { if (mine === seq.current && !auto) setBusy(false); });
    };

    // Clicking a spot elsewhere (the voice activity panel) lands here.
    useEffect(() => onLookupRequest((c, opts) => {
        run(c, opts);
        // Bring the field in step, so the box shows what is on screen.
        if (inputRef.current) inputRef.current.value = c;
    }), []);

    return (
        <div className="stack cs">
            {!minimal && (
                <form
                    className="cs-form"
                    onSubmit={(e) => { e.preventDefault(); run(entry); }}
                >
                    <input
                        ref={inputRef}
                        className="input cs-form__input"
                        type="search"
                        placeholder="Callsign…"
                        autoComplete="off"
                        spellCheck="false"
                        value={entry}
                        onChange={(e) => setEntry(e.target.value.toUpperCase())}
                    />
                    <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        icon={<Icon.Search />}
                        disabled={busy || !entry.trim()}
                        title="Look up"
                    />
                    {/* Whether a result carries its photo. Here rather than in
                        the display settings because the reason to turn it off is
                        the picture in front of you — it is the largest thing the
                        panel fetches, for the least it tells you. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        active={showPhoto}
                        icon={<Icon.Picture />}
                        title={showPhoto
                            ? 'Operator photos on — click to stop fetching them'
                            : 'Operator photos off — click to show them'}
                        onClick={() => setShowPhoto(setPhotoShown(!showPhoto))}
                    />
                    {/* Where the station is. Beside the photo toggle because it
                        is the same kind of switch — how much of the answer to
                        draw — and in the row rather than at the foot with Full
                        Lookup, which leaves the panel entirely. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        active={showMap}
                        icon={<Icon.Compass />}
                        title={showMap
                            ? 'Map on — click to hide it'
                            : 'Map off — click to show where the station is'}
                        onClick={toggleMap}
                    />
                    {/* How a lookup is announced. A dit and a dah rather than a
                        speaker, and a talking head for the spoken one: what matters
                        here is which kind of sound it is, since the receiver already
                        has a volume control.

                        In the form row rather than on one of its own because there is
                        room for it — a callsign is six characters and the box beside
                        it is sized for a search field. */}
                    {/* Passed as `icon` rather than as a label, though it is text: an
                        icon-only Button gets btn--icon and so the same square geometry
                        as the picture and external ones beside it. As a child it would
                        be a text button in a row of icons, half a pixel taller and
                        wider than its neighbours. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        active={cw.mode !== CALL_OFF}
                        icon={(
                            <span className="cs-form__cw">
                                {cw.mode === CALL_TTS ? '🗣' : '·–'}
                            </span>
                        )}
                        title={`${ANNOUNCE_SAID[cw.mode]} — click to ${ANNOUNCE_NEXT[cw.mode]}`}
                        onClick={() => setCallAnnounce({ mode: nextAnnounce() })}
                    />
                </form>
            )}

            {error && <div className="note note--warn">{error}</div>}

            {busy && !data && <Empty>Looking up {call}…</Empty>}

            {/* Without the box there is nothing to type into, so the prompt has
                to name the other way in. Shown before the receiver is started
                as well: the panel should look like itself on load, and what a
                lookup needs is said when one is asked for. */}
            {!busy && !data && !error && (
                <Empty>
                    {minimal
                        ? 'Click a callsign in the spots or activity lists.'
                        : 'Enter a callsign to look it up.'}
                </Empty>
            )}

            {data && (
                <Result
                    call={call}
                    data={data}
                    serverInfo={serverInfo}
                    showPhoto={showPhoto}
                    showMap={showMap}
                />
            )}

            {/* Whichever announcer is on, its own two settings — pitch and speed for
                Morse, voice and speed for speech. Only while there is something to set
                them for.

                Last in the panel, under the photo, rather than under the form where
                they started: they are set once and then left, and a row of pickers
                between the search box and the answer put furniture in front of the
                thing the panel is for. The result is what you came to read, so it goes
                directly under what you typed.

                Speech has its own voice and rate rather than borrowing the
                Announcements panel's: a callsign spelled out in phonetics and a
                frequency read as a number are different jobs, and the speed that suits
                one is often not the speed that suits the other.

                There is no replay button. Asking for the callsign already on screen
                announces it again — see the early return in run() — so the search
                button beside the box is already the "once more" gesture, and a second
                control for it would duplicate the obvious. */}
            {!minimal && cw.mode === CALL_CW && (
                <div className="cs-cw">
                    <select
                        className="select"
                        value={cw.pitch}
                        aria-label="Announcer tone"
                        title="Sidetone pitch"
                        onChange={(e) => setCallAnnounce({ pitch: Number(e.target.value) })}
                    >
                        {TONE_PITCHES.map((hz) => <option key={hz} value={hz}>{hz} Hz</option>)}
                    </select>
                    <select
                        className="select"
                        value={cw.wpm}
                        aria-label="Announcer speed"
                        title="Words per minute"
                        onChange={(e) => setCallAnnounce({ wpm: Number(e.target.value) })}
                    >
                        {TONE_SPEEDS.map((w) => <option key={w} value={w}>{w} wpm</option>)}
                    </select>
                </div>
            )}

            {!minimal && cw.mode === CALL_TTS && (
                <div className="cs-cw">
                    <select
                        className="select cs-cw__voice"
                        value={cw.voice || ''}
                        aria-label="Announcer voice"
                        title="Which voice reads the callsign"
                        onChange={(e) => setCallAnnounce({ voice: e.target.value })}
                    >
                        {/* Automatic is the same preference order the receiver's own
                            announcements use — see pickVoice — and it names the voice
                            it landed on, so "automatic" is not a mystery. */}
                        <option value="">
                            {voices.length ? `Automatic — ${voices[0].name}` : 'Automatic'}
                        </option>
                        {voices.map((v) => (
                            <option key={v.name} value={v.name}>{v.name}</option>
                        ))}
                    </select>
                    <select
                        className="select cs-cw__rate"
                        value={cw.rate}
                        aria-label="Announcer speed"
                        title="Speaking rate"
                        onChange={(e) => setCallAnnounce({ rate: Number(e.target.value) })}
                    >
                        {TTS_RATES.map((r) => (
                            <option key={r} value={r}>{r.toFixed(1)}×</option>
                        ))}
                    </select>
                </div>
            )}

            {/* The v1 page, which carries the bio, the map and the QSL details
                this panel does not. Whatever is in the box goes with it.

                At the foot rather than in the form row, and named rather than an
                icon. It was a bare ↗ beside the search button, where it read as
                one more thing to do to the box you were typing in — and it is
                not that: it is the way *out* of the panel, to a second window.
                Down here it is where anything that leaves is, after the answer
                somebody came to read, and with a label saying where it goes,
                because a lookup page opening in a new window is not something to
                find out by trying an unmarked arrow. */}
            {!minimal && (
                <Button
                    size="sm"
                    variant="ghost"
                    className="cs-full"
                    icon={<Icon.External />}
                    title="Open the full callsign lookup page in a new window"
                    onClick={() => openCallsignLookup({
                        uuid: getSessionId(),
                        callsign: isValidCallsign(normaliseCallsign(entry)) ? entry : '',
                    })}
                >
                    Full Lookup
                </Button>
            )}
        </div>
    );
}
