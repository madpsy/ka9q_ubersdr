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
            Sending is judged as you go: a wrong element is wrong the moment it is
            keyed rather than at the end of the character, which is how a fist feels
            its own mistake.
        </p>
    </>
);

const KEY = 'ubersdr.v2.games.morse';
const NEXT_MS = 1400;
const WRONG_MS = 2200;      // longer, because there is something to read
const OPTIONS = 5;

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
        };
    } catch (e) {
        return { level: KOCH_MIN, best: 0, sound: true, pitch: 600, wpm: 15, mode: 'copy' };
    }
}

export default function Morse() {
    const [prefs, setPrefs] = useState(load);
    const [target, setTarget] = useState('');
    const [options, setOptions] = useState([]);
    const [picked, setPicked] = useState('');       // copy mode: the answer given
    const [keyed, setKeyed] = useState('');         // send mode: what has been keyed
    const [verdict, setVerdict] = useState('');     // '' | 'right' | 'wrong'
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
        setPicked('');
        setKeyed('');
        setVerdict('');
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

    // Right, wrong, and what that does to the score — shared by both modes so the
    // progression cannot drift between them.
    const settle = useCallback((correct, ch, prefsNow) => {
        setVerdict(correct ? 'right' : 'wrong');
        if (!correct) {
            setStreak(0);
            setRun(0);
            setStatus(`✗ that was ${ch}`);
            // Hear what it should have been: the point of getting it wrong.
            sendChar(ch, prefsNow);
            timer.current = setTimeout(() => { if (alive.current) nextRound(prefsNow); }, WRONG_MS);
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
    }, [nextRound, run, save, sendChar, streak]);

    const answer = (ch) => {
        if (verdict || !target) return;
        setPicked(ch);
        settle(ch === target, target, prefs);
    };

    // Send mode: one element at a time, judged as it goes.
    //
    // Wrong the moment it diverges rather than at the end of the character — that
    // is how a fist feels its own mistake, and waiting for four elements to say
    // "no" teaches nothing about which one was wrong.
    const keyEl = useCallback((el) => {
        if (verdict || !target) return;
        const code = codeFor(target);
        const next = keyed + el;
        setKeyed(next);
        sendElement(el, prefs);
        if (!code.startsWith(next)) settle(false, target, prefs);
        else if (next === code) settle(true, target, prefs);
    }, [keyed, prefs, sendElement, settle, target, verdict]);

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
                    <span className="cw__inplay" title="The characters in play">{set.join(' ')}</span>
                </>
            )}
            status={status}
            score={`Streak:${streak} Best:${prefs.best}`}
            action={() => nextRound()}
            actionLabel="Skip"
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
                                            picked === ch && ch !== target ? 'is-wrong' : '',
                                        ].filter(Boolean).join(' ')}
                                        onClick={() => answer(ch)}
                                        disabled={!!verdict}
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
