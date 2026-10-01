// Entry point for the playground engine's page-side tests: the worker's
// protocol, audio routing, recording, sharing and the one-at-a-time rule.
import { DemodChain, IQDemod, planFor } from '../src/lib/iqDemod.js';
import { resetIQOwner } from '../src/lib/iqExclusive.js';
import { AudioRoutes, CHANNEL_PAN } from '../src/lib/audioRoutes.js';
import { BLOCK_BY_TYPE } from '../src/playground/blocks/index.js';
import { GRAPH_VERSION, compile, parseGraph, serializeGraph } from '../src/playground/graph.js';
import { Runtime } from '../src/playground/runtime.js';
import { graphForPlan } from '../src/playground/fromPlan.js';
import { READ_EVERY_MS, createWorkerCore } from '../src/playground/workerCore.js';
import { createHost } from '../src/playground/host.js';
import { MAX_RECORDING_BYTES, WavRecording, encodeWav16 } from '../src/playground/recording.js';
import { MAX_JSON_BYTES, decodeShare, encodeShare } from '../src/playground/share.js';
import { MAX_IN_FLIGHT, OFFLINE_RATE, PlaygroundEngine, STORAGE_KEY, defaultGraph, needsReceiver } from '../src/playground/engine.js';
import { centreFromName, decodeWav } from '../src/playground/wavfile.js';
import { frequencyOrigins } from '../src/playground/probes.js';

module.exports = {
    DemodChain, IQDemod, planFor, resetIQOwner, AudioRoutes, CHANNEL_PAN, BLOCK_BY_TYPE,
    GRAPH_VERSION, compile, parseGraph, serializeGraph, Runtime, graphForPlan,
    READ_EVERY_MS, createWorkerCore, createHost,
    MAX_RECORDING_BYTES, WavRecording, encodeWav16,
    MAX_JSON_BYTES, decodeShare, encodeShare,
    MAX_IN_FLIGHT, PlaygroundEngine, STORAGE_KEY, defaultGraph,
    OFFLINE_RATE, needsReceiver, centreFromName, decodeWav, frequencyOrigins,
};
