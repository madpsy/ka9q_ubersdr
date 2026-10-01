// Entry point for the playground editor's tests: its pure parts, and its
// components rendered through the hook stub.
//
// The hook stub first, for its side effect — see iqdemod.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import IQPanel from '../src/panels/IQPanel.jsx';
import PlaygroundWatch, { takeShareCode } from '../src/components/PlaygroundWatch.jsx';
import PlaygroundModal, { PlaygroundWindow, TemplatesMenu, WATCHED_TYPES, graphFromIQDemod, withArrival } from '../src/playground/ui/PlaygroundModal.jsx';
import { TEMPLATES } from '../src/playground/templates.js';
import Inspector, { ParamField } from '../src/playground/ui/Inspector.jsx';
import Canvas, { formatCpu, formatLatency, formatRate } from '../src/playground/ui/Canvas.jsx';
import CardVisual, { RfLine } from '../src/playground/ui/CardVisual.jsx';
import Palette from '../src/playground/ui/Palette.jsx';
import { closePlayground, offerSharedGraph, openPlayground, playgroundUiState } from '../src/playground/ui/store.js';
import {
    EditHistory, addNode, canConnect, cloneGraph, connectPorts, disconnectInput, duplicateNodes, freshId,
    moveNodes, removeNodes, removeWire,
} from '../src/playground/editing.js';
import {
    NODE_W, hasRfLine, autoLayout, graphBounds, fitView, nodeAt, nodeHeight, nodeWidth, portAt, portPosition, screenToWorld, wirePath,
    zoomAbout, zoomToward, ZOOM_MAX, ZOOM_MIN,
} from '../src/playground/geometry.js';
import {
    ConstellationView, INSTRUMENTS, Instrument, ScopeView, SpectrumView, freqLabel, scopeRange, spectrumAxis, timeLabel,
    spectrumMarks, counterText, groupDigits,
} from '../src/playground/ui/viewers.jsx';
import { BLOCKS, BLOCK_BY_TYPE } from '../src/playground/blocks/index.js';
import { GRAPH_VERSION, compile, parseGraph } from '../src/playground/graph.js';
import { getPlayground } from '../src/playground/engine.js';
import { encodeShare, decodeShare } from '../src/playground/share.js';
import { PROBES, airSpan, rfLabel, rfOf, shiftLabel } from '../src/playground/probes.js';
import { resetDemodSettings, saveDemodSettings } from '../src/lib/iqDemod.js';

module.exports = {
    deep, render, reset, walk, words,
    withArrival, zoomToward, ZOOM_MAX, ZOOM_MIN,
    IQPanel, PlaygroundWatch, takeShareCode, PlaygroundModal, PlaygroundWindow, WATCHED_TYPES, graphFromIQDemod, TemplatesMenu, TEMPLATES,
    Inspector, ParamField, Canvas, formatCpu, formatLatency, formatRate, CardVisual, RfLine, Palette,
    airSpan, rfLabel, rfOf, shiftLabel, hasRfLine, encodeShare, decodeShare,
    closePlayground, offerSharedGraph, openPlayground, playgroundUiState,
    EditHistory, addNode, canConnect, cloneGraph, connectPorts, disconnectInput, duplicateNodes, freshId,
    moveNodes, removeNodes, removeWire,
    NODE_W, nodeWidth, autoLayout, graphBounds, fitView, nodeAt, nodeHeight, portAt, portPosition, screenToWorld, wirePath, zoomAbout,
    Instrument, SpectrumView, ScopeView, ConstellationView, spectrumAxis, scopeRange, freqLabel, timeLabel, INSTRUMENTS,
    spectrumMarks, counterText, groupDigits,
    BLOCKS, BLOCK_BY_TYPE, GRAPH_VERSION, compile, parseGraph, getPlayground, resetDemodSettings, saveDemodSettings, PROBES,
};
