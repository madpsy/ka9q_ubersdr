// Speech-to-Text — v1's whisper extension, rebuilt for v2.
//
// The server streams the session's audio to a WhisperLive instance and sends
// the transcription back as it firms up (see ./frames.js for the wire format
// and, more importantly, for why the last line is provisional). Everything here
// follows from that one property: the console is a list of settled lines plus a
// live line that is rewritten in place, and anything that consumes the
// transcript — the clipboard, the file, the speech synthesiser, the summariser
// — works from the settled ones.
//
// What it does beyond showing text, and why each is here:
//
//   * **Reads it aloud.** Not a gimmick on a receiver: the point is to leave a
//     frequency running and hear what was said without watching a window. The
//     receiver's own audio is ducked while it speaks, so the two do not talk
//     over each other. See ./useSpeech.js and ./speech.js.
//   * **Summarises.** An hour of a net is a lot of text; the operator can
//     configure a summariser (`whisper.summary_url`) and this asks it for one.
//   * **Translates.** The language menu is the *output* language — Whisper
//     answers in English and the server runs that through LibreTranslate. See
//     ./languages.js, which is also why the menu is not "recognise as…".
//   * **Floats a caption box.** v1's "Show modal": the live line over the whole
//     page, movable and resizable, and — the reason it cannot just be the
//     minimal view — still there when this window is minimised. See
//     ./Caption.jsx.
//
// Two things v1 had are not here, and are called out rather than dropped
// quietly:
//
//   * The **Firefox voice-quality modal**, a per-session dialog sniffing the
//     user agent to say another browser sounds better. The real failure — a
//     browser with no voices installed at all — is a note beside the control.
//   * The **stop/start on retune**. v1 tore the decoder down for three seconds
//     whenever the dial moved. The server grew a `reset_transcript` control for
//     exactly this case, so retuning now clears the transcript and the server's
//     duplicate-suppression history without a gap in decoding. The one thing
//     the restart also did was flush WhisperLive's rolling audio buffer, so for
//     a few seconds after a retune the tail of the previous frequency can still
//     be transcribed.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Modal, Segmented, Slider, Switch } from '../../components/ui.jsx';
import { dxcluster } from '../../radio/dxcluster-connection.js';
import { controlMessage } from '../protocol.js';
import { useAudioExtension } from '../useAudioExtension.js';
import { AudioLevel } from '../TeleprinterUI.jsx';
import Caption from './Caption.jsx';
import {
    EMPTY, LINE_LIMITS, VIEWS, allSegments, applySegments, boldParts, decodeFrame,
    formatClock, formatSince, saveFilename, toText, visibleSegments,
} from './frames.js';
import { LANGUAGE_MENU, languageName } from './languages.js';
import { RATE, preferredVoice, voiceForLanguage, voiceGroups } from './speech.js';
import { useSpeech } from './useSpeech.js';

// Text size of the console, in px. v1's range and starting point. The console
// doubles as a caption display in the minimal view, where the whole point is
// reading it from across a room.
const FONT = { min: 8, max: 32, step: 2, default: 13 };

// Settled lines drawn by default. v1 showed ten, which is a workaround for the
// cost of the DOM it rebuilt on every decode rather than a judgement about how
// much scrollback a transcript wants; this list is reconciled, not rebuilt. The
// cap is a display choice either way — the clipboard, the file and the summary
// always take everything.
const DEFAULT_LIMIT = 100;

// How long after the dial stops moving before the transcript is reset. Long
// enough that spinning through a band is one reset rather than fifty, short
// enough to have happened by the time anybody has been listening.
const RETUNE_SETTLE_MS = 1200;

// A summary is an HTTP round trip to a language model on the operator's own
// infrastructure; a minute is generous for one and still short of "this is
// never going to answer".
const SUMMARY_TIMEOUT_MS = 60000;

// Modes speech can arrive in. CW is not among them, and transcribing it
// produces confident nonsense rather than nothing.
const VOICE_MODES = ['usb', 'lsb', 'am', 'sam', 'nfm', 'fm'];

// The one error the server sends that means the transcriber itself has failed
// rather than something asked of it — see sendErrorToFrontend's callers in
// audio_extensions/whisper/decoder.go.
const FATAL_ERROR = /^connection failed/i;

/**
 * The transcript.
 *
 * Its own component and memoised: the "last heard" clock ticks every second and
 * the speech state changes on every sentence, either of which would otherwise
 * reconcile a couple of hundred lines for nothing.
 */
const Transcript = memo(function Transcript({ segments, timestamps, autoScroll, font, empty }) {
    const box = useRef(null);

    // Newest is at the bottom — a transcript reads downwards — so following it
    // means keeping the bottom in view.
    useEffect(() => {
        if (!autoScroll || !box.current) return;
        box.current.scrollTop = box.current.scrollHeight;
    }, [segments, autoScroll]);

    return (
        <div className="tp__console stt__lines" ref={box} style={{ fontSize: `${font}px` }}>
            {segments.length === 0 && <Empty>{empty}</Empty>}
            {segments.map((s) => (
                <div key={s.id} className={`tp__line stt__line${s.completed ? '' : ' stt__line--live'}`}>
                    {timestamps && <span className="tp__line-at">{formatClock(s.at)}</span>}
                    <span className="tp__line-text">{s.text}</span>
                </div>
            ))}
        </div>
    );
});

/** The summary, once the server has answered — or the spinner while it has not. */
function SummaryModal({ summary, onClose }) {
    const [copied, setCopied] = useState(false);
    const lines = summary.requested === 1 ? 'line' : 'lines';

    const copy = () => {
        if (!summary.text || !navigator.clipboard) return;
        navigator.clipboard.writeText(summary.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }, () => { /* a refused clipboard is not worth an error state */ });
    };

    return (
        <Modal onClose={onClose} label="Transcript summary">
            <div className="stack stt-sum">
                <h2 className="stt-sum__title">Summary</h2>

                {summary.state === 'waiting' && (
                    <div className="stt-sum__wait">
                        <span className="stt-sum__spinner" />
                        <span>Summarising {summary.requested} {lines}…</span>
                    </div>
                )}

                {summary.state === 'error' && <div className="note note--warn">{summary.error}</div>}

                {summary.state === 'ready' && (
                    <>
                        <div className="stt-sum__meta">
                            {summary.used} of {summary.requested} {lines} summarised
                            {summary.language ? ` · ${languageName(summary.language)}` : ''}
                        </div>
                        <p className="stt-sum__text">
                            {boldParts(summary.text).map((p, i) => (p.bold
                                ? <strong key={i}>{p.text}</strong>
                                : <React.Fragment key={i}>{p.text}</React.Fragment>))}
                        </p>
                        <div className="row-end">
                            <Button size="sm" variant="ghost" onClick={copy} active={copied} icon={<Icon.Copy size={13} />}>
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

// `minimal` keeps the transport, the view filter, the text size, the caption
// toggle and the transcript, and drops the settings, the switches, the speech
// controls and the audio level. What survives is what you need with the window
// shrunk into a corner: is it running, how big is the text, and where is the
// caption box. See the registry's `minimal`.
export default function WhisperExtension({ minimal }) {
    const { running, audioState, tuning, serverInfo, player } = useRadio();
    // Attaching needs the audio session, not merely the power switch — see the
    // note on the same line in FT8Extension.jsx.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [language, setLanguage] = useState('en');
    const [transcript, setTranscript] = useState(EMPTY);
    const [detected, setDetected] = useState(null);
    const [failure, setFailure] = useState(null);
    const [lastAt, setLastAt] = useState(null);
    const [tick, setTick] = useState(0);
    const [copied, setCopied] = useState(false);
    const [summary, setSummary] = useState(null);
    const [font, setFont] = useState(FONT.default);
    const [caption, setCaption] = useState(false);
    const [opts, setOpts] = useState({
        view: 'all', limit: DEFAULT_LIMIT, timestamps: false, autoScroll: true,
    });
    const [tts, setTts] = useState({ on: false, voice: '', rate: RATE.default, duck: true });

    // When the transcriber attached, which is what a segment's `start` is
    // measured from, and when the session began, which is what the saved file is
    // named after. Refs, because they are read as a frame arrives and nothing
    // renders from them.
    const base = useRef(null);
    const startedAt = useRef(null);

    const speech = useSpeech({
        enabled: tts.on,
        voiceName: tts.voice,
        rate: tts.rate,
        // Whatever the transcript is delivered in, which is the output language
        // rather than the one being spoken on the air.
        lang: language,
    });
    const speakNow = speech.speak;
    const stopSpeaking = speech.stop;

    // Everything onResult touches goes through a ref: useAudioExtension holds
    // the callback in one, so the closure it calls is the first one it saw.
    const transcriptRef = useRef(EMPTY);
    const speakRef = useRef(null);
    speakRef.current = tts.on ? speakNow : null;
    const summaryRef = useRef(false);
    summaryRef.current = !!summary;
    // Read by `clear`, which has to stay referentially stable — the retune
    // timer below depends on it, and a callback that changed identity every
    // render would cancel and restart that timer for ever, so it would never
    // fire.
    const attachRef = useRef('idle');

    const apply = useCallback((next) => {
        transcriptRef.current = next;
        setTranscript(next);
    }, []);

    const onResult = (frame) => {
        switch (frame.kind) {
            case 'segments': {
                const { state, settled } = applySegments(transcriptRef.current, frame.segments, base.current);
                apply(state);
                // Only settled text is spoken: the live line is rewritten as the
                // transcriber changes its mind, and reading each revision would
                // repeat half of every sentence.
                if (speakRef.current) for (const s of settled) speakRef.current(s.text);
                setLastAt(Date.now());
                break;
            }
            case 'language':
                setDetected(frame.code ? { code: frame.code, prob: frame.prob } : null);
                break;
            case 'summary':
                setSummary({
                    state: 'ready',
                    text: frame.text,
                    used: frame.used,
                    requested: frame.requested,
                    language: frame.language,
                    error: '',
                });
                break;
            case 'error':
                // The server spells a failed summary and a dead upstream
                // connection the same way, so a pending summary claims the
                // message — it is the one that was asked for. A connection
                // failure is fatal either way and stops the transcriber.
                if (FATAL_ERROR.test(frame.error)) {
                    setFailure(frame.error);
                    setDecoding(false);
                }
                if (summaryRef.current) {
                    setSummary((s) => (s ? { ...s, state: 'error', error: frame.error } : s));
                } else if (!FATAL_ERROR.test(frame.error)) {
                    setFailure(frame.error);
                }
                break;
            default:
                break;
        }
    };

    const onEvent = (ev) => {
        // The stream's clock starts here, and starts again on every re-attach —
        // changing the output language is one, since the server takes it at
        // creation. Stamping arriving segments against the base in force at the
        // time is what keeps the lines already on screen at the time they were
        // spoken.
        if (ev.kind !== 'attached') return;
        base.current = Date.now();
        if (startedAt.current == null) startedAt.current = base.current;
        setFailure(null);
    };

    const params = useMemo(() => ({ language }), [language]);

    const { state: attachState, error } = useAudioExtension({
        name: 'whisper',
        params,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
        onEvent,
    });
    attachRef.current = attachState;

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // Stopping ends the session: the next start is a new stream with a clock of
    // its own, and a half-spoken sentence must not carry over into it.
    useEffect(() => {
        if (decoding) return;
        base.current = null;
        startedAt.current = null;
        setLastAt(null);
        setDetected(null);
        stopSpeaking();
    }, [decoding, stopSpeaking]);

    // The "last heard" readout counts up on its own, so it needs a clock of its
    // own — nothing else changes while a frequency is silent, which is exactly
    // when it is worth reading.
    useEffect(() => {
        if (!decoding || lastAt == null) return undefined;
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [decoding, lastAt]);

    // Silence the receiver while it is being read out, rather than pressing the
    // user's mute button as v1 did: a duck is a gate on the output alone, so the
    // mute button still means what it says, the volume control still works, and
    // the recorder still captures the receiver's audio. Same mechanism FreeDV
    // uses to play over the top.
    useEffect(() => {
        if (!player) return undefined;
        player.setDucked(tts.on && tts.duck && speech.speaking);
        return () => player.setDucked(false);
    }, [player, tts.on, tts.duck, speech.speaking]);

    // A voice for the language being delivered, chosen once the browser lists
    // its voices — they load asynchronously and are usually absent on the first
    // read — and again when the language changes. Never over a choice already
    // made by hand, which is what `handPicked` records; changing the language is
    // a new answer to "which voice", so it clears that.
    const handPicked = useRef(false);
    useEffect(() => {
        if (!speech.voices.length || handPicked.current) return;
        const pick = language === 'en'
            ? preferredVoice(speech.voices) || voiceForLanguage(speech.voices, 'en')
            : voiceForLanguage(speech.voices, language);
        if (!pick) return;
        setTts((t) => (t.voice === pick.name ? t : { ...t, voice: pick.name }));
    }, [speech.voices, language]);

    const setOpt = (patch) => setOpts((prev) => ({ ...prev, ...patch }));

    const clear = useCallback((alsoServer) => {
        apply(EMPTY);
        stopSpeaking();
        // The server suppresses a completed line whose text it has already sent,
        // for as long as the attach lives — so without this, clearing the screen
        // and hearing the same announcement again would show nothing.
        //
        // Only while attached: the server answers a control message with no
        // extension behind it with an `audio_extension_error`, which the hook
        // would surface as a decoder failure the user has to read and dismiss.
        if (alsoServer && attachRef.current === 'running' && dxcluster.connected) {
            dxcluster.send(controlMessage('reset_transcript'));
        }
    }, [apply, stopSpeaking]);

    // Retuning means a different station, so the transcript so far belongs to
    // somewhere else — and the server's duplicate suppression, which is what
    // stops a repeated announcement being shown twice, would otherwise take the
    // new station's first words for a repeat of the old one's.
    const dial = tuning.frequency;
    const lastDial = useRef(dial);
    useEffect(() => {
        if (lastDial.current === dial) return undefined;
        lastDial.current = dial;
        if (!decoding) return undefined;
        const id = setTimeout(() => clear(true), RETUNE_SETTLE_MS);
        return () => clearTimeout(id);
    }, [dial, decoding, clear]);

    const everything = useMemo(() => allSegments(transcript), [transcript]);
    const lastLine = everything.length ? everything[everything.length - 1].text : '';
    const rows = useMemo(
        () => visibleSegments(transcript, opts.view, opts.limit),
        [transcript, opts.view, opts.limit],
    );
    const text = useMemo(() => toText(everything, opts.timestamps), [everything, opts.timestamps]);
    // `tick` is what makes this recompute every second; its value is not used.
    const since = useMemo(
        () => (lastAt == null ? null : formatSince(Date.now() - lastAt)),
        [lastAt, tick],
    );

    const copy = () => {
        if (!text || !navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }, () => { /* a refused clipboard is not worth an error state */ });
    };

    const save = () => {
        const last = everything.length ? everything[everything.length - 1].at : Date.now();
        const name = saveFilename({
            callsign: (serverInfo && serverInfo.receiver && serverInfo.receiver.callsign) || '',
            frequency: tuning.frequency,
            mode: tuning.mode,
            from: startedAt.current == null ? last : startedAt.current,
            to: last,
        });
        const blob = new Blob([`${text}\n`], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // The server summarises the last n *settled* lines it has kept, so the count
    // asked for is the count we have — it caps that against its own buffer and
    // says in the reply how many it actually used.
    const summarise = () => {
        const n = transcript.done.length;
        if (!n || !dxcluster.connected) return;
        setSummary({ state: 'waiting', text: '', used: 0, requested: n, language: '', error: '' });
        dxcluster.send(controlMessage('summary_request', { n_segments: n }));
    };

    // A summariser that never answers must not leave a spinner up for the rest
    // of the session: the request is fire-and-forget, so nothing else would ever
    // close it.
    useEffect(() => {
        if (!summary || summary.state !== 'waiting') return undefined;
        const id = setTimeout(() => setSummary((s) => (s && s.state === 'waiting'
            ? { ...s, state: 'error', error: 'The summariser did not answer.' }
            : s)), SUMMARY_TIMEOUT_MS);
        return () => clearTimeout(id);
    }, [summary]);

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    const groups = useMemo(() => voiceGroups(speech.voices), [speech.voices]);

    let emptyText = 'Tune to a voice transmission and press Start.';
    if (opts.view === 'live' && transcript.done.length) emptyText = 'Nothing being decoded at the moment.';
    else if (decoding) {
        emptyText = attachState === 'running'
            ? 'Listening — nothing transcribed yet.'
            : 'Starting the transcriber…';
    }

    return (
        <div className="tp stt">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title="Whether the transcriber is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>

                {!minimal && detected && (
                    <span
                        className="stt__detected"
                        title="The language Whisper believes it is hearing, and how sure it is. That is what was spoken — not what the transcript is delivered in"
                    >
                        {languageName(detected.code)}
                        {detected.prob != null && ` ${Math.round(detected.prob * 100)}%`}
                    </span>
                )}

                <span className="tp__bar-gap" />

                <Segmented size="sm" options={VIEWS} value={opts.view} onChange={(v) => setOpt({ view: v })} />

                {/* In the bar rather than among the switches below, because it
                    has to be reachable from the minimal view: the caption box
                    is what you use *instead* of watching this window. */}
                <Button
                    size="sm"
                    variant="ghost"
                    active={caption}
                    onClick={() => setCaption((c) => !c)}
                    icon={<Icon.Captions size={13} />}
                    title="Float the line being spoken over the whole page, movable and resizable. It stays on screen when this window is minimised"
                />

                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFont((f) => Math.max(FONT.min, f - FONT.step))}
                    disabled={font <= FONT.min}
                    icon={<Icon.Minus size={13} />}
                    title="Smaller text"
                />
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFont((f) => Math.min(FONT.max, f + FONT.step))}
                    disabled={font >= FONT.max}
                    icon={<Icon.Plus size={13} />}
                    title="Larger text"
                />

                {decoding
                    ? (
                        <Button
                            size="sm"
                            onClick={() => setDecoding(false)}
                            icon={<Icon.Stop size={13} />}
                            title="Stop transcribing and release the transcriber on the server"
                        >
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setDecoding(true)}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? 'Start transcribing the audio this receiver is tuned to'
                                : 'Start the receiver first — the transcriber runs on your audio session'}
                        >
                            Start
                        </Button>
                    )}

                {!minimal && (
                    <>
                        <Button size="sm" variant="ghost" onClick={copy} disabled={!everything.length} active={copied} icon={<Icon.Copy size={13} />} title="Copy the whole transcript to the clipboard" />
                        <Button size="sm" variant="ghost" onClick={save} disabled={!everything.length} icon={<Icon.Download size={13} />} title="Download the whole transcript as a text file" />
                        <Button size="sm" variant="ghost" onClick={() => clear(true)} disabled={!everything.length} icon={<Icon.Trash size={13} />} title="Clear the transcript, and let the server send a repeated line again" />
                    </>
                )}
            </div>

            {!minimal && (
            <div className="tp__config">
                <label
                    className="tp__field"
                    title="The language the transcript is delivered in. Whisper transcribes to English and the server translates that, so English means no translation at all. Changing it restarts the transcriber"
                >
                    <span className="tp__field-label">Language</span>
                    <select
                        className="select stt__lang"
                        value={language}
                        onChange={(e) => { handPicked.current = false; setLanguage(e.target.value); }}
                    >
                        {LANGUAGE_MENU.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                    </select>
                </label>

                <label
                    className="tp__field"
                    title="How many settled lines to keep on screen. Everything is still copied, saved and summarised — this is only what is drawn"
                >
                    <span className="tp__field-label">Show</span>
                    <select
                        className="select stt__limit"
                        value={String(opts.limit)}
                        onChange={(e) => setOpt({ limit: Number(e.target.value) })}
                    >
                        {LINE_LIMITS.map((l) => <option key={l.value} value={String(l.value)}>{l.label}</option>)}
                    </select>
                </label>

                <Button
                    size="sm"
                    variant="ghost"
                    onClick={summarise}
                    disabled={!transcript.done.length || attachState !== 'running'}
                    icon={<Icon.List size={13} />}
                    title={transcript.done.length
                        ? 'Ask the server to summarise the transcript so far'
                        : 'Nothing to summarise yet — a line has to finish decoding first'}
                >
                    Summarise
                </Button>

                <span className="tp__bar-gap" />

                <span
                    className="stt__since"
                    title="How long since anything was transcribed. Transcription is silent when nobody is speaking, so this is the sign that it is still running"
                >
                    {decoding && since ? `Last heard ${since} ago` : '—'}
                </span>
            </div>
            )}

            {!minimal && !running && <div className="note note--tight">Start the receiver to transcribe.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {/* The transcriber takes whatever audio the session produces, so a
                mode carrying no speech does not fail — it invents words. */}
            {decoding && !VOICE_MODES.includes(tuning.mode) && (
                <div className="note note--warn">
                    {String(tuning.mode).toUpperCase()} carries no speech — anything transcribed will be invented out of the noise.
                </div>
            )}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}
            {failure && attachState !== 'error' && <div className="note note--warn">{failure}</div>}

            {!minimal && (
            <div className="tp__controls">
                <Switch
                    label="Timestamp"
                    title="Show the UTC time each line was spoken"
                    checked={opts.timestamps}
                    onChange={(v) => setOpt({ timestamps: v })}
                />
                <Switch
                    label="Auto-scroll"
                    title="Keep the newest line in view"
                    checked={opts.autoScroll}
                    onChange={(v) => setOpt({ autoScroll: v })}
                />
                <span className="tp__bar-gap" />
                <Switch
                    label="Speak"
                    disabled={!speech.supported}
                    title={speech.supported
                        ? 'Read each finished line aloud, so you can leave a frequency running without watching this window'
                        : 'This browser has no speech synthesiser'}
                    checked={tts.on}
                    onChange={(v) => setTts((t) => ({ ...t, on: v }))}
                />
            </div>
            )}

            {!minimal && tts.on && speech.voices.length === 0 && (
                <div className="note note--warn">
                    This browser has no speech voices installed, so nothing will be read out.
                </div>
            )}

            {!minimal && tts.on && speech.voices.length > 0 && (
            <div className="tp__controls stt__tts">
                <label
                    className="tp__field"
                    title="Which installed voice reads the transcript. Chrome's and Edge's online voices sound markedly better than the local fallbacks they also list"
                >
                    <span className="tp__field-label">Voice</span>
                    <select
                        className="select stt__voice"
                        value={tts.voice}
                        onChange={(e) => {
                            handPicked.current = true;
                            setTts((t) => ({ ...t, voice: e.target.value }));
                        }}
                    >
                        <option value="">Browser default</option>
                        {groups.map((g) => (
                            <optgroup key={g.label} label={g.label}>
                                {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </optgroup>
                        ))}
                    </select>
                </label>

                <label
                    className="tp__field stt__rate"
                    title="Speaking speed. Faster keeps up with a busy frequency; slower is easier to follow on a poor transcript"
                >
                    <span className="tp__field-label">Rate {tts.rate.toFixed(1)}×</span>
                    <Slider
                        value={tts.rate}
                        min={RATE.min}
                        max={RATE.max}
                        step={RATE.step}
                        onChange={(v) => setTts((t) => ({ ...t, rate: v }))}
                    />
                </label>

                <Switch
                    label="Duck receiver"
                    title="Silence the receiver's audio while a line is read out, so the two do not talk over each other. Your mute button and volume are left alone"
                    checked={tts.duck}
                    onChange={(v) => setTts((t) => ({ ...t, duck: v }))}
                />

                <span className="tp__bar-gap" />
                <span className={`tp__lamp${speech.speaking ? ' is-on' : ''}`}>Speaking</span>
            </div>
            )}

            <Transcript
                segments={rows}
                timestamps={opts.timestamps}
                autoScroll={opts.autoScroll}
                font={font}
                empty={emptyText}
            />

            {!minimal && (
            <div className="tp__foot">
                <span className="stt__count" title="Lines the transcriber has finished with. The live line is not counted — it is still being rewritten">
                    {transcript.done.length} line{transcript.done.length === 1 ? '' : 's'}
                </span>
                <span className="tp__bar-gap" />
                {running && <AudioLevel />}
            </div>
            )}

            {caption && (
                <Caption
                    // The line being spoken, falling back to the last one that
                    // settled: between overs there is no live segment, and an
                    // empty box says "broken" rather than "nobody is talking".
                    text={transcript.live ? transcript.live.text : lastLine}
                    hint={decoding ? 'Listening…' : 'Press Start to transcribe.'}
                    font={font}
                    onClose={() => setCaption(false)}
                />
            )}

            {summary && <SummaryModal summary={summary} onClose={() => setSummary(null)} />}
        </div>
    );
}
