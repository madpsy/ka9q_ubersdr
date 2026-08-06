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
import { assignRows, bandColors, bandLabelPositions, layoutBands, layoutBookmarks } from '../lib/markers.js';
import { countryFlag, formatFreqShort } from '../lib/format.js';
import { activityLabel, dialFreq, subscribeVoiceActivity } from '../lib/voiceActivity.js';
import { getVfos, markableVfos, onVfosChanged, selectVfo } from '../lib/vfos.js';
import { requestLookup } from '../lib/callsign.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { subscribeSpots } from '../lib/spotStore.js';
import { ageLabel, markerSpots, modeForSpot } from '../lib/spots.js';
import { haptic } from '../lib/haptics.js';

const BAND_H = 13;        // band strip along the top, CSS px
// How much of the band's own colour carries on down behind the marker rows.
//
// The strip alone said which band you were looking at only if you looked at the
// strip; the markers underneath sat on the bar's background and belonged to
// nothing. Tinting the whole height puts each pill inside its allocation, so
// the band a bookmark or a spot is in is read from where it sits rather than by
// tracking up to the strip and back.
//
// A fraction rather than the full colour because it is a backdrop for pills and
// their labels, not a band of its own — and the palette is already translucent
// (see bandColors), so this multiplies down from whatever intensity the
// operator has set rather than fighting it.
const BAND_BODY_ALPHA = 0.4;
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

// Voice activity: purple, as v1 paints it (voice-activity-markers.js). The
// point of a third colour is that these are not bookmarks — nobody chose them,
// they are what the detector heard in the last 90 seconds.
const VOICE_PILL = 'rgba(155, 89, 182, 0.95)';
const VOICE_INK = '#ffffff';

// The parked VFOs: a colour nothing else in the bar uses, because they are the
// one marker that is neither something the receiver told us about nor something
// somebody published — they are places *you* put down and can pick up again.
// Crimson against the purple of voice activity, which is the nearest hue here.
const VFO_FILL = 'rgba(233, 30, 99, 0.95)';
const VFO_INK = '#ffffff';

// Spot colours are v1's, so a green pill means the same thing in both
// frontends: green for DX cluster spots (dx-cluster drawDXSpotsOnSpectrum),
// cyan for the CW skimmer's (cw-spots drawCWSpotsOnSpectrum). Both take white
// text, as they do there.
const SPOT_STYLE = {
    dx: { pill: 'rgba(40, 167, 69, 0.95)', stem: 'rgba(40, 167, 69, 0.55)', ink: '#ffffff' },
    cw: { pill: 'rgba(23, 162, 184, 0.95)', stem: 'rgba(23, 162, 184, 0.55)', ink: '#ffffff' },
};

export default function MarkerBar({ width }) {
    const radio = useRadio();
    const { view, actions, catalog, tuning, serverInfo } = radio;
    const display = useDisplay();
    const canvasRef = useRef(null);
    const hitsRef = useRef({ bookmarks: [], bands: [] });
    const [tip, setTip] = useState(null);

    const showBands = display.markerBands !== false;
    // Server and local bookmarks toggle independently — the handful you saved
    // are worth keeping on screen even when 2450 published ones are not.
    const showServer = display.markerBookmarks !== false;
    const showLocal = display.markerLocalBookmarks !== false;
    // Off unless the receiver runs the detector at all — the toggle would
    // otherwise promise markers that can never appear.
    const showVoice = display.markerVoice !== false && !!(serverInfo && serverInfo.noise_floor);
    const showVfos = display.markerVfos !== false;
    // Spot markers, each gated on its own feed existing. The streams themselves
    // are held open for the session by <SpotStreams> in App.jsx — both are
    // low-rate — so a toggle here decides only what is drawn, and turning one on
    // shows the spots already collected rather than an empty bar. Digital spots
    // have no marker layer: a decoder band puts every station on one frequency.
    const showDx = display.markerDxSpots !== false && !!(serverInfo && serverInfo.dx_cluster);
    const showCw = display.markerCwSpots !== false && !!(serverInfo && serverInfo.cw_skimmer);
    const lookups = !!(serverInfo && serverInfo.lookup_service);

    // One shared poll with the voice activity panel; subscribing is what starts
    // it, so with the toggle off nothing is fetched.
    const [voice, setVoice] = useState([]);
    useEffect(() => {
        if (!showVoice) { setVoice([]); return undefined; }
        return subscribeVoiceActivity((state) => setVoice(state.activities || []));
    }, [showVoice]);

    // The VFO slots, from the same store the Receiver panel's buttons use, so a
    // marker appears the moment a VFO is stored and goes when it is switched to.
    const [vfos, setVfoState] = useState(getVfos);
    useEffect(() => onVfosChanged(setVfoState), []);

    // Read from the same store the Spots panel reads — see lib/spotStore.js.
    // Subscribing here only registers for updates; the stream is already up.
    const [dxSpots, setDxSpots] = useState([]);
    const [cwSpots, setCwSpots] = useState([]);
    useEffect(() => {
        if (!showDx) { setDxSpots([]); return undefined; }
        return subscribeSpots('dx', setDxSpots);
    }, [showDx]);
    useEffect(() => {
        if (!showCw) { setCwSpots([]); return undefined; }
        return subscribeSpots('cw', setCwSpots);
    }, [showCw]);

    // Spots age out of the marker window on their own, so the layer is rebuilt
    // on a slow clock as well as when spots arrive. Ten seconds is far finer
    // than the 10–30 minute windows involved.
    const [ageTick, setAgeTick] = useState(0);
    useEffect(() => {
        if (!showDx && !showCw) return undefined;
        const id = setInterval(() => setAgeTick((n) => n + 1), 10000);
        return () => clearInterval(id);
    }, [showDx, showCw]);

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

        hitsRef.current = { bookmarks: [], bands: [], voice: [], spots: [], vfos: [] };
        if (!span) return;

        const startFreq = centerFreq - span / 2;
        const endFreq = centerFreq + span / 2;
        const css = getComputedStyle(document.documentElement);
        const accent = css.getPropertyValue('--accent').trim() || '#08a2fb';
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
                // The body first, behind the marker rows, then the strip at
                // full strength over the top of it.
                c.globalAlpha = BAND_BODY_ALPHA;
                c.fillRect(s.x0, BAND_H, s.width, MARKER_BAR_H - BAND_H);
                c.globalAlpha = 1;
                c.fillRect(s.x0, 0, s.width, BAND_H);
                // A brighter top edge reads as a band boundary even where two
                // allocations of similar colour meet.
                c.fillStyle = 'rgba(255,255,255,0.18)';
                c.fillRect(s.x0, 0, Math.max(1, s.width), 1);
                if (s.width > 2) {
                    // Full height, so the edge between two allocations is
                    // followable down past the markers rather than stopping
                    // where the strip does.
                    c.fillStyle = 'rgba(255,255,255,0.10)';
                    c.fillRect(s.x0, 0, 1, MARKER_BAR_H);
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
        // Kept so the voice layer below can avoid the space they took.
        let placedMarks = [];

        // ---- VFOs: laid out first, drawn last -------------------------------
        // First because they outrank everything else in the bar: a bookmark or
        // a spot can move up a row or be dropped, and a VFO is somewhere you
        // put down yourself and expect to find again. Everything below is
        // seeded with these, so they fit around the VFOs rather than over them.
        //
        // The drawing waits until the end so the circles sit on top of any
        // stem that crosses them — see the block at the foot of this function.
        let placedVfos = [];
        if (showVfos) {
            const items = [];
            for (const v of markableVfos(vfos, tuning.frequency)) {
                if (v.frequency < startFreq || v.frequency > endFreq) continue;
                items.push({
                    vfo: v,
                    x: ((v.frequency - startFreq) / span) * width,
                    // A round mark is as wide as it is tall, and it takes a row
                    // the same way a pill does — same height, same baseline, so
                    // the bar reads as one set of markers rather than two.
                    width: PILL_H,
                });
            }
            items.sort((a, b) => a.x - b.x);
            placedVfos = assignRows(items);
            placedMarks = placedVfos.slice();
        }
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

            // Seeded with the VFOs, which were placed first and outrank these.
            const placedBookmarks = layoutBookmarks({
                sorted: marks, startFreq, endFreq, width, measure, occupied: placedMarks,
            });

            for (const p of placedBookmarks) {
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
            // The layers below avoid these as well as the VFOs.
            placedMarks = placedMarks.concat(placedBookmarks);
        }

        // ---- voice activity ----------------------------------------------
        // After the bookmarks, and seeded with where they landed, so a
        // detection never covers a bookmark. Same order v1 draws in.
        if (showVoice && voice.length) {
            c.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';

            const items = [];
            for (const a of voice) {
                const freq = dialFreq(a);
                if (!freq || freq < startFreq || freq > endFreq) continue;
                const label = activityLabel(a);
                items.push({
                    activity: a,
                    label,
                    x: ((freq - startFreq) / span) * width,
                    width: Math.min(140, c.measureText(label).width + 10),
                });
            }
            items.sort((a, b) => a.x - b.x);

            const placedVoice = assignRows(items, placedMarks);
            for (const p of placedVoice) {
                const y = BAND_H + 2 + (ROWS - 1 - p.row) * ROW_H;
                const { x, width: w } = p;

                c.strokeStyle = 'rgba(155, 89, 182, 0.55)';
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(Math.round(x) + 0.5, y + PILL_H);
                c.lineTo(Math.round(x) + 0.5, MARKER_BAR_H);
                c.stroke();

                c.fillStyle = VOICE_PILL;
                roundRect(c, x - w / 2, y, w, PILL_H, 3);
                c.fill();
                c.strokeStyle = 'rgba(255,255,255,0.55)';
                c.stroke();

                c.fillStyle = VOICE_INK;
                clipText(c, p.label, x, y + PILL_H / 2, w - 6);

                hitsRef.current.voice.push({ x, y, w, h: PILL_H, activity: p.activity, label: p.label });
            }
            // The spot layer below must avoid these too, not just the bookmarks.
            placedMarks = placedMarks.concat(placedVoice);
        }

        // ---- DX and CW spots ---------------------------------------------
        // Last, and seeded with everything already placed, so a spot never
        // covers a bookmark or a detection. Both layers share the same two rows
        // and are laid out together, so a DX and a CW spot on neighbouring
        // frequencies stack rather than overlap.
        if (showDx || showCw) {
            c.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';

            const items = [];
            const collect = (list, kind) => {
                for (const s of markerSpots({ spots: list, kind, startFreq, endFreq, now: Date.now() })) {
                    const label = s.callsign || '?';
                    items.push({
                        spot: s,
                        kind,
                        label,
                        x: ((s.frequency - startFreq) / span) * width,
                        width: Math.min(140, c.measureText(label).width + 10),
                    });
                }
            };
            if (showDx) collect(dxSpots, 'dx');
            if (showCw) collect(cwSpots, 'cw');
            items.sort((a, b) => a.x - b.x);

            for (const p of assignRows(items, placedMarks)) {
                const y = BAND_H + 2 + (ROWS - 1 - p.row) * ROW_H;
                const { x, width: w } = p;
                const style = SPOT_STYLE[p.kind];

                c.strokeStyle = style.stem;
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(Math.round(x) + 0.5, y + PILL_H);
                c.lineTo(Math.round(x) + 0.5, MARKER_BAR_H);
                c.stroke();

                c.fillStyle = style.pill;
                roundRect(c, x - w / 2, y, w, PILL_H, 3);
                c.fill();
                c.strokeStyle = 'rgba(255,255,255,0.55)';
                c.stroke();

                c.fillStyle = style.ink;
                clipText(c, p.label, x, y + PILL_H / 2, w - 6);

                hitsRef.current.spots.push({ x, y, w, h: PILL_H, spot: p.spot });
            }
        }

        // Baseline the stems land on.
        c.fillStyle = dim;
        c.globalAlpha = 0.35;
        c.fillRect(0, MARKER_BAR_H - 1, width, 1);
        c.globalAlpha = 1;
        // ---- VFOs, drawn -----------------------------------------------------
        // Placed at the top of this function so the other layers fit around
        // them; drawn here so the circles sit over any stem that crosses one.
        // Same rows, same baseline and same stem as every other marker — the
        // only difference is the shape and that they had first claim on a row.
        for (const p of placedVfos) {
            const y = BAND_H + 2 + (ROWS - 1 - p.row) * ROW_H;
            const x = p.x;
            const cy = y + PILL_H / 2;
            const r = PILL_H / 2;

            c.strokeStyle = 'rgba(233, 30, 99, 0.55)';
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(Math.round(x) + 0.5, y + PILL_H);
            c.lineTo(Math.round(x) + 0.5, MARKER_BAR_H);
            c.stroke();

            c.beginPath();
            c.arc(x, cy, r, 0, Math.PI * 2);
            c.fillStyle = VFO_FILL;
            c.fill();
            c.strokeStyle = 'rgba(255,255,255,0.65)';
            c.stroke();

            c.font = '700 9px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';
            c.fillStyle = VFO_INK;
            c.fillText(p.vfo.id, x, cy + 0.5);

            hitsRef.current.vfos.push({ x, y, w: PILL_H, h: PILL_H, vfo: p.vfo });
        }

    }, [width, centerFreq, span, catalog.bands, marks, showBands, colors, tuning.frequency,
        showVoice, voice, showDx, showCw, dxSpots, cwSpots, ageTick,
        showVfos, vfos, tuning.frequency]);

    const locate = useCallback((e) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const vfo = hitsRef.current.vfos.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (vfo) return { kind: 'vfo', ...vfo };
        const hit = hitsRef.current.bookmarks.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (hit) return { kind: 'bookmark', ...hit };
        const v = hitsRef.current.voice.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (v) return { kind: 'voice', ...v };
        const s = hitsRef.current.spots.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (s) return { kind: 'spot', ...s };
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
            text: hit.kind === 'vfo'
                ? `VFO ${hit.vfo.id} · ${formatFreqShort(hit.vfo.frequency)}${hit.vfo.mode ? ' · ' + hit.vfo.mode.toUpperCase() : ''}`
                : hit.kind === 'bookmark'
                ? `${hit.item.name} · ${formatFreqShort(hit.item.frequency)}${hit.item.mode ? ' · ' + hit.item.mode.toUpperCase() : ''}${hit.item.comment ? ' — ' + hit.item.comment : ''}`
                : hit.kind === 'voice'
                    ? voiceTip(hit.activity)
                    : hit.kind === 'spot'
                        ? spotTip(hit.spot)
                        : `${bandName(hit.band)} · ${formatFreqShort(hit.band.start)}–${formatFreqShort(hit.band.end)}`,
        });
    }, [locate]);

    const onClick = useCallback((e) => {
        const hit = locate(e);
        // Deliberately silent on a miss. The pills are a few millimetres of a
        // canvas, so hitting one is not a certainty — the pulse is what says
        // the tap found something, and no pulse says it did not.
        if (!hit) return;
        haptic('tune', 'spectrum');
        if (hit.kind === 'vfo') {
            // Go to that VFO rather than merely tuning its frequency: the mark
            // says "B is parked here", and arriving on A at B's frequency would
            // be a different thing than the one that was clicked. selectVfo
            // stores what is live into the slot being left, exactly as the
            // Receiver panel's buttons do.
            selectVfo(radio, hit.vfo.id);
            actions.ensureVisible(hit.vfo.frequency);
        } else if (hit.kind === 'voice') {
            const freq = dialFreq(hit.activity);
            actions.tuneTo({ frequency: freq, mode: (hit.activity.mode || 'lsb').toLowerCase() });
            actions.ensureVisible(freq);
            // Pair the tune with a lookup, as the voice activity panel's rows
            // do: the in-app panel takes it when open, otherwise the v1 popup
            // if that is. Neither is ever opened by this click.
            const call = hit.activity.dx_callsign;
            if (lookups && call && !requestLookup(call)) lookupCallsign(call);
        } else if (hit.kind === 'spot') {
            // One tune with the mode the feed implies, as the Spots panel's
            // rows do — see modeForSpot for where those rules come from.
            const freq = Math.round(hit.spot.frequency);
            actions.tuneTo({ frequency: freq, mode: modeForSpot(hit.spot) });
            actions.ensureVisible(freq);
            const call = hit.spot.callsign;
            if (lookups && call && !requestLookup(call)) lookupCallsign(call);
        } else if (hit.kind === 'bookmark') {
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
    }, [locate, actions, lookups, radio]);

    if (!showBands && !showServer && !showLocal && !showVoice && !showDx && !showCw && !showVfos) {
        return null;
    }

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

// The station, with its flag if the country is known.
//
// The flag goes before the callsign rather than beside the country name, so it
// reads as part of who this is — and so a glance down a column of tooltips
// lines the flags up. The tooltips are DOM rather than canvas, so these render
// as flags rather than as a pair of letters.
function who(callsign, code, country, fallback) {
    if (!callsign) return fallback;
    const flag = countryFlag(code);
    const name = flag ? `${flag} ${callsign}` : callsign;
    return country ? `${name} — ${country}` : name;
}

// What the detector found, not what someone named — so the tooltip leads with
// the measurement rather than repeating the label already on the pill.
function voiceTip(a) {
    const parts = [
        `${formatFreqShort(dialFreq(a))} ${(a.mode || 'LSB').toUpperCase()}`,
        who(a.dx_callsign, a.dx_country_code, a.dx_country, 'Voice activity'),
    ];
    if (a.signal_above_noise != null) parts.push(`${a.signal_above_noise.toFixed(1)} dB`);
    if (a.confidence != null) parts.push(`${Math.round(a.confidence * 100)}%`);
    return parts.join(' · ');
}

// Who, where, how long ago — and who heard them. Age leads the second line
// because a spot's usefulness falls off with it: a five-second-old cluster spot
// means someone is there now, a twenty-minute-old one means they were.
function spotTip(s) {
    const parts = [
        `${formatFreqShort(s.frequency)} ${modeForSpot(s).toUpperCase()}`,
        who(s.callsign, s.countryCode, s.country, s.callsign),
        ageLabel(s.at),
    ];
    if (s.snr != null) parts.push(`${s.snr > 0 ? '+' : ''}${s.snr} dB`);
    if (s.wpm != null) parts.push(`${s.wpm} WPM`);
    if (s.spotter) parts.push(`de ${s.spotter}`);
    const note = s.comment || s.message;
    if (note) parts.push(note);
    return parts.join(' · ');
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
