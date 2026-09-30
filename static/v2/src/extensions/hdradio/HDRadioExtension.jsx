// HD Radio (NRSC-5) — the digital service on AM broadcast stations.
//
// Like DRM, what comes back is *audio*: the server runs ubersdr-hdradio and
// the program's audio arrives Opus-encoded, so much of this panel is DRM's
// playback chain. Two things set it apart:
//
//   * It needs no mode change. The server gives the decoder a private iq48
//     channel of its own on the listener's frequency (private_iq_channel.go),
//     so the receiver stays in whatever mode it is in — AM, usually — and
//     follows every retune. None of DRM's switch-to-IQ-and-back is here.
//   * An HD station says a great deal about itself: its name, slogan and
//     message, up to eight programs with what each is playing, album art and
//     a logo, where it is, its local time, its data services, its transmitter,
//     and emergency alerts. The minimal view shows what a car radio would; the
//     full view shows all of it — but only what has actually arrived. A field
//     the station has not sent is not drawn, not drawn empty.
//
// The analogue audio is the one on the receiver. While HD audio is playing it
// is ducked, which is what an HD receiver does; while the decoder is still
// acquiring, or during a dropout, it comes back, so there is never silence
// where there is a signal — "blend to analogue". The switch keeps it up under
// the HD audio too (they will not line up: the digital path runs seconds late).

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Icon, Switch } from '../../components/ui.jsx';
import CallsignMap from '../../components/CallsignMap.jsx';
import { getOpusDecoderClass } from '../../radio/audio-player.js';
import { countryFlag, formatHz } from '../../lib/format.js';
import { distanceBearing } from '../../lib/callsign.js';
import { dxcluster } from '../../radio/dxcluster-connection.js';
import { controlMessage } from '../protocol.js';
import { useAudioExtension } from '../useAudioExtension.js';
import {
    MAX_ART, MAX_PROGRAMS, SIGNAL_TIMEOUT_MS, STATUS_STALE_MS,
    alertAreas, decodeFrame, describeHereMap, formatBer, formatDevice, formatLeapSecond,
    pictureFor, programLabel, safeUrl, selectedProgram, stationClock, stationZone, stationText,
} from './frame.js';

const LEAD_IN_SEC = 0.02;
const ANALOGUE_KEY = 'ubersdr.hdradio.hearAnalogue';
// HERE traffic/weather maps kept, newest first.
const MAX_HERE_MAPS = 4;
// The North American AM channel raster; every HD AM station sits on it.
const AM_RASTER_HZ = 10000;

function readAnaloguePref() {
    try { return localStorage.getItem(ANALOGUE_KEY) === '1'; } catch (e) { return false; }
}

function writeAnaloguePref(on) {
    try { localStorage.setItem(ANALOGUE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
}

function objectUrl(bytes, mime) {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Blob === 'undefined') return null;
    // Copied: the bytes are a view onto a socket buffer that will be reused.
    return URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
}

function revoke(url) {
    if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

// The AM service modes: the primary service mode indicator nrsc5 reports.
function serviceModeLabel(psmi) {
    if (psmi === 1) return 'Hybrid (MA1)';
    if (psmi === 2) return 'All-digital (MA3)';
    return '';
}

// One row of the details: shown only with a value.
function Row({ k, children, title }) {
    if (children == null || children === '' || children === false) return null;
    return (
        <div className="kv" title={title}>
            <span className="kv__k">{k}</span>
            <span className="kv__v">{children}</span>
        </div>
    );
}

export default function HDRadioExtension({ minimal }) {
    const { running, audioState, tuning, player, audio, serverInfo } = useRadio();
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [signal, setSignal] = useState(false);
    const [frames, setFrames] = useState(0);
    const [status, setStatus] = useState(null);
    const [statusStale, setStatusStale] = useState(false);
    const [failure, setFailure] = useState(null);
    const [blocked, setBlocked] = useState(false);
    const [hearAnalogue, setHearAnalogue] = useState(readAnaloguePref);
    // The program asked for. The status says which one is playing; this is
    // what the picker shows until it does.
    const [program, setProgram] = useState(0);
    const programRef = useRef(0);
    // What the attach carries, fixed for a run: changing an attach parameter
    // re-attaches, and a restarted decoder takes seconds to lock again. Later
    // program changes go as set_program controls instead.
    const [startParams, setStartParams] = useState({ program: 0 });

    // Pictures, keyed as the status refers to them. Refs, with a counter to
    // re-render, since object URLs must be revoked when dropped and state
    // would make that awkward.
    const pics = useRef({ art: new Map(), logos: new Map(), here: [] });
    const [picsVersion, setPicsVersion] = useState(0);

    const a = useRef({
        decoder: null, rate: 0, channels: 0,
        chain: Promise.resolve(), nextPlayTime: 0,
        gain: null, ctx: null, signalTimer: null, staleTimer: null,
    });

    // ── pictures ────────────────────────────────────────────────────────────

    const clearPictures = useCallback(() => {
        const p = pics.current;
        p.art.forEach(revoke);
        p.logos.forEach(revoke);
        p.here.forEach((h) => revoke(h.url));
        p.art = new Map();
        p.logos = new Map();
        p.here = [];
        setPicsVersion((n) => n + 1);
    }, []);

    const addPicture = useCallback((image, bytes) => {
        const url = objectUrl(bytes, image.mime);
        if (!url) return;
        const p = pics.current;
        if (image.kind === 'art' && image.lot != null) {
            revoke(p.art.get(image.lot));
            p.art.delete(image.lot);
            p.art.set(image.lot, url);
            while (p.art.size > MAX_ART) {
                const oldest = p.art.keys().next().value;
                revoke(p.art.get(oldest));
                p.art.delete(oldest);
            }
        } else if (image.kind === 'logo') {
            const n = image.program != null ? image.program : 0;
            revoke(p.logos.get(n));
            p.logos.set(n, url);
        } else if (image.kind === 'traffic' || image.kind === 'weather') {
            p.here.unshift({ url, image });
            while (p.here.length > MAX_HERE_MAPS) revoke(p.here.pop().url);
        } else {
            revoke(url);
            return;
        }
        setPicsVersion((n) => n + 1);
    }, []);

    // A retune or a stop: what was known about the station no longer applies.
    const forgetStation = useCallback(() => {
        clearTimeout(a.current.staleTimer);
        setStatus(null);
        setStatusStale(false);
        clearPictures();
    }, [clearPictures]);

    // ── start / stop / program ──────────────────────────────────────────────

    const start = useCallback(() => {
        setFailure(null);
        setBlocked(false);
        setStartParams({ program: programRef.current });
        setDecoding(true);
    }, []);

    const stop = useCallback(() => setDecoding(false), []);

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // ── playback ────────────────────────────────────────────────────────────

    const ensureGain = useCallback(() => {
        const s = a.current;
        const ctx = player && player.ctx;
        if (!ctx) return null;
        if (s.gain && s.ctx === ctx) return s.gain;
        s.gain = ctx.createGain();
        s.gain.connect(ctx.destination);
        s.ctx = ctx;
        s.nextPlayTime = 0;
        return s.gain;
    }, [player]);

    useEffect(() => { if (decoding && live) ensureGain(); }, [decoding, live, ensureGain]);

    useEffect(() => {
        const s = a.current;
        if (!s.gain || !s.ctx) return;
        s.gain.gain.setTargetAtTime(audio.muted ? 0 : audio.volume, s.ctx.currentTime, 0.015);
    }, [audio.volume, audio.muted, decoding, live]);

    const play = useCallback(async (frame) => {
        const s = a.current;
        const ctx = player && player.ctx;
        if (!ctx) return;
        if (!s.decoder || s.rate !== frame.sampleRate || s.channels !== frame.channels) {
            const Decoder = getOpusDecoderClass();
            if (!Decoder) return;
            if (s.decoder) { try { s.decoder.free(); } catch (e) { /* ignore */ } }
            s.decoder = new Decoder({ sampleRate: frame.sampleRate, channels: frame.channels });
            await s.decoder.ready;
            s.rate = frame.sampleRate;
            s.channels = frame.channels;
        }
        const decoded = await s.decoder.decodeFrame(frame.opus);
        if (!decoded || !decoded.samplesDecoded) return;
        const gain = ensureGain();
        if (!gain) return;
        const rate = decoded.sampleRate || frame.sampleRate;
        const buffer = ctx.createBuffer(decoded.channelData.length, decoded.samplesDecoded, rate);
        for (let ch = 0; ch < decoded.channelData.length; ch++) buffer.copyToChannel(decoded.channelData[ch], ch);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(gain);
        const now = ctx.currentTime;
        if (s.nextPlayTime < now) s.nextPlayTime = now + LEAD_IN_SEC;
        src.start(s.nextPlayTime);
        s.nextPlayTime += buffer.duration;
    }, [player, ensureGain]);

    const onResult = (msg) => {
        if (msg.kind === 'status') {
            setStatus(msg.status);
            setStatusStale(false);
            clearTimeout(a.current.staleTimer);
            a.current.staleTimer = setTimeout(() => setStatusStale(true), STATUS_STALE_MS);
            return;
        }
        if (msg.kind === 'image') {
            addPicture(msg.image, msg.bytes);
            return;
        }
        const s = a.current;
        // Copied: the decode is asynchronous and the socket reuses the buffer.
        const frame = { ...msg, opus: msg.opus.slice() };
        s.chain = s.chain.then(() => play(frame)).catch(() => { /* one bad frame */ });
        setFrames((n) => n + 1);
        setSignal(true);
        clearTimeout(s.signalTimer);
        s.signalTimer = setTimeout(() => setSignal(false), SIGNAL_TIMEOUT_MS);
    };

    const sendProgram = (p) => dxcluster.send(controlMessage('set_program', { program: p }));

    const onEvent = (ev) => {
        if (ev.kind === 'attached') {
            // A re-attach (after a reconnect) starts the decoder on the
            // program it was first attached with; put it back on this one.
            if (programRef.current !== startParams.program) sendProgram(programRef.current);
        } else if (ev.kind === 'retuned') {
            forgetStation();
            setBlocked(!!ev.blocked);
        }
    };

    const { state: attachState, error } = useAudioExtension({
        name: 'hdradio',
        params: startParams,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
        onEvent,
    });

    const choose = useCallback((p) => {
        if (p < 0 || p >= MAX_PROGRAMS) return;
        programRef.current = p;
        setProgram(p);
        if (attachState === 'running') sendProgram(p);
    }, [attachState]);

    // The hook reports 'error' only once it has given up retrying.
    useEffect(() => {
        if (attachState !== 'error') return;
        setFailure(error || 'The decoder stopped unexpectedly.');
        setDecoding(false);
    }, [attachState, error]);

    // Duck the analogue only while HD audio is actually playing.
    useEffect(() => {
        if (!player) return undefined;
        player.setDucked(decoding && live && signal && !hearAnalogue);
        return () => player.setDucked(false);
    }, [player, decoding, live, signal, hearAnalogue]);

    const toggleAnalogue = useCallback((on) => {
        setHearAnalogue(on);
        writeAnaloguePref(on);
    }, []);

    useEffect(() => {
        if (decoding) return undefined;
        const s = a.current;
        clearTimeout(s.signalTimer);
        setSignal(false);
        setBlocked(false);
        forgetStation();
        if (s.decoder) {
            try { s.decoder.free(); } catch (e) { /* ignore */ }
            s.decoder = null;
            s.rate = 0;
            s.channels = 0;
        }
        s.nextPlayTime = 0;
        return undefined;
    }, [decoding, forgetStation]);

    useEffect(() => () => {
        const s = a.current;
        clearTimeout(s.signalTimer);
        clearTimeout(s.staleTimer);
        if (s.decoder) { try { s.decoder.free(); } catch (e) { /* ignore */ } }
        if (s.gain) { try { s.gain.disconnect(); } catch (e) { /* ignore */ } }
        const p = pics.current;
        p.art.forEach(revoke);
        p.logos.forEach(revoke);
        p.here.forEach((h) => revoke(h.url));
    }, []);

    // The station's clock ticks while it is shown.
    const [now, setNow] = useState(() => Date.now());
    const showClock = !minimal && !!(status && status.localTime);
    useEffect(() => {
        if (!showClock) return undefined;
        const t = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(t);
    }, [showClock]);

    return (
        <HDRadioView
            minimal={minimal}
            running={running}
            live={live}
            decoding={decoding}
            attachState={attachState}
            problem={attachState === 'error' ? error : failure}
            status={status}
            statusStale={statusStale}
            signal={signal}
            frames={frames}
            blocked={blocked}
            program={program}
            onChoose={choose}
            hearAnalogue={hearAnalogue}
            onToggleAnalogue={toggleAnalogue}
            onStart={start}
            onStop={stop}
            pictures={pics.current}
            picturesVersion={picsVersion}
            tuning={tuning}
            serverInfo={serverInfo}
            now={now}
        />
    );
}

/**
 * Everything the panel draws, from values alone: no socket, no timers, so the
 * tests can render it with any status at all. pictures is { art: Map lot → url,
 * logos: Map program → url, here: [{ url, image }] }; picturesVersion changes
 * whenever they do.
 */
export function HDRadioView({
    minimal, running, live, decoding, attachState, problem, status, statusStale, signal, frames,
    blocked, program, onChoose, hearAnalogue, onToggleAnalogue, onStart, onStop,
    pictures, picturesVersion, tuning, serverInfo, now,
}) {
    const st = status || {};
    const programs = useMemo(
        () => (Array.isArray(st.programs) ? [...st.programs].sort((x, y) => x.program - y.program) : []),
        [status],
    );
    const playing = typeof st.program === 'number' ? st.program : program;
    const sel = selectedProgram(status) || null;
    // The picker offers what the station carries, and the one asked for even
    // if it does not (so the choice is visible, and can be undone).
    const choices = useMemo(() => {
        const set = new Set(programs.map((p) => p.program));
        set.add(program);
        return [...set].sort((x, y) => x - y);
    }, [programs, program]);
    const typeOf = (n) => {
        const p = programs.find((q) => q.program === n);
        return p ? stationText(p.typeName) : '';
    };

    const picture = useMemo(
        () => pictureFor(sel || { program: playing }, pictures.art, pictures.logos),
        [sel, playing, pictures, picturesVersion],
    );

    const name = stationText(st.name);
    const slogan = stationText(st.slogan);
    const message = stationText(st.message);
    const alert = stationText(st.alert);
    const title = sel ? stationText(sel.title) : '';
    const artist = sel ? stationText(sel.artist) : '';
    const album = sel ? stationText(sel.album) : '';

    const rxGps = serverInfo && serverInfo.receiver && serverInfo.receiver.gps;
    const rx = rxGps && (rxGps.lat || rxGps.lon)
        ? { lat: rxGps.lat, lon: rxGps.lon, label: (serverInfo.receiver.callsign) || 'Receiver' }
        : null;
    const loc = st.location && Number.isFinite(st.location.lat) && Number.isFinite(st.location.lon) ? st.location : null;
    const db = loc && rx ? distanceBearing(rx.lat, rx.lon, loc.lat, loc.lon) : null;

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));
    const synced = !!st.sync;
    const offRaster = tuning.frequency % AM_RASTER_HZ !== 0;

    const signalLabel = signal ? 'HD audio' : (synced ? 'HD locked' : 'No HD signal');
    const signalTitle = signal
        ? 'HD audio is playing'
        : (synced ? 'Locked to the digital signal; waiting for this program\'s audio' : 'No HD Radio signal decoded yet');

    const comments = sel && Array.isArray(sel.comments) ? sel.comments.filter((c) => stationText(c.text)) : [];
    const sale = sel && sel.commercial ? sel.commercial : null;
    const saleUrl = sale ? safeUrl(sale.contactUrl) : '';
    const services = Array.isArray(st.dataServices) ? st.dataServices : [];
    const categories = Array.isArray(st.alertCategories) ? st.alertCategories.filter(Boolean) : [];
    const areas = alertAreas(status);
    const here = pictures.here;

    const programBits = sel ? [
        stationText(sel.typeName),
        stationText(sel.serviceName),
        sel.access === 'restricted' ? 'restricted' : '',
        stationText(sel.surround),
    ].filter(Boolean).join(' · ') : '';

    return (
        <div className={`tp hd${minimal ? ' hd--min' : ''}`}>
            <div className="tp__bar">
                <span className={`tp__status tp__status--${statusTone}`} title="Whether the decoder is running on the server">
                    {statusLabel}
                </span>
                <span className={`fdv__signal${signal ? ' is-on' : ''}`} title={signalTitle}>
                    {signalLabel}
                </span>
                <span className="tp__bar-gap" />
                <Switch
                    checked={hearAnalogue}
                    onChange={onToggleAnalogue}
                    label={minimal ? null : 'Analogue too'}
                    title={hearAnalogue
                        ? 'The analogue audio stays up under the HD audio — they will not line up, the digital path runs seconds late'
                        : 'The analogue audio is muted while HD audio plays, and comes back while it is acquiring or drops out'}
                />
                {decoding
                    ? (
                        <Button size="sm" onClick={onStop} icon={<Icon.Stop size={13} />} title="Stop decoding">
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={onStart}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? 'Decode the HD Radio signal on this frequency'
                                : 'Start the receiver first — the decoder follows your tuning'}
                        >
                            Start
                        </Button>
                    )}
            </div>

            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && (
                <div className="note note--tight">
                    Tune to an HD Radio AM station's carrier and press Start. Your mode is left as it is.
                </div>
            )}
            {problem && <div className="note note--warn">{problem}</div>}
            {decoding && blocked && (
                <div className="note note--warn">This frequency is blocked on this receiver — tune elsewhere to decode.</div>
            )}
            {decoding && !blocked && attachState === 'running' && !synced && !minimal && (
                <div className="note note--tight">
                    Acquiring… an HD signal takes about ten seconds to lock.
                    {offRaster && ` Tune to the carrier: ${formatHz(tuning.frequency)} is off the 10 kHz channel raster.`}
                </div>
            )}
            {decoding && statusStale && attachState === 'running' && (
                <div className="note note--warn">The decoder has stopped reporting — what is shown may be out of date.</div>
            )}

            {decoding && alert && (
                <div className="hd__alert" role="alert">
                    <div className="hd__alert-head">
                        {`Alert${categories.length ? ` · ${categories.join(', ')}` : ''}`}
                    </div>
                    <div className="hd__alert-text">{alert}</div>
                    {!minimal && areas && <div className="hd__alert-areas">{areas}</div>}
                </div>
            )}

            {decoding && (
                <div className={`hd__id${statusStale ? ' is-stale' : ''}`}>
                    {picture && (
                        <img
                            className={`hd__pic hd__pic--${picture.kind}`}
                            src={picture.url}
                            alt={picture.kind === 'art' ? 'Album art' : 'Station logo'}
                        />
                    )}
                    <div className="hd__who">
                        <div className="hd__name">
                            {name || <span className="hd__waiting">{synced ? 'Station identified shortly…' : 'Searching…'}</span>}
                            {st.country && (
                                <span className="hd__flag" title={st.country}>{countryFlag(st.country) || st.country}</span>
                            )}
                        </div>
                        {!minimal && slogan && <div className="hd__slogan">{slogan}</div>}
                        {(title || artist) && (
                            <div className="hd__now">
                                {title && <span className="hd__title">{title}</span>}
                                {artist && <span className="hd__artist">{artist}</span>}
                                {!minimal && album && <span className="hd__album">{album}</span>}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {decoding && choices.length > 0 && (programs.length > 1 || program !== 0) && (
                <div className="chip-row chip-row--wrap hd__programs">
                    {choices.map((n) => (
                        <button
                            type="button"
                            key={n}
                            className={`chip chip--button${n === playing ? ' is-active' : ''}`}
                            onClick={() => onChoose(n)}
                            title={typeOf(n) ? `${programLabel(n)} — ${typeOf(n)}` : programLabel(n)}
                        >
                            {`${programLabel(n)}${!minimal && typeOf(n) ? ` ${typeOf(n)}` : ''}`}
                        </button>
                    ))}
                </div>
            )}

            {decoding && !minimal && message && <div className="hd__message">{message}</div>}

            {decoding && !minimal && (
                <div className="kv-list hd__details">
                    <Row k={sel ? programLabel(sel.program) : 'Program'}>{programBits}</Row>
                    <Row k="Genre">{sel ? stationText(sel.genre) : ''}</Row>
                    {comments.map((c, i) => (
                        <Row key={`c${i}`} k={stationText(c.desc) || 'Comment'}>{stationText(c.text)}</Row>
                    ))}
                    {sale && (stationText(sale.price) || stationText(sale.seller) || saleUrl) && (
                        <Row k="For sale">
                            <span>
                                {[stationText(sale.price), stationText(sale.seller), stationText(sale.description)].filter(Boolean).join(' · ')}
                                {saleUrl && ' · '}
                                {saleUrl && <a href={saleUrl} target="_blank" rel="noopener noreferrer nofollow">link</a>}
                                {stationText(sale.validUntil) && ` (until ${stationText(sale.validUntil)})`}
                            </span>
                        </Row>
                    )}
                    <Row k="Facility" title="The station's FCC facility ID">
                        {st.facilityId != null ? `${st.country ? `${st.country} ` : ''}${st.facilityId}` : ''}
                    </Row>
                    <Row k="Local time" title="The station's own clock, from its broadcast time zone">
                        {st.localTime ? `${stationClock(st.localTime, now)} ${stationZone(st.localTime)}` : ''}
                    </Row>
                    <Row k="Location">
                        {loc ? `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}${loc.alt ? ` · ${loc.alt} m` : ''}` : ''}
                    </Row>
                    <Row k="Distance" title="From this receiver">
                        {db ? `${db.distKm.toLocaleString()} km · ${db.bearing}°` : ''}
                    </Row>
                    <Row k="Services" title="The station's data services">
                        {services.length
                            ? services.map((s) => stationText(s.typeName) || stationText(s.mime)).filter(Boolean).join(' · ')
                            : ''}
                    </Row>
                    <Row k="Exciter" title="The transmitter's HD exciter">{formatDevice(st.exciter)}</Row>
                    <Row k="Importer" title="The studio-side HD importer">
                        {formatDevice(st.importer) || (st.importerConnected === false ? 'not connected' : '')}
                    </Row>
                    <Row k="Time">{formatLeapSecond(st.leapSecond)}</Row>
                    <Row k="Mode" title="The station's primary service mode">{serviceModeLabel(st.psmi)}</Row>
                    <Row k="Signal" title="Bit error rate of the known reference bits, and the carrier's offset from your tuning">
                        {synced
                            ? [formatBer(st.ber) && `BER ${formatBer(st.ber)}`,
                                typeof st.freqOffset === 'number' ? `${st.freqOffset > 0 ? '+' : ''}${st.freqOffset.toFixed(1)} Hz` : '']
                                .filter(Boolean).join(' · ')
                            : ''}
                    </Row>
                    <Row k="Audio frames" title="Decoded and failed audio frames for this program">
                        {sel && sel.frames ? `${sel.frames.toLocaleString()}${sel.errors ? ` (${sel.errors} errors)` : ''}` : ''}
                    </Row>
                </div>
            )}

            {decoding && !minimal && loc && (
                <CallsignMap
                    call={name || 'Station'}
                    position={{ lat: loc.lat, lon: loc.lon }}
                    from={rx}
                    className="csmap--inline"
                />
            )}

            {decoding && !minimal && here.length > 0 && (
                <div className="hd__here">
                    {here.map((h) => (
                        <figure key={h.url} className="hd__here-map">
                            <img src={h.url} alt={describeHereMap(h.image)} />
                            <figcaption>{describeHereMap(h.image)}</figcaption>
                        </figure>
                    ))}
                </div>
            )}

            {!minimal && (
                <div className="tp__controls">
                    <span className="tp__bar-gap" />
                    <span className="fdv__stat" title="HD audio frames played this session">{frames.toLocaleString()} frames</span>
                    <span className="fdv__stat" title="What the receiver is tuned to">
                        {formatHz(tuning.frequency)} {tuning.mode.toUpperCase()}
                    </span>
                </div>
            )}
        </div>
    );
}
