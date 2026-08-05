// The seams where this extension and the receiver can drift apart silently.
//
// Three of them, and none is caught by running either side on its own:
//
//   * The protocol constants are duplicated in content_script.js, because a
//     content script cannot import from the page's bundle. Duplication is fine;
//     duplication that quietly diverges is not.
//   * The background script and the popup send `cmd:*` messages that only the
//     content script implements. One renamed and nothing complains — the button
//     just stops working.
//   * The manifest is the thing that actually ships.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');
const V2 = path.join(__dirname, '..', '..', '..', 'static', 'v2', 'src', 'bridge');

const read = (p) => fs.readFileSync(p, 'utf8');

// For the "does this file still reach for X" checks: a comment explaining what
// was removed must not read as the thing itself.
const code = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const content = read(path.join(EXT, 'content_script.js'));
const background = read(path.join(EXT, 'background.js'));
const popup = read(path.join(EXT, 'popup.js'));
const manifest = JSON.parse(read(path.join(EXT, 'manifest.json')));

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- the duplicated constants ------------------------------------------------

t('the event names match the ones the page dispatches', () => {
    const protocol = read(path.join(V2, 'protocol.js'));
    for (const name of ['EVENT_TO_PAGE', 'EVENT_FROM_PAGE']) {
        const inPage = protocol.match(new RegExp(`${name} = '([^']+)'`));
        const inExt = content.match(new RegExp(`${name} = '([^']+)'`));
        assert.ok(inPage && inExt, `${name} not found in both`);
        assert.strictEqual(inExt[1], inPage[1], name);
    }
});

t('the protocol version matches', () => {
    const protocol = read(path.join(V2, 'protocol.js'));
    const inPage = protocol.match(/PROTOCOL = (\d+)/);
    const inExt = content.match(/PROTOCOL = (\d+)/);
    assert.strictEqual(inExt[1], inPage[1]);
});

t('the API major the extension speaks is one the page still offers', () => {
    const protocol = read(path.join(V2, 'protocol.js'));
    const pageMajor = protocol.match(/API_VERSION = \{ major: (\d+)/)[1];
    const extMajor = content.match(/API_MAJOR = (\d+)/)[1];
    // The extension refuses a page whose major differs, so a bump on the page
    // side without one here means every tab silently stops registering.
    assert.strictEqual(extMajor, pageMajor);
});

t('every topic the extension subscribes to is one the page publishes', () => {
    const protocol = read(path.join(V2, 'protocol.js'));
    const live = protocol.match(/LIVE_TOPICS = \[([^\]]+)\]/)[1]
        .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    const asked = new Set();
    for (const m of content.matchAll(/topics: \[([^\]]+)\]/g)) {
        for (const name of m[1].split(',')) asked.add(name.trim().replace(/'/g, ''));
    }
    assert.ok(asked.size >= 4, `only found ${asked.size} subscriptions`);
    for (const topic of asked) assert.ok(live.includes(topic), `no such topic: ${topic}`);
});

t('every command the extension sends is one the page has', () => {
    const commands = read(path.join(V2, 'commands.js'));
    const known = new Set(
        [...commands.matchAll(/^ {4}(\w+)\(args, ctx\)/gm)].map((m) => m[1]),
    );
    assert.ok(known.size >= 9, `only found ${known.size} commands`);
    const used = [...content.matchAll(/name: '(\w+)'/g)].map((m) => m[1]);
    assert.ok(used.length >= 4, `only found ${used.length} command sends`);
    for (const name of used) assert.ok(known.has(name), `no such command: ${name}`);
});

// --- the extension's own seam ------------------------------------------------

t('every cmd: message the extension sends itself is handled', () => {
    // A renamed command is otherwise silent: the button stops working and
    // nothing anywhere says so.
    const sent = new Set([
        ...[...background.matchAll(/type: '(cmd:\w+)'/g)].map((m) => m[1]),
        ...[...popup.matchAll(/type: '(cmd:\w+)'/g)].map((m) => m[1]),
    ]);
    const handled = new Set(
        [...content.matchAll(/'(cmd:\w+)'/g)].map((m) => m[1]),
    );
    assert.ok(sent.size >= 5, `only found ${sent.size} commands being sent`);
    for (const name of sent) assert.ok(handled.has(name), `${name} is sent but not handled`);
});

t('nothing reaches for v1 internals any more', () => {
    // The old page-world script and everything it needed. If one of these comes
    // back, the extension has grown a dependency on the interface it left.
    for (const [name, src] of [['content_script', code(content)], ['background', code(background)],
        ['popup', code(popup)]]) {
        for (const banned of ['radioAPI', 'userSessionID', 'autoTune', 'audio-start-overlay',
            'currentBasebandPower', 'setFrequencyInputValue', 'skipEdgeDetection']) {
            assert.ok(!src.includes(banned), `${name}.js still refers to ${banned}`);
        }
    }
});

t('the content script injects nothing into the page', () => {
    // The v2 API is a message channel; needing page-world access again would
    // mean something has gone wrong with it.
    const src = code(content);
    assert.ok(!/createElement\('script'\)/.test(src), 'still injecting a script element');
    assert.ok(!/postMessage/.test(src), 'still using postMessage');
    assert.ok(!/setInterval|setTimeout/.test(src), 'still polling');
});

t('nothing logs on a timer', () => {
    // The content script runs on every page in the browser and the background
    // polls flrig ten times a second. Neither may narrate what it is doing:
    // logging belongs on a transition or a failure, not on a tick.
    const src = code(background);
    for (const m of src.matchAll(/console\.log\(([^;]*)\)/g)) {
        assert.ok(!/pollFlrig|debounce|matchingTab|cooldown|writing (freq|mode)/.test(m[1]),
            'a per-poll log is back: ' + m[1].slice(0, 60));
    }
    // One line when the content script attaches, and nothing else.
    assert.strictEqual((code(content).match(/console\.log/g) || []).length, 1);
});

// --- what ships --------------------------------------------------------------

t('the manifest and the package agree on the version', () => {
    const pkg = JSON.parse(read(path.join(__dirname, '..', 'package.json')));
    assert.strictEqual(manifest.version, pkg.version);
});

t('the content script is the only thing injected, on every page, at idle', () => {
    assert.strictEqual(manifest.content_scripts.length, 1);
    const cs = manifest.content_scripts[0];
    assert.deepStrictEqual(cs.js, ['content_script.js'], 'the page-world script should be gone');
    assert.strictEqual(cs.run_at, 'document_idle');
    assert.strictEqual(cs.all_frames, false);
});

t('no page-world declaration survives', () => {
    // Firefox never needed one, but a copy of the Chrome manifest would bring
    // it across, and it would be injecting a file that no longer exists.
    assert.ok(!JSON.stringify(manifest).includes('page_world'), 'page_world is still declared');
    assert.ok(!fs.existsSync(path.join(EXT, 'page_world.js')), 'page_world.js is still present');
});

console.log(`\n${pass} ok`);
