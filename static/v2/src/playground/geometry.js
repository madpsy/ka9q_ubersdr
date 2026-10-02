// Where things are on the editor's canvas.
//
// A block's card has a natural width and a height that follow from its type —
// how many ports, and whether it draws something live — and the operator may
// make it bigger (or narrower) by its corner, which the node keeps as `w` and
// `h`. Either way every port's position is arithmetic on the node and never a
// measurement of the DOM. That keeps the wires exactly on the dots without a layout pass, makes
// "which port is under the pointer" a pure function, and lets the tests check
// all of it with no page.
//
// Coordinates here are world coordinates: the canvas pans and zooms by
// transforming the whole world, and screenToWorld undoes that.

import { BLOCK_BY_TYPE } from './blocks/index.js';
import { MARKER_SIZE } from './blocks/annotate.js';
import { inputsOf, isStream, outputsOf } from './block.js';

export const NODE_W = 196;
export const HEAD_H = 26;
export const ROW_H = 20;
export const PAD = 6;
export const FOOT_H = 18;
// The line above the footer saying where on the air a block is working.
export const RF_H = 16;

// The instruments are wider: a spectrum three hundred pixels across can be
// read, and a constellation wants to be square.
export const VIEWER_W = 300;
const WIDTH = {
    'iq-spectrum': VIEWER_W,
    'audio-spectrum': VIEWER_W,
    scope: VIEWER_W,
    constellation: 220,
    'frequency-counter': 260,
    'phase-meter': 220,
    'iq-phase-meter': 220,
    'signal-detector': 260,
    'message-log': 280,
    console: 300,
    'bit-view': 260,
};

/** A card's natural width — or, given its settings, an annotation's. */
export function nodeWidth(type, params) {
    if (params && isAnnotation(type)) return annotationBox({ type, params, x: 0, y: 0 }).w;
    return WIDTH[type] || NODE_W;
}

// How far a card may be resized. Narrower than natural is allowed, to a point
// — the header and port names still have to fit — but not shorter: the ports
// and what the card says need the height they have. Extra height goes to the
// card's picture.
export const CARD_MIN_W = 150;
export const CARD_MAX_W = 1600;
export const CARD_MAX_H = 1600;

/** A card's width as drawn: as the operator sized it, or natural. */
export function cardWidth(node) {
    if (isAnnotation(node.type)) return annotationBox(node).w;
    const w = Number(node.w);
    return Number.isFinite(w) && w > 0 ? Math.max(CARD_MIN_W, Math.min(CARD_MAX_W, w)) : nodeWidth(node.type);
}

/**
 * The size to keep for a card dragged to `w` × `h`: clamped to what it may
 * be, and with each side left out where it is the natural one — so a card
 * dragged back to where it started is a card never resized, and nothing more
 * goes into a saved graph or a link than has to.
 */
export function fitSize(node, w, h) {
    const natW = nodeWidth(node.type);
    const natH = naturalHeight(node);
    const out = {};
    const cw = Math.round(Math.max(CARD_MIN_W, Math.min(CARD_MAX_W, w)));
    const ch = Math.round(Math.max(natH, Math.min(CARD_MAX_H, h)));
    if (Math.abs(cw - natW) > 1) out.w = cw;
    if (ch - natH > 1) out.h = ch;
    return out;
}

/** How much taller than natural a card is: what its picture has to fill. */
export function cardGrow(node) {
    return isAnnotation(node.type) ? 0 : nodeHeight(node) - naturalHeight(node);
}

/** Whether a type is an annotation: drawn, never run (blocks/annotate.js). */
export function isAnnotation(type) {
    const def = BLOCK_BY_TYPE[type];
    return !!(def && def.annotation);
}

/**
 * An annotation's box in the world. Most are as big as their settings say; an
 * arrow runs from its position to `dx`, `dy` on, either way, so its box is
 * wherever its two ends put it; a step marker is a fixed badge.
 */
function annotationBox(n) {
    const p = n.params || {};
    if (n.type === 'arrow') {
        const x0 = Math.min(n.x, n.x + p.dx);
        const y0 = Math.min(n.y, n.y + p.dy);
        return { x: x0, y: y0, w: Math.abs(p.dx), h: Math.abs(p.dy) };
    }
    if (n.type === 'marker') return { x: n.x, y: n.y, w: MARKER_SIZE, h: MARKER_SIZE };
    return { x: n.x, y: n.y, w: p.w, h: p.h };
}

/** The box a node takes on the canvas: a card's, or an annotation's. */
export function nodeBox(n) {
    if (isAnnotation(n.type)) return annotationBox(n);
    return { x: n.x, y: n.y, w: cardWidth(n), h: nodeHeight(n) };
}

/**
 * The nodes a group box carries when it is dragged: every node whose box lies
 * wholly inside it, annotations included, other than itself.
 */
export function nodesInside(graph, groupId) {
    const g = graph.nodes.find((n) => n.id === groupId);
    if (!g) return [];
    const b = nodeBox(g);
    return graph.nodes.filter((n) => {
        if (n.id === groupId) return false;
        const o = nodeBox(n);
        return o.x >= b.x && o.y >= b.y && o.x + o.w <= b.x + b.w && o.y + o.h <= b.y + b.h;
    }).map((n) => n.id);
}

// The height of a spectrum, and of a waterfall, on a card; both stacked when
// a viewer shows both.
export const SPECTRUM_H = 80;
export const WATERFALL_H = 80;
// A spectrum or waterfall's frequency scale, under it, and the line under
// that reading out the peak, the floor and the gap between them.
export const SCALE_H = 12;
export const MARKER_H = 14;

/**
 * What a card draws between its ports and its footer, in pixels. Depends on
 * its settings for the viewers that can show a spectrum, a waterfall or both.
 */
export function visualHeight(type, params) {
    const own = ownVisualHeight(type, params);
    if (own !== null) return own;
    // A block with no picture of its own shows its level in and out — what
    // it is doing to what goes through it.
    return carriesSamples(type) ? LEVEL_LINE_H : 0;
}

/** The height of a card's own picture, or null for a type that has none. */
function ownVisualHeight(type, params) {
    switch (type) {
        case 'meter':
        case 'level-detector':
        case 'squelch':
            return 16;
        case 'audio-out':
            // A bar for each ear.
            return 30;
        case 'carrier-tracker':
            // What it is, and whether it has the carrier: a line each.
            return 34;
        case 'wav-recorder':
        case 'iq-recorder':
            return 24;
        case 'iq-in':
            // The span (15px) over the centre and width (14px), and room
            // for their descenders before the footer.
            return 32;
        case 'iq-player':
            // A line more for where on the air, when the file says.
            // The file (14px), its progress (3px), and with a centre the
            // span and centre beneath (15 + 1 + 14), 4px apart.
            return params && params.centreHz > 0 ? 56 : 26;
        case 'demodulator':
            return 30;
        case 'data-tx':
            return 26;
        case 'signal':
            // A line for each tone.
            return params && params.tone2 ? 34 : 16;
        case 'signal-detector':
            return 64;
        case 'console':
            return 76;
        case 'text-diff':
            return 94;
        case 'bit-view':
            return 30;
        case 'costas-loop':
        case 'morse-decoder':
        case 'morse-encoder':
        case 'uart':
        case 'sitor-decoder':
        case 'fsk-detector':
        case 'ook-detector':
        case 'rtty-decoder':
        case 'psk31-decoder':
        case 'cw-decoder':
        case 'navtex-decoder':
        case 'noise-blanker':
        case 'nr2':
            return 18;
        case 'compressor':
            // How much it is taking: a bar, and the limiter's line under it.
            return 32;
        case 'graphic-eq':
        case 'parametric-eq':
            // The response curve.
            return 56;
        case 'tts':
            // What it is saying, and what it said last.
            return 32;
        case 'timecode':
            // Its state, the time, and the symbols lately read.
            return 58;
        case 'pulse-classifier':
            // The symbols lately read, and the last width.
            return 34;
        case 'clock':
            // The time, where it comes from, and a note when it is not what was asked.
            return 50;
        case 'interval-counter':
            // The last interval, its statistics and their trace.
            return 64;
        case 'serial-port':
            // The port and its buttons, the lines, and room for a note.
            return 58;
        case 'message-log':
            return 84;
        case 'iq-spectrum':
        case 'audio-spectrum': {
            const show = (params && params.display) || (type === 'iq-spectrum' ? 'both' : 'spectrum');
            return (show === 'both' ? SPECTRUM_H + WATERFALL_H : show === 'waterfall' ? WATERFALL_H : SPECTRUM_H) + SCALE_H + MARKER_H;
        }
        case 'scope':
            return 130;
        case 'constellation':
            return 196;
        case 'frequency-counter':
            return 58;
        case 'slider':
        case 'number':
        case 'dropdown':
            return 28;
        case 'toggle':
            return 24;
        case 'control-scale':
        case 'control-shape':
        case 'integrator':
            return 20;
        case 'control-plot':
            return 66;
        case 'phase-meter':
        case 'iq-phase-meter':
            return 150;
        default:
            return null;
    }
}

// The height of that line.
export const LEVEL_LINE_H = 16;

/** Whether a block has audio or IQ in or out: a level to measure. */
export function carriesSamples(type) {
    const def = BLOCK_BY_TYPE[type];
    return !!def && !def.annotation
        && [...def.inputs, ...def.outputs].some((p) => p.kind === 'complex' || p.kind === 'real');
}

/** Whether a card's picture is its level line: see visualHeight. */
export function hasLevelLine(type) {
    return ownVisualHeight(type) === null && carriesSamples(type);
}

/**
 * Whether a card carries the RF line: every block that takes a complex
 * stream and does something with it. The instruments label their own axes,
 * sinks and sources say it in their own ways, and control blocks never see
 * a stream.
 */
export function hasRfLine(type) {
    const def = BLOCK_BY_TYPE[type];
    if (!def || NO_RF.has(def.category)) return false;
    return def.inputs.some((p) => p.kind === 'complex');
}
const NO_RF = new Set(['Viewers', 'Sinks', 'Sources', 'Control']);

/**
 * A card's height as drawn: from a node — whose exposed controls add input
 * rows, and which may have been made taller — or from a type and its
 * parameters, for a card with neither.
 */
export function nodeHeight(typeOrNode, params) {
    const node = typeof typeOrNode === 'object' && typeOrNode ? typeOrNode : { type: typeOrNode, params };
    if (isAnnotation(node.type)) return annotationBox({ x: 0, y: 0, ...node }).h;
    const natural = naturalHeight(node);
    const h = Number(node.h);
    return Number.isFinite(h) && h > natural ? Math.min(CARD_MAX_H, h) : natural;
}

/** A card's height as its type and settings make it, before any resizing. */
export function naturalHeight(node) {
    if (isAnnotation(node.type)) return annotationBox({ x: 0, y: 0, ...node }).h;
    const def = BLOCK_BY_TYPE[node.type];
    const rows = def ? Math.max(inputsOf(node, def).length, outputsOf(node, def).length, 1) : 1;
    return HEAD_H + PAD * 2 + rows * ROW_H + visualHeight(node.type, node.params) + (hasRfLine(node.type) ? RF_H : 0) + FOOT_H;
}

/** Where a card's live picture starts, below its port rows. */
export function visualTop(node) {
    const def = BLOCK_BY_TYPE[node.type];
    const rows = def ? Math.max(inputsOf(node, def).length, outputsOf(node, def).length, 1) : 1;
    return HEAD_H + PAD * 2 + rows * ROW_H;
}

/** Where port `index` on `side` ('in' or 'out') of a node sits. */
export function portPosition(node, side, index) {
    return {
        x: side === 'in' ? node.x : node.x + cardWidth(node),
        y: node.y + HEAD_H + PAD + index * ROW_H + ROW_H / 2,
    };
}

/** The same, by port name. Null if the node has no such port. */
export function portPositionByName(node, side, name) {
    const def = BLOCK_BY_TYPE[node.type];
    if (!def) return null;
    const list = side === 'in' ? inputsOf(node, def) : outputsOf(node, def);
    const i = list.findIndex((p) => p.name === name);
    return i < 0 ? null : portPosition(node, side, i);
}

/**
 * An SVG path for a wire from an output at (x1, y1) to an input at (x2, y2):
 * a curve that leaves rightwards and arrives from the left, with handles long
 * enough that a wire running backwards still reads as one.
 */
export function wirePath(x1, y1, x2, y2) {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/** The view's transform undone: a point on the screen, in the world. */
export function screenToWorld(view, sx, sy) {
    return { x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
}

// How near a port the pointer has to be to count, in screen pixels. A port is
// a ten-pixel dot; this is a fingertip.
export const PORT_GRAB_PX = 14;

/**
 * The port nearest a world point, within `radius` world units, on `side` — or
 * of a `kind` only, when given, so a wire being dragged lands only where it
 * could go. Returns `{ id, port, kind, index }` or null.
 */
export function portAt(graph, side, x, y, radius, kind = null) {
    let best = null;
    let bestD = radius * radius;
    for (const n of graph.nodes) {
        const def = BLOCK_BY_TYPE[n.type];
        if (!def) continue;
        const list = side === 'in' ? inputsOf(n, def) : outputsOf(n, def);
        list.forEach((p, i) => {
            if (kind && p.kind !== kind) return;
            const at = portPosition(n, side, i);
            const d = (at.x - x) ** 2 + (at.y - y) ** 2;
            if (d <= bestD) {
                bestD = d;
                best = { id: n.id, port: p.name, kind: p.kind, index: i };
            }
        });
    }
    return best;
}

/**
 * The node whose card contains a world point, topmost first: cards before
 * annotations, which are drawn under them, each in reverse of drawing order.
 */
export function nodeAt(graph, x, y) {
    const inside = (n) => {
        const b = nodeBox(n);
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    };
    for (const under of [false, true]) {
        for (let i = graph.nodes.length - 1; i >= 0; i--) {
            const n = graph.nodes[i];
            if (isAnnotation(n.type) === under && inside(n)) return n.id;
        }
    }
    return null;
}

/** The box round every card, or null for an empty graph. */
export function graphBounds(graph) {
    if (!graph.nodes.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of graph.nodes) {
        const b = nodeBox(n);
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const ZOOM_MIN = 0.3;
// Each press of a zoom button, or double-click on the canvas: three to go from
// fitted to the closest.
export const ZOOM_STEP = 1.4;
export const ZOOM_MAX = 2;

/** The view that shows the whole graph in a `w` × `h` canvas, with a margin. */
export function fitView(graph, w, h, margin = 32) {
    const b = graphBounds(graph);
    if (!b || !(w > 0) || !(h > 0)) return { x: margin, y: margin, zoom: 1 };
    const zoom = Math.max(ZOOM_MIN, Math.min(1, (w - margin * 2) / b.w, (h - margin * 2) / b.h));
    return {
        x: Math.round((w - b.w * zoom) / 2 - b.x * zoom),
        y: Math.round((h - b.h * zoom) / 2 - b.y * zoom),
        zoom,
    };
}

/**
 * The zoom buttons' step in a `w` × `h` canvas. With `focus` — the blocks
 * selected, as a graph — they come to the middle as the zoom changes, so
 * zooming in goes to them rather than to wherever the canvas happened to be;
 * without, the middle of the canvas stays put.
 */
export function zoomToward(view, w, h, factor, focus = null) {
    const b = focus ? graphBounds(focus) : null;
    if (!b) return zoomAbout(view, w / 2, h / 2, factor);
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.zoom * factor));
    return {
        x: Math.round(w / 2 - (b.x + b.w / 2) * zoom),
        y: Math.round(h / 2 - (b.y + b.h / 2) * zoom),
        zoom,
    };
}

/**
 * Two fingers: the view a pinch has made of `start`, from where the fingers
 * first were (`a0`, `b0`, screen points) to where they are now (`a1`, `b1`).
 * The zoom follows the spread between them, within the zoom's limits; and
 * the world point that was between them stays between them — so spreading
 * zooms about the fingers, and moving both pans, as a map does.
 */
export function pinchView(start, a0, b0, a1, b1) {
    const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
    const zoom = d0 > 0 ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (start.zoom * d1) / d0)) : start.zoom;
    const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
    const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
    const w = screenToWorld(start, m0.x, m0.y);
    return { x: m1.x - w.x * zoom, y: m1.y - w.y * zoom, zoom };
}

/** Zoom by `factor` about a screen point, so what is under the pointer stays there. */
export function zoomAbout(view, sx, sy, factor) {
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.zoom * factor));
    const k = zoom / view.zoom;
    return { x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k, zoom };
}

const GAP_X = 60;
const GAP_Y = 24;

/**
 * Lay a graph out left to right in the order the signal flows: each block one
 * column further right than the furthest block feeding it, and stacked down its
 * column in the order the graph lists them. For a graph that arrives with no
 * positions — or with positions from something that knew nothing of card
 * sizes, like graphForPlan. Annotations stay where they were put: they are
 * placed by hand, round whatever they describe.
 */
export function autoLayout(graph) {
    const depth = new Map(graph.nodes.map((n) => [n.id, 0]));
    // Control and message wires may loop back; only the samples' path sets
    // the columns.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const streamWires = graph.wires.filter((w) => {
        const n = byId.get(w[0]);
        const def = n && BLOCK_BY_TYPE[n.type];
        const p = def && outputsOf(n, def).find((o) => o.name === w[1]);
        return !p || isStream(p.kind);
    });
    // Longest path from a source, by relaxing until nothing moves. A graph
    // with a loop will not compile anyway; the bound keeps one from hanging
    // this.
    for (let pass = 0; pass < graph.nodes.length; pass++) {
        let moved = false;
        for (const w of streamWires) {
            const d = (depth.get(w[0]) ?? 0) + 1;
            if (depth.has(w[2]) && d > depth.get(w[2])) {
                depth.set(w[2], d);
                moved = true;
            }
        }
        if (!moved) break;
    }
    // Each column as wide as its widest card.
    const colW = new Map();
    for (const n of graph.nodes) {
        if (isAnnotation(n.type)) continue;
        const c = depth.get(n.id);
        colW.set(c, Math.max(colW.get(c) || 0, cardWidth(n)));
    }
    const colX = new Map();
    let x = 0;
    for (const c of [...colW.keys()].sort((a, b) => a - b)) {
        colX.set(c, x);
        x += colW.get(c) + GAP_X;
    }
    const columnY = new Map();
    const nodes = graph.nodes.map((n) => {
        if (isAnnotation(n.type)) return n;
        const c = depth.get(n.id);
        const y = columnY.get(c) || 0;
        columnY.set(c, y + nodeHeight(n) + GAP_Y);
        return { ...n, x: colX.get(c), y };
    });
    return { ...graph, nodes };
}
