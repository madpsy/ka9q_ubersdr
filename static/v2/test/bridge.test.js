// The v2 page API: the wire format and the serving of clients.
//
// This is a published contract — a browser extension is built against it and
// ships separately — so the tests are written as the specification of it. If a
// change here needs a test changed, that change is a breaking one and the API
// version has to say so.

const assert = require('assert');
const {
    API_VERSION, CLIENT_TYPES, ERR, EVENT_FROM_PAGE, EVENT_TO_PAGE, LIVE_TOPICS, MSG, PROTOCOL,
    STATIC_TOPICS, TOPICS, BridgeError, announceMessage, decodeMessage, encodeMessage, errorMessage, okMessage, problemWith,
    clientMessage, stateMessage,
} = require('./.build/bridgeprotocol.cjs');
const { MAX_CLIENTS, SIGNAL_MIN_MS, createHost, diff } = require('./.build/bridgehost.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- the envelope ------------------------------------------------------------

t('the two event names are the published ones', () => {
    // Extensions are built against these strings and ship on their own
    // schedule. Changing one is a breaking change to a released contract.
    assert.strictEqual(EVENT_TO_PAGE, 'ubersdr.to-page');
    assert.strictEqual(EVENT_FROM_PAGE, 'ubersdr.from-page');
    assert.strictEqual(PROTOCOL, 1);
    // 1.1 added the `layout` topic and the `panel` command; 1.2 the
    // `radiocontrol` topic and the `radio` command; 1.3 its `configure` action;
    // 1.4 the `surface` and `audio` commands and the `sdrcontrol` topic; 1.5 the
    // `vfos` topic, which is the only way to see a VFO that is not the active
    // one without switching to it and really retuning the receiver.
    // The envelope never changed, so PROTOCOL stays 1 and a 1.0 client keeps
    // working — which is what the major number is for, and why only the minor
    // has ever moved.
    assert.deepStrictEqual(API_VERSION, { major: 1, minor: 5 });
});

t('the topic lists are what a client is promised', () => {
    assert.deepStrictEqual(
        LIVE_TOPICS,
        ['tuning', 'audio', 'signal', 'spectrum', 'session', 'page', 'layout', 'radiocontrol',
            'sdrcontrol', 'vfos'],
    );
    assert.deepStrictEqual(STATIC_TOPICS, ['modes', 'bands', 'functions']);
    assert.deepStrictEqual(TOPICS, [...LIVE_TOPICS, ...STATIC_TOPICS]);
});

// The point of the list above is that things are only ever added to it. A topic
// that moved or disappeared would break a released client silently, so the 1.0
// set is pinned separately from the current one.
t('every topic 1.0 promised is still there, unmoved', () => {
    const v1 = ['tuning', 'audio', 'signal', 'spectrum', 'session', 'page'];
    assert.deepStrictEqual(LIVE_TOPICS.slice(0, v1.length), v1);
});

t('decode never throws, whatever arrives on the channel', () => {
    assert.strictEqual(decodeMessage('not json'), null);
    assert.strictEqual(decodeMessage('[1,2]'), null);     // an array is not a message
    assert.strictEqual(decodeMessage('"a string"'), null);
    assert.strictEqual(decodeMessage(null), null);
    assert.strictEqual(decodeMessage({ v: 1 }), null);    // detail must be a string
    assert.deepStrictEqual(decodeMessage(encodeMessage({ v: 1 })), { v: 1 });
});

t('a message from another protocol version is not ours to answer', () => {
    const good = clientMessage('c1', 1, MSG.HELLO);
    assert.strictEqual(problemWith(good), null);
    assert.match(problemWith({ ...good, v: 99 }), /protocol version/);
    assert.match(problemWith({ ...good, from: 'page' }), /not from a client/);
    assert.match(problemWith({ ...good, client: '' }), /client id/);
    assert.match(problemWith({ ...good, id: undefined }), /request id/);
    assert.match(problemWith(null), /not a message/);
});

t('results carry the id and the client, so replies can be told apart', () => {
    assert.deepStrictEqual(okMessage(7, 'c1', { a: 1 }), {
        v: 1, from: 'page', type: 'result', id: 7, client: 'c1', ok: true, value: { a: 1 },
    });
    // No value at all rather than an explicit undefined, which JSON drops.
    assert.ok(!('value' in okMessage(7, 'c1')));
    assert.deepStrictEqual(errorMessage(7, 'c1', ERR.BAD_ARGS, 'nope').error, {
        code: 'bad_args', message: 'nope',
    });
});

t('an announce is flat, and addressed only when it is a reply', () => {
    const d = { app: 'ubersdr', ui: 'v2' };
    assert.strictEqual(announceMessage(d).client, undefined);
    assert.strictEqual(announceMessage(d, 'c1').client, 'c1');
    assert.strictEqual(announceMessage(d).app, 'ubersdr');
});

// --- patch diffing -----------------------------------------------------------

t('diff reports what changed and stays quiet about what did not', () => {
    assert.deepStrictEqual(diff({ a: 1, b: 2 }, { a: 1, b: 3 }), { b: 3 });
    assert.deepStrictEqual(diff(null, { a: 1 }), { a: 1 });
    assert.deepStrictEqual(diff({ a: 1 }, { a: 1 }), {});
});

t('diff looks inside a nested value rather than at its identity', () => {
    // The squelch block is rebuilt on every render; comparing by reference
    // would put an identical copy on the wire every time.
    const prev = { squelch: { value: 30, open: true } };
    assert.deepStrictEqual(diff(prev, { squelch: { value: 30, open: true } }), {});
    assert.deepStrictEqual(diff(prev, { squelch: { value: 30, open: false } }),
        { squelch: { value: 30, open: false } });
});

// --- the host ----------------------------------------------------------------

function harness(over = {}) {
    const sent = [];
    let clock = 1000;
    const state = {
        tuning: { frequency: 7100000, mode: 'usb' },
        signal: { dbfs: -90 },
        audio: { volume: 0.7, muted: false },
        session: { id: 's1' },
        spectrum: { centerFreq: 15000000 },
        page: { url: 'https://rx/', title: 'UberSDR' },
        modes: [{ id: 'usb' }],
        bands: [{ name: '20m' }],
        functions: [{ id: 'freq_step_up' }],
    };
    const calls = [];
    const host = createHost({
        send: (m) => sent.push(m),
        now: () => clock,
        enabled: over.enabled || (() => true),
        describe: () => ({ app: 'ubersdr', ui: 'v2', api: API_VERSION }),
        snapshot: (topic) => state[topic],
        command: over.command || ((name, args) => { calls.push([name, args]); return { did: name }; }),
        run: over.run || ((fn, event) => { calls.push([fn, event]); return { fn }; }),
    });
    return {
        host,
        sent,
        calls,
        state,
        advance: (ms) => { clock += ms; },
        at: () => clock,
        say: (type, fields, client = 'c1', id = null) => {
            harness.seq = (harness.seq || 0) + 1;
            host.handle(encodeMessage(clientMessage(client, id == null ? harness.seq : id, type, fields)));
        },
        last: () => sent[sent.length - 1],
        ofType: (type) => sent.filter((m) => m.type === type),
    };
}

t('junk on the channel is ignored without a reply', () => {
    const h = harness();
    h.host.handle('not json');
    h.host.handle(encodeMessage({ v: 99, from: 'client', client: 'c1', id: 1, type: 'hello' }));
    h.host.handle(encodeMessage({ v: 1, from: 'page', client: 'c1', id: 1, type: 'hello' }));
    assert.deepStrictEqual(h.sent, []);
});

t('hello is answered with an announce addressed to the asker', () => {
    const h = harness();
    h.say(MSG.HELLO);
    const m = h.last();
    assert.strictEqual(m.type, MSG.ANNOUNCE);
    assert.strictEqual(m.client, 'c1');
    assert.strictEqual(m.app, 'ubersdr');
});

t('an unknown message type is told so rather than dropped', () => {
    // The sender is addressable and waiting; silence would hang it.
    const h = harness();
    h.say('teleport');
    assert.strictEqual(h.last().ok, false);
    assert.strictEqual(h.last().error.code, ERR.UNKNOWN_TYPE);
    for (const type of CLIENT_TYPES) assert.ok(h.last().error.message.includes(type), type);
});

t('subscribe answers with a full snapshot of each topic', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning', 'audio'] });
    assert.deepStrictEqual(h.last().value, { tuning: h.state.tuning, audio: h.state.audio });
});

t('a subscriber is sent only what changed', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] });
    h.advance(1000);
    h.host.publish('tuning', { frequency: 7100000, mode: 'lsb' });
    const patches = h.ofType(MSG.STATE);
    assert.strictEqual(patches.length, 1);
    assert.deepStrictEqual(patches[0].patch, { mode: 'lsb' });
});

t('publishing an unchanged value puts nothing on the wire', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] });
    h.advance(1000);
    h.host.publish('tuning', { ...h.state.tuning });
    assert.deepStrictEqual(h.ofType(MSG.STATE), []);
});

t('nothing is published to a client that did not ask for the topic', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] });
    h.advance(1000);
    h.host.publish('signal', { dbfs: -50 });
    assert.deepStrictEqual(h.ofType(MSG.STATE), []);
});

t('unsubscribe stops the patches and says what is left', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning', 'audio'] });
    h.say(MSG.UNSUBSCRIBE, { topics: ['tuning'] });
    assert.deepStrictEqual(h.last().value, { subscribed: ['audio'] });
    h.advance(1000);
    h.host.publish('tuning', { frequency: 1 });
    assert.deepStrictEqual(h.ofType(MSG.STATE), []);
});

t('the signal topic is rate limited, and the held value still arrives', () => {
    // The failure this prevents: dropping instead of holding leaves a meter
    // frozen on a stale reading the moment the band goes quiet.
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['signal'] });
    h.advance(SIGNAL_MIN_MS);
    h.host.publish('signal', { dbfs: -80 });
    assert.strictEqual(h.ofType(MSG.STATE).length, 1);

    h.advance(10);
    h.host.publish('signal', { dbfs: -70 });      // too soon
    assert.strictEqual(h.ofType(MSG.STATE).length, 1);
    h.host.tick();                                 // still too soon
    assert.strictEqual(h.ofType(MSG.STATE).length, 1);

    h.advance(SIGNAL_MIN_MS);
    h.host.tick();
    const patches = h.ofType(MSG.STATE);
    assert.strictEqual(patches.length, 2);
    assert.deepStrictEqual(patches[1].patch, { dbfs: -70 });
});

t('a held patch is recomputed from what is true at the flush, not what was queued', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['signal'] });
    h.advance(SIGNAL_MIN_MS);
    h.host.publish('signal', { dbfs: -80 });
    h.advance(10);
    h.host.publish('signal', { dbfs: -70 });
    h.host.publish('signal', { dbfs: -60 });
    h.advance(SIGNAL_MIN_MS);
    h.host.tick();
    assert.deepStrictEqual(h.ofType(MSG.STATE)[1].patch, { dbfs: -60 });
});

t('a client may ask to be told less often', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['signal'], minIntervalMs: 1000 });
    h.advance(200);
    h.host.publish('signal', { dbfs: -80 });
    assert.deepStrictEqual(h.ofType(MSG.STATE), []);
    h.advance(1000);
    h.host.tick();
    assert.strictEqual(h.ofType(MSG.STATE).length, 1);
});

t('a nonsense interval is refused rather than taken literally', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['signal'], minIntervalMs: -5 });
    assert.strictEqual(h.last().error.code, ERR.BAD_ARGS);
});

t('two clients keep their own subscriptions and their own history', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] }, 'c1');
    h.advance(1000);
    h.host.publish('tuning', { frequency: 7100000, mode: 'lsb' });
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] }, 'c2');
    // c2 subscribed after the change, so its snapshot is current and it is not
    // sent the patch c1 already had.
    const patches = h.ofType(MSG.STATE);
    assert.strictEqual(patches.length, 1);
    assert.strictEqual(h.host.clients().length, 2);
});

t('get returns one topic plainly and every topic as a map', () => {
    const h = harness();
    h.say(MSG.GET, { topic: 'tuning' });
    assert.deepStrictEqual(h.last().value, h.state.tuning);
    h.say(MSG.GET, {});
    assert.deepStrictEqual(Object.keys(h.last().value), LIVE_TOPICS);
});

t('static topics are readable but not subscribable', () => {
    const h = harness();
    h.say(MSG.GET, { topic: 'modes' });
    assert.deepStrictEqual(h.last().value, h.state.modes);
    h.say(MSG.SUBSCRIBE, { topics: ['modes'] });
    assert.strictEqual(h.last().error.code, ERR.BAD_ARGS);
});

t('an unknown topic is named in the refusal', () => {
    const h = harness();
    h.say(MSG.GET, { topic: 'weather' });
    assert.strictEqual(h.last().error.code, ERR.BAD_ARGS);
    assert.match(h.last().error.message, /weather/);
});

t('a command runs and its return value comes back', () => {
    const h = harness();
    h.say(MSG.COMMAND, { name: 'tune', args: { frequency: 14074000 } });
    assert.deepStrictEqual(h.calls[0], ['tune', { frequency: 14074000 }]);
    assert.deepStrictEqual(h.last(), {
        v: 1, from: 'page', type: 'result', id: h.last().id, client: 'c1', ok: true,
        value: { did: 'tune' },
    });
});

t('a command that throws a BridgeError keeps its code', () => {
    const h = harness({
        command: () => { throw new BridgeError(ERR.UNSUPPORTED, 'no rotator on this receiver'); },
    });
    h.say(MSG.COMMAND, { name: 'whatever' });
    assert.strictEqual(h.last().error.code, ERR.UNSUPPORTED);
    assert.strictEqual(h.last().error.message, 'no rotator on this receiver');
});

t('a command that throws anything else is still reported, not swallowed', () => {
    // A command that silently does nothing is the failure this API replaces.
    const h = harness({ command: () => { throw new TypeError('x is not a function'); } });
    h.say(MSG.COMMAND, { name: 'tune' });
    assert.strictEqual(h.last().ok, false);
    assert.strictEqual(h.last().error.code, ERR.FAILED);
    assert.match(h.last().error.message, /not a function/);
});

t('an async command replies once it settles', async () => {
    const h = harness({ command: () => Promise.resolve({ later: true }) });
    h.say(MSG.COMMAND, { name: 'tune' });
    assert.strictEqual(h.sent.length, 0);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(h.last().value, { later: true });
});

t('a rejected async command becomes one error reply', async () => {
    const h = harness({ command: () => Promise.reject(new BridgeError(ERR.UNSUPPORTED, 'no audio')) });
    h.say(MSG.COMMAND, { name: 'tune' });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(h.sent.length, 1);
    assert.strictEqual(h.last().error.code, ERR.UNSUPPORTED);
});

t('command and run refuse a message with nothing to run', () => {
    const h = harness();
    h.say(MSG.COMMAND, {});
    assert.strictEqual(h.last().error.code, ERR.BAD_ARGS);
    h.say(MSG.RUN, {});
    assert.strictEqual(h.last().error.code, ERR.BAD_ARGS);
});

t('run reaches the function catalogue, defaulting to a trigger', () => {
    const h = harness();
    h.say(MSG.RUN, { fn: 'freq_step_up' });
    assert.deepStrictEqual(h.calls[0], ['freq_step_up', { kind: 'trigger' }]);
    h.say(MSG.RUN, { fn: 'volume', event: { kind: 'absolute', value: 0.5 } });
    assert.deepStrictEqual(h.calls[1], ['volume', { kind: 'absolute', value: 0.5 }]);
});

t('a client that never said hello still works', () => {
    // The handshake is a convenience, not a gate — a content script that
    // reloads mid-session must not have to re-introduce itself.
    const h = harness();
    h.say(MSG.COMMAND, { name: 'tune', args: {} });
    assert.strictEqual(h.last().ok, true);
});

t('bye forgets the client', () => {
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] });
    h.say(MSG.BYE);
    assert.deepStrictEqual(h.host.clients(), []);
    h.advance(1000);
    h.host.publish('tuning', { frequency: 1 });
    assert.deepStrictEqual(h.ofType(MSG.STATE), []);
});

t('the number of clients is bounded, and the newcomer is not the one refused', () => {
    // Client ids are per-injection: an extension reloaded during development
    // leaves dead registrations behind. Refusing the newcomer would mean the
    // live client is the one locked out, with no way back but a page reload.
    const h = harness();
    for (let i = 0; i < MAX_CLIENTS; i++) {
        h.advance(10);
        h.say(MSG.HELLO, {}, `c${i}`);
    }
    assert.strictEqual(h.host.clients().length, MAX_CLIENTS);

    h.advance(10);
    h.say(MSG.HELLO, {}, 'newcomer');
    assert.strictEqual(h.host.clients().length, MAX_CLIENTS);
    assert.ok(h.host.clients().includes('newcomer'));
    assert.ok(!h.host.clients().includes('c0'), 'the stalest registration should have gone');
    // And it is told, so a client that is alive says hello again.
    const goodbye = h.ofType(MSG.CLOSING);
    assert.strictEqual(goodbye.length, 1);
    assert.strictEqual(goodbye[0].client, 'c0');
});

t('a subscriber outranks an idle registration when room is needed', () => {
    // An idle registration is what a dead one looks like; a subscriber is
    // demonstrably in use even if it has not spoken for a while.
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] }, 'watcher');
    for (let i = 1; i < MAX_CLIENTS; i++) {
        h.advance(10);
        h.say(MSG.HELLO, {}, `idle${i}`);
    }
    h.advance(10);
    h.say(MSG.HELLO, {}, 'newcomer');
    assert.ok(h.host.clients().includes('watcher'));
    assert.ok(!h.host.clients().includes('idle1'));
});

t('closing tells whoever is attached, once', () => {
    const h = harness();
    h.say(MSG.HELLO);
    h.host.closing();
    assert.strictEqual(h.last().type, MSG.CLOSING);
    const count = h.sent.length;
    h.host.closing();
    assert.strictEqual(h.sent.length, count);
});

t('a disabled bridge says so rather than going silent', () => {
    // A silent page is indistinguishable from a broken one; a client that is
    // told can say "switched off on this receiver".
    let on = false;
    const h = harness({ enabled: () => on });
    h.say(MSG.HELLO);
    assert.strictEqual(h.last().ok, false);
    assert.strictEqual(h.last().error.code, ERR.DISABLED);

    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] });
    assert.strictEqual(h.last().error.code, ERR.DISABLED);
    h.host.publish('tuning', { frequency: 1 });
    h.host.announce();
    assert.deepStrictEqual(h.ofType(MSG.STATE), []);
    assert.deepStrictEqual(h.ofType(MSG.ANNOUNCE), []);

    on = true;
    h.say(MSG.HELLO);
    assert.strictEqual(h.last().type, MSG.ANNOUNCE);
});

t('switching off tells whoever was attached, rather than starving them', () => {
    // A subscriber has no other way to learn that the patches stopped on
    // purpose, and silence is exactly what a broken page looks like.
    const h = harness();
    h.say(MSG.SUBSCRIBE, { topics: ['tuning'] });
    h.host.closing();
    assert.strictEqual(h.last().type, MSG.CLOSING);
    assert.deepStrictEqual(h.host.clients(), []);
});

t('a state patch is shaped the way clients merge it', () => {
    // Addressed: patches are per-subscriber, and merging one client's delta
    // into another client's picture would invent a state neither has.
    assert.deepStrictEqual(stateMessage('tuning', { frequency: 1 }, 'c1'), {
        v: 1, from: 'page', type: 'state', client: 'c1', topic: 'tuning', patch: { frequency: 1 },
    });
});

console.log(`\n${pass} ok`);
