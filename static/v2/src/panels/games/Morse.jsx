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
// Sound is optional and has a pitch, because this panel lives on a receiver: the
// operator may be listening to something, or wearing headphones tuned to their own
// sidetone. With it off, Copy shows the pattern instead of playing it — reading
// rather than listening, and worth practising in its own right.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    DAH, DIT, KOCH, KOCH_MIN, UNLOCK_RUN, codeFor, kochSet, pickChar, toneSlices, unitMs,
} from '../../lib/games/morse.js';

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
            <b>⌨</b> in Copy swaps the five keys for a box you type the character
            into — no menu to choose from, which is harder and is what copying
            actually is. The receiver&rsquo;s own keyboard shortcuts stand down while
            that box has the keyboard, so <b>U</b> is an answer rather than USB; click
            it again if you have clicked away, and the shortcuts come back the moment
            you do.
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
            its own mistake. <b>Reveal</b> gives up and shows the answer.
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
        };
    } catch (e) {
        return { level: KOCH_MIN, best: 0, sound: true, pitch: 600, wpm: 15, mode: 'copy', typed: false };
    }
}

export default function Morse() {
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
    // Copy: how many elements of the pattern the hint has given away. Never all of
    // them — see hint().
    const [hinted, setHinted] = useState(0);
    // Typing mode: the character in the box, which is the last key pressed rather
    // than an accumulating string — one answer per round, and seeing it land is the
    // only feedback a typed guess gets.
    const [typed, setTyped] = useState('');
    const [armed, setArmed] = useState(false);      // the box holds the keyboard
    const [run, setRun] = useState(0);              // correct in a row, towards the next unlock
    const [streak, setStreak] = useState(0);
    const [status, setStatus] = useState('Listen');
    const recent = useRef([]);
    const timer = useRef(null);
    const alive = useRef(true);

    // Its own audio context, not the receiver's. The player's belongs to the signal
    // path — its sample rate, its output device, its gain — and a game borrowing it
    // could stop the audio it is playing. Created on the first press rather than on
    // mount, because a context made without a user gesture starts suspended.
    const audio = useRef({ ctx: null, osc: null, gain: null });
    const typeRef = useRef(null);
    const focusType = useCallback(() => {
        const el = typeRef.current;
        if (el) el.focus();
    }, []);

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
        setHinted(0);
        setTyped('');
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

    useEffect(() => { nextRound(); }, []);

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
            save({ ...prefsNow, level, best: Math.max(now, prefsNow.best) });
            setStatus(`✓ ${ch} — new character: ${KOCH[level - 1]}`);
        } else {
            setRun(nextRun);
            if (now > prefsNow.best) save({ ...prefsNow, best: now });
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
        sendChar(target, prefsNow);
        setStatus(prefsNow.mode === 'send' ? 'Not that — listen, and key it again' : 'Not that one — listen again');
    }, [sendChar, target]);

    /**
     * A hint: the next element of the pattern, heard on its own and left on screen.
     *
     * Never the last one. A character with its final element missing is still a
     * question — `-.` is N, but it is also the start of C, K, X and Y — so the hint
     * can narrow the field without ever answering it. That also means E and T,
     * being one element long, have no hint to give, and the button says so by being
     * unavailable rather than by doing nothing.
     *
     * It costs the credit towards the next unlock, because a level climbed on hints
     * is a level you cannot hear. It does not break the streak: only a wrong answer
     * does that, and asking for help is not the same as getting it wrong.
     */
    const hint = useCallback(() => {
        if (verdict || !target) return;
        const code = codeFor(target);
        if (hinted >= code.length - 1) return;
        const n = hinted + 1;
        setHinted(n);
        setMissed(true);
        sendElement(code[n - 1], prefs);
    }, [hinted, prefs, sendElement, target, verdict]);

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
        setStatus(`✗ it was ${target}`);
        sendChar(target, prefs);
        // Reveal is a button and a button takes the focus with it, which in typing
        // mode means the next keystroke reaches the radio instead of the game.
        if (prefs.typed && prefs.mode === 'copy') focusType();
        timer.current = setTimeout(() => { if (alive.current) nextRound(); }, WRONG_MS);
    }, [focusType, nextRound, prefs, sendChar, target, verdict]);

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

    /**
     * A typed answer.
     *
     * Read from the value rather than from the keystroke: a phone's keyboard often
     * reports `Unidentified` for the key and only the resulting text is reliable, so
     * the box is the source of truth on every platform. Only the last character of
     * it counts — the box holds one answer, not a word.
     *
     * A key that is not a Morse character at all is a slip and is ignored. One that
     * is — including a character not yet in play — is a real answer and is wrong in
     * the usual way, because "I heard something else" is the mistake being trained
     * out, and the five-key version cannot express it at all.
     */
    const onTyped = (e) => {
        const ch = String(e.target.value || '').slice(-1).toUpperCase();
        setTyped(ch);
        if (ch && codeFor(ch)) answer(ch);
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
        sendElement(el, prefs);
        if (!code.startsWith(next)) {
            setKeyed('');
            miss(prefs);
            return;
        }
        setKeyed(next);
        if (next === code) finish(target, !missed, prefs);
    }, [finish, keyed, miss, missed, prefs, sendElement, target, verdict]);

    // Turning typing on takes the keyboard there and then — inside the click, so a
    // phone opens its keyboard rather than waiting to be tapped again. Not on mount,
    // though: a panel restoring a saved preference has no business stealing the
    // keyboard, or opening a keyboard over half the screen, before it is asked to.
    const mounted = useRef(false);
    useEffect(() => {
        if (mounted.current && prefs.typed && prefs.mode === 'copy') focusType();
        mounted.current = true;
    }, [focusType, prefs.typed, prefs.mode]);

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
        if (prefs.mode !== 'send') return undefined;
        const onKey = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const el = e.target;
            const tag = el && el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
            const k = e.key.toLowerCase();
            if (DIT_KEYS.includes(k)) { e.preventDefault(); keyEl('.'); }
            else if (DAH_KEYS.includes(k)) { e.preventDefault(); keyEl('-'); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [prefs.mode, keyEl]);

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
                                const next = { ...prefs, level: Number(e.target.value) };
                                setRun(0);
                                save(next);
                                nextRound(next);
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
            action={giveUp}
            actionLabel="Reveal"
        >
            <div className="cw">
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
                        <div className="cw__hint">
                            {verdict ? `${target} is ${glyphs(code)}` : 'keys  .  /   or  D  F'}
                        </div>
                    </>
                ) : (
                    <>
                        <div className={`cw__code${showCode ? '' : ' is-hidden'}`}>
                            {showCode ? glyphs(code)
                                : (hinted ? `${glyphs(code.slice(0, hinted))}?` : '?')}
                        </div>
                        <div className="cw__row">
                            <button
                                type="button"
                                className="chip chip--button"
                                onClick={() => sendChar(target, prefs)}
                                onMouseDown={(e) => { if (prefs.typed) e.preventDefault(); }}
                                disabled={!prefs.sound}
                                title={prefs.sound ? 'Send the whole character again' : 'Sound is off'}
                            >
                                ▶ Again
                            </button>
                            <button
                                type="button"
                                className="chip chip--button"
                                onClick={hint}
                                onMouseDown={(e) => { if (prefs.typed) e.preventDefault(); }}
                                disabled={!!verdict || hinted >= code.length - 1}
                                title={code.length < 2
                                    ? 'One element — there is nothing to give away'
                                    : 'Play the next element. Never the last one, so it narrows the answer without giving it — and costs the credit towards the next unlock'}
                            >
                                Hint {hinted ? `${hinted}/${Math.max(code.length - 1, 0)}` : ''}
                            </button>
                        </div>
                        {prefs.typed ? (
                            <div className="cw__typerow">
                                {/* A real input, and that is the whole trick: the
                                    receiver's shortcut layer already stands down for
                                    whatever is being typed into (see isTyping in
                                    lib/shortcuts.js), so the letters are the game's
                                    for as long as the box has the focus and nobody's
                                    setting has been changed behind their back. A
                                    toggle would have to be put back — on close, on
                                    unmount, on a crash — and one that failed to
                                    would leave the radio deaf to its own keys. */}
                                <input
                                    ref={typeRef}
                                    className={`cw__type${armed ? ' is-armed' : ''} is-${verdict || 'open'}`}
                                    value={typed}
                                    /* Never disabled, not even while the verdict is
                                       up: disabling an input takes the focus off it,
                                       and doing that at the end of every round would
                                       hand the next character to the radio. answer()
                                       ignores a keystroke that arrives too late. */
                                    onChange={onTyped}
                                    onFocus={() => setArmed(true)}
                                    onBlur={() => setArmed(false)}
                                    aria-label="Type the character you heard"
                                    placeholder={armed ? '' : 'tap to type'}
                                    autoComplete="off"
                                    autoCapitalize="characters"
                                    spellCheck={false}
                                />
                                {/* What has been ruled out, which the five-key
                                    version shows by striking the keys. Always here,
                                    empty or not, so the panel keeps its height. */}
                                <div className="cw__ruled">
                                    {wrong.length ? `not ${wrong.join(' ')}` : '\u00a0'}
                                </div>
                            </div>
                        ) : null}
                        {/* Five columns always, so the row is the same height and
                            the keys the same width at every level — but the ones in
                            play sit in the middle of it rather than packed left.
                            Early on there are only two characters to choose
                            between, and two keys against the left edge of an empty
                            row reads as something having failed to load. */}
                        <div className={`cw__options${prefs.typed ? ' is-off' : ''}`}>
                            {prefs.typed ? null : Array.from({ length: OPTIONS }, (_, i) => {
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
                    </>
                )}

                {/* Mode, sound, pitch and speed — the four things you would reach
                    for on a rig, in one row. Pitch and speed stay enabled with the
                    sound off so they can be set before turning it on. */}
                <div className="cw__controls">
                    <button
                        type="button"
                        className="chip chip--button cw__mode"
                        title={prefs.mode === 'send' ? 'Switch to copying' : 'Switch to sending'}
                        onClick={() => {
                            const next = { ...prefs, mode: prefs.mode === 'send' ? 'copy' : 'send' };
                            save(next);
                            nextRound(next);
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
                            if (next.sound && next.mode === 'copy') sendChar(target, next);
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
                                ? 'Typing — click for the five keys back'
                                : 'Type the answer instead of picking it. The radio\u2019s keyboard shortcuts stand down while the box has the keyboard'}
                            onClick={() => save({ ...prefs, typed: !prefs.typed })}
                        >
                            ⌨
                        </button>
                    ) : null}
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
