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
//
// The typed-in ones, which the SDR Control panel's surfaces share (see
// surfaces.js), and `choice` *(API 1.8)*: one of a few fixed values, shown as
// buttons — OmniRig's Rig 1 or Rig 2 is a pick, not something to type.
export const INPUT_FIELD_TYPES = ['text', 'number', 'password'];
export const FIELD_TYPES = [...INPUT_FIELD_TYPES, 'choice'];

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

/**
 * A choice field's options, as {value, label}. Refused rather than repaired
 * when there are too few to choose between, or a value is not a plain string or
 * number: buttons for half a list would offer choices the provider never meant.
 */
function normaliseOptions(key, raw) {
    if (!Array.isArray(raw)) throw new Error(`choice field "${key}" needs options`);
    const seen = new Set();
    const options = [];
    for (const o of raw) {
        const value = o && typeof o === 'object' ? o.value : undefined;
        if (typeof value !== 'string' && typeof value !== 'number') {
            throw new Error(`choice field "${key}" has an option without a value`);
        }
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({ value, label: String(o.label ?? value).slice(0, 20) });
    }
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
        throw new Error(`choice field "${key}" needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
    }
    return options;
}

/**
 * The option `value` names, as that option's own value, or undefined.
 *
 * Matched by text, so 2 and '2' are the same choice: a setting saved while the
 * field was a text box, or sent by a client that stringifies, still lands on
 * its button. What comes back is the option's value, typed as the provider
 * declared it, so the button lights and the provider gets what it asked for.
 */
export function choiceValue(field, value) {
    if (value === undefined || value === null) return undefined;
    const want = String(value).trim();
    const o = field.options.find((opt) => String(opt.value) === want);
    return o ? o.value : undefined;
}

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
        const field = {
            key,
            label: String(f.label || key).slice(0, 40),
            type,
            placeholder: f.placeholder === undefined ? '' : String(f.placeholder).slice(0, 40),
            default: f.default === undefined ? (type === 'number' ? 0 : '') : f.default,
        };
        if (type === 'choice') {
            field.options = normaliseOptions(key, f.options);
            // A default that is not one of them would leave no button lit.
            const d = choiceValue(field, field.default);
            field.default = d === undefined ? field.options[0].value : d;
        }
        return field;
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

// The rig's name, and the lines of detail under the readout. Both arrive from
// outside the page and are only ever shown, so they are cut to what fits the
// panel rather than refused: a provider sending a long model name should still
// get it on screen.
const MAX_RIG = 60;
const MAX_DETAILS = 12;
const MAX_LABEL = 30;
const MAX_VALUE = 80;

function normaliseRig(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim().slice(0, MAX_RIG);
    return s || null;
}

/**
 * `details` as label/value pairs of text, in the order given. Anything that is
 * not a pair with a label is dropped; null or an empty list clears them.
 */
function normaliseDetails(raw) {
    if (!Array.isArray(raw)) return null;
    const out = raw
        .filter((d) => d && typeof d === 'object' && d.label !== undefined && d.label !== null)
        .slice(0, MAX_DETAILS)
        .map((d) => ({
            label: String(d.label).trim().slice(0, MAX_LABEL),
            value: String(d.value ?? '').trim().slice(0, MAX_VALUE),
        }))
        .filter((d) => d.label);
    return out.length ? out : null;
}

/**
 * What the provider says it is doing: connected, the rig readout, an error.
 *
 * `rig` *(API 1.8)* names the radio — its model, as whatever is driving it knows
 * it — and `details` *(1.8)* is a short list of label/value pairs about the link,
 * shown under the readout when the panel is expanded. Both optional; a page
 * older than 1.8 ignores them.
 */
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
        rig: next.rig === undefined ? (prev.rig ?? null) : normaliseRig(next.rig),
        details: next.details === undefined ? (prev.details ?? null) : normaliseDetails(next.details),
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
            if (typeof value !== 'string' && typeof value !== 'number') continue;
            // A choice takes only one of its own values: anything else would be
            // a setting no button shows.
            const field = provider.fields.find((f) => f.key === key);
            if (field.type === 'choice') {
                const v = choiceValue(field, value);
                if (v !== undefined) config[key] = v;
                continue;
            }
            config[key] = value;
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
