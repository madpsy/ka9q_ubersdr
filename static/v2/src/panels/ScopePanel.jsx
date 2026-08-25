// Audio oscilloscope and audio waterfall — v1's "Audio visualization" section.
//
// Two views over the decoded audio, shown separately or together:
//
//   scope      time domain, with a timebase you can set and an auto-scaled
//              vertical axis, so a carrier or a CW note reads as a waveform
//   waterfall  the audio spectrum over time, in the same palette as the RF
//              waterfall, across the passband the current mode actually carries
//
// Both read one AnalyserNode from the audio player. Nothing here runs unless
// the panel is on screen: a collapsed section is not rendered at all, so the
// effect below never mounts, no getByteTimeDomainData/getFloatFrequencyData
// call is made — an AnalyserNode only transforms when it is read — and the
// node's FFT size drops back to its resting value on unmount.
//
// The x axis is the *useful* audio bandwidth, not Nyquist: see lib/audioBand.js
// for how the mode's passband maps onto FFT bins, which is where LSB (negative
// passband), AM (straddling zero) and CW (500 Hz tone offset) are handled.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Empty, Field, Segmented, Slider, Switch } from '../components/ui.jsx';
import { isIQ } from '../radio/constants.js';
import { audioBins } from '../lib/audioBand.js';
import { subscribeAudioSpectrum } from '../lib/audioSpectrum.js';
import { accumulateAudioStats, newAudioStats, readAudioStats } from '../lib/audioStats.js';
import {
    AUDIO_WF_RATE_MAX, AUDIO_WF_RATE_MIN,
    SCOPE_FLOOR_DEFAULT, SCOPE_FLOOR_MAX, SCOPE_FLOOR_MIN,
    cssVar, drawAudioBars, drawAudioRuler, drawAudioWaterfall, fmtHz, newBarLevel, newRing, sizedCanvas,
} from '../lib/audioWaterfall.js';

const VIEWS = [
    { value: 'both', label: 'Both' },
    { value: 'scope', label: 'Scope' },
    { value: 'waterfall', label: 'Waterfall' },
];

// Analysis resolution. It sets the waterfall's Hz/bin, and — because the bars
// have far more bins available than a canvas has room for at any of these — the
// width of a bar, and so how many of them there are. See barWidth.
const FFT_SIZES = [
    { value: 2048, label: 'Fast' },
    { value: 4096, label: 'Balanced' },
    { value: 8192, label: 'Detail' },
    { value: 16384, label: 'Max' },
];

const SCOPE_H = 96;
const WF_H = 120;
const RULER_H = 13;
// Silence guards. With the squelch closed the server sends nothing, or sends
// dither a hundred dB down, and an unbounded auto-scale turns that into a
// full-height mess of quantisation noise and a boiling waterfall. Both views
// therefore refuse to magnify beyond a point, and fall back to a flat line and
// a dark waterfall — which is what "no audio" should look like.
const SCOPE_MIN_PEAK = 0.05;   // fraction of full scale; below this, no extra gain
const SCOPE_SILENT_LSB = 2;    // +/-2/128 or less is the gate closed, not a signal

// `minimal` keeps the canvases and drops everything else: the view switch, the
// settings under them (timebase, waterfall speed, contrast, resolution) and the
// bandwidth line. All of it still applies — it is just not on show. See the
// registry's `minimal`.
export default function ScopePanel({ minimal }) {
    const { player, running, tuning } = useRadio();
    const display = useDisplay();

    const [view, setView] = useState(display.scopeView || 'both');
    const [fftSize, setFftSize] = useState(display.scopeFft || 4096);
    const [timebase, setTimebase] = useState(display.scopeTimebase || 20);   // ms across the scope
    const [contrast, setContrast] = useState(display.scopeContrast || 1);
    const [wfRate, setWfRate] = useState(display.scopeRate || AUDIO_WF_RATE_MAX);   // rows/s
    const [rate, setRate] = useState(null);   // audio sample rate, once known
    // What the top canvas is: the waveform, or the spectrum as bars.
    //
    // A tap on the picture rather than a control beside it. The two are the
    // same thing seen two ways and the choice is made by looking — you switch
    // because what is on screen is not answering the question — so the picture
    // is the right place to press. It is also the only control the minimal view
    // could have, where there is nothing but the canvases.
    const [shape, setShape] = useState(display.scopeShape === 'wave' ? 'wave' : 'bars');
    // Auto ranging, or a floor the operator chose.
    //
    // Auto is right most of the time and has one cost: it is *relative*. The
    // quietest bin sets the bottom of the scale, so quiet audio is magnified
    // until it fills the display exactly as loud audio does — which makes the
    // picture unable to answer "is this signal weak, or is my volume down".
    // A fixed floor with the ceiling at full scale makes it absolute, and low
    // levels read as low.
    const [autoLevel, setAutoLevel] = useState(display.scopeAuto !== false);
    const [floorDb, setFloorDb] = useState(
        Number.isFinite(display.scopeFloor) ? display.scopeFloor : SCOPE_FLOOR_DEFAULT,
    );

    // The numbers under the pictures. On by default, and shown in the minimal
    // view too: they are the same kind of thing as the pictures — something
    // read at a glance — so a side dock showing the traces should show them.
    const stats = display.scopeStats !== false;

    const scopeRef = useRef(null);
    const wfRef = useRef(null);
    const rulerRef = useRef(null);
    // Waterfall history, kept as an offscreen canvas so a row is one blit.
    const ring = useRef(newRing());
    // Latest FFT frame plus the window it covers, so the hover readout can be
    // answered from the pointer handler without running its own analysis.
    const last = useRef(null);
    const hover = useRef(null);      // pointer position while over the waterfall
    const tipAt = useRef(0);
    const [tip, setTip] = useState(null);
    // The averaged spectrum the Stats row is read from, and the last reading
    // taken off it. The average is a ref because it is written on every frame
    // and rendering it would be pointless; the reading is state because it is
    // what gets drawn, and is refreshed on a timer rather than per frame.
    const statsAcc = useRef(newAudioStats());
    const statsAt = useRef(0);
    const [statsRead, setStatsRead] = useState(null);
    // Smoothed vertical gain for the scope, so the trace does not jump as the
    // gate opens and closes.
    const scope = useRef({ gain: 1 });
    // The bar view's auto-level, which is its own: it and the waterfall ease
    // towards the same target but are not the same instrument, and sharing one
    // would have whichever drew second ease twice as fast.
    const barLevel = useRef(newBarLevel());
    const barRulerRef = useRef(null);
    // The bars get their own pointer state rather than sharing the waterfall's.
    // With both views on screen there are two canvases and one pointer, and one
    // shared record would put a tooltip over each of them — the one being
    // pointed at, and a copy on the other.
    const barHover = useRef(null);
    const barTipAt = useRef(0);
    const [barTip, setBarTip] = useState(null);

    const iq = isIQ(tuning.mode);
    const showScope = view !== 'waterfall';
    const showWf = view !== 'scope';
    const bars = showScope && shape === 'bars';
    // The bar view's two extras. Read here rather than inside the draw so the
    // effect has them as dependencies and a toggle repaints at once, rather
    // than at whatever rate the audio happens to be arriving.
    const peaks = display.scopePeaks !== false;
    const heat = display.scopeHeat !== false;

    // Persist the choices with the other display settings.
    useEffect(() => {
        display.set({
            scopeView: view,
            scopeFft: fftSize,
            scopeTimebase: timebase,
            scopeContrast: contrast,
            scopeRate: wfRate,
            scopeShape: shape,
            scopeAuto: autoLevel,
            scopeFloor: floorDb,
        });
    }, [view, fftSize, timebase, contrast, wfRate, shape, autoLevel, floorDb]);   // eslint-disable-line

    useEffect(() => {
        // Nothing to look at in IQ, and nothing is read: no subscription means
        // no FFT, since an AnalyserNode only transforms when something reads it.
        // See the note by the empty state below for why there is no IQ view.
        if (iq) return undefined;
        // One shared FFT: the filter panel's preview reads the same node, and
        // whichever of them is open drives it (see lib/audioSpectrum.js).
        // Bars need the spectrum, not the waveform — so what is asked of the
        // analyser follows the shape, and a scope showing bars costs no
        // time-domain read at all.
        return subscribeAudioSpectrum(player, {
            // Stats are read from the spectrum, so they need the bins even in
            // the waveform view where nothing else does.
            fftSize, bins: showWf || bars || stats, wave: showScope && !bars,
        }, (f) => {
            if (f.sampleRate !== rate) setRate(f.sampleRate);
            if (stats) {
                accumulateAudioStats(statsAcc.current, f, tuning);
                const now = performance.now();
                if (now - statsAt.current >= STATS_MS) {
                    statsAt.current = now;
                    setStatsRead(readAudioStats(statsAcc.current, f.sampleRate, f.binCount, tuning));
                }
            }
            if (bars) {
                // The frame the tooltip is answered from, kept whichever view
                // drew it: the readings are the frame's, not the picture's.
                last.current = { bins: f.bins, sampleRate: f.sampleRate, binCount: f.binCount, tuning };
                refreshTip(barHover.current, last.current, barTipAt, setBarTip);
                drawAudioBars({
                    canvas: scopeRef.current,
                    bins: f.bins,
                    binCount: f.binCount,
                    sampleRate: f.sampleRate,
                    tuning,
                    palette: display.palette,
                    contrast,
                    level: barLevel.current,
                    floorDb: autoLevel ? null : floorDb,
                    fftSize,
                    peaks,
                    heat,
                });
                drawAudioRuler(barRulerRef.current, tuning, f.sampleRate, f.binCount);
            } else if (showScope) {
                drawScope(scopeRef.current, f.wave, f.sampleRate, timebase, scope.current);
            }
            if (showWf) {
                last.current = { bins: f.bins, sampleRate: f.sampleRate, binCount: f.binCount, tuning };
                refreshTip(hover.current, last.current, tipAt, setTip);
                drawAudioWaterfall({
                    canvas: wfRef.current,
                    ring: ring.current,
                    bins: f.bins,
                    binCount: f.binCount,
                    sampleRate: f.sampleRate,
                    tuning,
                    palette: display.palette,
                    contrast,
                    rowsPerSec: wfRate,
                    floorDb: autoLevel ? null : floorDb,
                });
                drawAudioRuler(rulerRef.current, tuning, f.sampleRate, f.binCount);
            }
        });
    }, [player, fftSize, showScope, showWf, bars, peaks, heat, timebase, tuning, display.palette, contrast, rate,
        wfRate, autoLevel, floorDb, iq, stats]);

    // A new passband, a new resolution or a stopped stream all make the
    // accumulated average describe something that is no longer on screen.
    useEffect(() => {
        statsAcc.current = newAudioStats();
        setStatsRead(null);
    }, [tuning.mode, tuning.bandwidthLow, tuning.bandwidthHigh, fftSize, rate, running, stats]);

    const bins = audioBins(tuning.bandwidthLow, tuning.bandwidthHigh, rate || 48000, 1024);

    // Cursor and peak, the two lines v1 shows over its audio spectrum and
    // waterfall (app.js updateAudioSpectrumTooltip). The pointer position is
    // only stored here — the numbers are refreshed from the draw loop, so they
    // track the audio while the mouse sits still.
    const onHover = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        hover.current = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
    };

    const tipText = (hz, db) => `${fmtHz(hz)} Hz | ${Number.isFinite(db) ? db.toFixed(1) : '-∞'} dB`;

    // Cursor and peak, over whichever picture the pointer is on. Its own
    // component because there are two of those now and the placement rules —
    // flipping to the other side near the right edge so the box stays on the
    // canvas — are worth having in one place rather than two.
    const HoverTip = ({ tip: at }) => {
        if (!at) return null;
        return (
            <div
                className="spec-tip"
                style={{
                    left: at.x + (at.x > at.w - 150 ? -12 : 12),
                    top: at.y + 10,
                    transform: at.x > at.w - 150 ? 'translateX(-100%)' : undefined,
                }}
            >
                <div>Cursor: {tipText(at.freq, at.db)}</div>
                <div>Peak: {tipText(at.peakFreq, at.peakDb)}</div>
            </div>
        );
    };

    // Both views read one AnalyserNode, which is a real-input FFT sitting after
    // the channel merger — so in IQ it would transform I+Q summed, which is not
    // a spectrum of anything. Showing I and Q as two separate real FFTs would
    // not help either: each is mirror-symmetric about DC and so cannot tell
    // +1 kHz from -1 kHz, and the two have near-identical magnitude spectra
    // anyway, differing only in phase.
    //
    // The view that *would* be right is a complex FFT of I+jQ, and the RF
    // waterfall already is one: it reaches a 10.24 kHz span — the whole of what
    // a 10 kHz IQ stream carries — at the server's own resolution and with the
    // sidebands the correct way round, and now zooms past it besides.
    // Rebuilding that here in JS would duplicate it, worse.
    //
    // Left in the dock rather than removed, so the reason is where the picture
    // was instead of the panel quietly vanishing on a mode change.
    if (iq) {
        return (
            <Empty>
                Not available in IQ mode — the stream is a quadrature pair, not
                audio. Use the main waterfall, which shows the same span.
            </Empty>
        );
    }

    return (
        <div className="stack">
            {/* Which of the two views is on is a setting like the rest, and the
                minimal view is the picture on its own. Whatever is chosen still
                applies — it is just not on show. */}
            {!minimal && <Segmented options={VIEWS} value={view} onChange={setView} size="sm" />}

            {showScope && (
                <div className={`scope${bars ? ' scope--hover' : ''}`}>
                    <canvas
                        ref={scopeRef}
                        className="scope__canvas scope__canvas--tap"
                        style={{ height: SCOPE_H }}
                        title={bars ? 'Spectrum bars — tap for the waveform' : 'Waveform — tap for spectrum bars'}
                        onClick={() => setShape(bars ? 'wave' : 'bars')}
                        // Only the bars have a frequency under the pointer to
                        // report. A waveform's x axis is time, and the same
                        // readout over it would be answering a question nobody
                        // asked of it.
                        onPointerMove={bars ? (e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            barHover.current = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
                        } : undefined}
                        onPointerLeave={bars ? () => { barHover.current = null; setBarTip(null); } : undefined}
                    />
                    {/* The frequencies the bars are standing on. Only with the
                        bars: a waveform's x axis is time, and a frequency scale
                        under it would be a scale for the wrong axis. */}
                    {bars && (
                        <canvas
                            ref={barRulerRef}
                            className="scope__canvas scope__ruler"
                            style={{ height: RULER_H }}
                        />
                    )}
                    {bars && <HoverTip tip={barTip} />}
                </div>
            )}

            {showWf && (
                <div className="scope scope--hover">
                    <canvas
                        ref={wfRef}
                        className="scope__canvas"
                        style={{ height: WF_H }}
                        onPointerMove={onHover}
                        onPointerLeave={() => { hover.current = null; setTip(null); }}
                    />
                    <canvas ref={rulerRef} className="scope__canvas scope__ruler" style={{ height: RULER_H }} />
                    <HoverTip tip={tip} />
                </div>
            )}

            {stats && <StatsRow read={statsRead} />}

            {!minimal && showScope && (
                <Field label="Timebase" hint={`${timebase} ms`}>
                    <Slider value={timebase} min={2} max={200} step={1} onChange={setTimebase} />
                </Field>
            )}

            {/* Beside the RF waterfall's own speed control in the Display
                panel, and the same units. Independent of it: the two waterfalls
                are watched for different things. */}
            {!minimal && showWf && (
                <Field label="Waterfall speed" hint={`${wfRate} rows/s`}>
                    <Slider
                        value={wfRate}
                        min={AUDIO_WF_RATE_MIN}
                        max={AUDIO_WF_RATE_MAX}
                        onChange={setWfRate}
                    />
                </Field>
            )}

            {/* Level ranging, and where the bottom of the scale sits when it is
                not automatic. Offered whenever either picture is on, because
                both are drawn in the same dB window — see levelWindow. */}
            {!minimal && (showWf || bars) && (
                <Field label="Levels" hint={autoLevel ? 'follows the audio' : `${Math.round(floorDb)} dB to full scale`}>
                    <Segmented
                        options={[
                            { value: 'auto', label: 'Auto' },
                            { value: 'manual', label: 'Manual' },
                        ]}
                        value={autoLevel ? 'auto' : 'manual'}
                        onChange={(v) => setAutoLevel(v === 'auto')}
                        size="sm"
                    />
                </Field>
            )}

            {/* Only with a manual scale: in auto it would be a control that
                does nothing, which is worse than one that is not there. */}
            {!minimal && (showWf || bars) && !autoLevel && (
                <Field label="Floor" hint={`${Math.round(floorDb)} dB`}>
                    <Slider
                        value={floorDb}
                        min={SCOPE_FLOOR_MIN}
                        max={SCOPE_FLOOR_MAX}
                        step={1}
                        onChange={setFloorDb}
                    />
                </Field>
            )}

            {!minimal && showWf && (
                <Field label="Contrast" hint={contrast.toFixed(2)}>
                    <Slider value={contrast} min={0.4} max={2.5} step={0.05} onChange={setContrast} />
                </Field>
            )}

            {/* The bar view's two extras, side by side because they are the
                same kind of choice — what is drawn besides the bars — and
                because each is a word and a switch. Only with the bars
                showing: neither means anything over a waveform or a
                waterfall. */}
            {!minimal && bars && (
                <Field label="Bars">
                    <div className="scope__toggles">
                        <Switch
                            checked={peaks}
                            onChange={(v) => display.set({ scopePeaks: v })}
                            label="Peak"
                            title="A mark that jumps to each bar's top and falls back, holding the loudest moment for a second after the bar has dropped"
                        />
                        <Switch
                            checked={heat}
                            onChange={(v) => display.set({ scopeHeat: v })}
                            label="Heat"
                            title="Colours the space above the bars by how much of the audio's energy each part of the band is carrying — green for an average share, red for more, blue for less"
                        />
                    </div>
                </Field>
            )}

            {/* Not with the bar switches above: those describe what is drawn on
                the bars, while this is read from the spectrum whichever view is
                showing it — including the waveform, which has no spectrum on
                screen at all. */}
            {!minimal && (
                <Field label="Readout">
                    <div className="scope__toggles">
                        <Switch
                            checked={stats}
                            onChange={(v) => display.set({ scopeStats: v })}
                            label="Stats"
                            title="Numbers under the pictures: where the loudest audio is, how far above the noise it sits, and where the energy is centred — averaged over about a third of a second so they can be read"
                        />
                    </div>
                </Field>
            )}

            {/* Offered for the bars as well as the waterfall: it sets how many
                bars there are (lib/audioWaterfall.js barWidth), so gating it on
                the waterfall would leave a scope-only bar view with a control
                it can see the effect of but not reach. */}
            {!minimal && (showWf || bars) && (
                <Field label="Resolution" hint={rate ? `${Math.round(rate / fftSize)} Hz/bin` : ''}>
                    <Segmented
                        options={FFT_SIZES.map((f) => ({ value: String(f.value), label: f.label }))}
                        value={String(fftSize)}
                        onChange={(v) => setFftSize(Number(v))}
                        size="sm"
                    />
                </Field>
            )}

            {/* The bandwidth line goes with the settings, but "start the
                receiver" stays either way: without it two blank canvases are
                the only thing a stopped receiver shows here. */}
            {(!minimal || !running) && (
                <div className="note note--tight">
                    {!running
                        ? 'Start the receiver to see audio.'
                        : `${fmtHz(bins.startFreq)}–${fmtHz(bins.endFreq)} Hz of ${fmtHz((rate || 48000) / 2)} Hz available`}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// A few times a second, not per frame: the numbers must follow the audio while
// the pointer is still, but a two-line label does not need 60 Hz of React.
const TIP_MS = 150;

// The Stats row's own refresh. Slower than the tooltip: the tooltip follows a
// pointer that is being held somewhere on purpose, while these are read at a
// glance, and numbers that change four times a second are already at the limit
// of what can be read rather than watched.
const STATS_MS = 250;

function refreshTip(at, l, tipAt, setTip) {
    if (!at || !l) return;
    const now = performance.now();
    if (now - tipAt.current < TIP_MS) return;
    tipAt.current = now;

    const { start, count, startFreq, endFreq } = audioBins(
        l.tuning.bandwidthLow, l.tuning.bandwidthHigh, l.sampleRate, l.binCount,
    );
    if (!count) return;

    const frac = Math.max(0, Math.min(1, at.x / at.w));
    const cursor = start + Math.min(count - 1, Math.floor(frac * count));
    let peak = start;
    for (let i = start; i < start + count; i++) if (l.bins[i] > l.bins[peak]) peak = i;

    const freqOf = (bin) => startFreq + ((bin - start) / count) * (endFreq - startFreq);
    setTip({
        x: at.x,
        y: at.y,
        w: at.w,
        freq: freqOf(cursor),
        db: l.bins[cursor],
        peakFreq: freqOf(peak),
        peakDb: l.bins[peak],
    });
}



// The Stats row: what the spectrum says, in words, under the picture that says
// it in colour.
//
// Four readings, in the order they get used. Peak first because it is the one
// people come for — zero-beating a carrier, checking a tone, watching a drift.
// SNR beside it because a peak frequency means nothing until you know whether
// the peak is a signal; a dash of a few dB is the noise floor's own wobble.
// Centre and floor last, as context.
//
// A dash rather than a zero before there is anything to say: an empty reading
// and a reading of nothing are different, and only one of them is true when the
// stream has not started.
function StatsRow({ read }) {
    const hz = (v) => (Number.isFinite(v) ? `${fmtHz(v)} Hz` : '—');
    const db = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '—');

    return (
        <div className="scope-stats">
            <div className="scope-stats__item" title="Loudest frequency in the passband, interpolated between bins">
                <span className="scope-stats__label">Peak</span>
                <span className="scope-stats__value">{read ? hz(read.peakHz) : '—'}</span>
            </div>
            <div className="scope-stats__item" title="How far the peak stands above the median bin — the noise floor of the passband, not the receiver's SNR">
                <span className="scope-stats__label">SNR</span>
                <span className="scope-stats__value">{read ? db(read.snrDb) : '—'}</span>
            </div>
            <div className="scope-stats__item" title="Where the audio's energy is centred. On the peak for a tone; away from it when the energy is spread, as in speech or noise">
                <span className="scope-stats__label">Centre</span>
                <span className="scope-stats__value">{read ? hz(read.centroidHz) : '—'}</span>
            </div>
            <div className="scope-stats__item" title="The median bin level, as the passband's noise floor">
                <span className="scope-stats__label">Floor</span>
                <span className="scope-stats__value">{read ? db(read.floorDb) : '—'}</span>
            </div>
        </div>
    );
}

function drawScope(canvas, wave, sampleRate, timebaseMs, state) {
    if (!canvas || !wave || !wave.length) return;
    const { w, h, dpr } = sizedCanvas(canvas);
    const c = canvas.getContext('2d');
    c.fillStyle = cssVar('--spec-bg', '#0a0e15');
    c.fillRect(0, 0, w, h);

    // Grid: a line every 25% vertically, and one per millisecond-ish column.
    c.strokeStyle = cssVar('--spec-grid', 'rgba(255,255,255,0.06)');
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const y = Math.round((h * i) / 4) + 0.5;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
    }
    for (let i = 1; i < 8; i++) {
        const x = Math.round((w * i) / 8) + 0.5;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
    }

    // How many samples the requested timebase covers, capped by what the
    // analyser holds.
    const want = Math.max(16, Math.round((timebaseMs / 1000) * sampleRate));
    const n = Math.min(wave.length, want);
    const first = wave.length - n;

    // Rising-edge trigger near the mid-line, so a periodic signal stands still
    // instead of sliding across the screen — v1's "auto sync".
    let start = first;
    for (let i = first; i < wave.length - 1 && i < first + n / 2; i++) {
        if (wave[i] < 128 && wave[i + 1] >= 128) { start = i; break; }
    }
    const count = Math.min(n, wave.length - start);

    // Auto-scale: fit the peak in this window to 90% of the height, but never
    // amplify a silent line — with the gate closed the only thing left is +/-1
    // LSB of quantisation noise, and full-scaling that looks like a fault.
    // The gain is eased so the trace settles rather than snapping.
    let peak = 0;
    for (let i = start; i < start + count; i++) {
        const d = Math.abs(wave[i] - 128);
        if (d > peak) peak = d;
    }
    // Flat line rather than magnified dither: a closed gate is silence, and
    // drawing it as a jagged full-height trace reads as a broken receiver.
    if (peak <= SCOPE_SILENT_LSB) {
        c.strokeStyle = cssVar('--text-faint', '#5c6779');
        c.lineWidth = 1.4 * dpr;
        c.beginPath();
        c.moveTo(0, h / 2);
        c.lineTo(w, h / 2);
        c.stroke();
        state.gain = 0;
        return;
    }

    const usable = Math.max(peak / 128, SCOPE_MIN_PEAK) * 128;
    const target = (h / 2) * 0.9 / usable;
    state.gain = state.gain > 0 ? state.gain + (target - state.gain) * 0.15 : target;
    const gain = state.gain;

    c.beginPath();
    for (let i = 0; i < count; i++) {
        const x = (i / (count - 1)) * w;
        const y = h / 2 - (wave[start + i] - 128) * gain;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.strokeStyle = cssVar('--accent', '#08a2fb');
    c.lineWidth = 1.4 * dpr;
    c.stroke();
}


