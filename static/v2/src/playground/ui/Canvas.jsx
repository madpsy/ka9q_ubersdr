// The playground's canvas: blocks as cards, wires between their ports, and the
// gestures that build a graph.
//
//   drag a card              move it (and the rest of the selection with it)
//   drag from an output      draw a wire; let go on an input of the same kind
//   drag from a wired input  pick that wire up, to move it or drop it in space
//   press a wire             select it
//   drag the background      pan; the wheel zooms about the pointer
//
// Positions are arithmetic (geometry.js), not measurements, so wires meet the
// dots exactly whatever the zoom, and "which port is this" is portAt() rather
// than a question for the DOM. The world — cards and wires together — is one
// transformed layer, so panning and zooming move it all as one.

import React, { useEffect, useRef, useState } from '../../react.js';
import { BLOCK_BY_TYPE } from '../blocks/index.js';
import {
    FOOT_H, HEAD_H, PAD, PORT_GRAB_PX, RF_H, ROW_H, hasRfLine, nodeAt, nodeHeight, nodeWidth, portAt, portPositionByName, visualTop,
    screenToWorld, wirePath, zoomAbout,
} from '../geometry.js';
import { canConnect, connectPorts, removeWire } from '../editing.js';
import CardVisual, { RfLine } from './CardVisual.jsx';
import { inputOrigin } from '../probes.js';
import { inputsOf, outputsOf } from '../block.js';

/** Seconds as the shortest honest reading: µs, ms or s. */
export function formatLatency(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    if (sec === 0) return '0 ms';
    if (sec < 0.001) return `${Math.round(sec * 1e6)} µs`;
    if (sec < 1) return `${(sec * 1000).toFixed(sec < 0.01 ? 1 : 0)} ms`;
    return `${sec.toFixed(2)} s`;
}

/** A share of a core as a percentage, or a dash before there is one. */
export function formatCpu(share) {
    if (share == null || !Number.isFinite(share)) return '—';
    const pct = share * 100;
    if (pct < 0.1) return '<0.1%';
    return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** A rate in the unit it reads best in. */
export function formatRate(hz) {
    if (!(hz > 0)) return '';
    return hz >= 1000 ? `${Number((hz / 1000).toFixed(hz % 1000 ? 2 : 0))}k` : `${Math.round(hz)}`;
}

// On screen, whatever the zoom: a press this near a port's dot takes it, a
// wire let go of this near one lands on it, and a press becomes a drag once
// the pointer has gone this far.
const GRAB_PX = PORT_GRAB_PX;
const DROP_PX = 24;
const DRAG_PX = 4;

function Card({ pg, graph, node, selected, errors, rate, latency, cpu, wiredIn, target, look, origin, origins, onParams }) {
    const def = BLOCK_BY_TYPE[node.type];
    if (!def) return null;
    const h = nodeHeight(node);
    const ins = inputsOf(node, def);
    const outs = outputsOf(node, def);
    const err = errors && errors.length ? errors.map((e) => e.message).join(' ') : null;
    const port = (side, p, i) => {
        const wired = side === 'in' && wiredIn.has(`${node.id}.${p.name}`);
        // The port a wire being dragged would land on, lit to say whether it can.
        const aimed = target && target.side === side && target.port === p.name
            ? (target.ok ? ' is-target' : ' is-refused')
            : '';
        return (
            <div
                key={`${side}${p.name}`}
                className={`pg-port pg-port--${side} pg-port--${p.kind}${wired ? ' is-wired' : ''}${p.optional ? ' is-optional' : ''}${aimed}`}
                style={{ top: `${HEAD_H + PAD + i * ROW_H}px`, height: `${ROW_H}px` }}
                title={p.param ? `${p.label}: control input — drives this setting` : `${p.name} — ${p.kind}${p.optional ? ', optional' : ''}`}
            >
                <i className="pg-port__dot" />
                <span className="pg-port__name">{p.param ? p.label : p.name}</span>
            </div>
        );
    };
    const latencyTitle = latency
        ? `This block: ${formatLatency(latency.own)} · from the source: ${formatLatency(latency.total)}${def.latencyNote ? ` — ${def.latencyNote}` : ''}`
        : 'Latency';
    return (
        <div
            className={`pg-card${selected ? ' is-selected' : ''}${err ? ' is-error' : ''}`}
            data-node={node.id}
            style={{ left: `${node.x}px`, top: `${node.y}px`, width: `${nodeWidth(node.type)}px`, height: `${h}px` }}
            title={err || undefined}
        >
            <div className="pg-card__head" style={{ height: `${HEAD_H}px` }}>
                <span className="pg-card__label">{def.label}</span>
                <span className="pg-card__id">{node.id}</span>
            </div>
            {ins.map((p, i) => port('in', p, i))}
            {outs.map((p, i) => port('out', p, i))}
            <div
                className="pg-card__visual"
                style={{ top: `${visualTop(node)}px` }}
            >
                <CardVisual pg={pg} node={node} look={look} origin={origin} rate={rate} onParams={onParams} />
            </div>
            {hasRfLine(node.type) && (
                <div className="pg-card__rfbox" style={{ bottom: `${FOOT_H}px`, height: `${RF_H}px` }}>
                    <RfLine pg={pg} graph={graph} node={node} dialHz={look && look.dialHz} origins={origins} />
                </div>
            )}
            <div className="pg-card__foot" style={{ height: `${FOOT_H}px` }}>
                <span title="The rate this block works at">{formatRate(rate)}</span>
                <span title={latencyTitle}>{latency ? `⏱ ${formatLatency(latency.own)}${def.latencyNote ? '*' : ''}` : ''}</span>
                <span title="Share of one CPU core, measured over the last second">{cpu == null ? '' : `⚙ ${formatCpu(cpu)}`}</span>
            </div>
        </div>
    );
}

export default function Canvas({
    pg, graph, view, setView, selection, setPicked, onEdit, onMoved, onOpenNode, errorsByNode, rates, latencies, stats, look, origins, onParams,
}) {
    const root = useRef(null);
    const drag = useRef(null);
    const [ghost, setGhost] = useState(null);
    const [hover, setHover] = useState(null);
    const [hint, setHint] = useState(null);
    // The latest of each, for handlers registered once.
    const live = useRef({});
    live.current = { view, graph };

    const local = (e) => {
        const r = root.current ? root.current.getBoundingClientRect() : { left: 0, top: 0 };
        return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    };
    const world = (e) => {
        const { sx, sy } = local(e);
        return screenToWorld(view, sx, sy);
    };

    // The wheel zooms. Registered by hand because React's wheel listener is
    // passive and cannot keep the page from scrolling under the canvas.
    useEffect(() => {
        const el = root.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            const r = el.getBoundingClientRect();
            const factor = Math.exp(-e.deltaY * 0.0015);
            setView(zoomAbout(live.current.view, e.clientX - r.left, e.clientY - r.top, factor));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [setView]);

    const capture = (e) => {
        if (root.current && root.current.setPointerCapture) root.current.setPointerCapture(e.pointerId);
    };

    // Ports are found by distance, not by the element under the pointer: a
    // dot is 10 px across, and half that at the zoom a graph usually fits at.
    // Anywhere within GRAB_PX of one, on screen, takes it.
    const nearestPort = (x, y, radius) => {
        let best = null;
        for (const side of ['out', 'in']) {
            const hit = portAt(graph, side, x, y, radius);
            if (!hit) continue;
            const at = portPositionByName(graph.nodes.find((n) => n.id === hit.id), side, hit.port);
            const d = Math.hypot(at.x - x, at.y - y);
            if (!best || d < best.d) best = { ...hit, side, d };
        }
        return best;
    };

    // A drag that moves a wire leaves the wire where it is until the drop —
    // hidden, and replaced in one edit — so a press that goes nowhere breaks
    // nothing and a move is one undo step.
    const startWire = (from, at, hide = null) => {
        drag.current = { kind: 'wire', from, hide };
        setGhost({ from: { id: from.id, port: from.port }, x: at.x, y: at.y, hide });
    };
    const startBack = (to, at, hide = null) => {
        drag.current = { kind: 'wire-back', to, hide };
        setGhost({ to: { id: to.id, port: to.port }, x: at.x, y: at.y, hide });
    };
    // A wire taken up by one end: the other stays put.
    const lift = (index, end, at) => {
        const w = graph.wires[index];
        if (!w) return;
        const kind = kindOf(w);
        if (end === 'in') startWire({ id: w[0], port: w[1], kind }, at, index);
        else startBack({ id: w[2], port: w[3], kind }, at, index);
    };

    /** A press on the canvas, or on wire `wireIndex`. */
    const onDown = (e, wireIndex = null) => {
        if (e.button !== undefined && e.button !== 0) return;
        // Controls on a card are the card's business.
        if (e.target && e.target.closest && e.target.closest('button, input, select')) return;
        capture(e);
        const at = world(e);
        const { sx, sy } = local(e);
        const hit = nearestPort(at.x, at.y, GRAB_PX / view.zoom);
        if (hit) {
            const p = { id: hit.id, port: hit.port, kind: hit.kind };
            if (hit.side === 'out') {
                startWire(p, at);
                return;
            }
            // A wired input: its wire, by that end, once the pointer moves;
            // a click selects it.
            const index = graph.wires.findIndex((w) => w[2] === hit.id && w[3] === hit.port);
            if (index >= 0) {
                drag.current = { kind: 'press-wire', index, end: 'in', sx, sy };
                return;
            }
            // An empty input: a wire drawn backwards, to an output.
            startBack(p, at);
            return;
        }
        if (wireIndex != null) {
            setPicked({ nodes: new Set(), wire: wireIndex });
            drag.current = { kind: 'press-wire', index: wireIndex, end: null, sx, sy, at };
            return;
        }
        const card = e.target && e.target.closest && e.target.closest('[data-node]');
        if (card) {
            const id = card.getAttribute('data-node');
            let sel = selection.nodes;
            if (e.shiftKey) {
                sel = new Set(sel);
                if (sel.has(id)) sel.delete(id); else sel.add(id);
            } else if (!sel.has(id)) {
                sel = new Set([id]);
            }
            setPicked({ nodes: sel, wire: null });
            const origin = {};
            for (const n of graph.nodes) if (sel.has(n.id)) origin[n.id] = { x: n.x, y: n.y };
            drag.current = { kind: 'move', at, origin, moved: false };
            return;
        }
        if (!e.shiftKey) setPicked({ nodes: new Set(), wire: null });
        drag.current = { kind: 'pan', sx, sy, vx: view.x, vy: view.y };
    };

    /**
     * Where a wire being dragged would land: the port within DROP_PX of the
     * pointer that takes its kind, and whether it may — judged on the graph
     * without the wire being moved, which is what it will be joined into.
     */
    const landing = (d, at) => {
        const base = d.hide != null ? removeWire(graph, d.hide) : graph;
        const side = d.kind === 'wire' ? 'in' : 'out';
        const kind = d.kind === 'wire' ? d.from.kind : d.to.kind;
        const t = portAt(base, side, at.x, at.y, DROP_PX / view.zoom, kind);
        if (!t) return { base, target: null, check: null };
        const check = d.kind === 'wire'
            ? canConnect(base, d.from.id, d.from.port, t.id, t.port)
            : canConnect(base, t.id, t.port, d.to.id, d.to.port);
        return { base, target: { ...t, side }, check };
    };

    const onMove = (e) => {
        const d = drag.current;
        if (!d) return;
        if (d.kind === 'pan') {
            const { sx, sy } = local(e);
            setView({ ...view, x: d.vx + sx - d.sx, y: d.vy + sy - d.sy });
        } else if (d.kind === 'move') {
            const at = world(e);
            const dx = at.x - d.at.x;
            const dy = at.y - d.at.y;
            if (!d.moved && Math.hypot(dx, dy) < 2) return;
            d.moved = true;
            const next = {};
            for (const [id, o] of Object.entries(d.origin)) next[id] = { x: o.x + dx, y: o.y + dy };
            pg.setPositions(next);
        } else if (d.kind === 'press-wire') {
            const { sx, sy } = local(e);
            if (Math.hypot(sx - d.sx, sy - d.sy) < DRAG_PX) return;
            const at = world(e);
            let end = d.end;
            if (!end) {
                // Taken from along its length: the end nearer the press comes away.
                const w = graph.wires[d.index];
                const a = w && byId.get(w[0]) && portPositionByName(byId.get(w[0]), 'out', w[1]);
                const b = w && byId.get(w[2]) && portPositionByName(byId.get(w[2]), 'in', w[3]);
                if (!a || !b) return;
                end = Math.hypot(b.x - d.at.x, b.y - d.at.y) < Math.hypot(a.x - d.at.x, a.y - d.at.y) ? 'in' : 'out';
            }
            lift(d.index, end, at);
        } else if (d.kind === 'wire' || d.kind === 'wire-back') {
            const at = world(e);
            setGhost((g) => (g ? { ...g, x: at.x, y: at.y } : g));
            const { target, check } = landing(d, at);
            setHover(target ? { ...target, ok: !!(check && check.ok) } : null);
            setHint(target && check && !check.ok ? check.why : null);
        }
    };

    const onUp = (e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.kind === 'move' && d.moved) onMoved();
        // A press on a wired input that never moved: a click, which picks its wire.
        if (d.kind === 'press-wire' && d.end === 'in') setPicked({ nodes: new Set(), wire: d.index });
        if (d.kind === 'wire' || d.kind === 'wire-back') {
            const { base, target, check } = landing(d, world(e));
            const was = d.hide != null ? graph.wires[d.hide] : null;
            let next = null;
            if (target && check && check.ok) {
                const w = d.kind === 'wire'
                    ? [d.from.id, d.from.port, target.id, target.port]
                    : [target.id, target.port, d.to.id, d.to.port];
                // Put back where it was: nothing to do.
                if (!(was && w.every((v, i) => v === was[i]))) next = connectPorts(base, w[0], w[1], w[2], w[3]);
            } else if (was) {
                // Taken off a port and let go of anywhere else: removed.
                next = base;
            }
            if (next && next !== graph) {
                onEdit(next, 'wire');
                setPicked({ nodes: new Set(), wire: null });
            }
            setGhost(null);
            setHover(null);
            setHint(null);
        }
    };

    // By where the pointer is rather than by the event's target: the press
    // that began the double-click captured the pointer to the canvas, and a
    // browser may then deliver the click to the canvas, not the card.
    const onDouble = (e) => {
        if (e.target.closest && e.target.closest('button, input, select')) return;
        const at = world(e);
        const id = nodeAt(graph, at.x, at.y);
        if (id && onOpenNode) onOpenNode(id);
    };

    const wiredIn = new Set(graph.wires.map((w) => `${w[2]}.${w[3]}`));
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const kindOf = (w) => {
        const n = byId.get(w[0]);
        const o = n && BLOCK_BY_TYPE[n.type] && outputsOf(n, BLOCK_BY_TYPE[n.type]).find((p) => p.name === w[1]);
        return o ? o.kind : 'real';
    };

    let ghostPath = null;
    if (ghost && ghost.from) {
        const n = byId.get(ghost.from.id);
        const a = n && portPositionByName(n, 'out', ghost.from.port);
        if (a) ghostPath = wirePath(a.x, a.y, ghost.x, ghost.y);
    } else if (ghost && ghost.to) {
        const n = byId.get(ghost.to.id);
        const b = n && portPositionByName(n, 'in', ghost.to.port);
        if (b) ghostPath = wirePath(ghost.x, ghost.y, b.x, b.y);
    }

    return (
        <div
            ref={root}
            className="pg-canvas"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onDoubleClick={onDouble}
        >
            <div
                className="pg-world"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
            >
                <svg className="pg-wires" width="1" height="1" overflow="visible">
                    {graph.wires.map((w, i) => {
                        const a = byId.get(w[0]) && portPositionByName(byId.get(w[0]), 'out', w[1]);
                        const b = byId.get(w[2]) && portPositionByName(byId.get(w[2]), 'in', w[3]);
                        if (!a || !b) return null;
                        if (ghost && ghost.hide === i) return null;
                        const d = wirePath(a.x, a.y, b.x, b.y);
                        const sel = selection.wire === i;
                        return (
                            <g key={`${w.join('.')}`}>
                                <path
                                    className="pg-wire__hit"
                                    d={d}
                                    onPointerDown={(e) => {
                                        e.stopPropagation();
                                        onDown(e, i);
                                    }}
                                />
                                <path className={`pg-wire pg-wire--${kindOf(w)}${sel ? ' is-selected' : ''}`} d={d} />
                            </g>
                        );
                    })}
                    {ghostPath && <path className={`pg-wire pg-wire--ghost${hover && !hover.ok ? ' is-bad' : ''}`} d={ghostPath} />}
                </svg>
                {graph.nodes.map((n) => {
                    const s = stats && stats.nodes ? stats.nodes[n.id] : null;
                    return (
                        <Card
                            key={n.id}
                            pg={pg}
                            node={n}
                            selected={selection.nodes.has(n.id)}
                            errors={errorsByNode[n.id]}
                            rate={rates[n.id]}
                            latency={latencies[n.id]}
                            cpu={s ? s.cpu : null}
                            wiredIn={wiredIn}
                            target={hover && hover.id === n.id ? hover : null}
                            look={look}
                            origin={origins ? inputOrigin(graph, origins, n.id) : null}
                            graph={graph}
                            origins={origins}
                            onParams={onParams}
                        />
                    );
                })}
            </div>
            {hint && <div className="pg-canvas__hint">{hint}</div>}
            {!graph.nodes.length && (
                <div className="pg-canvas__empty">Add blocks from the list on the left, then drag from an output to an input to wire them.</div>
            )}
        </div>
    );
}
