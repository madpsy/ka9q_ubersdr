// Radio-control transports that something outside the page provides.
//
// The Radio Control panel drives a transceiver over Web Serial, through
// Hamlib-in-wasm, and that is the only way a *page* can reach a rig: a browser
// tab cannot open a socket to flrig or rigctld, and their XML-RPC and TCP
// servers send no CORS headers even if it could. An extension or a desktop
// shell has no such limit, so the page stops being the only place a transport
// can live: whatever is hosting the page registers what it can reach, and the
// panel offers it beside Serial.
//
// What a provider registers is a description, not code — an id, a label, and
// the fields it needs filled in (flrig: a host and a port). The panel renders
// those fields, the values travel back over the `radiocontrol` topic, and the
// provider does the talking. Nothing here knows what flrig is.
//
// Registrations are per client and last as long as it does. A client that dies
// without unregistering leaves an option that cannot connect, which is why the
// panel shows the provider's own status rather than assuming it is there.

const providers = new Map();   // id -> descriptor
const status = new Map();      // id -> last reported state
const listeners = new Set();

// The field types a provider may ask the panel to render. Deliberately few: a
// transport needs an address and a port, and a provider that wants a form
// belongs in its own window rather than in a receiver panel.
export const FIELD_TYPES = ['text', 'number', 'password'];

function emit() {
    const snapshot = listProviders();
    for (const fn of Array.from(listeners)) {
        try { fn(snapshot); } catch (e) { console.error('[ubersdr] provider listener threw', e); }
    }
}

/** Everything registered, in registration order, each with its last status. */
export function listProviders() {
    return Array.from(providers.values()).map((p) => ({
        ...p,
        status: status.get(p.id) || { connected: false },
    }));
}

export function getProvider(id) {
    return providers.get(id) || null;
}

export function providerStatus(id) {
    return status.get(id) || { connected: false };
}

/**
 * Sanitised on the way in, because this arrives from outside the page.
 *
 * Anything malformed is refused rather than repaired: a provider whose fields
 * are half-understood would render a form that cannot be filled in correctly,
 * and the client is in a position to be told.
 */
export function normaliseProvider(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('provider must be an object');
    const id = String(raw.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) {
        throw new Error('provider id must be 1-32 characters of [A-Za-z0-9_-]');
    }
    const label = String(raw.label || id).slice(0, 40);
    const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, 8).map((f) => {
        const key = String((f && f.key) || '').trim();
        if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) throw new Error(`bad field key "${key}"`);
        const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
        return {
            key,
            label: String(f.label || key).slice(0, 40),
            type,
            placeholder: f.placeholder === undefined ? '' : String(f.placeholder).slice(0, 40),
            default: f.default === undefined ? (type === 'number' ? 0 : '') : f.default,
        };
    });
    return {
        id,
        label,
        fields,
        // What it is able to keep in step. The panel hides a switch for
        // something the transport cannot do rather than offering a control that
        // silently does nothing.
        capabilities: ['frequency', 'mode', 'ptt'].filter(
            (c) => !Array.isArray(raw.capabilities) || raw.capabilities.includes(c),
        ),
    };
}

export function registerProvider(raw) {
    const provider = normaliseProvider(raw);
    providers.set(provider.id, provider);
    emit();
    return provider;
}

export function unregisterProvider(id) {
    const had = providers.delete(String(id || ''));
    status.delete(String(id || ''));
    if (had) emit();
    return had;
}

/** What the provider says it is doing: connected, the rig readout, an error. */
export function setProviderStatus(id, next) {
    const key = String(id || '');
    if (!providers.has(key)) throw new Error(`no provider "${key}"`);
    const prev = status.get(key) || {};
    const merged = {
        connected: next.connected === undefined ? !!prev.connected : !!next.connected,
        busy: next.busy === undefined ? !!prev.busy : !!next.busy,
        frequency: next.frequency === undefined ? (prev.frequency ?? null) : next.frequency,
        mode: next.mode === undefined ? (prev.mode ?? null) : next.mode,
        tx: next.tx === undefined ? !!prev.tx : !!next.tx,
        error: next.error === undefined ? (prev.error ?? null) : (next.error || null),
    };
    status.set(key, merged);
    emit();
    return merged;
}

/**
 * A provider correcting the panel: what its own settings actually are.
 *
 * The panel is where a transport is configured, but it is not the only place —
 * the browser extension has had an flrig host and port in its popup since long
 * before this existed, and two views of one setting have to agree whichever one
 * was touched. So a provider may write back what it now holds.
 *
 * Only its own fields, and only the sync settings that mean something to it: a
 * transport has no business choosing what some other transport connects to.
 * `select` is separate and explicit, because switching the panel to this
 * transport is a different act from telling it an address — one is answering a
 * question the operator asked, the other is taking the choice off them.
 */
export function normaliseConfigure(id, raw) {
    const provider = providers.get(String(id || ''));
    if (!provider) throw new Error(`no provider "${id}"`);
    const out = {};
    if (raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)) {
        const known = new Set(provider.fields.map((f) => f.key));
        const config = {};
        for (const [key, value] of Object.entries(raw.config)) {
            // Anything the provider did not declare is dropped rather than
            // stored: the panel cannot render a field it was never told about,
            // so keeping it would be keeping something nobody can see or edit.
            if (!known.has(key)) continue;
            if (typeof value === 'string' || typeof value === 'number') config[key] = value;
        }
        if (Object.keys(config).length) out.config = config;
    }
    if (typeof raw.connect === 'boolean') out.connect = raw.connect;
    if (raw.direction === 'sdr-to-radio' || raw.direction === 'radio-to-sdr') {
        out.direction = raw.direction;
    }
    for (const key of ['syncFrequency', 'syncMode', 'muteOnTx']) {
        if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
    if (raw.select === true) out.select = true;
    if (!Object.keys(out).length) throw new Error('nothing to configure');
    return out;
}

export function onProviders(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Test seam: the module is a singleton and a test that registers a provider
// would otherwise leak it into the next one.
export function resetProviders() {
    providers.clear();
    status.clear();
    emit();
}
