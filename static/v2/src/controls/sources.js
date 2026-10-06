// The three control sources, held outside React.
//
// This exists because of what a v2 panel is: moving one between docks, floating
// it, or opening it on a phone unmounts and remounts the component. If the
// sources lived in that component, a dock drag would close the serial port
// mid-QSO, drop the CAT link, and — for Radio Sync — throw away a 14 MB wasm
// module that then has to be fetched again.
//
// So they are module singletons with a lifetime tied to the *choice of source*,
// not to the panel's mount state. Hardware is released when the operator picks
// a different surface or presses Disconnect, and at no other time. A collapsed
// or hidden panel keeps its connection, which is the behaviour you want from a
// rig that is tracking your receiver.
//
// FlexControl, the RC-28 and MIDI are the mapped surfaces and exclude each
// other — two of them mapped to frequency would fight. Radio Sync excludes neither: it is a
// panel of its own and can run alongside whichever surface is chosen.

import { FlexControl, flexKeyLabel } from './flexcontrol.js';
import { MIDIControl, midiKeyLabel } from './webmidi.js';
import { RC28Control, rc28KeyLabel } from './rc28.js';
import { RadioSync } from './radiosync.js';

let flex = null;
let midi = null;
let rc28 = null;
let sync = null;

export function getFlex() {
    if (!flex) flex = new FlexControl();
    return flex;
}

export function getRc28() {
    if (!rc28) rc28 = new RC28Control();
    return rc28;
}

export function getMidi() {
    if (!midi) midi = new MIDIControl();
    return midi;
}

// Created on demand, and creating it downloads nothing — `ensureLoaded()` is
// what fetches Hamlib, and only the Radio Sync UI calls it.
export function getSync() {
    if (!sync) sync = new RadioSync();
    return sync;
}

export function getSurface(id) {
    if (id === 'midi') return getMidi();
    if (id === 'rc28') return getRc28();
    return getFlex();
}

// How a surface names one of its controls, for the mapping table and the log.
export function surfaceKeyLabel(id) {
    if (id === 'midi') return midiKeyLabel;
    if (id === 'rc28') return rc28KeyLabel;
    return flexKeyLabel;
}

// Releases the mapped surface that is not `keep`. Called when the chosen
// surface changes, so at most one of them is ever claimed. Radio Sync is
// untouched — it is nobody's alternative now. Safe to call for a surface that
// was never created: nothing is instantiated here.
export function releaseSurfaceExcept(keep) {
    if (keep !== 'flexcontrol' && flex) flex.disconnect();
    if (keep !== 'midi' && midi) midi.close();
    if (keep !== 'rc28' && rc28) rc28.disconnect();
}
