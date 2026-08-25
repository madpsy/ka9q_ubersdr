// Following another listener — v1's chat "sync".
//
// Chat already publishes what each user is tuned to (`chat_set_frequency_mode`: frequency,
// mode, bw_low, bw_high and optionally zoom_bw), which is how the user list can show it and
// how clicking a name tunes there. Following is the same fact made continuous: pick a user,
// and every time *their* dial moves, yours moves with it. It is what makes "listen to this"
// work over a channel where the interesting thing keeps moving — a net drifting up the band,
// somebody walking you through a signal.
//
// ── What v1 does, which this reproduces ──────────────────────────────────────
//
//   One user at a time. Following a second replaces the first; there is no queue and no
//   "follow everybody", because two dials cannot both be yours.
//
//   Frequency *and* mode, or nothing. A user record with a frequency and no mode is somebody
//   whose client has not published properly, and half a tune is worse than none.
//
//   The passband comes too, so following somebody on a narrow CW filter sounds like what they
//   are hearing rather than the same carrier through 3 kHz.
//
//   The zoom does not, unless asked for. It is a separate switch, off by default, because the
//   spectrum view is *your* window on the band — following somebody who is zoomed into 200 Hz
//   of a CW signal takes away your view of everything else, and plenty of people want the
//   audio without that. v1 keeps this preference; so do we.
//
//   Not yourself. Your own row has no follow button: you are already where you are.
//
//   Not remembered between visits. The choice is about who is on the channel right now, and
//   arriving to find your dial being driven by a name you do not remember choosing would be
//   the wrong kind of surprise. Only the zoom switch is stored.
//
// One thing v1 does that is left behind: it temporarily forces "edge tune" on for two seconds
// to drag the spectrum along, then puts it back. v2 has ensureVisible, which is that intent
// stated directly.

// The spectrum's limits, as RadioContext has them. Repeated rather than imported because this
// module is pure arithmetic and is tested on its own.
//
// MAX_HZ is the default for callers that do not know the receiver's real top; followView
// takes it as an argument so RadioContext can pass MAX_FREQ. 30 MHz is what a receiver
// was before the span became configurable — see RECEIVER_SPAN.md.
const MIN_HZ = 0;
const MAX_HZ = 30e6;

export const FOLLOW_ZOOM_KEY = 'ubersdr.v2.chatFollowZoom';

/**
 * What to tune to follow this user, in the shape `actions.tuneTo` takes — or null when the
 * record does not say enough to act on.
 *
 * The passband is only passed on when it is a pair that makes sense. v1 substitutes 0 for a
 * missing edge and hands that to the receiver; here a missing or nonsensical pair is left out
 * so the mode's own passband applies, which is what somebody following a mode change expects
 * to hear.
 */
export function followTarget(user) {
    if (!user) return null;
    const frequency = Math.round(Number(user.frequency) || 0);
    const mode = String(user.mode || '').toLowerCase();
    // Both, as v1 requires: a frequency with no mode is a client that has not published
    // properly, and tuning to it in whatever mode we happen to be in is a guess.
    if (!(frequency > MIN_HZ) || !mode) return null;
    const low = Number(user.bw_low);
    const high = Number(user.bw_high);
    const pair = Number.isFinite(low) && Number.isFinite(high) && low < high;
    return {
        frequency,
        mode,
        ...(pair ? { bandwidthLow: low, bandwidthHigh: high } : {}),
    };
}

/**
 * The spectrum view that matches this user's, or null when there is nothing to match.
 *
 * They publish `zoom_bw` — Hz per bin — which is resolution rather than span, so it has to be
 * multiplied by *our* bin count: the two receivers may be asking the server for different
 * numbers of bins, and copying the span rather than the resolution would show a different
 * slice of the band at the same zoom setting.
 *
 * The centre is pulled back so the whole window stays inside the receiver, as v1 does. Without it,
 * following somebody parked on 200 kHz at a wide zoom asks for a view starting below zero, and
 * what comes back is not the view either of you is looking at.
 */
export function followView(user, binCount, maxHz = MAX_HZ) {
    const binBW = Number(user && user.zoom_bw);
    const freq = Math.round(Number(user && user.frequency) || 0);
    if (!(binBW > 0) || !(binCount > 0) || !(freq > MIN_HZ)) return null;
    const top = maxHz > 0 ? maxHz : MAX_HZ;
    const span = binBW * binCount;
    const half = span / 2;
    // A span wider than the whole spectrum has no centre that satisfies both edges; the middle
    // is the only sensible answer, and the server will clamp the span itself.
    const centre = span >= top - MIN_HZ
        ? Math.round((MIN_HZ + top) / 2)
        : Math.round(Math.min(Math.max(freq, MIN_HZ + half), top - half));
    return { frequency: centre, span };
}

/**
 * What "they have moved" means.
 *
 * Compared rather than acted on blindly, because the user list is refreshed by anything that
 * happens on the channel — somebody joining, an idle sweep, our own status going out — and
 * re-tuning on each of those would fight an operator who has since nudged the dial. Only a
 * change in the numbers we would act on counts as a move.
 */
export function followSignature(user, withZoom) {
    const t = followTarget(user);
    if (!t) return '';
    const band = t.bandwidthLow == null ? '' : `${t.bandwidthLow}:${t.bandwidthHigh}`;
    const zoom = withZoom ? Number(user.zoom_bw) || 0 : 0;
    return `${t.frequency}|${t.mode}|${band}|${zoom}`;
}

/** Can this user be followed at all? Not us, and not a record with nothing in it. */
export function followable(user, me) {
    if (!user || !user.username) return false;
    if (me && user.username === me) return false;
    return !!followTarget(user);
}

/**
 * The user list in the order it should be drawn: whoever is being followed first, then
 * alphabetically — v1's order, and the reason for it is the same as the pager's. The server's
 * order changes as people come and go, so a row you are aiming at moves under the pointer;
 * alphabetical does not, and the followed one is pinned where it can be seen at a glance.
 */
export function sortFollowFirst(users, followed) {
    return [...(users || [])].sort((a, b) => {
        if (a.username === followed) return -1;
        if (b.username === followed) return 1;
        return String(a.username || '').localeCompare(String(b.username || ''));
    });
}

export function loadFollowZoom() {
    try { return localStorage.getItem(FOLLOW_ZOOM_KEY) === 'on'; } catch (e) { return false; }
}

export function saveFollowZoom(on) {
    try { localStorage.setItem(FOLLOW_ZOOM_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
}
