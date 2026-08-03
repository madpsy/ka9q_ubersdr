// Marker bar above the spectrum: band allocations as tinted spans, bookmarks as
// labelled pills on two stacked rows.
//
// Redrawn only when the view, the data or the toggles change — not per spectrum
// frame — because laying out thousands of markers is far more expensive than
// painting a spectrum trace. The heavy lifting (visible-window slice, row
// stacking, density cap) is in lib/markers.js.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { bandColors, bandLabelPositions, layoutBands, layoutBookmarks } from '../lib/markers.js';
import { formatFreqShort } from '../lib/format.js';

const BAND_H = 13;        // band strip along the top, CSS px
const ROW_H = 15;         // one bookmark row
const ROWS = 2;
const PILL_H = 13;
export const MARKER_BAR_H = BAND_H + ROWS * ROW_H + 4;

// The API packs a second line after a "|"; only the first part fits a marker.
function bandName(b) {
    return String(b.button_name || b.label || '').split('|')[0].replace(/\s+/g, ' ').trim();
}

// v1's two bookmark colours, kept identical so the distinction reads the same
// in both frontends: gold for what the receiver publishes, blue for what you
// saved in this browser (bookmark-manager.js drawBookmarks).
const SERVER_PILL = 'rgba(255, 215, 0, 0.95)';
const SERVER_INK = '#000000';
const LOCAL_PILL = 'rgba(52, 152, 219, 0.95)';
const LOCAL_INK = '#ffffff';

export default function MarkerBar({ width }) {
    const { view, actions, catalog, tuning } = useRadio();
    const display = useDisplay();
    const canvasRef = useRef(null);
    const hitsRef = useRef({ bookmarks: [], bands: [] });
    const [tip, setTip] = useState(null);

    const showBands = display.markerBands !== false;
    // Server and local bookmarks toggle independently — the handful you saved
    // are worth keeping on screen even when 2450 published ones are not.
    const showServer = display.markerBookmarks !== false;
    const showLocal = display.markerLocalBookmarks !== false;

    const colors = useMemo(
        () => bandColors(display.server.config.band_color_intensity),
        [display.server.config.band_color_intensity],
    );

    // Server and local bookmarks in one frequency-sorted list. Merged rather
    // than concatenated-and-sorted: both inputs are already ordered, and the
    // server side is a couple of thousand entries that would otherwise be
    // re-sorted every time a local bookmark is added or deleted.
    const marks = useMemo(() => {
        const server = showServer ? (catalog.bookmarks || []) : [];
        const local = showLocal ? (catalog.local || []) : [];
        if (!local.length) return server;
        if (!server.length) return local;
        const out = new Array(server.length + local.length);
        let i = 0;
        let j = 0;
        let k = 0;
        while (i < server.length && j < local.length) {
            out[k++] = server[i].frequency <= local[j].frequency ? server[i++] : local[j++];
        }
        while (i < server.length) out[k++] = server[i++];
        while (j < local.length) out[k++] = local[j++];
        return out;
    }, [catalog.bookmarks, catalog.local, showServer, showLocal]);

    const centerFreq = view.centerFreq;
    const span = view.span;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !width) return;

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(MARKER_BAR_H * dpr);
        canvas.style.width = width + 'px';
        canvas.style.height = MARKER_BAR_H + 'px';

        const c = canvas.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, width, MARKER_BAR_H);

        hitsRef.current = { bookmarks: [], bands: [] };
        if (!span) return;

        const startFreq = centerFreq - span / 2;
        const endFreq = centerFreq + span / 2;
        const css = getComputedStyle(document.documentElement);
        const accent = css.getPropertyValue('--accent').trim() || '#3ddbe8';
        const accentInk = css.getPropertyValue('--accent-ink').trim() || '#04141a';
        const dim = css.getPropertyValue('--text-faint').trim() || '#5c6779';

        // ---- band allocations -------------------------------------------
        if (showBands && catalog.bands) {
            const spans = layoutBands({ bands: catalog.bands, startFreq, endFreq, width });
            c.font = '600 9px ui-monospace, SFMono-Regular, monospace';
            c.textBaseline = 'middle';
            c.textAlign = 'center';

            for (const s of spans) {
                c.fillStyle = colors[s.index % colors.length];
                c.fillRect(s.x0, 0, s.width, BAND_H);
                // A brighter top edge reads as a band boundary even where two
                // allocations of similar colour meet.
                c.fillStyle = 'rgba(255,255,255,0.18)';
                c.fillRect(s.x0, 0, Math.max(1, s.width), 1);
                if (s.width > 2) {
                    c.fillStyle = 'rgba(255,255,255,0.10)';
                    c.fillRect(s.x0, 0, 1, BAND_H);
                }
                hitsRef.current.bands.push(s);
            }

            for (const s of spans) {
                const name = bandName(s.band);
                if (!name) continue;
                const labelWidth = c.measureText(name).width + 6;
                for (const x of bandLabelPositions({ x0: s.x0, x1: s.x1, labelWidth })) {
                    c.fillStyle = 'rgba(0,0,0,0.45)';
                    c.fillRect(x - labelWidth / 2, 1.5, labelWidth, BAND_H - 3);
                    c.fillStyle = 'rgba(255,255,255,0.92)';
                    c.fillText(name, x, BAND_H / 2 + 0.5);
                }
            }
        }

        // ---- bookmarks ---------------------------------------------------
        if (marks.length) {
            c.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';

            // Label widths are measured once per name and cached: measureText on
            // every marker every redraw is the single most expensive step here.
            const cache = new Map();
            const measure = (b) => {
                let w = cache.get(b.name);
                if (w === undefined) {
                    w = Math.min(140, c.measureText(b.name).width + 10);
                    cache.set(b.name, w);
                }
                return w;
            };

            const placed = layoutBookmarks({
                sorted: marks, startFreq, endFreq, width, measure,
            });

            for (const p of placed) {
                const y = BAND_H + 2 + (ROWS - 1 - p.row) * ROW_H;
                const x = p.x;
                const w = p.width;
                const isTuned = Math.abs(p.item.frequency - tuning.frequency) < 1;

                // Stem down to a common baseline, so a pill on the upper row
                // still visibly points at its frequency.
                c.strokeStyle = isTuned ? accent : 'rgba(255,255,255,0.30)';
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(Math.round(x) + 0.5, y + PILL_H);
                c.lineTo(Math.round(x) + 0.5, MARKER_BAR_H);
                c.stroke();

                const isLocal = p.item.source === 'local';
                c.fillStyle = isTuned ? accent : (isLocal ? LOCAL_PILL : SERVER_PILL);
                roundRect(c, x - w / 2, y, w, PILL_H, 3);
                c.fill();
                if (!isTuned) {
                    c.strokeStyle = 'rgba(255,255,255,0.55)';
                    c.stroke();
                }

                c.fillStyle = isTuned ? accentInk : (isLocal ? LOCAL_INK : SERVER_INK);
                clipText(c, p.item.name, x, y + PILL_H / 2, w - 6);

                hitsRef.current.bookmarks.push({ x, y, w, h: PILL_H, item: p.item });
            }
        }

        // Baseline the stems land on.
        c.fillStyle = dim;
        c.globalAlpha = 0.35;
        c.fillRect(0, MARKER_BAR_H - 1, width, 1);
        c.globalAlpha = 1;
    }, [width, centerFreq, span, catalog.bands, marks, showBands, colors, tuning.frequency]);

    const locate = useCallback((e) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const hit = hitsRef.current.bookmarks.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (hit) return { kind: 'bookmark', ...hit };
        if (y <= BAND_H) {
            // Narrow allocations are drawn last (on top), so search backwards.
            for (let i = hitsRef.current.bands.length - 1; i >= 0; i--) {
                const s = hitsRef.current.bands[i];
                if (x >= s.x0 && x <= s.x1) return { kind: 'band', ...s };
            }
        }
        return null;
    }, []);

    const onMove = useCallback((e) => {
        const hit = locate(e);
        if (!hit) { setTip(null); return; }
        const r = canvasRef.current.getBoundingClientRect();
        setTip({
            x: e.clientX - r.left,
            text: hit.kind === 'bookmark'
                ? `${hit.item.name} · ${formatFreqShort(hit.item.frequency)}${hit.item.mode ? ' · ' + hit.item.mode.toUpperCase() : ''}${hit.item.comment ? ' — ' + hit.item.comment : ''}`
                : `${bandName(hit.band)} · ${formatFreqShort(hit.band.start)}–${formatFreqShort(hit.band.end)}`,
        });
    }, [locate]);

    const onClick = useCallback((e) => {
        const hit = locate(e);
        if (!hit) return;
        if (hit.kind === 'bookmark') {
            if (hit.item.mode) actions.setMode(hit.item.mode);
            actions.setFrequency(hit.item.frequency);
            // A pill sits at the edge of the bar as often as the middle, and
            // with follow-tuning off nothing else would move the view — so the
            // signal you just clicked could end up half off screen.
            actions.ensureVisible(hit.item.frequency);
        } else {
            const centre = Math.round((hit.band.start + hit.band.end) / 2);
            if (hit.band.mode) actions.setMode(hit.band.mode);
            actions.setFrequency(centre);
            actions.setSpectrumCenter(centre);
        }
    }, [locate, actions]);

    if (!showBands && !showServer && !showLocal) return null;

    return (
        <div className="markerbar" style={{ height: MARKER_BAR_H }}>
            <canvas
                ref={canvasRef}
                className="markerbar__canvas"
                onPointerMove={onMove}
                onPointerLeave={() => setTip(null)}
                onClick={onClick}
            />
            {tip && (
                <div
                    className="markerbar__tip"
                    style={{ left: Math.max(4, Math.min((width || 0) - 4, tip.x)) }}
                >
                    {tip.text}
                </div>
            )}
        </div>
    );
}

function roundRect(c, x, y, w, h, r) {
    const rad = Math.min(r, h / 2, w / 2);
    c.beginPath();
    c.moveTo(x + rad, y);
    c.arcTo(x + w, y, x + w, y + h, rad);
    c.arcTo(x + w, y + h, x, y + h, rad);
    c.arcTo(x, y + h, x, y, rad);
    c.arcTo(x, y, x + w, y, rad);
    c.closePath();
}

// Trims with an ellipsis rather than spilling out of the pill.
function clipText(c, text, x, y, maxWidth) {
    if (c.measureText(text).width <= maxWidth) {
        c.fillText(text, x, y);
        return;
    }
    let s = text;
    while (s.length > 1 && c.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    c.fillText(s + '…', x, y);
}
