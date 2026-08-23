// Custom panels, as far as the registry.
//
// The promise being pinned: a panel an operator enabled is a registry entry like
// any other — it lands in a dock, in the layout manager, in a phone's tab row,
// and it can float — while a manifest written by somebody else can never take
// the interface down with it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    PANELS, PANEL_BY_ID, SEEDED,
    panelEntry, panelEntries,
    cachedPanels, panelIds, panelVersion, refreshPanels, resetPanelCache,
    startPanelPolling, POLL_MS,
    PANEL_ICONS, panelIcon, iconName,
    GROUPS, SOLO, groupsFor, ungrouped,
} = require('./.build/custompanels.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const GOOD = 'x:aaaa-1111';
const MESSY = 'x:bbbb-2222';
const Stub = () => null;
const makeStub = () => Stub;

// --- the manifest, turned into an entry --------------------------------------

t('a well-formed manifest becomes the entry it describes', () => {
    const e = panelEntry(SEEDED[0], makeStub);
    assert.strictEqual(e.id, GOOD);
    assert.strictEqual(e.title, 'World clocks');
    assert.strictEqual(e.dock, 'right');
    assert.strictEqual(e.minimal, true);
    assert.strictEqual(e.weight, 2);
    assert.strictEqual(e.height, 180);
    assert.strictEqual(e.group, 'activity');
    assert.strictEqual(e.Component, Stub);
});

t('provenance is carried for the layout manager', () => {
    const e = panelEntry(SEEDED[0], makeStub);
    assert.strictEqual(e.custom.callsign, 'M9PSY');
    assert.strictEqual(e.custom.version, 3);
    assert.ok(e.custom.description.includes('places you work'));
});

t('every unusable field degrades rather than throwing', () => {
    // This runs before the first render. Anything that threw here would be a
    // white screen for the whole receiver over somebody else's typo.
    const e = panelEntry(SEEDED[1], makeStub);
    assert.strictEqual(e.dock, 'left', 'an unknown dock falls back');
    assert.strictEqual(e.title, MESSY, 'a missing title falls back to the id');
    assert.ok('icon' in e, 'an unknown icon name still produces an icon key');
    assert.ok(e.weight <= 4, `weight ${e.weight} was not clamped`);
    assert.ok(e.height >= 60, `height ${e.height} was not clamped`);
});

t('the icon names are a published contract, with a fallback in it', () => {
    // A manifest out on the collector names its icon by key, so these names
    // cannot be renamed without breaking published panels — and an unknown one
    // has to land somewhere rather than leaving a hole in the mobile tab row,
    // which is icons only.
    assert.ok(PANEL_ICONS.includes('Custom'), 'the fallback glyph exists');
    assert.ok(PANEL_ICONS.includes('Clock'), 'and the name the fixture uses');
    assert.ok(!PANEL_ICONS.includes('NotAnIconName'));
    assert.strictEqual(iconName('Clock'), 'Clock');
    assert.strictEqual(iconName('NotAnIconName'), 'Custom');

    // Inherited keys are not icons. `Icon[name]` alone would resolve these to
    // something off Object.prototype and hand React a non-component.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
        assert.strictEqual(iconName(name), 'Custom', `${name} resolved to something else`);
    }
    // And resolution must not throw on anything a manifest can hold.
    for (const name of [undefined, null, 42, '', {}, []]) {
        assert.strictEqual(iconName(name), 'Custom');
        panelIcon(name);
    }
});

t('nonsense in, null out — never an exception', () => {
    for (const bad of [null, undefined, 42, 'string', {}, { id: 5 }, { id: 'no-prefix' }]) {
        assert.strictEqual(panelEntry(bad, makeStub), null, `${JSON.stringify(bad)} produced an entry`);
    }
});

t('a manifest cannot claim a built-in id', () => {
    // PANEL_BY_ID is a map: a second entry would silently shadow the first, and
    // if the first were the Layout panel the way back would go with it.
    const taken = new Set(['receiver', 'layout']);
    const out = panelEntries([{ id: 'receiver' }, { id: 'layout' }, { id: 'x:ok' }], makeStub, taken);
    assert.deepStrictEqual(out.map((p) => p.id), ['x:ok']);
});

t('duplicate ids are dropped, not merged', () => {
    const out = panelEntries([{ id: 'x:dup' }, { id: 'x:dup' }], makeStub);
    assert.strictEqual(out.length, 1);
});

// --- the cache ---------------------------------------------------------------

t('the cache is read synchronously, before anything renders', () => {
    const ids = panelIds();
    assert.ok(ids.has(GOOD) && ids.has(MESSY));
    assert.strictEqual(cachedPanels().length, 2, 'and only the entries that are listings');
});

t('an entry that is not one of ours never reaches the registry', () => {
    for (const p of cachedPanels()) {
        assert.ok(typeof p === 'object' && p.id.startsWith('x:'), `${JSON.stringify(p)} survived`);
    }
});

// --- the registry ------------------------------------------------------------

t('an enabled panel is in the registry like any other', () => {
    const e = PANEL_BY_ID[GOOD];
    assert.ok(e, 'the panel is registered');
    assert.strictEqual(e.title, 'World clocks');
    assert.ok(PANELS.includes(e));
});

t('the panels that ship are untouched by it', () => {
    assert.ok(PANEL_BY_ID.receiver, 'the Receiver panel is still there');
    assert.ok(PANEL_BY_ID.layout, 'and so is the one that unhides the others');
    const builtInFirst = PANELS.findIndex((p) => p.id === GOOD);
    assert.ok(builtInFirst > 0, 'custom panels come last');
    assert.ok(PANELS.slice(0, builtInFirst).every((p) => !p.custom));
});

t('a custom entry is marked as one, which is what gates it', () => {
    assert.ok(PANEL_BY_ID[GOOD].custom, 'custom panels carry their provenance');
    assert.strictEqual(PANEL_BY_ID.receiver.custom, undefined, 'built-ins do not');
});

// --- the phone ---------------------------------------------------------------

t('a panel lands in the group its manifest names', () => {
    const groups = groupsFor(PANELS);
    const activity = groups.find((g) => g.id === 'activity');
    assert.ok(activity.items.some((p) => p.id === GOOD), 'the panel is in the group it asked for');
    assert.strictEqual(activity.items[activity.items.length - 1].id, GOOD,
        'and after the panels that ship, not among them');
});

t('an unknown group is a fallback, not a disappearance', () => {
    // The messy panel names a group that does not exist. It has to stay
    // reachable: a phone's tab row is the only way to a panel there.
    const groups = groupsFor(PANELS);
    const everywhere = groups.flatMap((g) => g.items.map((p) => p.id));
    assert.ok(everywhere.includes(MESSY), 'the panel is reachable on a phone');
    assert.ok(ungrouped(PANELS).some((p) => p.id === MESSY));
    assert.ok(!ungrouped(PANELS).some((p) => p.id === GOOD), 'one with a real group is not spare');
});

t('a manifest cannot claim the slot a phone opens on', () => {
    // SOLO is this interface's decision about the first thing under a thumb.
    const groups = groupsFor(PANELS);
    assert.ok(!GROUPS.some((g) => g.id === SOLO), 'SOLO is not a group to be claimed');
    for (const g of groups) {
        assert.ok(!g.items.some((p) => p.custom && p.id === SOLO));
    }
});

t('no panel appears in two groups', () => {
    const seen = new Set();
    for (const g of groupsFor(PANELS)) {
        for (const p of g.items) {
            assert.ok(!seen.has(p.id), `${p.id} is in more than one group`);
            seen.add(p.id);
        }
    }
});

// --- revalidation ------------------------------------------------------------

const withFetch = async (impl, fn) => {
    const saved = globalThis.fetch;
    globalThis.fetch = impl;
    try { await fn(); } finally { globalThis.fetch = saved; }
};

const reply = (status, body, etag) => async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => etag || null },
    json: async () => body,
});

(async () => {
    await ta('a fetch that fails leaves the cache alone', async () => {
        // The panels an operator enabled do not stop existing because one
        // request failed — and clearing them would take the layout entries with
        // them on the next load.
        resetPanelCache(SEEDED.slice(0, 1));
        await withFetch(async () => { throw new Error('offline'); }, async () => {
            await refreshPanels();
        });
        assert.strictEqual(cachedPanels().length, 1);
    });

    await ta('a 304 leaves the cache alone too', async () => {
        resetPanelCache(SEEDED.slice(0, 1));
        await withFetch(reply(304, null), async () => { await refreshPanels(); });
        assert.strictEqual(cachedPanels().length, 1);
    });

    await ta('an error status leaves the cache alone', async () => {
        resetPanelCache(SEEDED.slice(0, 1));
        await withFetch(reply(500, null), async () => { await refreshPanels(); });
        assert.strictEqual(cachedPanels().length, 1);
    });

    await ta('a 404 clears it — the receiver has answered', async () => {
        // Not a failed request: the receiver has said there is no such endpoint,
        // so there are no custom panels here. Keeping the list matters only when
        // it came from another receiver, which is exactly what the desktop and
        // mobile clients' shared settings do — and then the stale entry passes
        // the gate, the panel is drawn, and it says it could not be loaded on a
        // receiver that never had it. Permanently, because every later poll gets
        // the same 404 and kept the list too.
        resetPanelCache(SEEDED.slice(0, 1));
        await withFetch(reply(404, null), async () => { await refreshPanels(); });
        assert.deepStrictEqual(cachedPanels(), [], 'a 404 must empty the cache');
        assert.strictEqual(panelIds().size, 0, 'the gate still thinks it is enabled');
    });

    await ta('a 410 does the same', async () => {
        resetPanelCache(SEEDED.slice(0, 1));
        await withFetch(reply(410, null), async () => { await refreshPanels(); });
        assert.deepStrictEqual(cachedPanels(), []);
    });

    await ta('a 404 after a good answer drops the etag with the list', async () => {
        // Or the next receiver to answer 200 would be asked to validate against
        // an etag from a different one, and could reply 304 — leaving the empty
        // list standing on a receiver that does serve panels.
        resetPanelCache([]);
        await withFetch(reply(200, { etag: '"a"', panels: SEEDED }, '"a"'), async () => {
            await refreshPanels();
        });
        assert.ok(cachedPanels().length > 0);
        await withFetch(reply(404, null), async () => { await refreshPanels(); });
        assert.deepStrictEqual(cachedPanels(), []);

        let sentMatch = 'unset';
        await withFetch(async (url, init) => {
            sentMatch = init && init.headers ? init.headers['If-None-Match'] : undefined;
            return { status: 200, ok: true, headers: { get: () => '"b"' }, json: async () => ({ panels: SEEDED }) };
        }, async () => { await refreshPanels(); });
        assert.strictEqual(sentMatch, undefined, 'a stale etag was sent after the 404');
        assert.ok(cachedPanels().length > 0, 'the list did not come back');
    });

    await ta('a good answer replaces it, and is written back', async () => {
        resetPanelCache([]);
        await withFetch(reply(200, { etag: '"x"', panels: SEEDED }, '"x"'), async () => {
            await refreshPanels();
        });
        assert.strictEqual(cachedPanels().length, 2, 'the junk entries were still dropped');
        const written = JSON.parse(localStorage.getItem('ubersdr.v2.panels'));
        assert.strictEqual(written.length, 2, 'and the next load starts from this');
    });

    await ta('a receiver with no panels is a receiver with no panels', async () => {
        resetPanelCache(SEEDED);
        await withFetch(reply(200, { etag: '"y"', panels: [] }, '"y"'), async () => {
            await refreshPanels();
        });
        assert.strictEqual(cachedPanels().length, 0);
    });

    // --- the lifecycle poll --------------------------------------------------
    //
    // What makes a panel the operator has just enabled, or one whose author has
    // just published, arrive without anybody reloading the page.

    await ta('a version bump is visible to a mounted frame', async () => {
        // The registry entry is frozen at module init, so this is what a running
        // panel actually watches to know it has been updated.
        resetPanelCache(SEEDED);
        assert.strictEqual(panelVersion(GOOD), 3);
        assert.strictEqual(panelVersion('x:never-existed'), null);

        const bumped = JSON.parse(JSON.stringify(SEEDED));
        bumped[0].version = 4;
        await withFetch(reply(200, { etag: '"z"', panels: bumped }, '"z"'), async () => {
            await refreshPanels();
        });
        assert.strictEqual(panelVersion(GOOD), 4, 'the new version never reached the frame');
    });

    await ta('a removed panel reports no version at all', async () => {
        resetPanelCache(SEEDED);
        await withFetch(reply(200, { etag: '"w"', panels: [] }, '"w"'), async () => {
            await refreshPanels();
        });
        assert.strictEqual(panelVersion(GOOD), null);
    });

    await ta('the poll runs on its interval and stops when told', async () => {
        const timers = [];
        let calls = 0;
        const stop = startPanelPolling({
            intervalMs: 1000,
            isHidden: () => false,
            refresh: async () => { calls += 1; },
            timers: {
                set: (fn) => { timers.push(fn); return timers.length; },
                clear: () => {},
            },
        });
        assert.strictEqual(timers.length, 1, 'nothing was scheduled');
        await timers.pop()();
        assert.strictEqual(calls, 1);
        assert.strictEqual(timers.length, 1, 'the poll did not schedule the next one');

        stop();
        await timers.pop()();
        assert.strictEqual(calls, 1, 'it kept polling after being stopped');
    });

    await ta('a hidden tab does not poll, and asks as soon as it is looked at', async () => {
        // Nobody is looking at a panel in a hidden tab, and a tab that has just
        // come back should not wait out the rest of an interval that ran while
        // it was away.
        const timers = [];
        let calls = 0;
        let hidden = true;
        const listeners = [];
        globalThis.document = {
            get hidden() { return hidden; },
            addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); },
            removeEventListener: () => {},
        };
        const stop = startPanelPolling({
            intervalMs: 1000,
            refresh: async () => { calls += 1; },
            timers: { set: (fn) => { timers.push(fn); return timers.length; }, clear: () => {} },
        });

        await timers.pop()();
        assert.strictEqual(calls, 0, 'a hidden tab polled');

        hidden = false;
        for (const fn of listeners) fn();
        assert.strictEqual(calls, 1, 'coming back did not refresh');

        stop();
        delete globalThis.document;
    });

    // --- the authoring guide -------------------------------------------------
    //
    // PANEL_AUTHORING.md tells authors which icons and groups exist, and those
    // names go out into manifests on a collector shared by every receiver. Both
    // lists were wrong the first time they were written by hand, so they are
    // pinned here rather than trusted.

    const guide = fs.readFileSync(path.join(__dirname, '..', 'PANEL_AUTHORING.md'), 'utf8');

    t('the guide lists exactly the icons that exist', () => {
        const after = guide.slice(guide.indexOf('The names, as of this version:'));
        const block = after.slice(after.indexOf('```') + 3);
        const listed = block.slice(0, block.indexOf('```')).trim().split(/\s+/).filter(Boolean);

        const missing = PANEL_ICONS.filter((n) => !listed.includes(n));
        const invented = listed.filter((n) => !PANEL_ICONS.includes(n));
        assert.deepStrictEqual(missing, [], 'icons an author is not told about');
        assert.deepStrictEqual(invented, [], 'icons the guide promises that do not exist');
    });

    t('the guide and the skill list the real built-in panel titles', () => {
        // These are copies, and a copy of a list is a thing that goes stale. If
        // they drift, an author is told a name is free when it is not.
        const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'panel-meta.json'), 'utf8'));
        const skillPath = '/home/nathan/repos/ubersdr-claude/skills/create-panel/SKILL.md';
        const docs = [['the guide', guide]];
        if (fs.existsSync(skillPath)) docs.push(['the skill', fs.readFileSync(skillPath, 'utf8')]);

        for (const [what, text] of docs) {
            const from = text.indexOf('pick a title that is yours');
            assert.ok(from > 0, what + ' no longer names the taken titles');
            const block = text.slice(text.indexOf('```', from) + 3);
            // Split on the separator *and* on line ends: the list wraps, and a
            // wrapped line has no separator at its break.
            const listed = block.slice(0, block.indexOf('```')).split(/[·\n]/).map((t) => t.trim()).filter(Boolean);
            const missing = meta.titles.filter((t) => !listed.includes(t));
            assert.deepStrictEqual(missing, [], what + ' omits taken titles');
        }
    });

    t('the guide lists exactly the groups that exist', () => {
        // Scoped to the Groups section: the manifest table above it is also rows
        // of backticked lowercase names, and matching those made this pass for
        // the wrong reason.
        const from = guide.indexOf('## 4. Groups');
        const section = guide.slice(from, guide.indexOf('## 5.', from));
        const listed = [...section.matchAll(/^\| `([a-z]+)` \| /gm)].map((m) => m[1]);
        const real = GROUPS.map((g) => g.id);
        assert.ok(listed.length, 'no groups found in the guide');
        assert.deepStrictEqual(listed.slice().sort(), real.slice().sort());
    });

    t('the generated meta the admin editor checks against is the real thing', () => {
        // build.sh greps these out of the source. A regex over source is exactly
        // the sort of thing that breaks quietly, so it is compared here against
        // the modules themselves.
        const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'panel-meta.json'), 'utf8'));
        assert.deepStrictEqual(meta.icons.slice().sort(), PANEL_ICONS.slice().sort());
        assert.deepStrictEqual(meta.groups.slice().sort(), GROUPS.map((g) => g.id).sort());
    });

    t('the admin editor agrees with the server about what a panel is', () => {
        // Three parsers now have to say the same thing: panels_api.go serves it,
        // the collector indexes it, and the admin editor tells the author which
        // they are looking at. A disagreement is how somebody publishes
        // something the editor called a panel and no receiver will run.
        const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'admin.html'), 'utf8');
        const from = admin.indexOf('const PANEL_TEMPLATE_RE');
        const to = admin.indexOf('function updateWidgetKindNote');
        assert.ok(from > 0 && to > from, 'the editor no longer has the detection this pins');

        // eslint-disable-next-line no-new-func
        const inspect = new Function(admin.slice(from, to) + '; return inspectWidgetContent;')();

        const example = fs.readFileSync(path.join(__dirname, '..', 'example-panel.html'), 'utf8');
        const good = inspect(example);
        assert.strictEqual(good.kind, 'panel', 'the editor does not recognise the worked example');
        assert.deepStrictEqual(good.problems, [], 'the editor complains about the worked example');

        // A v1 widget is a v1 widget, and must never be mistaken for a panel.
        assert.strictEqual(inspect('<div id="w"></div><script>window.foo()<\/script>').kind, 'classic');
        assert.strictEqual(inspect('').kind, 'classic');

        // The wrapper without a manifest, and a manifest that is not JSON.
        assert.strictEqual(inspect('<template id="ubersdr-panel"><div></div></template>').kind, 'broken');
        assert.strictEqual(
            inspect('<template id="ubersdr-panel"><script type="application/ubersdr-panel+json">{oops}<\/script><\/template>').kind,
            'broken',
        );

        // A panel whose code is a classic script: it would publish, enable, and
        // then fail to parse in the frame.
        const classic = example.replace('<script type="module">', '<script>');
        const flagged = inspect(classic);
        assert.strictEqual(flagged.kind, 'panel');
        assert.ok(flagged.problems.some((x) => /module/.test(x)),
            'the editor did not notice a classic script: ' + flagged.problems.join('; '));
    });

    t('every panel is expected to have a minimal view', () => {
        // The requirement lives in three places that have to agree: the guide
        // here, the authoring skill Claude works from, and the editor that a
        // human publishes through. It drifted once — all three called `minimal`
        // optional, and panels arrived without one — so this pins it.
        const table = /\|\s*`minimal`\s*\|\s*\*\*yes\*\*/;
        assert.ok(table.test(guide), 'the guide no longer requires a minimal view');

        const skillPath = '/home/nathan/repos/ubersdr-claude/skills/create-panel/SKILL.md';
        if (fs.existsSync(skillPath)) {
            const skill = fs.readFileSync(skillPath, 'utf8');
            assert.ok(table.test(skill), 'the skill no longer requires a minimal view');
        }

        const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'admin.html'), 'utf8');
        const insFrom = admin.indexOf('const PANEL_TEMPLATE_RE');
        const insTo = admin.indexOf('function updateWidgetKindNote');
        // eslint-disable-next-line no-new-func
        const inspect = new Function(admin.slice(insFrom, insTo) + '; return inspectWidgetContent;')();

        const without = [
            '<template id="ubersdr-panel">',
            '<script type="application/ubersdr-panel+json">',
            '{"ui":2,"schema":1,"title":"No Minimal","icon":"Custom","group":"shack"}',
            '<\/script>',
            '<div>hi</div>',
            '</template>',
        ].join('\n');
        const found = inspect(without);
        assert.ok(found.problems.some((p) => /minimal/.test(p)),
            'the editor no longer points out a panel with no minimal view');
    });

    t('a new widget starts as a valid panel', () => {
        // The admin editor prefills this, so it is the first thing most authors
        // will ever publish. If it does not itself pass, every new panel starts
        // broken.
        const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'admin.html'), 'utf8');
        const from = admin.indexOf('const NEW_PANEL_SKELETON');
        assert.ok(from > 0, 'the editor no longer prefills a panel skeleton');
        const to = admin.indexOf('function openNewWidgetEditor', from);
        // eslint-disable-next-line no-new-func
        const skeleton = new Function(admin.slice(from, to) + '; return NEW_PANEL_SKELETON;')();

        // Through the editor's own detection, which mirrors the server's.
        const insFrom = admin.indexOf('const PANEL_TEMPLATE_RE');
        const insTo = admin.indexOf('function updateWidgetKindNote');
        // eslint-disable-next-line no-new-func
        const inspect = new Function(admin.slice(insFrom, insTo) + '; return inspectWidgetContent;')();

        const found = inspect(skeleton);
        assert.strictEqual(found.kind, 'panel', 'the prefilled skeleton is not a panel');
        assert.deepStrictEqual(found.problems, [], 'the prefilled skeleton has problems');

        // And it names things that exist, which is what the fallbacks would
        // otherwise quietly paper over.
        assert.ok(PANEL_ICONS.includes(found.manifest.icon), 'skeleton icon does not exist');
        assert.ok(GROUPS.some((g) => g.id === found.manifest.group), 'skeleton group does not exist');

        // The rule that catches authors out: await needs a module.
        assert.ok(/<script type="module">/.test(skeleton), 'the skeleton uses a classic script');
    });

    t('the reference panels use theme variables that exist', () => {
        // Both are copied by authors — the worked example is what the skill
        // points at first, and the skeleton is literally prefilled into the
        // editor. A wrong variable name in either teaches the mistake.
        const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
        const root = styles.slice(styles.indexOf(':root {'), styles.indexOf('\n}', styles.indexOf(':root {')));
        const real = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

        const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'admin.html'), 'utf8');
        const from = admin.indexOf('const NEW_PANEL_SKELETON');
        // eslint-disable-next-line no-new-func
        const skeleton = new Function(
            admin.slice(from, admin.indexOf('function openNewWidgetEditor', from))
            + '; return NEW_PANEL_SKELETON;')();

        for (const [what, text] of [
            ['the worked example', fs.readFileSync(path.join(__dirname, '..', 'example-panel.html'), 'utf8')],
            ['the editor skeleton', skeleton],
        ]) {
            const used = [...text.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
            const invented = [...new Set(used)].filter((v) => !real.has(v));
            assert.deepStrictEqual(invented, [], what + ' uses variables that do not exist');
        }
    });

    t('the generated meta lists the built-in titles, so a clash can be warned about', () => {
        const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'panel-meta.json'), 'utf8'));
        const real = PANELS.filter((p) => !p.custom).map((p) => p.title).sort();
        assert.deepStrictEqual((meta.titles || []).slice().sort(), [...new Set(real)].sort());
    });

    t('a custom panel can never take a built-in panel\'s id, whatever it is called', () => {
        // Titles can collide and that is only confusing. Ids cannot, and that is
        // the part that would actually break something: PANEL_BY_ID is a map, so
        // a duplicate would shadow the real panel — and if it shadowed the
        // Layout panel, the way to unhide anything would go with it.
        const hostile = PANELS.filter((p) => !p.custom).slice(0, 8).map((p) => ({
            id: p.id,                       // the built-in's own id
            version: 1,
            manifest: { ui: 2, title: p.title, icon: 'Custom', group: 'shack' },
        }));
        const out = panelEntries(hostile, makeStub, new Set(PANELS.map((p) => p.id)));
        assert.deepStrictEqual(out, [], 'a manifest claimed a built-in id');

        // And the same title on a properly namespaced id is allowed through —
        // it is a display clash, not a structural one.
        const twin = panelEntries(
            [{ id: 'x:twin', version: 1, manifest: { ui: 2, title: 'Signal', icon: 'Custom', group: 'shack' } }],
            makeStub,
        );
        assert.strictEqual(twin.length, 1);
        assert.strictEqual(twin[0].title, 'Signal');
        assert.notStrictEqual(twin[0].id, 'signal');
    });

    t('the worked example uses a real icon and a real group', () => {
        // /v2/example-panel.html is what an author is pointed at first. If it
        // names something that does not exist, it teaches the fallback as if it
        // were the feature.
        const html = fs.readFileSync(path.join(__dirname, '..', 'example-panel.html'), 'utf8');
        const block = html.match(/<script[^>]*ubersdr-panel\+json[^>]*>([\s\S]*?)<\/script>/);
        assert.ok(block, 'the example has no manifest');
        const manifest = JSON.parse(block[1]);

        assert.ok(PANEL_ICONS.includes(manifest.icon), `example icon ${manifest.icon} does not exist`);
        assert.ok(GROUPS.some((g) => g.id === manifest.group), `example group ${manifest.group} does not exist`);

        // And it must survive the same conversion a published panel does.
        const entry = panelEntry({ id: 'x:example', version: 1, manifest, name: 'Example' }, makeStub);
        assert.strictEqual(entry.title, manifest.title);
        assert.strictEqual(entry.group, manifest.group);
        assert.strictEqual(entry.dock, manifest.dock || 'left');
    });

    console.log(`\n${pass} ok`);
})();
