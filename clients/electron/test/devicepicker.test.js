// The device picker page (serial/), against a DOM small enough to read.
//
// One page now picks two kinds of device: a serial port, as it always has, and
// a HID device — the RC-28 — for WebHID. The main process says which in
// `info().kind`, and what is pinned here is that the page listens: an RC-28
// picker that still says "No serial ports found" sends somebody looking for a
// COM port that does not exist. And that the row it draws for a HID device —
// no path, only USB IDs — is one that can be picked and connected.
//
// Also, as for the chooser: every element the script reaches for by id has to
// exist in index.html, or the page throws on open and the request hangs.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describeHidDevice } = require('../hid.js');

let pass = 0;
const results = [];
const ta = (name, fn) => results.push([name, fn]);

const DIR = path.join(__dirname, '..', 'serial');
const SOURCE = fs.readFileSync(path.join(DIR, 'serial.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

// --- the smallest document that runs it -------------------------------------

class Node {
    constructor(tag, doc) {
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.childNodes = [];
        this.attributes = {};
        this.listeners = new Map();
        this.dataset = {};
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.id = '';
        this._text = '';
    }
    get textContent() {
        return this._text + this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) { this._text = String(v); this.children = []; this.childNodes = []; }
    appendChild(n) {
        this.childNodes.push(n);
        if (n instanceof Node) this.children.push(n);
        return n;
    }
    replaceChildren(...nodes) {
        this.children = [];
        this.childNodes = [];
        this._text = '';
        for (const n of nodes) this.appendChild(n);
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }
    dispatch(type, extra = {}) {
        const event = { type, target: this, preventDefault() {}, ...extra };
        for (const fn of this.listeners.get(type) || []) fn(event);
    }
    click() { this.dispatch('click'); }
    focus() { this.ownerDocument.activeElement = this; }
    scrollIntoView() {}
}

function makeDocument() {
    const doc = { title: '', activeElement: null, byId: new Map() };
    doc.body = new Node('body', doc);
    const listeners = [];
    // Only the ids index.html actually has, so a script reaching for one that
    // is not there finds null, exactly as it would in the window.
    for (const [, tag, id] of MARKUP.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)) {
        const node = new Node(tag, doc);
        node.id = id;
        doc.byId.set(id, node);
    }
    doc.getElementById = (id) => doc.byId.get(id) || null;
    doc.createElement = (tag) => new Node(tag, doc);
    doc.createTextNode = (text) => ({ textContent: String(text) });
    doc.addEventListener = (type, fn) => listeners.push([type, fn]);
    return doc;
}

// Opens the page against `info` and resolves once its startup has run.
async function open(info) {
    const document = makeDocument();
    const chosen = [];
    let pushPorts = null;
    const api = {
        info: async () => info,
        choose: (id) => chosen.push(id),
        onPorts: (cb) => { pushPorts = cb; },
    };
    const sandbox = { window: { serialPicker: api }, document, console };
    vm.runInNewContext(SOURCE, sandbox, { filename: 'serial.js' });
    // The startup is an async IIFE awaiting info(); let it finish.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const $ = (id) => document.getElementById(id);
    return { document, chosen, $, push: (list) => pushPorts(list) };
}

const RC28 = describeHidDevice({ deviceId: '7', name: 'RC-28 REMOTE ENCODER', vendorId: 0x0C26, productId: 0x001E });
const FLEX = {
    portId: 'p1', portName: '/dev/ttyUSB0', displayName: 'FlexControl',
    vendorId: '2192', productId: '0010', serialNumber: '',
};

// --- the markup -------------------------------------------------------------

ta('every element the script reaches for by id exists in index.html', async () => {
    const ids = new Set([...MARKUP.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, id] of SOURCE.matchAll(/getElementById\('([^']+)'\)/g)) {
        assert.ok(ids.has(id), `serial.js reaches for #${id}, which index.html does not have`);
    }
});

// --- serial, as before ------------------------------------------------------

ta('a serial picker still says serial port', async () => {
    const { $, document } = await open({ ports: [], origin: '', kind: 'serial' });
    assert.strictEqual($('heading').textContent, 'Select a serial port');
    assert.strictEqual(document.title, 'Select serial port');
    assert.strictEqual($('empty-title').textContent, 'No serial ports found');
});

ta('an older main process that sends no kind gets the serial words', async () => {
    const { $ } = await open({ ports: [], origin: '' });
    assert.strictEqual($('heading').textContent, 'Select a serial port');
});

ta('a serial port is still listed and connected as before', async () => {
    const { $, chosen } = await open({ ports: [FLEX], origin: 'rx.example', kind: 'serial' });
    const rows = $('port-list').children;
    assert.strictEqual(rows.length, 1);
    assert.match(rows[0].textContent, /FlexControl/);
    assert.match(rows[0].textContent, /\/dev\/ttyUSB0/);
    $('connect').click();
    assert.deepStrictEqual(chosen, ['p1']);
});

// --- HID --------------------------------------------------------------------

ta('a HID picker says USB device, not serial port', async () => {
    const { $, document } = await open({ ports: [RC28], origin: 'rx.example', kind: 'hid' });
    assert.strictEqual($('heading').textContent, 'Select a USB device');
    assert.strictEqual(document.title, 'Select USB device');
    assert.doesNotMatch($('subtitle').textContent, /serial/i);
    assert.match($('subtitle').textContent, /rx\.example wants to connect/);
});

ta('the RC-28 row shows its name and USB IDs, with no empty path', async () => {
    const { $ } = await open({ ports: [RC28], origin: '', kind: 'hid' });
    const row = $('port-list').children[0];
    assert.match(row.textContent, /RC-28 REMOTE ENCODER/);
    assert.match(row.textContent, /USB 0c26:001e/);
    // A HID device has no path; the separator for a missing one would show as
    // a stray "·" at the start of the second line.
    assert.doesNotMatch(row.textContent, /ENCODER·/);
});

ta('the RC-28 is armed and Connect hands its device id back', async () => {
    const { $, chosen } = await open({ ports: [RC28], origin: '', kind: 'hid' });
    assert.strictEqual($('connect').disabled, false, 'the only row is armed for the keyboard');
    $('connect').click();
    assert.deepStrictEqual(chosen, ['7']);
});

ta('an empty HID picker points at the plug and the udev rule', async () => {
    const { $ } = await open({ ports: [], origin: '', kind: 'hid' });
    assert.strictEqual($('port-empty').hidden, false);
    assert.strictEqual($('empty-title').textContent, 'No supported USB device found');
    assert.match($('empty-body').textContent, /RC-28/);
    assert.match($('empty-body').textContent, /udev/);
    assert.strictEqual($('connect').disabled, true);
});

ta('an RC-28 plugged in while the picker is open appears in it', async () => {
    const { $, push, chosen } = await open({ ports: [], origin: '', kind: 'hid' });
    push([RC28]);
    assert.strictEqual($('port-list').children.length, 1);
    assert.strictEqual($('port-empty').hidden, true);
    $('connect').click();
    assert.deepStrictEqual(chosen, ['7']);
});

ta('cancel answers with no device', async () => {
    const { $, chosen } = await open({ ports: [RC28], origin: '', kind: 'hid' });
    $('cancel').click();
    assert.deepStrictEqual(chosen, ['']);
});

(async () => {
    for (const [name, fn] of results) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\nall ${pass} device picker tests passed`);
})();
