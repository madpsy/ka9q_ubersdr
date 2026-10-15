// Speech-to-Text — v1's whisper extension, rebuilt for v2.
//
// It transcribes in one of two places, picked in the settings:
//
//   * **On this device** — the default wherever it works. A recogniser in the
//     browser (Web Speech, on-device only) or in the host app, fed the
//     receiver's audio and never the microphone; ./engines/ has both, and
//     ./local.js every decision about them. Its results are turned into the
//     server's segments by ./localSegments.js, so everything below — the
//     console, the caption, reading aloud, copy and save — cannot tell which
//     source it is looking at. What it cannot do is what the server adds: there
//     is no summariser and no language detection, so both are hidden, and
//     translation happens on the device too, one settled line at a time
//     (./translate.js).
//   * **Server** — WhisperLive, exactly as before; the rest of this header is
//     about that.
//
// Local fails in more ways than the server does — a language not installed, a
// permission refused, a recogniser that will not stay running, one that runs
// and says nothing — and the user is told every time: each is a note, with
// "Use server instead" beside it wherever the receiver has a transcriber.
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
import { useExtensionEntry } from '../ExtensionsContext.jsx';
import { AudioLevel } from '../TeleprinterUI.jsx';
import { waveLevelDb } from '../toneSpectrum.js';
import { subscribeAudioSpectrum } from '../../lib/audioSpectrum.js';
import Caption from './Caption.jsx';
import {
    EMPTY, LINE_LIMITS, VIEWS, allSegments, applySegments, boldParts, decodeFrame,
    formatClock, formatSince, saveFilename, toText, visibleSegments,
} from './frames.js';
import { LANGUAGE_MENU, languageName } from './languages.js';
import { RATE, preferredVoice, voiceForLanguage, voiceGroups } from './speech.js';
import { useSpeech } from './useSpeech.js';
import {
    LOCAL_NO_LANGUAGES, SOURCE_LOCAL, SOURCE_SERVER, SPOKEN_CANDIDATES, WATCHDOG_EMPTY, closestLanguage,
    describeError, languageError, loadSource, loadSpoken, pickSource, saveSource, saveSpoken, sourcePhrase,
    spokenName, translationPair, watchdogStep,
} from './local.js';
import { LOCAL_EMPTY, finishSentence, foldResult, liveSegment } from './localSegments.js';
import {
    TRACK_UNSUPPORTED_REASON, browserTrackProbed, canInstall, createLocalEngine, hostStt, installLanguage,
    localEngineKind, localLanguages, localUnavailableReason, probeBrowserTrack,
} from './engines/index.js';
import { createLineTranslator } from './translate.js';
import { saveFile } from '../../lib/saveFile.js';

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

// How often the on-device watchdog reads the audio level: the AudioLevel
// meter's own rate, which is what WATCHDOG.window's "~2 s" is counted in.
const WATCHDOG_SAMPLE_MS = 100;

// How long the device has to say which languages it can recognise. A browser
// answers forty-odd checks in well under a second and a host app one call, so
// this is only reached by one that never answers — and without it Start would
// sit at "Starting…" for ever with nothing said.
const LANGUAGES_TIMEOUT_MS = 10000;

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

/**
 * A note about transcribing on the device, with whatever can be done about it
 * beside it: installing the language, or handing the job to the server. Every
 * local failure is drawn by this one component, so none of them can leave out
 * the way out.
 */
function LocalNote({ note, onInstall, installing, onServer }) {
    return (
        <div className="note note--warn stt__note">
            <span>{note.message}</span>
            {onInstall && (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={onInstall}
                    disabled={installing}
                    icon={<Icon.Download size={13} />}
                    title="Download this language so it can be recognised on this device. It is a one-off download, and nothing you listen to is sent anywhere"
                >
                    {installing ? 'Installing…' : 'Install'}
                </Button>
            )}
            {onServer && (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={onServer}
                    title="Transcribe with the receiver's own transcriber instead. It copes better with a weak signal, and it is what this extension did before it could run on the device"
                >
                    Use server instead
                </Button>
            )}
        </div>
    );
}

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
    const liveRef = useRef(live);
    liveRef.current = live;

    // Where the transcribing happens — see the top of the file and ./local.js
    // pickSource for the rules. The receiver's half of the answer comes from
    // ExtensionsContext; outside it there is no answer, and this component was
    // only ever opened where the receiver enabled it, so that is assumed.
    // The device's half is a question about which APIs exist, asked once.
    const entry = useExtensionEntry('whisper');
    const serverEnabled = entry ? !!entry.serverEnabled : true;
    // A browser's recogniser counts only once it has been seen to take a
    // track (probeBrowserTrack). Usually already answered — ExtensionsContext
    // asked before this could open — but asked here too for a component
    // rendered without it; until then local is not on offer.
    const presentKind = useMemo(() => localEngineKind(), []);
    const [trackOk, setTrackOk] = useState(() => (presentKind === 'browser' ? browserTrackProbed() : true));
    useEffect(() => {
        if (trackOk !== null) return undefined;
        let live = true;
        probeBrowserTrack().then((ok) => { if (live) setTrackOk(ok); });
        return () => { live = false; };
    }, [trackOk]);
    const localKind = trackOk === true ? presentKind : null;
    const localReason = useMemo(() => {
        if (presentKind && trackOk === null) return 'Checking whether this browser can transcribe on the device…';
        if (presentKind && trackOk === false) return TRACK_UNSUPPORTED_REASON;
        return localUnavailableReason();
    }, [presentKind, trackOk]);
    const [savedSource, setSavedSource] = useState(loadSource);

    // The spoken language, which only local mode asks for: Whisper works it
    // out, an on-device model has to be told. `spokenAnswer` is what the
    // device last said it can do, `{epoch, list}` with `list` as
    // `[{code, status}]`, null until it has answered; `langEpoch` asks it
    // again, after an install, and an answer is only current when its epoch
    // is. Up here because the answer bears on the source: see `noLanguages`.
    const [spokenPref, setSpokenPref] = useState(loadSpoken);
    const [spokenAnswer, setSpokenAnswer] = useState(null);
    const [langEpoch, setLangEpoch] = useState(0);
    const spokenList = spokenAnswer ? spokenAnswer.list : null;
    const spokenReady = !!spokenAnswer && spokenAnswer.epoch === langEpoch;
    // The device answered, and could do nothing. Where the receiver has a
    // transcriber that makes local unavailable, with the reason, rather than
    // a default that fails at every Start; where it is the only source, it
    // stays chosen and says so in a note.
    const noLanguages = !!localKind && !!spokenList && spokenList.length === 0;
    const localUsable = !!localKind && !(noLanguages && serverEnabled);

    const picked = useMemo(() => pickSource({
        localAvailable: localUsable,
        serverEnabled,
        saved: savedSource,
        localReason: localKind ? LOCAL_NO_LANGUAGES : localReason,
    }), [localUsable, localKind, serverEnabled, savedSource, localReason]);
    // Null only when neither is possible, and the extension is not offered
    // then — so anything that does render with it falls to the server path,
    // which is what this component always was.
    const source = picked.source;
    const local = source === SOURCE_LOCAL;

    const [decoding, setDecoding] = useState(false);
    // Read when a translated line comes back, which may be after Stop.
    const decodingRef = useRef(decoding);
    decodingRef.current = decoding;
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

    // On the device only. `localStatus` is the engine's progress — 'idle',
    // 'starting', 'running' — the counterpart of the server's attach state.
    // `localNote` is a recogniser complaint that did not stop it, `silent` the
    // watchdog's verdict, and the two translate ones what the on-device
    // translator has to say; fatal failures go into `failure`, as the
    // server's do, as `{message, action}` rather than a string so the note can
    // offer the fix.
    const [localStatus, setLocalStatus] = useState('idle');
    const [localNote, setLocalNote] = useState(null);
    const [silent, setSilent] = useState(false);
    const [translateNote, setTranslateNote] = useState(null);
    const [translateProgress, setTranslateProgress] = useState(null);
    const [installing, setInstalling] = useState(false);

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

    // The on-device session in progress — its engine, its utterance state
    // (./localSegments.js) and its clock — or null. A ref because the engine's
    // callbacks are bound once, at start, and must reach the current one.
    const localRun = useRef(null);
    // The line translator for that session, `{tr, lang}`, or null when the
    // spoken language already is the output language.
    const translatorRef = useRef(null);
    // Bumped whenever the transcript is cleared, so a line that went away to
    // be translated and comes back afterwards is dropped rather than landing
    // in a transcript of a different station.
    const gen = useRef(0);
    // Whether any result, interim or final, has arrived since the watchdog
    // last looked.
    const heardRef = useRef(false);

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
        // Only when the server is the source: on the device there is nothing
        // to attach, and an idle attach would still cost a WhisperLive slot.
        active: decoding && live && !local,
        parse: decodeFrame,
        onResult,
        onEvent,
    });
    attachRef.current = attachState;

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // Stopping ends the session: the next start is a new stream with a clock of
    // its own, and a half-spoken sentence must not carry over into it. A
    // warning about the session that ended goes with it; a fatal `failure`
    // stays, because it is the explanation of why it ended.
    useEffect(() => {
        if (decoding) return;
        base.current = null;
        startedAt.current = null;
        setLastAt(null);
        setDetected(null);
        setLocalNote(null);
        setSilent(false);
        stopSpeaking();
    }, [decoding, stopSpeaking]);

    // ---- on the device -----------------------------------------------------

    // Which spoken languages the device has. Asked when local is the source
    // rather than up front: a browser can only be asked one language at a
    // time, so this is forty-odd checks, and a user on the server never needs
    // the answer. A host that does not list its languages is taken at its word
    // that it can do any of them, as ./engines/index.js languageStatus does.
    useEffect(() => {
        if (!local || !localKind) return undefined;
        let cancelled = false;
        const host = localKind === 'host' ? hostStt() : null;
        const late = setTimeout(() => {
            if (cancelled) return;
            setFailure({
                message: `This ${localKind === 'host' ? 'app' : 'browser'} hasn't said which languages it can recognise on the device.`,
                action: '',
                code: 'languages-timeout',
            });
        }, LANGUAGES_TIMEOUT_MS);
        localLanguages(localKind).then((list) => {
            clearTimeout(late);
            if (cancelled) return;
            // An answer after all: the note about there being none is wrong now.
            setFailure((f) => (f && f.code === 'languages-timeout' ? null : f));
            setSpokenAnswer({
                epoch: langEpoch,
                list: host && typeof host.languages !== 'function'
                    ? SPOKEN_CANDIDATES.map((code) => ({ code, status: 'available' }))
                    : list,
            });
        });
        return () => { cancelled = true; clearTimeout(late); };
    }, [local, localKind, langEpoch]);

    // The language to recognise: the one chosen by hand if the device has it,
    // otherwise the nearest to it — or to English, in the user's own region —
    // that is ready to use rather than merely downloadable. Before the device
    // has answered this is only a guess, for the menu to show: the engine
    // waits for the answer (see its effect below), because starting on the
    // guess fails wherever the guess is not installed — an en-GB user on a
    // device with only en-US would be told English needs a download — and
    // where it is, the answer arriving would change the language and restart
    // the recogniser under them.
    const userLocale = (typeof navigator !== 'undefined' && navigator.language) || '';
    const spokenCodes = spokenList ? spokenList.map((l) => l.code) : [];
    const readyCodes = spokenList ? spokenList.filter((l) => l.status === 'available').map((l) => l.code) : [];
    let spokenLang;
    if (!spokenCodes.length) spokenLang = spokenPref || closestLanguage(SPOKEN_CANDIDATES, 'en', userLocale);
    else if (spokenPref && spokenCodes.includes(spokenPref)) spokenLang = spokenPref;
    else spokenLang = closestLanguage(readyCodes.length ? readyCodes : spokenCodes, spokenPref || 'en', userLocale);
    const spokenEntry = spokenList ? spokenList.find((l) => l.code === spokenLang) : null;
    const spokenStatus = spokenEntry ? spokenEntry.status : null;

    // A note about a language names the language, and the Install button
    // beside it installs that one — the language the note is about, not
    // whatever the menu says by the time it is pressed. So a language failure
    // that is no longer about the language chosen is taken down: the answer
    // arriving, or the user picking another, makes it stale.
    useEffect(() => {
        setFailure((f) => (f && typeof f === 'object' && /^language-/.test(f.code || '') && f.lang !== spokenLang
            ? null
            : f));
    }, [spokenLang]);

    // One recogniser result, as transcript segments. The same applySegments
    // the server's frames go through, so speaking, the "last heard" clock and
    // everything downstream behave identically.
    const applyLocal = (run, segments) => {
        const { state, settled } = applySegments(transcriptRef.current, segments, run.t0);
        apply(state);
        if (speakRef.current) for (const s of settled) speakRef.current(s.text);
        setLastAt(Date.now());
    };

    // Settled lines go through the translator when there is one; the live line
    // never does — see ./translate.js. A translated line comes back after the
    // next utterance may have begun, so the live segment as it now stands goes
    // with it, or applySegments would take the settled line on its own as the
    // end of all speech and clear the line being spoken.
    //
    // "As it now stands" is the session running *now*, which need not be the
    // one the line was heard in: a change of spoken language, or the audio
    // reconnecting, starts a new one while a translation is out. The line is
    // still this station's, so it lands — on the new session's clock, beside
    // the new session's live line. What it must not do is land after Stop, in
    // a transcript the user has finished with (and be read aloud there), or
    // after a clear, in a transcript of a different station.
    const deliverLocal = (run, segments) => {
        for (const seg of segments) {
            const t = translatorRef.current;
            if (!seg.completed || !t) {
                applyLocal(run, [seg]);
                continue;
            }
            const g = gen.current;
            t.tr.translate(seg.text).then((out) => {
                if (gen.current !== g || !decodingRef.current) return;
                const line = { ...seg, text: out.translated ? finishSentence(out.text, t.lang) : out.text };
                const cur = localRun.current;
                if (!cur) {
                    // Between sessions: nobody is speaking, so there is no
                    // live line to keep.
                    applyLocal(run, [line]);
                    return;
                }
                const shift = (run.t0 - cur.t0) / 1000;
                const moved = cur === run ? line : { ...line, start: line.start + shift, end: line.end + shift };
                const pending = liveSegment(cur.state, (Date.now() - cur.t0) / 1000);
                applyLocal(cur, pending ? [moved, pending] : [moved]);
            });
        }
    };

    // The engine's lifetime: running while local is the source, Start is on
    // and there is audio — the same three things the server's attach waits
    // for — and started again in a new language when that changes. Not before
    // the device has said which languages it has, for the reason given at
    // `spokenLang`; until then Start shows "Starting…", which is what it is.
    // And not with no language at all: the note says why. A fatal error ends
    // it from the inside, and is the one thing that turns Start off without
    // the user pressing Stop.
    useEffect(() => {
        if (!local || !decoding || !live || !localKind || !spokenReady || noLanguages) return undefined;
        const engine = createLocalEngine(localKind, { player });
        if (!engine) return undefined;
        const run = { engine, state: LOCAL_EMPTY, t0: Date.now(), lang: spokenLang, stopped: false, failed: false };
        localRun.current = run;
        // The clock segments are measured from, as the server's `attached`
        // sets it — see onEvent.
        base.current = run.t0;
        if (startedAt.current == null) startedAt.current = run.t0;
        heardRef.current = false;
        setFailure(null);
        setLocalNote(null);
        setLocalStatus('starting');

        const fail = (e) => {
            run.failed = true;
            setFailure({ message: e.message, action: e.action || '', code: e.code || '', lang: run.lang });
        };

        engine.start({
            lang: spokenLang,
            onResult: (r) => {
                if (run.stopped) return;
                heardRef.current = true;
                setLocalStatus('running');
                const at = (Date.now() - run.t0) / 1000;
                const { state, segments } = foldResult(run.state, r, at, { lang: run.lang });
                run.state = state;
                deliverLocal(run, segments);
            },
            onError: (e) => {
                if (run.stopped || !e) return;
                if (e.fatal) fail(e);
                else setLocalNote(e);
            },
            onEnd: () => {
                if (run.stopped) return;
                run.stopped = true;
                // The contract says an unasked-for end follows a fatal error,
                // which has already been shown. One that did not would turn
                // Start off with nothing on screen to say why.
                if (!run.failed) fail(describeError('ended', '', { kind: localKind }));
                setLocalStatus('idle');
                setDecoding(false);
            },
        }).then(() => {
            if (!run.stopped && !run.failed) setLocalStatus((st) => (st === 'starting' ? 'running' : st));
        }, (e) => {
            // start() is not meant to reject — every failure is an onError —
            // but one that does must still say so and stop.
            if (run.stopped) return;
            run.stopped = true;
            engine.stop();
            fail(describeError('start-failed', (e && e.message) || String(e), { kind: localKind }));
            setLocalStatus('idle');
            setDecoding(false);
        });

        return () => {
            run.stopped = true;
            engine.stop();
            if (localRun.current === run) localRun.current = null;
            setLocalStatus('idle');
        };
    }, [local, decoding, live, spokenLang, localKind, spokenReady, noLanguages, player]);

    // The translator, when the output language is not the one being spoken.
    // Opened as Start is pressed rather than at the first settled line: a
    // translation model may have to download, and Chrome can insist that a
    // download follow a click — an effect run straight after one still counts.
    // A failure is a note and never a stop; the line is shown as spoken.
    useEffect(() => {
        if (!local || !decoding) return undefined;
        const pair = translationPair(spokenLang, language);
        if (!pair) return undefined;
        let alive = true;
        const tr = createLineTranslator({
            pair,
            onNote: (n) => { if (alive) setTranslateNote(n); },
            onProgress: (p) => { if (alive) setTranslateProgress(p >= 1 ? null : p); },
        });
        const mine = { tr, lang: language };
        translatorRef.current = mine;
        tr.prepare().then(() => { if (alive) setTranslateProgress(null); });
        return () => {
            alive = false;
            tr.destroy();
            if (translatorRef.current === mine) translatorRef.current = null;
            setTranslateNote(null);
            setTranslateProgress(null);
        };
    }, [local, decoding, spokenLang, language]);

    // The watchdog — see ./local.js. Fed by the same reading the AudioLevel
    // meter shows, at the meter's own rate, so the warning and the meter can
    // never disagree about whether there was audio. That reading is taken
    // after the volume control, so a muted receiver reads as silence and the
    // watchdog stays quiet: it can miss a recogniser that has failed while the
    // receiver is muted, but it cannot accuse one that is working of ignoring
    // audio nobody is hearing. Voice modes only, as the warning about CW
    // below already covers the rest.
    const voiceMode = VOICE_MODES.includes(tuning.mode);
    useEffect(() => {
        if (!local || !decoding || !voiceMode || !player) return undefined;
        let wd = WATCHDOG_EMPTY;
        let last = -Infinity;
        heardRef.current = false;
        const off = subscribeAudioSpectrum(player, { fftSize: 2048, bins: false, wave: true }, (f) => {
            const now = performance.now();
            if (now - last < WATCHDOG_SAMPLE_MS) return;
            last = now;
            wd = watchdogStep(wd, { levelDb: waveLevelDb(f.wave), now, heard: heardRef.current, armed: true });
            heardRef.current = false;
            setSilent(wd.warn);
        });
        return () => {
            off();
            setSilent(false);
        };
    }, [local, decoding, voiceMode, player]);

    // Switching source by hand. Remembered, so it holds next time where it can
    // (see pickSource), and whatever the other source had to complain about
    // goes with it. Start is left as it was: switching while transcribing
    // carries on transcribing, from the other place.
    const chooseSource = (next) => {
        if (next === source) return;
        saveSource(next);
        setSavedSource(next);
        setFailure(null);
        setLocalNote(null);
        setSilent(false);
    };

    // The way out that every local note offers, where there is one: the
    // receiver's own transcriber. It also starts it, since the user was
    // trying to transcribe when the note appeared.
    const switchToServer = local && serverEnabled
        ? () => {
            chooseSource(SOURCE_SERVER);
            if (live) setDecoding(true);
        }
        : null;

    // Install a spoken language, from a note's button — Chrome wants the
    // download to follow a click. The note's own language, which the note
    // names. Then ask the device again what it has, and start, since that is
    // what the user was trying to do; the engine waits for the new answer.
    const installable = local && canInstall(localKind);
    const install = (lang) => {
        setInstalling(true);
        installLanguage(lang).then((ok) => {
            setInstalling(false);
            setLangEpoch((n) => n + 1);
            if (!ok) {
                setFailure({
                    message: `${spokenName(lang)} could not be installed for on-device recognition. Try again, or choose another language.`,
                    action: '',
                    code: 'language-install-failed',
                    lang,
                });
                return;
            }
            // A browser probed before it had any language could not be judged
            // then (probeBrowserTrack passes it without remembering); with a
            // pack installed it can, and a track it will refuse is better
            // said now than as a failed Start.
            const judged = presentKind === 'browser' && browserTrackProbed() === null
                ? probeBrowserTrack()
                : Promise.resolve(true);
            return judged.then((trackWorks) => {
                if (!trackWorks) {
                    setTrackOk(false);
                    setFailure({ message: `${TRACK_UNSUPPORTED_REASON}.`, action: '', code: 'track-unsupported', lang });
                    return;
                }
                setFailure(null);
                if (liveRef.current) setDecoding(true);
            });
        });
    };

    const chooseSpoken = (code) => {
        saveSpoken(code);
        setSpokenPref(code);
        setFailure(null);
    };

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

    const clear = useCallback((alsoServer, retuned) => {
        apply(EMPTY);
        stopSpeaking();
        gen.current += 1;
        // On the device there is no server history to reset — the utterance in
        // progress is all there is, and it belongs to what was just cleared.
        // A retune also has the recogniser drop it, since the audio it has
        // heard so far is the old station's.
        const run = localRun.current;
        if (run) {
            run.state = LOCAL_EMPTY;
            if (retuned) run.engine.reset();
            return;
        }
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
        const id = setTimeout(() => clear(true, true), RETUNE_SETTLE_MS);
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
        saveFile(blob, name);
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

    // On the device the engine's own progress stands in for the attach state.
    // There is no 'error' among it: a fatal failure stops the engine, and the
    // note says why.
    const runState = local ? localStatus : attachState;
    const statusLabel = !decoding
        ? 'Stopped'
        : (runState === 'running' ? 'Running' : (runState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (runState === 'running' ? 'on' : (runState === 'error' ? 'bad' : 'wait'));
    const statusTitle = local
        ? `Whether the transcriber is running ${sourcePhrase(SOURCE_LOCAL)}: this ${localKind === 'host' ? 'app' : 'browser'} recognises the receiver's audio itself, and nothing is sent to the server`
        : 'Whether the transcriber is attached to your audio session on the server';

    // The selector's options, with a reason on the one that cannot be chosen.
    const sourceOptions = picked.options.map((o) => ({
        value: o.value,
        label: o.label,
        disabled: o.disabled,
        title: o.disabled
            ? o.reason
            : (o.value === SOURCE_LOCAL
                ? 'Recognise speech on this device. Costs the receiver nothing and sends nothing to it, but copes less well with a weak or noisy signal'
                : `Transcribe ${sourcePhrase(SOURCE_SERVER)}, with the receiver's WhisperLive — the better transcriber on a poor signal, and the one that can summarise`),
    }));

    // The disabled option's reason, as text beside the selector as well as in
    // its tooltip: a phone has no hover, and many browsers show no tooltip on
    // a disabled button at all — and a phone is exactly where local is most
    // often unavailable.
    const sourceWhy = picked.options.filter((o) => o.disabled).map((o) => o.reason).join(' · ');

    // What the spoken-language menu lists: the device's answer, or the guess
    // while that answer is outstanding, marked as what it is. An answer of
    // nothing lists nothing — the note below says why — rather than a
    // language the device has just said it cannot do.
    let spokenMenu;
    if (spokenList && spokenList.length) spokenMenu = spokenList;
    else if (spokenList) spokenMenu = [];
    else spokenMenu = [{ code: spokenLang, status: 'checking' }];

    // A spoken language that is not ready, said before Start rather than after
    // it — the same note the engine would raise, with the same Install button.
    // Or no spoken language at all.
    let langNote = null;
    if (local && noLanguages) {
        langNote = describeError('no-languages', '', { kind: localKind });
    } else if (local && !decoding && !failure && spokenStatus && spokenStatus !== 'available') {
        langNote = { ...describeError(languageError(spokenStatus), '', { lang: spokenLang }), lang: spokenLang };
    }
    const offerInstall = (note) => (note && note.action === 'install' && installable
        ? () => install(note.lang || spokenLang)
        : null);

    const groups = useMemo(() => voiceGroups(speech.voices), [speech.voices]);

    let emptyText = 'Tune to a voice transmission and press Start.';
    if (opts.view === 'live' && transcript.done.length) emptyText = 'Nothing being decoded at the moment.';
    else if (decoding && local) {
        emptyText = localStatus === 'running'
            ? 'Listening on this device — nothing transcribed yet.'
            : 'Starting the on-device recogniser…';
    } else if (decoding) {
        emptyText = attachState === 'running'
            ? 'Listening — nothing transcribed yet.'
            : 'Starting the transcriber…';
    }

    return (
        <div className="tp stt">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title={statusTitle}
                >
                    {statusLabel}
                </span>

                {/* Whisper's guess at the spoken language. Server only: on the
                    device the language is the one chosen, not detected. */}
                {!minimal && !local && detected && (
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
                            title={local
                                ? 'Stop transcribing and release the recogniser on this device'
                                : 'Stop transcribing and release the transcriber on the server'}
                        >
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setDecoding(true)}
                            disabled={!live || (local && noLanguages)}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? (local && noLanguages
                                    ? 'There is no language this device can recognise — see the note below'
                                    : `Start transcribing the audio this receiver is tuned to${local ? ', on this device' : ''}`)
                                : (local
                                    ? 'Start the receiver first — there is no audio to transcribe yet'
                                    : 'Start the receiver first — the transcriber runs on your audio session')}
                        >
                            Start
                        </Button>
                    )}

                {!minimal && (
                    <>
                        <Button size="sm" variant="ghost" onClick={copy} disabled={!everything.length} active={copied} icon={<Icon.Copy size={13} />} title="Copy the whole transcript to the clipboard" />
                        <Button size="sm" variant="ghost" onClick={save} disabled={!everything.length} icon={<Icon.Download size={13} />} title="Download the whole transcript as a text file" />
                        <Button size="sm" variant="ghost" onClick={() => clear(true)} disabled={!everything.length} icon={<Icon.Trash size={13} />} title={local ? 'Clear the transcript' : 'Clear the transcript, and let the server send a repeated line again'} />
                    </>
                )}
            </div>

            {!minimal && (
            <div className="tp__config">
                {/* Not drawn with a single option: a choice of one is not a
                    choice. With local unavailable it still has two, one of
                    them disabled with the reason — see pickSource. A div, not
                    a label: a label forwards a click on its text to the first
                    button inside it, which would pick a source. */}
                {sourceOptions.length > 1 && (
                    <div
                        className="tp__field"
                        title="Where the speech is recognised: on this device, or on the receiver"
                    >
                        <span className="tp__field-label">Transcribe</span>
                        <Segmented size="sm" options={sourceOptions} value={source} onChange={chooseSource} />
                        {sourceWhy && <span className="stt__source-why">{sourceWhy}</span>}
                    </div>
                )}

                {local && (
                    <label
                        className="tp__field"
                        title="The language being spoken on the air. An on-device recogniser handles one language at a time and has to be told which; only the ones this device can recognise are listed. Changing it restarts the recogniser"
                    >
                        <span className="tp__field-label">Spoken</span>
                        <select
                            className="select stt__lang"
                            value={spokenMenu.length ? spokenLang : ''}
                            disabled={!spokenMenu.length}
                            onChange={(e) => chooseSpoken(e.target.value)}
                        >
                            {!spokenMenu.length && <option value="">None on this device</option>}
                            {spokenMenu.map((l) => {
                                let suffix = ' — download needed';
                                if (l.status === 'available') suffix = '';
                                else if (l.status === 'checking') suffix = ' — checking…';
                                return <option key={l.code} value={l.code}>{`${spokenName(l.code)}${suffix}`}</option>;
                            })}
                        </select>
                    </label>
                )}

                <label
                    className="tp__field"
                    title={local
                        ? 'The language the transcript is delivered in. When it is not the spoken language, each finished line is translated on this device; the line still being spoken is shown as heard'
                        : 'The language the transcript is delivered in. Whisper transcribes to English and the server translates that, so English means no translation at all. Changing it restarts the transcriber'}
                >
                    <span className="tp__field-label">{local ? 'Output' : 'Language'}</span>
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

                {/* The summariser is the receiver operator's, reached
                    through the attach, so there is none on the device. */}
                {!local && (
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
                )}

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
            {failure && attachState !== 'error' && (typeof failure === 'string'
                ? <div className="note note--warn">{failure}</div>
                : (
                    <LocalNote
                        note={failure}
                        onInstall={offerInstall(failure)}
                        installing={installing}
                        onServer={switchToServer}
                    />
                ))}
            {langNote && (
                <LocalNote note={langNote} onInstall={offerInstall(langNote)} installing={installing} onServer={switchToServer} />
            )}
            {/* Warnings from a recogniser that is still running. The watchdog
                one in particular is the only sign of a failure that otherwise
                looks exactly like a quiet frequency. */}
            {local && decoding && localNote && <LocalNote note={localNote} onServer={switchToServer} />}
            {local && decoding && silent && <LocalNote note={describeError('silent')} onServer={switchToServer} />}
            {local && decoding && translateNote && <LocalNote note={translateNote} onServer={switchToServer} />}
            {local && decoding && translateProgress != null && (
                <div className="note note--tight">
                    Downloading the translation model… {Math.round(translateProgress * 100)}%
                </div>
            )}

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
