// Ready-made graphs: somewhere to start, and a way to find out what the
// blocks can do without building it all first.
//
// Each is small, works as loaded, and is there to be changed — the summary
// says what to try. They are written without positions and laid out on
// loading, so a template never depends on card sizes staying as they are.

import { GRAPH_VERSION, parseGraph } from './graph.js';
import { autoLayout } from './geometry.js';
import { controlPort } from './block.js';
import { graphForPlan } from './fromPlan.js';
import { DEMOD_MODES, VFO_DEFAULTS, planForVfo } from '../lib/iqDemod.js';

const g = (nodes, wires) => autoLayout(parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph);

// The decoders a test bench is made for, with the transmitter mode each takes.
const BENCHES = [
    { mode: 'cw', decoder: 'cw-decoder', label: 'CW' },
    { mode: 'rtty', decoder: 'rtty-decoder', label: 'RTTY' },
    { mode: 'psk', decoder: 'psk31-decoder', label: 'PSK31' },
    { mode: 'navtex', decoder: 'navtex-decoder', label: 'NAVTEX' },
];

export const TEMPLATES = [
    {
        id: 'listen',
        title: 'Listen with one block',
        summary: 'The receiver’s stream into a Demodulator — the IQ Demod panel’s own — and out to the speakers, with the stream’s spectrum beside it. Change the mode or offset, or Expand the demodulator to see inside.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'demod', type: 'demodulator', params: { mode: 'usb', widthHz: 2700 } },
                { id: 'audio', type: 'audio-out' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'both' } },
            ],
            [['iq', 'out', 'demod', 'in'], ['demod', 'audio', 'audio', 'in'], ['iq', 'out', 'spectrum', 'in']],
        ),
    },
    {
        id: 'strongest',
        title: 'Tune to the strongest signal',
        summary: 'A signal detector watches the stream and steers the demodulator’s offset to whatever is loudest; the log lists signals as they come and go. Raise the detector’s threshold to ignore weak ones.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'detector', type: 'signal-detector', params: { intervalMs: 500 } },
                { id: 'demod', type: 'demodulator', params: { mode: 'am', widthHz: 9000 }, controls: ['offsetHz'] },
                { id: 'audio', type: 'audio-out' },
                { id: 'log', type: 'message-log' },
            ],
            [
                ['iq', 'out', 'detector', 'in'], ['iq', 'out', 'demod', 'in'], ['demod', 'audio', 'audio', 'in'],
                ['detector', 'strongest', 'demod', controlPort('offsetHz')], ['detector', 'events', 'log', 'in'],
            ],
        ),
    },
    {
        id: 'afc',
        title: 'Lock to a carrier',
        summary: 'A frequency lock. The counter measures how far the carrier is from zero after the shift, and the integrator moves the shift until it is nowhere — so a drifting carrier holds still, heard as a steady CW note. Set the integrator’s “Start at” to minus the carrier’s offset, and watch the plot settle.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'shift', type: 'shift', controls: ['frequencyHz'] },
                { id: 'window', type: 'complex-bandpass', params: { lowHz: -400, highHz: 400 } },
                { id: 'counter', type: 'frequency-counter', params: { gateSec: 0.1 } },
                { id: 'loop', type: 'integrator', params: { gain: -0.5, initial: 0, min: -192000, max: 192000 } },
                { id: 'plot', type: 'control-plot' },
                { id: 'demod', type: 'demodulator', params: { mode: 'cwu', widthHz: 500, pitchHz: 700 } },
                { id: 'audio', type: 'audio-out' },
            ],
            [
                ['iq', 'out', 'shift', 'in'], ['shift', 'out', 'window', 'in'], ['window', 'out', 'counter', 'in'],
                ['counter', 'hz', 'loop', 'in'], ['loop', 'out', 'shift', controlPort('frequencyHz')], ['loop', 'out', 'plot', 'in'],
                ['shift', 'out', 'demod', 'in'], ['demod', 'audio', 'audio', 'in'],
            ],
        ),
    },
    {
        id: 'player',
        title: 'Play an IQ file',
        summary: 'No receiver needed. Select the player, load an IQ WAV file — from this receiver, SDR++, HDSDR, SDRuno — and press Start. Everything after it works as it would on the air.',
        build: () => g(
            [
                { id: 'player', type: 'iq-player' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'both' } },
                { id: 'demod', type: 'demodulator', params: { mode: 'usb', widthHz: 2700 } },
                { id: 'audio', type: 'audio-out' },
            ],
            [['player', 'out', 'spectrum', 'in'], ['player', 'out', 'demod', 'in'], ['demod', 'audio', 'audio', 'in']],
        ),
    },
    {
        id: 'record',
        title: 'Record IQ',
        summary: 'The stream to a stereo IQ WAV file, named with its frequency so the player can label it again. Press record on the recorder’s card once running.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'recorder', type: 'iq-recorder' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'spectrum' } },
            ],
            [['iq', 'out', 'recorder', 'in'], ['iq', 'out', 'spectrum', 'in']],
        ),
    },
    {
        id: 'filter-bench',
        title: 'Look at a filter',
        summary: 'A test bench, no receiver needed: a generator through an audio low-pass, with a scope showing input (A) against output (B) and a gain-and-phase meter across it. Sweep the generator’s frequency past the cutoff and watch the output fall and lag.',
        build: () => g(
            [
                { id: 'gen', type: 'signal', params: { frequencyHz: 800, amplitude: 0.5 } },
                { id: 'real', type: 'real-part' },
                { id: 'filter', type: 'audio-lowpass', params: { cutoffHz: 1500 } },
                { id: 'scope', type: 'scope', params: { timebaseMs: 5, range: 0.5 } },
                { id: 'phase', type: 'phase-meter' },
                { id: 'audio', type: 'audio-out' },
            ],
            [
                ['gen', 'out', 'real', 'in'], ['real', 'out', 'filter', 'in'], ['filter', 'out', 'audio', 'in'],
                ['real', 'out', 'scope', 'a'], ['filter', 'out', 'scope', 'b'],
                ['real', 'out', 'phase', 'a'], ['filter', 'out', 'phase', 'b'],
            ],
        ),
    },
    {
        id: 'audio-bench',
        title: 'Scope the audio',
        summary: 'A demodulator’s output on an oscilloscope and an audio spectrum, with its level on a meter — what a receiver is actually putting out.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'demod', type: 'demodulator', params: { mode: 'usb', widthHz: 2700 } },
                { id: 'audio', type: 'audio-out' },
                { id: 'scope', type: 'scope', params: { timebaseMs: 20 } },
                { id: 'spectrum', type: 'audio-spectrum', params: { display: 'both' } },
                { id: 'meter', type: 'meter' },
            ],
            [
                ['iq', 'out', 'demod', 'in'], ['demod', 'audio', 'audio', 'in'], ['demod', 'audio', 'scope', 'a'],
                ['demod', 'audio', 'spectrum', 'in'], ['demod', 'audio', 'meter', 'in'],
            ],
        ),
    },
    {
        id: 'rtty',
        title: 'Decode RTTY',
        summary: 'Amateur radioteletype — 45.45 baud, 170 Hz shift — to text. Tune USB so the signal sits a little above the dial, set the decoder’s offset to its centre (the spectrum’s marker helps), and read the console.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'both' } },
                { id: 'rtty', type: 'rtty-decoder', params: { offsetHz: 1000 } },
                { id: 'console', type: 'console' },
            ],
            [['iq', 'out', 'spectrum', 'in'], ['iq', 'out', 'rtty', 'in'], ['rtty', 'text', 'console', 'in']],
        ),
    },
    {
        id: 'psk31',
        title: 'Decode PSK31',
        summary: 'PSK31 to text. Set the decoder’s offset near a signal — within 30 Hz — and auto-tune pulls it in; the card says where it settled. Expand the decoder to see its constellation and the tuning loop.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'both' } },
                { id: 'psk', type: 'psk31-decoder', params: { offsetHz: 1000 } },
                { id: 'console', type: 'console' },
            ],
            [['iq', 'out', 'spectrum', 'in'], ['iq', 'out', 'psk', 'in'], ['psk', 'text', 'console', 'in']],
        ),
    },
    {
        id: 'cw',
        title: 'Decode CW',
        summary: 'Morse to text, finding the sender’s speed itself. Set the offset to the signal and narrow the bandwidth on a crowded band.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'both' } },
                { id: 'cw', type: 'cw-decoder', params: { offsetHz: 700 } },
                { id: 'console', type: 'console' },
            ],
            [['iq', 'out', 'spectrum', 'in'], ['iq', 'out', 'cw', 'in'], ['cw', 'text', 'console', 'in']],
        ),
    },
    {
        id: 'navtex',
        title: 'Decode NAVTEX',
        summary: 'Maritime safety broadcasts on 518 kHz (and 490, and 4209.5). Tune 1 kHz below the channel in IQ, leave the offset at +1000, and wait for the next transmission — they run to a schedule.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'both' } },
                { id: 'navtex', type: 'navtex-decoder', params: { offsetHz: 1000 } },
                { id: 'console', type: 'console' },
            ],
            [['iq', 'out', 'spectrum', 'in'], ['iq', 'out', 'navtex', 'in'], ['navtex', 'text', 'console', 'in']],
        ),
    },
    {
        id: 'rtty-inside',
        title: 'Look inside RTTY',
        summary: 'The RTTY decoder taken apart: the FSK detector’s output on a scope is the signal’s eye — open and square on a clean signal, closing as noise and fading take over — and the start-stop decoder turns it into characters.',
        build: () => g(
            [
                { id: 'iq', type: 'iq-in' },
                { id: 'shift', type: 'shift', params: { frequencyHz: -1000 } },
                { id: 'fsk', type: 'fsk-detector' },
                { id: 'eye', type: 'scope', params: { timebaseMs: 44, range: 1, mode: 'auto' } },
                { id: 'uart', type: 'uart' },
                { id: 'ita2', type: 'ita2-decoder' },
                { id: 'console', type: 'console' },
            ],
            [
                ['iq', 'out', 'shift', 'in'], ['shift', 'out', 'fsk', 'in'], ['fsk', 'out', 'eye', 'a'], ['fsk', 'out', 'uart', 'in'],
                ['uart', 'codes', 'ita2', 'codes'], ['ita2', 'text', 'console', 'in'],
            ],
        ),
    },
    // One for each of IQ Demod's modes, after the hand-made ones.
    ...DEMOD_MODES.map(modeTemplate),
    // And a bench for each decoder, with a transmitter to feed it.
    ...BENCHES.map(benchTemplate),
];

/**
 * A decoder with a transmitter feeding it, no receiver needed: what was sent
 * on one console and what was decoded on another, side by side, both passed on
 * to a Text difference that marks where they part and gives the error rate,
 * and the signal on a spectrum. Both sit 1 kHz up, so moving one's offset and
 * not the other's is the first thing to try.
 */
function benchTemplate(b) {
    return {
        id: `bench-${b.mode}`,
        group: 'Decoder test benches',
        title: `Test the ${b.label} decoder`,
        summary: `A data transmitter sending ${b.label} into the ${b.label} decoder, no receiver needed: what was sent and what was decoded side by side, and a Text difference marking every mistake with the error rate. Switch on noise and lower the SNR to watch the errors start.`,
        build: () => g(
            [
                { id: 'tx', type: 'data-tx', params: { mode: b.mode, offsetHz: 1000 } },
                { id: 'decoder', type: b.decoder, params: { offsetHz: 1000 } },
                { id: 'console', type: 'console' },
                { id: 'sent', type: 'console' },
                { id: 'diff', type: 'text-diff' },
                { id: 'spectrum', type: 'iq-spectrum', params: { display: 'both' } },
            ],
            [
                ['tx', 'out', 'decoder', 'in'], ['decoder', 'text', 'console', 'in'],
                ['tx', 'sent', 'sent', 'in'], ['tx', 'out', 'spectrum', 'in'],
                ['sent', 'out', 'diff', 'sent'], ['console', 'out', 'diff', 'received'],
            ],
        ),
    };
}

/**
 * An IQ Demod mode drawn out block by block, as "From IQ Demod" draws the
 * panel's selected demodulator — but as a freshly added one in that mode
 * would be, from the panel's own defaults, so it is the same whatever the
 * panel happens to be set to. Built for the stream's rate, where the modal
 * gives one, so a wide stream gets the decimator the panel would use.
 */
function modeTemplate(m) {
    return {
        id: `mode-${m.id}`,
        group: 'IQ Demod’s modes, taken apart',
        title: `${m.label}, block by block`,
        summary: `${m.summary} IQ Demod’s ${m.label} demodulator, built from its parts rather than as one Demodulator block: every filter, detector and level is there to look at and change.`,
        build: (rateHz = 12000) => {
            const vfo = { ...VFO_DEFAULTS, mode: m.id };
            return autoLayout(parseGraph(graphForPlan(planForVfo(vfo), rateHz, {
                agc: vfo.agc, gain: vfo.gain, squelchDb: vfo.squelchDb, lockMute: vfo.lockMute, adaptive: true,
            })).graph);
        },
    };
}

export const TEMPLATE_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
