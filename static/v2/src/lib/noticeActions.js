// What a notification can be pressed to do.
//
// A notification that says a station is on 7.150 and then makes you type 7150 into the
// dial has told you something and then made you do the work anyway. So one of them can
// carry an action: press the toast, or its line in the panel, and the receiver does the
// obvious thing.
//
// ── Why the action is data and not a function ────────────────────────────────
//
// A callback would be shorter to write and wrong in three ways. The notification store is
// a plain module that any code may push into — a watcher, a promise handler, a module with
// no React in it — and none of those have the radio's actions to hand; a closure captured
// at push time would go stale, because the notification outlives the moment by design and
// the history keeps it for fifty more; and nothing about a stored function can be checked,
// so a bad one is a crash inside a click handler rather than a notification that simply
// has no action on it.
//
// So: a small validated descriptor, a registry of the kinds, and one place that performs
// them. Adding a kind is an entry here and nothing else — the toast layer and the panel
// both already draw whatever this validates and run whatever it performs.
//
// This file knows about the radio's actions, which is why it is not in notifications.js:
// that one is the store, and a store that could tune the receiver is a store that does
// more than keep a list.

import { formatFreqShort } from './format.js';

/** The modes a notification is allowed to ask for. The same set tuneTarget accepts. */
const MODES = /^(usb|lsb|am|sam|fm|nfm|cwu|cwl)$/;

/**
 * A tune action, from a frequency and optionally a mode.
 *
 * Returns null rather than a half-built action when there is no frequency: a notification
 * with an action that does nothing is worse than one with no action, because it is
 * pressable and looks like it should work.
 */
export function tuneAction(target) {
    if (!target) return null;
    const frequency = Number(target.frequency) || 0;
    if (!(frequency > 0)) return null;
    const mode = MODES.test(String(target.mode || '')) ? String(target.mode) : '';
    // Mode omitted rather than guessed where the source did not report one — tuning to an
    // SSB station in the wrong sideband is the same as not tuning to it, and a mode
    // nobody asked for would overwrite whatever the operator had chosen.
    return mode ? { kind: 'tune', frequency, mode } : { kind: 'tune', frequency };
}

/**
 * An action as it should be stored, or null.
 *
 * Everything that reaches the store goes through this, so a caller cannot put an
 * unrecognised kind or a malformed payload into the history and have it surface as a
 * broken button later.
 */
export function normaliseNoticeAction(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'tune') return tuneAction(raw);
    return null;
}

/** What the press does, in words: the button's label and its tooltip. */
export function noticeActionLabel(action) {
    if (!action) return '';
    if (action.kind === 'tune') {
        const where = formatFreqShort(action.frequency);
        return action.mode ? `Tune to ${where} ${action.mode.toUpperCase()}` : `Tune to ${where}`;
    }
    return '';
}

/**
 * Do it.
 *
 * `actions` is the radio's action bag, from useRadio — passed in rather than imported,
 * because a lib that reached into a React context would only work from inside a component
 * and this has to be callable from the toast layer and the panel alike.
 *
 * Returns whether anything was done, which is what lets a caller decide not to dismiss a
 * toast whose action turned out to be a no-op.
 */
export function runNoticeAction(action, actions) {
    if (!action || !actions) return false;
    if (action.kind === 'tune') {
        const { kind, ...target } = action;
        actions.tuneTo(target);
        // The same pair the Voice skimmer panel and the marker bar use when a callsign is
        // clicked: tuning to somewhere off the edge of the spectrum and leaving the view
        // where it was is half a job.
        if (actions.ensureVisible) actions.ensureVisible(target.frequency);
        return true;
    }
    return false;
}
