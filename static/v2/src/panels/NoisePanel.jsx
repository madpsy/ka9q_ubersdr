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

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Field, Segmented, Slider, Switch } from '../components/ui.jsx';
import DspControl from './DspControl.jsx';
import {
    NB_THRESHOLD_MAX, NB_THRESHOLD_MIN, NB_WIDTH_MAX, NB_WIDTH_MIN,
} from '../lib/noiseBlanker.js';

// `minimal` keeps every switch — blanker, client NR, and the server insert
// with its filter chips — and drops the sliders and the notes. Which stages
// are working is what you change while listening; how hard they work is set
// once against a band and left.
export default function NoisePanel({ minimal }) {
    const { noise, dsp, player, actions } = useRadio();
    const { nb, nr } = noise;
    const setNb = (patch) => actions.setNoise({ nb: patch });
    const setNr = (patch) => actions.setNoise({ nr: patch });

    // The blanker's running total, polled while it is on. This is the readout
    // the threshold is set against — steady counting on a crackling band is
    // the blanker working, a count racing during clean speech means the
    // threshold is low and it is eating syllables. It restarts from zero when
    // the blanker is toggled, because the DSP is rebuilt then.
    const [nbStats, setNbStats] = useState({ n: 0, cut: 0 });
    useEffect(() => {
        if (!nb.enabled) { setNbStats({ n: 0, cut: 0 }); return undefined; }
        const t = setInterval(
            () => setNbStats({ n: player.nbPulses(), cut: player.nbCut() }),
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

            {/* Pulses caught, then the share of the audio actually being
                removed — "412 · 1.3%". The second number is the one that
                settles "is this doing anything": a count can climb on the odd
                spike while the cut rounds to nothing, which is what a
                mis-set threshold looks like. */}
            <Field
                label="Noise blanker"
                hint={nb.enabled
                    ? `${nbStats.n} · ${(nbStats.cut * 100).toFixed(1)}%`
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
                    <Field label="Width" hint={`${nb.widthMs} ms`}>
                        <Slider
                            value={nb.widthMs}
                            min={NB_WIDTH_MIN}
                            max={NB_WIDTH_MAX}
                            step={0.5}
                            onChange={(v) => setNb({ widthMs: v })}
                        />
                    </Field>
                    <div className="note note--tight">
                        Cuts short clicks out of the audio before they reach anything
                        else — lower the threshold until the crackle goes, raise it if
                        speech starts dropping out. Works alongside any noise
                        reduction, here or on the receiver.
                    </div>
                </>
            )}

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
                    value={nr.type === 'nr2' ? 'nr2' : 'lsa'}
                    onChange={(v) => setNr({ type: v })}
                    options={[
                        {
                            value: 'lsa',
                            label: 'LSA',
                            title: 'MMSE-LSA over tracked minima — no learning phase, best on voice',
                        },
                        {
                            value: 'nr2',
                            label: 'NR2',
                            title: 'Classic spectral subtraction, long window — v1\u2019s engine, suits narrowband',
                        },
                    ]}
                />
            )}
            {!minimal && nr.enabled && (
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

            {!serverAbsent && (
                <>
                    <div className="divider" />
                    <div className="section-label"><span>On the receiver</span></div>
                    <DspControl minimal={minimal} />
                </>
            )}
        </div>
    );
}
