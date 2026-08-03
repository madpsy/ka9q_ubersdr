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
// a different source or presses Disconnect, and at no other time. A collapsed
// or hidden panel keeps its connection, which is the behaviour you want from a
// rig that is tracking your receiver.

import { FlexControl } from './flexcontrol.js';
import { MIDIControl } from './webmidi.js';
import { RadioSync } from './radiosync.js';

let flex = null;
let midi = null;
let sync = null;

export function getFlex() {
    if (!flex) flex = new FlexControl();
    return flex;
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
    return id === 'midi' ? getMidi() : getFlex();
}

// Releases every source except `keep`. Called when the selected source changes,
// so exactly one device is ever claimed. Safe to call for a source that was
// never created — nothing is instantiated here.
export function releaseExcept(keep) {
    if (keep !== 'flexcontrol' && flex) flex.disconnect();
    if (keep !== 'midi' && midi) midi.close();
    if (keep !== 'radiosync' && sync) sync.disconnect();
}
