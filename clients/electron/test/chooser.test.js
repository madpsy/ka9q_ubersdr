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
    };
}

/**
 * Loads chooser.js into a context. Its top-level function declarations land on
 * the context object, which is how the tests reach keyButton and describe.
 */
function load(api, { ids } = {}) {
    const document = makeDocument(ids || [...MARKUP.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const ctx = {
        document,
        window: { ubersdr: api },
        console: { log() {}, error() {} },
        setTimeout,
        clearTimeout,
    };
    ctx.globalThis = ctx;
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

// --- the page's own scaffolding -----------------------------------------------------

t('every element the script reaches for exists in the page', () => {
    // A renamed id fails at load in a way nothing else here would catch: the
    // page comes up and one control silently does nothing.
    const declared = new Set([...MARKUP.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = [...SOURCE.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(wanted.length > 5, 'found no lookups to check — has the script changed shape?');
    for (const id of new Set(wanted)) assert.ok(declared.has(id), `#${id} is not in index.html`);
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

// Printed on the way out, so the async cases above are counted whichever order
// they settle in — the same shape as wsserver.test.js.
process.on('exit', () => console.log(`\n${pass} passed`));
