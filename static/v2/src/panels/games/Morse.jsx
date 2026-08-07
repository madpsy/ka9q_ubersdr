// Morse trainer, by the Koch method.
//
// A character is sent and you say which it was. Two to start with, and each time
// you get five right in a row another joins in — the order is Koch's, which adds
// each new character where it will be confused with one already known, because
// telling them apart is the whole skill.
//
// The code and the timing are lib/games/morse.js, where they are pinned by tests:
// the table is ITU, and the rhythm is the PARIS definition to the millisecond.
//
// Sound is optional and has a pitch, because this panel lives on a receiver: the
// operator may be listening to something, or wearing headphones tuned to their own
// sidetone. With it off the game still works — the pattern is shown instead of
// played, which is reading rather than listening, and a useful thing to practise
// in its own right.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    KOCH, KOCH_MIN, UNLOCK_RUN, codeFor, kochSet, pickChar, toneSlices, unitMs,
} from '../../lib/games/morse.js';

// How to play — shown by the ? beside the game picker. See GamesPanel.
export const gameHelp = (
    <>
        <p>
            A character is sent in Morse. Say which one it was. Five right in a row
            and another character joins in.
        </p>
        <p>
            You start with two — <b>K</b> and <b>M</b>, which sound nothing alike —
            and work through Koch&rsquo;s order, which is not alphabetical: each new
            character arrives where it can be confused with one you already know,
            because hearing the difference is the skill.
        </p>
        <p>
            <b>Speed</b> is real words per minute, and characters are sent at full
            speed from the start on purpose. Learning them slowly builds a habit of
            counting dits that has to be unlearned; if it is too fast, the answer is
            more listening rather than a lower speed.
        </p>
        <p>
            <b>Pitch</b> is the tone in hertz — pick whatever your ear likes, as you
            would on a rig. Turn the sound off and the pattern is shown instead,
            which practises reading rather than hearing.
        </p>
    </>
);

const KEY = 'ubersdr.v2.games.morse';
const NEXT_MS = 1400;
const OPTIONS = 5;

// Sidetone choices, in hertz. The range CW operators actually use: much below 400
// is muddy on a small speaker and much above 900 is tiring within a minute.
const PITCHES = [400, 500, 600, 700, 800];
// Character speeds. 20 wpm is where a fist stops sounding like counting, and the
// slower rungs are there to arrive at it rather than to stay on.
const SPEEDS = [12, 15, 18, 20, 25];

// The keying envelope, seconds. A tone switched on instantly clicks — the click is
// a spray of harmonics, it is what a badly keyed transmitter sounds like on air,
// and it makes a short dit hard to place. Real rigs shape the edges; five
// milliseconds is the usual figure and is short enough not to soften a dit at
// 25 wpm, where one is 48 ms.
const RAMP = 0.005;

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY)) || {};
        return {
            level: Math.min(Math.max(Number(saved.level) || KOCH_MIN, KOCH_MIN), KOCH.length),
            best: Number(saved.best) || 0,
            sound: saved.sound !== false,
            pitch: PITCHES.includes(saved.pitch) ? saved.pitch : 600,
            wpm: SPEEDS.includes(saved.wpm) ? saved.wpm : 15,
        };
    } catch (e) {
        return { level: KOCH_MIN, best: 0, sound: true, pitch: 600, wpm: 15 };
    }
}

export default function Morse() {
    const [prefs, setPrefs] = useState(load);
    const [target, setTarget] = useState('');
    const [options, setOptions] = useState([]);
    const [picked, setPicked] = useState('');
    const [run, setRun] = useState(0);            // correct in a row, towards the next unlock
    const [streak, setStreak] = useState(0);
    const [status, setStatus] = useState('Listen');
    const recent = useRef([]);
    const timer = useRef(null);
    const alive = useRef(true);

    // Its own audio context, not the receiver's. The player's belongs to the
    // signal path — its sample rate, its output device, its gain — and a game
    // borrowing it could stop the audio it is playing. Created on the first press
    // rather than on mount, because a context made without a user gesture starts
    // suspended and stays that way.
    const audio = useRef({ ctx: null, osc: null, gain: null });

    const save = useCallback((next) => {
        setPrefs(next);
        try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
    }, []);

    const silence = useCallback(() => {
        const a = audio.current;
        if (!a.ctx) return;
        try {
            a.gain.gain.cancelScheduledValues(a.ctx.currentTime);
            a.gain.gain.setValueAtTime(0, a.ctx.currentTime);
        } catch (e) { /* a context torn down mid-play */ }
    }, []);

    useEffect(() => () => {
        alive.current = false;
        clearTimeout(timer.current);
        const a = audio.current;
        if (a.ctx) a.ctx.close().catch(() => {});
    }, []);

    /**
     * Send a character.
     *
     * Every element is scheduled against the audio clock in one go rather than
     * fired off by timers: setTimeout is accurate to a few milliseconds at best
     * and worse under load, and at 20 wpm a dit is sixty. Morse whose rhythm
     * wanders is Morse nobody can learn from, so the sound card keeps the time.
     */
    const play = useCallback((ch, prefsNow) => {
        const { sound, pitch, wpm } = prefsNow;
        if (!sound || !ch) return;
        const a = audio.current;
        if (!a.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            a.ctx = new Ctx();
            a.gain = a.ctx.createGain();
            a.gain.gain.value = 0;
            a.gain.connect(a.ctx.destination);
            // One oscillator for the life of the panel, gated by the gain. Starting
            // and stopping an oscillator per dit is both more work and more clicks.
            a.osc = a.ctx.createOscillator();
            a.osc.type = 'sine';
            a.osc.frequency.value = pitch;
            a.osc.connect(a.gain);
            a.osc.start();
        }
        if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
        a.osc.frequency.setValueAtTime(pitch, a.ctx.currentTime);

        silence();
        let at = a.ctx.currentTime + 0.06;        // a beat before the first dit
        for (const slice of toneSlices(ch, wpm)) {
            const secs = slice.ms / 1000;
            if (slice.on) {
                // Ramped both ends: see RAMP.
                a.gain.gain.setValueAtTime(0, at);
                a.gain.gain.linearRampToValueAtTime(0.18, at + RAMP);
                a.gain.gain.setValueAtTime(0.18, at + Math.max(secs - RAMP, RAMP));
                a.gain.gain.linearRampToValueAtTime(0, at + secs);
            }
            at += secs;
        }
    }, [silence]);

    const nextRound = useCallback((prefsNow = prefs) => {
        clearTimeout(timer.current);
        setPicked('');
        const set = kochSet(prefsNow.level);
        const ch = pickChar(prefsNow.level, recent.current);
        recent.current = [...recent.current, ch].slice(-6);

        // Five choices, or everything in play while there are fewer than five.
        const others = set.filter((c) => c !== ch).sort(() => Math.random() - 0.5);
        const shown = [ch, ...others.slice(0, Math.max(1, OPTIONS - 1))]
            .sort(() => Math.random() - 0.5);
        setTarget(ch);
        setOptions(shown);
        setStatus(prefsNow.sound ? 'Listen' : 'Read the pattern');
        play(ch, prefsNow);
    }, [prefs, play]);

    useEffect(() => { nextRound(); }, []);

    const answer = (ch) => {
        if (picked || !target) return;
        setPicked(ch);
        if (ch === target) {
            const now = streak + 1;
            setStreak(now);
            const nextRun = run + 1;
            // Another character, once five in a row say the last one has landed.
            if (nextRun >= UNLOCK_RUN && prefs.level < KOCH.length) {
                setRun(0);
                const level = prefs.level + 1;
                save({ ...prefs, level, best: Math.max(now, prefs.best) });
                setStatus(`✓ ${target} — new character: ${KOCH[level - 1]}`);
            } else {
                setRun(nextRun);
                if (now > prefs.best) save({ ...prefs, best: now });
                setStatus(`✓ ${target}`);
            }
        } else {
            setStreak(0);
            setRun(0);
            setStatus(`✗ ${target}, not ${ch}`);
        }
        timer.current = setTimeout(() => { if (alive.current) nextRound(); }, NEXT_MS);
    };

    const set = kochSet(prefs.level);
    const code = codeFor(target);
    // The pattern: hidden while listening, shown once answered — and shown from
    // the start when the sound is off, which is the whole game in that mode.
    const showCode = !!picked || !prefs.sound;

    return (
        <Frame
            info={(
                <>
                    <span>Level {prefs.level}/{KOCH.length}</span>
                    <span>{UNLOCK_RUN - run} to go</span>
                </>
            )}
            status={status}
            score={`Streak:${streak} Best:${prefs.best}`}
            action={() => nextRound()}
            actionLabel="Skip"
        >
            <div className="cw">
                {/* The pattern, in a box that is there whether or not it has
                    anything in it — the answer arriving must not resize the panel.
                    Big, because dit-dah-dit is a shape you learn to read as one. */}
                <div className={`cw__code${showCode ? '' : ' is-hidden'}`}>
                    {showCode ? code.replace(/\./g, '·').replace(/-/g, '–') : '?'}
                </div>

                <button
                    type="button"
                    className="chip chip--button cw__play"
                    onClick={() => play(target, prefs)}
                    disabled={!prefs.sound}
                    title={prefs.sound ? 'Send it again' : 'Sound is off'}
                >
                    ▶ Again
                </button>

                <div className="cw__options">
                    {Array.from({ length: OPTIONS }, (_, i) => {
                        const ch = options[i];
                        if (!ch) return <span className="cw__opt is-blank" key={`b${i}`} aria-hidden="true" />;
                        return (
                            <button
                                key={ch}
                                type="button"
                                className={[
                                    'cw__opt',
                                    picked ? 'is-done' : '',
                                    picked && ch === target ? 'is-right' : '',
                                    picked === ch && ch !== target ? 'is-wrong' : '',
                                ].filter(Boolean).join(' ')}
                                onClick={() => answer(ch)}
                                disabled={!!picked}
                            >
                                {ch}
                            </button>
                        );
                    })}
                </div>

                {/* Sound, pitch and speed — the three things an operator adjusts on
                    a rig, in the same row. Pitch and speed stay enabled with the
                    sound off so they can be set before turning it on. */}
                <div className="cw__controls">
                    <button
                        type="button"
                        className={`chip chip--button${prefs.sound ? ' is-active' : ''}`}
                        title={prefs.sound ? 'Sound on — click for pattern only' : 'Sound off — click to listen'}
                        aria-pressed={prefs.sound}
                        onClick={() => {
                            const next = { ...prefs, sound: !prefs.sound };
                            save(next);
                            silence();
                            if (next.sound) play(target, next);
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

                <div className="cw__set" title="The characters in play">
                    {set.join(' ')}
                </div>
            </div>
        </Frame>
    );
}
