// Turning hardware movement into receiver commands.
//
// This used to live in the SDR Control panel, and that was the bug: a collapsed
// section is unmounted, so collapsing the panel took the `input` subscription
// with it. The surface stayed connected — it is a singleton in sources.js, and
// the badge above the spectrum went on saying so — but nothing was listening,
// and a knob that had been tuning the receiver a moment ago did nothing. The
// same for the radio sync, whose live context was owned by the Radio control
// panel and went stale when that panel closed.
//
// So dispatch lives here, driven by ControlWatch, which is mounted for the life
// of the page. The panels are what you set it up with, not what runs it.
//
// Learn is the exception and stays with the panel, because it only means
// anything while somebody is looking at it: the panel installs a handler that
// takes input *before* the dispatcher, and removes it when learning stops.

import { Dispatcher } from './mappings.js';
import { getSurface } from './sources.js';
import { hardwareMessages } from './hardware.js';

const dispatchers = new Map();
// The radio facade. A live one — see useControlContext, whose getters read the
// current render — held by ControlWatch, so it never goes stale.
let context = null;
// While the panel is learning, it consumes input instead. Returns true if it
// took the event.
let learn = null;
// How to name a control and a function in a warning, which needs the DSP
// schemas and the hardware list. Installed by ControlWatch; without it the
// warning is still emitted, just less specific.
let describe = null;

function dispatcherFor(id) {
    let d = dispatchers.get(id);
    if (!d) {
        d = new Dispatcher();
        // A function that refuses the event it was handed is the one failure
        // with nothing to see — the control is mapped, the row looks right, and
        // the receiver ignores it. Said once per control: a fader on an
        // encoder-only function sends a message per degree of travel and would
        // bury the log. Sent to hardwareMessages so the panel's log shows it
        // when the panel is open and nothing is lost when it is not.
        const warned = new Set();
        d.onResult = (key, fn, ok) => {
            if (ok) { warned.delete(key); return; }
            if (warned.has(key)) return;
            warned.add(key);
            const text = describe
                ? describe(id, key, fn)
                : `A mapped control was ignored — that function cannot be driven by it`;
            hardwareMessages.emit('message', { text, tone: 'warn' });
        };
        dispatchers.set(id, d);
    }
    return d;
}

export function setControlContext(ctx) {
    context = ctx;
}

export function setSurfaceMappings(id, mappings) {
    dispatcherFor(id).setMappings(mappings);
}

export function setControlDescriber(fn) {
    describe = fn;
}

/** The panel, while learning. Returns an unsubscribe. */
export function setLearnHandler(fn) {
    learn = fn;
    return () => { if (learn === fn) learn = null; };
}

/**
 * Listen to a surface and drive the receiver from it. Returns an unsubscribe.
 *
 * Unsubscribing stops the dispatch and nothing else: the device stays claimed,
 * because releasing it belongs to the surface switch rather than to anything
 * here going away.
 */
export function watchSurface(id) {
    if (!id || id === 'off') return () => {};
    const surface = getSurface(id);
    if (!surface) return () => {};

    return surface.on('input', (e) => {
        if (learn && learn(e)) return;
        if (!context) return;
        dispatcherFor(id).handle(e.key, e.event, context);
    });
}

// --- connecting unattended --------------------------------------------------
//
// Autoconnect was the panel's too, and the panel is `defaultOpen: false` — so a
// surface set to connect on its own only ever did once the operator opened the
// panel and reminded it to. Here it runs from ControlWatch, which means a page
// loaded with everything collapsed still comes up with the dial live.
//
// Only ever to hardware already granted: a MIDI input whose name was remembered
// from a Connect, a serial port already picked out of the OS dialog. Neither can
// be claimed without that first deliberate act, which is what makes doing it
// unattended reasonable. Nothing here reports a failure — no dial plugged in is
// the normal state of a receiver nobody is sitting at, not an error worth a line
// in the log.

// A press of Disconnect outranks the switch until the operator asks again, or a
// hotplug would undo it the moment anything moved. Held here rather than in the
// panel so the panel closing does not forget it.
const manualOff = new Set();

export function setManualOff(id, off) {
    if (off) manualOff.add(id);
    else manualOff.delete(id);
}

export function tryAutoConnect(id, conf) {
    if (!id || id === 'off' || !conf || !conf.autoConnect || manualOff.has(id)) return;
    const surface = getSurface(id);
    if (!surface || surface.connected) return;
    if (id !== 'midi') { surface.autoConnect(); return; }
    if (!conf.device) return;
    const match = surface.devices().find((d) => d.name === conf.device);
    if (match) surface.connect(match.id);
}

/** Test seam. */
export function _resetDispatch() {
    manualOff.clear();
    dispatchers.clear();
    context = null;
    learn = null;
    describe = null;
}
