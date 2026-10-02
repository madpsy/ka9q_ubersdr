// Entry point for the playground engine's tests.
import { DemodChain, planFor, setIQSpan } from '../src/lib/iqDemod.js';
import { BLOCKS, BLOCK_BY_TYPE } from '../src/playground/blocks/index.js';
import { COMPLEX, REAL, makeBuffer, sanitizeParams } from '../src/playground/block.js';
import { GRAPH_VERSION, compile, emptyGraph, parseGraph, serializeGraph } from '../src/playground/graph.js';
import { Runtime } from '../src/playground/runtime.js';
import { graphForPlan } from '../src/playground/fromPlan.js';
import { createWorkerCore, STATS_EVERY_MS } from '../src/playground/workerCore.js';
import { biquadCoefficients, biquadGainAt } from '../src/lib/dsp/biquad.js';
import { PROBES, acrossPair, addAcross, addProbe, frequencyOrigins, inputOrigin } from '../src/playground/probes.js';
import { nodeHeight, nodeWidth } from '../src/playground/geometry.js';
import { canConnect, exposeControl } from '../src/playground/editing.js';
import { controlPort, inputsOf } from '../src/playground/block.js';
import { parseChoices } from '../src/playground/blocks/controls.js';
import { demodPlan } from '../src/playground/blocks/radio.js';
import { expandDecoder, expandDemodulator } from '../src/playground/expand.js';
import { resampleRatio } from '../src/lib/dsp/resample.js';
import { findSignals } from '../src/playground/blocks/messages.js';
import { TEMPLATES } from '../src/playground/templates.js';
import { MORSE, VARICODE, encodeIta2, encodeMorse, encodeSitorB, encodeVaricode } from '../src/playground/codes.js';
import { SNR_BANDWIDTH_HZ, TEST_MESSAGES, Transmitter } from '../src/playground/transmit.js';
import { alignText, normaliseText } from '../src/playground/textdiff.js';
// The Noise panel's engines and the playground's copies of them.
import { NRProcessor as PanelNR } from '../src/lib/nr.js';
import { NR2Processor as PanelNR2 } from '../src/lib/nr2.js';
import { NoiseBlanker as PanelNB } from '../src/lib/noiseBlanker.js';
import { NRProcessor as CopyNR } from '../src/playground/noise/nr.js';
import { NR2Processor as CopyNR2 } from '../src/playground/noise/nr2.js';
import { NoiseBlanker as CopyNB } from '../src/playground/noise/noiseBlanker.js';

module.exports = {
    DemodChain, planFor, setIQSpan,
    BLOCKS, BLOCK_BY_TYPE, COMPLEX, REAL, makeBuffer, sanitizeParams,
    GRAPH_VERSION, compile, emptyGraph, parseGraph, serializeGraph,
    Runtime, graphForPlan, createWorkerCore, STATS_EVERY_MS, biquadCoefficients, biquadGainAt,
    PROBES, acrossPair, addAcross, addProbe, frequencyOrigins, inputOrigin, nodeHeight, nodeWidth,
    canConnect, exposeControl, controlPort, inputsOf, parseChoices, demodPlan, expandDemodulator, expandDecoder, resampleRatio, findSignals, TEMPLATES,
    MORSE, VARICODE, encodeIta2, encodeMorse, encodeSitorB, encodeVaricode,
    SNR_BANDWIDTH_HZ, TEST_MESSAGES, Transmitter, alignText, normaliseText,
    PanelNR, PanelNR2, PanelNB, CopyNR, CopyNR2, CopyNB,
};
