// The curated command set.
//
// Two surfaces reach the receiver from outside, and they have distinct jobs:
//
//   commands   this file. A small, hand-written, precisely-typed set for the
//              operations an external controller has to be *exact* about —
//              "tune to 14074000 with this passband", "mute, because the rig is
//              transmitting". These are the contract: their names and argument
//              shapes do not change.
//
//   functions  controls/functions.js, reached with the `run` message. The whole
//              mappable catalogue, addressed by id, with the same event shapes
//              MIDI, FlexControl and the keyboard use. Every function added
//              there becomes reachable from outside with no change here and no
//              protocol revision — which is the point, and the reason there is
//              no third surface and never should be.
//
// Every command validates its arguments and either succeeds or throws a
// BridgeError with a specific code. None of them clamp silently: an out-of-band
// frequency is a mistake in the caller worth reporting, not something to round
// off and pretend about. Each returns the state it just set, so a client does
// not need a follow-up `get` to know where it landed.
//
// `ctx` is the control-surface facade from controls/panel.jsx — `actions`,
// `stepHz` and `state()`. Deliberately the same object the knobs and keys get:
// one path to the receiver, so a bridge command cannot behave differently from
// the button that does the same thing.

import { BridgeError, ERR } from './protocol.js';
import { registerProvider, setProviderStatus, unregisterProvider } from '../controls/radioProviders.js';
import {
    MAX_FREQ, MIN_FREQ, MODES, MODE_BY_ID, SQUELCH_MAX, SQUELCH_MIN,
    bandwidthLimits, squelchEnabled,
} from '../radio/constants.js';
import { VFO_IDS, getVfos, selectVfo, stepVfo } from '../lib/vfos.js';

// --- argument checking ------------------------------------------------------

function number(args, name, required) {
    const v = args[name];
    if (v === undefined || v === null) {
        if (required) throw new BridgeError(ERR.BAD_ARGS, `${name} is required`);
        return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BridgeError(ERR.BAD_ARGS, `${name} must be a number`);
    return n;
}

function bool(args, name) {
    const v = args[name];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'boolean') throw new BridgeError(ERR.BAD_ARGS, `${name} must be true or false`);
    return v;
}

// Absolute values are refused when they are impossible: the caller asked for
// something that does not exist, and clamping would report success for a
// frequency the receiver is not on.
function inRange(n, lo, hi, name) {
    if (n < lo || n > hi) {
        throw new BridgeError(ERR.BAD_ARGS, `${name} ${n} is outside ${lo}–${hi}`);
    }
    return n;
}

// Relative movements stop at the edge instead, because that is what turning the
// dial or the volume knob does — and what the receiver does anyway: applyTuning
// clamps to the band whatever it is handed. Refusing would make a step that ran
// into the edge do nothing at all, which no physical control does.
function toEdge(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
}

// The receiver as the VFO helpers want it.
const asRadio = (ctx) => {
    const s = ctx.state();
    return { tuning: s.tuning, view: s.view, actions: ctx.actions };
};

const tuningOf = (ctx) => {
    const { tuning } = ctx.state();
    return {
        frequency: tuning.frequency,
        mode: tuning.mode,
        bandwidthLow: tuning.bandwidthLow,
        bandwidthHigh: tuning.bandwidthHigh,
    };
};

function checkPassband(mode, low, high) {
    const limits = bandwidthLimits(mode);
    if (low >= high) throw new BridgeError(ERR.BAD_ARGS, `low ${low} must be below high ${high}`);
    inRange(low, limits.min, limits.max, 'low');
    inRange(high, limits.min, limits.max, 'high');
}

// --- the commands -----------------------------------------------------------

export const COMMANDS = {
    /**
     * tune — absolute, relative, or a step on the grid.
     *
     *   { frequency }                 exact
     *   { delta }                     relative, in Hz
     *   { step, dir }                 a step of the dial, snapped to the step
     *                                 grid exactly as the UI does; step
     *                                 defaults to the panel's current setting
     *
     * `mode` and the passband may ride along, and when they do it is one tune
     * rather than three: sending them separately walks the receiver through
     * intermediate mode/passband pairs on the way, which is audible and, on a
     * recalled VFO, was visible as the spectrum closing around the wrong place.
     */
    tune(args, ctx) {
        const stepping = args.step !== undefined || args.dir !== undefined;
        if (stepping) {
            if (args.frequency !== undefined || args.delta !== undefined) {
                throw new BridgeError(ERR.BAD_ARGS, 'give frequency, delta or step — not more than one');
            }
            const step = args.step === undefined ? ctx.stepHz : number(args, 'step', true);
            const dir = args.dir === undefined ? 1 : number(args, 'dir', true);
            if (!(step > 0)) throw new BridgeError(ERR.BAD_ARGS, 'step must be above zero');
            ctx.actions.stepBy(step, dir >= 0 ? 1 : -1);
            return tuningOf(ctx);
        }

        const state = ctx.state();
        const patch = {};

        if (args.frequency !== undefined && args.delta !== undefined) {
            throw new BridgeError(ERR.BAD_ARGS, 'give frequency or delta, not both');
        }
        if (args.frequency !== undefined) {
            patch.frequency = inRange(number(args, 'frequency', true), MIN_FREQ, MAX_FREQ, 'frequency');
        } else if (args.delta !== undefined) {
            patch.frequency = toEdge(
                state.tuning.frequency + number(args, 'delta', true), MIN_FREQ, MAX_FREQ,
            );
        }

        if (args.mode !== undefined) {
            if (!MODE_BY_ID[args.mode]) {
                throw new BridgeError(ERR.BAD_ARGS,
                    `no mode "${args.mode}" — one of ${MODES.map((m) => m.id).join(', ')}`);
            }
            patch.mode = args.mode;
        }

        const hasLow = args.bandwidthLow !== undefined;
        const hasHigh = args.bandwidthHigh !== undefined;
        if (hasLow !== hasHigh) {
            throw new BridgeError(ERR.BAD_ARGS, 'bandwidthLow and bandwidthHigh go together');
        }
        if (hasLow) {
            const low = number(args, 'bandwidthLow', true);
            const high = number(args, 'bandwidthHigh', true);
            checkPassband(patch.mode || state.tuning.mode, low, high);
            patch.bandwidthLow = low;
            patch.bandwidthHigh = high;
        }

        if (!Object.keys(patch).length) {
            throw new BridgeError(ERR.BAD_ARGS, 'nothing to tune');
        }
        ctx.actions.tuneTo(patch);

        // The spectrum follows the dial on its own when following is on; this
        // is for a client that wants the view moved regardless.
        if (bool(args, 'ensureVisible') && patch.frequency !== undefined) {
            ctx.actions.ensureVisible(patch.frequency);
        }
        return tuningOf(ctx);
    },

    /** mode — the passband becomes the mode's default, as pressing the button does. */
    mode(args, ctx) {
        if (!MODE_BY_ID[args.mode]) {
            throw new BridgeError(ERR.BAD_ARGS,
                `no mode "${args.mode}" — one of ${MODES.map((m) => m.id).join(', ')}`);
        }
        ctx.actions.setMode(args.mode);
        return tuningOf(ctx);
    },

    /** passband — edges in Hz relative to the dial, checked against the mode. */
    passband(args, ctx) {
        const low = number(args, 'low', true);
        const high = number(args, 'high', true);
        checkPassband(ctx.state().tuning.mode, low, high);
        ctx.actions.setBandwidth(low, high);
        return tuningOf(ctx);
    },

    /** volume — 0..1, absolute or relative. */
    volume(args, ctx) {
        const audio = ctx.state().audio;
        const relative = args.delta !== undefined;
        const raw = relative
            ? toEdge(audio.volume + number(args, 'delta', true), 0, 1)
            : inRange(number(args, 'volume', true), 0, 1, 'volume');
        const next = Math.round(raw * 100) / 100;
        ctx.actions.setVolume(next);
        return { volume: next, muted: audio.muted };
    },

    /**
     * mute — absolute by default, and that matters.
     *
     * PTT mute is driven by "the rig is transmitting: true/false". A toggle
     * desynchronises permanently the first time a message is missed, and then
     * un-mutes on transmit forever after. `toggle` is available for a button
     * that genuinely means "the other one".
     */
    mute(args, ctx) {
        const wanted = bool(args, 'muted');
        if (wanted === null) {
            if (!bool(args, 'toggle')) throw new BridgeError(ERR.BAD_ARGS, 'muted or toggle is required');
            ctx.actions.toggleMute();
            return { muted: !ctx.state().audio.muted };
        }
        // Straight through to the absolute setter rather than reading the
        // current value and toggling if it differs: that emulation is a
        // read-modify-write, and two controllers doing it at once both read the
        // same value, both toggle, and cancel each other out.
        ctx.actions.setMuted(wanted);
        return { muted: wanted };
    },

    /**
     * duck — silence that is not the user's mute.
     *
     * For a controller that has to make the receiver quiet for a moment and
     * then stop: a transmitting rig, a tab you have switched away from. It
     * leaves `muted` alone, so a transmission cannot end with the receiver
     * permanently muted, and the mute a client is showing stays true.
     */
    duck(args, ctx) {
        const wanted = bool(args, 'ducked');
        if (wanted === null) throw new BridgeError(ERR.BAD_ARGS, 'ducked is required');
        ctx.actions.setDucked(wanted);
        return { ducked: wanted };
    },

    /**
     * squelch — the slider position, whose floor means off, or `auto` to put it
     * just above the noise the receiver is hearing now.
     */
    squelch(args, ctx) {
        if (bool(args, 'auto')) {
            ctx.actions.autoSquelch();
            const sq = ctx.state().squelch;
            return { value: sq.value, enabled: sq.enabled, threshold: sq.threshold };
        }
        if (bool(args, 'enabled') === false) {
            ctx.actions.setSquelch(SQUELCH_MIN);
            return { value: SQUELCH_MIN, enabled: false, threshold: null };
        }
        const value = inRange(number(args, 'value', true), SQUELCH_MIN, SQUELCH_MAX, 'value');
        ctx.actions.setSquelch(value);
        return { value, enabled: squelchEnabled(value) };
    },

    /** vfo — select A/B/C/D, or step along them. */
    vfo(args, ctx) {
        if (args.step !== undefined) {
            const dir = number(args, 'step', true);
            if (dir !== 1 && dir !== -1) throw new BridgeError(ERR.BAD_ARGS, 'step must be 1 or -1');
            stepVfo(asRadio(ctx), dir);
            return { vfo: getVfos().active, ...tuningOf(ctx) };
        }
        if (!VFO_IDS.includes(args.id)) {
            throw new BridgeError(ERR.BAD_ARGS, `no VFO "${args.id}" — one of ${VFO_IDS.join(', ')}`);
        }
        selectVfo(asRadio(ctx), args.id);
        return { vfo: getVfos().active, ...tuningOf(ctx) };
    },

    /**
     * spectrum — where the view is and how wide.
     *
     * `center` and `span` together go through one call: setting them one after
     * the other leaves the span to close around wherever the view had got to.
     */
    spectrum(args, ctx) {
        const { actions } = ctx;
        if (bool(args, 'reset')) {
            actions.resetSpectrum();
            return { reset: true };
        }
        if (bool(args, 'centerOnTuned')) {
            actions.centerOnTuned();
            return viewOf(ctx);
        }
        if (args.zoom !== undefined) {
            const n = number(args, 'zoom', true);
            if (!Number.isInteger(n) || n === 0) {
                throw new BridgeError(ERR.BAD_ARGS, 'zoom must be a non-zero whole number of steps');
            }
            actions.zoomSteps(n, args.about === undefined ? undefined : number(args, 'about', true));
            return viewOf(ctx);
        }
        const center = number(args, 'center', false);
        const span = number(args, 'span', false);
        if (center !== null && span !== null) {
            actions.setSpectrumView(inRange(center, MIN_FREQ, MAX_FREQ, 'center'), span);
        } else if (center !== null) {
            actions.setSpectrumCenter(inRange(center, MIN_FREQ, MAX_FREQ, 'center'));
        } else if (span !== null) {
            actions.setSpan(span);
        } else {
            throw new BridgeError(ERR.BAD_ARGS, 'give center, span, zoom, centerOnTuned or reset');
        }
        return viewOf(ctx);
    },

    /**
     * power — off only.
     *
     * Starting audio needs a user gesture in every browser that matters, so an
     * extension cannot do it and is told so plainly rather than being handed a
     * command that quietly fails. Whether audio is running is in the `session`
     * topic, which is what a client actually wants to know.
     */
    power(args, ctx) {
        const on = bool(args, 'on');
        if (on === null) throw new BridgeError(ERR.BAD_ARGS, 'on is required');
        if (on) {
            throw new BridgeError(ERR.UNSUPPORTED,
                'audio must be started from the page — browsers require a user gesture');
        }
        ctx.actions.powerOff();
        return { running: false };
    },

    /**
     * panel — show, hide or move one panel.
     *
     *   { id, hidden }      show or hide it
     *   { id, placement }   move it to a dock, or set it floating
     *
     * Either or both, and at least one: a call naming a panel and asking for
     * nothing is a client with a bug, and answering it with the current state
     * would hide that.
     *
     * Both take the same path the Layout panel's own controls do, so there is
     * no second way to arrange a page — the rule the rest of this file keeps.
     * Moving a hidden panel shows it, because `movePanel` does; asking for
     * somewhere it already is still returns the layout rather than failing,
     * since a client setting a position it cannot see has nothing to correct.
     */
    panel(args, ctx) {
        const layout = ctx.layout;
        if (!layout) throw new BridgeError(ERR.UNSUPPORTED, 'this page has no layout');

        const id = typeof args.id === 'string' ? args.id : '';
        const known = layout.panels.find((p) => p.id === id);
        if (!known) {
            throw new BridgeError(ERR.BAD_ARGS,
                `no panel "${id}" — one of ${layout.panels.map((p) => p.id).join(', ')}`);
        }

        const hidden = bool(args, 'hidden');
        const placement = args.placement === undefined ? null : String(args.placement);
        if (hidden === null && placement === null) {
            throw new BridgeError(ERR.BAD_ARGS, 'give hidden, placement, or both');
        }
        if (placement !== null && !layout.placements.includes(placement)) {
            throw new BridgeError(ERR.BAD_ARGS,
                `no placement "${placement}" — one of ${layout.placements.join(', ')}`);
        }
        // The Layout panel is what brings the others back, so the UI refuses to
        // hide it. Silently ignoring that here would leave a client's menu
        // showing a tick that never clears.
        if (hidden === true && known.unhideable) {
            throw new BridgeError(ERR.UNSUPPORTED,
                `"${id}" cannot be hidden — it is what unhides the others`);
        }

        if (placement !== null) layout.move(id, placement);
        if (hidden !== null) layout.setHidden(id, hidden);
        return layout.snapshot();
    },

    /**
     * radio — offer a radio-control transport, or say what it is doing.
     *
     *   { action: 'register', provider: {...} }   offer it
     *   { action: 'unregister', id }              withdraw it
     *   { action: 'status', id, ... }             connected / frequency / mode / tx / error
     *
     * A page cannot open a socket to flrig or rigctld and their servers send no
     * CORS headers, so Serial is the only transport the page can host by
     * itself. Whatever is hosting the page — an extension, the desktop shell —
     * can reach them, so it registers what it has and the Radio Control panel
     * offers it beside Serial. See controls/radioProviders.js.
     *
     * Registering the same id again replaces it, which is what a client
     * re-announcing after a page reload does.
     */
    radio(args, ctx) {
        const action = String(args.action || '');
        try {
            if (action === 'register') return registerProvider(args.provider);
            if (action === 'unregister') {
                unregisterProvider(args.id);
                return { id: String(args.id || ''), registered: false };
            }
            if (action === 'status') return setProviderStatus(args.id, args);
        } catch (err) {
            throw new BridgeError(ERR.BAD_ARGS, err.message);
        }
        throw new BridgeError(ERR.BAD_ARGS, 'action must be register, unregister or status');
    },
};

function viewOf(ctx) {
    const { view } = ctx.state();
    return {
        centerFreq: view.centerFreq,
        span: view.span,
        binBandwidth: view.binBandwidth,
        binCount: view.binCount,
    };
}

export const COMMAND_NAMES = Object.keys(COMMANDS);

export function runCommand(name, args, ctx) {
    const fn = COMMANDS[name];
    if (!fn) {
        throw new BridgeError(ERR.UNSUPPORTED,
            `no command "${name}" — one of ${COMMAND_NAMES.join(', ')}`);
    }
    return fn(args || {}, ctx);
}
