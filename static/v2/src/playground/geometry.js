// Where things are on the editor's canvas.
//
// A block's card has a fixed width and a height that follows from its type —
// how many ports, and whether it draws something live — so every port's
// position is arithmetic on the node's (x, y) and never a measurement of the
// DOM. That keeps the wires exactly on the dots without a layout pass, makes
// "which port is under the pointer" a pure function, and lets the tests check
// all of it with no page.
//
// Coordinates here are world coordinates: the canvas pans and zooms by
// transforming the whole world, and screenToWorld undoes that.

import { BLOCK_BY_TYPE } from './blocks/index.js';
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

/** A card's width. */
export function nodeWidth(type) {
    return WIDTH[type] || NODE_W;
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
    switch (type) {
        case 'meter':
        case 'level-detector':
        case 'squelch':
            return 16;
        case 'carrier-tracker':
            return 18;
        case 'wav-recorder':
        case 'iq-recorder':
            return 24;
        case 'iq-in':
            return 30;
        case 'iq-player':
            // A line more for where on the air, when the file says.
            return params && params.centreHz > 0 ? 42 : 26;
        case 'demodulator':
            return 30;
        case 'signal-detector':
            return 64;
        case 'console':
            return 76;
        case 'bit-view':
            return 30;
        case 'costas-loop':
        case 'morse-decoder':
        case 'uart':
        case 'sitor-decoder':
        case 'fsk-detector':
        case 'ook-detector':
        case 'rtty-decoder':
        case 'psk31-decoder':
        case 'cw-decoder':
        case 'navtex-decoder':
            return 18;
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
        case 'integrator':
            return 20;
        case 'control-plot':
            return 66;
        case 'phase-meter':
        case 'iq-phase-meter':
            return 150;
        default:
            return 0;
    }
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
 * A card's height: from a node — whose exposed controls add input rows — or
 * from a type and its parameters, for a card with none.
 */
export function nodeHeight(typeOrNode, params) {
    const node = typeof typeOrNode === 'object' && typeOrNode ? typeOrNode : { type: typeOrNode, params };
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
        x: side === 'in' ? node.x : node.x + nodeWidth(node.type),
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

/** The node whose card contains a world point, topmost (last drawn) first. */
export function nodeAt(graph, x, y) {
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
        const n = graph.nodes[i];
        if (x >= n.x && x <= n.x + nodeWidth(n.type) && y >= n.y && y <= n.y + nodeHeight(n)) return n.id;
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
        x0 = Math.min(x0, n.x);
        y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + nodeWidth(n.type));
        y1 = Math.max(y1, n.y + nodeHeight(n));
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const ZOOM_MIN = 0.3;
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
 * sizes, like graphForPlan.
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
        const c = depth.get(n.id);
        colW.set(c, Math.max(colW.get(c) || 0, nodeWidth(n.type)));
    }
    const colX = new Map();
    let x = 0;
    for (const c of [...colW.keys()].sort((a, b) => a - b)) {
        colX.set(c, x);
        x += colW.get(c) + GAP_X;
    }
    const columnY = new Map();
    const nodes = graph.nodes.map((n) => {
        const c = depth.get(n.id);
        const y = columnY.get(c) || 0;
        columnY.set(c, y + nodeHeight(n) + GAP_Y);
        return { ...n, x: colX.get(c), y };
    });
    return { ...graph, nodes };
}
