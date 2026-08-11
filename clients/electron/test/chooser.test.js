// The chooser page, against a DOM small enough to read.
//
// The page cannot be opened here — this is Electron's renderer and there is no
// browser in a test run — so the document is stubbed to just the parts
// chooser.js uses. That is worth doing for one thing above all: the password
// dialog decides, from what the main process answers, whether a password has
// been saved or has to be carried to the connect that saves it. Getting that
// backwards loses the password silently, and it is the kind of wrong that only
// shows up on a receiver that actually needs one.
//
// The other half is cheaper and just as easy to break: every element the script
// reaches for by id has to exist in index.html.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'chooser', 'chooser.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(__dirname, '..', 'chooser', 'index.html'), 'utf8');

// --- the smallest document that runs it -----------------------------------------

class Node {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parent = null;
        this.attributes = {};
        this.listeners = new Map();
        this._class = '';
        this._text = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.classList = {
            add: (c) => { if (!this.has(c)) this._class = (this._class + ' ' + c).trim(); },
            remove: (c) => { this._class = this._class.split(/\s+/).filter((x) => x && x !== c).join(' '); },
            contains: (c) => this.has(c),
            toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)),
        };
    }

    has(c) { return this._class.split(/\s+/).includes(c); }

    get className() { return this._class; }

    set className(v) { this._class = v || ''; }

    get textContent() {
        return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    }

    set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }

    appendChild(child) { child.parent = this; this.children.push(child); return child; }

    insertBefore(child, before) {
        const at = this.children.indexOf(before);
        child.parent = this;
        this.children.splice(at < 0 ? this.children.length : at, 0, child);
        return child;
    }

    replaceChildren(...kids) { this.children = kids; }

    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
    }

    /**
     * Enough serialisation for the one thing that uses it: a marker icon is a
     * string of HTML, and it is built from a node so that a callsign off the
     * wire is escaped rather than injected. That escaping is the assertion.
     */
    get outerHTML() {
        const tag = this.tagName.toLowerCase();
        const inner = this.children.length
            ? this.children.map((c) => c.outerHTML).join('')
            : String(this._text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<${tag} class="${this._class}">${inner}</${tag}>`;
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }

    getAttribute(name) { return this.attributes[name]; }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }

    focus() { this.focused = true; }

    /** Fires on this node and then up the tree, as a bubbling event does. */
    dispatch(type, event = {}) {
        const ev = { type, target: this, preventDefault() {}, ...event };
        for (let node = this; node; node = node.parent) {
            for (const fn of node.listeners.get(type) || []) fn.call(node, ev);
        }
        return ev;
    }

    click() { return this.dispatch('click'); }

    /** Every node under this one, for the assertions. */
    all() {
        return this.children.flatMap((c) => [c, ...c.all()]);
    }

    find(pred) { return this.all().find(pred) || null; }

    text() { return this.textContent; }
}

function makeDocument(ids) {
    const byId = new Map();
    const body = new Node('body');
    for (const id of ids) {
        const node = new Node('div');
        node.id = id;
        byId.set(id, node);
        body.appendChild(node);
    }
    return {
        body,
        byId,
        createElement: (tag) => new Node(tag),
        createElementNS: (_ns, tag) => new Node(tag),
        getElementById: (id) => byId.get(id) || null,
        // No `head`: the map loads Leaflet by appending to it, and there is no
        // Leaflet — nor a layout to draw one in — under a stub document. The
        // load rejects on the missing property, which is the path the page takes
        // in a checkout that has not been through build.sh, and the one worth
        // exercising here.
    };
}

/**
 * A Leaflet that records what it was asked to draw.
 *
 * The map is a third of this page now and none of it can be seen from a stub
 * DOM, so what is checked instead is the call sequence: that the view is fitted
 * to every pin and the operator together, that it is refitted when the set
 * changes and left alone when it does not, and that selecting a receiver repaints
 * its pin and draws the path. The shapes matter as much as the calls — a marker's
 * getLatLng answers with an object, not the array it was given, and reading it as
 * an array is the kind of wrong that only shows up on a real map.
 */
function fakeLeaflet(log, doc) {
    const layers = new Set();
    return {
        layers,
        map(id, opts) {
            log.push(['map', id, opts]);
            return {
                _zoom: 2,
                setView(ll, z) { log.push(['setView', ll, z]); this._zoom = z; return this; },
                fitBounds(b, o) { log.push(['fitBounds', b.pts, o]); return this; },
                getZoom() { return this._zoom; },
                // A map in a hidden panel measures its container as nothing, and
                // Leaflet's own fitBounds arithmetic returns NaN for that.
                getSize() { return doc.getElementById('panel-dir').hidden ? { x: 0, y: 0 } : { x: 600, y: 400 }; },
                invalidateSize() {},
                removeLayer(l) { layers.delete(l); },
            };
        },
        tileLayer(url, o) { log.push(['tileLayer', url, o]); return { addTo(m) { layers.add(this); return this; } }; },
        divIcon(o) { return { html: o.html }; },
        latLngBounds(pts) { return { pts }; },
        terminator() { return { addTo() { return this; }, setTime() {} }; },
        polyline(pts, o) {
            log.push(['polyline', pts.length, o.color]);
            return { addTo() { layers.add(this); return this; } };
        },
        marker(ll, o) {
            return {
                icon: o.icon,
                addTo() { layers.add(this); return this; },
                bindPopup(c) { this.popup = c; return this; },
                bindTooltip(c, opts) { this.tooltip = c; this.tooltipOpts = opts; return this; },
                openTooltip() { log.push(['openTooltip', ll]); return this; },
                closeTooltip() { log.push(['closeTooltip', ll]); return this; },
                openPopup() { log.push(['openPopup', ll]); return this; },
                // An L.LatLng, which is not the array it was constructed from.
                getLatLng() { return { lat: ll[0], lng: ll[1] }; },
                setIcon(icon) { this.icon = icon; log.push(['setIcon', ll, icon.html]); return this; },
                on(ev, fn) { (this.handlers || (this.handlers = {}))[ev] = fn; return this; },
                fire(ev) { if (this.handlers && this.handlers[ev]) this.handlers[ev](); return this; },
            };
        },
    };
}

/**
 * Loads chooser.js into a context. Its top-level function declarations land on
 * the context object, which is how the tests reach keyButton and describe.
 *
 * With `leaflet`, the document grows a head whose appended scripts load, and the
 * page finds a window.L waiting — the path a staged build takes. Without it there
 * is no head at all, which is the path a checkout that skipped build.sh takes.
 */
function load(api, { ids, leaflet } = {}) {
    const document = makeDocument(ids || [...MARKUP.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const log = [];
    const ctx = {
        document,
        window: { ubersdr: api },
        console: { log() {}, error() {} },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
    };
    if (leaflet) {
        ctx.window.L = fakeLeaflet(log, document);
        // Synchronous, so the whole build stays in microtasks and one turn of
        // the macrotask queue still drains the page's startup. Both directions
        // are recorded: a stylesheet has to go in ahead of the page's own or
        // Leaflet's colours and fonts win on document order.
        const head = [];
        document.head = {
            order: head,
            appendChild: (node) => { head.push(node); if (node.onload) node.onload(); return node; },
            prepend: (node) => { head.unshift(node); if (node.onload) node.onload(); return node; },
        };
    }
    ctx.globalThis = ctx;
    ctx.log = log;
    vm.createContext(ctx);
    vm.runInContext(SOURCE, ctx);
    return ctx;
}

// An api that records what it was asked and answers as the main process would.
function fakeApi(overrides = {}) {
    const calls = [];
    return {
        calls,
        appInfo: async () => ({ builtinAvailable: true, buildInfo: 'test', electron: '0' }),
        saved: async () => [],
        directory: async () => [],
        lan: async () => [],
        sort: async () => 'used',
        setSort: async (v) => v,
        chooser: async () => ({}),
        setChooser: async (patch) => { calls.push(['setChooser', patch]); return patch; },
        home: async () => null,
        sharedPrefs: async () => true,
        setSharedPrefs: async (v) => v,
        resolve: async () => ({ ok: false, error: 'not used here' }),
        connect: async (desc) => { calls.push(['connect', desc]); return { ok: true }; },
        update: async () => {},
        remove: async () => {},
        onChanged: () => {},
        setPassword: async (target, password) => {
            calls.push(['setPassword', target, password]);
            return { ok: true, saved: true, hasPassword: !!password };
        },
        ...overrides,
    };
}

const SAVED = { id: 'abc', label: 'Shack', host: 'rx.example', port: 8080, tls: true };
const FOUND = { name: 'Somebody else', host: 'lan.local', port: 80, tls: false };

// The dialog, as it currently stands in the document.
const dialog = (ctx) => ctx.document.body.find((n) => n.has('modal-backdrop'));
const button = (root, label) => root.find((n) => n.tagName === 'BUTTON' && n.textContent === label);
const field = (root) => root.find((n) => n.tagName === 'INPUT' && n.type === 'password');
const text = (root) => root.find((n) => n.tagName === 'INPUT' && n.type === 'text');

// --- the page's own scaffolding -----------------------------------------------------

const DECLARED = new Set([...MARKUP.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

t('every element the script reaches for exists in the page', () => {
    // A renamed id fails at load in a way nothing else here would catch: the
    // page comes up and one control silently does nothing.
    const wanted = [...SOURCE.matchAll(/\bbyId\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(wanted.length > 5, 'found no lookups to check — has the script changed shape?');
    for (const id of new Set(wanted)) assert.ok(DECLARED.has(id), `#${id} is not in index.html`);
});

t('and so does every element it reaches for by a built-up id', () => {
    // The tabs and the sort chips are addressed as `tab-${name}` and friends,
    // which the scan above cannot see. They are the ones most likely to be
    // half-renamed, because renaming one means renaming four.
    for (const tab of ['saved', 'lan', 'dir']) {
        for (const id of [`tab-${tab}`, `tab-${tab}-count`, `panel-${tab}`]) {
            assert.ok(DECLARED.has(id), `#${id} is not in index.html`);
        }
    }
    for (const sort of ['distance', 'listeners', 'snr', 'name']) {
        assert.ok(DECLARED.has(`dir-sort-${sort}`), `#dir-sort-${sort} is not in index.html`);
    }
});

// --- the key ------------------------------------------------------------------------

t('a receiver with no password gets a key that says so', () => {
    const ctx = load(fakeApi());
    const btn = ctx.keyButton({ ...SAVED });
    assert.ok(btn.has('key-btn'));
    // The one beside the address box is inside a form, where a button with no
    // type is a submit button — the key would connect instead of asking.
    assert.strictEqual(btn.type, 'button');
    assert.ok(!btn.has('set'), 'not lit');
    assert.match(btn.title, /^Set a password/);
    assert.ok(btn.find((n) => n.tagName === 'SVG'), 'and it is an icon, not a word');
});

t('a receiver with one gets a key that is lit', () => {
    const ctx = load(fakeApi());
    const btn = ctx.keyButton({ ...SAVED, hasPassword: true });
    assert.ok(btn.has('set'));
    assert.match(btn.title, /change or clear/);
});

t('the key opens one dialog, naming the receiver it is for', () => {
    const ctx = load(fakeApi());
    const btn = ctx.keyButton({ ...SAVED });
    btn.click();
    const box = dialog(ctx);
    assert.ok(box, 'no dialog');
    assert.ok(box.textContent.includes('Shack'), box.textContent);
    // Clicking again replaces it rather than stacking a second one.
    btn.click();
    assert.strictEqual(ctx.document.body.all().filter((n) => n.has('modal-backdrop')).length, 1);
});

ta('saving sends the password to the main process and lights the key', async () => {
    const api = fakeApi();
    const ctx = load(api);
    const row = { ...SAVED };
    const btn = ctx.keyButton(row);
    btn.click();
    field(dialog(ctx)).value = ' hunter2 ';
    button(dialog(ctx), 'Save').click();
    await new Promise(setImmediate);

    const [call] = api.calls;
    assert.strictEqual(call[0], 'setPassword');
    assert.strictEqual(call[1].id, 'abc', 'addressed by id where there is one');
    assert.strictEqual(call[2], 'hunter2', 'and trimmed — a pasted password brings spaces');
    assert.strictEqual(row.hasPassword, true);
    assert.ok(btn.has('set'));
    assert.strictEqual(dialog(ctx), null, 'and the dialog is gone');
});

ta('clearing sends an empty password and puts the key out', async () => {
    const api = fakeApi({
        setPassword: async (target, password) => ({ ok: true, saved: true, hasPassword: !!password }),
    });
    const ctx = load(api);
    const row = { ...SAVED, hasPassword: true };
    const btn = ctx.keyButton(row);
    btn.click();
    button(dialog(ctx), 'Clear').click();
    await new Promise(setImmediate);
    assert.strictEqual(row.hasPassword, false);
    assert.ok(!btn.has('set'));
});

t('there is nothing to clear on a receiver that has no password', () => {
    const ctx = load(fakeApi());
    ctx.keyButton({ ...SAVED }).click();
    assert.strictEqual(button(dialog(ctx), 'Clear').disabled, true);
});

t('an empty box is a mistake, not a way to clear it', () => {
    // Save with nothing typed would otherwise read as "remove the password",
    // which is not what the button says.
    const api = fakeApi();
    const ctx = load(api);
    ctx.keyButton({ ...SAVED, hasPassword: true }).click();
    button(dialog(ctx), 'Save').click();
    assert.strictEqual(api.calls.length, 0);
    assert.ok(dialog(ctx), 'and the dialog stays open');
    assert.match(dialog(ctx).find((n) => n.has('modal-note')).textContent, /Clear/);
});

t('cancel and escape both leave without saving', () => {
    const api = fakeApi();
    const ctx = load(api);
    const btn = ctx.keyButton({ ...SAVED });
    btn.click();
    field(dialog(ctx)).value = 'hunter2';
    button(dialog(ctx), 'Cancel').click();
    assert.strictEqual(dialog(ctx), null);

    btn.click();
    field(dialog(ctx)).dispatch('keydown', { key: 'Escape' });
    assert.strictEqual(dialog(ctx), null);
    assert.strictEqual(api.calls.length, 0);
});

ta('Enter in the box saves, because that is what Enter does in a one-field dialog', async () => {
    const api = fakeApi();
    const ctx = load(api);
    ctx.keyButton({ ...SAVED }).click();
    const input = field(dialog(ctx));
    input.value = 'hunter2';
    input.dispatch('keydown', { key: 'Enter' });
    await new Promise(setImmediate);
    assert.deepStrictEqual(api.calls[0].slice(0, 1), ['setPassword']);
    assert.strictEqual(api.calls[0][2], 'hunter2');
});

// --- a receiver that is not saved yet -------------------------------------------------

ta('a password for an unsaved receiver is kept for the connect that saves it', async () => {
    // The LAN scan and the directory: there is no entry to attach it to until
    // the connect creates one, and the main process says so.
    const api = fakeApi({
        setPassword: async (target, password) => {
            api.calls.push(['setPassword', target, password]);
            return { ok: true, saved: false, hasPassword: !!password };
        },
    });
    const ctx = load(api);
    const row = { ...FOUND };
    const btn = ctx.keyButton(row);
    btn.click();
    field(dialog(ctx)).value = 'hunter2';
    button(dialog(ctx), 'Save').click();
    await new Promise(setImmediate);

    assert.strictEqual(api.calls[0][1].id, undefined, 'addressed by host and port');
    assert.strictEqual(api.calls[0][1].host, 'lan.local');
    assert.strictEqual(row.password, 'hunter2', 'held for the connect');
    assert.strictEqual(row.hasPassword, true);
    assert.ok(btn.has('set'), 'and the key is lit either way');

    // ...and the connect button on the same row carries it.
    const connect = ctx.connectButton(row, null);
    connect.click();
    await new Promise(setImmediate);
    const sent = api.calls.find((c) => c[0] === 'connect');
    assert.strictEqual(sent[1].password, 'hunter2');
});

t('the key beside the address box names whatever is typed there', () => {
    // No row to take a name from, and it changes under the button: read at the
    // moment the dialog opens, by mouse or by keyboard.
    const ctx = load(fakeApi());
    ctx.document.getElementById('add-input').value = ' rx.example:8080 ';
    const key = ctx.document.getElementById('add-form').children
        .find((n) => n.has && n.has('key-btn'));
    assert.ok(key, 'no key in the address form');
    key.click();
    assert.ok(dialog(ctx).textContent.includes('rx.example:8080'), dialog(ctx).textContent);
});

ta('a saved receiver does not resend a password it already has', async () => {
    // Its connect is by id; the password is in the store, not in the page.
    const api = fakeApi();
    const ctx = load(api);
    ctx.connectButton({ id: 'abc', running: false }, null).click();
    await new Promise(setImmediate);
    const sent = api.calls.find((c) => c[0] === 'connect');
    assert.strictEqual(sent[1].password, undefined);
    assert.strictEqual(sent[1].id, 'abc');
});

// --- the tabs -----------------------------------------------------------------------

// Everything the startup sequence awaits is an already-resolved promise, so one
// turn of the macrotask queue drains the whole chain — including the map build,
// which fails on the stub document's missing `head` and is caught.
const settled = () => new Promise(setImmediate);

const tabOpen = (ctx) => ['saved', 'lan', 'dir']
    .find((tab) => !ctx.document.getElementById(`panel-${tab}`).hidden) || null;

ta('with nothing saved the page opens on the public directory', async () => {
    // Which is the only tab that can have anything in it for a new install —
    // opening on an empty saved list would be opening on an empty page.
    const ctx = load(fakeApi());
    await settled();
    assert.strictEqual(tabOpen(ctx), 'dir');
});

ta('with something saved it opens there instead', async () => {
    const ctx = load(fakeApi({ saved: async () => [{ ...SAVED }] }));
    await settled();
    assert.strictEqual(tabOpen(ctx), 'saved');
});

ta('and a tab chosen last time beats both', async () => {
    const ctx = load(fakeApi({
        saved: async () => [{ ...SAVED }],
        chooser: async () => ({ tab: 'lan' }),
    }));
    await settled();
    assert.strictEqual(tabOpen(ctx), 'lan');
});

ta('choosing a tab shows one panel, and is remembered', async () => {
    const api = fakeApi();
    const ctx = load(api);
    await settled();
    ctx.document.getElementById('tab-saved').click();
    assert.strictEqual(tabOpen(ctx), 'saved');
    assert.ok(ctx.document.getElementById('tab-saved').has('active'));
    assert.ok(!ctx.document.getElementById('tab-dir').has('active'));
    // Field by field rather than deepStrictEqual: the patch was built inside the
    // vm and carries that realm's Object prototype, which is not this one's.
    const [, patch] = api.calls.filter((c) => c[0] === 'setChooser').pop();
    assert.strictEqual(patch.tab, 'saved');
});

// --- where the operator says they are -----------------------------------------------

t('a location is a locator or a coordinate pair, and nothing else', () => {
    const ctx = load(fakeApi());
    // Centre of the subsquare, which is the only honest point in a 100-km box.
    const grid = ctx.parsePlace(' io91wm ');
    assert.ok(Math.abs(grid.lat - 51.5208) < 0.001, `lat ${grid.lat}`);
    assert.ok(Math.abs(grid.lon - -0.125) < 0.001, `lon ${grid.lon}`);
    assert.strictEqual(grid.label, 'IO91WM');

    // Comma, space, or both: a pair arrives from a map, a GPS and a config file
    // in three different shapes.
    for (const text of ['51.507, -0.128', '51.507,-0.128', '51.507 -0.128']) {
        const pair = ctx.parsePlace(text);
        assert.ok(pair, text);
        assert.strictEqual(pair.lat, 51.507);
        assert.strictEqual(pair.lon, -0.128);
    }

    for (const bad of ['', 'somewhere', '51.507', 'ZZ99', '95, 0', '0, 200', '51.5, x']) {
        assert.strictEqual(ctx.parsePlace(bad), null, `accepted "${bad}"`);
    }
});

// --- the public directory -----------------------------------------------------------

const HERE = { lat: 51.5, lon: -0.12, city: 'London', country: 'UK', source: 'geoip' };

// Fresh conditions, or the badges and the SNR sort read as absent — which is
// exactly what a fixture with a hardcoded date would test by accident.
const fresh = () => new Date().toISOString();

const DIR = [
    {
        uuid: 'far', callsign: 'VK2ABC', name: 'Sydney loop', location: 'Sydney, Australia',
        host: 'vk2.example', port: 443, tls: true, lat: -33.87, lon: 151.21,
        countryCode: 'au', online: true, availableClients: 2, maxClients: 8, snr: 20,
        avgBandSnr: 25, conditionsAt: fresh(),
        bandConditions: { '20m': 25, '40m': 8, '10m': 2 },
    },
    {
        uuid: 'near', callsign: 'G4XYZ', name: 'Woking dipole', location: 'Woking, UK',
        host: 'g4xyz.example', port: 443, tls: true, lat: 51.32, lon: -0.56,
        countryCode: 'gb', online: true, availableClients: 0, maxClients: 4, snr: 12,
        avgBandSnr: 9, conditionsAt: fresh(), bandConditions: { '20m': 9 },
    },
    {
        uuid: 'dead', callsign: 'W1DED', name: 'Boston vertical', location: 'Boston, USA',
        host: 'w1ded.example', port: 443, tls: true, lat: 42.36, lon: -71.06,
        countryCode: 'us', online: false, availableClients: 8, maxClients: 8, snr: 40,
        avgBandSnr: 40, conditionsAt: fresh(), bandConditions: { '20m': 40 },
    },
];

const callsigns = (ctx) => ctx.document.getElementById('dir-list').children
    .map((row) => row.find((n) => n.has('call')).textContent);

const dirApi = (overrides) => fakeApi({ directory: async () => DIR.map((r) => ({ ...r })), ...overrides });

ta('the directory sorts by distance once it knows where you are', async () => {
    const ctx = load(dirApi({ home: async () => HERE }));
    await settled();
    // Woking before Sydney, and the offline one last however good it sounds.
    assert.deepStrictEqual(callsigns(ctx), ['G4XYZ', 'VK2ABC', 'W1DED']);
    assert.ok(ctx.document.getElementById('dir-sort-distance').has('active'));
});

ta('and by conditions when it does not', async () => {
    // Distance is not a sort that can quietly do nothing: with no position the
    // button is disabled and the list falls back to what it can measure.
    const ctx = load(dirApi());
    await settled();
    assert.deepStrictEqual(callsigns(ctx), ['VK2ABC', 'G4XYZ', 'W1DED']);
    assert.strictEqual(ctx.document.getElementById('dir-sort-distance').disabled, true);
    assert.ok(ctx.document.getElementById('dir-sort-snr').has('active'));
});

ta('free slots is a different question from a good signal', async () => {
    const ctx = load(dirApi());
    await settled();
    ctx.document.getElementById('dir-sort-listeners').click();
    // The full one sinks even though it is nearer and hearing well enough.
    assert.deepStrictEqual(callsigns(ctx), ['VK2ABC', 'G4XYZ', 'W1DED']);
    assert.strictEqual(callsigns(ctx).indexOf('G4XYZ'), 1);
});

ta('the filter reads places and countries, not just callsigns', async () => {
    const ctx = load(dirApi({ home: async () => HERE }));
    await settled();
    const box = ctx.document.getElementById('dir-filter');
    box.value = 'sydney';
    box.dispatch('input');
    assert.deepStrictEqual(callsigns(ctx), ['VK2ABC']);
    assert.match(ctx.document.getElementById('dir-status').textContent, /1 of 3/);
});

ta('a row carries distance, free slots and the bands worth trying', async () => {
    const ctx = load(dirApi({ home: async () => HERE }));
    await settled();
    const row = ctx.document.getElementById('dir-list').children[0];   // G4XYZ, nearest
    assert.match(row.find((n) => n.has('drow-meta')).textContent, /Woking, UK/);
    // ~36 km from the fixture's home; the exact figure is the haversine's.
    assert.match(row.find((n) => n.has('drow-meta')).textContent, /\d+ km/);
    const users = row.find((n) => n.has('users'));
    assert.strictEqual(users.textContent, '0/4');
    assert.ok(users.has('full'), 'no free slots is worth seeing before connecting');
    // 20m at 9 dB is fair and shown; nothing else on that receiver clears it.
    const bands = row.find((n) => n.has('bands')).children.map((b) => b.textContent);
    assert.deepStrictEqual(bands, ['20']);
});

ta('stale conditions are not drawn as conditions', async () => {
    // An instance that stopped reporting an hour ago is not a receiver hearing
    // 40 dB on 20m; it is a receiver nobody has heard from.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const ctx = load(fakeApi({
        directory: async () => [{ ...DIR[0], conditionsAt: old }],
    }));
    await settled();
    const row = ctx.document.getElementById('dir-list').children[0];
    assert.deepStrictEqual(row.find((n) => n.has('bands')).children, []);
    assert.strictEqual(row.find((n) => n.has('badge') && !n.has('users')), null);
});

ta('a receiver picked from the list connects with everything it needs', async () => {
    const api = dirApi();
    const ctx = load(api);
    await settled();
    const row = ctx.document.getElementById('dir-list').children[0];
    button(row, 'Connect').click();
    await settled();
    const sent = api.calls.find((c) => c[0] === 'connect')[1];
    assert.strictEqual(sent.host, 'vk2.example');
    assert.strictEqual(sent.port, 443);
    assert.strictEqual(sent.tls, true);
    // And not an id: a directory row's uuid is the directory's, not the store's,
    // and main.js reads `id` as "already saved under this one".
    assert.strictEqual(sent.id, undefined);
});

ta('receivers the directory knows nothing about still sort somewhere', async () => {
    // Two rows both missing the thing being sorted on must compare equal. The
    // obvious sentinel is Infinity, and Infinity - Infinity is NaN, which sorts
    // arbitrarily — and "no position" and "stale conditions" are both ordinary.
    const blank = (uuid) => ({
        uuid, callsign: `Q${uuid}`, name: 'Nothing known', location: '',
        host: `${uuid}.example`, port: 443, tls: true, lat: null, lon: null,
        online: true, availableClients: 1, maxClients: 2, snr: 0,
        avgBandSnr: null, bandConditions: null, conditionsAt: '',
    });
    const ctx = load(fakeApi({
        directory: async () => [blank('a'), blank('b'), blank('c'), ...DIR.map((r) => ({ ...r }))],
        home: async () => HERE,
    }));
    await settled();
    assert.deepStrictEqual(callsigns(ctx), ['G4XYZ', 'VK2ABC', 'Qa', 'Qb', 'Qc', 'W1DED']);
    ctx.document.getElementById('dir-sort-snr').click();
    assert.deepStrictEqual(callsigns(ctx), ['VK2ABC', 'G4XYZ', 'Qa', 'Qb', 'Qc', 'W1DED']);
});

ta('typing a location saves it and the list starts measuring from it', async () => {
    // The one that matters here: GeoIP is often wrong by a county and sometimes
    // by a country, and a distance column measured from the wrong place is worse
    // than no distance column.
    let stored = null;
    const api = dirApi({
        setChooser: async (patch) => {
            if ('home' in patch) stored = patch.home;
            return patch;
        },
        home: async () => (stored ? { ...stored, source: 'manual' } : null),
    });
    const ctx = load(api);
    await settled();
    assert.strictEqual(ctx.document.getElementById('dir-sort-distance').disabled, true);

    ctx.document.getElementById('home-set').click();
    text(dialog(ctx)).value = 'IO91wm';
    button(dialog(ctx), 'Save').click();
    await settled();

    assert.ok(stored, 'nothing was stored');
    assert.strictEqual(stored.label, 'IO91WM');
    assert.strictEqual(dialog(ctx), null, 'and the dialog is gone');
    assert.match(ctx.document.getElementById('home-status').textContent, /IO91WM/);
    assert.strictEqual(ctx.document.getElementById('dir-sort-distance').disabled, false);
    assert.deepStrictEqual(callsigns(ctx), ['G4XYZ', 'VK2ABC', 'W1DED'], 'and is sorted by it');
});

ta('a location that is not one is refused, and nothing is saved', async () => {
    const api = dirApi();
    const ctx = load(api);
    await settled();
    api.calls.length = 0;
    ctx.document.getElementById('home-set').click();
    text(dialog(ctx)).value = 'somewhere near Woking';
    button(dialog(ctx), 'Save').click();
    await settled();
    assert.ok(dialog(ctx), 'the dialog stays open');
    assert.match(dialog(ctx).find((n) => n.has('modal-note')).textContent, /IO91wm/);
    assert.strictEqual(api.calls.filter((c) => c[0] === 'setChooser').length, 0);
});

// --- the map ------------------------------------------------------------------------

const drawn = (ctx, call) => ctx.log.filter((l) => l[0] === call);

ta('the view is fitted to every receiver and to you', async () => {
    // Not centred on one of them at a guessed zoom: the map is next to a list of
    // the same receivers, and one that opens without some of them on it reads as
    // a map of a different set.
    const ctx = load(dirApi({ home: async () => HERE }), { leaflet: true });
    await settled();
    const [fit] = drawn(ctx, 'fitBounds');
    assert.ok(fit, 'never fitted');
    assert.strictEqual(fit[1].length, 4, 'three receivers and the operator');
    // Element by element: the array was built inside the vm and carries that
    // realm's Array prototype, which deepStrictEqual counts as a difference.
    assert.strictEqual(fit[1][3][0], HERE.lat, 'the operator is a corner of it');
    assert.strictEqual(fit[1][3][1], HERE.lon);
    assert.ok(fit[2].maxZoom, 'and it will not fly to a rooftop for a single pin');
});

ta('and refitted when the set changes, but not otherwise', async () => {
    // A refit on every minute's refresh would drag the map back from wherever it
    // had been panned to; never refitting would leave a filtered list beside a
    // map of everything.
    const ctx = load(dirApi({ home: async () => HERE }), { leaflet: true });
    await settled();
    assert.strictEqual(drawn(ctx, 'fitBounds').length, 1);

    ctx.renderDirectory();
    await settled();
    assert.strictEqual(drawn(ctx, 'fitBounds').length, 1, 'the same pins refitted');

    const box = ctx.document.getElementById('dir-filter');
    box.value = 'sydney';
    box.dispatch('input');
    await settled();
    const fits = drawn(ctx, 'fitBounds');
    assert.strictEqual(fits.length, 2, 'a filter did not refit');
    assert.strictEqual(fits[1][1].length, 2, 'the one left, and you');
});

ta('two receivers at one address are both clickable', async () => {
    // Directory entries do share coordinates — a site with two radios, or an
    // operator who gave both instances the same position. Drawn at one point,
    // the second is a pin nobody can reach.
    const twin = { ...DIR[1], uuid: 'twin', callsign: 'G4XYZ2' };
    const ctx = load(fakeApi({
        directory: async () => [{ ...DIR[1] }, twin],
    }), { leaflet: true });
    await settled();
    const rows = ctx.document.getElementById('dir-list').children;
    rows[0].dispatch('click');
    const first = drawn(ctx, 'setView').pop();
    rows[1].dispatch('click');
    const second = drawn(ctx, 'setView').pop();
    assert.notDeepStrictEqual(first[1], second[1], 'both pins are at the same point');
});

ta('picking a receiver rings its pin and draws the path to it', async () => {
    const ctx = load(dirApi({ home: async () => HERE }), { leaflet: true });
    await settled();
    const rows = ctx.document.getElementById('dir-list').children;
    rows[0].dispatch('click');

    const lit = drawn(ctx, 'setIcon').filter((l) => l[2].includes('pin--selected'));
    assert.strictEqual(lit.length, 1, 'one pin lit');
    // A curve, because that is the path — a straight line on a Mercator map
    // between two distant points is not where the signal went.
    const [path] = drawn(ctx, 'polyline');
    assert.ok(path, 'no path drawn');
    assert.ok(path[1] > 2, `a great circle, not a straight line (${path[1]} points)`);

    rows[1].dispatch('click');
    const icons = drawn(ctx, 'setIcon');
    assert.strictEqual(icons.filter((l) => l[2].includes('pin--selected')).length, 2);
    assert.ok(!icons[icons.length - 2][2].includes('pin--selected'), 'and the first is put out');
});

ta('hovering a pin says what it is, without buttons it cannot reach', async () => {
    // A tooltip goes as the pointer leaves the pin, so Connect on one would be a
    // button nobody can get to. The facts are the point of the hover; the buttons
    // are the point of the click.
    const ctx = load(dirApi({ home: async () => HERE }), { leaflet: true });
    await settled();
    const pin = [...ctx.window.L.layers].find((l) => l.tooltip);
    assert.ok(pin, 'no pin bound a tooltip');
    const said = pin.tooltip.textContent;
    assert.match(said, /km away/, 'the hover card carries the distance');
    assert.match(said, /slots free/);
    assert.strictEqual(pin.tooltip.find((n) => n.tagName === 'BUTTON'), null, 'and no buttons');
    assert.ok(pin.popup.find((n) => n.tagName === 'BUTTON'), 'which the click card does have');

    // Both at once would be the same card drawn twice, one over the other.
    pin.fire('popupopen');
    assert.ok(drawn(ctx, 'closeTooltip').length, 'the tooltip stayed under the popup');
});

ta("Leaflet's stylesheet goes in ahead of the page's own", async () => {
    // Not a nicety. chooser.css overrides leaflet.css at equal specificity — the
    // popup colours, the zoom buttons, and the font-family on .leaflet-container
    // that everything inside the map inherits, flag face included. Equal
    // specificity is settled by document order, so a sheet appended after ours
    // silently wins all of it: white popups, and flags back to letters in boxes
    // on Windows.
    const ctx = load(dirApi(), { leaflet: true });
    await settled();
    const [first] = ctx.document.head.order;
    assert.ok(first, 'nothing was loaded');
    assert.strictEqual(first.rel, 'stylesheet', 'the stylesheet is not first');
    assert.match(first.href, /leaflet\.css$/);
});

ta('a tab nobody has opened does not fetch Leaflet', async () => {
    // The directory list loads whichever tab the page opened on, so the map tab
    // is instant when it is reached — but drawing it while the panel is shut
    // costs 150 KB for a tab that may never be opened, and there is nothing to
    // draw on either way.
    const ctx = load(dirApi({ saved: async () => [{ ...SAVED }] }), { leaflet: true });
    await settled();
    assert.strictEqual(tabOpen(ctx), 'saved');
    assert.strictEqual(drawn(ctx, 'map').length, 0, 'a map was built for a shut tab');
    assert.ok(callsigns(ctx).length, 'though the list behind it is ready');

    ctx.document.getElementById('tab-dir').click();
    await settled();
    assert.strictEqual(drawn(ctx, 'map').length, 1, 'and built when the tab is opened');
});

ta('a map built behind a shut tab is fitted when the tab is opened', async () => {
    // The bug this guards: a hidden panel measures as zero, and Leaflet's
    // getBoundsZoom subtracts the padding from that, divides by a negative and
    // takes its log — so the zoom comes back NaN and the map lands somewhere
    // arbitrary. Worse, it stayed there, because the fit had "happened".
    const ctx = load(dirApi({
        saved: async () => [{ ...SAVED }],
        chooser: async () => ({ tab: 'saved' }),
        home: async () => HERE,
    }), { leaflet: true });
    await settled();

    // Force the map into existence while its panel is shut, as an earlier
    // startup did by drawing the directory regardless of the tab.
    await ctx.ensureMap();
    await settled();
    assert.strictEqual(drawn(ctx, 'fitBounds').length, 0, 'fitted against a container of no size');

    ctx.document.getElementById('tab-dir').click();
    await settled();
    const fits = drawn(ctx, 'fitBounds');
    assert.strictEqual(fits.length, 1, 'never fitted once the panel had a size');
    assert.strictEqual(fits[0][1].length, 4, 'and to every pin, plus you');
});

ta('hovering a row raises its pin, and lets go of it', async () => {
    // Which dot is this row? — the question a map beside a list exists to
    // answer, and hunting the pins for the one that says "Woking, UK" is the
    // work it was supposed to save.
    const ctx = load(dirApi({ home: async () => HERE }), { leaflet: true });
    await settled();
    const rows = ctx.document.getElementById('dir-list').children;
    // Counted from here: the map sets a view of its own while it is being built.
    const moves = drawn(ctx, 'setView').length;

    rows[0].dispatch('mouseenter');
    assert.strictEqual(drawn(ctx, 'openTooltip').length, 1, 'no pin raised');

    rows[0].dispatch('mouseleave');
    assert.strictEqual(drawn(ctx, 'closeTooltip').length, 1, 'and it stayed up after the pointer left');

    // Hovering is not a reason to move the map — a pointer crossing the list on
    // its way somewhere else would drag the view through half the world.
    assert.strictEqual(drawn(ctx, 'setView').length, moves);

    // A receiver the directory has no position for has no pin to raise, and
    // hovering its row is not an error.
    const bare = load(fakeApi({
        directory: async () => [{ ...DIR[0], lat: null, lon: null }],
    }), { leaflet: true });
    await settled();
    bare.document.getElementById('dir-list').children[0].dispatch('mouseenter');
    assert.strictEqual(drawn(bare, 'openTooltip').length, 0);
});

ta('a callsign from the directory cannot become markup on a pin', async () => {
    // A marker icon is a string of HTML, and every callsign on it comes off the
    // wire. Built from a node and serialised, so the escaping is the DOM's.
    const ctx = load(fakeApi({
        directory: async () => [{ ...DIR[0], callsign: '<img src=x onerror=alert(1)>' }],
    }), { leaflet: true });
    await settled();
    ctx.document.getElementById('dir-list').children[0].dispatch('click');
    const [icon] = drawn(ctx, 'setIcon');
    assert.ok(icon[2].includes('&lt;img'), icon[2]);
    assert.ok(!icon[2].includes('<img'), 'unescaped markup reached the icon');
});

ta('no Leaflet is a missing map, not a missing directory', async () => {
    // What a checkout that has not run build.sh gets — and what the stub
    // document reproduces, having no head to append a script to.
    const ctx = load(dirApi());
    await settled();
    assert.strictEqual(ctx.document.getElementById('dir-map').hidden, true);
    assert.strictEqual(ctx.document.getElementById('map-fallback').hidden, false);
    assert.strictEqual(callsigns(ctx).length, 3, 'and the list is all still there');
});

// Printed on the way out, so the async cases above are counted whichever order
// they settle in — the same shape as wsserver.test.js.
process.on('exit', () => console.log(`\n${pass} passed`));
