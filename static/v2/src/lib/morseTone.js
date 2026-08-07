// A Morse sidetone: an oscillator, a gain, and a list of slices scheduled onto the
// audio clock.
//
// Separate from lib/morse.js because that file is arithmetic and this one is a sound
// card. The split is what lets the table and the timing be tested in node, where
// there is no AudioContext at all — and it is why the two callers, the trainer and
// the callsign announcer, can share both halves without one of them owning the other.
//
// Never the receiver's own audio context. That one belongs to the signal path — its
// sample rate, its output device, its gain — and a sidetone borrowing it could stop
// the audio somebody is listening to.

import { DAH, DIT, toneSlices, unitMs } from './morse.js';

// The keying envelope, in seconds. A tone switched on instantly clicks — the click is
// a spray of harmonics, it is what a badly keyed transmitter sounds like on air, and
// it makes a short dit hard to place. Real rigs shape the edges; five milliseconds is
// the usual figure and is short enough not to soften a dit at 25 wpm, where one is
// 48 ms.
export const RAMP = 0.005;
export const LEVEL = 0.18;
// How far ahead of `currentTime` the first element goes. Scheduling at exactly now
// races the audio thread, which is already part way through the block it is filling.
export const LEAD = 0.04;

// What the two pickers offer, shared so the trainer and the announcer cannot drift
// apart on what a sensible sidetone is.
//
// Pitches are the range CW operators actually use: much below 400 is muddy on a small
// speaker and much above 900 is tiring within a minute. Speeds bracket 20 wpm, which
// is where a fist stops sounding like counting.
export const TONE_PITCHES = [400, 500, 600, 700, 800];
export const TONE_SPEEDS = [12, 15, 18, 20, 25];

export const clampPitch = (hz) => (TONE_PITCHES.includes(Number(hz)) ? Number(hz) : 600);
export const clampWpm = (wpm) => (TONE_SPEEDS.includes(Number(wpm)) ? Number(wpm) : 15);

/**
 * One player. Cheap to make and silent until asked: the context is created on the
 * first sound rather than here, because a context made outside a user gesture starts
 * suspended and browsers are within their rights to leave it that way.
 */
export function createSidetone() {
    const a = { ctx: null, osc: null, gain: null };

    const ensure = (pitch) => {
        if (a.ctx) return true;
        // No window at all in a node test, and no AudioContext in a browser old
        // enough to matter: either way the caller carries on silently rather than
        // throwing from inside a lookup.
        if (typeof window === 'undefined') return false;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return false;
        a.ctx = new Ctx();
        a.gain = a.ctx.createGain();
        a.gain.gain.value = 0;
        a.gain.connect(a.ctx.destination);
        // One oscillator for the life of the player, gated by the gain. Starting and
        // stopping one per dit is both more work and more clicks.
        a.osc = a.ctx.createOscillator();
        a.osc.type = 'sine';
        a.osc.frequency.value = pitch;
        a.osc.connect(a.gain);
        a.osc.start();
        return true;
    };

    return {
        /**
         * Put a list of `{ on, ms }` slices on the sound card, replacing anything
         * still queued.
         *
         * Scheduled in one go against the audio clock rather than fired off by
         * timers: setTimeout is accurate to a few milliseconds at best and worse
         * under load, and at 20 wpm a dit is sixty. Morse whose rhythm wanders is
         * Morse nobody can read, so the sound card keeps the time.
         *
         * Returns how long it will take, in seconds — a caller that wants to know
         * when it has finished should not have to add the slices up again.
         */
        play(slices, pitch = 600) {
            if (!slices || !slices.length) return 0;
            if (!ensure(pitch)) return 0;
            if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
            const now = a.ctx.currentTime;
            a.osc.frequency.setValueAtTime(pitch, now);
            try {
                a.gain.gain.cancelScheduledValues(now);
                a.gain.gain.setValueAtTime(0, now);
            } catch (e) { /* a context torn down mid-play */ }

            let at = now + LEAD;
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
            return at - now;
        },

        /** Text, at a speed. Farnsworth if `charWpm` is faster than `wpm`. */
        send(text, { wpm = 15, pitch = 600, charWpm } = {}) {
            return this.play(toneSlices(text, wpm, charWpm || wpm), pitch);
        },

        /** One element, the length it would be inside a character. */
        element(el, { wpm = 15, pitch = 600 } = {}) {
            const units = el === '-' ? DAH : DIT;
            return this.play([{ on: true, ms: units * unitMs(wpm) }], pitch);
        },

        /** Stop, mid-character if need be: everything queued is cancelled. */
        stop() {
            if (!a.ctx || !a.gain) return;
            try {
                const now = a.ctx.currentTime;
                a.gain.gain.cancelScheduledValues(now);
                a.gain.gain.setValueAtTime(0, now);
            } catch (e) { /* already torn down */ }
        },

        close() {
            if (a.ctx) a.ctx.close().catch(() => {});
            a.ctx = null;
            a.osc = null;
            a.gain = null;
        },
    };
}
