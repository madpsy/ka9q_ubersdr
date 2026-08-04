// The station hardware a control surface can reach: the rotator and the antenna
// switch.
//
// Unlike every other mapped function these do not go through `actions` — neither
// belongs to the receiver. They are HTTP endpoints shared with v1's
// /rotator.html and /switch.html, and three things about them shape this file:
//
//   * They are password-guarded, and a knob has no way to type a password. The
//     one the Rotator or Antenna panel saved is all there is (v1's localStorage
//     keys, so a password typed in either frontend counts). Without it the
//     function says so in the log rather than doing nothing quietly.
//
//   * POST /api/rotctl/position and /api/ant-switch/command are rate limited to
//     one request a second per address. A dial mapped to the rotator sends far
//     more than that, so detents accumulate into a target bearing and one
//     request goes out per second carrying wherever the dial has got to by
//     then. Throttling at the dispatcher instead would drop most of the turn:
//     the surplus detents are the turn.
//
//   * Neither panel is necessarily open — driving them from hardware without
//     the panel on screen is the whole point — so the current bearing and the
//     current antenna are read and cached here rather than taken from a
//     component that may never have mounted.
//
// Everything reports through `hardwareMessages`, which SDR Control pipes into
// its log: a rotator that refuses a bearing, a switch locked out by
// thunderstorm mode and a missing password all look identical from the knob.

import { Emitter } from '../radio/emitter.js';

// Just over the server's one-per-second limit, so a coalesced send is never the
// request that gets refused.
const SEND_MS = 1100;

// How long a cached bearing or antenna state is trusted. Both can be changed
// from the panel, from v1, or by the scheduler, and a control surface that
// stepped from a stale reading would jump the beam somewhere unasked.
const STALE_MS = 8000;

export const hardwareMessages = new Emitter();

function say(text, tone = 'info') {
    hardwareMessages.emit('message', { text, tone });
}

function stored(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function forget(key) {
    try { localStorage.removeItem(key); } catch (e) { /* private mode */ }
}

const norm = (deg) => ((Math.round(deg) % 360) + 360) % 360;

// --- rotator ----------------------------------------------------------------

const ROT_PW = 'rotctl_password';

const rot = {
    target: null,     // where we have asked it to go, or null when unknown
    at: 0,            // when `target` was last confirmed against the rotator
    pending: 0,       // degrees asked for that no target has absorbed yet
    reading: null,    // in-flight status request, so a spin reads once
    timer: null,
    lastSend: 0,
};

function readRotator() {
    if (rot.reading) return rot.reading;
    rot.reading = fetch('/api/rotctl/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
            rot.reading = null;
            if (!d || !d.position || d.position.azimuth == null) {
                say('Rotator: no position reported', 'warn');
                return null;
            }
            if (d.read_only) {
                say('Rotator is view-only on this receiver', 'warn');
                return null;
            }
            rot.target = norm(d.position.azimuth);
            rot.at = Date.now();
            applyPending();
            return rot.target;
        })
        .catch(() => {
            rot.reading = null;
            rot.pending = 0;
            say('Rotator: could not read the current bearing', 'error');
            return null;
        });
    return rot.reading;
}

function applyPending() {
    if (rot.target == null || !rot.pending) return;
    rot.target = norm(rot.target + rot.pending);
    rot.pending = 0;
    scheduleSend();
}

function scheduleSend() {
    if (rot.timer) return;
    const wait = Math.max(0, SEND_MS - (Date.now() - rot.lastSend));
    rot.timer = setTimeout(() => { rot.timer = null; sendBearing(); }, wait);
}

function sendBearing() {
    if (rot.target == null) return;
    const pw = stored(ROT_PW);
    if (!pw) {
        say('Rotator: no password saved — enter it once in the Rotator panel', 'warn');
        rot.target = null;
        return;
    }
    const azimuth = rot.target;
    rot.lastSend = Date.now();
    fetch('/api/rotctl/position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, azimuth }),
    })
        .then(async (resp) => {
            const d = await resp.json().catch(() => ({}));
            if (resp.status === 401 || (d.error && String(d.error).toLowerCase().includes('password'))) {
                forget(ROT_PW);
                rot.target = null;
                say('Rotator: password rejected — enter it again in the Rotator panel', 'error');
                return;
            }
            if (!resp.ok || d.success === false) {
                say(`Rotator refused ${azimuth}° — ${d.error || 'no reason given'}`, 'error');
                return;
            }
            rot.at = Date.now();
            say(`Rotator → ${azimuth}°`, 'good');
        })
        .catch(() => say('Rotator: command failed', 'error'));
}

/**
 * Turn `deg` from where the beam is heading — negative for anticlockwise.
 *
 * Detents accumulate whether or not the bearing is known yet, so the first turn
 * of a dial after a pause is not the one that gets thrown away while the status
 * request it triggered is still in flight.
 */
export function rotatorStep(deg) {
    if (!deg) return;
    rot.pending += deg;
    if (rot.target == null || Date.now() - rot.at > STALE_MS) {
        rot.target = null;
        readRotator();
        return;
    }
    applyPending();
}

export function rotatorCommand(command) {
    const pw = stored(ROT_PW);
    if (!pw) {
        say('Rotator: no password saved — enter it once in the Rotator panel', 'warn');
        return;
    }
    // A stop leaves the beam somewhere neither we nor the last target knows, so
    // the next step has to read the rotator again rather than resume from it.
    if (command === 'stop') {
        if (rot.timer) { clearTimeout(rot.timer); rot.timer = null; }
        rot.pending = 0;
        rot.target = null;
    }
    fetch('/api/rotctl/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, command }),
    })
        .then((resp) => {
            if (resp.status === 401) {
                forget(ROT_PW);
                say('Rotator: password rejected — enter it again in the Rotator panel', 'error');
                return;
            }
            say(command === 'stop' ? 'Rotator stopping' : `Rotator: ${command}`, 'good');
        })
        .catch(() => say('Rotator: command failed', 'error'));
}

// --- antenna switch ---------------------------------------------------------

const ANT_PW = 'ant_switch_password';

const ant = {
    count: 0,
    labels: [],
    selected: [],
    grounded: false,
    at: 0,
    reading: null,
    want: null,       // the antenna we have asked for, 0 for grounded
    wantAt: 0,
    timer: null,
    lastSend: 0,
};

/**
 * What the switch has, once it has been read: `{ count, labels }`, else null.
 *
 * The learn dropdown uses this to offer the antennas this receiver actually has
 * under the names its operator gave them, rather than eight numbered slots.
 */
export function antennaInfo() {
    return ant.count ? { count: ant.count, labels: ant.labels.slice() } : null;
}

/** Reads the switch if the cache is cold or stale. Resolves to `antennaInfo()`. */
export function readAntenna(force) {
    if (!force && ant.count && Date.now() - ant.at < STALE_MS) return Promise.resolve(antennaInfo());
    if (ant.reading) return ant.reading;
    ant.reading = fetch('/api/ant-switch/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
            ant.reading = null;
            if (!d || !d.enabled) return null;
            const before = ant.count;
            ant.count = d.num_antennas || 0;
            ant.labels = Array.isArray(d.antenna_labels) ? d.antenna_labels : [];
            ant.selected = Array.isArray(d.selected) ? d.selected : [];
            ant.grounded = !!d.grounded;
            ant.thunderstorm = !!d.thunderstorm;
            ant.at = Date.now();
            // Only when the list itself changes: the dropdown is rebuilt from
            // this and a re-render per poll would be for nothing.
            if (ant.count !== before) hardwareMessages.emit('antennas', antennaInfo());
            return antennaInfo();
        })
        .catch(() => { ant.reading = null; return null; });
    return ant.reading;
}

function sendAntenna(cmd, describe) {
    const pw = stored(ANT_PW);
    if (!pw) {
        say('Antenna switch: no password saved — enter it once in the Antenna panel', 'warn');
        return;
    }
    fetch('/api/ant-switch/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, ...cmd }),
    })
        .then(async (resp) => {
            if (resp.status === 401) {
                forget(ANT_PW);
                say('Antenna switch: password rejected — enter it again in the Antenna panel', 'error');
                return;
            }
            if (resp.status === 403) {
                say('⚡ Thunderstorm mode — antenna switching is disabled', 'warn');
                return;
            }
            const d = await resp.json().catch(() => ({}));
            if (!resp.ok || d.success === false) {
                say(`Antenna switch refused — ${d.error || 'no reason given'}`, 'error');
                return;
            }
            // The reply carries the verified hardware state, so the next step
            // from a dial counts from where the switch really is.
            if (d.selected !== undefined) {
                ant.selected = Array.isArray(d.selected) ? d.selected : [];
                ant.grounded = !!d.grounded;
                ant.at = Date.now();
            }
            say(describe, 'good');
        })
        .catch(() => say('Antenna switch: command failed', 'error'));
}

export function antennaLabelFor(n) {
    return ant.labels[n - 1] || `Antenna ${n}`;
}

// Same coalescing as the rotator, and for the same reason — /api/ant-switch/
// command is rate limited to one a second. Two quick presses of "next antenna"
// must land on the one two along, not select the next and then have the second
// press refused, so the intent is held here and the last one wins.
function scheduleAntenna() {
    if (ant.timer) return;
    const wait = Math.max(0, SEND_MS - (Date.now() - ant.lastSend));
    ant.timer = setTimeout(() => {
        ant.timer = null;
        const n = ant.want;
        if (n == null) return;
        ant.lastSend = Date.now();
        if (n === 0) sendAntenna({ command: 'ground' }, 'Antennas grounded');
        else sendAntenna({ command: 'select', antenna: n }, `Antenna → ${antennaLabelFor(n)}`);
    }, wait);
}

export function antennaSelect(n) {
    if (ant.count && (n < 1 || n > ant.count)) {
        say(`This receiver has no antenna ${n}`, 'warn');
        return;
    }
    ant.want = n;
    ant.wantAt = Date.now();
    scheduleAntenna();
}

export function antennaGround() {
    ant.want = 0;
    ant.wantAt = Date.now();
    scheduleAntenna();
}

/**
 * Which antenna is `dir` places along from `current`, wrapping.
 *
 * `current` of 0 means grounded, which counts as before the first antenna: one
 * press off the ground lands on antenna 1 going forward and the last one going
 * back, the way any other wrap-around list behaves rather than a special case
 * to remember.
 */
export function nextAntenna(current, count, dir) {
    if (!count) return 0;
    if (!current) return dir > 0 ? 1 : count;
    return ((current - 1 + dir + count) % count) + 1;
}

/**
 * Step `dir` places through the switch's antennas.
 *
 * With several selected at once — a switch configured to allow mixing — the
 * highest is the one stepped from, so repeated presses walk up the list rather
 * than sitting between two of them.
 */
export function antennaStep(dir) {
    readAntenna().then((info) => {
        if (!info) {
            say('Antenna switch: could not read the current antenna', 'error');
            return;
        }
        // Step from what we last asked for while that is still in flight, so a
        // second press walks on rather than recomputing from a switch that has
        // not caught up yet.
        const current = ant.want != null && Date.now() - ant.wantAt < STALE_MS
            ? ant.want
            : (ant.grounded || !ant.selected.length ? 0 : Math.max(...ant.selected));
        antennaSelect(nextAntenna(current, info.count, dir));
    });
}
