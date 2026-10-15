// Speech-to-text on the device: Web Speech, on-device only, on receiver audio.
//
// Web Speech's recogniser is two things this extension must never use: by
// default it streams audio to the browser vendor's servers, and by default it
// listens to the microphone. Both are switched off here, and neither may fall
// back:
//
//   * `processLocally = true` — recognition happens on the device or not at
//     all. The language pack is checked with `SpeechRecognition.available()`
//     before starting, so a missing one is a note with an Install button rather
//     than a recogniser that starts and silently produces nothing.
//   * `start(track)` — the receiver's audio as a MediaStreamTrack, from
//     AudioPlayer.recognitionTrack(), which is taken before the volume, the
//     mute and the duck. Without the track argument the recogniser opens the
//     microphone, which would transcribe the room. ./index.js explains why a
//     browser that gets this far is one that honours it.
//
// The rest is keeping a recogniser running that was designed for dictation.
// `continuous` keeps one session across pauses and `interimResults` gives the
// live line, but Chrome still ends a session on its own — after a stretch of
// silence, or after a while regardless — and a broadcast is hours long. So an
// unrequested 'end' is answered by starting again, on the bounded policy in
// ../local.js restartPlan: a recogniser that transcribed something, or ran for
// a while and ended quietly, is restarted at once; one that keeps failing —
// dying on every start, or erroring out of every session however long it ran
// — gives up after a handful of tries with "keeps stopping" rather than
// looping for ever.
//
// Errors go through ../local.js describeError. Retryable ones (no speech, an
// abort, a lost track) are left to the restart that follows them — the
// recogniser always ends after an error — and the user hears nothing of them,
// but they are remembered until that 'end', because how a session ended is
// half of whether it counts against the limit. Fatal ones stop the engine and
// are reported once.

import { describeError, languageError, restartPlan } from '../local.js';

/**
 * One recogniser `result` event as `{text, final}` results, in order.
 *
 * In continuous mode the event's list holds the whole session — every final
 * so far and then the interim tail — and `resultIndex` is the first entry that
 * changed. Finals from there on are reported one by one; the interims after
 * them are a single hypothesis split into pieces, so they are joined into the
 * one live line they are.
 */
export function resultsFromEvent(event) {
    const list = event && event.results;
    if (!list || !(list.length > 0)) return [];
    const from = Number.isFinite(event.resultIndex) && event.resultIndex > 0 ? event.resultIndex : 0;
    const out = [];
    let interim = '';
    for (let i = from; i < list.length; i++) {
        const r = list[i];
        const alt = r && r[0];
        const text = alt && alt.transcript != null ? String(alt.transcript) : '';
        if (r && r.isFinal) {
            out.push({ text, final: true });
        } else if (text) {
            // Pieces usually carry their own leading space; when neither side
            // of the join does, words would run together.
            const gap = interim && !/\s$/.test(interim) && !/^\s/.test(text) ? ' ' : '';
            interim += gap + text;
        }
    }
    if (interim.trim()) out.push({ text: interim, final: false });
    return out;
}

/** See ./index.js for the engine contract. */
export function createBrowserEngine({
    player,
    Recognition,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    now = () => Date.now(),
} = {}) {
    let opts = null;        // the callbacks of the session in progress
    let rec = null;         // its recogniser
    let running = false;
    let active = false;     // rec.start() succeeded and 'end' has not come yet
    let intentional = false; // the coming 'end' is a restart we asked for
    let launches = 0;       // starts this session, to tell the first from a restart
    let strikes = 0;
    let startedAt = 0;
    // How the session in progress is going, for restartPlan: the retryable
    // error it raised, if any, and whether it has settled a line.
    let sessionError = '';
    let settled = false;
    let timer = null;
    let offTrack = null;
    // An interim has been reported and its final has not. A session that ends
    // or is restarted mid-utterance never sends that final, so it is sent here
    // instead — an empty final, which ../localSegments.js foldResult takes as
    // "settle what you have" — rather than leaving the live line up for ever.
    let pending = false;

    const quiet = () => {};

    function teardown() {
        running = false;
        active = false;
        if (timer != null) clearTimer(timer);
        timer = null;
        if (offTrack) offTrack();
        offTrack = null;
        const r = rec;
        rec = null;
        if (r) {
            r.onresult = null;
            r.onerror = null;
            r.onend = null;
            try { r.abort(); } catch (e) { /* not started */ }
        }
        if (player && typeof player.releaseRecognitionTrack === 'function') player.releaseRecognitionTrack();
    }

    function finish(error) {
        if (!running) return;
        const o = opts;
        teardown();
        opts = null;
        if (error) o.onError(error);
        o.onEnd();
    }

    const fail = (code, detail, lang) => finish(describeError(code, detail, { kind: 'browser', lang }));

    function settlePending() {
        if (!pending || !opts) return;
        pending = false;
        opts.onResult({ text: '', final: true });
    }

    function launch() {
        timer = null;
        if (!running || !rec) return;
        const track = player && typeof player.recognitionTrack === 'function' ? player.recognitionTrack() : null;
        if (!track) {
            fail('no-audio');
            return;
        }
        launches += 1;
        intentional = false;
        startedAt = now();
        sessionError = '';
        settled = false;
        try {
            rec.start(track);
            active = true;
        } catch (e) {
            const name = e && e.name;
            if (launches === 1) {
                // On the very first start, a refusal of the track is the
                // browser saying it cannot do this at all — a TypeError from
                // an overload it does not have, or InvalidStateError for a
                // track it will not take. Anything else is worth quoting.
                if (name === 'TypeError' || name === 'InvalidStateError') fail('track-unsupported');
                else fail('start-failed', (e && e.message) || String(e));
                return;
            }
            // A restart that would not start counts as one that died at once.
            ended();
        }
    }

    function ended() {
        active = false;
        if (!running) return;
        settlePending();
        if (intentional) {
            intentional = false;
            timer = setTimer(launch, 0);
            return;
        }
        const plan = restartPlan(strikes, now() - startedAt, { error: sessionError, settled });
        strikes = plan.strikes;
        if (plan.giveUp) {
            fail('keeps-stopping');
            return;
        }
        timer = setTimer(launch, plan.delayMs);
    }

    // Abort and start again — a retune, or a new track after the context was
    // rebuilt. When the recogniser is between sessions there is nothing to
    // abort and no 'end' coming.
    //
    // `keep` settles the utterance in progress first, and is what a new track
    // passes; a retune passes false, because that utterance belongs to the
    // station just tuned away from.
    function restartNow(keep) {
        if (!running || !rec) return;
        if (keep) settlePending();
        else pending = false;
        if (active) {
            intentional = true;
            try { rec.abort(); } catch (e) { intentional = false; }
            return;
        }
        // Between sessions, a restart is already scheduled — possibly a
        // backoff after a run of failures. A retune leaves it alone: the
        // session it launches is a fresh one either way, and bringing it
        // forward would let someone scanning the band skip the backoff on
        // every turn of the dial. A new track is brought forward, because it
        // is a different source and may well be what the last ones lacked.
        // On a timer even so: the track event fires from inside the player's
        // context rebuild, which is no place to be starting a recogniser.
        if (timer != null && !keep) return;
        if (timer != null) clearTimer(timer);
        timer = setTimer(launch, 0);
    }

    async function start({ lang, onResult, onError, onEnd } = {}) {
        if (running) return;
        opts = { onResult: onResult || quiet, onError: onError || quiet, onEnd: onEnd || quiet };
        running = true;
        launches = 0;
        strikes = 0;
        pending = false;
        const mine = opts;

        if (typeof Recognition !== 'function' || typeof Recognition.available !== 'function'
            || !Recognition.prototype || !('processLocally' in Recognition.prototype)) {
            fail('unsupported');
            return;
        }

        let status = 'unavailable';
        try {
            status = await Recognition.available({ langs: [String(lang || '')], processLocally: true });
        } catch (e) { /* a check that throws is a language we cannot use */ }
        // Stopped, or stopped and started again, while the check was out.
        if (opts !== mine) return;
        if (status !== 'available') {
            fail(languageError(status), '', lang);
            return;
        }

        let r;
        try {
            r = new Recognition();
            r.processLocally = true;
            r.continuous = true;
            r.interimResults = true;
            r.maxAlternatives = 1;
            r.lang = String(lang || '');
        } catch (e) {
            fail('start-failed', (e && e.message) || String(e));
            return;
        }
        rec = r;

        r.onresult = (ev) => {
            if (rec !== r) return;
            for (const res of resultsFromEvent(ev)) {
                pending = !res.final;
                // A settled line is the proof it works — see restartPlan for
                // why an interim is not.
                if (res.final && res.text.trim()) settled = true;
                mine.onResult(res);
            }
        };
        r.onerror = (ev) => {
            if (rec !== r) return;
            const code = ev && ev.error;
            // Our own abort, on the way to a restart.
            if (intentional && code === 'aborted') return;
            const d = describeError(code, ev && ev.message, { kind: 'browser', lang });
            if (d.fatal) {
                finish(d);
                return;
            }
            // Retryable: the 'end' that always follows an error restarts it,
            // and needs to know this session ended on one.
            sessionError = String(code || '');
        };
        r.onend = () => {
            if (rec !== r) return;
            ended();
        };

        if (player && typeof player.on === 'function') {
            offTrack = player.on('recognitiontrack', () => restartNow(true));
        }
        launch();
    }

    return {
        kind: 'browser',
        start,
        reset: () => restartNow(false),
        stop: () => finish(null),
    };
}
