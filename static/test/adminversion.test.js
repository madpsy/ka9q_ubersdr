// admin.html — the "update available" decision in the monitor and the version footer.
//
// The server compares versions semantically (version_checker.go: IsNewerVersionAvailable)
// and publishes the answer as update_available on /admin/version-health. The page used to
// throw that away and re-decide with `currentVersion !== latestVersion`, so a build running
// ahead of what is published on GitHub — 0.1.66 local, 0.1.65 on main — was announced as
// "Software Update Available: Current 0.1.66 → Latest 0.1.65".
//
// admin.html is a plain browser page with no build step, so the functions under test are
// sliced out of the file that ships and run against a stub DOM. Slicing by the names they
// define means a rename fails loudly here rather than quietly testing nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const tAsync = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

/** Slice one brace-balanced declaration, starting at `opener`, out of `src`. */
function sliceBlock(src, opener, what) {
    const start = src.indexOf(opener);
    assert.ok(start >= 0, `${what}: "${opener}" not found`);
    const from = src.indexOf('{', start);
    assert.ok(from > 0, `${what}: no opening brace`);
    let depth = 0;
    let str = null;
    for (let i = from; i < src.length; i++) {
        const c = src[i];
        if (str) {
            if (c === '\\') { i++; continue; }
            if (c === str) str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { str = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`${what}: unbalanced braces`);
}

/** The inline <script> out of an HTML page. */
function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    return blocks.map((m) => m[1]).join('\n');
}

const ADMIN = inlineScript(path.join(STATIC, 'admin.html'));

// ── Stub DOM ─────────────────────────────────────────────────────────────────
// Only what the two functions touch: ids, styles, classes, innerHTML, and adding
// or removing the warning banner.

function makeDOM(ids) {
    const registry = new Map();

    const makeEl = (id) => {
        const classes = new Set();
        const el = {
            id: id || '',
            className: '',
            innerHTML: '',
            textContent: '',
            style: {},
            children: [],
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c),
            },
            appendChild(child) {
                this.children.push(child);
                child._parent = this;
                if (child.id) registry.set(child.id, child);
            },
            remove() {
                if (this._parent) {
                    this._parent.children = this._parent.children.filter((c) => c !== this);
                    this._parent = null;
                }
                if (this.id) registry.delete(this.id);
            },
        };
        return el;
    };

    for (const id of ids) registry.set(id, makeEl(id));

    return {
        registry,
        document: {
            getElementById: (id) => registry.get(id) || null,
            createElement: () => makeEl(''),
        },
    };
}

// =============================================================================
// renderSoftwareVersionHealth — the monitor tab's version card and banner
// =============================================================================

const RENDER_IDS = ['monitor-software-version', 'softwareVersionDisplay', 'systemHealthWarnings'];

function renderSandbox() {
    const dom = makeDOM(RENDER_IDS);
    const ctx = {
        document: dom.document,
        console,
        updateMonitorNav: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(
        sliceBlock(ADMIN, 'function renderSoftwareVersionHealth', 'renderSoftwareVersionHealth'),
        ctx,
    );
    ctx._dom = dom;
    ctx._status = () => {
        const html = dom.registry.get('softwareVersionDisplay').innerHTML;
        for (const s of ['Version check failed', 'Update available', 'Up to date', 'Unknown']) {
            if (html.includes(`>${s}</span>`)) return s;
        }
        throw new Error('no status text rendered');
    };
    ctx._banner = () => dom.registry.get('swVersionWarning') || null;
    return ctx;
}

// The regression: local build ahead of what is published.
t('monitor: running ahead of the published version is not an update', () => {
    const s = renderSandbox();
    s.renderSoftwareVersionHealth('0.1.66', '0.1.65', false, false);
    assert.strictEqual(s._status(), 'Up to date');
    assert.strictEqual(s._banner(), null, 'no update banner');
    assert.ok(!s._dom.registry.get('softwareVersionDisplay').innerHTML.includes('View Release Notes'));
});

t('monitor: a genuinely newer published version is an update', () => {
    const s = renderSandbox();
    s.renderSoftwareVersionHealth('0.1.66', '0.1.67', false, true);
    assert.strictEqual(s._status(), 'Update available');
    const banner = s._banner();
    assert.ok(banner, 'the warning banner is added');
    assert.ok(banner.innerHTML.includes('0.1.66'));
    assert.ok(banner.innerHTML.includes('0.1.67'));
    assert.strictEqual(s._dom.registry.get('systemHealthWarnings').style.display, 'block');
});

t('monitor: equal versions are up to date', () => {
    const s = renderSandbox();
    s.renderSoftwareVersionHealth('0.1.66', '0.1.66', false, false);
    assert.strictEqual(s._status(), 'Up to date');
    assert.strictEqual(s._banner(), null);
});

t('monitor: a failed check is reported as a failed check, not an update', () => {
    const s = renderSandbox();
    s.renderSoftwareVersionHealth('0.1.66', '', true, false);
    assert.strictEqual(s._status(), 'Version check failed');
    assert.strictEqual(s._banner(), null);
});

t('monitor: nothing known yet stays Unknown', () => {
    const s = renderSandbox();
    s.renderSoftwareVersionHealth('Unknown', 'Unknown', false, false);
    assert.strictEqual(s._status(), 'Unknown');
    assert.strictEqual(s._banner(), null);
});

t('monitor: the server has the last word — differing versions alone never warn', () => {
    // Anything other than an explicit update_available:true is not an update, whatever
    // the two version strings look like.
    for (const flag of [false, undefined, null, 0, '']) {
        const s = renderSandbox();
        s.renderSoftwareVersionHealth('0.1.66', '0.1.65', false, flag);
        assert.strictEqual(s._status(), 'Up to date', `flag ${JSON.stringify(flag)}`);
        assert.strictEqual(s._banner(), null, `flag ${JSON.stringify(flag)}`);
    }
});

t('monitor: a stale banner is cleared once the update is gone', () => {
    const s = renderSandbox();
    s.renderSoftwareVersionHealth('0.1.66', '0.1.67', false, true);
    assert.ok(s._banner(), 'banner present after the update is announced');
    // Next refresh, e.g. after the update landed or the checker corrected itself.
    s.renderSoftwareVersionHealth('0.1.67', '0.1.67', false, false);
    assert.strictEqual(s._banner(), null, 'banner removed');
    assert.strictEqual(s._dom.registry.get('systemHealthWarnings').children.length, 0);
});

t('monitor: the banner is not duplicated across refreshes', () => {
    const s = renderSandbox();
    s.renderSoftwareVersionHealth('0.1.66', '0.1.67', false, true);
    s.renderSoftwareVersionHealth('0.1.66', '0.1.67', false, true);
    assert.strictEqual(s._dom.registry.get('systemHealthWarnings').children.length, 1);
});

// The wiring: renderMonitorHealth must hand the server's verdict through. Without the
// fourth argument the function has nothing to go on and would silently never warn.
t('monitor: the health payload passes update_available through', () => {
    assert.ok(
        /renderSoftwareVersionHealth\(\s*sv\.current_version,\s*sv\.latest_version,\s*sv\.check_failed,\s*sv\.update_available\s*\)/.test(ADMIN),
        'renderSoftwareVersionHealth is not called with sv.update_available',
    );
});

// =============================================================================
// checkVersions — the version footer
// =============================================================================

const FOOTER_IDS = ['currentVersion', 'latestVersion', 'updateNotice', 'versionFooter'];

function footerSandbox(versionHealth) {
    const dom = makeDOM(FOOTER_IDS);
    const ctx = {
        document: dom.document,
        console,
        updateDecoderAnalyticsLinks: () => {},
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        authenticatedFetch: async () => ({ ok: true, json: async () => versionHealth }),
    };
    vm.createContext(ctx);
    vm.runInContext('var siteDescription = null;', ctx);
    vm.runInContext(sliceBlock(ADMIN, 'async function checkVersions', 'checkVersions'), ctx);
    ctx._dom = dom;
    return ctx;
}

const health = (over) => ({
    current_version: '0.1.66',
    latest_version: '0.1.65',
    update_available: false,
    check_enabled: true,
    check_failed: false,
    ...over,
});

(async () => {
    await tAsync('footer: running ahead of the published version shows no update notice', async () => {
        const s = footerSandbox(health());
        await s.checkVersions();
        assert.strictEqual(s._dom.registry.get('currentVersion').textContent, '0.1.66');
        assert.strictEqual(s._dom.registry.get('latestVersion').textContent, '0.1.65');
        assert.strictEqual(s._dom.registry.get('updateNotice').style.display, 'none');
        assert.ok(!s._dom.registry.get('latestVersion').classList.contains('version-update-available'));
        assert.strictEqual(s._dom.registry.get('versionFooter').style.display, 'flex');
    });

    await tAsync('footer: a newer published version shows the update notice', async () => {
        const s = footerSandbox(health({ latest_version: '0.1.67', update_available: true }));
        await s.checkVersions();
        assert.strictEqual(s._dom.registry.get('updateNotice').style.display, 'block');
        assert.ok(s._dom.registry.get('latestVersion').classList.contains('version-update-available'));
    });

    await tAsync('footer: a failed check says so instead of offering an update', async () => {
        const s = footerSandbox(health({ latest_version: '', check_failed: true }));
        await s.checkVersions();
        assert.strictEqual(s._dom.registry.get('latestVersion').textContent, 'Check failed');
        assert.strictEqual(s._dom.registry.get('updateNotice').style.display, 'none');
    });

    await tAsync('footer: version checking disabled says Disabled', async () => {
        const s = footerSandbox(health({ check_enabled: false, latest_version: '' }));
        await s.checkVersions();
        assert.strictEqual(s._dom.registry.get('latestVersion').textContent, 'Disabled');
    });

    console.log(`\n${pass} passed`);
})();
