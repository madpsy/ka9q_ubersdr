'use strict';

// The UberSDR Dial over Bluetooth, inside the app: `navigator.bluetooth` as
// v2's Dial driver (static/v2/src/controls/dial.js) expects to find it.
//
// A WebView has no Web Bluetooth — Android's WebView never shipped it, even
// where Chrome on the same phone has it — so the Dial's Bluetooth link simply
// was not there. This is the page half of a stand-in: just enough of the API
// for dial.js, carried over the host channel to native code that does the
// radio work (DialBluetooth.java on Android).
//
// Only the Dial. The native half scans for the Dial's service alone, connects
// only to a dial the operator picked in its own chooser, and touches only that
// service's characteristics; this half refuses a request for anything else
// before it is sent. The page is a remote receiver's, and a remote receiver
// has no business with the rest of the phone's Bluetooth.
//
// Declared only when the host says so, through `bluetoothHost` in
// `window.ubersdrDesktop`, written at document start before this runs. Never
// over a real `navigator.bluetooth`, should a WebView ever grow one.
//
// ── The protocol ────────────────────────────────────────────────────────────
//
// Page → host, as JSON over the host channel (tellHost):
//
//   {type:'ble-request', id}                 the chooser: scan, let the
//                                            operator pick, remember the pick
//   {type:'ble-devices', id}                 the remembered dial, if any and if
//                                            the permission is already held —
//                                            never a prompt
//   {type:'ble-connect', id, device}
//   {type:'ble-notify', id, device, char}
//   {type:'ble-write', id, device, char, value, response}
//                                            value: base64, at most 512 bytes
//   {type:'ble-disconnect', device}          no answer
//
// Host → page, as strings in the host channel's `prefix:payload` style:
//
//   ble-reply:{id, ...}                      the answer to any request above;
//                                            {id, error:{name, message}} when
//                                            it failed. ble-request and
//                                            ble-devices carry `device` /
//                                            `devices` as {id, name}; ble-connect
//                                            carries `services`:
//                                            [{uuid, chars:[uuid]}]
//   ble-value:{device, char, value}          a notification, base64
//   ble-disconnected:{device}                the link dropped, or the host let
//                                            it go
//
// Device ids are the host's opaque tokens, not addresses. Request ids start
// from a random point per page load, as in hostspeech.js and for the same
// reason: the host outlives a reload, and a reply meant for the old page must
// not match the new page's first request.

export const DIAL_SERVICE = '89540001-8c77-4d5f-9411-e7534b50c873';

export const TIMEOUTS = {
    // The chooser is open for as long as the operator takes to switch the dial
    // on and pick it, and may first show the Nearby devices prompt.
    requestMs: 180000,
    devicesMs: 5000,
    // The host gives up on a connect itself after 10 s (the dial is off or out
    // of range); this only catches a host that never answers.
    connectMs: 20000,
    opMs: 10000,
};

// The longest attribute value GATT allows.
const MAX_WRITE = 512;

function idBase() {
    return Math.floor(Math.random() * 0x40000000);
}

function parse(json) {
    try { return JSON.parse(json); } catch (e) { return null; }
}

function domError(name, message) {
    const err = new Error(message || name);
    err.name = name;
    return err;
}

/** Bytes of any BufferSource. */
function bytesOf(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw domError('TypeError', 'not a BufferSource');
}

/** A minimal EventTarget: dial.js only adds and removes listeners. */
function eventful(obj) {
    const listeners = new Map();
    obj.addEventListener = (type, fn) => {
        if (typeof fn !== 'function') return;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
        const set = listeners.get(type);
        if (set) set.delete(fn);
    };
    obj.dispatchEvent = (event) => {
        const set = listeners.get(event.type);
        if (!set) return true;
        for (const fn of [...set]) {
            try { fn.call(obj, event); } catch (e) { /* one listener cannot stop the rest */ }
        }
        // As in the DOM, a property handler runs after the listeners.
        const prop = obj['on' + event.type];
        if (typeof prop === 'function') {
            try { prop.call(obj, event); } catch (e) { /* as above */ }
        }
        return true;
    };
    return obj;
}

/**
 * Declare `navigator.bluetooth` if the host's flag says to, and return the
 * handler for what the host sends back: `onHostMessage(data)` is true for a
 * message that was this file's. The timer functions exist for tests.
 */
export function installHostBluetooth({
    win,
    tellHost,
    btoaFn = (s) => btoa(s),
    atobFn = (s) => atob(s),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    timeouts = TIMEOUTS,
} = {}) {
    const none = { onHostMessage: () => false, bluetooth: null };
    let flags = null;
    try { flags = win && win.ubersdrDesktop; } catch (e) { flags = null; }
    if (!flags || !flags.bluetoothHost) return none;
    const nav = win.navigator;
    if (!nav || nav.bluetooth) return none;

    const limits = { ...TIMEOUTS, ...timeouts };
    let counter = idBase();
    const pending = new Map();      // id -> {resolve, reject, timer, device}
    const devices = new Map();      // token -> BluetoothDevice
    let requesting = false;

    function ask(message, ms, device) {
        return new Promise((resolve, reject) => {
            counter += 1;
            const id = counter;
            const timer = setTimer(() => {
                pending.delete(id);
                reject(domError('NetworkError', 'the app did not answer'));
            }, ms);
            pending.set(id, { resolve, reject, timer, device: device || null });
            tellHost({ ...message, id });
        });
    }

    function settle(reply) {
        const p = pending.get(reply.id);
        if (!p) return;
        pending.delete(reply.id);
        clearTimer(p.timer);
        if (reply.error) {
            p.reject(domError(String(reply.error.name || 'NetworkError'), String(reply.error.message || 'failed')));
        } else {
            p.resolve(reply);
        }
    }

    // Whatever was waiting on a device that has gone.
    function failDevice(token, message) {
        for (const [id, p] of [...pending]) {
            if (p.device !== token) continue;
            pending.delete(id);
            clearTimer(p.timer);
            p.reject(domError('NetworkError', message));
        }
    }

    function base64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoaFn(binary);
    }

    function unbase64(text) {
        const binary = atobFn(String(text || ''));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
        return out;
    }

    function makeCharacteristic(device, service, uuid) {
        const token = device.id;
        const ch = eventful({
            uuid,
            service,
            value: null,
            properties: {},
            async startNotifications() {
                if (!device.gatt.connected) throw domError('NetworkError', 'not connected');
                await ask({ type: 'ble-notify', device: token, char: uuid }, limits.opMs, token);
                return ch;
            },
            async stopNotifications() {
                return ch;
            },
            writeValueWithResponse(value) { return write(value, true); },
            writeValueWithoutResponse(value) { return write(value, false); },
            writeValue(value) { return write(value, true); },
            async readValue() {
                throw domError('NotSupportedError', 'reading is not supported here');
            },
        });
        async function write(value, response) {
            if (!device.gatt.connected) throw domError('NetworkError', 'not connected');
            const bytes = bytesOf(value);
            if (bytes.length > MAX_WRITE) throw domError('InvalidModificationError', 'value too long');
            await ask({
                type: 'ble-write', device: token, char: uuid, value: base64(bytes), response,
            }, limits.opMs, token);
        }
        return ch;
    }

    function makeService(device, uuid, charUuids) {
        const service = { uuid, device, isPrimary: true };
        const chars = new Map();
        for (const c of charUuids) chars.set(c, makeCharacteristic(device, service, c));
        service._chars = chars;
        service.getCharacteristic = async (want) => {
            const c = chars.get(String(want).toLowerCase());
            if (!c) throw domError('NotFoundError', `no characteristic ${want}`);
            return c;
        };
        service.getCharacteristics = async () => [...chars.values()];
        return service;
    }

    function deviceFor(info) {
        const token = String(info.id);
        let device = devices.get(token);
        if (device) {
            if (info.name) device.name = String(info.name);
            return device;
        }
        device = eventful({ id: token, name: info.name ? String(info.name) : '' });
        let services = new Map();
        const gatt = {
            device,
            connected: false,
            async connect() {
                if (gatt.connected) return gatt;
                const reply = await ask({ type: 'ble-connect', device: token }, limits.connectMs, token);
                services = new Map();
                for (const s of reply.services || []) {
                    const uuid = String(s.uuid).toLowerCase();
                    services.set(uuid, makeService(device, uuid, (s.chars || []).map((c) => String(c).toLowerCase())));
                }
                gatt.connected = true;
                return gatt;
            },
            disconnect() {
                if (!gatt.connected) return;
                tellHost({ type: 'ble-disconnect', device: token });
                lost();
            },
            async getPrimaryService(want) {
                if (!gatt.connected) throw domError('NetworkError', 'not connected');
                const s = services.get(String(want).toLowerCase());
                if (!s) throw domError('NotFoundError', `no service ${want}`);
                return s;
            },
            async getPrimaryServices() {
                if (!gatt.connected) throw domError('NetworkError', 'not connected');
                return [...services.values()];
            },
        };
        function lost() {
            const was = gatt.connected;
            gatt.connected = false;
            failDevice(token, 'the dial disconnected');
            if (was) device.dispatchEvent({ type: 'gattserverdisconnected', target: device });
        }
        device.gatt = gatt;
        device._lost = lost;
        device._characteristic = (uuid) => {
            for (const s of services.values()) {
                const c = s._chars.get(uuid);
                if (c) return c;
            }
            return null;
        };
        devices.set(token, device);
        return device;
    }

    function asksForTheDial(options) {
        const filters = options && Array.isArray(options.filters) ? options.filters : [];
        return filters.some((f) => f && Array.isArray(f.services)
            && f.services.some((s) => String(s).toLowerCase() === DIAL_SERVICE));
    }

    const bluetooth = eventful({
        async getAvailability() {
            return true;
        },
        async requestDevice(options) {
            if (!asksForTheDial(options)) {
                throw domError('NotFoundError', 'this app connects to the UberSDR Dial only');
            }
            // One chooser at a time, as a browser allows.
            if (requesting) throw domError('InvalidStateError', 'a device chooser is already open');
            requesting = true;
            try {
                const reply = await ask({ type: 'ble-request' }, limits.requestMs);
                if (!reply.device || reply.device.id == null) throw domError('NotFoundError', 'no dial chosen');
                return deviceFor(reply.device);
            } finally {
                requesting = false;
            }
        },
        async getDevices() {
            let reply;
            try {
                reply = await ask({ type: 'ble-devices' }, limits.devicesMs);
            } catch (e) {
                return [];
            }
            return (Array.isArray(reply.devices) ? reply.devices : [])
                .filter((d) => d && d.id != null)
                .map(deviceFor);
        },
    });

    try {
        Object.defineProperty(nav, 'bluetooth', { value: bluetooth, configurable: true, enumerable: true });
    } catch (e) {
        return none;
    }

    // What the page's Dial watcher reads to decide that this host remembers a
    // dial and is worth retrying a few times after load (ControlWatch.jsx,
    // DIAL_DESKTOP_RETRY_MS) — there is no hotplug event for a dial switched on
    // after the page. getDevices() above already answers with the remembered
    // dial, so this has nothing to add and says so: asking again here would
    // only connect to the same dial twice per attempt.
    if (typeof flags.bluetoothAutoConnect !== 'function') {
        try { flags.bluetoothAutoConnect = () => Promise.resolve(false); } catch (e) { /* frozen */ }
    }

    function onHostMessage(data) {
        if (typeof data !== 'string') return false;
        if (data.startsWith('ble-reply:')) {
            const reply = parse(data.slice(10));
            if (reply && reply.id != null) settle(reply);
            return true;
        }
        if (data.startsWith('ble-value:')) {
            const m = parse(data.slice(10));
            const device = m && devices.get(String(m.device));
            if (!device || !device.gatt.connected) return true;
            const ch = device._characteristic(String(m.char).toLowerCase());
            if (!ch) return true;
            // A fresh buffer of exactly the value: dial.js reads `.value.buffer`
            // whole.
            const bytes = unbase64(m.value);
            ch.value = new DataView(bytes.buffer);
            ch.dispatchEvent({ type: 'characteristicvaluechanged', target: ch });
            return true;
        }
        if (data.startsWith('ble-disconnected:')) {
            const m = parse(data.slice(17));
            const device = m && devices.get(String(m.device));
            if (device) device._lost();
            return true;
        }
        return false;
    }

    return { onHostMessage, bluetooth };
}
