// Entry point for the playground editor's tests: its pure parts, and its
// components rendered through the hook stub.
//
// The hook stub first, for its side effect — see iqdemod.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import IQPanel from '../src/panels/IQPanel.jsx';
import PlaygroundWatch, { takeShareCode } from '../src/components/PlaygroundWatch.jsx';
import PlaygroundModal, { AnnotateMenu, useCompactRow, PlaygroundWindow, TemplatesMenu, WATCHED_TYPES, graphFromIQDemod, graphFromAllChannels, withArrival } from '../src/playground/ui/PlaygroundModal.jsx';
import { TEMPLATES } from '../src/playground/templates.js';
import Inspector, { ParamField, countShare, formatBytesPerSec, useQuietWhilePlaying, streamRates, throughputHistory, eqPresetParams, formatKbps, VoiceField } from '../src/playground/ui/Inspector.jsx';
import { holdPlayback, playbackHeld } from '../src/lib/playbackHold.js';
import JsonPane, { graphText, readGraphText } from '../src/playground/ui/JsonPane.jsx';
import { Switch, Slider, Modal } from '../src/components/ui.jsx';
import { MarginPicker } from '../src/panels/AudioPanel.jsx';
import { MARGIN_MIN_DB, MARGIN_LOSSLESS } from '../src/radio/constants.js';
import { setUberSDRVersion, uberSDRVersion, versionNote } from '../src/playground/version.js';
import Canvas, { BlockPreview, InPlace, formatCpu, formatLatency, formatRate } from '../src/playground/ui/Canvas.jsx';
import { HEAD_H as CARD_HEAD_H } from '../src/playground/geometry.js';
import CardVisual, { ActivityDot, ClipPill, RfLine, activityMeaning, canClip, plotValue } from '../src/playground/ui/CardVisual.jsx';
import Palette from '../src/playground/ui/Palette.jsx';
import { closePlayground, offerSharedGraph, openPlayground, playgroundUiState } from '../src/playground/ui/store.js';
import {
    EditHistory, addNode, canConnect, cloneGraph, connectPorts, disconnectInput, duplicateNodes, freshId, renameNode,
    moveNodes, removeNodes, removeWire,
} from '../src/playground/editing.js';
import {
    NODE_W, hasRfLine, autoLayout, graphBounds, fitView, nodeAt, nodeHeight, nodeWidth, portAt, portPosition, screenToWorld, wirePath,
    zoomAbout, zoomToward, ZOOM_MAX, ZOOM_MIN, isAnnotation, nodeBox, nodesInside,
    cardWidth, cardGrow, fitSize, naturalHeight, CARD_MIN_W, CARD_MAX_W, pinchView,
} from '../src/playground/geometry.js';
import {
    ConstellationView, ConsoleView, DiffView, INSTRUMENTS, Instrument, ScopeView, SpectrumView, freqLabel, scopeRange, spectrumAxis, timeLabel,
    spectrumMarks, counterText, groupDigits, messageLine, measureLine, logText,
} from '../src/playground/ui/viewers.jsx';
import { BLOCKS, BLOCK_BY_TYPE, CATEGORIES } from '../src/playground/blocks/index.js';
import { holdSpectrum, setSpectrumPaused, spectrumPaused } from '../src/lib/spectrumPause.js';
import { GRAPH_VERSION, compile, parseGraph, serializeGraph } from '../src/playground/graph.js';
import { getPlayground } from '../src/playground/engine.js';
import { encodeShare, decodeShare } from '../src/playground/share.js';
import { PROBES, airSpan, rfLabel, rfOf, shiftLabel } from '../src/playground/probes.js';
import * as LIB from '../src/playground/library.js';
import { ExportDialog, GraphName, OpenDialog, SaveNameDialog } from '../src/playground/ui/GraphLibrary.jsx';
import SerialCard from '../src/playground/ui/SerialCard.jsx';
import { resetDemodSettings, saveDemodSettings } from '../src/lib/iqDemod.js';

module.exports = {
    deep, render, reset, walk, words, SerialCard, plotValue, messageLine, measureLine, logText, AnnotateMenu, useCompactRow, LIB, GraphName, ExportDialog, OpenDialog, SaveNameDialog,
    withArrival, zoomToward, ZOOM_MAX, ZOOM_MIN,
    IQPanel, PlaygroundWatch, takeShareCode, PlaygroundModal, PlaygroundWindow, WATCHED_TYPES, graphFromIQDemod, graphFromAllChannels, TemplatesMenu, TEMPLATES,
    Inspector, ParamField, countShare, formatBytesPerSec, useQuietWhilePlaying, streamRates, throughputHistory, eqPresetParams, formatKbps, VoiceField, holdPlayback, playbackHeld, JsonPane, graphText, readGraphText, Canvas, BlockPreview, CARD_HEAD_H, InPlace, formatCpu, formatLatency, formatRate, CardVisual, RfLine, ActivityDot, activityMeaning, ClipPill, canClip, Palette,
    airSpan, rfLabel, rfOf, shiftLabel, hasRfLine, encodeShare, decodeShare,
    closePlayground, offerSharedGraph, openPlayground, playgroundUiState,
    EditHistory, addNode, canConnect, cloneGraph, connectPorts, disconnectInput, duplicateNodes, freshId, renameNode,
    moveNodes, removeNodes, removeWire,
    NODE_W, nodeWidth, autoLayout, graphBounds, fitView, nodeAt, nodeHeight, portAt, portPosition, screenToWorld, wirePath, isAnnotation, nodeBox, nodesInside, zoomAbout,
    cardWidth, cardGrow, fitSize, naturalHeight, CARD_MIN_W, CARD_MAX_W, pinchView,
    setUberSDRVersion, uberSDRVersion, versionNote, Switch, Slider, Modal, MarginPicker, MARGIN_MIN_DB, MARGIN_LOSSLESS, Instrument, SpectrumView, ScopeView, ConstellationView, ConsoleView, DiffView, spectrumAxis, scopeRange, freqLabel, timeLabel, INSTRUMENTS,
    spectrumMarks, counterText, groupDigits,
    holdSpectrum, setSpectrumPaused, spectrumPaused, BLOCKS, BLOCK_BY_TYPE, CATEGORIES, GRAPH_VERSION, compile, parseGraph, serializeGraph, getPlayground, resetDemodSettings, saveDemodSettings, PROBES,
};
