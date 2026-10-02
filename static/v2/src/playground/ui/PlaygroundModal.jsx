// The playground's window: a toolbar, the blocks, the canvas, and the
// selection's controls.
//
// A view over the engine (playground/engine.js), which outlives it — closing
// this leaves a running graph running, the same way folding the IQ Demod panel
// away leaves its demodulators going. The graph lives in the engine; what
// lives here is only what is about looking at it: the view, the selection, and
// the undo history, which starts afresh each time the window opens.

import React, { useEffect, useMemo, useReducer, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { MODE_BY_ID, isIQ } from '../../radio/constants.js';
import { serverClock } from '../../radio/serverClock.js';
import { Button, Icon, Modal } from '../../components/ui.jsx';
import { arrivalQuery, shareOriginHere, shareQuery } from '../../lib/share.js';
import { ubersdrAppUri } from '../../lib/appLinks.js';
import { insideApp } from '../../lib/hostPanels.js';
import { saveText } from '../../lib/saveFile.js';
import { cleanGraphName, emptyGraph, parseGraph, serializeGraph } from '../graph.js';
import {
    bundleGraphs, deleteSaved, fileNameFor, findSaved, importBundle, isBundle, openSaved, sameGraphName, saveGraph, saveState, savedGraphs,
} from '../library.js';
import { ExportDialog, GraphName, OpenDialog, SaveNameDialog, SaveReplaceDialog } from './GraphLibrary.jsx';
import { Runtime } from '../runtime.js';
import { encodeShare } from '../share.js';
import { getPlayground, graphIqWidth, needsReceiver } from '../engine.js';
import { BLOCK_BY_TYPE } from '../blocks/index.js';
import {
    EditHistory, addNode, cloneGraph, duplicateNodes, exposeControl, removeNodes, removeWire, renameNode,
} from '../editing.js';
import { HEAD_H, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, autoLayout, fitView, isAnnotation, nodeBox, screenToWorld, zoomToward } from '../geometry.js';
import { addAcross, addProbe, frequencyOrigins } from '../probes.js';
import { expandNode } from '../expand.js';
import { TEMPLATES } from '../templates.js';
import { INSTRUMENTS } from './viewers.jsx';
import { useDisplay } from '../../display/DisplayContext.jsx';
import Canvas, { BlockPreview, formatCpu, formatLatency } from './Canvas.jsx';
import Inspector from './Inspector.jsx';
import JsonPane from './JsonPane.jsx';
import Palette from './Palette.jsx';
import { closePlayground, offerSharedGraph, usePlaygroundUi } from './store.js';
import { holdSpectrum } from '../../lib/spectrumPause.js';
import { versionNote } from '../version.js';
import { channelSummary, graphFromAllChannels, graphFromIQDemod, iqDemodChannels } from '../fromIQDemod.js';

// The nodes whose readings the cards draw. Others have nothing live to show,
// and asking for an Audio out's reading would copy its samples back for nothing.
export const WATCHED_TYPES = new Set([
    'meter', 'level-detector', 'squelch', 'carrier-tracker', 'control-scale', 'integrator', 'control-plot', 'iq-player', 'data-tx', 'demodulator',
    'costas-loop', 'morse-decoder', 'uart', 'sitor-decoder', 'fsk-detector', 'ook-detector',
    'rtty-decoder', 'psk31-decoder', 'cw-decoder', 'navtex-decoder', 'noise-blanker', 'nr2', 'compressor', 'morse-encoder',
    ...INSTRUMENTS,
]);

/** The query parameter a shared graph arrives in. */
export const SHARE_PARAM = 'playground';

/** The rate the stream has, or will have once IQ is chosen. */
function streamRateFor(mode, measured) {
    if (measured > 0) return measured;
    const def = isIQ(mode) && MODE_BY_ID[mode];
    return def ? def.high - def.low : 12000;
}

export { graphFromIQDemod, graphFromAllChannels };

/**
 * Compile a graph off to the side, as the worker would: its errors, every
 * block's rate, and every block's latency — known before anything runs.
 */
function inspect(graph, rate) {
    const rt = new Runtime(graph, rate, { now: () => 0 });
    const errorsByNode = {};
    for (const e of rt.errors) {
        if (!e.node) continue;
        (errorsByNode[e.node] = errorsByNode[e.node] || []).push(e);
    }
    const latencies = {};
    for (const n of graph.nodes) {
        const l = rt.latencyOf(n.id);
        if (l) latencies[n.id] = l;
    }
    return {
        ok: rt.ok, errors: rt.errors, errorsByNode, rates: rt.plan.inRate, latencies,
        order: rt.plan.order || [], inputs: rt.plan.inputs || {},
    };
}

/**
 * The latencies with the IQ stream's own age put in: how old its samples
 * already are on arriving here — capture at the receiver, radiod, the network
 * — measured from the capture time on every packet (see audio-connection's
 * arrivalLag). Each block downstream then reads from the antenna rather than
 * from the graph's edge. `arrivalSec` null — nothing arriving, or the
 * receiver's clock not measured yet — leaves the IQ stream's own figure
 * unknown and every total as the blocks alone make it.
 * Exported for the test.
 */
export function withArrival(info, graph, arrivalSec) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const known = arrivalSec != null && Number.isFinite(arrivalSec);
    const out = {};
    for (const id of info.order) {
        const l = info.latencies[id];
        const n = byId.get(id);
        if (!l || !n) continue;
        if (n.type === 'iq-in') {
            out[id] = { own: known ? Math.max(0, arrivalSec) : null, total: known ? Math.max(0, arrivalSec) : null, arrival: true };
            continue;
        }
        let before = 0;
        for (const f of info.inputs[id] || []) {
            if (f && out[f[0]] && out[f[0]].total > before) before = out[f[0]].total;
        }
        out[id] = { own: l.own, total: before + l.own };
    }
    return out;
}

// How far a press on a palette block moves before it is a drag rather than a
// click, in screen pixels — the canvas's own threshold.
const DRAG_PX = 4;

/** Everything about a graph except where its cards sit. */
const structureKey = (g) => JSON.stringify([g.nodes.map((n) => [n.id, n.type, n.params]), g.wires]);

// A list under a toolbar button, shut by a press elsewhere or by Escape. Its
// own rather than the app's Menu: that one is layered for the dock and opens
// behind this window.
function useDropdown() {
    const [open, setOpen] = useState(false);
    const box = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const away = (e) => { if (box.current && box.current.contains && !box.current.contains(e.target)) setOpen(false); };
        const key = (e) => {
            if (e.key !== 'Escape') return;
            // Shut the list, not the window behind it.
            e.stopPropagation();
            setOpen(false);
        };
        document.addEventListener('pointerdown', away, true);
        document.addEventListener('keydown', key, true);
        return () => {
            document.removeEventListener('pointerdown', away, true);
            document.removeEventListener('keydown', key, true);
        };
    }, [open]);
    return { open, setOpen, box };
}

/** The templates, as a list under a button. */
export function TemplatesMenu({ onPick }) {
    const { open, setOpen, box } = useDropdown();
    return (
        <span className="pg-tpl" ref={box}>
            <Button size="sm" variant="ghost" icon={<Icon.Layers />} title="Start from a ready-made graph" aria-expanded={open} onClick={() => setOpen(!open)}>Templates</Button>
            {open && (
                <div className="pg-tpl__list" role="menu">
                    {TEMPLATES.map((t, k) => [
                        t.group && t.group !== (TEMPLATES[k - 1] || {}).group && (
                            <div key={`group:${t.group}`} className="pg-tpl__group">{t.group}</div>
                        ),
                        <button
                            key={t.id}
                            type="button"
                            role="menuitem"
                            className="pg-tpl__item"
                            onClick={() => { setOpen(false); onPick(t); }}
                        >
                            <span className="pg-tpl__title">{t.title}</span>
                            <span className="pg-tpl__summary">{t.summary}</span>
                        </button>,
                    ])}
                </div>
            )}
        </span>
    );
}

// The toolbar's annotation buttons, each with a glyph of what it adds.
const ANNOTATE_TOOLS = [
    { type: 'note', title: 'Add a note', glyph: <><path d="M4 4h16v11l-5 5H4z" /><path d="M15 20v-5h5" /><path d="M8 9h8M8 13h5" /></> },
    { type: 'heading', title: 'Add a heading', glyph: <path d="M6 5h12M12 5v14M9 19h6" /> },
    { type: 'group', title: 'Add a group box — drag it by its title and what is inside goes with it', glyph: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></> },
    { type: 'rect', title: 'Add a rectangle', glyph: <rect x="4" y="6" width="16" height="12" rx="1.5" /> },
    { type: 'ellipse', title: 'Add an ellipse', glyph: <ellipse cx="12" cy="12" rx="8.5" ry="6" /> },
    { type: 'arrow', title: 'Add an arrow', glyph: <><path d="M4 18 18 6" /><path d="M11 6h7v7" /></> },
    { type: 'marker', title: 'Add a numbered step marker', glyph: <><circle cx="12" cy="12" r="8.5" /><path d="M11 9l2-1.5V16" /></> },
];

const glyph = (g, size = 16) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {g}
    </svg>
);

/**
 * The same tools folded into one button, for a toolbar too narrow to show
 * seven of them: each named in the list, beside its glyph.
 */
export function AnnotateMenu({ onAdd }) {
    const { open, setOpen, box } = useDropdown();
    return (
        <span className="pg-tpl" ref={box}>
            <Button
                size="sm"
                variant="ghost"
                icon={glyph(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>)}
                title="Draw: notes, headings, groups and shapes"
                aria-label="Draw"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            />
            {open && (
                <div className="pg-tpl__list pg-draw__list" role="menu">
                    {ANNOTATE_TOOLS.map((t) => (
                        <button
                            key={t.type}
                            type="button"
                            role="menuitem"
                            className="pg-tpl__item pg-draw__item"
                            title={t.title}
                            onClick={() => { setOpen(false); onAdd(t.type); }}
                        >
                            {glyph(t.glyph)}
                            <span className="pg-tpl__title">{(BLOCK_BY_TYPE[t.type] || {}).label || t.type}</span>
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}

function AnnotateTools({ onAdd }) {
    return (
        <span className="pg-bar__group" role="group" aria-label="Annotate">
            {ANNOTATE_TOOLS.map((t) => (
                <button key={t.type} type="button" className="pg-bar__tool" title={t.title} aria-label={t.title} onClick={() => onAdd(t.type)}>
                    {glyph(t.glyph)}
                </button>
            ))}
        </span>
    );
}

// How much of the title bar a row this wide can show, measured rather than
// guessed at a breakpoint: the room it needs moves with the UI scale, the
// status text and the platform's font. Each step puts one more thing away:
//
//   1  the "Playground" label
//   2  the status line — Start/Stop says most of it, and the rest is in the
//      button's tooltip
//   3  the words on the graph buttons (New, Open, Save…) — their icons stay,
//      and their tooltips still name them
//   4  the seven drawing tools, folded into one Draw button with a list
//
// It never wraps. The graph's name gives way before any of this (see
// .pg__name-box), so the toolbar only overflows once the name is as short as
// it goes.
//
// A step is taken when the toolbar overflows, and remembers how wide the whole
// title bar would have had to be to avoid it; the step is undone only once the
// title bar is that wide. The title bar's width, not the toolbar's: putting the
// label away (step 1) widens the toolbar without the window changing at all,
// and measured against itself the toolbar would take that as room to unfold
// into — bringing the label back, overflowing again, and flickering for as
// long as the window stayed at that width.
const COMPACT_MAX = 4;
export function useCompactRow(ref) {
    const [level, setLevel] = useState(0);
    const needed = useRef([]);
    const levelNow = useRef(0);
    levelNow.current = level;
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const row = el.parentElement || el;
        const check = () => {
            const at = levelNow.current;
            const short = el.scrollWidth - el.clientWidth;
            if (at < COMPACT_MAX && short > 1) {
                needed.current[at] = row.clientWidth + short;
                setLevel(at + 1);
            } else if (at > 0 && row.clientWidth >= (needed.current[at - 1] || Infinity)) {
                setLevel(at - 1);
            }
        };
        const ro = new ResizeObserver(check);
        ro.observe(row);
        if (row !== el) ro.observe(el);
        check();
        return () => ro.disconnect();
    }, [ref, level]);
    return level;
}

function Toolbar({
    pg, live, offline, iq, onStart, onStop, history, onUndo, onRedo, onFit, onFromDemod, onNew, onImport, onExport, onShare,
    onTemplate, onAnnotate, json, onJson, onSave, onOpen,
}) {
    const on = pg.running;
    const bar = useRef(null);
    const compact = useCompactRow(bar);
    const status = !live ? 'Start the receiver to run a graph that listens to it — or use an IQ player, which needs none.'
        : !on ? (offline ? 'Ready — this graph runs by itself, without the receiver.'
            : iq ? 'Ready — the receiver is in IQ.' : 'Starting will switch the receiver to IQ.')
            : pg.fault ? `Stopped by an error: ${pg.fault}`
                : !pg.offline && !pg.quadrature ? 'Waiting for the quadrature stream…'
                    : `Running${pg.overloaded ? ' — overloaded, dropping packets' : ''}`;
    // Where and how, for anybody who wants it: in the tooltip, and on Start/Stop
    // too, which is where it still is once the status line has been put away.
    const detail = on && !pg.fault && (pg.offline || pg.quadrature)
        ? `${status} — ${pg.offline ? 'by itself, without the receiver, ' : ''}${pg.hostKind === 'worker' ? 'in a worker' : 'on the page'}`
        : status;
    return (
        // Cumulative: a bar folded to step 3 is is-fold-1, -2 and -3 at once.
        <div className={['pg-bar', ...Array.from({ length: compact }, (_, k) => `is-fold-${k + 1}`)].join(' ')} ref={bar}>
            <Button
                size="sm"
                variant={on ? 'default' : 'primary'}
                icon={on ? <Icon.Stop /> : <Icon.Play />}
                disabled={!live}
                title={detail}
                onClick={on ? onStop : onStart}
            >
                {on ? 'Stop' : 'Start'}
            </Button>
            {/* One line, cut short with an ellipsis where it has to be — the
                whole of it is in the tooltip. */}
            <span className="pg-bar__status" title={detail}>{status}</span>
            {/* Grouped by what the buttons are for, with a rule between each
                group: editing, drawing, where a graph comes from, keeping it,
                moving it about, and its JSON. */}
            <span className="pg-bar__sep" aria-hidden="true" />
            <span className="pg-bar__group">
                <Button size="sm" variant="ghost" icon={<Icon.RotateLeft />} disabled={!history.canUndo} title="Undo (Ctrl+Z)" onClick={onUndo} />
                <Button size="sm" variant="ghost" icon={<Icon.RotateRight />} disabled={!history.canRedo} title="Redo (Ctrl+Shift+Z)" onClick={onRedo} />
                <Button size="sm" variant="ghost" icon={<Icon.Expand />} title="Fit the graph to the window (F)" onClick={onFit} />
            </span>
            <span className="pg-bar__sep" aria-hidden="true" />
            {compact < 4 ? <AnnotateTools onAdd={onAnnotate} /> : <AnnotateMenu onAdd={onAnnotate} />}
            <span className="pg-bar__sep" aria-hidden="true" />
            <span className="pg-bar__group pg-bar__files">
                <TemplatesMenu onPick={onTemplate} />
                <Button size="sm" variant="ghost" icon={<Icon.Waves />} title="Replace the graph with IQ Demod’s selected demodulator" onClick={onFromDemod}>From IQ Demod</Button>
            </span>
            <span className="pg-bar__sep" aria-hidden="true" />
            <span className="pg-bar__group pg-bar__files">
                <Button size="sm" variant="ghost" icon={<Icon.Plus />} title="Start again from an empty canvas" onClick={onNew}>New</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Folder />} title="Open a graph saved in this browser" onClick={onOpen}>Open</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Save />} title="Save the graph in this browser, under its name (Ctrl+S)" onClick={onSave}>Save</Button>
            </span>
            <span className="pg-bar__sep" aria-hidden="true" />
            <span className="pg-bar__group pg-bar__files">
                <Button size="sm" variant="ghost" icon={<Icon.Upload />} title="Load a graph, or a file of graphs, from a .json file" onClick={onImport}>Import</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Download />} title="Save the graph, or saved graphs, as a .json file" onClick={onExport}>Export</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Share />} title="Copy a link to this graph" onClick={onShare}>Share</Button>
            </span>
            <span className="pg-bar__sep" aria-hidden="true" />
            <span className="pg-bar__group pg-bar__files">
                <Button
                    size="sm"
                    variant={json ? 'primary' : 'ghost'}
                    icon={<Icon.Code />}
                    aria-pressed={json}
                    title={json ? 'Hide the graph’s JSON' : 'Edit the graph as JSON, beside the canvas'}
                    onClick={onJson}
                >JSON</Button>
            </span>
        </div>
    );
}

function Summary({ pg, graph, info, stats }) {
    const outs = graph.nodes.filter((n) => n.type === 'audio-out');
    const worst = outs.reduce((m, n) => Math.max(m, (info.latencies[n.id] || {}).total || 0), 0);
    const measured = graph.nodes.some((n) => n.type === 'iq-in' && info.latencies[n.id] && info.latencies[n.id].own != null);
    return (
        <>
            <div className="pg-insp__title">This graph</div>
            <div className="readout-grid">
                <div className="readout"><div className="readout__label">Blocks</div><div className="readout__value">{graph.nodes.filter((n) => !isAnnotation(n.type)).length}</div></div>
                <div className="readout"><div className="readout__label">To the speakers</div><div className="readout__value">{outs.length ? formatLatency(worst) : '—'}</div></div>
                <div className="readout"><div className="readout__label">CPU</div><div className="readout__value">{stats ? formatCpu(stats.cpu) : '—'}</div></div>
                <div className="readout"><div className="readout__label">Last packet</div><div className="readout__value">{pg.running ? `${pg.costMs.toFixed(2)} ms` : '—'}</div></div>
            </div>
            {info.errors.length > 0 && (
                <div className="pg-insp__section">
                    <div className="pg-insp__title">Not running until fixed</div>
                    {info.errors.map((e, i) => <div key={i} className="note note--tight note--warn">{e.node ? `${e.node}: ` : ''}{e.message}</div>)}
                </div>
            )}
            <div className="pg-insp__section pg-insp__help">
                <div className="pg-insp__title">How to</div>
                <p>Press a block on the left to add it. Drag from an output dot to an input dot of the same colour to wire them; drag from a wired input to move or remove its wire.</p>
                <p>To see a signal anywhere, select a block or a wire and attach an instrument — spectrum, scope, constellation, frequency counter — to any input or output. Instruments only listen: the path carries on as it was.</p>
                <p>Select a filter and press Measure gain &amp; phase to see what it does to the signal going through it.</p>
                <p>Drag the background to pan, scroll to zoom. Shift-press to select several. Delete removes, Ctrl+D duplicates, Ctrl+Z undoes.</p>
                <p>{measured
                    ? '“To the speakers” is how old the audio is on leaving the graph: capture at the receiver and the trip here, measured, plus the delay the blocks add. This browser’s audio output comes on top.'
                    : '“To the speakers” is the delay the blocks add. How old the IQ already is on arriving shows on the IQ stream block once it is arriving; this browser’s audio output comes on top.'}</p>
            </div>
        </>
    );
}

// Over the middle of the window rather than in a strip along the top: a link
// that was followed is the reason the window opened, and until it is answered
// the graph underneath is still the operator's own.
// `appUri` is the link this page arrived on, as an ubersdr:// link: the same
// graph and tuning, opened in the UberSDR app instead of here. Null inside an
// app already, or for a receiver the directory does not list (no UUID to name).
function SharedOffer({ pending, onLoad, appUri }) {
    const ok = pending.graph && pending.graph.nodes.length > 0;
    const count = ok ? pending.graph.nodes.length : 0;
    const older = ok ? versionNote(pending.ubersdr) : null;
    return (
        <div className="pg-dialog pg-offer" role="dialog" aria-label="Shared graph">
            <div className="pg-dialog__card">
                <div className="pg-dialog__title">{ok ? 'Shared graph' : 'Shared graph unreadable'}</div>
                <p>
                    {ok ? `A link brought ${pending.graph.name ? `“${pending.graph.name}”, ` : ''}a graph of ${count} ${count === 1 ? 'block' : 'blocks'}. Loading it replaces the one open now; you can put yours back afterwards.` : 'A playground link could not be read.'}
                    {pending.errors && pending.errors.length ? ` ${pending.errors.map((e) => e.message).join(' ')}` : ''}
                </p>
                {older && <div className="note note--tight note--warn pg-offer__version">{older}</div>}
                <div className="pg-dialog__actions">
                    <Button size="sm" variant="ghost" onClick={() => offerSharedGraph(null)}>{ok ? 'Keep mine' : 'Dismiss'}</Button>
                    {/* A link rather than a button: following a scheme is what
                        hands it to the app. The offer stays up, because nothing
                        here can tell whether an app answered — an unclaimed
                        scheme does nothing at all — and loading it here is still
                        the way on if none did. */}
                    {ok && appUri && (
                        <a
                            className="btn btn--default btn--sm"
                            href={appUri}
                            title="Open this graph, and the receiver it was shared from, in the UberSDR app"
                        >
                            Open in App
                        </a>
                    )}
                    {ok && <Button size="sm" variant="primary" onClick={onLoad}>Load it</Button>}
                </div>
            </div>
        </div>
    );
}

// Before New, Import, From IQ Demod or a template throws away a graph: a
// canvas cleared by a stray press is hours of wiring gone, and the way to keep
// a copy is right here. A title may name what is coming (`subject`).
const REPLACING = {
    new: { title: 'Start a new graph?', what: 'will be cleared from the canvas', go: 'Clear it' },
    import: { title: 'Import a graph?', what: 'will be replaced by the file you choose, if it holds one graph — a file of several adds them to the saved graphs instead', go: 'Choose file…' },
    demod: { title: 'Load IQ Demod’s demodulator?', what: 'will be replaced by IQ Demod’s selected demodulator', go: 'Replace it' },
    template: { title: (subject) => `Load “${subject}”?`, what: 'will be replaced by the template', go: 'Load it' },
};

/**
 * From IQ Demod with more than one demodulator in the panel: which to bring,
 * or all of them. Also says what it replaces, where there is anything to
 * replace, so it is the one question rather than two.
 */
function PickChannel({ channels, active, count, onExport, onCancel, onPick }) {
    return (
        <div className="pg-dialog pg-confirm pg-pick" role="dialog" aria-label="Which demodulator?">
            <div className="pg-dialog__card">
                <div className="pg-dialog__title">Which demodulator?</div>
                <p>{`IQ Demod has ${channels.length}. Bring one of them, or all of them on one IQ stream, each in a group of its own.`}</p>
                <div className="pg-pick__list">
                    {channels.map((c, i) => (
                        <Button key={i} size="sm" variant={i === active ? 'primary' : 'default'} onClick={() => onPick(i)}>
                            {`${channelSummary(c, i)}${i === active ? ' (selected)' : ''}`}
                        </Button>
                    ))}
                </div>
                {count > 0 && <p>{`The graph open now, ${count} ${count === 1 ? 'block' : 'blocks'}, will be replaced. Export it first to keep a copy.`}</p>}
                <div className="pg-dialog__actions">
                    {count > 0 && <Button size="sm" variant="ghost" icon={<Icon.Download />} onClick={onExport}>Export</Button>}
                    <span className="pg-dialog__gap" />
                    <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                    <Button size="sm" variant={count > 0 ? 'danger' : 'primary'} onClick={() => onPick('all')}>All channels</Button>
                </div>
            </div>
        </div>
    );
}

function ConfirmReplace({ kind, subject, count, onExport, onCancel, onConfirm }) {
    const t = REPLACING[kind];
    const title = typeof t.title === 'function' ? t.title(subject) : t.title;
    return (
        <div className="pg-dialog pg-confirm" role="dialog" aria-label={title}>
            <div className="pg-dialog__card">
                <div className="pg-dialog__title">{title}</div>
                <p>{`The graph open now, ${count} ${count === 1 ? 'block' : 'blocks'}, ${t.what}. Export it first to keep a copy.`}</p>
                <div className="pg-dialog__actions">
                    <Button size="sm" variant="ghost" icon={<Icon.Download />} onClick={onExport}>Export</Button>
                    <span className="pg-dialog__gap" />
                    <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                    <Button size="sm" variant="danger" onClick={onConfirm}>{t.go}</Button>
                </div>
            </div>
        </div>
    );
}

export function PlaygroundWindow({ onClose }) {
    const { running, audioState, tuning, actions, player, allowedIQModes, audioConn, spectrumConn, serverInfo } = useRadio();
    // Listed in the directory, so an ubersdr:// link can name this receiver.
    const publicUuid = (serverInfo && serverInfo.public_uuid) || '';
    const callsign = ((serverInfo && serverInfo.receiver && serverInfo.receiver.callsign) || '').trim();
    const pg = getPlayground(player);

    // The spectrum is paused while this window is open — it covers the display,
    // and a waterfall nobody can see is CPU and bandwidth the graph could use —
    // and comes back on closing, unless it was paused already (lib/
    // spectrumPause.js holdSpectrum). Held again if the receiver is started
    // while the window is open; never brought back for a receiver that has
    // stopped, which the latest `running` says on the way out.
    const runningNow = useRef(running);
    runningNow.current = running;
    useEffect(() => {
        if (!running || !spectrumConn) return undefined;
        const release = holdSpectrum(spectrumConn);
        return () => release(runningNow.current);
    }, [running, spectrumConn]);
    const ui = usePlaygroundUi();
    const iq = isIQ(tuning.mode);
    const live = running && audioState === 'open';
    const rate = streamRateFor(tuning.mode, pg.running ? pg.streamRate || 0 : 0);

    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => pg.on('change', bump), [pg]);
    useEffect(() => pg.on('stats', bump), [pg]);

    const history = useRef(null);
    if (!history.current) history.current = new EditHistory(cloneGraph(pg.graph));
    const [view, setView] = useState({ x: 32, y: 32, zoom: 1 });
    const [selection, setPicked] = useState({ nodes: new Set(), wire: null });
    const [notice, setNotice] = useState(null);
    const [asking, setAsking] = useState(null);
    // The template a 'template' question is about.
    const [template, setTemplate] = useState(null);
    const [sides, setSides] = useState(readSides);
    // The latest, for two folds before the next render to both count.
    const sidesNow = useRef(sides);
    const fold = (side) => {
        const next = { ...sidesNow.current, [side]: !sidesNow.current[side] };
        sidesNow.current = next;
        writeSides(next);
        setSides(next);
    };
    // A block double-clicked: its settings, with the panel that holds them
    // opened if it had been folded away.
    const openNode = (id) => {
        setPicked({ nodes: new Set([id]), wire: null });
        if (sidesNow.current.right) fold('right');
    };
    const canvasBox = useRef(null);
    const fileInput = useRef(null);

    const graph = pg.graph;
    const key = structureKey(graph);
    const compiled = useMemo(() => inspect(graph, rate), [key, rate]);
    // The IQ's age on arriving, read again every second while it arrives.
    const [, tickAge] = useReducer((n) => n + 1, 0);
    const listening = needsReceiver(graph) && iq && running;
    useEffect(() => {
        if (!listening) return undefined;
        const t = setInterval(tickAge, 1000);
        return () => clearInterval(t);
    }, [listening]);
    const lag = listening && audioConn ? audioConn.arrivalLag : null;
    const clk = lag != null ? serverClock() : null;
    const arrivalSec = clk ? (lag + clk.theta) / 1000 : null;
    const info = { ...compiled, latencies: withArrival(compiled, graph, arrivalSec) };
    const origins = useMemo(() => frequencyOrigins(graph, tuning.frequency), [key, tuning.frequency]);
    const display = useDisplay();
    // What the instruments draw with: the operator's waterfall palette, and
    // the dial, so a spectrum of the stream is labelled in real frequencies.
    const look = { palette: (display && display.palette) || 'classic', dialHz: tuning.frequency };
    const stats = pg.running ? pg.stats : null;

    // Readings for the cards that draw them, for as long as the window is open.
    const watchKey = graph.nodes.filter((n) => WATCHED_TYPES.has(n.type)).map((n) => n.id).join(',');
    useEffect(() => {
        // Every block's level too, for the cards' strips and Audio out's bar.
        pg.watch(watchKey ? watchKey.split(',') : [], { levels: true });
        return () => pg.watch([]);
    }, [pg, watchKey]);

    const size = () => {
        const el = canvasBox.current;
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return r && r.width ? { w: r.width, h: r.height } : { w: 800, h: 500 };
    };
    const fit = (g = graph) => {
        const { w, h } = size();
        setView(fitView(g, w, h));
    };
    // The zoom buttons: toward the selected blocks where there are some.
    const zoomBy = (factor) => {
        const { w, h } = size();
        const picked = graph.nodes.filter((n) => selection.nodes.has(n.id));
        // From the latest view, so two presses before a render are two steps.
        setView((v) => zoomToward(v, w, h, factor, picked.length ? { nodes: picked } : null));
    };
    // Fit once on opening, so the graph is on screen however it was left.
    useEffect(() => { fit(); }, []);

    /** Every edit goes through here: into the engine, and onto the history. */
    const apply = (next, why = null) => {
        if (next === graph) return;
        history.current.push(cloneGraph(next), why);
        pg.setGraph(next);
    };
    // Something else in the canvas, and what it is called with it — nothing, if
    // it says nothing. A replacement is never the saved graph the last one was,
    // unless it says so (openSaved does).
    const replace = (next, message) => {
        history.current.replace(cloneGraph(next));
        pg.setGraph({ ...next, name: next.name || '', savedAs: next.savedAs || '' });
        setPicked({ nodes: new Set(), wire: null });
        fit(next);
        if (message) setNotice(message);
    };
    // A replacement the operator did not build, with a button on the notice
    // that brings back what they had. As an edit of its own rather than an
    // undo, so it still restores their graph after they have changed the new
    // one.
    const replaceKeepingBack = (next, text) => replace(next, {
        text,
        back: { ...cloneGraph(graph), name: graph.name || '', savedAs: graph.savedAs || '' },
    });
    const putBack = (back) => {
        apply(back);
        setPicked({ nodes: new Set(), wire: null });
        fit(back);
        setNotice('Your graph is back. Undo brings the loaded one back again.');
    };

    // A graph with no IQ stream in it — a file, a generator — runs by
    // itself: no receiver needed, and the mode is left alone.
    const offline = !needsReceiver(graph);
    // Whether this visit may have the IQ width a graph is built for.
    const widthUsable = (g) => {
        const want = graphIqWidth(g);
        return !want || want === 'iq' || (allowedIQModes || []).includes(want);
    };
    // `g` for a graph just handed to the engine, which this render has not seen.
    const start = (g = graph) => {
        if (!needsReceiver(g)) {
            pg.start();
            return;
        }
        pg.restoreMode = iq ? null : tuning.mode;
        // At the IQ width the graph is built for, where this visit may have
        // it; plain IQ where not, which the IQ stream block says.
        const width = widthUsable(g) ? graphIqWidth(g) : 'iq';
        if (tuning.mode !== width) actions.setMode(width);
        pg.start();
    };
    // A graph from a link starts as soon as it is loaded: following a link to
    // hear something and then having to find Start is one step too many. Only
    // when it can run as it was built — the receiver up, and the IQ width the
    // sender used available here. A playground already running carries on
    // with the new graph by itself.
    const loadShared = (g) => {
        offerSharedGraph(null);
        if (pg.running) {
            replaceKeepingBack(g, 'Loaded the shared graph.');
            return;
        }
        if (!needsReceiver(g)) {
            replaceKeepingBack(g, 'Loaded the shared graph. It runs without the receiver: press Start when ready.');
            return;
        }
        if (!widthUsable(g)) {
            const m = MODE_BY_ID[graphIqWidth(g)];
            replaceKeepingBack(g, `Loaded the shared graph, but not started: it is built for ${m ? m.label : 'wide IQ'}, which this receiver does not offer you.`);
            return;
        }
        if (!live) {
            replaceKeepingBack(g, 'Loaded the shared graph. Press Start once the receiver is running.');
            return;
        }
        replaceKeepingBack(g, 'Loaded the shared graph and started it.');
        start(g);
    };
    const stop = () => {
        if (pg.offline) {
            pg.stop();
            return;
        }
        const back = pg.restoreMode;
        pg.restoreMode = null;
        pg.stop();
        if (back && isIQ(tuning.mode)) actions.setMode(back);
    };

    // In the middle of what can be seen, stepped a little each time so a few
    // added in a row do not land on one another.
    const add = (type) => {
        const { w, h } = size();
        const centre = screenToWorld(view, w / 2, h / 2);
        const n = graph.nodes.length % 6;
        const r = addNode(graph, type, 0, 0);
        const box = nodeBox(r.graph.nodes.find((x) => x.id === r.id));
        addAt(type, centre.x - box.w / 2 + n * 18, centre.y - box.h / 2 + n * 18);
    };
    const addAt = (type, x, y) => {
        const r = addNode(graph, type, x, y);
        if (!r.id) return;
        apply(r.graph, null);
        setPicked({ nodes: new Set([r.id]), wire: null });
    };

    // A block dragged in from the palette: the block itself follows the
    // pointer, at the canvas's zoom, and lands where it is let go — held by
    // the middle of its title, or the middle of an annotation. Let go anywhere
    // but the canvas, or Escape, and nothing is added. A press that never
    // moves far is the palette's click, and adds as it always has.
    const [carry, setCarry] = useState(null);
    const pgRoot = useRef(null);
    // Whether the press just ended was a drag, so its click adds nothing.
    const dragged = useRef(false);
    // The latest render's, for the listeners a drag outlives renders with.
    const latest = useRef(null);
    latest.current = { addAt, view, graph };
    const overCanvas = (x, y) => {
        const el = canvasBox.current;
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return !!r && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    };
    const pickUp = (type, e) => {
        if (e.button !== 0) return;
        // No text selection starting under a mouse drag.
        if (e.pointerType === 'mouse' && e.preventDefault) e.preventDefault();
        dragged.current = false;
        const sx = e.clientX;
        const sy = e.clientY;
        let held = null;
        const follow = (x, y) => {
            const root = pgRoot.current;
            const r = root && root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, top: 0 };
            const { zoom } = latest.current.view;
            held = {
                ...held,
                x, y,
                left: x - r.left - held.grab.x * zoom,
                top: y - r.top - held.grab.y * zoom,
                zoom,
                over: overCanvas(x, y),
            };
            setCarry(held);
        };
        const move = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            if (!held) {
                if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_PX) return;
                dragged.current = true;
                const r = addNode(latest.current.graph, type, 0, 0);
                const node = r.graph.nodes.find((n) => n.id === r.id);
                if (!node) return;
                const b = nodeBox(node);
                const grab = {
                    x: b.x + b.w / 2,
                    y: isAnnotation(type) ? b.y + b.h / 2 : Math.min(HEAD_H / 2, b.h / 2),
                };
                held = { node, grab };
            }
            follow(ev.clientX, ev.clientY);
        };
        const end = (drop, ev) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', cancel);
            document.removeEventListener('keydown', key, true);
            setCarry(null);
            // The click that follows the release, if any, comes before this.
            setTimeout(() => { dragged.current = false; }, 0);
            if (!held || !drop || !overCanvas(ev.clientX, ev.clientY)) return;
            const c = canvasBox.current.getBoundingClientRect();
            const at = screenToWorld(latest.current.view, ev.clientX - c.left, ev.clientY - c.top);
            latest.current.addAt(type, at.x - held.grab.x, at.y - held.grab.y);
        };
        const up = (ev) => { if (ev.pointerId === e.pointerId) end(true, ev); };
        const cancel = (ev) => { if (ev.pointerId === e.pointerId) end(false, ev); };
        const key = (ev) => {
            if (ev.key !== 'Escape') return;
            // Drop the block, not the window.
            ev.stopPropagation();
            end(false, null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
        document.addEventListener('keydown', key, true);
    };
    const pick = (type) => {
        if (dragged.current) return;
        add(type);
    };
    const remove = () => {
        if (selection.wire != null) apply(removeWire(graph, selection.wire));
        else if (selection.nodes.size) apply(removeNodes(graph, [...selection.nodes]));
        setPicked({ nodes: new Set(), wire: null });
    };
    const duplicate = () => {
        if (!selection.nodes.size) return;
        const r = duplicateNodes(graph, [...selection.nodes]);
        apply(r.graph);
        setPicked({ nodes: new Set(r.ids), wire: null });
    };
    // Hang an instrument off an output, and select it so its large view and
    // settings are what the inspector shows next.
    const probe = (fromId, fromPort, type) => {
        const r = addProbe(graph, fromId, fromPort, type);
        if (!r.id) return;
        apply(r.graph);
        setPicked({ nodes: new Set([r.id]), wire: null });
    };
    const across = (id) => {
        const r = addAcross(graph, id);
        if (!r.id) return;
        apply(r.graph);
        setPicked({ nodes: new Set([r.id]), wire: null });
    };
    // A demodulator block into the blocks it is made of, selected, so the
    // inspector shows them as one group to move or take back with undo.
    const expand = (id) => {
        const r = expandNode(graph, id, info.rates[id] || rate);
        if (!r.ids.length) return;
        apply(r.graph);
        setPicked({ nodes: new Set(r.ids), wire: null });
    };
    const undo = () => { pg.setGraph(history.current.undo()); setPicked({ nodes: new Set(), wire: null }); };
    const redo = () => { pg.setGraph(history.current.redo()); setPicked({ nodes: new Set(), wire: null }); };
    const params = (id, patch, why) => {
        pg.setParams(id, patch);
        history.current.push(cloneGraph(pg.graph), why);
    };
    const moved = () => history.current.push(cloneGraph(pg.graph), null);

    // Two kinds of link to the same graph and tuning, and the sender picks:
    //
    //   web   https://<receiver>/v2/?freq=…&playground=pg1…   opens anywhere,
    //         and the page it opens offers the app to whoever has it
    //   app   ubersdr://connect?uuid=…&freq=…&playground=pg1…   opens straight
    //         in the UberSDR app, but most chat and mail apps will not make a
    //         custom scheme tappable
    //
    // The web link's address is shareOriginHere's rather than location.origin:
    // inside the desktop or mobile app this page is served from a loopback
    // proxy, and a link to 127.0.0.1 reaches nobody. The app link exists only
    // for a receiver the directory lists — it names the receiver by UUID.
    const copyLink = async (link) => {
        try {
            await navigator.clipboard.writeText(link);
            return true;
        } catch (err) { return false; /* not allowed here: the link is shown to copy by hand */ }
    };
    const share = async () => {
        try {
            const code = await encodeShare(graph);
            const tuned = shareQuery({ tuning });
            const qs = `${tuned ? `${tuned}&` : ''}${SHARE_PARAM}=${code}`;
            const web = `${shareOriginHere(serverInfo)}${location.pathname}?${qs}`;
            const app = ubersdrAppUri(publicUuid, qs);
            // Nothing to choose between: straight to the web link, as before.
            if (!app) { setNotice({ web, app: null, kind: 'web', copied: await copyLink(web) }); return; }
            setNotice({ web, app, kind: null, copied: false });
        } catch (err) {
            setNotice(`Could not make a link: ${err.message || err}`);
        }
    };
    const pickLink = async (kind) => {
        const n = notice;
        if (!n || !n[kind]) return;
        setNotice({ ...n, kind, copied: await copyLink(n[kind]) });
    };
    // Typed into the JSON pane: an edit like any other, with a pause in typing
    // its own step of undo. What it removed is no longer selected.
    const fromJson = (next) => {
        apply(next, 'json');
        const ids = new Set(next.nodes.map((n) => n.id));
        const wired = JSON.stringify(next.wires) === JSON.stringify(graph.wires);
        setPicked((s) => ({ nodes: new Set([...s.nodes].filter((id) => ids.has(id))), wire: wired ? s.wire : null }));
    };
    const exportFile = () => saveText(JSON.stringify(serializeGraph(graph), null, 2), fileNameFor(graph.name), 'application/json');
    // Export asks what to export only where there is a choice: with nothing
    // saved, it is the graph open now, as it always was.
    const exportChoice = () => (savedGraphs().length ? setAsking('export') : exportFile());
    const exportPicked = ({ current, names }) => {
        setAsking(null);
        const saved = names.map((n) => findSaved(n)).filter(Boolean).map((e) => openSaved(e).graph);
        const all = [...(current ? [graph] : []), ...saved];
        if (all.length === 1) {
            saveText(JSON.stringify(serializeGraph(all[0]), null, 2), fileNameFor(all[0].name), 'application/json');
            return;
        }
        saveText(JSON.stringify(bundleGraphs(all), null, 2), 'ubersdr-playground-graphs.json', 'application/json');
    };

    // ── named graphs, kept in this browser (library.js) ──
    //
    // Save keeps the graph under its name. It writes straight over the saved
    // graph this one was opened from or last saved as, and asks before writing
    // over any other of the same name. A graph with no name is asked for one.
    const [library, bumpLibrary] = useReducer((n) => n + 1, 0);
    const standing = saveState(graph);
    const saveAs = (name) => {
        setAsking(null);
        try {
            const n = saveGraph(name, graph);
            pg.setName(n, n);
            bumpLibrary();
            setNotice(`Saved “${n}” in this browser.`);
        } catch (err) {
            setNotice(err.message || String(err));
        }
    };
    const save = () => {
        const name = cleanGraphName(graph.name);
        if (!name) { setAsking('save-name'); return; }
        const theirs = findSaved(name);
        if (theirs && !(graph.savedAs && sameGraphName(graph.savedAs, name))) { setAsking('save-replace'); return; }
        saveAs(name);
    };
    const openEntry = (entry) => {
        setAsking(null);
        const { graph: g, errors, ubersdr } = openSaved(entry);
        const said = errors.length ? `Opened “${entry.name}”. ${errors.map((e) => e.message).join(' ')}` : `Opened “${entry.name}”.`;
        const older = versionNote(ubersdr);
        const text = older ? `${said} ${older}` : said;
        // Put-back where there is something to lose: anything not saved as it is.
        if (graph.nodes.length && standing !== 'saved') replaceKeepingBack(g, text);
        else replace(g, text);
    };
    const deleteEntry = (entry) => {
        try {
            deleteSaved(entry.name);
            // The graph open now is no longer a copy of anything.
            if (graph.savedAs && sameGraphName(graph.savedAs, entry.name)) pg.setName(graph.name || '', '');
            bumpLibrary();
            setNotice(`Deleted the saved graph “${entry.name}”.`);
        } catch (err) {
            setNotice(err.message || String(err));
        }
    };
    const chooseFile = () => fileInput.current && fileInput.current.click();
    const importFile = async (file) => {
        if (!file) return;
        try {
            const raw = JSON.parse(await file.text());
            // A file of several graphs goes to the saved graphs, not the canvas.
            if (isBundle(raw)) {
                const { added, errors } = importBundle(raw);
                bumpLibrary();
                const list = added.map((n) => `“${n}”`).join(', ');
                setNotice([
                    added.length ? `Added ${added.length} saved ${added.length === 1 ? 'graph' : 'graphs'} from ${file.name}: ${list}. Open shows them.` : `Nothing in ${file.name} could be added.`,
                    ...errors,
                ].join(' '));
                return;
            }
            const { graph: g, errors, ubersdr } = parseGraph(raw);
            // A file from another version says so, after what was loaded.
            const said = errors.length ? errors.map((e) => e.message).join(' ') : `Loaded ${file.name}.`;
            const older = versionNote(ubersdr);
            replaceKeepingBack(g.nodes.some((n) => n.x || n.y) ? g : autoLayout(g), older ? `${said} ${older}` : said);
        } catch (err) {
            setNotice(`${file.name} is not a playground graph.`);
        }
    };

    // Keys, while the window is open. Not inside a text box: there Delete and
    // Ctrl+Z belong to the text.
    useEffect(() => {
        const onKey = (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
            const mod = e.ctrlKey || e.metaKey;
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
            else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
            else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
            else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
            else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); }
            else if (!mod && e.key.toLowerCase() === 'f') fit();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    });

    return (
        <div className={`pg${carry ? ' is-carrying' : ''}`} ref={pgRoot}>
            <div className="pg__head">
                {/* Which receiver this is, ahead of what it is: with the app
                    open on two receivers, or a browser tab on each, the
                    playgrounds look alike. */}
                {callsign && <div className="pg__call" title="This receiver">{callsign}</div>}
                <div className="pg__title">Playground</div>
                <GraphName name={graph.name || ''} state={standing} onRename={(n) => pg.setName(n)} />
                <Toolbar
                    pg={pg}
                    live={live || offline}
                    offline={offline}
                    iq={iq}
                    onStart={() => start()}
                    onStop={stop}
                    history={history.current}
                    onUndo={undo}
                    onRedo={redo}
                    onFit={() => fit()}
                    onFromDemod={() => {
                        if (iqDemodChannels().vfos.length > 1) setAsking('pick');
                        else if (graph.nodes.length) setAsking('demod');
                        else replace(graphFromIQDemod(rate), 'Loaded IQ Demod’s selected demodulator.');
                    }}
                    onNew={() => (graph.nodes.length ? setAsking('new') : replace(emptyGraph(), null))}
                    onTemplate={(t) => {
                        if (!graph.nodes.length) {
                            replace({ ...t.build(rate), name: t.title }, `Loaded “${t.title}”. ${t.summary}`);
                            return;
                        }
                        setTemplate(t);
                        setAsking('template');
                    }}
                    onAnnotate={add}
                    onImport={() => (graph.nodes.length ? setAsking('import') : chooseFile())}
                    onExport={exportChoice}
                    onShare={share}
                    onSave={save}
                    onOpen={() => setAsking('open')}
                    json={sides.json}
                    onJson={() => fold('json')}
                />
                <input
                    ref={fileInput}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={(e) => { importFile(e.target.files && e.target.files[0]); e.target.value = ''; }}
                />
            </div>
            {asking === 'pick' && (
                <PickChannel
                    channels={iqDemodChannels().vfos}
                    active={iqDemodChannels().active}
                    count={graph.nodes.length}
                    onExport={exportFile}
                    onCancel={() => setAsking(null)}
                    onPick={(which) => {
                        setAsking(null);
                        const next = which === 'all' ? graphFromAllChannels(rate) : graphFromIQDemod(rate, which);
                        const what = which === 'all' ? `Loaded all ${iqDemodChannels().vfos.length} of IQ Demod’s demodulators.` : `Loaded IQ Demod’s demodulator ${channelSummary(iqDemodChannels().vfos[which], which)}.`;
                        if (graph.nodes.length) replaceKeepingBack(next, what);
                        else replace(next, what);
                    }}
                />
            )}
            {asking && REPLACING[asking] && (
                <ConfirmReplace
                    kind={asking}
                    subject={template && template.title}
                    count={graph.nodes.length}
                    onExport={exportFile}
                    onCancel={() => setAsking(null)}
                    onConfirm={() => {
                        setAsking(null);
                        if (asking === 'import') chooseFile();
                        else if (asking === 'demod') replaceKeepingBack(graphFromIQDemod(rate), 'Loaded IQ Demod’s selected demodulator.');
                        else if (asking === 'template' && template) replaceKeepingBack({ ...template.build(rate), name: template.title }, `Loaded “${template.title}”. ${template.summary}`);
                        else replaceKeepingBack(emptyGraph(), 'Started a new graph.');
                    }}
                />
            )}
            {asking === 'save-name' && (
                <SaveNameDialog
                    title={graph.name ? 'Save as' : 'Name this graph'}
                    initial={graph.name || ''}
                    onCancel={() => setAsking(null)}
                    onSave={saveAs}
                />
            )}
            {asking === 'save-replace' && (
                <SaveReplaceDialog
                    name={cleanGraphName(graph.name)}
                    onCancel={() => setAsking(null)}
                    onRename={() => setAsking('save-name')}
                    onReplace={() => saveAs(graph.name)}
                />
            )}
            {asking === 'open' && (
                <OpenDialog
                    key={library}
                    graphs={savedGraphs()}
                    current={graph.savedAs || ''}
                    onOpen={openEntry}
                    onDelete={deleteEntry}
                    onSaveAs={() => setAsking('save-name')}
                    onCancel={() => setAsking(null)}
                />
            )}
            {asking === 'export' && (
                <ExportDialog
                    current={graph}
                    graphs={savedGraphs()}
                    onCancel={() => setAsking(null)}
                    onExport={exportPicked}
                />
            )}
            {ui.pending && (
                <SharedOffer
                    pending={ui.pending}
                    onLoad={() => loadShared(ui.pending.graph)}
                    appUri={!insideApp() && publicUuid ? ubersdrAppUri(publicUuid, arrivalQuery()) : null}
                />
            )}
            {notice && (
                <div className="pg-notice">
                    {typeof notice === 'string' ? notice : notice.back ? (
                        <>
                            <span>{notice.text}</span>
                            <Button size="sm" variant="primary" icon={<Icon.RotateLeft />} onClick={() => putBack(notice.back)}>Put mine back</Button>
                        </>
                    ) : (
                        <>
                            <span>
                                {!notice.kind ? 'Share as:'
                                    : notice.copied ? `${notice.kind === 'app' ? 'App link' : 'Link'} copied.`
                                        : 'Copy this link:'}
                            </span>
                            {notice.app && (
                                <>
                                    <Button
                                        size="sm"
                                        variant={notice.kind === 'web' ? 'primary' : 'default'}
                                        onClick={() => pickLink('web')}
                                        title="An https link to this receiver. Opens in any browser, and offers the UberSDR app to anyone who has it."
                                    >
                                        Web link
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant={notice.kind === 'app' ? 'primary' : 'default'}
                                        onClick={() => pickLink('app')}
                                        title="An ubersdr:// link. Opens straight in the UberSDR app on desktop, Android or iOS — but chat and mail apps may not make it tappable."
                                    >
                                        App link
                                    </Button>
                                </>
                            )}
                            {notice.kind && (
                                <input className="input pg-notice__link" readOnly value={notice[notice.kind]} onFocus={(e) => e.target.select()} />
                            )}
                        </>
                    )}
                    <button type="button" className="pg-notice__close" title="Dismiss" onClick={() => setNotice(null)}>
                        <Icon.Close size={14} />
                    </button>
                </div>
            )}
            <div className={`pg__body${sides.left ? ' is-left-shut' : ''}${sides.right ? ' is-right-shut' : ''}${sides.json ? ' is-json' : ''}`}>
                <SidePanel side="left" label="Blocks" shut={sides.left} onToggle={() => fold('left')}>
                    <Palette onAdd={pick} onPickUp={pickUp} />
                </SidePanel>
                <div className="pg__canvas" ref={canvasBox}>
                    <Canvas
                        pg={pg}
                        graph={graph}
                        view={view}
                        setView={setView}
                        selection={selection}
                        setPicked={setPicked}
                        onEdit={apply}
                        onMoved={moved}
                        onOpenNode={openNode}
                        errorsByNode={info.errorsByNode}
                        rates={info.rates}
                        latencies={info.latencies}
                        stats={stats}
                        look={look}
                        origins={origins}
                        onParams={params}
                    />
                    <div className="pg-zoom" role="group" aria-label="Zoom">
                        <button
                            type="button"
                            className="pg-zoom__btn"
                            title={selection.nodes.size ? 'Zoom in on the selected block' : 'Zoom in'}
                            aria-label="Zoom in"
                            disabled={view.zoom >= ZOOM_MAX}
                            onClick={() => zoomBy(ZOOM_STEP)}
                        >+</button>
                        <button
                            type="button"
                            className="pg-zoom__btn"
                            title="Zoom out"
                            aria-label="Zoom out"
                            disabled={view.zoom <= ZOOM_MIN}
                            onClick={() => zoomBy(1 / ZOOM_STEP)}
                        >−</button>
                    </div>
                </div>
                {sides.json && (
                    <aside className="pg__side pg__side--json" aria-label="JSON">
                        <JsonPane graph={graph} onApply={fromJson} />
                    </aside>
                )}
                <SidePanel side="right" label={selection.nodes.size || selection.wire != null ? 'Selected' : 'This graph'} shut={sides.right} onToggle={() => fold('right')}>
                    <Inspector
                        pg={pg}
                        graph={graph}
                        selection={selection}
                        errorsByNode={info.errorsByNode}
                        rates={info.rates}
                        latencies={info.latencies}
                        stats={stats}
                        onParams={params}
                        onRemove={remove}
                        onDuplicate={duplicate}
                        look={look}
                        origins={origins}
                        onProbe={probe}
                        onAcross={across}
                        onExpand={expand}
                        onRename={(id, name) => apply(renameNode(graph, id, name), `name:${id}`)}
                        onExpose={(id, param, on) => apply(exposeControl(graph, id, param, on))}
                        summary={<Summary pg={pg} graph={graph} info={info} stats={stats} />}
                    />
                </SidePanel>
            </div>
            {carry && (
                <div
                    className={`pg-carry${carry.over ? '' : ' is-away'}`}
                    style={{ transform: `translate(${carry.left}px, ${carry.top}px) scale(${carry.zoom})` }}
                    aria-hidden="true"
                >
                    <BlockPreview pg={pg} node={carry.node} look={look} />
                </div>
            )}
        </div>
    );
}

// ── the side panels, open or folded away ────────────────────────────────────

// Which side panels are folded, and whether the JSON is showing, kept for this
// browser: a convenience, so a lost or blocked store just means both open and
// no JSON.
const SIDES_KEY = 'ubersdr.v2.playground.sides';

export function readSides() {
    try {
        const v = JSON.parse(localStorage.getItem(SIDES_KEY) || '{}');
        return { left: !!(v && v.left), right: !!(v && v.right), json: !!(v && v.json) };
    } catch (e) {
        return { left: false, right: false, json: false };
    }
}

function writeSides(v) {
    try { localStorage.setItem(SIDES_KEY, JSON.stringify(v)); } catch (e) { /* private mode */ }
}

/**
 * One side panel: a header that folds it away, as the main window's docks
 * do, and — folded — a narrow rail with its name that opens it again.
 */
export function SidePanel({ side, label, shut, onToggle, children }) {
    const chevron = (side === 'left') === shut ? <Icon.ChevronRight size={14} /> : <Icon.ChevronLeft size={14} />;
    if (shut) {
        return (
            <aside className={`pg__side pg__side--${side} is-shut`}>
                <button type="button" className="pg__rail" title={`Show ${label.toLowerCase()}`} aria-expanded={false} onClick={onToggle}>
                    <span className="dock__collapse">{chevron}</span>
                    <span className="pg__rail-label">{label}</span>
                </button>
            </aside>
        );
    }
    return (
        <aside className={`pg__side pg__side--${side}`}>
            <button type="button" className="pg__side-head" title={`Hide ${label.toLowerCase()}`} aria-expanded onClick={onToggle}>
                <span className="dock__name">{label}</span>
                <span className="dock__collapse">{chevron}</span>
            </button>
            <div className="pg__side-body">{children}</div>
        </aside>
    );
}

/** The window, while it is open. Mounted once, page-wide (PlaygroundWatch). */
export default function PlaygroundModal() {
    const ui = usePlaygroundUi();
    if (!ui.open) return null;
    return (
        // As much of the window as there is: a workspace, not a dialog.
        <Modal onClose={closePlayground} label="Playground" className="modal--full">
            <PlaygroundWindow onClose={closePlayground} />
        </Modal>
    );
}

