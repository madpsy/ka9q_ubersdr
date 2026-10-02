// The playground's canvas: blocks as cards, wires between their ports, and the
// gestures that build a graph.
//
//   drag a card              move it (and the rest of the selection with it)
//   drag from an output      draw a wire; let go on an input of the same kind
//   drag from a wired input  pick that wire up, to move it or drop it in space
//   press a wire             select it
//   drag the background      pan; the wheel zooms about the pointer, and a
//                            double-click on empty grid zooms a step toward it
//   drag a handle            resize an annotation, or move an arrow's end
//   double-click a note      write in it (headings, group titles, markers too)
//   click a card's title     rename the block (or press its pencil)
//
// Blocks also arrive by being dragged in from the palette, which the window
// handles (PlaygroundModal.jsx): the canvas is only where they are let go.
//
// Positions are arithmetic (geometry.js), not measurements, so wires meet the
// dots exactly whatever the zoom, and "which port is this" is portAt() rather
// than a question for the DOM. The world — cards and wires together — is one
// transformed layer, so panning and zooming move it all as one.

import React, { useEffect, useRef, useState } from '../../react.js';
import { BLOCK_BY_TYPE } from '../blocks/index.js';
import {
    FOOT_H, HEAD_H, PAD, PORT_GRAB_PX, RF_H, ROW_H, hasRfLine, isAnnotation, nodeAt, nodeBox, nodeHeight, nodeWidth, nodesInside, portAt,
    portPositionByName, visualTop, screenToWorld, wirePath, zoomAbout, ZOOM_STEP,
} from '../geometry.js';
import { canConnect, connectPorts, removeWire, renameNode } from '../editing.js';
import { NAME_MAX, nodeName } from '../graph.js';
import CardVisual, { ActivityDot, ClipPill, LevelStrip, RfLine, activityMeaning, canClip } from './CardVisual.jsx';
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

// A pencil, for the button that renames a block.
const PENCIL = (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 20h4L19 9l-4-4L4 16z" />
        <path d="m13.5 6.5 4 4" />
    </svg>
);

function Card({ pg, graph, node, selected, errors, rate, latency, cpu, wiredIn, target, look, origin, origins, onParams, naming, session, onRename, onNamed }) {
    const def = BLOCK_BY_TYPE[node.type];
    if (!def) return null;
    const h = nodeHeight(node);
    const ins = inputsOf(node, def);
    const outs = outputsOf(node, def);
    const err = errors && errors.length ? errors.map((e) => e.message).join(' ') : null;
    // Audio or IQ in or out: something with a level to show along the foot.
    // Audio out shows its own, a bar for each ear.
    const carries = (p) => p.kind === 'complex' || p.kind === 'real';
    const leveled = node.type !== 'audio-out' && (ins.some(carries) || outs.some(carries));
    const activity = activityMeaning(def);
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
                {naming ? (
                    <InPlace
                        className="pg-card__name"
                        value={nodeName(node)}
                        session={session}
                        maxLength={NAME_MAX}
                        selectAll
                        onDone={(v) => onNamed(node.id, v)}
                    />
                ) : (
                    <>
                        <span className="pg-card__label" title={node.name ? `${node.name} — a ${def.label}. Click to rename.` : 'Click to rename'}>{nodeName(node)}</span>
                        <button type="button" className="pg-card__rename" title="Rename" aria-label={`Rename ${nodeName(node)}`} onClick={() => onRename(node.id)}>
                            {PENCIL}
                        </button>
                    </>
                )}
                {canClip(def) && <ClipPill pg={pg} id={node.id} />}
                {activity && <ActivityDot pg={pg} id={node.id} meaning={activity} />}
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
                {leveled && <LevelStrip pg={pg} id={node.id} />}
                <span title="The rate this block works at">{formatRate(rate)}</span>
                <span title={latencyTitle}>{latency ? `⏱ ${formatLatency(latency.own)}${def.latencyNote ? '*' : ''}` : ''}</span>
                <span title="Share of one CPU core, measured over the last second">{cpu == null ? '' : `⚙ ${formatCpu(cpu)}`}</span>
            </div>
        </div>
    );
}

const NONE = new Set();
const nothing = () => {};

/**
 * A block as it will look on the canvas, drawn with nothing wired and nothing
 * measured: what a block being dragged in from the palette carries. At the
 * world's origin, in world units — the caller places and scales it.
 */
export function BlockPreview({ pg, node, look }) {
    if (isAnnotation(node.type)) {
        return <Annotation node={node} selected={false} editing={false} session={0} onWritten={nothing} />;
    }
    return (
        <Card
            pg={pg}
            graph={{ nodes: [node], wires: [] }}
            node={node}
            selected={false}
            errors={null}
            rate={null}
            latency={null}
            cpu={null}
            wiredIn={NONE}
            target={null}
            look={look}
            origin={null}
            origins={null}
            onParams={nothing}
            naming={false}
            session={0}
            onRename={nothing}
            onNamed={nothing}
        />
    );
}

// Annotations with nothing to see through: all of their box is them.
const SOLID = new Set(['note', 'heading', 'marker']);

// The annotations whose text is written on the canvas, and which setting holds it.
const WRITTEN = { note: 'text', heading: 'text', group: 'title', marker: 'text' };

/**
 * Text written in place: Enter (Ctrl+Enter in a note) or leaving it keeps it,
 * Escape does not. `session` numbers each edit, so what one edit typed or how
 * it ended can never carry into the next — and the blur that follows an
 * Escape, as the box goes, cannot then keep the text after all.
 */
export function InPlace({ value, session, multiline, onDone, className, style, maxLength, selectAll = false }) {
    const [draft, setDraft] = useState({ session, text: value });
    const ended = useRef(null);
    const text = draft.session === session ? draft.text : value;
    const finish = (keep) => {
        if (ended.current === session) return;
        ended.current = session;
        onDone(keep ? text : null);
    };
    const props = {
        className,
        style,
        value: text,
        maxLength,
        autoFocus: true,
        // A name is usually replaced whole: start with all of it selected.
        onFocus: selectAll ? (e) => e.target.select() : undefined,
        onChange: (e) => setDraft({ session, text: e.target.value }),
        onBlur: () => finish(true),
        onPointerDown: (e) => e.stopPropagation(),
        onKeyDown: (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') finish(false);
            else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
        },
    };
    return multiline ? <textarea {...props} /> : <input {...props} />;
}

/**
 * One annotation, in world coordinates. Only the parts meant to be taken hold
 * of carry `data-node`: a group by its title bar, so the inside of a big one
 * still pans the canvas and reaches the cards on it; a hollow shape by its
 * outline.
 */
function Annotation({ node, selected, editing, session, onWritten }) {
    const p = node.params;
    const b = nodeBox(node);
    const sel = selected ? ' is-selected' : '';
    const handle = selected && node.type !== 'arrow' && node.type !== 'marker' && (
        <i className="pg-ann__handle" data-node={node.id} data-handle="size" style={{ left: `${b.x + b.w}px`, top: `${b.y + b.h}px` }} />
    );
    const writing = (multiline, className, style) => (
        <InPlace value={p[WRITTEN[node.type]]} session={session} multiline={multiline} className={className} style={style} onDone={(v) => onWritten(node.id, WRITTEN[node.type], v)} />
    );
    const box = { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` };
    switch (node.type) {
        case 'note':
            return (
                <>
                    <div className={`pg-ann pg-ann--note pg-ann--${p.colour}${sel}`} data-node={node.id} style={{ ...box, fontSize: `${p.fontSize}px` }}>
                        {editing ? writing(true, 'pg-ann__write', { fontSize: `${p.fontSize}px` })
                            : p.text ? p.text : <span className="pg-ann__empty">Double-click to write</span>}
                    </div>
                    {handle}
                </>
            );
        case 'heading':
            return (
                <>
                    <div className={`pg-ann pg-ann--heading${sel}`} data-node={node.id} style={{ ...box, fontSize: `${p.fontSize}px` }}>
                        {editing ? writing(false, 'pg-ann__write', { fontSize: `${p.fontSize}px` }) : (p.text || <span className="pg-ann__empty">Heading</span>)}
                    </div>
                    {handle}
                </>
            );
        case 'group':
            return (
                <>
                    <div className={`pg-ann pg-ann--group pg-ann--${p.colour}${sel}`} style={box}>
                        <div className="pg-ann__title" data-node={node.id}>
                            {editing ? writing(false, 'pg-ann__write') : (p.title || 'Group')}
                        </div>
                    </div>
                    {handle}
                </>
            );
        case 'marker':
            return (
                <div className={`pg-ann pg-ann--marker pg-ann--${p.colour}${sel}`} data-node={node.id} style={box}>
                    {editing ? writing(false, 'pg-ann__write') : p.text}
                </div>
            );
        case 'rect':
        case 'ellipse': {
            // Drawn inside its box, so a thick outline is not cut off.
            const inset = 2;
            const shape = { className: 'pg-ann__shape', 'data-node': node.id };
            const fill = `pg-ann__svg pg-ann--${p.colour}${p.fill ? ' is-filled' : ''}${p.dashed ? ' is-dashed' : ''}${sel}`;
            return (
                <>
                    <svg className={fill} style={box} width={b.w} height={b.h}>
                        {node.type === 'rect'
                            ? <rect {...shape} x={inset} y={inset} width={Math.max(0, b.w - inset * 2)} height={Math.max(0, b.h - inset * 2)} rx="4" />
                            : <ellipse {...shape} cx={b.w / 2} cy={b.h / 2} rx={Math.max(0, b.w / 2 - inset)} ry={Math.max(0, b.h / 2 - inset)} />}
                    </svg>
                    {handle}
                </>
            );
        }
        case 'arrow': {
            // In a box padded for the heads and the line's width.
            const pad = 6 + p.thickness * 3;
            const x1 = node.x - b.x + pad;
            const y1 = node.y - b.y + pad;
            const x2 = x1 + p.dx;
            const y2 = y1 + p.dy;
            const len = Math.hypot(p.dx, p.dy) || 1;
            const ux = p.dx / len;
            const uy = p.dy / len;
            const head = 4 + p.thickness * 2.5;
            // A head at (x, y) pointing along (dx, dy).
            const tip = (x, y, dx, dy) => `${x},${y} ${x - dx * head - dy * head * 0.55},${y - dy * head + dx * head * 0.55} ${x - dx * head + dy * head * 0.55},${y - dy * head - dx * head * 0.55}`;
            // The line stops short of a head, so a thick one does not poke out of its point.
            const sx = p.heads === 'both' ? x1 + ux * head * 0.8 : x1;
            const sy = p.heads === 'both' ? y1 + uy * head * 0.8 : y1;
            const ex = p.heads === 'none' ? x2 : x2 - ux * head * 0.8;
            const ey = p.heads === 'none' ? y2 : y2 - uy * head * 0.8;
            return (
                <>
                    <svg
                        className={`pg-ann__svg pg-ann--${p.colour}${p.dashed ? ' is-dashed' : ''}${sel}`}
                        style={{ left: `${b.x - pad}px`, top: `${b.y - pad}px` }}
                        width={b.w + pad * 2}
                        height={b.h + pad * 2}
                    >
                        <line className="pg-ann__hit" data-node={node.id} x1={x1} y1={y1} x2={x2} y2={y2} />
                        <line className="pg-ann__line" x1={sx} y1={sy} x2={ex} y2={ey} style={{ strokeWidth: p.thickness }} />
                        {p.heads !== 'none' && <polygon className="pg-ann__head" points={tip(x2, y2, ux, uy)} />}
                        {p.heads === 'both' && <polygon className="pg-ann__head" points={tip(x1, y1, -ux, -uy)} />}
                    </svg>
                    {selected && (
                        <>
                            <i className="pg-ann__handle is-end" data-node={node.id} data-handle="start" style={{ left: `${node.x}px`, top: `${node.y}px` }} />
                            <i className="pg-ann__handle is-end" data-node={node.id} data-handle="end" style={{ left: `${node.x + p.dx}px`, top: `${node.y + p.dy}px` }} />
                        </>
                    )}
                </>
            );
        }
        default:
            return null;
    }
}

export default function Canvas({
    pg, graph, view, setView, selection, setPicked, onEdit, onMoved, onOpenNode, errorsByNode, rates, latencies, stats, look, origins, onParams,
}) {
    const root = useRef(null);
    const drag = useRef(null);
    const [ghost, setGhost] = useState(null);
    const [hover, setHover] = useState(null);
    const [hint, setHint] = useState(null);
    // The annotation whose text is being written in place, if any, and which
    // edit this is.
    const [editing, setEditing] = useState(null);
    const sessions = useRef(0);
    // The block whose name is being written, if any.
    const [naming, setNaming] = useState(null);
    const rename = (id) => {
        sessions.current++;
        setPicked({ nodes: new Set([id]), wire: null });
        setNaming(id);
    };
    const named = (id, value) => {
        setNaming(null);
        if (value === null) return;
        const next = renameNode(graph, id, value);
        if (next !== graph) onEdit(next, `name:${id}`);
    };
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
        if (e.target && e.target.closest && e.target.closest('button, input, select, textarea')) return;
        capture(e);
        const at = world(e);
        const { sx, sy } = local(e);
        // An annotation's handle: its size, or an arrow's end.
        const grip = e.target && e.target.closest && e.target.closest('[data-handle]');
        if (grip) {
            const id = grip.getAttribute('data-node');
            const n = graph.nodes.find((x) => x.id === id);
            if (n) {
                setPicked({ nodes: new Set([id]), wire: null });
                drag.current = { kind: 'resize', id, handle: grip.getAttribute('data-handle'), at, from: { x: n.x, y: n.y, ...n.params }, moved: false };
                return;
            }
        }
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
            // A group carries what is inside it.
            const carried = new Set(sel);
            for (const g of graph.nodes) if (sel.has(g.id) && g.type === 'group') for (const c of nodesInside(graph, g.id)) carried.add(c);
            const origin = {};
            for (const n of graph.nodes) if (carried.has(n.id)) origin[n.id] = { x: n.x, y: n.y };
            // A press on the title that never becomes a drag renames.
            const onTitle = !e.shiftKey && e.target.closest && e.target.closest('.pg-card__label');
            drag.current = { kind: 'move', at, origin, moved: false, title: onTitle ? id : null };
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
        } else if (d.kind === 'resize') {
            const at = world(e);
            const dx = Math.round(at.x - d.at.x);
            const dy = Math.round(at.y - d.at.y);
            if (!d.moved && Math.hypot(dx, dy) < 2) return;
            d.moved = true;
            const f = d.from;
            if (d.handle === 'start') {
                // The start moves; the end stays where it is.
                pg.setPositions({ [d.id]: { x: f.x + dx, y: f.y + dy } });
                pg.setParams(d.id, { dx: f.dx - dx, dy: f.dy - dy });
            } else if (d.handle === 'end') {
                pg.setParams(d.id, { dx: f.dx + dx, dy: f.dy + dy });
            } else {
                pg.setParams(d.id, { w: f.w + dx, h: f.h + dy });
            }
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
        if ((d.kind === 'move' || d.kind === 'resize') && d.moved) onMoved();
        if (d.kind === 'move' && !d.moved && d.title) rename(d.title);
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
        const near = (sel) => !!(e.target && e.target.closest && e.target.closest(sel));
        if (near('button, input, select, textarea')) return;
        const at = world(e);
        const id = nodeAt(graph, at.x, at.y);
        const n = id && graph.nodes.find((x) => x.id === id);
        // Empty grid — nothing there, or only the see-through inside of an
        // annotation (a group's body, a hollow shape's middle, the space round
        // an arrow) — zooms a step toward the pointer, keeping what is under it
        // where it is. A solid annotation is found by where the pointer is, as
        // a card is; a see-through one only by what was pressed.
        const solid = n && (SOLID.has(n.type) || ((n.type === 'rect' || n.type === 'ellipse') && n.params.fill));
        const onAnnotation = n && isAnnotation(n.type) && (solid || near('[data-node]'));
        if ((!n || (isAnnotation(n.type) && !onAnnotation)) && !near('.pg-wire__hit')) {
            const { sx, sy } = local(e);
            setView(zoomAbout(view, sx, sy, ZOOM_STEP));
            return;
        }
        if (!n) return;
        // Annotations with words are written in place; a group only from its title.
        if (WRITTEN[n.type]) {
            const onTitle = n.type !== 'group' || near('.pg-ann__title');
            if (onTitle) {
                setPicked({ nodes: new Set([id]), wire: null });
                sessions.current++;
                setEditing(id);
            }
            return;
        }
        if (onOpenNode) onOpenNode(id);
    };
    const written = (id, param, value) => {
        setEditing(null);
        const n = graph.nodes.find((x) => x.id === id);
        if (value !== null && n && n.params[param] !== value) onParams(id, { [param]: value }, `param:${id}:${param}`);
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
                {/* Under the wires and the cards: annotations are about them. */}
                <div className="pg-anns">
                    {graph.nodes.map((n) => (isAnnotation(n.type) ? (
                        <Annotation key={n.id} node={n} selected={selection.nodes.has(n.id)} editing={editing === n.id} session={sessions.current} onWritten={written} />
                    ) : null))}
                </div>
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
                    if (isAnnotation(n.type)) return null;
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
                            naming={naming === n.id}
                            session={sessions.current}
                            onRename={rename}
                            onNamed={named}
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
