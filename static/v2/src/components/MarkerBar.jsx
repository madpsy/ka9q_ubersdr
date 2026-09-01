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
import {
    assignRows, bandColors, bandLabelPositions, layoutBands, layoutBookmarks, offscreenArrows,
} from '../lib/markers.js';
import { markColors } from '../display/uiConfig.js';
import { bookmarkReachable, bookmarkTarget } from '../lib/bookmarkTune.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import { countryFlag, formatFreqShort, freqInRange, sinceLabel } from '../lib/format.js';
import { activityLabel, dialFreq, subscribeVoiceActivity } from '../lib/voiceActivity.js';
import { getVfos, markableVfos, onVfosChanged, selectVfo } from '../lib/vfos.js';
import { requestLookup } from '../lib/callsign.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { subscribeSpots } from '../lib/spotStore.js';
import { ageLabel, markerSpots, modeForSpot } from '../lib/spots.js';
import { packetAvailable } from '../lib/packet.js';
import {
    REF_MARKER_LABEL, freqRefAvailable, refMarkerFreq, refMarkerLayout, refMarkerTip,
} from '../lib/freqRef.js';
import { subscribePacketMarkers } from '../lib/packetMarkers.js';
import { subscribeListeners } from '../lib/listeners.js';
import { clusterSpots, dotTitle, gapPct } from '../lib/listenerBands.js';
import { subscribeConfirmedVoice } from '../lib/voiceConfirmed.js';
import { tuneTarget, voiceSkimmerAvailable } from '../lib/voiceSkimmer.js';
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

// Confirmed voice: a callsign the skimmer heard and validated. Teal, which is the
// one hue this bar had left — and the collision it looks like it has is one that
// cannot happen. The nearest colour is the CW spots' cyan, and CW spots live in the
// CW segments while a voice skimmer produces nothing there, so the two are never on
// screen together. What it *is* next to is the purple of voice activity, on the same
// SSB segments, and against that it is unmistakable — which is the pair that matters,
// because those two markers mean different things about the same station.
const CONFIRMED_PILL = 'rgba(0, 150, 136, 0.95)';
const CONFIRMED_STEM = 'rgba(0, 150, 136, 0.55)';
const CONFIRMED_INK = '#ffffff';

// The parked VFOs: a colour nothing else in the bar uses, because they are the
// one marker that is neither something the receiver told us about nor something
// somebody published — they are places *you* put down and can pick up again.
// Crimson against the purple of voice activity, which is the nearest hue here.
const VFO_FILL = 'rgba(233, 30, 99, 0.95)';
const VFO_INK = '#ffffff';

// Packet channels: orange, which nothing else in the bar uses. The colour has to be
// its own because the marker means something different from all the others — not "a
// station is here" but "this frequency is shared, and these are the stations on it".
const PACKET_PILL = 'rgba(230, 126, 34, 0.95)';
const PACKET_STEM = 'rgba(230, 126, 34, 0.55)';
const PACKET_INK = '#1b1004';

// The frequency reference: silver, and the one marker in the bar that is not a
// colour.
//
// It cannot be gold or near it, which is also why it does not match the amber
// the spectrum draws its own reference line in. A receiver measures itself
// against a standard station — WWV, MSF, a GPSDO's output — and that is exactly
// the sort of frequency the published bookmark list has an entry for, so the
// pill this one sits beside most often is a gold one. Neutral says what it is,
// too: everything else here is something that was heard, and this is the ruler
// the rest are measured with.
const REF_PILL = 'rgba(214, 222, 234, 0.95)';
const REF_STEM = 'rgba(214, 222, 234, 0.55)';
const REF_INK = '#131a24';

// Spot colours are v1's, so a green pill means the same thing in both
// frontends: green for DX cluster spots (dx-cluster drawDXSpotsOnSpectrum),
// cyan for the CW skimmer's (cw-spots drawCWSpotsOnSpectrum). Both take white
// text, as they do there.
const SPOT_STYLE = {
    dx: { pill: 'rgba(40, 167, 69, 0.95)', stem: 'rgba(40, 167, 69, 0.55)', ink: '#ffffff' },
    cw: { pill: 'rgba(23, 162, 184, 0.95)', stem: 'rgba(23, 162, 184, 0.55)', ink: '#ffffff' },
};

// Listeners: where everybody else on the receiver is tuned, one dot per person
// and a dot with a count where several share a frequency — the Listeners
// panel's band view, drawn across the spectrum's own window instead of across a
// band. lib/listenerBands.js does the clustering for both.
//
// The one layer that is not a pill and does not take a marker row. It lives in
// the band strip along the top, above everything else in the bar, and so it can
// never be pushed up a row or dropped for want of space: the band labels give
// way to it instead. That is the right way round — a label repeats every couple
// of hundred pixels and losing one costs nothing, while a listener that is
// sometimes drawn and sometimes not is not an indicator.
//
// White with a dark ring, which is exactly what the panel paints (.lsn-dot, on
// --text). Not a new colour to learn, and the two views cannot be confused with
// each other because nothing else is ever in this lane.
const LSN_R = 5;            // dot radius, CSS px — the strip is 13 high
const LSN_MIN_W = 15;       // a dot carrying a count grows sideways, as the panel's does
const LSN_LABEL_PAD = 5;    // clearance a band label keeps from a dot

// Off-screen indicators for the dial and the passband edges. Their colours are
// not fixed here: they are the operator's own marks, from the palette or from
// the pickers in the Display panel, and an arrow that did not match the line it
// stands for would be a third colour to learn rather than the same one moved.
//
// Small, and level with the near row rather than in a strip of their own — the
// bar has no spare height, and an arrow on the row it overlaps reads as part of
// the same picture. The halo is the spectrum's trick for the same problem: these
// land on band tints, on pills and on nothing, and a single colour cannot be
// legible against all three on its own.
const ARROW_W = 7;                          // base to tip, CSS px
const ARROW_H = 11;
const ARROW_PAD = 2;                        // clear of the end of the bar
const ARROW_GAP = 3;                        // between one arrow and the next
const ARROW_HALO = 'rgba(0, 0, 0, 0.72)';

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
    //
    // `running` as well, and that is not belt and braces. Subscribing is what
    // *opens* the spot socket when nobody else holds it — see spotStore — and
    // these two toggles default to on, so before this the bar was the first
    // subscriber on every page load: the socket opened behind the Start overlay
    // and minted the page's session id as a side effect of doing so. Pressing
    // Start then mints a fresh one for the audio and spectrum sessions, leaving
    // the spot socket registered to an id with nothing behind it — which is what
    // the connection's `stale` handling exists to clean up after. Everything
    // else that reads these feeds already waits for the receiver (App.jsx,
    // MediaSessionContext, useMarkerNav, SpotsPanel); this was the one that did
    // not, and its comment above assumed somebody else had opened the stream.
    //
    // The visible consequence is that spot markers clear on Stop, which is what
    // the voice layer beside them already does — its poll goes through the same
    // gate — and what the Spots panel says in words.
    const live = !!radio.running;
    const showDx = live && display.markerDxSpots !== false && !!(serverInfo && serverInfo.dx_cluster);
    const showCw = live && display.markerCwSpots !== false && !!(serverInfo && serverInfo.cw_skimmer);
    // Confirmed callsigns from the voice skimmer, gated on the addon being installed.
    const showConfirmed = display.markerVoiceConfirmed !== false
        && voiceSkimmerAvailable(serverInfo);
    // Packet channels, gated on the addon being installed — the toggle would otherwise
    // promise markers that can never appear.
    const showPacket = display.markerPacket !== false && packetAvailable(serverInfo);
    // Where the other listeners are. Not you: the dial already says where this
    // receiver is pointed, and a dot for yourself would be the one mark in the
    // bar that tells you something you are looking at.
    const showListeners = display.markerListeners !== false;
    // The frequency reference, gated on the operator running the monitor at all.
    // refMarkerFreq stays null until it has averaged a measurement, so the pill
    // arrives with the first lock rather than at load — the same "enabled, but
    // nothing to say yet" the badge and the spectrum marks already handle.
    const showRef = display.markerReference !== false && freqRefAvailable(serverInfo);
    const refFreq = showRef ? refMarkerFreq(serverInfo) : null;
    const lookups = !!(serverInfo && serverInfo.lookup_service);

    // The dial and passband colours the spectrum is drawing with — palette
    // defaults or the operator's own overrides, whichever is in force. Plain
    // strings, so they can go straight into the draw effect's dependencies.
    const { dial: dialColor, edge: edgeColor } = markColors(display);
    // The passband in absolute hertz. The tuning state holds it as offsets from
    // the dial, which are signed — an LSB filter's edges are both below it.
    const edgeLowHz = tuning.frequency + tuning.bandwidthLow;
    const edgeHighHz = tuning.frequency + tuning.bandwidthHigh;

    // One shared poll for the page: subscribing starts it, and the last unsubscribe
    // stops it, so with the toggle off the addon is never asked anything.
    const [packet, setPacket] = useState([]);
    useEffect(() => {
        if (!showPacket) { setPacket([]); return undefined; }
        return subscribePacketMarkers((list) => setPacket(list || []));
    }, [showPacket]);

    // Its own poll, for every band rather than the panel's chosen one — see
    // lib/voiceConfirmed.js. Subscribing is what starts it, so with the toggle off the
    // addon is never asked anything.
    const [confirmed, setConfirmed] = useState([]);
    useEffect(() => {
        if (!showConfirmed) { setConfirmed([]); return undefined; }
        return subscribeConfirmedVoice((list) => setConfirmed(list || []));
    }, [showConfirmed]);

    // The same refcounted /stats poll the Listeners panel and the spectrum's
    // stats readout use — see lib/listeners.js. Subscribing joins whichever loop
    // is already running or starts one, so this costs a request every ten
    // seconds only when nothing else was asking. Gated on `running` as the spot
    // layers are: a stopped receiver leaving stale dots on the bar would be the
    // one place in the app still claiming to know who is listening.
    const [listeners, setListeners] = useState([]);
    useEffect(() => {
        if (!showListeners || !live) { setListeners([]); return undefined; }
        return subscribeListeners((state) => {
            setListeners(((state && state.channels) || []).filter((c) => !c.you));
        });
    }, [showListeners, live]);

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

        hitsRef.current = {
            bookmarks: [], bands: [], voice: [], confirmed: [], spots: [], vfos: [], packet: [],
            ref: [], listeners: [],
        };
        if (!span) return;

        const startFreq = centerFreq - span / 2;
        const endFreq = centerFreq + span / 2;
        const css = getComputedStyle(document.documentElement);
        const accent = css.getPropertyValue('--accent').trim() || '#08a2fb';
        const accentInk = css.getPropertyValue('--accent-ink').trim() || '#04141a';
        const dim = css.getPropertyValue('--text-faint').trim() || '#5c6779';
        // The listener dots, from the same two tokens the panel's dots use.
        const ink = css.getPropertyValue('--text').trim() || '#e8eef7';
        const paper = css.getPropertyValue('--bg').trim() || '#0b0f16';

        // ---- listeners: clustered first, drawn after the band strip --------
        // Laid out before the bands because the band labels have to fit around
        // the dots rather than the other way round, and the labels are drawn in
        // the block below.
        //
        // Clustered across the visible window with the same pixel gap the panel
        // uses, so what counts as "the same frequency" tightens as you zoom in:
        // at full span half the receiver is one dot, and at 20 kHz two people
        // 300 Hz apart are two.
        const lsnSpots = showListeners && listeners.length
            ? clusterSpots(
                listeners.filter((c) => c.frequency >= startFreq && c.frequency <= endFreq),
                startFreq, endFreq, gapPct(width),
            )
            : [];
        c.font = '700 8px ui-monospace, SFMono-Regular, monospace';
        const lsnDots = lsnSpots.map((spot) => ({
            spot,
            x: (spot.pct / 100) * width,
            // A single dot is round; several share a capsule wide enough for the
            // count, exactly as .lsn-dot.is-many does in the panel.
            w: spot.channels.length > 1
                ? Math.max(LSN_MIN_W, c.measureText(String(spot.channels.length)).width + 8)
                : LSN_R * 2,
        }));

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
                    // A label under a listener dot is dropped rather than moved.
                    // The positions are evenly spread across the band and sliding
                    // one along would break that spacing for the sake of a name
                    // that is repeated every couple of hundred pixels anyway.
                    if (lsnDots.some((d) => (
                        Math.abs(d.x - x) < (d.w + labelWidth) / 2 + LSN_LABEL_PAD
                    ))) continue;
                    c.fillStyle = 'rgba(0,0,0,0.45)';
                    c.fillRect(x - labelWidth / 2, 1.5, labelWidth, BAND_H - 3);
                    c.fillStyle = 'rgba(255,255,255,0.92)';
                    c.fillText(name, x, BAND_H / 2 + 0.5);
                }
            }
        }

        // ---- listeners, drawn ----------------------------------------------
        // Over the band strip and its labels, and before the pills so that a
        // stem is covered by whatever it passes behind rather than drawn across
        // it. The stem is what makes a mark at the top of the bar point at a
        // frequency at the bottom of it, which every other marker here needs too.
        if (lsnDots.length) {
            const cy = BAND_H / 2;
            for (const d of lsnDots) {
                c.strokeStyle = 'rgba(255,255,255,0.28)';
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(Math.round(d.x) + 0.5, cy + LSN_R);
                c.lineTo(Math.round(d.x) + 0.5, MARKER_BAR_H);
                c.stroke();

                c.fillStyle = ink;
                roundRect(c, d.x - d.w / 2, cy - LSN_R, d.w, LSN_R * 2, LSN_R);
                c.fill();
                // The panel gives its dots a dark ring for the same reason: they
                // land on band colours, on the bar's background and on each
                // other's stems, and none of those is a reliable backdrop.
                c.strokeStyle = 'rgba(0,0,0,0.55)';
                c.stroke();

                if (d.spot.channels.length > 1) {
                    c.font = '700 8px ui-monospace, SFMono-Regular, monospace';
                    c.textBaseline = 'middle';
                    c.textAlign = 'center';
                    c.fillStyle = paper;
                    c.fillText(String(d.spot.channels.length), d.x, cy + 0.5);
                }

                hitsRef.current.listeners.push({
                    x: d.x, y: cy - LSN_R, w: d.w, h: LSN_R * 2, spot: d.spot,
                });
            }
        }

        // ---- bookmarks ---------------------------------------------------
        // Kept so the voice layer below can avoid the space they took.
        let placedMarks = [];

        // ---- the frequency reference: laid out before anything else ---------
        // First claim on a row, ahead of even the VFOs. The reference is not a
        // place a signal might be, it is where this receiver's own accuracy is
        // measured — and it sits on a standard station, which is exactly the sort
        // of frequency somebody has already published a bookmark for. So the
        // collision is the normal case rather than an edge one, and when the two
        // land together the reference keeps the near row while the bookmark is
        // pushed up to the top one: both stay readable, and the mark that is about
        // this pixel is the one against the spectrum.
        //
        // Drawn at the foot of the function for the same reason the VFOs are.
        let placedRef = [];
        if (showRef && refFreq != null) {
            c.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';
            placedRef = refMarkerLayout({
                freq: refFreq,
                startFreq,
                endFreq,
                width,
                labelWidth: c.measureText(REF_MARKER_LABEL).width + 10,
            });
            placedMarks = placedRef.slice();
        }

        // ---- VFOs: laid out next, drawn last --------------------------------
        // Ahead of everything but the reference, because they outrank the rest of
        // the bar: a bookmark or a spot can move up a row or be dropped, and a VFO
        // is somewhere you put down yourself and expect to find again. Everything
        // below is seeded with these, so it fits around the VFOs rather than over
        // them.
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
            placedVfos = assignRows(items, placedMarks);
            placedMarks = placedMarks.concat(placedVfos);
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

        // ---- confirmed voice callsigns ------------------------------------
        // After voice activity and seeded with it, so the two never overlap. They
        // belong next to each other — the same station, once as "speech here" and
        // once as "and it is this callsign" — and the order puts the named one
        // second because a name is the more specific claim.
        if (showConfirmed && confirmed.length) {
            c.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';

            const items = [];
            for (const sp of confirmed) {
                if (!sp.hz || sp.hz < startFreq || sp.hz > endFreq) continue;
                items.push({
                    spot: sp,
                    label: sp.callsign,
                    x: ((sp.hz - startFreq) / span) * width,
                    width: Math.min(140, c.measureText(sp.callsign).width + 10),
                });
            }
            items.sort((a, b) => a.x - b.x);

            const placedConfirmed = assignRows(items, placedMarks);
            for (const p of placedConfirmed) {
                const y = BAND_H + 2 + (ROWS - 1 - p.row) * ROW_H;
                const { x, width: w } = p;

                c.strokeStyle = CONFIRMED_STEM;
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(Math.round(x) + 0.5, y + PILL_H);
                c.lineTo(Math.round(x) + 0.5, MARKER_BAR_H);
                c.stroke();

                c.fillStyle = CONFIRMED_PILL;
                roundRect(c, x - w / 2, y, w, PILL_H, 3);
                c.fill();
                c.strokeStyle = 'rgba(255,255,255,0.55)';
                c.stroke();

                c.fillStyle = CONFIRMED_INK;
                clipText(c, p.label, x, y + PILL_H / 2, w - 6);

                hitsRef.current.confirmed.push({
                    x, y, w, h: PILL_H, spot: p.spot, label: p.label,
                });
            }
            placedMarks = placedMarks.concat(placedConfirmed);
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

        // ---- packet channels ----------------------------------------------
        // Last of the pills and seeded with everything already placed. A packet channel
        // is a fixed frequency somebody configured, so unlike a spot it does not move —
        // but it is also the least urgent thing in the bar, and it gives way rather than
        // pushing a live detection off its row.
        if (showPacket && packet.length) {
            c.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';

            const items = [];
            for (const m of packet) {
                if (m.frequency < startFreq || m.frequency > endFreq) continue;
                items.push({
                    marker: m,
                    label: m.text,
                    x: ((m.frequency - startFreq) / span) * width,
                    width: Math.min(150, c.measureText(m.text).width + 10),
                });
            }
            items.sort((a, b) => a.x - b.x);

            for (const p of assignRows(items, placedMarks)) {
                const y = BAND_H + 2 + (ROWS - 1 - p.row) * ROW_H;
                const { x, width: w } = p;

                c.strokeStyle = PACKET_STEM;
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(Math.round(x) + 0.5, y + PILL_H);
                c.lineTo(Math.round(x) + 0.5, MARKER_BAR_H);
                c.stroke();

                // A channel with nothing on it is drawn faded rather than dropped: it
                // is still being listened to, and "144.800, nothing for a quarter of an
                // hour" is a real answer. A marker that vanished would read as a
                // receiver that had stopped listening.
                c.save();
                if (!p.marker.calls.length) c.globalAlpha = 0.45;
                c.fillStyle = PACKET_PILL;
                roundRect(c, x - w / 2, y, w, PILL_H, 3);
                c.fill();
                c.strokeStyle = 'rgba(255,255,255,0.55)';
                c.stroke();
                c.restore();

                c.fillStyle = PACKET_INK;
                clipText(c, p.label, x, y + PILL_H / 2, w - 6);

                hitsRef.current.packet.push({ x, y, w, h: PILL_H, marker: p.marker });
            }
        }

        // Baseline the stems land on.
        c.fillStyle = dim;
        c.globalAlpha = 0.35;
        c.fillRect(0, MARKER_BAR_H - 1, width, 1);
        c.globalAlpha = 1;
        // ---- the frequency reference, drawn ----------------------------------
        // Placed at the top of this function, drawn here for the same reason the
        // VFOs are: whatever this pill displaced is now on the row above with a
        // stem running down past it.
        for (const p of placedRef) {
            const y = BAND_H + 2 + (ROWS - 1 - p.row) * ROW_H;
            const { x, width: w } = p;

            c.strokeStyle = REF_STEM;
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(Math.round(x) + 0.5, y + PILL_H);
            c.lineTo(Math.round(x) + 0.5, MARKER_BAR_H);
            c.stroke();

            c.fillStyle = REF_PILL;
            roundRect(c, x - w / 2, y, w, PILL_H, 3);
            c.fill();
            c.strokeStyle = 'rgba(255,255,255,0.55)';
            c.stroke();

            c.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            c.textBaseline = 'middle';
            c.textAlign = 'center';
            c.fillStyle = REF_INK;
            clipText(c, REF_MARKER_LABEL, x, y + PILL_H / 2, w - 6);

            hitsRef.current.ref.push({ x, y, w, h: PILL_H });
        }

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

        // ---- off-screen dial and passband ------------------------------------
        // Last of everything, so a marker at the end of the view cannot cover an
        // arrow. An indicator that can be hidden is not one.
        const arrows = offscreenArrows({
            dialHz: tuning.frequency,
            edgeHz: [edgeLowHz, edgeHighHz],
            startFreq,
            endFreq,
        });
        // Level with the near row: the bottom of the marker section.
        const arrowCy = BAND_H + 2 + (ROWS - 1) * ROW_H + PILL_H / 2;
        arrows.left.forEach((kind, i) => {
            drawArrow(c, ARROW_PAD + i * (ARROW_W + ARROW_GAP), arrowCy, -1,
                kind === 'dial' ? dialColor : edgeColor);
        });
        arrows.right.forEach((kind, i) => {
            drawArrow(c, width - ARROW_PAD - i * (ARROW_W + ARROW_GAP), arrowCy, 1,
                kind === 'dial' ? dialColor : edgeColor);
        });

    }, [width, centerFreq, span, catalog.bands, marks, showBands, colors, tuning.frequency,
        showVoice, voice, showConfirmed, confirmed,
        showDx, showCw, dxSpots, cwSpots, ageTick, showPacket, packet,
        showVfos, vfos, tuning.frequency, showRef, refFreq, showListeners, listeners,
        dialColor, edgeColor, edgeLowHz, edgeHighHz]);

    const locate = useCallback((e) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        // The dots first. They are alone in the band strip, so this cannot take a
        // hit from a pill — but it has to come before the band fallback below,
        // which claims the whole of that strip.
        const ls = hitsRef.current.listeners.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (ls) return { kind: 'listener', ...ls };
        const rf = hitsRef.current.ref.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (rf) return { kind: 'ref' };
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
        const cv = hitsRef.current.confirmed.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (cv) return { kind: 'confirmed', ...cv };
        const s = hitsRef.current.spots.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (s) return { kind: 'spot', ...s };
        const pk = hitsRef.current.packet.find(
            (b) => y >= b.y && y <= b.y + b.h && x >= b.x - b.w / 2 && x <= b.x + b.w / 2,
        );
        if (pk) return { kind: 'packet', ...pk };
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
            text: hit.kind === 'listener'
                ? dotTitle(hit.spot, Date.now())
                : hit.kind === 'ref'
                ? refMarkerTip(serverInfo)
                : hit.kind === 'vfo'
                ? `VFO ${hit.vfo.id} · ${formatFreqShort(hit.vfo.frequency)}${hit.vfo.mode ? ' · ' + hit.vfo.mode.toUpperCase() : ''}`
                : hit.kind === 'bookmark'
                ? `${hit.item.name} · ${formatFreqShort(hit.item.frequency)}${hit.item.mode ? ' · ' + hit.item.mode.toUpperCase() : ''}${hit.item.comment ? ' — ' + hit.item.comment : ''}`
                : hit.kind === 'voice'
                    ? voiceTip(hit.activity)
                    : hit.kind === 'confirmed'
                    ? confirmedTip(hit.spot)
                    : hit.kind === 'spot'
                        ? spotTip(hit.spot)
                        : hit.kind === 'packet'
                            ? packetTip(hit.marker)
                            : `${bandName(hit.band)} · ${formatFreqShort(hit.band.start)}–${formatFreqShort(hit.band.end)}`,
        });
    }, [locate, serverInfo]);

    const onClick = useCallback((e) => {
        const hit = locate(e);
        // Deliberately silent on a miss. The pills are a few millimetres of a
        // canvas, so hitting one is not a certainty — the pulse is what says
        // the tap found something, and no pulse says it did not.
        if (!hit) return;
        haptic('tune', 'spectrum');
        if (hit.kind === 'listener') {
            // The same tune the panel's dots make — frequency, mode and the
            // passband they are using — so listening in on somebody lands
            // identically wherever you click them. A dot with nobody tunable
            // behind it (an IQ channel) is read rather than pressed, as it is
            // there.
            const t = hit.spot.tune;
            if (!t || !freqInRange(t.frequency)) return;
            actions.tuneTo({
                frequency: t.frequency,
                mode: t.mode,
                bandwidthLow: t.bandwidthLow,
                bandwidthHigh: t.bandwidthHigh,
            });
        } else if (hit.kind === 'ref') {
            // Where this receiver hears the reference, which is where the dial has
            // to be to hear it — not the frequency the station transmits on, which
            // is the same number only for a receiver that is exactly right. No
            // mode: a carrier is not one, and whatever is set already is a better
            // answer than a guess.
            if (refFreq != null) {
                const freq = Math.round(refFreq);
                actions.setFrequency(freq);
                actions.ensureVisible(freq);
            }
        } else if (hit.kind === 'vfo') {
            // Go to that VFO rather than merely tuning its frequency: the mark
            // says "B is parked here", and arriving on A at B's frequency would
            // be a different thing than the one that was clicked. selectVfo
            // stores what is live into the slot being left, exactly as the
            // Receiver panel's buttons do.
            selectVfo(radio, hit.vfo.id);
            actions.ensureVisible(hit.vfo.frequency);
        } else if (hit.kind === 'voice') {
            // Every kind below refuses a frequency outside the receiver rather than
            // letting tuneTo clamp it to the band edge — a spot or marker that cannot be
            // reached must not look like it tuned. Live cluster and skimmer feeds are
            // already filtered server-side; this covers injected spots, anything replayed
            // from the database, and a receiver whose range has since narrowed.
            const freq = dialFreq(hit.activity);
            if (!freqInRange(freq)) return;
            actions.tuneTo({ frequency: freq, mode: (hit.activity.mode || 'lsb').toLowerCase() });
            actions.ensureVisible(freq);
            // Pair the tune with a lookup, as the voice activity panel's rows
            // do: the in-app panel takes it when open, otherwise the v1 popup
            // if that is. Neither is ever opened by this click.
            const call = hit.activity.dx_callsign;
            if (lookups && call && !requestLookup(call)) lookupCallsign(call);
        } else if (hit.kind === 'confirmed') {
            // The frequency and the mode the skimmer heard it on — tuneTarget, the same
            // one the panel's rows use, so clicking a callsign lands identically
            // wherever you click it. A mode it did not report is left alone rather than
            // guessed, which is why this is a spread and not two fixed fields.
            const t = tuneTarget(hit.spot);
            if (t && freqInRange(t.frequency)) {
                actions.tuneTo(t);
                actions.ensureVisible(t.frequency);
                if (lookups && !requestLookup(hit.spot.callsign)) lookupCallsign(hit.spot.callsign);
            }
        } else if (hit.kind === 'packet') {
            // Tune to the channel. No mode is set: the addon's channels are configured
            // with their own demodulation, and guessing one here would fight whatever
            // the operator has the receiver set to for a frequency they have just
            // asked to hear.
            if (!freqInRange(hit.marker.frequency)) return;
            actions.setFrequency(hit.marker.frequency);
            actions.ensureVisible(hit.marker.frequency);
        } else if (hit.kind === 'spot') {
            // One tune with the mode the feed implies, as the Spots panel's
            // rows do — see modeForSpot for where those rules come from.
            const freq = Math.round(hit.spot.frequency);
            if (!freqInRange(freq)) return;
            actions.tuneTo({ frequency: freq, mode: modeForSpot(hit.spot) });
            actions.ensureVisible(freq);
            const call = hit.spot.callsign;
            if (lookups && call && !requestLookup(call)) lookupCallsign(call);
        } else if (hit.kind === 'bookmark') {
            // Server or local — the pill draws both, and both can carry a passband. One
            // tune, so a mode change does not send the old filter on the way through.
            // Same refusal as the panels: a marker for a bookmark this receiver cannot
            // reach must not silently retune to the band edge.
            if (!bookmarkReachable(hit.item, MIN_FREQ, MAX_FREQ)) return;
            actions.tuneTo(bookmarkTarget(hit.item));
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
    }, [locate, actions, lookups, radio, refFreq]);

    // Packet was missing from this list, which hid the whole bar for anyone who
    // had turned everything else off and kept the packet channels.
    if (!showBands && !showServer && !showLocal && !showVoice && !showConfirmed
        && !showDx && !showCw && !showVfos && !showPacket && !showRef && !showListeners) {
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
/**
 * A confirmed sighting: who, where, and how long ago. The country comes from the
 * addon rather than being derived here — see normaliseSpot for why that matters for
 * England, Scotland and Wales.
 */
function confirmedTip(sp) {
    const where = sp.country ? ` (${sp.country})` : '';
    const when = sp.at ? ` · ${sinceLabel(sp.at, Date.now())}` : '';
    const mode = sp.mode ? ` ${sp.mode.toUpperCase()}` : '';
    return `${sp.callsign}${where} · ${formatFreqShort(sp.hz)}${mode}${when} — heard and confirmed`;
}

function voiceTip(a) {
    const parts = [
        `${formatFreqShort(dialFreq(a))} ${(a.mode || 'LSB').toUpperCase()}`,
        who(a.dx_callsign, a.dx_country_code, a.dx_country, 'Voice activity'),
    ];
    if (a.signal_above_noise != null) parts.push(`${a.signal_above_noise.toFixed(1)} dB`);
    if (a.confidence != null) parts.push(`${Math.round(a.confidence * 100)}%`);
    return parts.join(' · ');
}

/**
 * A packet channel's tooltip: who is on it, and who they are working.
 *
 * The only multi-line tip in the bar, and it has to be. Every other marker is one thing
 * — a bookmark, a spot, a detection — and fits on a line; a shared frequency is a list
 * by nature, and squeezing six station pairs onto one line with separators would be
 * unreadable exactly when it has something to say.
 *
 * Ordered by how recently each pair was heard, most recent first, because the question
 * a packet channel raises is who is there *now*. Each line is "FROM › TO", with a count
 * when a pair has been heard more than once — a station beaconing every minute is one
 * line and a number, not thirty lines.
 */
function packetTip(m) {
    const head = [
        `${m.mhz ? `${m.mhz} MHz` : m.label} · packet`,
        m.calls.length
            ? `${m.calls.length} station${m.calls.length === 1 ? '' : 's'} · ${sinceLabel(m.at)}`
            : (m.up ? 'listening — nothing heard' : 'channel not connected'),
    ].join(' · ');
    if (!m.pairs.length) return head;
    // Six, because a tooltip is not the panel: the whole of it is in the Packet panel
    // and on the addon's own page, and a tip taller than the marker bar it hangs over
    // stops being a tip.
    const lines = m.pairs.slice(0, 6).map((p) => (
        `${p.from} › ${p.to || '?'}${p.n > 1 ? `  ×${p.n}` : ''}`
    ));
    if (m.pairs.length > 6) lines.push(`+${m.pairs.length - 6} more`);
    return [head, ...lines].join('\n');
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

// One off-screen indicator. `x` is the tip and `dir` which way it points: -1 for
// the left end of the bar, +1 for the right.
//
// Stroked before it is filled, so the dark outline sits under the colour rather
// than eating into it — the same order the spectrum's marks use for their halo.
function drawArrow(c, x, cy, dir, fill) {
    c.beginPath();
    c.moveTo(x, cy);
    c.lineTo(x - dir * ARROW_W, cy - ARROW_H / 2);
    c.lineTo(x - dir * ARROW_W, cy + ARROW_H / 2);
    c.closePath();

    c.lineJoin = 'round';
    c.lineWidth = 2;
    c.strokeStyle = ARROW_HALO;
    c.stroke();

    c.fillStyle = fill;
    c.fill();
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
