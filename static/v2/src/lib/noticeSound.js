// The notification ding: two sine partials and an envelope, built on the spot.
//
// Synthesised rather than shipped as a file, for the reasons the Morse sidetone is —
// nothing to fetch, nothing to cache, nothing to go missing on a receiver served over a
// slow link, and a couple of dozen lines against a few kilobytes of audio. See
// lib/morseTone.js, which this follows deliberately: a bell is a simpler sidetone.
//
// Never the receiver's own audio context. That one belongs to the signal path — its sample
// rate, its output device, its gain — and a ding borrowing it could interrupt the audio
// somebody is listening to. This one is its own, made on the first sound and kept.
//
// Everything here fails silently. A notification that threw because the machine has no
// sound card would be a worse bug than the missing ding, and the ding is decoration on a
// message that has already been delivered by the time this is called.

// The bell. 880 Hz with an octave above it at a fifth of the level: one sine alone is a
// test tone, and the partial is most of what makes it read as a chime rather than a beep.
export const DING_HZ = 880;
export const DING_PARTIAL = 2;
export const PARTIAL_LEVEL = 0.2;

// Quiet, because it is punctuation rather than an alarm, and because it plays over
// whatever the operator is actually listening to.
export const LEVEL = 0.14;

// The envelope, in seconds. A fast attack and a long exponential tail is what a struck
// object does; a square edge on either end is what a fire alarm does.
export const ATTACK = 0.004;
export const DECAY = 0.34;

// The shortest gap between two dings. Three notifications can land in the same instant —
// a burst of spots, a reconnect storm — and three overlapping bells is a noise rather than
// three messages. The toast layer's own limit is three on screen; this is the same idea
// applied to the ear, where they would all arrive at once rather than stack.
export const MIN_GAP_MS = 400;

let ctx = null;
let lastAt = 0;

/** The one context, made on demand. Null where this page cannot make sounds at all. */
function audio() {
    if (ctx) return ctx;
    // No window in a node test, and no AudioContext in a browser old enough to matter:
    // either way the caller carries on silently rather than throwing from a lookup.
    if (typeof window === 'undefined') return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { ctx = new Ctx(); } catch (e) { return null; }
    return ctx;
}

/**
 * Ding, unless one has just been played.
 *
 * Returns whether a sound was actually scheduled, which is what makes this testable and
 * is otherwise of no interest to any caller.
 */
export function playNoticeDing(now = Date.now()) {
    if (now - lastAt < MIN_GAP_MS) return false;
    const a = audio();
    if (!a) return false;
    // A context created outside a user gesture starts suspended and browsers are within
    // their rights to leave it that way. Resuming is worth asking for and not worth
    // waiting on: by the time somebody has a notification to hear, they have pressed
    // Start, which is a gesture.
    if (a.state === 'suspended') { try { a.resume(); } catch (e) { /* refused */ } }

    try {
        const t = a.currentTime;
        const gain = a.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(LEVEL, t + ATTACK);
        // Exponential, because that is how a struck thing decays and how the ear hears
        // loudness. It cannot reach zero, so it approaches it and is then set flat.
        gain.gain.exponentialRampToValueAtTime(0.0001, t + DECAY);
        gain.gain.setValueAtTime(0, t + DECAY + 0.01);
        gain.connect(a.destination);

        for (const [hz, level] of [[DING_HZ, 1], [DING_HZ * DING_PARTIAL, PARTIAL_LEVEL]]) {
            const osc = a.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(hz, t);
            const mix = a.createGain();
            mix.gain.setValueAtTime(level, t);
            osc.connect(mix);
            mix.connect(gain);
            osc.start(t);
            // Stopped rather than left running: an oscillator per ding is the cheap way
            // round, but only if each one goes away afterwards.
            osc.stop(t + DECAY + 0.05);
        }
    } catch (e) {
        return false;
    }
    lastAt = now;
    return true;
}

/** Test seam, and what a context that has been closed by the browser needs. */
export function _resetNoticeSound() {
    if (ctx) { try { ctx.close(); } catch (e) { /* already gone */ } }
    ctx = null;
    lastAt = 0;
}
