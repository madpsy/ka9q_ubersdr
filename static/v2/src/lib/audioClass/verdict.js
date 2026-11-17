// What the audio classifier's verdicts add up to, and how the badge says it.
//
// Pure functions, so the tests can pin them: the engine (./classifier.js)
// keeps the history, this decides what it means.
//
// Two answers come from each window: VOICE / MUSIC / NOISE (AudioSet's tags,
// smoothed as below) and, when the receiver serves the signal references,
// which signal it is (./signals.js: FT8, CW, RTTY..., or a family such as FSK
// when it is sure of the kind but not the signal). A confident name wins the
// badge; then a family; then VOICE / MUSIC / NOISE, in the modes that carry
// voice or music (not CW, where only a name or a family is worth showing).
//
// The model gives one verdict per 5 s window, refreshed every 2.5 s, and a
// single window that lands in a pause between words reads as noise. So the
// badge shows the majority of the last three, and only the latest when there
// is no majority: one pause cannot flip a conversation to NOISE, and a new
// signal still shows within two windows.

import { MODE_BY_ID } from '../../radio/constants.js';

// The window the model is asked about, and how often. See classifier.go for
// the measurements behind 5 s.
export const WINDOW_SEC = 5;
export const HOP_MS = 2500;
// How many verdicts the badge is the majority of.
export const HISTORY = 3;

const LABELS = ['voice', 'music', 'noise'];

function modeGroup(mode) {
    const m = MODE_BY_ID[String(mode || '').toLowerCase()];
    return m ? m.group : null;
}

/** Whether a mode carries demodulated audio worth classifying: SSB, AM, FM, CW. */
export function classifiableMode(mode) {
    const g = modeGroup(mode);
    return g === 'voice' || g === 'cw';
}

/** Whether VOICE / MUSIC / NOISE means anything in a mode: SSB, AM, FM. */
export function voiceMode(mode) {
    return modeGroup(mode) === 'voice';
}

/**
 * The label the badge shows for a history of verdicts, oldest first: the
 * majority of the last HISTORY, or the latest when none has one. null for an
 * empty history.
 */
export function smoothLabel(history) {
    const recent = (history || []).slice(-HISTORY);
    if (!recent.length) return null;
    const count = {};
    for (const r of recent) count[r.label] = (count[r.label] || 0) + 1;
    for (const l of LABELS) if (count[l] * 2 > recent.length) return l;
    return recent[recent.length - 1].label;
}

const SHORT = { voice: 'VOICE', music: 'MUSIC', noise: 'NOISE' };
const NAME = { voice: 'Voice', music: 'Music', noise: 'Noise' };

/**
 * The badge, or null when there should be none.
 *
 * `state` is the engine's: { status, history, quiet, ms }. `mode` is the
 * radio's (no mode: as SSB). Nothing shows while the classifier is off, has
 * failed (it is on by default; a receiver that cannot serve the model should
 * not put a fault in front of every listener — the Display panel says why), or
 * has not yet heard enough to say anything.
 */
export function badge(state, mode) {
    if (!state || state.status !== 'ready') return null;
    const history = state.history || [];
    const latest = history[history.length - 1];
    const sig = latest && latest.signal;
    if (sig && sig.say === 'name') {
        return { text: sig.short, tone: state.quiet ? 'ghost' : 'accent', title: signalTitle(sig, latest, state, true) };
    }
    if (sig && sig.say === 'family') {
        return { text: sig.familyText, tone: 'ghost', title: signalTitle(sig, latest, state, false) };
    }
    if (mode !== undefined && !voiceMode(mode)) return null;
    const label = smoothLabel(history);
    if (!label) return null;
    const tone = state.quiet ? 'ghost' : ({ voice: 'good', music: 'accent', noise: 'ghost' }[label]);
    return { text: SHORT[label], tone, title: title(label, latest, history, state) };
}

function seconds(windows) {
    // Windows of 5 s, one every 2.5 s.
    return Math.round(WINDOW_SEC + (windows - 1) * HOP_MS / 1000);
}

function signalTitle(sig, latest, state, named) {
    const lines = [];
    const over = `over the last ${seconds(sig.windows)} s`;
    if (state.quiet) lines.push('When there was last audio — nothing is coming through now (squelch closed?)');
    if (named) {
        lines.push(`${sig.name} — ${pct(sig.p)} likely, ${over}`);
        lines.push(`Kind: ${sig.familyText} (${pct(sig.familyP)})`);
    } else {
        lines.push(`${sig.familyText} — ${pct(sig.familyP)} likely, ${over}; not sure which signal`);
    }
    const others = sig.top.slice(named ? 1 : 0).filter((t) => t.p >= 0.01);
    if (others.length) lines.push(`${named ? 'Next closest' : 'Closest'}: ${others.map((t) => `${t.name} ${pct(t.p)}`).join(', ')}`);
    if (latest && latest.label) lines.push(`Also heard as: ${NAME[latest.label] || latest.label}`);
    lines.push('Named in this browser by comparing with reference recordings of known signals');
    lines.push('Click to switch it off (Display panel)');
    return lines.join('\n');
}

function pct(x) {
    return `${Math.round((x || 0) * 100)}%`;
}

function title(label, latest, history, state) {
    const lines = [];
    if (state.quiet) {
        lines.push(`${NAME[label]} — when there was last audio. Nothing is coming through now (squelch closed?)`);
    } else if (latest && latest.label === label) {
        lines.push(`${NAME[label]} — ${pct(latest.confidence)} likely, over the last ${WINDOW_SEC} s`);
    } else {
        lines.push(`${NAME[label]} — most of the last ${history.slice(-HISTORY).length} looks`);
    }
    const tags = (latest && latest.tags) || [];
    if (tags.length) {
        lines.push(`Heard: ${tags.slice(0, 4).map((t) => `${t.label} ${pct(t.score)}`).join(', ')}`);
    }
    const recent = history.slice(-HISTORY).map((r) => r.label);
    if (recent.length > 1) lines.push(`Last ${recent.length} looks: ${recent.join(', ')}`);
    const sig = latest && latest.signal;
    if (sig && sig.say !== 'name' && sig.say !== 'family' && sig.top && sig.top.length) {
        lines.push(`No particular signal recognised (closest: ${sig.top[0].name} ${pct(sig.top[0].p)})`);
    }
    const ms = latest && latest.ms;
    lines.push(`Classified in this browser by an audio tagger (EfficientAT mn05)${ms ? ` in ${Math.round(ms)} ms` : ''}`);
    lines.push('Click to switch it off (Display panel)');
    return lines.join('\n');
}

/**
 * What the Display panel says under the switch: what the classifier is doing,
 * or why it is not.
 */
export function statusText(state, mode) {
    if (!state) return '';
    switch (state.status) {
        case 'off': return '';
        case 'idle': return 'Starts when audio is playing in SSB, AM, FM or CW';
        case 'loading': return 'Loading the classifier — about 9 MB from this receiver, the first time only';
        case 'error': return `Not available: ${state.error || 'unknown error'}`;
        default:
            if (!classifiableMode(mode)) return 'Waiting for an SSB, AM, FM or CW mode';
            return state.history && state.history.length ? '' : `Listening — first verdict after ${WINDOW_SEC} s of audio`;
    }
}
