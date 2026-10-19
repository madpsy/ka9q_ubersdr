// Game controllers: turning polled Gamepad API snapshots into control-surface
// input, the default mapping, rumble, and the plumbing that makes the pad a
// fifth choice beside the others.
//
// There is no pad in a test, so a pad here is the plain object getGamepads()
// returns — buttons, axes, an index and an id — and the frames are driven by
// hand with a fake clock. What can go wrong silently is what is pinned: a stick
// at rest that tunes by itself, a held Mute that flickers, a Y axis that turns
// things down when pushed up, and a default mapping that names a function this
// build does not have.

const assert = require('assert');
const gp = require('./.build/gamepad.cjs');

const {
    GamepadControl, GAMEPAD_DEFAULT_MAPPINGS, DEADZONE, ENGAGE, RATE_MAX, REPEAT_DELAY_MS, REPEAT_MS,
    TICK_GAP_MS, gamepadKeyLabel, gamepadKeyRank, otherHalf, isAxisKey, detentRate, rumbleSettings,
    _setStandardLayout,
} = gp;

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// --- stand-ins ---------------------------------------------------------------

function makePad({ index = 0, id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', mapping = 'standard', actuator = true } = {}) {
    const pad = {
        index, id, mapping, connected: true,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
        axes: [0, 0, 0, 0],
        effects: [],
    };
    if (actuator) {
        pad.vibrationActuator = {
            type: 'dual-rumble',
            playEffect: (type, params) => { pad.effects.push({ type, ...params }); return Promise.resolve('complete'); },
        };
    }
    return pad;
}

function press(pad, n, down = true) {
    pad.buttons[n] = { pressed: down, value: down ? 1 : 0 };
}

function rig(pads, opts = {}) {
    let now = 1000;
    const listeners = {};
    const win = {
        addEventListener: (n, fn) => { listeners[n] = fn; },
        removeEventListener: (n) => { delete listeners[n]; },
    };
    const c = new GamepadControl({
        now: () => now,
        getPads: () => pads,
        schedule: () => 1,     // frames are driven by hand
        cancel: () => {},
        window: win,
        ...opts,
    });
    const inputs = [];
    c.on('input', (e) => inputs.push(e));
    const messages = [];
    c.on('message', (m) => messages.push(m));
    return {
        c, inputs, messages, listeners,
        frame(ms = 16) { now += ms; c.poll(); },
        advance(ms) { now += ms; },
        get now() { return now; },
    };
}

// The Gamepad API exists for these: the driver checks for it before listening.
globalThis.navigator = { getGamepads: () => [] };

// --- buttons -----------------------------------------------------------------

t('a press and a release are two keys, with note-on and note-off', () => {
    const pad = makePad();
    const r = rig([pad]);
    assert.ok(r.c.connect('0'));
    press(pad, 0); r.frame();
    press(pad, 0, false); r.frame();
    assert.deepStrictEqual(r.inputs.map((e) => [e.key, !!e.isNoteOn, !!e.isNoteOff]), [
        ['b:0', true, false],
        ['b:0:up', false, true],
    ]);
    assert.strictEqual(r.inputs[0].event.kind, 'trigger');
});

t('a button already held when connecting is not a press', () => {
    const pad = makePad();
    press(pad, 3);
    const r = rig([pad]);
    r.c.connect('0');
    r.frame(); r.frame();
    assert.deepStrictEqual(r.inputs, []);
    press(pad, 3, false); r.frame();
    assert.deepStrictEqual(r.inputs.map((e) => e.key), ['b:3:up']);
});

t('a held button repeats only when its function is continuous', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    r.c.setContinuous({ 'b:15': true });
    press(pad, 15); press(pad, 0);
    r.frame();
    // Held well past the delay and several repeat periods.
    for (let i = 0; i < 60; i++) r.frame(16);
    const held = 60 * 16;
    const repeats = r.inputs.filter((e) => e.key === 'b:15' && e.repeat).length;
    const expected = Math.floor((held - REPEAT_DELAY_MS) / REPEAT_MS) + 1;
    assert.ok(Math.abs(repeats - expected) <= 1, `repeats ${repeats}, expected about ${expected}`);
    assert.strictEqual(r.inputs.filter((e) => e.key === 'b:0').length, 1, 'mute pressed once, fired once');
});

t('an analog trigger counts as down past half travel, not at the first touch', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    pad.buttons[7] = { pressed: true, value: 0.2 };
    r.frame();
    assert.deepStrictEqual(r.inputs, []);
    pad.buttons[7] = { pressed: true, value: 0.8 };
    r.frame();
    assert.deepStrictEqual(r.inputs.map((e) => e.key), ['b:7']);
});

// --- sticks ------------------------------------------------------------------

t('a stick at rest, or drifting inside the dead zone, sends nothing', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    r.c.setContinuous({ 'a:0+': true, 'a:0-': true });
    for (const v of [0, 0.05, -0.1, DEADZONE - 0.01, ENGAGE - 0.01]) {
        pad.axes[0] = v;
        for (let i = 0; i < 30; i++) r.frame();
    }
    assert.deepStrictEqual(r.inputs, []);
});

t('a stick as a rate: one detent at once, then faster the further it is pushed', () => {
    const count = (v) => {
        const pad = makePad();
        const r = rig([pad]);
        r.c.connect('0');
        r.c.setContinuous({ 'a:0+': true, 'a:0-': true });
        pad.axes[0] = v;
        for (let i = 0; i < 63; i++) r.frame(16);   // about a second
        return r.inputs.reduce((n, e) => n + Math.abs(e.event.delta), 0);
    };
    const gentle = count(0.4);
    const full = count(1);
    assert.ok(gentle >= 1 && gentle < 8, `gentle ${gentle}`);
    assert.ok(full >= RATE_MAX * 0.9 && full <= RATE_MAX + 2, `full ${full}`);
});

t('right and up are positive; left and down negative — the Y axis is flipped', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    r.c.setContinuous({ 'a:0+': true, 'a:0-': true, 'a:1+': true, 'a:1-': true });
    const first = (axis, v) => {
        r.inputs.length = 0;
        pad.axes = [0, 0, 0, 0];
        r.frame();
        pad.axes[axis] = v;
        r.frame();
        return r.inputs[0];
    };
    assert.deepStrictEqual([first(0, 1).key, first(0, 1).event.delta], ['a:0+', 1]);
    assert.deepStrictEqual([first(0, -1).key, first(0, -1).event.delta], ['a:0-', -1]);
    // The standard layout reads down as positive; pushed up is "more".
    assert.deepStrictEqual([first(1, -1).key, first(1, -1).event.delta], ['a:1-', 1]);
    assert.deepStrictEqual([first(1, 1).key, first(1, 1).event.delta], ['a:1+', -1]);
});

t('a stick mapped to a press fires once per push, with hysteresis', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    for (const v of [0.7, 0.9, 0.5, 0.7, 0.2, 0.7]) { pad.axes[0] = v; r.frame(); }
    // 0.5 is above the release point, so the second 0.7 is the same push.
    assert.deepStrictEqual(r.inputs.map((e) => [e.key, e.event.kind]), [
        ['a:0+', 'trigger'], ['a:0+', 'trigger'],
    ]);
});

t('the rate curve is zero at rest and RATE_MAX at the end of travel', () => {
    assert.strictEqual(detentRate(0), 0);
    assert.strictEqual(detentRate(DEADZONE), 0);
    assert.strictEqual(detentRate(1), RATE_MAX);
    assert.strictEqual(detentRate(-1), RATE_MAX);
});

// --- names, order, defaults --------------------------------------------------

t('labels name the standard layout, and number anything else', () => {
    _setStandardLayout(true);
    assert.strictEqual(gamepadKeyLabel('b:0'), 'A / ✕ (bottom)');
    assert.strictEqual(gamepadKeyLabel('b:14'), 'D-pad left');
    assert.strictEqual(gamepadKeyLabel('b:5:up'), 'Right bumper release');
    assert.strictEqual(gamepadKeyLabel('a:1-'), 'Left stick up');
    assert.strictEqual(gamepadKeyLabel('b:20'), 'Button 20');
    _setStandardLayout(false);
    assert.strictEqual(gamepadKeyLabel('b:0'), 'Button 0');
    assert.strictEqual(gamepadKeyLabel('a:1-'), 'Axis 1 -');
    _setStandardLayout(true);
});

t('a pad without the standard layout says so on connect', () => {
    const pad = makePad({ mapping: '' });
    const r = rig([pad]);
    r.c.connect('0');
    assert.ok(r.messages.some((m) => /numbered rather than named/.test(m.text)));
    // And a stick's Y axis is left as the pad reports it.
    r.c.setContinuous({ 'a:1+': true });
    pad.axes[1] = 1; r.frame();
    assert.strictEqual(r.inputs[0].event.delta, 1);
    _setStandardLayout(true);
});

t('axis halves pair up, and rows sort sticks first then buttons in pad order', () => {
    assert.strictEqual(otherHalf('a:2+'), 'a:2-');
    assert.strictEqual(otherHalf('a:2-'), 'a:2+');
    assert.strictEqual(otherHalf('b:2'), null);
    assert.ok(isAxisKey('a:10-') && !isAxisKey('b:1'));
    const keys = ['b:5', 'b:0:up', 'a:1+', 'b:0', 'a:0-'];
    keys.sort((a, b) => {
        const ra = gamepadKeyRank(a); const rb = gamepadKeyRank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
        return 0;
    });
    assert.deepStrictEqual(keys, ['a:0-', 'a:1+', 'b:0', 'b:0:up', 'b:5']);
});

t('every default mapping names a function this build has', () => {
    for (const [key, m] of Object.entries(GAMEPAD_DEFAULT_MAPPINGS)) {
        assert.ok(gp.findFunction(m.function), `${key} → ${m.function}`);
        assert.strictEqual(m.throttleMs, 0, `${key} is paced by the pad, not a limit`);
    }
    // The sticks are rates: both halves of each go to something continuous.
    for (const key of ['a:0+', 'a:0-', 'a:2+', 'a:2-', 'a:3+', 'a:3-']) {
        assert.ok(gp.functionIsContinuous(GAMEPAD_DEFAULT_MAPPINGS[key].function), key);
    }
});

// --- connection --------------------------------------------------------------

t('a pad that sleeps and wakes is taken back, at whatever index it returns', () => {
    const pad = makePad({ index: 0 });
    const pads = [pad];
    const r = rig(pads);
    r.c.open();
    r.c.connect('0');
    const states = [];
    r.c.on('state', (s) => states.push(s.connected));
    pads.length = 0;
    r.listeners.gamepaddisconnected({ gamepad: pad });
    assert.strictEqual(r.c.connected, false);
    const back = makePad({ index: 2 });
    pads.push(back);
    r.listeners.gamepadconnected({ gamepad: back });
    assert.strictEqual(r.c.connected, true);
    assert.strictEqual(r.c.deviceId, '2');
    assert.deepStrictEqual(states, [false, true]);
});

t('after Disconnect a returning pad is left alone', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.open();
    r.c.connect('0');
    r.c.disconnect();
    r.listeners.gamepadconnected({ gamepad: pad });
    assert.strictEqual(r.c.connected, false);
});

t('a frame with the pad missing is not a disconnect', () => {
    const pad = makePad();
    const pads = [pad];
    const r = rig(pads);
    r.c.connect('0');
    pads[0] = null;
    r.frame();
    assert.strictEqual(r.c.connected, true);
});

// --- rumble ------------------------------------------------------------------

t('rumble plays its pattern at the chosen strength', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    assert.ok(r.c.canRumble());
    assert.ok(r.c.rumble('off', 0.5));
    assert.strictEqual(pad.effects.length, 2, 'off is two pulses');
    assert.ok(pad.effects[1].startDelay > pad.effects[0].startDelay);
    for (const e of pad.effects) {
        assert.ok(e.weakMagnitude > 0 && e.weakMagnitude <= 0.5);
        assert.strictEqual(e.type, 'dual-rumble');
    }
});

t('ticks closer together than the gap are one tick', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    r.c.rumble('tick');
    r.advance(TICK_GAP_MS / 2);
    r.c.rumble('tick');
    assert.strictEqual(pad.effects.length, 1);
    r.advance(TICK_GAP_MS);
    r.c.rumble('tick');
    assert.strictEqual(pad.effects.length, 2);
});

t('a pad with no motor, or no pad at all, rumbles quietly to nothing', () => {
    const pad = makePad({ actuator: false });
    const r = rig([pad]);
    assert.strictEqual(r.c.rumble('on'), false);
    r.c.connect('0');
    assert.strictEqual(r.c.canRumble(), false);
    assert.strictEqual(r.c.rumble('on'), false);
});

t('Firefox\'s older haptic actuator is used when there is no vibrationActuator', () => {
    const pad = makePad({ actuator: false });
    const pulses = [];
    pad.hapticActuators = [{ pulse: (v, ms) => pulses.push([v, ms]) }];
    const r = rig([pad]);
    r.c.connect('0');
    assert.ok(r.c.canRumble());
    r.c.rumble('on', 1);
    assert.deepStrictEqual(pulses, [[1, 60]]);
});

t('rumble settings are filled in and clamped', () => {
    assert.deepStrictEqual(rumbleSettings(undefined), gp.DEFAULT_RUMBLE);
    assert.strictEqual(rumbleSettings({ strength: 5 }).strength, 1);
    assert.strictEqual(rumbleSettings({ strength: 0 }).strength, gp.DEFAULT_RUMBLE.strength);
    assert.strictEqual(rumbleSettings({ ticks: true }).ticks, true);
});

// --- plumbing ----------------------------------------------------------------

t('the pad is a mapped surface, arrives mapped, and keeps its rumble settings', () => {
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    assert.ok(gp.SURFACES.includes('gamepad'));
    assert.ok(gp.isMappedSurface('gamepad'));
    assert.strictEqual(gp.getSurface('gamepad'), gp.getGamepad());
    assert.strictEqual(gp.surfaceKeyLabel('gamepad')('b:15'), 'D-pad right');
    const s = gp.loadState();
    assert.deepStrictEqual(s.gamepad.mappings, GAMEPAD_DEFAULT_MAPPINGS);
    assert.deepStrictEqual(s.gamepad.rumble, gp.DEFAULT_RUMBLE);

    const saved = { surface: 'gamepad', gamepad: { mappings: {}, rumble: { ticks: true } } };
    globalThis.localStorage = { getItem: (k) => (k === 'ubersdr.v2.radioControl' ? JSON.stringify(saved) : null), setItem: () => {} };
    const s2 = gp.loadState();
    assert.deepStrictEqual(s2.gamepad.mappings, {}, 'an emptied table stays empty');
    assert.strictEqual(s2.gamepad.rumble.ticks, true);
    assert.strictEqual(s2.gamepad.rumble.enabled, true, 'a setting saved before another existed is filled in');
});

t('a stick drives the receiver through the dispatcher, and results are reported', () => {
    gp._resetDispatch();
    const pad = makePad();
    globalThis.navigator = { getGamepads: () => [pad] };
    const surface = gp.getGamepad();
    // The singleton reads the real navigator; poll by hand.
    surface.connect('0');
    surface.setContinuous({ 'a:0+': true, 'a:0-': true });
    const nudges = [];
    gp.setControlContext({
        actions: { nudge: (hz) => nudges.push(hz) },
        stepHz: 1000,
        state: () => ({ dsp: { schemas: [] }, tuning: { frequency: 14e6 } }),
    });
    gp.setSurfaceMappings('gamepad', GAMEPAD_DEFAULT_MAPPINGS);
    const results = [];
    const offResult = gp.onControlResult((id, key, fn, ok) => results.push([id, key, fn, ok]));
    const off = gp.watchSurface('gamepad');
    pad.axes[0] = -1;
    surface.poll();
    assert.deepStrictEqual(nudges, [-100]);
    assert.deepStrictEqual(results, [['gamepad', 'a:0-', 'freq_enc_100', true]]);
    off(); offResult();
    surface.close();
    gp._resetDispatch();
});

t('autoconnect finds the remembered pad by name', () => {
    gp._resetDispatch();
    const pad = makePad({ index: 1 });
    globalThis.navigator = { getGamepads: () => [null, pad] };
    const surface = gp.getGamepad();
    gp.tryAutoConnect('gamepad', { autoConnect: true, device: 'Some other pad' });
    assert.strictEqual(surface.connected, false);
    gp.tryAutoConnect('gamepad', { autoConnect: true, device: pad.id });
    assert.strictEqual(surface.connected, true);
    assert.strictEqual(surface.deviceId, '1');
    gp.releaseSurfaceExcept('midi');
    assert.strictEqual(surface.connected, false, 'choosing another surface lets the pad go');
});

t('in another window\'s turn the pad is read but sends nothing, and a held button is not a press on return', () => {
    const pad = makePad();
    const r = rig([pad]);
    r.c.connect('0');
    r.c.setContinuous({ 'a:0+': true });
    const seen = [];
    r.c.on('active', (on) => seen.push(on));
    r.c.setActive(false);
    press(pad, 0); pad.axes[0] = 1;
    for (let i = 0; i < 10; i++) r.frame();
    assert.deepStrictEqual(r.inputs, []);
    assert.strictEqual(r.c.rumble('on'), false, 'no rumble from a window without the pad');
    r.c.setActive(true);
    r.frame();
    assert.ok(!r.inputs.some((e) => e.key === 'b:0'), 'still held, not pressed');
    assert.ok(r.inputs.some((e) => e.key === 'a:0+'), 'the stick is a rate, so it carries on');
    press(pad, 0, false); r.frame();
    press(pad, 0); r.frame();
    assert.strictEqual(r.inputs.filter((e) => e.key === 'b:0').length, 1);
    assert.deepStrictEqual(seen, [false, true]);
});

t('the desktop client says which window has the pad', () => {
    let tell = null;
    let subs = 0;
    const pad = makePad();
    const r = rig([pad], {
        window: {
            addEventListener() {}, removeEventListener() {},
            ubersdrDesktop: { onControllerActive: (fn) => { subs++; tell = fn; fn(false); } },
        },
    });
    r.c.open();
    assert.strictEqual(r.c.active, false);
    tell(true);
    assert.strictEqual(r.c.active, true);
    r.c.open();
    assert.strictEqual(subs, 1, 'subscribed once, not per open');
});

console.log(`\n${pass} passed`);
