// Game controllers, over the Gamepad API.
//
// Bluetooth is invisible from here: the OS pairs the pad — Xbox, DualSense,
// Switch Pro, 8BitDo — and the browser lists it exactly as it lists a USB one.
// Unlike Web MIDI and WebHID this is in every engine, Firefox and Safari too.
//
// Two things make it unlike the other surfaces:
//
//   * It is polled. There is no event for a button going down, only a snapshot
//     per frame from getGamepads(), so each frame is compared with the last and
//     the differences become input. Chrome hands back nothing while the tab is
//     hidden, so a pad drives a receiver that is on screen and no other.
//
//   * Browsers hide every pad until a button on it is pressed, so a page cannot
//     list what is plugged in before somebody touches it. "No controllers" is
//     the normal first state and the panel says to press a button.
//
// Controls are keyed by what the API calls them:
//
//   b:N        button N going down
//   b:N:up     the same button coming back up — for "map press and release"
//   a:N+ a:N-  each half of stick axis N, so the two directions map apart
//
// Sticks spring back to the middle, so as a position (a fader) they would set
// the volume and then snap it back on letting go. A half-axis is a rate
// instead: past the dead zone it sends detents, faster the further it is
// pushed, which is what makes "push right to tune up, harder to tune faster"
// work with the same encoder functions a dial uses. That is only for a
// function that wants a stream — an encoder, a step that repeats, a level.
// Mapped to anything else ("Mute", "Next mode") a half-axis is a button: one
// press each time it is pushed over.
//
// Buttons work the same way round: one press per press, and a held button
// repeats only when its function is one that should — a held D-pad keeps
// stepping the frequency, a held Mute does not flicker the audio.
//
// Rumble is here too, as feedback rather than input — see rumble() below and
// ControlWatch, which decides when.

import { Emitter } from '../radio/emitter.js';

// Below this a stick is resting, not pushed. Worn pads drift to 0.1 or so.
// It starts sending only past ENGAGE, and then keeps on until it is back
// inside DEADZONE: one threshold for both is how a stick resting near it
// sends a detent every few seconds by itself.
export const DEADZONE = 0.18;
export const ENGAGE = 0.25;
// Detents a second at the edge of the dead zone and at full deflection. The
// curve between is quadratic, so the first half of the travel is for fine
// tuning and the last bit is for crossing a band.
export const RATE_MIN = 2;
export const RATE_MAX = 30;
// A half-axis mapped as a button: pressed past PRESS_AT, released below
// RELEASE_AT. The gap is the hysteresis that stops a stick held near the
// threshold from chattering.
export const PRESS_AT = 0.6;
export const RELEASE_AT = 0.35;
// The analog triggers report a value as well as `pressed`, and some pads set
// `pressed` at the faintest touch; the value is the better judge.
export const TRIGGER_AT = 0.5;
// A held button that repeats: first repeat after REPEAT_DELAY_MS, then one
// every REPEAT_MS — the keyboard's own feel.
export const REPEAT_DELAY_MS = 400;
export const REPEAT_MS = 90;

// The "standard" layout's names, which the API guarantees for any pad whose
// `mapping` is "standard". Face buttons by position as well as by letter:
// index 0 is A on an Xbox pad, ✕ on a PlayStation one and B on a Nintendo one,
// and only "bottom" is true of all three.
const STANDARD_BUTTONS = [
    'A / ✕ (bottom)', 'B / ○ (right)', 'X / □ (left)', 'Y / △ (top)',
    'Left bumper', 'Right bumper', 'Left trigger', 'Right trigger',
    'Back / Select', 'Start / Menu', 'Left stick press', 'Right stick press',
    'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home / Guide',
];
const STANDARD_AXES = {
    '0+': 'Left stick right', '0-': 'Left stick left',
    '1+': 'Left stick down', '1-': 'Left stick up',
    '2+': 'Right stick right', '2-': 'Right stick left',
    '3+': 'Right stick down', '3-': 'Right stick up',
};
// The standard layout's Y axes read positive downwards. A stick pushed up
// should turn things up, so on those the sign of a detent is flipped.
const INVERTED_AXES = new Set([1, 3]);

// What the operator gets before learning anything. A pad is the one surface
// whose controls we know in advance, so like the RC-28 it arrives mapped; a
// saved table, even an emptied one, wins.
export const GAMEPAD_DEFAULT_MAPPINGS = {
    'a:0+': { function: 'freq_enc_100', throttleMs: 0, mode: 'none' },
    'a:0-': { function: 'freq_enc_100', throttleMs: 0, mode: 'none' },
    'a:2+': { function: 'freq_enc_10', throttleMs: 0, mode: 'none' },
    'a:2-': { function: 'freq_enc_10', throttleMs: 0, mode: 'none' },
    'a:3+': { function: 'volume_set', throttleMs: 0, mode: 'none' },
    'a:3-': { function: 'volume_set', throttleMs: 0, mode: 'none' },
    'b:14': { function: 'freq_step_down', throttleMs: 0, mode: 'none' },
    'b:15': { function: 'freq_step_up', throttleMs: 0, mode: 'none' },
    'b:12': { function: 'zoom_in', throttleMs: 0, mode: 'none' },
    'b:13': { function: 'zoom_out', throttleMs: 0, mode: 'none' },
    'b:0': { function: 'mute_toggle', throttleMs: 0, mode: 'none' },
    'b:1': { function: 'tune_lock_toggle', throttleMs: 0, mode: 'none' },
    'b:2': { function: 'mode_prev', throttleMs: 0, mode: 'none' },
    'b:3': { function: 'mode_next', throttleMs: 0, mode: 'none' },
    'b:4': { function: 'vfo_prev', throttleMs: 0, mode: 'none' },
    'b:5': { function: 'vfo_next', throttleMs: 0, mode: 'none' },
    'b:6': { function: 'bw_narrow', throttleMs: 0, mode: 'none' },
    'b:7': { function: 'bw_widen', throttleMs: 0, mode: 'none' },
    'b:9': { function: 'freq_entry', throttleMs: 0, mode: 'none' },
    'b:8': { function: 'squelch_toggle', throttleMs: 0, mode: 'none' },
};

// Rumble feedback, all of it optional. On by default because it is quiet and
// it is the only way a pad can say "that did something" without eyes on the
// screen; the tuning ticks are off because they are a matter of taste.
export const DEFAULT_RUMBLE = {
    enabled: true,
    strength: 0.5,
    // One pulse when a toggle turns on, two when it turns off.
    toggles: true,
    // A buzz when a mapped control was refused.
    refused: true,
    // A short pulse on connect and on each control learned.
    confirm: true,
    // A tick each time tuning crosses a step-size boundary, like a detent.
    ticks: false,
};

export function rumbleSettings(saved) {
    const r = { ...DEFAULT_RUMBLE, ...(saved && typeof saved === 'object' ? saved : {}) };
    r.strength = Math.min(1, Math.max(0.05, Number(r.strength) || DEFAULT_RUMBLE.strength));
    return r;
}

// Each one a list of pulses: [startMs, durationMs, weight]. Weight scales the
// operator's strength; the strong motor carries the long ones and the weak one
// the short, which is how a pad tells "thud" from "tick".
// Ticks closer together than this are one tick: a stick crossing several
// steps in a frame is a buzz otherwise, and a buzz says nothing.
export const TICK_GAP_MS = 60;

export const RUMBLE_PATTERNS = {
    tick: [[0, 18, 0.5]],
    on: [[0, 60, 1]],
    off: [[0, 40, 0.8], [110, 40, 0.8]],
    confirm: [[0, 90, 0.8]],
    refused: [[0, 160, 1]],
};

export function gamepadAvailable() {
    return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
}

export function buttonKey(n, up) {
    return up ? `b:${n}:up` : `b:${n}`;
}

export function axisKey(n, positive) {
    return `a:${n}${positive ? '+' : '-'}`;
}

export function isAxisKey(key) {
    return /^a:\d+[+-]$/.test(String(key));
}

/** The other half of an axis: `a:0+` ↔ `a:0-`. Null for anything else. */
export function otherHalf(key) {
    if (!isAxisKey(key)) return null;
    const k = String(key);
    return k.slice(0, -1) + (k.endsWith('+') ? '-' : '+');
}

// Whether the pad bound now uses the standard layout. Only it has names; a pad
// the browser could not place is "Button 7" and "Axis 4 +", which is honest.
// Module state because the label function is a plain function of the key — the
// same shape every surface hands the mapping table.
let standardLayout = true;

export function gamepadKeyLabel(key) {
    const k = String(key);
    let m = /^b:(\d+)(:up)?$/.exec(k);
    if (m) {
        const n = Number(m[1]);
        const name = (standardLayout && STANDARD_BUTTONS[n]) || `Button ${n}`;
        return m[2] ? `${name} release` : name;
    }
    m = /^a:(\d+)([+-])$/.exec(k);
    if (m) {
        return (standardLayout && STANDARD_AXES[`${m[1]}${m[2]}`]) || `Axis ${m[1]} ${m[2]}`;
    }
    return k;
}

/** Sort rank for the mapping table: sticks first, then buttons in pad order. */
export function gamepadKeyRank(key) {
    const k = String(key);
    let m = /^a:(\d+)([+-])$/.exec(k);
    if (m) return [0, Number(m[1]), m[2] === '-' ? 0 : 1];
    m = /^b:(\d+)(:up)?$/.exec(k);
    if (m) return [1, Number(m[1]), m[2] ? 1 : 0];
    return null;
}

// How far past the dead zone, 0..1.
function deflection(v) {
    const a = Math.abs(v);
    if (a <= DEADZONE) return 0;
    return Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
}

export function detentRate(v) {
    const x = deflection(v);
    if (x <= 0) return 0;
    return RATE_MIN + (RATE_MAX - RATE_MIN) * x * x;
}

function buttonDown(b) {
    if (!b) return false;
    if (typeof b === 'number') return b > TRIGGER_AT;
    // Digital buttons report value 0 or 1; analog triggers in between.
    if (typeof b.value === 'number' && b.value > 0 && b.value < 1) return b.value > TRIGGER_AT;
    return !!b.pressed;
}

export class GamepadControl extends Emitter {
    /**
     * `env` is the seam for the tests: the clock, the frame scheduler and where
     * the pads come from. In the page they are the browser's own.
     */
    constructor(env = {}) {
        super();
        this.connected = false;
        this.deviceId = null;       // the pad's index, as a string
        this.deviceName = '';       // its `id` string, which is what is remembered
        this._now = env.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
        this._getPads = env.getPads || (() => (gamepadAvailable() ? Array.from(navigator.getGamepads() || []) : []));
        this._schedule = env.schedule || ((fn) => (typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(fn) : setTimeout(fn, 16)));
        this._cancel = env.cancel || ((id) => (typeof cancelAnimationFrame === 'function'
            ? cancelAnimationFrame(id) : clearTimeout(id)));
        this._win = env.window !== undefined ? env.window : (typeof window !== 'undefined' ? window : null);
        this._frame = null;
        this._opened = false;
        // Whether this window is the one the pad drives. Always, in a browser;
        // in the desktop client every visible receiver window is handed the
        // pad's input, so the host says which one should act on it — see
        // setActive and clients/electron/main.js.
        this.active = true;
        this._hostWatched = false;
        // Keys whose mapped function wants a stream — see the top of the file.
        // Set by ControlWatch from the mapping table.
        this.continuous = {};
        this._reset();
        // The name of the pad last connected on purpose, and still wanted. A
        // Bluetooth pad sleeps after a few idle minutes and comes back as a new
        // connection, often at another index; while this is set it is taken
        // back without asking. A press of Disconnect clears it.
        this._wanted = null;
        this._onConnected = (e) => {
            this.emit('devices', this.devices());
            const gp = e && e.gamepad;
            if (!this.connected && this._wanted && gp && gp.id === this._wanted) {
                this.connect(String(gp.index), true);
            }
        };
        this._onDisconnected = (e) => {
            const gp = e && e.gamepad;
            if (this.connected && gp && String(gp.index) === this.deviceId) this._lost();
            this.emit('devices', this.devices());
        };
    }

    setContinuous(map) {
        this.continuous = map || {};
    }

    // Off: frames are still read, so what is held is known, but nothing is
    // sent. Back on, whatever is held at that moment is the new baseline — a
    // button down when the window was focused is not a press in it.
    setActive(on) {
        const next = !!on;
        if (next === this.active) return;
        this.active = next;
        const pad = this.connected ? this._pad(this.deviceId) : null;
        this._reset();
        if (pad) this._prime(pad);
        this.emit('active', next);
    }

    // Nothing to ask for: the Gamepad API has no permission. This only starts
    // listening for pads appearing, which is the hotplug signal.
    async open() {
        if (!gamepadAvailable()) return false;
        const host = this._win && this._win.ubersdrDesktop;
        if (!this._hostWatched && host && typeof host.onControllerActive === 'function') {
            this._hostWatched = true;
            try { host.onControllerActive((on) => this.setActive(on)); } catch (e) { /* stays active */ }
        }
        if (!this._opened && this._win && this._win.addEventListener) {
            this._win.addEventListener('gamepadconnected', this._onConnected);
            this._win.addEventListener('gamepaddisconnected', this._onDisconnected);
            this._opened = true;
        }
        this.emit('devices', this.devices());
        return true;
    }

    devices() {
        return this._getPads()
            .filter((p) => p && p.connected !== false)
            .map((p) => ({ id: String(p.index), name: p.id || `Controller ${p.index + 1}` }));
    }

    connect(id, quiet) {
        const pad = this._pad(id);
        if (!pad) {
            this.emit('message', { text: 'That controller is no longer there — press a button on it', tone: 'error' });
            return false;
        }
        this._stop();
        this._reset();
        this.connected = true;
        this.deviceId = String(id);
        this.deviceName = pad.id || `Controller ${pad.index + 1}`;
        this._wanted = this.deviceName;
        standardLayout = pad.mapping === 'standard';
        // What is already held when connecting is not a press. Taking the
        // first frame as the baseline stops a finger resting on a button from
        // firing it the moment the Connect is clicked.
        this._prime(pad);
        this.emit('state', { connected: true, deviceName: this.deviceName });
        this.emit('message', {
            text: quiet ? `Reconnected: ${this.deviceName}` : `Connected: ${this.deviceName}`,
            tone: 'good',
        });
        if (!standardLayout) {
            this.emit('message', {
                text: 'The browser does not know this controller’s layout, so its controls are numbered rather than named',
                tone: 'info',
            });
        }
        this._loop();
        return true;
    }

    disconnect(quiet) {
        this._wanted = null;
        this._stop();
        this._reset();
        if (!this.connected) return;
        this.connected = false;
        this.deviceId = null;
        this.deviceName = '';
        this.emit('state', { connected: false, deviceName: '' });
        if (!quiet) this.emit('message', { text: 'Disconnected', tone: 'info' });
    }

    close() {
        this.disconnect(true);
        if (this._opened && this._win && this._win.removeEventListener) {
            this._win.removeEventListener('gamepadconnected', this._onConnected);
            this._win.removeEventListener('gamepaddisconnected', this._onDisconnected);
        }
        this._opened = false;
    }

    // The pad went away by itself — out of range, asleep, battery. Still
    // wanted, so it is taken back when it reappears.
    _lost() {
        const wanted = this._wanted;
        this.disconnect(true);
        this._wanted = wanted;
        this.emit('message', { text: 'Controller went away — it reconnects when it wakes', tone: 'warn' });
    }

    /** Whether the bound pad has a motor the browser can drive. */
    canRumble() {
        const pad = this.connected ? this._pad(this.deviceId) : null;
        return !!(pad && (actuatorOf(pad) || hapticOf(pad)));
    }

    /**
     * Plays a pattern from RUMBLE_PATTERNS at `strength` (0..1). Quiet when
     * there is no pad or no motor — feedback is never worth an error.
     */
    rumble(name, strength = DEFAULT_RUMBLE.strength) {
        const pattern = RUMBLE_PATTERNS[name];
        const pad = this.connected ? this._pad(this.deviceId) : null;
        if (!pattern || !pad || !this.active) return false;
        if (name === 'tick') {
            const now = this._now();
            if (now - (this._tickAt || -Infinity) < TICK_GAP_MS) return true;
            this._tickAt = now;
        }
        const act = actuatorOf(pad);
        const haptic = hapticOf(pad);
        if (!act && !haptic) return false;
        for (const [start, duration, weight] of pattern) {
            const mag = Math.min(1, Math.max(0, strength * weight));
            try {
                if (act) {
                    // Long pulses on the strong motor, ticks on the weak one.
                    const strong = duration >= 50 ? mag : mag * 0.3;
                    const p = act.playEffect(act.type || 'dual-rumble', {
                        startDelay: start, duration, strongMagnitude: strong, weakMagnitude: mag,
                    });
                    if (p && p.catch) p.catch(() => {});
                } else {
                    // Firefox's older API has no delay; a timer stands in.
                    const go = () => { try { haptic.pulse(mag, duration); } catch (e) { /* ignore */ } };
                    if (start > 0) setTimeout(go, start); else go();
                }
            } catch (e) {
                return false;
            }
        }
        return true;
    }

    _pad(id) {
        return this._getPads().find((p) => p && String(p.index) === String(id) && p.connected !== false) || null;
    }

    _reset() {
        this._buttons = [];       // last frame's down state, per button
        this._axisPressed = {};   // half-axis key -> held past PRESS_AT, as a button
        this._accum = {};         // half-axis key -> fractional detents owed
        this._repeatAt = {};      // button key -> when it next repeats
        this._last = null;        // when the last frame was read
    }

    _prime(pad) {
        this._buttons = (pad.buttons || []).map(buttonDown);
        // A stick already off centre is left alone until it comes back; there
        // is no "already pressed" to remember for a rate.
        this._last = this._now();
    }

    _loop() {
        this._frame = this._schedule(() => {
            this._frame = null;
            if (!this.connected) return;
            this.poll();
            if (this.connected) this._loop();
        });
    }

    _stop() {
        if (this._frame !== null) this._cancel(this._frame);
        this._frame = null;
    }

    /** One frame. Public for the tests, which drive it instead of a scheduler. */
    poll() {
        if (!this.connected) return;
        const pad = this._pad(this.deviceId);
        // Chrome blanks a pad while the tab is hidden and some platforms
        // return null for a frame mid-reconnect; neither is a disconnect,
        // which has its own event.
        if (!pad) return;
        const now = this._now();
        if (!this.active) {
            this._prime(pad);
            this._axisPressed = {};
            this._accum = {};
            this._repeatAt = {};
            return;
        }
        const dt = this._last === null ? 0 : Math.min(0.25, Math.max(0, (now - this._last) / 1000));
        this._last = now;
        this._readButtons(pad, now);
        this._readAxes(pad, dt);
    }

    _readButtons(pad, now) {
        const buttons = pad.buttons || [];
        for (let i = 0; i < buttons.length; i += 1) {
            const down = buttonDown(buttons[i]);
            const was = !!this._buttons[i];
            const key = buttonKey(i);
            if (down && !was) {
                this._emitButton(key, true);
                this._repeatAt[key] = now + REPEAT_DELAY_MS;
            } else if (!down && was) {
                delete this._repeatAt[key];
                this._emitButton(buttonKey(i, true), false);
            } else if (down && this.continuous[key] && now >= (this._repeatAt[key] || Infinity)) {
                this._repeatAt[key] = now + REPEAT_MS;
                this.emit('input', { key, event: { kind: 'trigger' }, repeat: true });
            }
            this._buttons[i] = down;
        }
    }

    _emitButton(key, press) {
        this.emit('input', {
            key,
            event: { kind: 'trigger' },
            isNoteOn: press,
            isNoteOff: !press,
        });
    }

    _readAxes(pad, dt) {
        const axes = pad.axes || [];
        for (let i = 0; i < axes.length; i += 1) {
            const v = Number(axes[i]) || 0;
            const sign = INVERTED_AXES.has(i) && standardLayout ? -1 : 1;
            for (const positive of [true, false]) {
                const key = axisKey(i, positive);
                const part = positive ? Math.max(0, v) : Math.max(0, -v);
                // The detent's direction: physical right and up are positive.
                const dir = (positive ? 1 : -1) * sign;
                if (this.continuous[key]) {
                    this._axisRate(key, part, dir, dt);
                } else {
                    this._axisButton(key, part);
                }
            }
        }
    }

    _axisRate(key, part, dir, dt) {
        const engaged = this._accum[key] !== undefined;
        const rate = detentRate(part);
        if (rate <= 0 || (!engaged && part < ENGAGE)) {
            delete this._accum[key];
            return;
        }
        // The first frame past the dead zone sends one at once, so a nudge
        // of the stick always does something; after that it is the rate.
        if (this._accum[key] === undefined) {
            this._accum[key] = 0;
            this.emit('input', { key, event: { kind: 'relative', delta: dir }, isNoteOn: true });
            return;
        }
        this._accum[key] += rate * dt;
        const n = Math.floor(this._accum[key]);
        if (n < 1) return;
        this._accum[key] -= n;
        this.emit('input', { key, event: { kind: 'relative', delta: dir * n } });
    }

    _axisButton(key, part) {
        const was = !!this._axisPressed[key];
        if (!was && part > PRESS_AT) {
            this._axisPressed[key] = true;
            this.emit('input', { key, event: { kind: 'trigger' }, isNoteOn: true });
        } else if (was && part < RELEASE_AT) {
            this._axisPressed[key] = false;
        }
    }
}

function actuatorOf(pad) {
    const a = pad && pad.vibrationActuator;
    return a && typeof a.playEffect === 'function' ? a : null;
}

function hapticOf(pad) {
    const h = pad && pad.hapticActuators && pad.hapticActuators[0];
    return h && typeof h.pulse === 'function' ? h : null;
}

/** Test seam: the layout flag is module state. */
export function _setStandardLayout(on) {
    standardLayout = !!on;
}
