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
import { canConnect, connectPorts, disconnectInput } from '../editing.js';
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

function Card({ pg, graph, node, selected, errors, rate, latency, cpu, wiredIn, onPortDown, look, origin, origins, onParams }) {
    const def = BLOCK_BY_TYPE[node.type];
    if (!def) return null;
    const h = nodeHeight(node);
    const ins = inputsOf(node, def);
    const outs = outputsOf(node, def);
    const err = errors && errors.length ? errors.map((e) => e.message).join(' ') : null;
    const port = (side, p, i) => {
        const wired = side === 'in' && wiredIn.has(`${node.id}.${p.name}`);
        return (
            <div
                key={`${side}${p.name}`}
                className={`pg-port pg-port--${side} pg-port--${p.kind}${wired ? ' is-wired' : ''}${p.optional ? ' is-optional' : ''}`}
                style={{ top: `${HEAD_H + PAD + i * ROW_H}px`, height: `${ROW_H}px` }}
                title={p.param ? `${p.label}: control input — drives this setting` : `${p.name} — ${p.kind}${p.optional ? ', optional' : ''}`}
                onPointerDown={(e) => onPortDown(e, node.id, side, p)}
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

    const onPortDown = (e, id, side, p) => {
        e.stopPropagation();
        capture(e);
        const at = world(e);
        if (side === 'out') {
            drag.current = { kind: 'wire', from: { id, port: p.name, kind: p.kind } };
            setGhost({ from: { id, port: p.name }, x: at.x, y: at.y });
            return;
        }
        // An input with a wire on it: pick the wire up from its far end.
        const w = graph.wires.find((x) => x[2] === id && x[3] === p.name);
        if (!w) return;
        const fromNode = graph.nodes.find((n) => n.id === w[0]);
        const outDef = fromNode && outputsOf(fromNode, BLOCK_BY_TYPE[fromNode.type]).find((o) => o.name === w[1]);
        if (!outDef) return;
        onEdit(disconnectInput(graph, id, p.name), 'wire');
        drag.current = { kind: 'wire', from: { id: w[0], port: w[1], kind: outDef.kind } };
        setGhost({ from: { id: w[0], port: w[1] }, x: at.x, y: at.y });
    };

    const onDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const card = e.target.closest && e.target.closest('[data-node]');
        // Controls on a card are the card's business.
        if (e.target.closest && e.target.closest('button, input, select')) return;
        capture(e);
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
            const at = world(e);
            const origin = {};
            for (const n of graph.nodes) if (sel.has(n.id)) origin[n.id] = { x: n.x, y: n.y };
            drag.current = { kind: 'move', at, origin, moved: false };
            return;
        }
        if (!e.shiftKey) setPicked({ nodes: new Set(), wire: null });
        const { sx, sy } = local(e);
        drag.current = { kind: 'pan', sx, sy, vx: view.x, vy: view.y };
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
        } else if (d.kind === 'wire') {
            const at = world(e);
            setGhost((g) => (g ? { ...g, x: at.x, y: at.y } : g));
            const target = portAt(graph, 'in', at.x, at.y, PORT_GRAB_PX / view.zoom, d.from.kind);
            const ok = target && canConnect(graph, d.from.id, d.from.port, target.id, target.port);
            setHover(target ? { ...target, ok: ok && ok.ok } : null);
            setHint(target && ok && !ok.ok ? ok.why : null);
        }
    };

    const onUp = (e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.kind === 'move' && d.moved) onMoved();
        if (d.kind === 'wire') {
            const at = world(e);
            const target = portAt(graph, 'in', at.x, at.y, PORT_GRAB_PX / view.zoom, d.from.kind);
            if (target) {
                const next = connectPorts(graph, d.from.id, d.from.port, target.id, target.port);
                if (next !== graph) onEdit(next, 'wire');
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
    if (ghost) {
        const n = byId.get(ghost.from.id);
        const a = n && portPositionByName(n, 'out', ghost.from.port);
        if (a) ghostPath = wirePath(a.x, a.y, ghost.x, ghost.y);
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
                        const d = wirePath(a.x, a.y, b.x, b.y);
                        const sel = selection.wire === i;
                        return (
                            <g key={`${w.join('.')}`}>
                                <path
                                    className="pg-wire__hit"
                                    d={d}
                                    onPointerDown={(e) => {
                                        e.stopPropagation();
                                        setPicked({ nodes: new Set(), wire: i });
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
                            onPortDown={onPortDown}
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
