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
import { Button, Icon, Modal } from '../../components/ui.jsx';
import { buildShareUrl } from '../../lib/share.js';
import { saveText } from '../../lib/saveFile.js';
import { demodSettings, planForVfo } from '../../lib/iqDemod.js';
import { emptyGraph, parseGraph, serializeGraph } from '../graph.js';
import { Runtime } from '../runtime.js';
import { graphForPlan } from '../fromPlan.js';
import { encodeShare } from '../share.js';
import { getPlayground, graphIqWidth, needsReceiver } from '../engine.js';
import {
    EditHistory, addNode, cloneGraph, duplicateNodes, exposeControl, removeNodes, removeWire,
} from '../editing.js';
import { autoLayout, fitView, screenToWorld } from '../geometry.js';
import { addAcross, addProbe, frequencyOrigins } from '../probes.js';
import { expandNode } from '../expand.js';
import { TEMPLATES } from '../templates.js';
import { INSTRUMENTS } from './viewers.jsx';
import { useDisplay } from '../../display/DisplayContext.jsx';
import Canvas, { formatCpu, formatLatency } from './Canvas.jsx';
import Inspector from './Inspector.jsx';
import Palette from './Palette.jsx';
import { closePlayground, offerSharedGraph, usePlaygroundUi } from './store.js';

// The nodes whose readings the cards draw. Others have nothing live to show,
// and asking for an Audio out's reading would copy its samples back for nothing.
export const WATCHED_TYPES = new Set([
    'meter', 'level-detector', 'squelch', 'carrier-tracker', 'control-scale', 'integrator', 'control-plot', 'iq-player', 'demodulator',
    'costas-loop', 'morse-decoder', 'uart', 'sitor-decoder', 'fsk-detector', 'ook-detector',
    'rtty-decoder', 'psk31-decoder', 'cw-decoder', 'navtex-decoder',
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

/** IQ Demod's selected demodulator as a graph, its output settings carried over. */
export function graphFromIQDemod(rate) {
    const s = demodSettings();
    const vfo = s.vfos[s.active] || s.vfos[0];
    const g = parseGraph(graphForPlan(planForVfo(vfo), rate, {
        agc: vfo.agc, gain: vfo.gain, squelchDb: vfo.squelchDb, lockMute: vfo.lockMute,
    })).graph;
    const out = g.nodes.find((n) => n.id === 'audio');
    if (out) {
        out.params = {
            ...out.params,
            device: vfo.sinkId || '',
            channel: vfo.pan === 'left' ? 'left' : vfo.pan === 'right' ? 'right' : 'both',
            muted: !!vfo.muted,
        };
    }
    return autoLayout(g);
}

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
    return { ok: rt.ok, errors: rt.errors, errorsByNode, rates: rt.plan.inRate, latencies };
}

/** Everything about a graph except where its cards sit. */
const structureKey = (g) => JSON.stringify([g.nodes.map((n) => [n.id, n.type, n.params]), g.wires]);

/**
 * The templates, as a list under a button. Its own rather than the app's Menu:
 * that one is layered for the dock and opens behind this window.
 */
export function TemplatesMenu({ onPick }) {
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
    return (
        <span className="pg-tpl" ref={box}>
            <Button size="sm" variant="ghost" icon={<Icon.Layers />} aria-expanded={open} onClick={() => setOpen(!open)}>Templates</Button>
            {open && (
                <div className="pg-tpl__list" role="menu">
                    {TEMPLATES.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            role="menuitem"
                            className="pg-tpl__item"
                            onClick={() => { setOpen(false); onPick(t); }}
                        >
                            <span className="pg-tpl__title">{t.title}</span>
                            <span className="pg-tpl__summary">{t.summary}</span>
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}

function Toolbar({
    pg, live, offline, iq, onStart, onStop, history, onUndo, onRedo, onFit, onFromDemod, onNew, onImport, onExport, onShare,
    onTemplate,
}) {
    const on = pg.running;
    return (
        <div className="pg-bar">
            <Button
                size="sm"
                variant={on ? 'default' : 'primary'}
                icon={on ? <Icon.Stop /> : <Icon.Play />}
                disabled={!live}
                onClick={on ? onStop : onStart}
            >
                {on ? 'Stop' : 'Start'}
            </Button>
            <span className="pg-bar__status">
                {!live ? 'Start the receiver to run a graph that listens to it — or use an IQ player, which needs none.'
                    : !on ? (offline ? 'Ready — this graph runs by itself, without the receiver.'
                        : iq ? 'Ready — the receiver is in IQ.' : 'Starting will switch the receiver to IQ.')
                        : pg.fault ? `Stopped by an error: ${pg.fault}`
                            : pg.offline ? `Running by itself ${pg.hostKind === 'worker' ? 'in a worker' : 'on the page'}${pg.overloaded ? ' — overloaded, dropping packets' : ''}`
                            : !pg.quadrature ? 'Waiting for the quadrature stream…'
                                : `Running ${pg.hostKind === 'worker' ? 'in a worker' : 'on the page'}${pg.overloaded ? ' — overloaded, dropping packets' : ''}`}
            </span>
            <span className="pg-bar__group">
                <Button size="sm" variant="ghost" icon={<Icon.RotateLeft />} disabled={!history.canUndo} title="Undo (Ctrl+Z)" onClick={onUndo} />
                <Button size="sm" variant="ghost" icon={<Icon.RotateRight />} disabled={!history.canRedo} title="Redo (Ctrl+Shift+Z)" onClick={onRedo} />
                <Button size="sm" variant="ghost" icon={<Icon.Expand />} title="Fit the graph to the window (F)" onClick={onFit} />
            </span>
            <span className="pg-bar__group">
                <TemplatesMenu onPick={onTemplate} />
                <Button size="sm" variant="ghost" icon={<Icon.Waves />} title="Replace the graph with IQ Demod’s selected demodulator" onClick={onFromDemod}>From IQ Demod</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Plus />} title="Start again from an empty canvas" onClick={onNew}>New</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Upload />} title="Load a graph from a .json file" onClick={onImport}>Import</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Download />} title="Save the graph as a .json file" onClick={onExport}>Export</Button>
                <Button size="sm" variant="ghost" icon={<Icon.Share />} title="Copy a link to this graph" onClick={onShare}>Share</Button>
            </span>
        </div>
    );
}

function Summary({ pg, graph, info, stats }) {
    const outs = graph.nodes.filter((n) => n.type === 'audio-out');
    const worst = outs.reduce((m, n) => Math.max(m, (info.latencies[n.id] || {}).total || 0), 0);
    return (
        <>
            <div className="pg-insp__title">This graph</div>
            <div className="readout-grid">
                <div className="readout"><div className="readout__label">Blocks</div><div className="readout__value">{graph.nodes.length}</div></div>
                <div className="readout"><div className="readout__label">To the speakers</div><div className="readout__value">{outs.length ? formatLatency(worst) : '—'}</div></div>
                <div className="readout"><div className="readout__label">CPU</div><div className="readout__value">{stats ? formatCpu(stats.cpu) : '—'}</div></div>
                <div className="readout"><div className="readout__label">Last packet</div><div className="readout__value">{pg.running ? `${pg.costMs.toFixed(2)} ms` : '—'}</div></div>
            </div>
            {info.errors.length > 0 && (
                <div className="pg-insp__section">
                    <div className="pg-insp__title">Not ready to run</div>
                    {info.errors.map((e, i) => <div key={i} className="note note--tight note--warn">{e.node ? `${e.node}: ` : ''}{e.message}</div>)}
                </div>
            )}
            <div className="pg-insp__section pg-insp__help">
                <div className="pg-insp__title">How to</div>
                <p>Press a block on the left to add it. Drag from an output dot to an input dot of the same colour to wire them; drag from a wired input to move or remove its wire.</p>
                <p>To see a signal anywhere, select a block or a wire and attach an instrument — spectrum, scope, constellation, frequency counter — to any input or output. Instruments only listen: the path carries on as it was.</p>
                <p>Select a filter and press Measure gain &amp; phase to see what it does to the signal going through it.</p>
                <p>Drag the background to pan, scroll to zoom. Shift-press to select several. Delete removes, Ctrl+D duplicates, Ctrl+Z undoes.</p>
                <p>“To the speakers” is the delay the blocks add. The receiver’s own buffering comes on top.</p>
            </div>
        </>
    );
}

// Over the middle of the window rather than in a strip along the top: a link
// that was followed is the reason the window opened, and until it is answered
// the graph underneath is still the operator's own.
function SharedOffer({ pending, onLoad }) {
    const ok = pending.graph && pending.graph.nodes.length > 0;
    const count = ok ? pending.graph.nodes.length : 0;
    return (
        <div className="pg-dialog pg-offer" role="dialog" aria-label="Shared graph">
            <div className="pg-dialog__card">
                <div className="pg-dialog__title">{ok ? 'Shared graph' : 'Shared graph unreadable'}</div>
                <p>
                    {ok ? `A link brought a graph of ${count} ${count === 1 ? 'block' : 'blocks'}. Loading it replaces the one open now; you can put yours back afterwards.` : 'A playground link could not be read.'}
                    {pending.errors && pending.errors.length ? ` ${pending.errors.map((e) => e.message).join(' ')}` : ''}
                </p>
                <div className="pg-dialog__actions">
                    <Button size="sm" variant="ghost" onClick={() => offerSharedGraph(null)}>{ok ? 'Keep mine' : 'Dismiss'}</Button>
                    {ok && <Button size="sm" variant="primary" onClick={onLoad}>Load it</Button>}
                </div>
            </div>
        </div>
    );
}

// Before New or Import throws away a graph: a canvas cleared by a stray press
// is hours of wiring gone, and the way to keep a copy is right here.
const REPLACING = {
    new: { title: 'Start a new graph?', what: 'will be cleared from the canvas', go: 'Clear it' },
    import: { title: 'Import a graph?', what: 'will be replaced by the file you choose', go: 'Choose file…' },
};

function ConfirmReplace({ kind, count, onExport, onCancel, onConfirm }) {
    const t = REPLACING[kind];
    return (
        <div className="pg-dialog pg-confirm" role="dialog" aria-label={t.title}>
            <div className="pg-dialog__card">
                <div className="pg-dialog__title">{t.title}</div>
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
    const { running, audioState, tuning, actions, player, allowedIQModes } = useRadio();
    const pg = getPlayground(player);
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
    const info = useMemo(() => inspect(graph, rate), [key, rate]);
    const origins = useMemo(() => frequencyOrigins(graph, tuning.frequency), [key, tuning.frequency]);
    const display = useDisplay();
    // What the instruments draw with: the operator's waterfall palette, and
    // the dial, so a spectrum of the stream is labelled in real frequencies.
    const look = { palette: (display && display.palette) || 'classic', dialHz: tuning.frequency };
    const stats = pg.running ? pg.stats : null;

    // Readings for the cards that draw them, for as long as the window is open.
    const watchKey = graph.nodes.filter((n) => WATCHED_TYPES.has(n.type)).map((n) => n.id).join(',');
    useEffect(() => {
        pg.watch(watchKey ? watchKey.split(',') : []);
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
    // Fit once on opening, so the graph is on screen however it was left.
    useEffect(() => { fit(); }, []);

    /** Every edit goes through here: into the engine, and onto the history. */
    const apply = (next, why = null) => {
        if (next === graph) return;
        history.current.push(cloneGraph(next), why);
        pg.setGraph(next);
    };
    const replace = (next, message) => {
        history.current.replace(cloneGraph(next));
        pg.setGraph(next);
        setPicked({ nodes: new Set(), wire: null });
        fit(next);
        if (message) setNotice(message);
    };
    // A replacement the operator did not build, with a button on the notice
    // that brings back what they had. As an edit of its own rather than an
    // undo, so it still restores their graph after they have changed the new
    // one.
    const replaceKeepingBack = (next, text) => replace(next, { text, back: cloneGraph(graph) });
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

    const add = (type) => {
        const { w, h } = size();
        const centre = screenToWorld(view, w / 2, h / 2);
        const n = graph.nodes.length % 6;
        const r = addNode(graph, type, centre.x - 98 + n * 18, centre.y - 40 + n * 18);
        apply(r.graph, null);
        setPicked({ nodes: new Set([r.id]), wire: null });
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

    const share = async () => {
        try {
            const code = await encodeShare(graph);
            const base = buildShareUrl({ origin: location.origin, pathname: location.pathname, tuning });
            const link = `${base}${base.includes('?') ? '&' : '?'}${SHARE_PARAM}=${code}`;
            let copied = false;
            try {
                await navigator.clipboard.writeText(link);
                copied = true;
            } catch (err) { /* not allowed here: the link is shown to copy by hand */ }
            setNotice({ link, copied });
        } catch (err) {
            setNotice(`Could not make a link: ${err.message || err}`);
        }
    };
    const exportFile = () => saveText(JSON.stringify(serializeGraph(graph), null, 2), 'ubersdr-playground.json', 'application/json');
    const chooseFile = () => fileInput.current && fileInput.current.click();
    const importFile = async (file) => {
        if (!file) return;
        try {
            const { graph: g, errors } = parseGraph(JSON.parse(await file.text()));
            replaceKeepingBack(g.nodes.some((n) => n.x || n.y) ? g : autoLayout(g), errors.length ? errors.map((e) => e.message).join(' ') : `Loaded ${file.name}.`);
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
            else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); }
            else if (!mod && e.key.toLowerCase() === 'f') fit();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    });

    return (
        <div className="pg">
            <div className="pg__head">
                <div className="pg__title">Playground</div>
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
                    onFromDemod={() => replace(graphFromIQDemod(rate), 'Loaded IQ Demod’s selected demodulator.')}
                    onNew={() => (graph.nodes.length ? setAsking('new') : replace(emptyGraph(), null))}
                    onTemplate={(t) => replaceKeepingBack(t.build(), `Loaded “${t.title}”. ${t.summary}`)}
                    onImport={() => (graph.nodes.length ? setAsking('import') : chooseFile())}
                    onExport={exportFile}
                    onShare={share}
                />
                <input
                    ref={fileInput}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={(e) => { importFile(e.target.files && e.target.files[0]); e.target.value = ''; }}
                />
            </div>
            {asking && (
                <ConfirmReplace
                    kind={asking}
                    count={graph.nodes.length}
                    onExport={exportFile}
                    onCancel={() => setAsking(null)}
                    onConfirm={() => {
                        setAsking(null);
                        if (asking === 'import') chooseFile();
                        else replaceKeepingBack(emptyGraph(), 'Started a new graph.');
                    }}
                />
            )}
            {ui.pending && (
                <SharedOffer
                    pending={ui.pending}
                    onLoad={() => loadShared(ui.pending.graph)}
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
                            {notice.copied ? 'Link copied.' : 'Copy this link:'}
                            <input className="input pg-notice__link" readOnly value={notice.link} onFocus={(e) => e.target.select()} />
                        </>
                    )}
                    <button type="button" className="pg-notice__close" title="Dismiss" onClick={() => setNotice(null)}>
                        <Icon.Close size={14} />
                    </button>
                </div>
            )}
            <div className={`pg__body${sides.left ? ' is-left-shut' : ''}${sides.right ? ' is-right-shut' : ''}`}>
                <SidePanel side="left" label="Blocks" shut={sides.left} onToggle={() => fold('left')}>
                    <Palette onAdd={add} />
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
                </div>
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
                        onExpose={(id, param, on) => apply(exposeControl(graph, id, param, on))}
                        summary={<Summary pg={pg} graph={graph} info={info} stats={stats} />}
                    />
                </SidePanel>
            </div>
        </div>
    );
}

// ── the side panels, open or folded away ────────────────────────────────────

// Which side panels are folded, kept for this browser: a convenience, so a
// lost or blocked store just means both open.
const SIDES_KEY = 'ubersdr.v2.playground.sides';

export function readSides() {
    try {
        const v = JSON.parse(localStorage.getItem(SIDES_KEY) || '{}');
        return { left: !!(v && v.left), right: !!(v && v.right) };
    } catch (e) {
        return { left: false, right: false };
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
        <Modal onClose={closePlayground} label="Playground">
            <PlaygroundWindow onClose={closePlayground} />
        </Modal>
    );
}

