// Noise: what can be done about it, in two places.
//
// The split that matters here is *where the work happens*, so that is the
// split the panel wears. "In this client" is DSP on the decoded
// audio — it exists on every receiver, costs the server nothing, and keeps
// working when the instance offers no filters at all. "On the receiver" is the
// server's own DSP inserts (DspControl), which act on the channel before the
// audio is encoded — better placed in the chain, but only present where the
// operator has installed them. The server section disappears entirely on a
// receiver that has answered "none"; the client section is the reason this
// panel never disappears.
//
// The blanker is not an alternative to any of the reducers, and the layout
// says so by giving it its own switch: an impulse blanker removes microsecond
// clicks *before* anything models the noise floor — exactly the samples a
// spectral NR must not learn — so it composes with client NR, server NR, or
// both. Client NR alongside server NR is legal too; whether it helps depends
// on the band, and that is the operator's experiment to run, not this panel's
// to forbid.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Segmented, Slider, Switch } from '../components/ui.jsx';
import DspControl from './DspControl.jsx';
import {
    NB_THRESHOLD_MAX, NB_THRESHOLD_MIN, NB_WIDTH_MAX, NB_WIDTH_MIN, TRACE_LEN, TRACE_MS,
} from '../lib/noiseBlanker.js';
import { cssVar } from '../lib/audioWaterfall.js';
import {
    RM_REGISTER_URL, getRmNoise, rmCredentials, rmFamilyOfModel, rmModeSupported,
    saveRmCredentials,
} from '../lib/rmnoise.js';

// What the blanker is hearing, and where it drew the line.
//
// Everything is plotted against the blanker's own reference rather than in
// absolute level, which is the whole reason this is worth drawing: the
// threshold becomes a horizontal line, and setting it stops being guesswork.
// Bursts that stand over the line are the ones being cut — the chart shades
// those buckets — and bursts that sit under it are the ones still audible,
// which is the question every "is this thing doing anything" comes down to.
//
// Drawn from the blanker's own ring, on a timer rather than an animation
// frame: three seconds of ten-millisecond buckets, and a panel that is often
// on a phone. Ten redraws a second is plenty to watch a crash go past.
const SCOPE_H = 64;
const SCOPE_TOP_DB = 40;      // top of the scale, dB over the reference
const SCOPE_BOTTOM_DB = -6;

function NbScope({ thresholdDb }) {
    const { player } = useRadio();
    const ref = useRef(null);

    useEffect(() => {
        const draw = () => {
            const canvas = ref.current;
            const trace = player.nbTrace();
            if (!canvas || !trace) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
            const h = Math.round(SCOPE_H * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            const c = canvas.getContext('2d');
            c.clearRect(0, 0, w, h);

            const y = (db) => h - ((Math.max(SCOPE_BOTTOM_DB, Math.min(SCOPE_TOP_DB, db)) - SCOPE_BOTTOM_DB)
                / (SCOPE_TOP_DB - SCOPE_BOTTOM_DB)) * h;
            const bw = w / TRACE_LEN;

            // The buckets, oldest first: `head` is where the next one lands,
            // so it is also the oldest one still held.
            const accent = cssVar('--accent', '#4aa8ff');
            const bad = cssVar('--bad', '#f2646a');
            for (let i = 0; i < TRACE_LEN; i++) {
                const k = (trace.head + i) % TRACE_LEN;
                const top = y(trace.db[k]);
                const x = i * bw;
                const bar = Math.max(1, bw);
                // The bar is what was heard; the red part of it is the share
                // of that ten milliseconds the gate was shut for. A bucket
                // half cut is drawn half red, so "it went red" and "it was
                // removed" cannot come apart.
                c.fillStyle = accent;
                c.globalAlpha = 0.5;
                c.fillRect(x, top, bar, h - top);
                const share = trace.cut[k] / 255;
                if (share > 0) {
                    c.fillStyle = bad;
                    c.globalAlpha = 0.95;
                    c.fillRect(x, top, bar, (h - top) * share);
                }
            }
            c.globalAlpha = 1;

            // The line the threshold draws, over the top of the bars it is
            // judging — the one thing on here that is a setting rather than a
            // measurement, so it is drawn as one.
            const ty = y(thresholdDb);
            c.strokeStyle = cssVar('--text', '#e6ecf5');
            c.lineWidth = Math.max(1, dpr);
            c.setLineDash([4 * dpr, 3 * dpr]);
            c.beginPath();
            c.moveTo(0, ty);
            c.lineTo(w, ty);
            c.stroke();
            c.setLineDash([]);
        };
        draw();
        const t = setInterval(draw, 100);
        return () => clearInterval(t);
    }, [player, thresholdDb]);

    return (
        <div className="nb-scope">
            <canvas ref={ref} style={{ height: SCOPE_H }} />
            <span className="nb-scope__label">
                peak over reference · {(TRACE_LEN * TRACE_MS) / 1000} s
            </span>
        </div>
    );
}

// `minimal` keeps every switch — blanker, client NR, and the server insert
// with its filter chips — and drops the sliders and the notes. Which stages
// are working is what you change while listening; how hard they work is set
// once against a band and left.
// rmnoise.com: the account, the model, and whether it is actually connected.
//
// This is the only noise reducer here that can fail for reasons which have
// nothing to do with radio — a password, somebody else's uptime, a network
// path — so unlike the local engines it has to be able to say so. The bridge
// (lib/rmnoise.js) owns the connection and outlives this component; a
// collapsed panel must not drop a session that took a login to make.
//
// The password is kept in this browser's storage, in the same place v1 keeps
// it, so moving between the two interfaces does not mean typing it again. That
// is a real convenience and a real exposure, and the note under the fields
// says so rather than leaving somebody to assume otherwise.
function RmNoiseControls() {
    const { tuning } = useRadio();
    const rm = getRmNoise();
    const saved = rmCredentials();
    const [, bump] = useState(0);
    const [username, setUsername] = useState(saved.username);
    // Deliberately empty even when one is stored. A stored password painted
    // into the field is a password on screen for no reason: nothing here needs
    // to read it, the browser offers to fill over it — which on iOS arrives as
    // a generated string and reads as the saved one having been corrupted —
    // and leaving the box blank means "keep the one that already works".
    const [password, setPassword] = useState('');

    useEffect(() => rm.on('change', () => bump((n) => n + 1)), [rm]);

    // The connection *state* arrives as events; the two numbers do not. Latency
    // is written for every frame that comes back — twenty a second — and the
    // buffered figure changes on every audio callback, so neither can raise an
    // event without turning this panel into a render loop. They are polled at
    // reading speed instead, which is what the blanker's readouts do and for
    // the same reason. Without this the numbers were live but never redrawn:
    // whatever they happened to be at the last connection event, frozen.
    useEffect(() => {
        if (!rm.ready) return undefined;
        const t = setInterval(() => bump((n) => n + 1), 500);
        return () => clearInterval(t);
    }, [rm, rm.ready]);

    // Connecting when the engine is selected is RadioContext's job — see the
    // note there. What this button does is the explicit version, with whatever
    // has just been typed into the fields.

    const status = rm.ready ? 'connected'
        : rm.connecting ? 'connecting…'
            : rm.error ? 'failed'
                : 'not connected';

    // Saved *after* it works, never before. A password that has not been
    // accepted is not a setting: storing it would put a wrong one into the
    // credentials that follow the operator to every other receiver, and would
    // arm the automatic connect above with something already known to fail.
    const connect = async () => {
        // Blank means the stored one, which is the only one that has ever been
        // accepted; typing replaces it.
        const pass = password || saved.password;
        try {
            await rm.connect({ username, password: pass, mode: tuning.mode });
            saveRmCredentials({ username, password: pass });
        } catch (e) { /* the bridge keeps the message; the panel reads it */ }
    };

    return (
        <>
            {/* Round trip, then how much denoised audio is in hand — the
                reserve standing between the network and a gap. Not the jitter
                buffer, which process() empties on every call and so reads zero
                whatever is happening. */}
            <Field
                label="Status"
                hint={rm.ready ? `${Math.round(rm.latencyMs)} ms · ${rm.bufferMs} ms buffered` : undefined}
                inline
            >
                <span className={`badge badge--${rm.ready ? 'open' : rm.connecting ? 'idle' : rm.error ? 'closed' : 'idle'}`}>
                    {status.toUpperCase()}
                </span>
            </Field>

            {rm.error && (
                <div className="note note--warn note--tight">
                    {rm.authFailed
                        ? `${rm.error} Check the username and password below and press Connect — nothing is tried again on its own.`
                        : rm.error}
                </div>
            )}

            {/* What it last did, in its own words — which model it chose and
                why it changed. A service that picks a model on the operator's
                behalf has to be able to say which one it picked; without this
                the only way to tell a wrong choice from a choice that never
                happened was to ask somebody to describe the dropdown. */}
            {rm.lines.length > 0 && (
                <div className="param-help">{rm.lines[rm.lines.length - 1].message}</div>
            )}

            {rm.ready && rm.availableFilters.length > 0 && (
                <Field label="Model">
                    <select
                        className="select"
                        value={rm.filterNumber}
                        onChange={(e) => rm.setFilter(e.target.value)}
                    >
                        {rm.availableFilters.map((f) => {
                            const family = rmFamilyOfModel(f.filterDesc);
                            return (
                                <option key={f.filterNumber} value={f.filterNumber}>
                                    {f.filterDesc || `Filter ${f.filterNumber}`}
                                    {family ? ` · ${family.toUpperCase()}` : ''}
                                </option>
                            );
                        })}
                    </select>
                </Field>
            )}

            {!rm.ready && (
                <>
                    {/* AutoFill is switched off on both, and the fields are
                        not named as a login. They are an account with
                        rmnoise.com, not with this receiver, and a browser
                        offering the keychain's entry for *this* origin fills
                        them with something that has nothing to do with the
                        service — on iOS that arrives as a generated password
                        and reads as the stored one having been corrupted. What
                        was typed here is remembered by this panel anyway, and
                        only once it has been accepted. */}
                    <Field label="Username">
                        <input
                            className="input"
                            name="rmnoise-account"
                            value={username}
                            autoComplete="off"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(e) => setUsername(e.target.value)}
                        />
                    </Field>
                    <Field label="Password">
                        <input
                            className="input"
                            name="rmnoise-secret"
                            type="password"
                            placeholder={saved.password ? 'stored — leave blank to keep' : ''}
                            value={password}
                            autoComplete="off"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </Field>
                    <div className="note note--tight">
                        An <a href={RM_REGISTER_URL} target="_blank" rel="noopener noreferrer">rmnoise.com account</a> is
                        needed. The audio goes to their servers and comes back denoised, and the
                        password is kept in this browser — shared with the classic interface, so it
                        is only typed once.
                    </div>
                </>
            )}

            <div className="chip-row chip-row--wrap">
                {rm.ready || rm.connecting ? (
                    <Button size="sm" variant="ghost" onClick={() => rm.disconnect({ manual: true })}>
                        Disconnect
                    </Button>
                ) : (
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={!username || !(password || saved.password)}
                        onClick={connect}
                    >
                        Connect
                    </Button>
                )}
            </div>
        </>
    );
}

export default function NoisePanel({ minimal }) {
    const { noise, dsp, player, tuning, actions } = useRadio();
    const { nb, nr } = noise;
    const setNb = (patch) => actions.setNoise({ nb: patch });
    const setNr = (patch) => actions.setNoise({ nr: patch });

    // The blanker's running total, polled while it is on. This is the readout
    // the threshold is set against — steady counting on a crackling band is
    // the blanker working, a count racing during clean speech means the
    // threshold is low and it is eating syllables. It restarts from zero when
    // the blanker is toggled, because the DSP is rebuilt then.
    const [nbStats, setNbStats] = useState({ n: 0, cut: 0, db: 0 });
    useEffect(() => {
        if (!nb.enabled) { setNbStats({ n: 0, cut: 0, db: 0 }); return undefined; }
        const t = setInterval(
            () => setNbStats({
                n: player.nbPulses(),
                cut: player.nbCut(),
                db: player.nbReductionDb(),
            }),
            500,
        );
        return () => clearInterval(t);
    }, [nb.enabled, player]);

    // Hidden only when the server has *answered* that there is nothing —
    // while the answer is pending (or the receiver is not running) DspControl
    // says which, and vanishing-then-appearing would read as a glitch.
    const serverAbsent = Array.isArray(dsp.schemas) && dsp.schemas.length === 0;

    return (
        <div className="stack">
            <div className="section-label"><span>In this client</span></div>

            {/* A box each, because they are two independent machines that
                happen to live in one panel: either can be on without the
                other, they do different things to the audio, and read as one
                list of switches and sliders they were a wall somebody had to
                work out the grouping of. The border is the grouping. */}
            <div className="noise-stage">
            {/* Pulses caught, the share of the audio being removed and what
                that costs in level — "412 · 1.3% · -0.4 dB". It lives in the
                hint rather than under the chart because a line that appears
                and disappears as the numbers cross a threshold is a flicker in
                the corner of the eye; a hint that is always there is a
                reading. */}
            <Field
                label="Noise blanker"
                hint={nb.enabled
                    ? `${nbStats.n} · ${(nbStats.cut * 100).toFixed(1)}% · ${nbStats.db.toFixed(1)} dB`
                    : 'off'}
                inline
            >
                <Switch
                    checked={nb.enabled}
                    onChange={(on) => setNb({ enabled: on })}
                    title="Cut impulse noise — ignition, power-line arcing, fences"
                />
            </Field>
            {!minimal && nb.enabled && (
                <>
                    <Field label="Threshold" hint={`${nb.thresholdDb} dB`}>
                        <Slider
                            value={nb.thresholdDb}
                            min={NB_THRESHOLD_MIN}
                            max={NB_THRESHOLD_MAX}
                            step={1}
                            onChange={(v) => setNb({ thresholdDb: v })}
                        />
                    </Field>
                    {/* The shortest blank. Runs of samples over the
                        threshold extend it themselves, so this is a floor
                        rather than the length of every cut. */}
                    <Field label="Width" hint={`${nb.widthMs} ms`}>
                        <Slider
                            value={nb.widthMs}
                            min={NB_WIDTH_MIN}
                            max={NB_WIDTH_MAX}
                            step={0.5}
                            onChange={(v) => setNb({ widthMs: v })}
                        />
                    </Field>
                    <NbScope thresholdDb={nb.thresholdDb} />
                </>
            )}
            </div>

            <div className="noise-stage">
            <Field label="NR" hint={nr.enabled ? 'on' : 'off'} inline>
                <Switch
                    checked={nr.enabled}
                    onChange={(on) => setNr({ enabled: on })}
                    title="Reduce steady band noise under the audio"
                />
            </Field>
            {/* The engine picker stays in the minimal view, as the server
                section's filter chips do: which engine is a real mid-session
                change, its sliders are not. */}
            {nr.enabled && (
                <Segmented
                    size="sm"
                    value={['nr2', 'rmn'].includes(nr.type) ? nr.type : 'lsa'}
                    onChange={(v) => setNr({ type: v })}
                    options={[
                        {
                            value: 'lsa',
                            label: 'LSA',
                            title: 'MMSE-LSA over tracked minima — no learning phase, best on voice',
                        },
                        {
                            // Labelled NR, stored as 'nr2'. The label is what an
                            // operator reads and there is no NR1 to tell it from;
                            // the value is what saved settings already say, and
                            // renaming that would silently move everybody to the
                            // default engine.
                            value: 'nr2',
                            label: 'NR',
                            title: 'Classic spectral subtraction, long window — v1\u2019s engine, suits narrowband',
                        },
                        {
                            value: 'rmn',
                            label: 'RMN',
                            // Red, in the top bar's Stop colour, until there is
                            // a login to use. It is the one engine here that
                            // cannot simply be switched on: without an account
                            // it selects a stage that passes audio through, and
                            // the only way to find that out was to choose it
                            // and notice nothing happened. Red is the interface
                            // already saying "this one needs you" everywhere
                            // else, so it says it here.
                            className: rmCredentials().username && rmCredentials().password
                                ? undefined : 'segmented__item--alert',
                            title: rmCredentials().username
                                ? 'rmnoise.com — an AI denoiser over the network'
                                : 'rmnoise.com — an AI denoiser over the network. Needs an account: choose this to enter it',
                        },
                    ]}
                />
            )}
            {/* Outside the `enabled` test on purpose: this is what explains an
                engine that has just switched *itself* off, so it has to be
                visible at exactly the moment its controls are not. */}
            {!minimal && nr.type === 'rmn' && !rmModeSupported(tuning.mode) && (
                <div className="note note--warn note--tight">
                    RM Noise only works on SSB and CW — the model is trained on voice
                    bandwidth, and on {String(tuning.mode).toUpperCase()} what comes back is
                    not worth hearing. Switch back to USB, LSB or CW to use it again.
                </div>
            )}

            {/* Nothing of this in the cut-down view, which is switches and
                pickers only — the same rule the other two engines follow, where
                minimal drops their sliders and notes. The connection itself is
                RadioContext's, so a cut-down panel still starts it; what is
                dropped here is the reading of it, not the working of it. */}
            {!minimal && nr.enabled && nr.type === 'rmn' && <RmNoiseControls />}

            {!minimal && nr.enabled && nr.type !== 'rmn' && (
                <>
                    <Field label="Strength" hint={`${nr.strength}%`}>
                        <Slider
                            value={nr.strength}
                            min={0}
                            max={100}
                            step={5}
                            onChange={(v) => setNr({ strength: v })}
                        />
                    </Field>
                    {/* NR2's own knobs; the LSA engine has no equivalents on
                        purpose — its estimator constants interact, and every
                        published implementation ships them fixed. */}
                    {nr.type === 'nr2' && (
                        <>
                            <Field label="Spectral floor" hint={`${nr.floor}%`}>
                                <Slider
                                    value={nr.floor}
                                    min={0}
                                    max={10}
                                    step={0.5}
                                    onChange={(v) => setNr({ floor: v })}
                                />
                            </Field>
                            <Field label="Adaptation" hint={`${Number(nr.adaptRate).toFixed(1)}%`}>
                                <Slider
                                    value={nr.adaptRate}
                                    min={0.1}
                                    max={5}
                                    step={0.1}
                                    onChange={(v) => setNr({ adaptRate: v })}
                                />
                            </Field>
                        </>
                    )}
                    <Field
                        label="Makeup gain"
                        hint={`${nr.makeupDb >= 0 ? '+' : ''}${nr.makeupDb} dB`}
                    >
                        <Slider
                            value={nr.makeupDb}
                            min={-12}
                            max={12}
                            step={0.5}
                            onChange={(v) => setNr({ makeupDb: v })}
                        />
                    </Field>
                    <div className="note note--tight">
                        {nr.type === 'nr2'
                            ? 'Learns the noise floor for half a second, then subtracts it — '
                              + 'the profile re-learns on every retune. Raise the floor if the '
                              + 'residue turns watery.'
                            : 'Tracks the noise floor continuously — nothing to learn and '
                              + 'nothing to reset. Strength sets how deep the cut goes. A '
                              + 'steady, unmodulated carrier reads as noise and fades too.'}
                    </div>
                </>
            )}

            </div>

            {!serverAbsent && (
                <>
                    <div className="section-label"><span>On the receiver</span></div>
                    <div className="noise-stage">
                        <DspControl minimal={minimal} />
                    </div>
                </>
            )}
        </div>
    );
}
