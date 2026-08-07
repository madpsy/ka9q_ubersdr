// Morse trainer, by the Koch method — both ways round.
//
//   Copy — a character is sent and you say which it was.
//   Send — a character is shown and you key it, dit by dit.
//
// The second is not a gimmick: recognising Morse and producing it are different
// skills, and the one nobody practises is sending. Keying `-.-` with two buttons
// while hearing it is most of what a straight key teaches, minus the wrist.
//
// Two characters to start with, and each five in a row adds another in Koch's
// order — which is neither alphabetical nor easiest-first: each new character
// arrives where it will be confused with one already known, because telling them
// apart is the whole skill. The level can also just be picked, for somebody who
// already knows half of it and does not want to prove it again.
//
// The code and the timing are lib/games/morse.js, pinned by tests: the table is
// ITU, and the rhythm is the PARIS definition to the millisecond.
//
// It starts on a press, and that is not ceremony. A collapsed dock peeked at by
// hovering its rail mounts the panels inside it, and a game that sent a character on
// mount sounded one every time the pointer crossed that rail — from a panel that was
// on screen for half a second, on a receiver somebody is listening to. Nothing here
// makes a noise until it has been asked to, and every mount asks again. It also puts
// the first tone inside a click, which is where a browser wants an AudioContext
// started.
//
// Sound is optional and has a pitch, because this panel lives on a receiver: the
// operator may be listening to something, or wearing headphones tuned to their own
// sidetone. With it off, Copy shows the pattern instead of playing it — reading
// rather than listening, and worth practising in its own right.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    DAH, DIT, KOCH, KOCH_MIN, UNLOCK_RUN, codeFor, kochSet, pickChar, toneSlices, unitMs,
} from '../../lib/games/morse.js';
import { claimKeys, isTyping } from '../../lib/shortcuts.js';

// How to play — shown by the ? beside the game picker. See GamesPanel.
export const gameHelp = (
    <>
        <p>
            <b>Copy</b> sends a character; say which one it was. <b>Send</b> shows
            one and you key it with the <b>·</b> and <b>–</b> buttons — or with two
            keys side by side, <b>.</b> and <b>/</b>, or <b>D</b> and <b>F</b> for
            the left hand. Dit is the left of the pair, as on a paddle.
        </p>
        <p>
            You start with two characters — <b>K</b> and <b>M</b>, which sound
            nothing alike — and five right in a row adds another. The order is
            Koch&rsquo;s: not alphabetical, because each new character arrives where
            it can be confused with one you already know, and hearing the difference
            is the skill. Pick a level directly if you already know some.
        </p>
        <p>
            <b>⌨</b> in Copy answers from the keyboard: press the character rather
            than reaching for its key, which is how copying is actually done. The keys
            stay on screen — they are the characters in play, and still clickable.
            While it is on, the receiver&rsquo;s own shortcuts stand down so that
            <b>U</b> is an answer and not USB; turn it off, or close the panel, and
            they are back.
        </p>
        <p>
            <b>Speed</b> is real words per minute, and characters are sent at full
            speed from the start on purpose: learning them slowly builds a habit of
            counting dits that has to be unlearned. If it is too fast, the answer is
            more listening rather than a lower speed.
        </p>
        <p>
            <b>Pitch</b> is the tone in hertz — pick what your ear likes, as you
            would on a rig. With the sound off, Copy shows the pattern instead of
            playing it.
        </p>
        <p>
            A wrong answer is not the end of it: the character is sent again and you
            can have another go, with what you ruled out still on screen. It
            costs the streak and earns no credit towards the next unlock — but the
            character you could not hear is the one worth hearing twice, which is
            why it is not simply revealed.
        </p>
        <p>
            Sending is judged as you go: a wrong element is wrong the moment it is
            keyed rather than at the end of the character, which is how a fist feels
            its own mistake. <b>Hint</b> sounds the next element you need and shows
            it, following along as you key — but never the last one, so it can narrow
            a pattern without ever finishing it for you. <b>Reveal</b> gives up and
            shows the answer.
        </p>
    </>
);

const KEY = 'ubersdr.v2.games.morse';
const NEXT_MS = 1400;
const WRONG_MS = 2200;      // longer, because there is something to read
const OPTIONS = 5;
// How many of the characters in play to name in the info row. Four fits beside the
// level picker at any width the panel is given, and they are the four that matter:
// the most recently unlocked are the ones still being learned.
const NEWEST = 4;

// Sidetone choices, in hertz. The range CW operators actually use: much below 400
// is muddy on a small speaker and much above 900 is tiring within a minute.
const PITCHES = [400, 500, 600, 700, 800];
// Character speeds. 20 wpm is where a fist stops sounding like counting; the
// slower rungs are there to arrive at it rather than to stay on.
const SPEEDS = [12, 15, 18, 20, 25];

// The keying envelope, seconds. A tone switched on instantly clicks — the click is
// a spray of harmonics, it is what a badly keyed transmitter sounds like on air,
// and it makes a short dit hard to place. Real rigs shape the edges; five
// milliseconds is the usual figure and is short enough not to soften a dit at
// 25 wpm, where one is 48 ms.
const RAMP = 0.005;
const LEVEL = 0.18;

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY)) || {};
        return {
            level: Math.min(Math.max(Number(saved.level) || KOCH_MIN, KOCH_MIN), KOCH.length),
            best: Number(saved.best) || 0,
            sound: saved.sound !== false,
            pitch: PITCHES.includes(saved.pitch) ? saved.pitch : 600,
            wpm: SPEEDS.includes(saved.wpm) ? saved.wpm : 15,
            mode: saved.mode === 'send' ? 'send' : 'copy',
            typed: saved.typed === true,
            // Part of the way to the next character. Clamped below the unlock, so a
            // hand-edited or half-written value cannot leave somebody permanently
            // one answer from a level they never reach.
            run: Math.min(Math.max(Number(saved.run) || 0, 0), UNLOCK_RUN - 1),
        };
    } catch (e) {
        return {
            level: KOCH_MIN, best: 0, sound: true, pitch: 600, wpm: 15,
            mode: 'copy', typed: false, run: 0,
        };
    }
}

export default function Morse({ visible = true, covered = false }) {
    const [prefs, setPrefs] = useState(load);
    const [target, setTarget] = useState('');
    const [options, setOptions] = useState([]);
    // Copy: the answers already ruled out this round. Plural, because a wrong one
    // does not end the round — see `missed`.
    const [wrong, setWrong] = useState([]);
    const [keyed, setKeyed] = useState('');         // send mode: what has been keyed
    const [verdict, setVerdict] = useState('');     // '' | 'right' | 'wrong'
    // Whether anything has been got wrong this round. A character reached on the
    // second attempt has still been learned, and is still worth hearing again —
    // but it does not count towards the streak or the next unlock, or the level
    // would climb on guesswork.
    const [missed, setMissed] = useState(false);
    // Send: the element a hint has just given away, if any. One at a time and never
    // the last — see hint().
    const [tip, setTip] = useState('');
    // Correct in a row, towards the next unlock — and saved, because it is progress.
    // Four in a row is most of the way to a new character, and losing it to a closed
    // panel or a reload would make the level a thing you have to finish in one
    // sitting. The streak beside it is not saved and is not meant to be: it is a run
    // of attention rather than of learning, it ends when you stop, and the best one
    // is kept.
    // Read from prefs rather than by loading again: one parse of one key is enough,
    // and useState only ever uses the first value it is given.
    const [run, setRun] = useState(() => prefs.run);
    const [streak, setStreak] = useState(0);
    // Nothing is sent, and no keys are claimed, until this is true. See the top of
    // the file: it is per mount, deliberately, and is not remembered.
    const [started, setStarted] = useState(false);
    const [status, setStatus] = useState('Ready');
    const recent = useRef([]);
    const timer = useRef(null);
    const alive = useRef(true);

    // Its own audio context, not the receiver's. The player's belongs to the signal
    // path — its sample rate, its output device, its gain — and a game borrowing it
    // could stop the audio it is playing. Created on the first press rather than on
    // mount, because a context made without a user gesture starts suspended.
    const audio = useRef({ ctx: null, osc: null, gain: null });

    const save = useCallback((next) => {
        setPrefs(next);
        try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
    }, []);

    useEffect(() => () => {
        alive.current = false;
        clearTimeout(timer.current);
        const a = audio.current;
        if (a.ctx) a.ctx.close().catch(() => {});
    }, []);

    /**
     * Put a list of `{ on, ms }` slices on the sound card.
     *
     * Scheduled against the audio clock in one go rather than fired off by timers:
     * setTimeout is accurate to a few milliseconds at best and worse under load,
     * and at 20 wpm a dit is sixty. Morse whose rhythm wanders is Morse nobody can
     * learn from, so the sound card keeps the time.
     */
    const schedule = useCallback((slices, prefsNow) => {
        const { sound, pitch } = prefsNow;
        if (!sound || !slices.length) return;
        const a = audio.current;
        if (!a.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            a.ctx = new Ctx();
            a.gain = a.ctx.createGain();
            a.gain.gain.value = 0;
            a.gain.connect(a.ctx.destination);
            // One oscillator for the life of the panel, gated by the gain. Starting
            // and stopping one per dit is both more work and more clicks.
            a.osc = a.ctx.createOscillator();
            a.osc.type = 'sine';
            a.osc.frequency.value = pitch;
            a.osc.connect(a.gain);
            a.osc.start();
        }
        if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
        const now = a.ctx.currentTime;
        a.osc.frequency.setValueAtTime(pitch, now);
        try {
            a.gain.gain.cancelScheduledValues(now);
            a.gain.gain.setValueAtTime(0, now);
        } catch (e) { /* a context torn down mid-play */ }

        let at = now + 0.04;
        for (const slice of slices) {
            const secs = slice.ms / 1000;
            if (slice.on) {
                a.gain.gain.setValueAtTime(0, at);
                a.gain.gain.linearRampToValueAtTime(LEVEL, at + RAMP);
                a.gain.gain.setValueAtTime(LEVEL, at + Math.max(secs - RAMP, RAMP));
                a.gain.gain.linearRampToValueAtTime(0, at + secs);
            }
            at += secs;
        }
    }, []);

    /** Stop, mid-character if need be: everything queued is cancelled. */
    const silence = useCallback(() => {
        const a = audio.current;
        if (!a.ctx || !a.gain) return;
        try {
            const now = a.ctx.currentTime;
            a.gain.gain.cancelScheduledValues(now);
            a.gain.gain.setValueAtTime(0, now);
        } catch (e) { /* a context already torn down */ }
    }, []);

    const sendChar = useCallback((ch, prefsNow) => {
        if (ch) schedule(toneSlices(ch, prefsNow.wpm), prefsNow);
    }, [schedule]);

    // One element, as it is keyed. The same tone and the same length it would have
    // inside a character — which is what makes keying it teach the rhythm.
    const sendElement = useCallback((el, prefsNow) => {
        const units = el === '-' ? DAH : DIT;
        schedule([{ on: true, ms: units * unitMs(prefsNow.wpm) }], prefsNow);
    }, [schedule]);

    const nextRound = useCallback((prefsNow = prefs) => {
        clearTimeout(timer.current);
        setWrong([]);
        setKeyed('');
        setVerdict('');
        setMissed(false);
        setTip('');
        const set = kochSet(prefsNow.level);
        const ch = pickChar(prefsNow.level, recent.current);
        recent.current = [...recent.current, ch].slice(-6);

        const others = set.filter((c) => c !== ch).sort(() => Math.random() - 0.5);
        setOptions([ch, ...others.slice(0, Math.max(1, OPTIONS - 1))]
            .sort(() => Math.random() - 0.5));
        setTarget(ch);

        if (prefsNow.mode === 'send') {
            setStatus('Key it');
        } else {
            setStatus(prefsNow.sound ? 'Listen' : 'Read the pattern');
            sendChar(ch, prefsNow);
        }
    }, [prefs, sendChar]);

    const begin = useCallback((prefsNow = prefs) => {
        setStarted(true);
        nextRound(prefsNow);
    }, [nextRound, prefs]);

    // A round only follows a settings change once the game is running: switching mode
    // or level from behind the start overlay must set the setting and stay quiet.
    const restart = useCallback((prefsNow) => {
        if (started) nextRound(prefsNow);
    }, [nextRound, started]);

    // A round got right. `credit` is false when it took more than one go: shared by
    // both modes, so the progression cannot drift between them.
    const finish = useCallback((ch, credit, prefsNow) => {
        setVerdict('right');
        if (!credit) {
            setStatus(`✓ ${ch} — second go, no credit`);
            timer.current = setTimeout(() => { if (alive.current) nextRound(); }, NEXT_MS);
            return;
        }
        const now = streak + 1;
        setStreak(now);
        const nextRun = run + 1;
        if (nextRun >= UNLOCK_RUN && prefsNow.level < KOCH.length) {
            setRun(0);
            const level = prefsNow.level + 1;
            save({ ...prefsNow, level, run: 0, best: Math.max(now, prefsNow.best) });
            setStatus(`✓ ${ch} — new character: ${KOCH[level - 1]}`);
        } else {
            setRun(nextRun);
            // Written on every correct answer rather than only when the best
            // improves: the run is the thing that would be lost, and one small
            // localStorage write per character is nothing next to sending one.
            save({ ...prefsNow, run: nextRun, best: Math.max(now, prefsNow.best) });
            setStatus(`✓ ${ch}`);
        }
        timer.current = setTimeout(() => { if (alive.current) nextRound(); }, NEXT_MS);
    }, [nextRound, run, save, streak]);

    // Got wrong, but not over: the streak goes, the answer is *not* shown, and it
    // is sent again to be listened to properly. Being told the answer the instant
    // you guess is how a trainer stops teaching — the character you could not hear
    // is exactly the one worth hearing twice.
    const miss = useCallback((prefsNow) => {
        setMissed(true);
        setStreak(0);
        setRun(0);
        save({ ...prefsNow, run: 0 });
        sendChar(target, prefsNow);
        setStatus(prefsNow.mode === 'send' ? 'Not that — listen, and key it again' : 'Not that one — listen again');
    }, [save, sendChar, target]);

    /**
     * A hint, for Send: the next element you have to key, on its own.
     *
     * This belongs to Send and to nothing else. In Copy the character has already
     * been sounded in full — replaying the first element of something you have just
     * heard end to end is not a hint, it is a shorter copy of the question. Sending
     * is the mode where the pattern genuinely is not known: it is on screen as a
     * letter and has to come back out as rhythm.
     *
     * Never the last element. `-.` is N, but it is equally the start of C, K, X and
     * Y, so a pattern with its final element still missing is a real question — and
     * one element short of the answer is as far as help can go without becoming the
     * answer. It follows from where you have keyed to, so it moves with you, and it
     * runs out one before the end. E and T, one element long, have no hint to give.
     *
     * Sounded and shown, not one or the other: the sound is the point when it is on,
     * and with it off there would otherwise be no hint at all.
     *
     * It costs the credit towards the next unlock, because a level climbed on hints
     * is a level you cannot send. It does not break the streak: only keying the wrong
     * element does that, and asking for help is not the same as getting it wrong.
     */
    const hint = useCallback(() => {
        if (verdict || !target) return;
        const code = codeFor(target);
        if (keyed.length >= code.length - 1) return;
        const el = code[keyed.length];
        setTip(el);
        setMissed(true);
        sendElement(el, prefs);
    }, [keyed, prefs, sendElement, target, verdict]);

    // Giving up. Its own path rather than a wrong answer, because it is the one
    // case where showing the answer is the useful thing to do.
    const giveUp = useCallback(() => {
        if (verdict || !target) {
            nextRound();
            return;
        }
        setVerdict('wrong');
        setStreak(0);
        setRun(0);
        save({ ...prefs, run: 0 });
        setStatus(`✗ it was ${target}`);
        sendChar(target, prefs);
        timer.current = setTimeout(() => { if (alive.current) nextRound(); }, WRONG_MS);
    }, [nextRound, prefs, save, sendChar, target, verdict]);

    const answer = (ch) => {
        if (verdict || !target || wrong.includes(ch)) return;
        if (ch === target) {
            finish(target, !missed, prefs);
            return;
        }
        // Struck off and left on screen: it is a real answer, and knowing what it
        // was not is part of telling two characters apart.
        setWrong((w) => [...w, ch]);
        miss(prefs);
    };

    // Send mode: one element at a time, judged as it goes.
    //
    // Wrong the moment it diverges rather than at the end of the character — that
    // is how a fist feels its own mistake, and waiting for four elements to say
    // "no" teaches nothing about which one was wrong. The buffer is then cleared
    // and the character sent again, so the next attempt is made against the sound
    // rather than against a guess.
    const keyEl = useCallback((el) => {
        if (verdict || !target) return;
        const code = codeFor(target);
        const next = keyed + el;
        setTip('');
        sendElement(el, prefs);
        if (!code.startsWith(next)) {
            setKeyed('');
            miss(prefs);
            return;
        }
        setKeyed(next);
        if (next === code) finish(target, !missed, prefs);
    }, [finish, keyed, miss, missed, prefs, sendElement, target, verdict]);

    /**
     * Typing mode: the character itself, off the keyboard, with the keys still on
     * screen — they are the set in play, and clicking one is still an answer.
     *
     * The listener is on the document rather than on a focused input. An input would
     * have got the keys for free (the shortcut layer already stands down for one),
     * but it would also have to *hold the focus* to keep them: a click on Hint, on
     * Reveal, on a picker, and the next character typed would be tuning the radio.
     * So the mode claims the keys outright for as long as it is on — see claimKeys —
     * and the claim is taken and released by this effect, which means closing the
     * panel or switching to Send gives them back without anything having to remember
     * to.
     *
     * Read through a ref so the listener is registered once. Rebuilding it on every
     * render would drop the keystroke that lands in the gap, and this one is a game
     * answer being timed.
     */
    const live = useRef(null);
    live.current = { answer, replay: () => sendChar(target, prefs) };
    useEffect(() => {
        if (!started || !visible || covered || prefs.mode !== 'copy' || !prefs.typed) return undefined;
        const release = claimKeys();
        const onKey = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // A chat message or a bookmark name still outranks the game.
            if (isTyping(e.target)) return;
            if (e.key === 'Enter') { e.preventDefault(); live.current.replay(); return; }
            if (e.key.length !== 1) return;
            const ch = e.key.toUpperCase();
            // Not a Morse character at all: a slip, not an answer. One that *is* —
            // including a character not yet in play — is a real answer and wrong in
            // the usual way, which is a mistake the five keys cannot even express.
            if (!codeFor(ch)) return;
            e.preventDefault();
            live.current.answer(ch);
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            release();
        };
    }, [covered, prefs.mode, prefs.typed, started, visible]);

    // Minimised, mid-round. The panel is still mounted — see GamesPanel — so nothing
    // else would have stopped it: the character being sent would finish and the timer
    // would deal another, into a window on the strip that nobody can see. It stops
    // and it goes back behind the start overlay, because a game that resumed on its
    // own when the window came back would be making a noise nobody had just asked for
    // all over again.
    useEffect(() => {
        if (visible || !started) return;
        clearTimeout(timer.current);
        silence();
        setStarted(false);
        setStatus('Ready');
    }, [silence, started, visible]);

    // Two keys side by side, so it can be played like a paddle rather than typed:
    // `.` and `/` are neighbours with the dit on the left, which is the way round a
    // paddle is wired, and `.` is the dit's own glyph. D and F are the same thing
    // for the left hand.
    //
    // Every one of them is a key the receiver's own shortcuts leave alone — the
    // arrows tune, Z and X are the filter, and most other letters are a mode or a
    // band. See lib/shortcuts.js: taking one of those would have the game tuning
    // the radio while you keyed.
    const DIT_KEYS = ['.', 'd'];
    const DAH_KEYS = ['/', 'f', '-'];
    useEffect(() => {
        if (!started || !visible || covered || prefs.mode !== 'send') return undefined;
        const onKey = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (isTyping(e.target)) return;
            const k = e.key.toLowerCase();
            if (DIT_KEYS.includes(k)) { e.preventDefault(); keyEl('.'); }
            else if (DAH_KEYS.includes(k)) { e.preventDefault(); keyEl('-'); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [covered, prefs.mode, keyEl, started, visible]);

    const set = kochSet(prefs.level);
    const code = codeFor(target);
    const glyphs = (s) => s.replace(/\./g, '·').replace(/-/g, '–');
    // Copy: the pattern is hidden until answered, or shown from the start when the
    // sound is off, which is the whole game in that mode. Send: what you have keyed.
    const showCode = prefs.mode === 'send' ? true : (!!verdict || !prefs.sound);

    return (
        <Frame
            info={(
                <>
                    {/* The readout is the control: somebody who already knows half
                        the alphabet should not have to prove it five characters at
                        a time. */}
                    <label className="cw__level">
                        Level
                        <select
                            className="select cw__sel"
                            value={prefs.level}
                            aria-label="Level"
                            onChange={(e) => {
                                const next = { ...prefs, level: Number(e.target.value), run: 0 };
                                setRun(0);
                                save(next);
                                restart(next);
                            }}
                        >
                            {KOCH.map((ch, i) => (i + 1 >= KOCH_MIN
                                ? <option key={ch} value={i + 1}>{i + 1} · {ch}</option>
                                : null))}
                        </select>
                    </label>
                    {/* The newest few rather than all of them. By level 28 the
                        full set is a line and a half of monospace, which crowded
                        the picker beside it — and the ones worth showing are the
                        ones being learned, not the twenty that are known. The whole
                        set is in the tooltip. */}
                    <span className="cw__inplay" title={`In play: ${set.join(' ')}`}>
                        {set.length > NEWEST ? '… ' : ''}{set.slice(-NEWEST).join(' ')}
                    </span>
                </>
            )}
            status={status}
            score={`Streak:${streak} Best:${prefs.best}`}
            /* Wrapped, not passed: Frame hands its action the click event, and
               begin() takes the prefs to start from — a MouseEvent has no level. */
            action={started ? giveUp : () => begin()}
            actionLabel={started ? 'Reveal' : 'Start'}
        >
            <div className="cw">
                {/* The play area, and the start overlay over it. Wrapped so the
                    overlay covers the game and nothing else: mode, level, pitch and
                    speed stay reachable before the first character, which is where
                    somebody who wants to send rather than copy would set them. */}
                <div className="cw__area">
                    {prefs.mode === 'send' ? (
                        <>
                            {/* What to send. Big, because it is the prompt rather than
                                the answer. */}
                            <div className="cw__target">{target}</div>
                            <div className={`cw__code cw__code--keyed is-${verdict || 'open'}`}>
                                {keyed ? glyphs(keyed) : '·–'}
                            </div>
                            <div className="cw__paddle">
                                <button
                                    type="button"
                                    className="cw__key"
                                    onClick={() => keyEl('.')}
                                    disabled={!!verdict}
                                    title="Dit — or the . or D key"
                                >
                                    ·
                                </button>
                                <button
                                    type="button"
                                    className="cw__key"
                                    onClick={() => keyEl('-')}
                                    disabled={!!verdict}
                                    title="Dah — or the / or F key"
                                >
                                    –
                                </button>
                            </div>
                            <button
                                type="button"
                                className="chip chip--button cw__play"
                                onClick={hint}
                                disabled={!!verdict || keyed.length >= code.length - 1}
                                title={code.length < 2
                                    ? 'One element — there is nothing to give away'
                                    : 'The next element, sounded and shown. Never the last one, so it never keys the character for you — and it costs the credit towards the next unlock'}
                            >
                                Hint
                            </button>
                            <div className="cw__hint">
                                {verdict
                                    ? `${target} is ${glyphs(code)}`
                                    : tip
                                        ? `next  ${glyphs(tip)}`
                                        : 'keys  .  /   or  D  F'}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className={`cw__code${showCode ? '' : ' is-hidden'}`}>
                                {showCode ? glyphs(code) : '?'}
                            </div>
                            <button
                                type="button"
                                className="chip chip--button cw__play"
                                onClick={() => sendChar(target, prefs)}
                                disabled={!prefs.sound}
                                title={prefs.sound ? 'Send it again' : 'Sound is off'}
                            >
                                ▶ Again
                            </button>
                            {/* Five columns always, so the row is the same height and
                                the keys the same width at every level — but the ones in
                                play sit in the middle of it rather than packed left.
                                Early on there are only two characters to choose
                                between, and two keys against the left edge of an empty
                                row reads as something having failed to load. */}
                            <div className="cw__options">
                                {Array.from({ length: OPTIONS }, (_, i) => {
                                    const ch = options[i - Math.floor((OPTIONS - options.length) / 2)];
                                    if (!ch) return <span className="cw__opt is-blank" key={`b${i}`} aria-hidden="true" />;
                                    return (
                                        <button
                                            key={ch}
                                            type="button"
                                            className={[
                                                'cw__opt',
                                                verdict ? 'is-done' : '',
                                                verdict && ch === target ? 'is-right' : '',
                                                wrong.includes(ch) ? 'is-wrong' : '',
                                            ].filter(Boolean).join(' ')}
                                            onClick={() => answer(ch)}
                                            disabled={!!verdict || wrong.includes(ch)}
                                        >
                                            {ch}
                                        </button>
                                    );
                                })}
                            </div>
                            {/* Said plainly, because it is a side effect on the rest of
                                the page: while this is on, the receiver's shortcut keys
                                do nothing. Better on screen than discovered by pressing
                                M and wondering why the mode did not change. */}
                            {prefs.typed ? (
                                <div className="cw__hint">
                                    press the character &nbsp;·&nbsp; radio keys paused
                                </div>
                            ) : null}
                        </>
                    )}
                    {!started ? (
                        <div className="cw__start">
                            <button type="button" className="btn btn--primary cw__go" onClick={() => begin()}>
                                ▶ Start
                            </button>
                            <div className="cw__starttip">
                                {prefs.mode === 'send'
                                    ? `Send · level ${prefs.level}`
                                    : `Copy · level ${prefs.level}${prefs.sound ? '' : ' · silent'}`}
                            </div>
                        </div>
                    ) : null}
                </div>

                {/* Two rows, split by how often they are touched rather than by
                    what would fit: the toggles are flipped mid-session — mode every
                    few rounds, sound when someone walks in — and the pitch and speed
                    are set once and left, the way they are on a rig.

                    They did share a row, and it stopped working when typing made a
                    fourth toggle. Three chips take about 100px of a dock that can be
                    dragged down to 220, which left the two pickers 37px each for
                    "700 Hz" — a clipped picker, and the only thing that shrinks in a
                    row where everything else is fixed. */}
                <div className="cw__controls">
                    <button
                        type="button"
                        className="chip chip--button cw__mode"
                        title={prefs.mode === 'send' ? 'Switch to copying' : 'Switch to sending'}
                        onClick={() => {
                            const next = { ...prefs, mode: prefs.mode === 'send' ? 'copy' : 'send' };
                            save(next);
                            restart(next);
                        }}
                    >
                        {prefs.mode === 'send' ? 'Send' : 'Copy'}
                    </button>
                    <button
                        type="button"
                        className={`chip chip--button${prefs.sound ? ' is-active' : ''}`}
                        title={prefs.sound ? 'Sound on — click for pattern only' : 'Sound off — click to listen'}
                        aria-pressed={prefs.sound}
                        onClick={() => {
                            const next = { ...prefs, sound: !prefs.sound };
                            save(next);
                            if (started && next.sound && next.mode === 'copy') sendChar(target, next);
                        }}
                    >
                        {prefs.sound ? '🔊' : '🔇'}
                    </button>
                    {prefs.mode === 'copy' ? (
                        <button
                            type="button"
                            className={`chip chip--button${prefs.typed ? ' is-active' : ''}`}
                            aria-pressed={prefs.typed}
                            title={prefs.typed
                                ? 'Keyboard on — the radio\u2019s shortcut keys are paused. Click to give them back'
                                : 'Answer from the keyboard: press the character instead of clicking it. The radio\u2019s shortcut keys pause while it is on'}
                            onClick={() => save({ ...prefs, typed: !prefs.typed })}
                        >
                            ⌨
                        </button>
                    ) : null}
                </div>
                {/* Pitch and speed stay enabled with the sound off, so they can be
                    set before it is turned on rather than after. */}
                <div className="cw__rig">
                    <select
                        className="select cw__sel"
                        value={prefs.pitch}
                        aria-label="Tone"
                        title="Sidetone pitch"
                        onChange={(e) => save({ ...prefs, pitch: Number(e.target.value) })}
                    >
                        {PITCHES.map((hz) => <option key={hz} value={hz}>{hz} Hz</option>)}
                    </select>
                    <select
                        className="select cw__sel"
                        value={prefs.wpm}
                        aria-label="Speed"
                        title={`Words per minute — a dit is ${Math.round(unitMs(prefs.wpm))} ms`}
                        onChange={(e) => save({ ...prefs, wpm: Number(e.target.value) })}
                    >
                        {SPEEDS.map((w) => <option key={w} value={w}>{w} wpm</option>)}
                    </select>
                </div>

                {/* What the next character is, and what it costs. Also the answer to
                    "why are there only two of them": you are two characters in, and
                    the third has a name and a price. */}
                <div className="cw__next">
                    {prefs.level >= KOCH.length
                        ? `All ${KOCH.length} characters in play`
                        : `${UNLOCK_RUN - run} in a row to unlock ${KOCH[prefs.level]}`}
                </div>
            </div>
        </Frame>
    );
}
