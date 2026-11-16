// What the audio classifier's verdicts add up to, and how the badge says it.
//
// Pure functions, so the tests can pin them: the engine (./classifier.js)
// keeps the history, this decides what it means.
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

/** Whether a mode carries demodulated audio worth classifying: SSB, AM, FM. */
export function classifiableMode(mode) {
    const m = MODE_BY_ID[String(mode || '').toLowerCase()];
    return !!m && m.group === 'voice';
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
 * `state` is the engine's: { status, history, quiet, ms }. Nothing shows while
 * the classifier is off, has failed (it is on by default; a receiver that
 * cannot serve the model should not put a fault in front of every listener —
 * the Display panel says why), or has not yet heard enough to say anything.
 */
export function badge(state) {
    if (!state || state.status !== 'ready') return null;
    const history = state.history || [];
    const label = smoothLabel(history);
    if (!label) return null;
    const latest = history[history.length - 1];
    const tone = state.quiet ? 'ghost' : ({ voice: 'good', music: 'accent', noise: 'ghost' }[label]);
    return { text: SHORT[label], tone, title: title(label, latest, history, state) };
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
        case 'idle': return 'Starts when audio is playing in SSB, AM or FM';
        case 'loading': return 'Loading the classifier — about 10 MB from this receiver, the first time only';
        case 'error': return `Not available: ${state.error || 'unknown error'}`;
        default:
            if (!classifiableMode(mode)) return 'Waiting for an SSB, AM or FM mode';
            return state.history && state.history.length ? '' : `Listening — first verdict after ${WINDOW_SEC} s of audio`;
    }
}
