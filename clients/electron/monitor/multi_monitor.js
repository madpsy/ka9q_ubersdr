// UberSDR Multi-Monitor
// Connects to multiple SDR instances simultaneously, muting all but the active listener(s).
// Supports dual-channel audio: up to two instances active at once, panned L / L+R / R.
// Signal quality data (basebandPower / signalSNR) flows from every connected instance.

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];

// Band frequency ranges in MHz (matching instances.js)
const BAND_RANGES = {
    '160m': { min: 1.81,   max: 2.0   },
    '80m':  { min: 3.5,    max: 3.8   },
    '60m':  { min: 5.2585, max: 5.4065},
    '40m':  { min: 7.0,    max: 7.2   },
    '30m':  { min: 10.1,   max: 10.15 },
    '20m':  { min: 14.0,   max: 14.35 },
    '17m':  { min: 18.068, max: 18.168},
    '15m':  { min: 21.0,   max: 21.45 },
    '12m':  { min: 24.89,  max: 24.99 },
    '10m':  { min: 28.0,   max: 29.7  },
};

// SNR thresholds for band quality filter labels
const BAND_QUALITY_SNR = { 'fair': 6, 'good': 20, 'excellent': 30 };

// Maximum number of instances that can be monitored simultaneously
const MAX_SELECTED = 5;

// Signal bar range (dBFS)
const SIG_MIN_DB = -120;
const SIG_MAX_DB = -40;

// SNR meter range and colour steps, in dB (mirrors SNR_MIN/SNR_MAX and the
// colour ramp in static/v2/src/lib/format.js).
//
// These were 30–80 with steps at 40 and 50, which made sense only because the
// figure being measured was not an SNR: the server sent noise as a density, so
// `power - noise` came out as S/N0 in dB·Hz, about 34 dB above the true SNR on
// a 2.65 kHz filter. MinimalRadio now normalises that to a real SNR whatever
// protocol version the instance speaks, so the scale is the one that means:
// below 0 the channel is empty, 3-10 dB is weak but readable speech, and 20 dB
// and up is armchair copy.
const SNR_MIN_DB   = -5;
const SNR_MAX_DB   = 30;
const SNR_GREEN_DB = 15;   // at or above: signal stops improving audibly
const SNR_AMBER_DB = 6;    // at or above: above the noise, worth listening to

// How often to refresh the signal meter UI (ms)
const METER_UPDATE_INTERVAL = 100;

// Rolling history: 10 seconds at 100 ms = 100 samples
const HISTORY_SAMPLES = 100;

// ─── State ───────────────────────────────────────────────────────────────────

let allInstances = [];          // All instances from API
let filteredInstances = [];     // After search/filter

// Promise that resolves once loadInstances() has completed at least once.
// startMonitoringFollower() awaits this to avoid a race where the follower
// join flow fires before allInstances is populated.
let _instancesReadyResolve = null;
const _instancesReady = new Promise(resolve => { _instancesReadyResolve = resolve; });

let selectedIds = new Set();    // IDs chosen in selection phase
let selectSortKey = 'snr';      // Sort key for the selection grid

// Monitor phase
let activeRadios = {};          // instanceId → MinimalRadio
let meterUpdateTimer = null;    // setInterval handle for meter redraws
let signalHistory = {};         // instanceId → dBFS ring buffer (Array)
let snrHistory    = {};         // instanceId → SNR ring buffer (Array)
let historyIndex  = {};         // instanceId → next write position
let historyTime   = {};         // instanceId → performance.now() ring buffer (sample arrival times)
let signalCharts  = {};         // instanceId → Chart.js instance
let chartMode     = {};         // instanceId → 'dbfs' | 'snr' (all kept in sync)
let globalChartMode = 'snr';    // Single mode shared across all tiles
let sessionExpiry = {};         // instanceId → Date (session expiry) or null (unlimited)

// Reconnection state
let reconnectTimers = {};       // instanceId → setTimeout handle (pending reconnect)
let disconnectedIds = new Set();// instanceIds currently in a disconnected/reconnecting state
const RECONNECT_DELAY_MS = 5000; // wait 5 s before attempting reconnect

// Dual-channel audio state
// channel: 'left' | 'right' | 'both' | null
let leftChannelId  = null;      // instance assigned to left ear
let rightChannelId = null;      // instance assigned to right ear
// Note: 'both' (centre) is stored in leftChannelId with rightChannelId = null

// Follower-mode pan intent map: instanceId → pan value (-1 | 0 | 1)
// Maintained by assignChannel() in follower mode so updateChannelUI() can
// distinguish 'left' (pan=-1) from 'both' (pan=0) without activeRadios.
const followerPanMap = new Map();

// How far the connected receiver tunes, in Hz.
//
// Not always the 0-30 MHz box this page assumed: the span follows the front end sample
// rate, so a 129.6 Msps RX888 reaches 60 MHz and has 6 m in it. The numbers come from
// /api/description's `tuning_range`, built server-side by ReceiverConfig.TuningRange in
// receiver_span.go — the same object v2 reads.
//
// The fallback is a contract rather than padding: until the description answers, and on
// a server too old to publish the object, this must behave exactly as this page did
// before the span became configurable. The old bottom here was 0.1 MHz, which was this
// page's own number and matched nothing else — the server has always said 10 kHz.
const FALLBACK_MIN_FREQ_HZ = 10000;
const FALLBACK_MAX_FREQ_HZ = 30000000;
let minFreqHz = FALLBACK_MIN_FREQ_HZ;
let maxFreqHz = FALLBACK_MAX_FREQ_HZ;

/**
 * Adopt the receiver's tuning range and resize the frequency controls to match.
 *
 * Each field falls back on its own — they are independent facts, and a receiver that
 * states one must not reset the other. A max at or below the min is not a range but a
 * misconfiguration, and taking it would leave every clamp on this page inverted, so it
 * is refused outright. Mirrors applyTuningRange in static/v2/src/radio/constants.js.
 */
function applyTuningRange(range) {
    const r = range || {};
    // `> 0` rather than `??` or `||`, so 0, null, '' and undefined all fall through to
    // the default rather than 0 becoming a legitimate limit.
    const pick = (v, was) =>
        (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : was);
    const min = pick(r.min_frequency, FALLBACK_MIN_FREQ_HZ);
    const max = pick(r.max_frequency, FALLBACK_MAX_FREQ_HZ);
    if (max <= min) return false;

    const changed = min !== minFreqHz || max !== maxFreqHz;
    minFreqHz = min;
    maxFreqHz = max;

    // The three frequency inputs are in MHz, and their min/max are what stops the
    // browser's own number validation rejecting 6 m before any of this code runs.
    const minMhz = minFreqHz / 1e6;
    const maxMhz = maxFreqHz / 1e6;
    ['freqSlider', 'freqInput', 'snrModalFreqInput'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.min = String(minMhz);
        el.max = String(maxMhz);
    });

    // The tick labels under the slider are positioned by percentage, so they have to be
    // regenerated rather than restyled — a fixed 0/5/10/15/20/25/30 would sit at the
    // right pixels and name the wrong frequencies.
    renderFreqMarkers();
    return changed;
}

/** Is this frequency, in MHz, one the connected receiver can actually tune? */
function freqInRangeMhz(mhz) {
    const hz = mhz * 1e6;
    return hz >= minFreqHz && hz <= maxFreqHz;
}

/** Redraw the slider's tick labels for the range now in force. */
function renderFreqMarkers() {
    const markers = document.querySelector('.freq-markers');
    if (!markers) return;
    const maxMhz = maxFreqHz / 1e6;
    // Six intervals, as the original markup had, so the spacing stays familiar. Whole
    // MHz where the span allows it; the span is a whole number of MHz for any real
    // receiver, and a fraction is rounded rather than printed to six places.
    const steps = 6;
    const html = [];
    for (let i = 0; i <= steps; i++) {
        const mhz = (maxMhz * i) / steps;
        const label = Number.isInteger(mhz) ? String(mhz) : mhz.toFixed(1);
        html.push(`<span style="left:${((i / steps) * 100).toFixed(2)}%">${label}</span>`);
    }
    markers.innerHTML = html.join('');
}

/**
 * Ask the receiver how far it tunes.
 *
 * Failure is not an error: every path out leaves the fallback in force, and an operator
 * on a 30 MHz receiver sees no difference whether this succeeds or not.
 */
async function loadTuningRange() {
    try {
        const resp = await fetch('/api/description');
        if (!resp.ok) return;
        const desc = await resp.json();
        applyTuningRange(desc && desc.tuning_range);
    } catch (e) { /* keep the fallback */ } finally {
        // Whether or not the fetch worked, the range in force is now final — so this is
        // where the frequency restoreFreqFromURL deliberately left unchecked gets its
        // one and only check.
        revalidateFrequency();
    }
}

/**
 * Check the restored frequency against the range that is actually in force.
 *
 * restoreFreqFromURL runs before the receiver has been asked anything, so a share link
 * or saved preference is accepted unvalidated and settled here instead. A frequency the
 * receiver genuinely cannot reach falls back to the page default rather than being
 * clamped to the band edge: clamping would look like success and leave the user on a
 * frequency they never asked for.
 */
function revalidateFrequency() {
    if (currentFreqHz >= minFreqHz && currentFreqHz <= maxFreqHz) return;

    const mhz = DEFAULT_FREQ_HZ / 1e6;
    currentFreqHz = DEFAULT_FREQ_HZ;
    currentMode = resolveMode(mhz);
    isFreqValid = true;

    const slider  = document.getElementById('freqSlider');
    const input   = document.getElementById('freqInput');
    const display = document.getElementById('freqDisplay');
    const modeEl  = document.getElementById('modeIndicator');
    if (slider) slider.value = mhz;
    if (input) {
        input.value = mhz.toFixed(6);
        input.classList.remove('invalid');
    }
    if (display) display.textContent = `${mhz.toFixed(6)} MHz`;
    if (modeEl) modeEl.textContent = currentMode.toUpperCase();
}

// Frequency state
// Where this page starts when nothing else says otherwise — also where
// revalidateFrequency() sends a frequency the receiver turns out not to cover.
const DEFAULT_FREQ_HZ = 14100000;
let currentFreqHz   = DEFAULT_FREQ_HZ;
let currentMode     = 'usb';
let modality        = 'phone';   // 'phone' | 'cw'
let modeOverride    = null;      // null | 'usb' | 'lsb' | 'cwu' | 'cwl' — user-forced sideband
let isFreqValid     = true;

// Band quality filter
let currentBandFilter = '';   // '' | 'fair' | 'good' | 'excellent'

// User location
let userLocation = null;   // { latitude, longitude } once resolved
let userMarker   = null;   // Leaflet marker for user's position

// Select-phase audio preview
let previewRadio      = null;   // MinimalRadio instance for select-phase preview
let previewId         = null;   // ID of the instance currently being previewed
let previewMeterTimer = null;   // setInterval handle for preview SNR meter

// Noise Reduction state
// Each active radio gets its own NREngine + ScriptProcessorNode so that
// independently-panned channels (L / R / both) are processed separately.
let nrGlobalEnabled = false;    // default OFF — user must opt in

// ─── Noise Reduction Controls ─────────────────────────────────────────────────

/**
 * Helper to reset a single NREngine's internal state (ring buffer, OLA tail,
 * delay buffer, entropy arrays).  Safe to call on any NREngine instance.
 */
function resetNREngine(eng) {
    if (!eng) return;
    eng.audio.fill(0);
    eng.olaBuf.fill(0);
    eng._delayReady = false;
    eng._delayBuf   = new Float32Array(4096);
    eng.entropyRaw.fill(0);
    eng.entropySmoothed.fill(0);
    eng.entropyThresh.fill(0);
    for (let i = 0; i < eng.fRe.length; i++) {
        eng.fRe[i].fill(0);
        eng.fIm[i].fill(0);
        eng.fMag[i].fill(0);
        eng.mask[i].fill(0);
        eng.smoothed[i].fill(0);
    }
}

/**
 * Reset both the NREngine internal state AND the per-radio sample accumulator
 * ring buffers (_nrInBuf / _nrOutBuf).  Call this whenever the audio context
 * changes (retune, unmute, Smart Listen switch) to avoid stale-context artefacts.
 */
function resetRadioNR(radio) {
    if (!radio) return;
    resetNREngine(radio._nrEngine);
    // Clear the 4096-sample accumulator and output drain buffer
    if (radio._nrInBuf)  radio._nrInBuf.fill(0);
    radio._nrInCount   = 0;
    radio._nrOutBuf    = new Float32Array(0);
    radio._nrOutOffset = 0;
}

/**
 * Sync both NR UI surfaces (toolbar button + modal checkbox) to the current
 * nrGlobalEnabled state.  Safe to call at any time — missing elements are ignored.
 */
function syncNRUI() {
    const btn = document.getElementById('nrToggleBtn');
    if (btn) btn.textContent = `🎛️ NR: ${nrGlobalEnabled ? 'On' : 'Off'}`;

    const chk = document.getElementById('nrModalToggle');
    if (chk) chk.checked = nrGlobalEnabled;
}

/**
 * Enable or disable NR on all currently active radios.
 * When enabling, each radio's NR engine is flushed so it starts clean.
 * When disabling, engines are left intact (no CPU cost — onaudioprocess
 * passes audio through unchanged when eng.enabled is false).
 * Called by the toolbar button (via toggleNR) and the modal checkbox directly.
 */
function setNR(enabled) {
    nrGlobalEnabled = !!enabled;
    for (const radio of Object.values(activeRadios)) {
        if (!radio._nrEngine) continue;
        radio._nrEngine.enabled = nrGlobalEnabled;
        if (nrGlobalEnabled) {
            // Flush stale ring buffer so NR starts clean on the current source
            resetRadioNR(radio);
        }
    }
    syncNRUI();
}

/** Toggle NR on/off — called by the toolbar button. */
function toggleNR() {
    setNR(!nrGlobalEnabled);
}

window.setNR    = setNR;
window.toggleNR = toggleNR;

// ─── Initialisation ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Ask the receiver how far it tunes. Not awaited: the controls must be usable
    // immediately, and every one of them reads minFreqHz/maxFreqHz live rather than
    // caching a copy, so widening them when the answer lands needs no re-setup. The
    // frequency restoreFreqFromURL leaves unchecked is settled inside this call.
    loadTuningRange();
    restoreFreqFromURL();   // set slider/input BEFORE setupFrequencyControls reads slider.value
    syncModalityUI();       // sync Phone/CW button states after URL restore
    setupFrequencyControls();
    setupFilterListeners();
    requestUserLocation();  // non-blocking; updates map when resolved
    loadInstances();        // after load, restoreSelectionFromURL() is called inside
    // Note: initOutputDeviceSelector() is called inside startMonitoring(), not here

    // Wire up mode indicator click (more reliable than inline onclick in strict mode)
    const modeEl = document.getElementById('modeIndicator');
    if (modeEl) modeEl.addEventListener('click', cycleMode);

    // Populate the sessions quick-load dropdown from localStorage
    renderSessionsDropdown();

    // Wire up the in-modal frequency input
    const modalFreqInput = document.getElementById('snrModalFreqInput');
    if (modalFreqInput) {
        modalFreqInput.addEventListener('input', e => {
            const mhz = parseFloat(e.target.value);
            if (!isNaN(mhz) && freqInRangeMhz(mhz)) {
                e.target.classList.remove('invalid');
                // Mirror value into the main slider + input, then apply
                const slider  = document.getElementById('freqSlider');
                const mainInput = document.getElementById('freqInput');
                if (slider)    slider.value    = mhz;
                if (mainInput) mainInput.value = mhz.toFixed(6);
                // Reuse nudgeFreq logic by computing delta from current
                const deltaHz = Math.round(mhz * 1e6) - currentFreqHz;
                if (deltaHz !== 0) nudgeFreq(deltaHz);
            } else if (e.target.value !== '') {
                e.target.classList.add('invalid');
            }
        });
        // Commit on Enter
        modalFreqInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const mhz = parseFloat(e.target.value);
                if (!isNaN(mhz) && freqInRangeMhz(mhz)) {
                    const deltaHz = Math.round(mhz * 1e6) - currentFreqHz;
                    if (deltaHz !== 0) nudgeFreq(deltaHz);
                    e.target.blur();
                }
            }
        });
    }
});

// ─── User Location ────────────────────────────────────────────────────────────

/**
 * Request user location: browser geolocation first, /api/myip as fallback.
 * Non-blocking — updates the map marker once resolved.
 */
async function requestUserLocation() {
    // Always fetch IP-based location as fallback (runs in parallel)
    let ipLocation = null;
    try {
        const resp = await fetch('/api/myip');
        if (resp.ok) {
            const data = await resp.json();
            if (data.latitude != null && data.longitude != null) {
                ipLocation = { latitude: data.latitude, longitude: data.longitude };
            }
        }
    } catch (e) { /* ignore */ }

    // Try browser geolocation
    if (navigator.geolocation) {
        await new Promise(resolve => {
            navigator.geolocation.getCurrentPosition(
                position => {
                    userLocation = {
                        latitude:  position.coords.latitude,
                        longitude: position.coords.longitude
                    };
                    resolve();
                },
                () => {
                    // Denied or error — use IP fallback
                    if (ipLocation) userLocation = ipLocation;
                    resolve();
                },
                { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 }
            );
        });
    } else if (ipLocation) {
        userLocation = ipLocation;
    }

    if (userLocation && instanceMap) {
        placeUserMarker();
    }
}

/** Add or update the blue pulsing user location marker on the map. */
function placeUserMarker() {
    if (!instanceMap || !userLocation) return;

    if (userMarker) {
        instanceMap.removeLayer(userMarker);
        userMarker = null;
    }

    const html = `
        <div style="position:relative;">
            <div style="
                background:#3b82f6;width:16px;height:16px;border-radius:50%;
                border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);
            "></div>
            <div style="
                position:absolute;top:-4px;left:-4px;
                background:rgba(59,130,246,0.3);width:24px;height:24px;
                border-radius:50%;animation:pulse-ring 2s ease-out infinite;
            "></div>
        </div>`;

    userMarker = L.marker([userLocation.latitude, userLocation.longitude], {
        icon: L.divIcon({
            html,
            className: 'user-location-marker',
            iconSize:   [24, 24],
            iconAnchor: [12, 12]
        }),
        zIndexOffset: -1000,
        interactive: true
    })
    .bindTooltip('You', { direction: 'top', offset: [0, -14] })
    .addTo(instanceMap);

    // Update select-phase hover tooltips to include distance now that location is known
    if (!mapMonitorMode) {
        instanceMarkerById.forEach(({ marker, inst }) => {
            if (inst.latitude == null || inst.longitude == null) return;
            // Only update hover tooltips (non-selected); selected markers have permanent callsign-only tooltips
            if (selectedIds.has(inst.id)) return;
            const km = haversineKm(userLocation.latitude, userLocation.longitude, inst.latitude, inst.longitude);
            const distHtml = ` <span style="font-size:0.82em;font-weight:normal;opacity:0.8">${formatDistKm(km)}</span>`;
            marker.setTooltipContent(`<strong>${escHtml(inst.callsign)}</strong>${distHtml}<br>${escHtml(inst.location)}`);
        });
    }

    // Draw persistent lines for all monitored/selected instances now that location is known
    updateSelectedGeodesicLines();
}

// ─── URL State ───────────────────────────────────────────────────────────────

// localStorage key prefix — namespaced so other pages don't collide
const LS_KEY = 'mm_prefs';

/**
 * Persist current freq / modality / modeOverride / selectedIds to localStorage.
 * Called from updateURL() so every meaningful state change is captured.
 */
function savePrefs() {
    try {
        const prefs = {
            freq:         (currentFreqHz / 1e6).toFixed(6),
            modality:     modality,
            modeOverride: modeOverride || null,
            ids:          [...selectedIds],
        };
        localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch (e) { /* localStorage unavailable (private browsing, quota, etc.) */ }
}

/**
 * Load saved prefs from localStorage.
 * Returns an object with the same shape as savePrefs() writes, or null if nothing saved.
 */
function loadPrefs() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) { return null; }
}

/** Write current freq + modality + mode override + selected IDs into the URL. */
function updateURL() {
    // In follower mode, preserve the ?share= param so a page refresh re-joins the
    // same shared session.  Don't write freq/ids/smart — those are owned by the host.
    if (typeof isFollowerMode !== 'undefined' && isFollowerMode) {
        const existing = new URLSearchParams(location.search);
        const shareId  = existing.get('share');
        if (shareId) {
            // Keep only the share param — drop any freq/ids/smart that may have crept in
            history.replaceState(null, '', `?share=${encodeURIComponent(shareId)}`);
        }
        savePrefs();
        return;
    }

    const params = new URLSearchParams();
    const mhz = currentFreqHz / 1e6;
    params.set('freq', mhz.toFixed(6));
    if (modality === 'cw') params.set('modality', 'cw');
    // Persist a user-forced sideband override so bookmarks restore exactly
    if (modeOverride) params.set('mode', modeOverride);
    if (selectedIds.size > 0) {
        params.set('ids', [...selectedIds].join(','));
    }
    // Persist Smart Listen modal open state
    const modalOpen = document.getElementById('snrModalOverlay')?.classList.contains('open');
    if (modalOpen) params.set('smart', '1');
    history.replaceState(null, '', `?${params.toString()}`);
    savePrefs();
    // Notify shared session followers of freq/mode change (owner only, debounced)
    // isOwnerMode and scheduleSharedSessionUpdate are defined in shared_session.js
    if (typeof isOwnerMode !== 'undefined' && isOwnerMode &&
        typeof scheduleSharedSessionUpdate === 'function') {
        scheduleSharedSessionUpdate();
    }
}

/** Restore frequency, modality and mode override from URL params, falling back to localStorage. */
function restoreFreqFromURL() {
    const params = new URLSearchParams(location.search);
    const validModes = ['usb', 'lsb', 'cwu', 'cwl'];

    // Determine source: URL params take priority over localStorage
    const prefs = loadPrefs();
    const urlFreq     = params.get('freq');
    const urlModality = params.get('modality');
    const urlMode     = params.get('mode');

    // Resolve values: URL → localStorage → built-in defaults
    const freqStr    = urlFreq     ?? prefs?.freq         ?? null;
    const modalityIn = urlModality ?? prefs?.modality      ?? null;
    const modeIn     = urlMode     ?? prefs?.modeOverride  ?? null;

    // Restore modality first (needed by resolveMode)
    if (modalityIn === 'cw') modality = 'cw';

    // Restore explicit mode override (e.g. user forced LSB on 20m)
    if (modeIn && validModes.includes(modeIn)) {
        modeOverride = modeIn;
    }

    // Deliberately not bounded against the receiver's range here.
    //
    // This runs from DOMContentLoaded, before /api/description has answered, so the only
    // range available at this point is the fallback. It used to test `freq <= 30` and
    // drop anything above outright — which meant a 6 m share link, or a saved preference
    // from a wider receiver, was thrown away and replaced with 14.1 MHz before the real
    // range was ever known. That is lossy: the frequency the link existed to convey is
    // gone by the time anything could have validated it properly.
    //
    // So an out-of-range value is left in place and checked once, in
    // revalidateFrequency(), after the range lands.
    const freq = parseFloat(freqStr);
    if (!isNaN(freq) && freq > 0) {
        const slider  = document.getElementById('freqSlider');
        const input   = document.getElementById('freqInput');
        if (slider) slider.value = freq;
        if (input)  input.value  = freq.toFixed(6);
        currentFreqHz = Math.round(freq * 1e6);
        currentMode   = resolveMode(freq);  // respects modeOverride if set
        const display = document.getElementById('freqDisplay');
        const modeEl  = document.getElementById('modeIndicator');
        if (display) display.textContent = `${freq.toFixed(6)} MHz`;
        if (modeEl) {
            modeEl.textContent = currentMode.toUpperCase();
            modeEl.classList.toggle('overridden', modeOverride !== null);
            if (modeOverride) {
                modeEl.title = 'Click to toggle sideband (overridden — click again to cycle)';
            }
        }
    }
}

// Tracks whether ?smart=1 was in the URL so resumeSession() can reopen the modal
let _resumeWithSmart = false;

/**
 * Restore selected instance IDs from URL params, falling back to localStorage.
 * Instead of auto-starting monitoring, shows a resume banner so the user can
 * confirm before connecting. The instances are pre-selected in the grid.
 */
function restoreSelectionFromURL() {
    const params = new URLSearchParams(location.search);

    // If a share link is present, the follower/owner join flow handles everything —
    // don't show the resume banner which would call startMonitoring() directly.
    if (params.get('share')) return;

    const prefs  = loadPrefs();

    // URL ?ids= takes priority; fall back to localStorage saved IDs
    const idsParam = params.get('ids') ?? (prefs?.ids?.length ? prefs.ids.join(',') : null);
    if (!idsParam) return;

    const ids = idsParam.split(',').filter(Boolean);
    if (ids.length === 0) return;

    // Select valid IDs that exist in allInstances
    for (const id of ids) {
        const inst = allInstances.find(i => i.id === id);
        if (inst && selectedIds.size < MAX_SELECTED) {
            selectedIds.add(id);
        }
    }

    if (selectedIds.size > 0) {
        renderSelectGrid();
        updateSelectCount();
        _resumeWithSmart = params.get('smart') === '1';
        showResumeBanner();
    }
}

/**
 * General-purpose confirm overlay — repurposes the resume banner modal.
 * All callers that need a non-blocking confirmation use this instead of
 * native confirm() / alert() so audio is never stalled.
 *
 * @param {object} opts
 *   icon        {string}   Emoji shown at top (default '📡')
 *   title       {string}   Bold heading
 *   desc        {string}   Body text
 *   confirmText {string}   Primary button label
 *   confirmCls  {string}   Extra CSS class for primary button (default 'btn-primary')
 *   cancelText  {string}   Secondary button label (default '✕ Dismiss')
 *   onConfirm   {Function} Called when primary button is clicked
 *   onCancel    {Function} Called when secondary button is clicked (optional)
 */
function showConfirmOverlay({ icon = '📡', title, desc, confirmText, confirmCls = 'btn-primary', cancelText = '✕ Dismiss', onConfirm, onCancel } = {}) {
    const banner      = document.getElementById('resumeBanner');
    const iconEl      = document.getElementById('resumeBannerIcon');
    const titleEl     = document.getElementById('resumeBannerTitle');
    const textEl      = document.getElementById('resumeBannerText');
    const confirmBtn  = document.getElementById('resumeBannerConfirmBtn');
    const cancelBtn   = document.getElementById('resumeBannerCancelBtn');
    if (!banner) return;

    if (iconEl)  iconEl.textContent  = icon;
    if (titleEl) titleEl.textContent = title  || '';
    if (textEl)  textEl.textContent  = desc   || '';

    if (confirmBtn) {
        confirmBtn.textContent = confirmText || '▶ Continue';
        confirmBtn.className   = `btn ${confirmCls}`;
        confirmBtn.style.padding = '8px 22px';
        confirmBtn.onclick = () => {
            banner.classList.remove('open');
            _restoreResumeBannerDefaults();
            if (onConfirm) onConfirm();
        };
    }
    if (cancelBtn) {
        cancelBtn.textContent = cancelText;
        cancelBtn.className   = 'btn btn-secondary';
        cancelBtn.style.padding = '8px 16px';
        cancelBtn.onclick = () => {
            banner.classList.remove('open');
            _restoreResumeBannerDefaults();
            if (onCancel) onCancel();
        };
    }

    banner.classList.add('open');
}

/** Restore the resume banner to its default resume-session wiring after any overlay use. */
function _restoreResumeBannerDefaults() {
    const iconEl     = document.getElementById('resumeBannerIcon');
    const titleEl    = document.getElementById('resumeBannerTitle');
    const confirmBtn = document.getElementById('resumeBannerConfirmBtn');
    const cancelBtn  = document.getElementById('resumeBannerCancelBtn');
    if (iconEl)     iconEl.textContent    = '📡';
    if (titleEl)    titleEl.textContent   = 'Resume Previous Session?';
    if (confirmBtn) {
        confirmBtn.textContent  = '▶ Start Monitoring';
        confirmBtn.className    = 'btn btn-primary';
        confirmBtn.style.padding = '8px 22px';
        confirmBtn.onclick      = resumeSession;
    }
    if (cancelBtn) {
        cancelBtn.textContent  = '✕ Dismiss';
        cancelBtn.className    = 'btn btn-secondary';
        cancelBtn.style.padding = '8px 16px';
        cancelBtn.onclick      = dismissResumeBanner;
    }
}

/** Show the resume overlay with a summary of the restored session. */
function showResumeBanner() {
    const banner  = document.getElementById('resumeBanner');
    const textEl  = document.getElementById('resumeBannerText');
    if (!banner || !textEl) return;

    const n    = selectedIds.size;
    const mhz  = (currentFreqHz / 1e6).toFixed(3).replace(/\.?0+$/, '');
    const mode = currentMode.toUpperCase();
    textEl.textContent = `${n} instance${n !== 1 ? 's' : ''} · ${mhz} MHz · ${mode}`;
    // Ensure defaults are wired before opening (in case a previous overlay left custom handlers)
    _restoreResumeBannerDefaults();
    banner.classList.add('open');
}

/** Start monitoring when the user confirms via the resume banner. */
async function resumeSession() {
    dismissResumeBanner();
    // In follower mode, use relay-based monitoring (no direct SDR connections)
    if (typeof isFollowerMode !== 'undefined' && isFollowerMode) {
        await startMonitoringFollower();
    } else {
        await startMonitoring();
    }
    if (_resumeWithSmart) {
        setTimeout(() => openSnrHistoryModal(), 800);
        _resumeWithSmart = false;
    }
}

/** Dismiss the resume overlay without starting monitoring. */
function dismissResumeBanner() {
    const banner = document.getElementById('resumeBanner');
    if (banner) banner.classList.remove('open');
    _restoreResumeBannerDefaults();
}

/**
 * Intercept "← Back to Selection" when the owner is actively sharing.
 * Shows a non-blocking warning overlay so the user can confirm before
 * the relay is torn down and followers lose audio.
 * Falls through to stopMonitoring() immediately when not sharing.
 */
function confirmStopMonitoring() {
    const sharing = typeof isOwnerMode !== 'undefined' && isOwnerMode;
    if (!sharing) { stopMonitoring(); return; }
    showConfirmOverlay({
        icon:        '🔗',
        title:       'You\'re currently sharing',
        desc:        'Going back to selection will stop the relay and disconnect all listeners.',
        confirmText: '🛑 Stop Sharing & Go Back',
        confirmCls:  'btn-danger',
        cancelText:  'Keep Sharing',
        onConfirm:   () => stopMonitoring(),
    });
}

/**
 * Intercept same-tab navigation (e.g. 🏠 Instances link) when the owner
 * is actively sharing in monitor mode.
 * Falls through to immediate navigation when not sharing.
 * @param {string} url  Destination URL
 */
function confirmNavAway(url) {
    const sharing    = typeof isOwnerMode !== 'undefined' && isOwnerMode;
    const monitoring = document.getElementById('phase-monitor')?.style.display !== 'none';
    if (!sharing || !monitoring) { location.href = url; return; }
    showConfirmOverlay({
        icon:        '🔗',
        title:       'You\'re currently sharing',
        desc:        'Navigating away will stop the relay and disconnect all listeners.',
        confirmText: '🛑 Stop Sharing & Leave',
        confirmCls:  'btn-danger',
        cancelText:  'Keep Sharing',
        onConfirm:   () => { location.href = url; },
    });
}

window.resumeSession        = resumeSession;
window.dismissResumeBanner  = dismissResumeBanner;
window.confirmStopMonitoring = confirmStopMonitoring;
window.confirmNavAway        = confirmNavAway;

// ─── API ─────────────────────────────────────────────────────────────────────

async function loadInstances() {
    setStatus('Loading instances…', 'loading');
    try {
        const resp = await fetch('/api/instances?conditions=true&online_only=false');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        allInstances = data.instances || [];
        applyFilters();
        // Status is updated by applyFilters() after filtering
        restoreSelectionFromURL(); // restore selected IDs now that allInstances is populated
    } catch (err) {
        setStatus(`Failed to load instances: ${err.message}`, 'error');
    } finally {
        // Signal that allInstances is ready (even if empty due to error) so that
        // startMonitoringFollower() doesn't wait forever on a failed fetch.
        if (_instancesReadyResolve) { _instancesReadyResolve(); _instancesReadyResolve = null; }
    }
}

// ─── Filtering & Selection Phase ─────────────────────────────────────────────

function getBandForFreq(mhz) {
    for (const [band, range] of Object.entries(BAND_RANGES)) {
        if (mhz >= range.min && mhz <= range.max) return band;
    }
    return null;
}

function updateBandFilterUI() {
    const mhz  = currentFreqHz / 1e6;
    const band = getBandForFreq(mhz);
    const label = document.getElementById('bandFilterLabel');
    const radios = document.querySelectorAll('input[name="bandQuality"]');

    if (band) {
        if (label) label.textContent = `${band} quality:`;
        radios.forEach(r => { r.disabled = false; r.closest('label').style.opacity = '1'; });
    } else {
        if (label) label.textContent = 'Band quality (no band at this frequency):';
        radios.forEach(r => {
            r.disabled = true;
            r.closest('label').style.opacity = '0.4';
            if (r.value === '') r.checked = true; // reset to Any
        });
        currentBandFilter = '';
    }

    // Highlight the active band jump button
    document.querySelectorAll('.band-jump-btn').forEach(btn => {
        btn.classList.toggle('active-band', btn.textContent.trim() === band);
    });

    applyFilters();
}

function applyFilters() {
    const search      = document.getElementById('selectSearch').value.trim().toLowerCase();
    const onlineOnly  = true; // Always show online instances only
    const audioOnly   = true; // Audio (TLS) is always required

    const mhz  = currentFreqHz / 1e6;
    const band = getBandForFreq(mhz);
    const minSnr = currentBandFilter ? BAND_QUALITY_SNR[currentBandFilter] : null;

    filteredInstances = allInstances.filter(inst => {
        if (onlineOnly && !inst.is_online) return false;
        if (audioOnly  && !inst.tls)       return false;
        if (search) {
            const hay = `${inst.callsign} ${inst.name} ${inst.location}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        // Band quality filter — only apply if a band is detected and filter is set
        if (band && minSnr !== null && inst.band_conditions) {
            const snr = inst.band_conditions[band];
            if (snr === null || snr === undefined || snr < minSnr) return false;
        }
        return true;
    });

    // Deselect any instances that are no longer visible after filtering
    const filteredIds = new Set(filteredInstances.map(i => i.id));
    let selectionChanged = false;
    for (const id of [...selectedIds]) {
        if (!filteredIds.has(id)) {
            selectedIds.delete(id);
            selectionChanged = true;
        }
    }
    if (selectionChanged) {
        updateSelectCount();
        refreshMapSelection();
        updateURL();
    }

    renderSelectGrid();
    setStatus(`${filteredInstances.length} audio-capable online instance${filteredInstances.length !== 1 ? 's' : ''} available`, 'success');
}

function setupFilterListeners() {
    document.getElementById('selectSearch').addEventListener('input', applyFilters);
    document.querySelectorAll('input[name="bandQuality"]').forEach(r => {
        r.addEventListener('change', e => {
            currentBandFilter = e.target.value;
            applyFilters();
        });
    });
}

function renderSelectGrid() {
    const grid = document.getElementById('selectGrid');

    if (filteredInstances.length === 0) {
        grid.innerHTML = '<div class="no-instances">No instances match the current filters.</div>';
        updateSelectCount();
        return;
    }

    // Sort each group by selectSortKey, then selected instances float to the top
    const sortGroup = arr => {
        const copy = [...arr];
        switch (selectSortKey) {
            case 'snr':
                copy.sort((a, b) => {
                    const sa = (a.avg_band_snr != null) ? a.avg_band_snr : -Infinity;
                    const sb = (b.avg_band_snr != null) ? b.avg_band_snr : -Infinity;
                    return sb - sa;
                });
                break;
            case 'listeners':
                copy.sort((a, b) => {
                    const aUsers = (a.max_clients ?? 0) - (a.available_clients ?? 0);
                    const bUsers = (b.max_clients ?? 0) - (b.available_clients ?? 0);
                    const diff = bUsers - aUsers;
                    if (diff !== 0) return diff;
                    return (b.max_clients ?? 0) - (a.max_clients ?? 0);
                });
                break;
            case 'callsign':
                copy.sort((a, b) => (a.callsign || '').localeCompare(b.callsign || ''));
                break;
        }
        return copy;
    };

    const sorted = [
        ...sortGroup(filteredInstances.filter(i => selectedIds.has(i.id))),
        ...sortGroup(filteredInstances.filter(i => !selectedIds.has(i.id))),
    ];
    grid.innerHTML = sorted.map(inst => buildSelectCard(inst)).join('');

    // Attach click handlers
    grid.querySelectorAll('.select-card').forEach(card => {
        card.addEventListener('click', () => toggleSelect(card.dataset.id));
    });

    updateSelectCount();
    // Don't touch the map if we're already in monitor mode
    if (!mapMonitorMode) {
        updateMap(filteredInstances);
        attachMapHoverHandlers(grid);
    }
    // Ensure freshly-rendered Open SDR links have freq/mode/bw params
    updateSdrLinks();
}

function applySelectSort(key) {
    selectSortKey = key;
    document.querySelectorAll('.select-sort-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sort === key);
    });
    renderSelectGrid();
}

function buildSelectCard(inst) {
    const isSelected   = selectedIds.has(inst.id);
    const isOnline     = inst.is_online;
    const hasAudio     = inst.tls;
    const isFull       = !isSelected && (inst.available_clients !== undefined && inst.available_clients <= 0);
    const isMaxed      = !isSelected && !isFull && selectedIds.size >= MAX_SELECTED;
    const isPreviewing = previewId === inst.id;

    // Band condition dots (or SNR meter when previewing)
    let dotsHtml = '';
    if (isPreviewing) {
        dotsHtml = `<div class="preview-snr-track"><div class="preview-snr-fill" id="preview-fill-${inst.id}"></div></div>`;
    } else if (inst.band_conditions) {
        dotsHtml = BANDS.map(band => {
            const snr = inst.band_conditions[band];
            const cls = snrClass(snr);
            return `<div class="band-dot ${cls}" title="${band}: ${snr !== null && snr !== undefined ? snr.toFixed(1) + ' dB' : 'N/A'}"></div>`;
        }).join('');
    }

    const flagHtml = countryFlag(inst.country_code)
        ? `<span class="flag" title="${escHtml(inst.country_name || inst.country_code)}">${countryFlag(inst.country_code)}</span>`
        : '';

    const slots = `${inst.available_clients}/${inst.max_clients}`;

    const distHtml = (userLocation && inst.latitude != null && inst.longitude != null)
        ? `<span style="font-size:0.78em; font-weight:normal; opacity:0.65; margin-left:6px;">${formatDistKm(haversineKm(userLocation.latitude, userLocation.longitude, inst.latitude, inst.longitude))}</span>`
        : '';

    const previewBtn = (isOnline && hasAudio)
        ? `<button class="select-preview-btn${isPreviewing ? ' active' : ''}"
                   data-id="${inst.id}"
                   title="${isPreviewing ? 'Stop preview' : 'Preview audio'}"
                   onclick="event.stopPropagation(); toggleSelectPreview('${inst.id}')">
               ${isPreviewing ? '🔊' : '🔈'}
           </button>`
        : '';

    // Build the Open SDR link (same class as monitor tiles so updateSdrLinks() keeps it fresh)
    const openSdrBadge = isOnline && inst.public_url
        ? `<a href="${escHtml(inst.public_url)}"
              data-base-url="${escHtml(inst.public_url)}"
              target="_blank"
              class="status-badge open-sdr-badge meter-connect-link"
              onclick="event.stopPropagation(); stopSelectPreview();">Open SDR</a>`
        : `<span class="status-badge offline">○ Offline</span>`;

    return `
        <div class="select-card ${isSelected ? 'selected' : ''} ${!isOnline ? 'offline' : ''} ${isMaxed ? 'maxed' : ''} ${isFull ? 'full' : ''}"
             data-id="${inst.id}">
            <div class="select-card-check">${isSelected ? '✓' : ''}</div>
            <div class="select-card-callsign">${flagHtml} ${escHtml(inst.callsign)}${distHtml}</div>
            <div class="select-card-name">${escHtml(inst.location)}</div>
            <div class="select-card-meta">
                ${openSdrBadge}
                <span class="status-badge slots">👥 ${slots}</span>
                ${isFull ? '<span class="status-badge full-badge">Full</span>' : ''}
                ${!hasAudio ? '<span class="status-badge no-audio">No Audio</span>' : ''}
            </div>
            ${dotsHtml ? `<div class="band-dots">${dotsHtml}</div>` : ''}
            ${previewBtn}
        </div>
    `;
}

function toggleSelect(id) {
    if (selectedIds.has(id)) {
        selectedIds.delete(id);
    } else {
        if (selectedIds.size >= MAX_SELECTED) return; // Enforce max limit
        const inst = allInstances.find(i => i.id === id);
        if (inst && inst.available_clients !== undefined && inst.available_clients <= 0) return; // Full instance
        selectedIds.add(id);
    }
    renderSelectGrid();
    refreshMapSelection(); // Update marker highlight without rebuilding map
    updateURL();
}

function updateSelectCount() {
    const n = selectedIds.size;
    const atLimit = n >= MAX_SELECTED;
    document.getElementById('selectCount').textContent =
        atLimit ? `${n} / ${MAX_SELECTED} selected (max)` : `${n} / ${MAX_SELECTED} selected`;
    const btn = document.getElementById('startMonitorBtn');
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `📡 Start Monitoring ${n} Instance${n !== 1 ? 's' : ''}` : '📡 Start Monitoring';
}

function clearSelection() {
    selectedIds.clear();
    renderSelectGrid();
    refreshMapSelection();
    updateURL();
}

// Make globally accessible for onclick attributes
window.clearSelection = clearSelection;

// ─── Refresh Instances ────────────────────────────────────────────────────────

async function refreshInstances() {
    const btn = document.getElementById('refreshBtn');
    const icon = btn && btn.querySelector('i');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.6';
        if (icon) icon.classList.add('fa-spin');
    }
    try {
        const resp = await fetch('/api/instances?conditions=true&online_only=false');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        allInstances = data.instances || [];
        applyFilters();
    } catch (err) {
        setStatus(`Failed to refresh instances: ${err.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '';
            if (icon) icon.classList.remove('fa-spin');
        }
    }
}

window.refreshInstances = refreshInstances;

// ─── Select-Phase Audio Preview ───────────────────────────────────────────────

/**
 * Stop any active select-phase preview and reset state.
 * Safe to call even when nothing is playing.
 */
async function stopSelectPreview() {
    if (!previewRadio) return;
    const stoppedId = previewId;

    // Stop the meter interval
    if (previewMeterTimer) {
        clearInterval(previewMeterTimer);
        previewMeterTimer = null;
    }

    previewRadio.stopPreview().catch(() => {});
    previewRadio = null;
    previewId    = null;

    // Refresh the card button and marker icon for the stopped instance
    if (stoppedId) {
        refreshMapSelection();
        const card = document.querySelector(`#selectGrid .select-card[data-id="${CSS.escape(stoppedId)}"]`);
        if (card) {
            // Restore button
            const btn = card.querySelector('.select-preview-btn');
            if (btn) { btn.textContent = '🔈'; btn.classList.remove('active'); btn.title = 'Preview audio'; }
            // Restore band dots
            const dotsDiv = card.querySelector('.band-dots');
            if (dotsDiv) {
                const inst = allInstances.find(i => i.id === stoppedId);
                if (inst && inst.band_conditions) {
                    dotsDiv.innerHTML = BANDS.map(band => {
                        const snr = inst.band_conditions[band];
                        const cls = snrClass(snr);
                        return `<div class="band-dot ${cls}" title="${band}: ${snr !== null && snr !== undefined ? snr.toFixed(1) + ' dB' : 'N/A'}"></div>`;
                    }).join('');
                } else {
                    dotsDiv.innerHTML = '';
                }
            }
        }
    }
}

/**
 * Start the live SNR meter for the currently previewing instance.
 * Updates the .preview-snr-fill bar at 100ms intervals.
 */
function startPreviewMeter(id) {
    if (previewMeterTimer) clearInterval(previewMeterTimer);
    previewMeterTimer = setInterval(() => {
        if (!previewRadio) { clearInterval(previewMeterTimer); previewMeterTimer = null; return; }
        const fill = document.getElementById(`preview-fill-${id}`);
        if (!fill) return;
        const snr = previewRadio.signalSNR;
        if (snr === null || snr === undefined) {
            fill.style.width = '0%';
            fill.style.background = '#6b7280';
        } else {
            const pct = Math.max(0, Math.min(100, ((snr - SNR_MIN_DB) / (SNR_MAX_DB - SNR_MIN_DB)) * 100));
            fill.style.width = pct + '%';
            fill.style.background = monitorSnrColor(snr);
        }
    }, 100);
}

/**
 * Toggle select-phase audio preview for the given instance ID.
 * Only one preview plays at a time; clicking the same instance stops it.
 */
async function toggleSelectPreview(id) {
    // Clicking the active preview → stop it
    if (previewId === id) {
        await stopSelectPreview();
        return;
    }

    // Stop any existing preview first
    await stopSelectPreview();

    const inst = allInstances.find(i => i.id === id);
    if (!inst || !inst.is_online || !inst.tls) return;

    try {
        const radio = new MinimalRadio(null, inst.public_url,
            MinimalRadio.protocolVersionFor(inst.version));
        // Suppress the floating signal bar
        radio.startSignalBarUpdates = () => {};
        radio.stopSignalBarUpdates  = () => {};

        // Route audio to the user-selected output device (if supported)
        patchRadioOutputDevice(radio);

        // The preview only exists while the user is listening to it, so it
        // connects unmuted — this is here for PTT mute, which zeroes its volume.
        attachServerMuteSync(radio);

        await radio.startPreview(currentFreqHz, currentMode);

        // Set bandwidth
        if (currentMode === 'lsb') {
            radio.bandwidthLow  = -2700;
            radio.bandwidthHigh = -50;
        } else {
            radio.bandwidthLow  = 50;
            radio.bandwidthHigh = 2700;
        }
        sendTune(radio);

        previewRadio = radio;
        previewId    = id;

        // Update button to active state and swap dots → meter
        const card = document.querySelector(`#selectGrid .select-card[data-id="${CSS.escape(id)}"]`);
        if (card) {
            const btn = card.querySelector('.select-preview-btn');
            if (btn) { btn.textContent = '🔊'; btn.classList.add('active'); btn.title = 'Stop preview'; }
            // Replace band dots with SNR meter track
            const dotsDiv = card.querySelector('.band-dots');
            if (dotsDiv) {
                dotsDiv.innerHTML = `<div class="preview-snr-track"><div class="preview-snr-fill" id="preview-fill-${id}"></div></div>`;
            }
        }

        // Start live SNR meter updates
        startPreviewMeter(id);

        // Update marker icon to show speaker badge
        refreshMapSelection();

    } catch (err) {
        console.error(`Preview failed for ${inst.callsign}:`, err);
        previewRadio = null;
        previewId    = null;
    }
}

// Make globally accessible for onclick attributes in card HTML
window.toggleSelectPreview = toggleSelectPreview;

// ─── Monitoring Phase ─────────────────────────────────────────────────────────

async function startMonitoring() {
    if (selectedIds.size === 0) return;

    // Always dismiss the resume banner when monitoring starts (whether via banner or toolbar)
    dismissResumeBanner();

    // Reset play-best to enabled at the start of each new monitoring session
    playBestEnabled = true;
    const pbCb = document.getElementById('snrPlayBestToggle');
    if (pbCb) pbCb.checked = true;

    // Stop any select-phase preview before entering monitor mode
    await stopSelectPreview();

    // Initialise audio output device selector now that the user has interacted.
    // This also requests microphone permission so device labels are populated.
    initOutputDeviceSelector(); // intentionally not awaited — runs in background

    // Switch phase
    document.getElementById('phase-select').style.display         = 'none';
    document.getElementById('phase-monitor').style.display        = 'block';
    document.getElementById('monitor-toolbar-panel').style.display = 'block';
    document.getElementById('band-filter-panel').style.display    = 'none';

    const chosen = allInstances.filter(inst => selectedIds.has(inst.id));

    // Update map to show only chosen instances (monitor mode: permanent tooltips + SNR colours)
    updateMap(chosen, true);

    // Build meter tiles
    renderMonitorGrid(chosen);

    // Connect all radios
    for (const inst of chosen) {
        connectInstance(inst);
    }

    // Start meter refresh loop
    meterUpdateTimer = setInterval(refreshAllMeters, METER_UPDATE_INTERVAL);
}

window.startMonitoring = startMonitoring;

/**
 * Show a non-blocking toast notification.
 * @param {string} message  Text to display
 * @param {'error'|'warn'|'info'} [type='error']  Visual style
 * @param {number} [duration=5000]  Auto-dismiss after ms
 */
function showToast(message, type = 'error', duration = 5000) {
    const container = document.getElementById('toastContainer');
    if (!container) { console.warn(message); return; }
    const toast = document.createElement('div');
    toast.className = `toast${type === 'warn' ? ' toast-warn' : type === 'info' ? ' toast-info' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    // Trigger animation
    requestAnimationFrame(() => {
        requestAnimationFrame(() => toast.classList.add('toast-show'));
    });
    // Auto-dismiss
    setTimeout(() => {
        toast.classList.remove('toast-show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
window.showToast = showToast;

/**
 * Returns the panValue of an active radio, or null if not found.
 * Exposed so shared_session.js can check pan state without direct activeRadios access.
 */
function getActiveRadioPanValue(instanceId) {
    const radio = activeRadios[instanceId];
    return radio ? radio.panValue : null;
}
window.getActiveRadioPanValue = getActiveRadioPanValue;

/**
 * Attach or detach the relay upstream onAudioFrame callback on all active radios.
 * Called by shared_session.js when the owner creates/resumes/stops a shared session.
 * @param {object|null} relayUpstream  RelayUpstream instance, or null to detach
 */
function attachRelayCallbacksToActiveRadios(relayUpstream) {
    const ids = Object.keys(activeRadios);
    console.log(`[Relay] attachRelayCallbacksToActiveRadios: ${relayUpstream ? 'attaching' : 'detaching'} callbacks on ${ids.length} radio(s):`, ids);
    for (const [instId, radio] of Object.entries(activeRadios)) {
        if (relayUpstream) {
            const capturedId = instId;
            radio.onAudioFrame = (sr, ch, bp, nd, opus) => {
                relayUpstream.sendAudio(capturedId, sr, ch, bp, nd, opus);
            };
        } else {
            radio.onAudioFrame = null;
        }
        // Followers pick what they listen to for themselves, so relaying counts
        // as listening: everything stays unmuted for the life of the share and
        // drops back to volume-driven muting when it ends.
        syncServerMute(radio);
    }
}

window.attachRelayCallbacksToActiveRadios = attachRelayCallbacksToActiveRadios;

// ─── Follower Monitoring ──────────────────────────────────────────────────────

/**
 * Start monitoring in follower mode: build tiles for all instances in the
 * shared session but do NOT create MinimalRadio connections.  Signal data
 * and audio arrive via the FollowerRelay WebSocket instead.
 */
async function startMonitoringFollower() {
    // Stop any select-phase preview
    await stopSelectPreview();

    // Wait for allInstances to be populated before filtering.
    // There is a race: the follower join flow can fire before loadInstances() completes.
    await _instancesReady;

    // Switch phase
    document.getElementById('phase-select').style.display         = 'none';
    document.getElementById('phase-monitor').style.display        = 'block';
    document.getElementById('monitor-toolbar-panel').style.display = 'block';
    document.getElementById('band-filter-panel').style.display    = 'none';

    // Build the list of instances to show tiles for.
    // Prefer full instance objects from allInstances; fall back to minimal stubs
    // for any IDs that aren't in allInstances (e.g. offline, or API not yet loaded).
    const chosen = [];
    for (const id of selectedIds) {
        const inst = allInstances.find(i => i.id === id);
        if (inst) {
            chosen.push(inst);
        } else {
            // Stub — relay will provide signal data; callsign shown as truncated ID
            chosen.push({ id, callsign: id.slice(0, 8), is_online: true, tls: false, location: '', public_url: '' });
        }
    }

    // Update map
    updateMap(chosen, true);

    // Build tiles (same HTML, but we'll override the initial state below)
    renderMonitorGrid(chosen);

    // Override initial tile state: "Waiting for relay…" (amber pulse dot)
    // and hide the "Open SDR" link since followers don't connect directly.
    for (const inst of chosen) {
        setTileConnState(inst.id, 'relay-waiting');
        const link = document.querySelector(`#tile-${inst.id} .meter-connect-link`);
        if (link) link.style.display = 'none';
    }

    // Start meter refresh loop (handles countdowns; signal updates come via updateMeterTileSignal)
    meterUpdateTimer = setInterval(refreshAllMeters, METER_UPDATE_INTERVAL);
}

window.startMonitoringFollower = startMonitoringFollower;

/**
 * Update a follower tile's signal bar, dBFS and SNR display from relay frame data.
 * Called by FollowerRelay._handleBinaryFrame() in shared_session.js.
 *
 * @param {string} instanceId
 * @param {number} basebandPower  dBFS float
 * @param {number} noisePower     dBFS float, over the same passband
 * @param {number} snr            dB float (basebandPower - noisePower)
 */
// Throttle timestamps for relay signal history (instanceId → last push time ms)
// Relay frames arrive at ~50 Hz; we only push one history sample per METER_UPDATE_INTERVAL.
const _relaySignalLastPush = {};

function updateMeterTileSignal(instanceId, basebandPower, noisePower, snr) {
    const bar    = document.getElementById(`bar-${instanceId}`);
    const dbfsEl = document.getElementById(`dbfs-${instanceId}`);
    const snrEl  = document.getElementById(`snr-${instanceId}`);
    if (!bar || !dbfsEl || !snrEl) return;

    const isSnrMode = chartMode[instanceId] === 'snr';

    if (isSnrMode && snr !== null && !isNaN(snr)) {
        const pct = Math.max(0, Math.min(100, ((snr - SNR_MIN_DB) / (SNR_MAX_DB - SNR_MIN_DB)) * 100));
        bar.style.width = pct + '%';
        bar.style.background = snr >= SNR_GREEN_DB
            ? 'linear-gradient(90deg, #22c55e 0%, #4ade80 100%)'
            : snr >= SNR_AMBER_DB
                ? 'linear-gradient(90deg, #fbbf24 0%, #fcd34d 100%)'
                : 'linear-gradient(90deg, #ef4444 0%, #f87171 100%)';
    } else {
        const dbfs = basebandPower;
        const pct = Math.max(0, Math.min(100,
            ((dbfs - SIG_MIN_DB) / (SIG_MAX_DB - SIG_MIN_DB)) * 100
        ));
        bar.style.width = pct + '%';
        bar.style.background = dbfs > -60
            ? 'linear-gradient(90deg, #22c55e 0%, #4ade80 100%)'
            : dbfs > -90
                ? 'linear-gradient(90deg, #fbbf24 0%, #fcd34d 100%)'
                : 'linear-gradient(90deg, #ef4444 0%, #f87171 100%)';
    }

    // Update map marker colour
    updateMarkerSignalColor(instanceId, snr);

    dbfsEl.textContent = `${basebandPower.toFixed(1)} dBFS`;
    snrEl.textContent  = snr !== null && !isNaN(snr) ? `SNR: ${snr.toFixed(1)} dB` : 'SNR: --';

    // Cache per-instance signal for the chrome extension bridge in follower mode.
    // The bridge interval picks the best SNR across all instances every 500 ms.
    if (typeof isFollowerMode !== 'undefined' && isFollowerMode) {
        if (!window._followerSignalCache) window._followerSignalCache = {};
        window._followerSignalCache[instanceId] = {
            power: basebandPower,
            noisePower: (snr !== null && !isNaN(snr)) ? basebandPower - snr : null,
            snr: (snr !== null && !isNaN(snr)) ? snr : null,
        };
    }

    // Throttle history pushes to METER_UPDATE_INTERVAL (100ms).
    // Relay frames arrive at ~50 Hz but the ring buffer expects one sample per 100ms
    // for a 10-second / 100-sample window — same rate as refreshAllMeters() for owners.
    const _now = Date.now();
    const _lastPush = _relaySignalLastPush[instanceId] || 0;
    if (_now - _lastPush < METER_UPDATE_INTERVAL) return;
    _relaySignalLastPush[instanceId] = _now;

    // Push into history ring buffers for sparkline chart
    if (signalHistory[instanceId]) {
        const idx = historyIndex[instanceId];
        signalHistory[instanceId][idx] = basebandPower;
        snrHistory[instanceId][idx]    = snr;
        if (historyTime[instanceId]) historyTime[instanceId][idx] = performance.now();
        historyIndex[instanceId] = (idx + 1) % HISTORY_SAMPLES;

        const chart = signalCharts[instanceId];
        if (chart) {
            const history = chartMode[instanceId] === 'snr' ? snrHistory[instanceId] : signalHistory[instanceId];
            const ordered = [];
            for (let i = 0; i < HISTORY_SAMPLES; i++) {
                ordered.push(history[(historyIndex[instanceId] + i) % HISTORY_SAMPLES]);
            }
            chart.data.datasets[0].data = ordered;
            chart.update('none');
        }
    }
}

window.updateMeterTileSignal = updateMeterTileSignal;

/**
 * Called by FollowerRelay._handleRelayState() when the relay_state control message arrives.
 * Updates tile connection states and enables channel buttons when the owner is connected.
 *
 * @param {boolean} ownerConnected  Whether the owner WebSocket is currently connected
 * @param {string[]} instanceIds    List of instance IDs in the relay stream
 */
function updateRelayTileOwnerState(ownerConnected, instanceIds) {
    for (const id of instanceIds) {
        if (ownerConnected) {
            setTileConnState(id, 'relay-live');
            // Enable channel buttons so the follower can assign audio channels
            document.querySelectorAll(`#ch-btns-${id} .ch-btn`).forEach(b => {
                b.disabled = false;
            });
        } else {
            setTileConnState(id, 'relay-offline');
            // Disable channel buttons when owner is offline
            document.querySelectorAll(`#ch-btns-${id} .ch-btn`).forEach(b => {
                b.disabled = true;
            });
        }
    }
}

window.updateRelayTileOwnerState = updateRelayTileOwnerState;

function renderMonitorGrid(instances) {
    const grid = document.getElementById('monitorGrid');
    grid.innerHTML = instances.map(inst => buildMeterTile(inst)).join('');

    // Attach channel button handlers
    grid.querySelectorAll('.ch-btn').forEach(btn => {
        btn.addEventListener('click', () => assignChannel(btn.dataset.id, btn.dataset.ch));
    });

    // Stop all audio when any "Open SDR →" link is clicked (link opens in new tab)
    grid.querySelectorAll('.meter-connect-link').forEach(a => {
        a.addEventListener('click', () => stopAllAudio());
    });

    // Hover → highlight on map
    attachMapHoverHandlers(grid);

    // Initialise per-instance history buffers and Chart.js sparklines
    instances.forEach(inst => initSignalChart(inst.id));
}

function initSignalChart(id) {
    // Initialise ring buffers filled with nulls (no data yet)
    signalHistory[id] = new Array(HISTORY_SAMPLES).fill(null);
    snrHistory[id]    = new Array(HISTORY_SAMPLES).fill(null);
    historyTime[id]   = new Array(HISTORY_SAMPLES).fill(0);
    historyIndex[id]  = 0;
    chartMode[id]     = globalChartMode; // sync to global mode

    const canvas = document.getElementById(`hist-${id}`);
    if (!canvas || typeof Chart === 'undefined') return;

    // Build label array: -10s … 0s (one label per sample)
    const labels = Array.from({ length: HISTORY_SAMPLES }, (_, i) =>
        (((i - HISTORY_SAMPLES + 1) * METER_UPDATE_INTERVAL) / 1000).toFixed(1)
    );

    signalCharts[id] = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                data: signalHistory[id].slice(),
                borderColor: 'rgba(96, 165, 250, 0.9)',   // #60a5fa — matches freq display
                backgroundColor: 'rgba(96, 165, 250, 0.15)',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.3,
                fill: true,
                spanGaps: false
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        title: items => `${items[0].label}s`,
                        label: item  => item.parsed.y !== null
                            ? `${item.parsed.y.toFixed(1)} ${chartMode[id] === 'snr' ? 'dB SNR' : 'dBFS'}`
                            : 'No data'
                    }
                }
            },
            scales: {
                x: {
                    display: false
                },
                y: {
                    display: true,
                    min: SIG_MIN_DB,
                    max: SIG_MAX_DB,
                    ticks: {
                        color: 'rgba(255,255,255,0.45)',
                        font: { size: 9 },
                        maxTicksLimit: 4,
                        callback: v => `${v}`
                    },
                    grid: {
                        color: 'rgba(255,255,255,0.08)'
                    },
                    border: { display: false }
                }
            }
        }
    });

    // Clicking the bar or chart area toggles ALL tiles between dBFS and SNR views
    const clickTarget = document.getElementById(`meter-clickable-${id}`);
    if (clickTarget) {
        clickTarget.addEventListener('click', () => toggleAllChartModes());
    }

    // Apply the current global mode immediately so the chart starts in the right state
    applyChartMode(id, globalChartMode);
}

/** Toggle all tiles between dBFS and SNR simultaneously. */
function toggleAllChartModes() {
    globalChartMode = globalChartMode === 'dbfs' ? 'snr' : 'dbfs';
    for (const id of Object.keys(chartMode)) {
        applyChartMode(id, globalChartMode);
    }
}

function applyChartMode(id, mode) {
    chartMode[id] = mode;
    const isSnr = mode === 'snr';

    // Update bold styling on the text labels
    const dbfsEl = document.getElementById(`dbfs-${id}`);
    const snrEl  = document.getElementById(`snr-${id}`);
    if (dbfsEl) dbfsEl.style.fontWeight = isSnr ? 'normal' : 'bold';
    if (snrEl)  snrEl.style.fontWeight  = isSnr ? 'bold'   : 'normal';

    // Update bar scale labels
    const scaleMin = document.getElementById(`bar-scale-min-${id}`);
    const scaleMax = document.getElementById(`bar-scale-max-${id}`);
    if (scaleMin) scaleMin.textContent = isSnr ? `${SNR_MIN_DB} dB` : `${SIG_MIN_DB} dBFS`;
    if (scaleMax) scaleMax.textContent = isSnr ? `${SNR_MAX_DB} dB` : `${SIG_MAX_DB} dBFS`;

    // Immediately update bar fill to reflect the new mode's current value
    const radio = activeRadios[id];
    if (radio && radio.hasSignalQuality()) {
        const bar = document.getElementById(`bar-${id}`);
        if (bar) {
            if (isSnr) {
                const snr = radio.signalSNR;
                const pct = snr !== null
                    ? Math.max(0, Math.min(100, ((snr - SNR_MIN_DB) / (SNR_MAX_DB - SNR_MIN_DB)) * 100))
                    : 0;
                bar.style.width = pct + '%';
                bar.style.background = snr !== null && snr >= SNR_GREEN_DB
                    ? 'linear-gradient(90deg, #22c55e 0%, #4ade80 100%)'
                    : snr !== null && snr >= SNR_AMBER_DB
                        ? 'linear-gradient(90deg, #fbbf24 0%, #fcd34d 100%)'
                        : 'linear-gradient(90deg, #ef4444 0%, #f87171 100%)';
            } else {
                const dbfs = radio.basebandPower;
                const pct = Math.max(0, Math.min(100, ((dbfs - SIG_MIN_DB) / (SIG_MAX_DB - SIG_MIN_DB)) * 100));
                bar.style.width = pct + '%';
                bar.style.background = dbfs > -60
                    ? 'linear-gradient(90deg, #22c55e 0%, #4ade80 100%)'
                    : dbfs > -90
                        ? 'linear-gradient(90deg, #fbbf24 0%, #fcd34d 100%)'
                        : 'linear-gradient(90deg, #ef4444 0%, #f87171 100%)';
            }
        }
    }

    // Update chart Y-axis range and colour
    const chart = signalCharts[id];
    if (!chart) return;

    if (isSnr) {
        chart.options.scales.y.min = SNR_MIN_DB;
        chart.options.scales.y.max = SNR_MAX_DB;
        chart.data.datasets[0].borderColor      = 'rgba(34, 197, 94, 0.9)';  // green for SNR
        chart.data.datasets[0].backgroundColor  = 'rgba(34, 197, 94, 0.15)';
    } else {
        chart.options.scales.y.min = SIG_MIN_DB;
        chart.options.scales.y.max = SIG_MAX_DB;
        chart.data.datasets[0].borderColor      = 'rgba(96, 165, 250, 0.9)';  // blue for dBFS
        chart.data.datasets[0].backgroundColor  = 'rgba(96, 165, 250, 0.15)';
    }

    // Immediately redraw with the correct history
    const history = isSnr ? snrHistory[id] : signalHistory[id];
    if (history) {
        const ordered = [];
        for (let i = 0; i < HISTORY_SAMPLES; i++) {
            ordered.push(history[(historyIndex[id] + i) % HISTORY_SAMPLES]);
        }
        chart.data.datasets[0].data = ordered;
    }
    chart.update('none');
}

function buildMeterTile(inst) {
    const flagHtml = countryFlag(inst.country_code)
        ? `<span class="flag" title="${escHtml(inst.country_name || inst.country_code)}">${countryFlag(inst.country_code)}</span>`
        : '';

    return `
        <div class="meter-tile" id="tile-${inst.id}" data-id="${inst.id}">
            <div class="channel-badge" id="ch-badge-${inst.id}"></div>
            <div class="meter-header">
                <div class="meter-callsign">${flagHtml} ${escHtml(inst.callsign)}</div>
                <div class="meter-status-row" style="justify-content:flex-end;">
                    <span class="session-countdown" id="countdown-${inst.id}"></span>
                    <div class="conn-dot connecting" id="dot-${inst.id}"></div>
                    <span class="conn-label" id="conn-label-${inst.id}">Connecting…</span>
                </div>
            </div>
            <div style="font-size:0.78em; opacity:0.7; margin-top:-6px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:baseline; gap:6px;">
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1;">${escHtml(inst.location)}</span>${
                    (userLocation && inst.latitude != null && inst.longitude != null)
                        ? `<span style="opacity:0.65; white-space:nowrap; flex-shrink:0;">${formatDistKm(haversineKm(userLocation.latitude, userLocation.longitude, inst.latitude, inst.longitude))}</span>`
                        : ''
                }
            </div>

            <!-- Signal bar + history chart — click to toggle dBFS / SNR view -->
            <div id="meter-clickable-${inst.id}" style="cursor: pointer;" title="Click to toggle dBFS / SNR view">
                <div class="signal-bar-wrap">
                    <div class="signal-bar-track">
                        <div class="signal-bar-fill" id="bar-${inst.id}"></div>
                    </div>
                    <div class="signal-bar-scale">
                        <span id="bar-scale-min-${inst.id}">${SIG_MIN_DB} dBFS</span>
                        <span id="bar-scale-max-${inst.id}">${SIG_MAX_DB} dBFS</span>
                    </div>
                </div>

                <div class="signal-values">
                    <span class="signal-dbfs" id="dbfs-${inst.id}" style="font-weight:bold;">-- dBFS</span>
                    <span class="signal-snr"  id="snr-${inst.id}"  style="font-weight:normal;">SNR: --</span>
                </div>

                <!-- 10-second rolling signal history -->
                <div style="margin-top: 8px; height: 50px; position: relative;">
                    <canvas id="hist-${inst.id}" style="width:100%; height:50px;"></canvas>
                </div>
            </div>

            <!-- Channel assignment buttons -->
            <div class="ch-btn-group" id="ch-btns-${inst.id}">
                <button class="ch-btn" data-id="${inst.id}" data-ch="left"  disabled title="Left ear only">◀ L</button>
                <button class="ch-btn" data-id="${inst.id}" data-ch="both"  disabled title="Both ears (centre)">L+R</button>
                <button class="ch-btn" data-id="${inst.id}" data-ch="right" disabled title="Right ear only">R ▶</button>
            </div>

            <a href="${escHtml(inst.public_url)}?freq=${currentFreqHz}&mode=${currentMode}&bwl=${currentMode === 'lsb' ? -2700 : 50}&bwh=${currentMode === 'lsb' ? -50 : 2700}"
               data-base-url="${escHtml(inst.public_url)}"
               target="_blank" class="meter-connect-link">
                Open SDR →
            </a>
        </div>
    `;
}

// ─── Server-side mute ─────────────────────────────────────────────────────────
// A grid of twenty tiles used to pull twenty full audio streams and throw
// nineteen of them away at the gain node.  Instead each instance connects with
// ?muted=1 and is unmuted only while something is actually listening to it, so
// an idle tile costs the instance an Opus encode of silence and nothing more.
// Signal-quality metering is untouched: the server keeps sending packets while
// muted and the S-meter/SNR figures ride in their headers, not the audio.
//
// "Something is listening" means any of:
//   • the tile is assigned to a channel, or Smart Listen picked it → volume > 0
//   • Smart Listen is about to switch to it (see setPlayBestPreUnmute)
//   • its frames are being relayed to shared-session followers, who choose what
//     they listen to independently of what the owner has playing
//
// Volume is the signal for the first case, and there are a dozen places that
// write it (channel buttons, Smart Listen, PTT mute, stop-all).  Rather than
// teach each one about the server, attachServerMuteSync() turns currentVolume
// into an accessor so every write — present and future — drives the mute state.

/** True when this radio's audio is wanted by anyone. */
function radioWantsAudio(radio) {
    if (!radio) return false;
    if (radio.onAudioFrame) return true;      // relayed to shared-session followers
    if (radio._preUnmute) return true;        // Smart Listen is about to switch to it
    return (radio.currentVolume || 0) > 0;
}

/** Push the current "is anyone listening" verdict to the server. */
function syncServerMute(radio) {
    if (radio && typeof radio.setServerMuted === 'function') {
        radio.setServerMuted(!radioWantsAudio(radio));
    }
}

/**
 * Make every write to radio.currentVolume drive the server-side mute state.
 * Call before startPreview() so the initial verdict lands in the connect URL
 * rather than arriving a round trip after the audio does.
 */
function attachServerMuteSync(radio) {
    let vol = radio.currentVolume;
    Object.defineProperty(radio, 'currentVolume', {
        configurable: true,
        enumerable: true,
        get() { return vol; },
        set(v) { vol = v; syncServerMute(radio); },
    });
    syncServerMute(radio);
}

/**
 * Keep one instance unmuted ahead of a Smart Listen switch, and only that one.
 * Without this every switch would open with however long the unmute round trip
 * takes as silence, and the NR engine would be adapting to digital silence at
 * the moment the audio arrives.  Pass null to release.
 */
function setPlayBestPreUnmute(id) {
    for (const [rid, radio] of Object.entries(activeRadios)) {
        const want = rid === id;
        if (!!radio._preUnmute === want) continue;
        radio._preUnmute = want;
        syncServerMute(radio);
    }
}

// ─── Connection ───────────────────────────────────────────────────────────────

async function connectInstance(inst) {
    // Cancel any pending reconnect timer for this instance
    if (reconnectTimers[inst.id]) {
        clearTimeout(reconnectTimers[inst.id]);
        delete reconnectTimers[inst.id];
    }

    try {
        const radio = new MinimalRadio(null, inst.public_url,
            MinimalRadio.protocolVersionFor(inst.version));
        activeRadios[inst.id] = radio;

        // Start muted — volume 0 until user assigns a channel
        radio.currentVolume = 0;

        // Attach relay upstream callback if owner mode
        if (typeof isOwnerMode !== 'undefined' && isOwnerMode &&
            typeof _relayUpstream !== 'undefined' && _relayUpstream) {
            const instId = inst.id;
            radio.onAudioFrame = (sr, ch, bp, nd, opus) => {
                _relayUpstream.sendAudio(instId, sr, ch, bp, nd, opus);
            };
            console.log(`[Relay] connectInstance: attached onAudioFrame for ${inst.callsign} (${inst.id})`);
        }

        // Volume 0 and no relay callback means nobody is listening yet, so this
        // resolves to muted and startPreview() connects with ?muted=1 — the tile
        // is never audible, not even for the first few frames.  Attached after
        // the relay block above so an owner-mode session is seen as a listener.
        attachServerMuteSync(radio);

        // Suppress the floating fixed-position signal bar that MinimalRadio normally
        // appends to document.body anchored to a Leaflet map marker.
        radio.startSignalBarUpdates = () => {};
        radio.stopSignalBarUpdates  = () => {};

        // Route audio to the user-selected output device (if supported)
        patchRadioOutputDevice(radio);

        // Override playAudioBuffer to inject a StereoPannerNode and optional NR.
        // NR is applied synchronously to the decoded PCM *before* creating the
        // AudioBuffer — this avoids ScriptProcessorNode graph-timing issues entirely.
        //
        // NREngine.processBlock() requires exactly 4096-sample blocks, but Opus
        // frames are typically 960 samples.  We accumulate incoming samples into a
        // 4096-sample ring buffer (_nrInBuf) and drain the processed output into a
        // corresponding output ring (_nrOutBuf).  Each call to playAudioBuffer
        // replaces the incoming buffer with NR-processed samples when available.
        //
        // The scheduling/fade logic is copied verbatim from MinimalRadio.playAudioBuffer().
        radio.panValue                = 0.0;   // -1=left, 0=both/centre, +1=right
        radio._nrEngine               = null;  // NREngine instance (lazy-created on first audio packet)
        radio._nrEngineInitAttempted  = false; // prevents repeated creation attempts
        radio._nrProcessor            = null;  // unused — kept for teardown compatibility
        radio._pannerNode             = null;  // StereoPannerNode — lazy-created on first audio packet
        // NR accumulator ring buffers (4096-sample block alignment)
        radio._nrInBuf     = new Float32Array(4096);
        radio._nrInCount   = 0;     // samples accumulated in _nrInBuf
        radio._nrOutBuf    = new Float32Array(0); // processed output waiting to be consumed
        radio._nrOutOffset = 0;     // read position in _nrOutBuf

        radio.playAudioBuffer = function(buffer) {
            if (!this.audioContext) return;

            // ── Lazy init: panner + NR engine (audioContext exists by first call) ──
            if (!this._pannerNode && this.audioContext) {
                this._pannerNode = this.audioContext.createStereoPanner();
                this._pannerNode.pan.value = this.panValue;
                this._pannerNode.connect(this.audioContext.destination);
            }
            if (!this._nrEngine && !this._nrEngineInitAttempted && this.audioContext) {
                this._nrEngineInitAttempted = true;
                if (typeof window.NREngine === 'function') {
                    try {
                        this._nrEngine = new window.NREngine();
                        this._nrEngine.enabled = nrGlobalEnabled;
                        const bw = Math.abs((this.bandwidthHigh || 2700) - (this.bandwidthLow || 50));
                        const binWidth = this.audioContext.sampleRate / 512;
                        let bins = Math.ceil(bw / binWidth) + 1;
                        if (bins < 4)   bins = 4;
                        if (bins > 257) bins = 257;
                        this._nrEngine.nbins = bins;
                    } catch (nrErr) {
                        this._nrEngine = null;
                    }
                }
            }

            // ── Inline NR processing ──────────────────────────────────────────
            // NREngine requires 4096-sample blocks.  We accumulate incoming samples
            // and replace the buffer with NR-processed output when available.
            // NOTE: do NOT gate on currentVolume — the NR pipeline must run
            // continuously (even while muted) so the accumulator stays warm and
            // output is available immediately when the radio becomes audible.
            if (this._nrEngine && this._nrEngine.enabled) {
                try {
                    const ch0 = new Float32Array(buffer.getChannelData(0)); // copy
                    const frameLen = ch0.length;
                    let outSamples = null; // will hold NR-processed output for this frame

                    // Feed incoming samples into the 4096-sample accumulator
                    let srcOff = 0;
                    while (srcOff < frameLen) {
                        const space = 4096 - this._nrInCount;
                        const copy  = Math.min(space, frameLen - srcOff);
                        this._nrInBuf.set(ch0.subarray(srcOff, srcOff + copy), this._nrInCount);
                        this._nrInCount += copy;
                        srcOff += copy;

                        if (this._nrInCount === 4096) {
                            // Full block ready — process it
                            const processed = this._nrEngine.processWithDelay(
                                new Float32Array(this._nrInBuf)
                            );
                            this._nrInCount = 0;
                            if (processed !== null) {
                                // Append to output ring
                                const prev = this._nrOutBuf.subarray(this._nrOutOffset);
                                const combined = new Float32Array(prev.length + processed.length);
                                combined.set(prev, 0);
                                combined.set(processed, prev.length);
                                this._nrOutBuf    = combined;
                                this._nrOutOffset = 0;
                            }
                        }
                    }

                    // Drain output ring: consume frameLen samples if available
                    const available = this._nrOutBuf.length - this._nrOutOffset;
                    if (available >= frameLen) {
                        outSamples = this._nrOutBuf.subarray(
                            this._nrOutOffset, this._nrOutOffset + frameLen
                        );
                        this._nrOutOffset += frameLen;
                        // Compact output ring when offset grows large
                        if (this._nrOutOffset > 8192) {
                            this._nrOutBuf    = new Float32Array(
                                this._nrOutBuf.subarray(this._nrOutOffset)
                            );
                            this._nrOutOffset = 0;
                        }
                    }

                    if (outSamples !== null) {
                        const nrBuf = this.audioContext.createBuffer(
                            buffer.numberOfChannels,
                            outSamples.length,
                            buffer.sampleRate
                        );
                        for (let c = 0; c < buffer.numberOfChannels; c++) {
                            nrBuf.getChannelData(c).set(outSamples);
                        }
                        buffer = nrBuf;
                    }
                } catch (nrErr) {
                    // NR failed — fall through with original buffer
                }
            }
            // ─────────────────────────────────────────────────────────────────

            const source   = this.audioContext.createBufferSource();
            source.buffer  = buffer;
            const gainNode = this.audioContext.createGain();

            // Update panner pan value (the node stays permanently connected)
            if (this._pannerNode) this._pannerNode.pan.value = this.panValue;

            // Route: source → gain → panner (permanently wired to destination)
            source.connect(gainNode);
            if (this._pannerNode) {
                gainNode.connect(this._pannerNode);
            } else {
                // Fallback: no permanent panner yet (shouldn't happen after startPreview)
                const pannerNode = this.audioContext.createStereoPanner();
                pannerNode.pan.value = this.panValue;
                gainNode.connect(pannerNode);
                pannerNode.connect(this.audioContext.destination);
            }

            const currentTime  = this.audioContext.currentTime;
            const bufferAhead  = this.nextPlayTime - currentTime;
            const needsReset   = this.audioBufferCount >= 3 &&
                                 (this.nextPlayTime < currentTime || bufferAhead < 0.05);

            if (this.audioBufferCount === 0) {
                // Fade in on first buffer
                const FADE_TIME     = 0.5;
                const fadeStartTime = Math.max(this.nextPlayTime, currentTime);
                gainNode.gain.setValueAtTime(0, fadeStartTime);
                gainNode.gain.linearRampToValueAtTime(this.currentVolume, fadeStartTime + FADE_TIME);
            } else if (needsReset) {
                // Quick fade out/in on buffer underrun
                const FADE_TIME = 0.01;
                gainNode.gain.setValueAtTime(this.currentVolume, currentTime);
                gainNode.gain.linearRampToValueAtTime(0, currentTime + FADE_TIME);
                this.nextPlayTime = currentTime + FADE_TIME + 0.05;
                gainNode.gain.setValueAtTime(0, this.nextPlayTime);
                gainNode.gain.linearRampToValueAtTime(this.currentVolume, this.nextPlayTime + FADE_TIME);
            } else {
                gainNode.gain.value = this.currentVolume;
            }

            this.audioBufferCount++;
            source.start(this.nextPlayTime);
            this.nextPlayTime += buffer.duration;
        };

        await radio.startPreview(currentFreqHz, currentMode);

        // NOTE: audioContext is created lazily on the first audio packet, so
        // the panner and NR engine are now initialised inside playAudioBuffer
        // on the first call (see lazy-init block above).
        // ─────────────────────────────────────────────────────────────────────

        // ── Mid-session disconnect handler ────────────────────────────────────
        // Attach after startPreview() succeeds so we only react to drops that
        // happen after a successful connection, not to initial-connect failures
        // (those are caught by the outer try/catch below).
        if (radio.ws) {
            radio.ws.addEventListener('close', (event) => {
                // Ignore if this radio has already been replaced (e.g. by stopMonitoring)
                if (activeRadios[inst.id] !== radio) return;

                const wasSessionExpiry = sessionExpiry[inst.id] !== null &&
                    sessionExpiry[inst.id] !== undefined &&
                    new Date() >= sessionExpiry[inst.id];

                const reason = wasSessionExpiry ? 'Session expired' : 'Disconnected';
                console.warn(`[MultiMonitor] ${inst.callsign} ${reason} (code ${event.code})`);

                // Mark tile as errored and zero out the signal bar
                setTileConnState(inst.id, 'error', reason);
                disconnectedIds.add(inst.id);
                const bar = document.getElementById(`bar-${inst.id}`);
                if (bar) bar.style.width = '0%';

                // Disable channel buttons so the user can't assign a dead radio
                document.querySelectorAll(`#ch-btns-${inst.id} .ch-btn`).forEach(b => {
                    b.disabled = true;
                });

                // Clear channel assignment — don't leave a badge on a dead instance
                if (leftChannelId === inst.id || rightChannelId === inst.id) {
                    removeFromChannel(inst.id);
                    updateChannelUI();
                }

                // Let Smart Listen immediately pick a new best
                if (playBestCurrentId === inst.id) {
                    playBestCurrentId      = null;
                    playBestCandidateId    = null;
                    playBestCandidateTicks = 0;
                }

                // Tear down NR engine, processor and permanent panner for this radio
                if (radio._nrProcessor) {
                    try { radio._nrProcessor.disconnect(); } catch (e) { /* ignore */ }
                    radio._nrProcessor = null;
                }
                if (radio._pannerNode) {
                    try { radio._pannerNode.disconnect(); } catch (e) { /* ignore */ }
                    radio._pannerNode = null;
                }
                radio._nrEngine = null;

                // Remove from activeRadios so meters and applyPlayBest skip it
                delete activeRadios[inst.id];

                // Schedule reconnect (unless stopMonitoring has already cleared the grid)
                if (document.getElementById(`tile-${inst.id}`)) {
                    setTileConnState(inst.id, 'reconnecting');
                    reconnectTimers[inst.id] = setTimeout(() => {
                        delete reconnectTimers[inst.id];
                        // Only reconnect if we're still in monitor phase
                        if (document.getElementById(`tile-${inst.id}`)) {
                            disconnectedIds.delete(inst.id);
                            connectInstance(inst);
                        }
                    }, RECONNECT_DELAY_MS);
                }
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        // Override bandwidth to 2700 Hz
        if (currentMode === 'lsb') {
            radio.bandwidthLow  = -2700;
            radio.bandwidthHigh = -50;
        } else {
            radio.bandwidthLow  = 50;
            radio.bandwidthHigh = 2700;
        }
        sendTune(radio);

        // Record session expiry time (0 = unlimited)
        const maxSec = radio.maxSessionTime || 0;
        sessionExpiry[inst.id] = maxSec > 0 ? new Date(Date.now() + maxSec * 1000) : null;
        updateSessionCountdown(inst.id);

        // Successfully (re)connected — clear disconnected flag
        disconnectedIds.delete(inst.id);
        setTileConnState(inst.id, 'live');

        // Enable channel buttons
        const btns = document.querySelectorAll(`#ch-btns-${inst.id} .ch-btn`);
        btns.forEach(b => { b.disabled = false; });

    } catch (err) {
        console.error(`Failed to connect to ${inst.callsign}:`, err);
        setTileConnState(inst.id, 'error', err.message);
        delete activeRadios[inst.id];

        // Schedule a reconnect for initial-connect failures too, as long as the
        // tile still exists (i.e. we haven't navigated back to selection phase).
        if (document.getElementById(`tile-${inst.id}`)) {
            setTileConnState(inst.id, 'reconnecting');
            reconnectTimers[inst.id] = setTimeout(() => {
                delete reconnectTimers[inst.id];
                if (document.getElementById(`tile-${inst.id}`)) {
                    connectInstance(inst);
                }
            }, RECONNECT_DELAY_MS);
        }
    }
}

function setTileConnState(id, state, msg) {
    const dot   = document.getElementById(`dot-${id}`);
    const label = document.getElementById(`conn-label-${id}`);
    const tile  = document.getElementById(`tile-${id}`);

    if (!dot || !label) return;

    // Map state → CSS class on the dot
    // 'reconnecting' reuses the amber 'connecting' animation
    // 'relay-waiting' and 'relay-live' are relay-specific states
    let dotClass = state;
    if (state === 'reconnecting') dotClass = 'connecting';
    if (state === 'relay-waiting') dotClass = 'connecting';
    if (state === 'relay-live') dotClass = 'live';
    if (state === 'relay-offline') dotClass = 'error';
    dot.className = `conn-dot ${dotClass}`;

    switch (state) {
        case 'connecting':
            label.textContent = 'Connecting…';
            if (tile) tile.classList.remove('conn-error');
            break;
        case 'live':
            label.textContent = 'Live';
            if (tile) tile.classList.remove('conn-error');
            break;
        case 'error':
            label.textContent = msg ? `Error: ${msg.substring(0, 40)}` : 'Connection failed';
            if (tile) tile.classList.add('conn-error');
            break;
        case 'reconnecting':
            label.textContent = `Reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`;
            if (tile) tile.classList.add('conn-error');
            break;
        case 'relay-waiting':
            label.textContent = 'Waiting for owner…';
            if (tile) tile.classList.remove('conn-error');
            break;
        case 'relay-live':
            label.textContent = 'Live (relay)';
            if (tile) tile.classList.remove('conn-error');
            break;
        case 'relay-offline':
            label.textContent = msg || 'Owner offline';
            if (tile) tile.classList.add('conn-error');
            break;
    }
}

// ─── Channel Assignment ───────────────────────────────────────────────────────

/**
 * Assign an instance to a channel ('left', 'right', 'both').
 * If the instance is already on that channel, it is removed (toggled off).
 *
 * Rules:
 *  - 'both' (centre) is exclusive: clears both L and R slots first.
 *  - 'left' replaces any existing left assignment; right is unaffected.
 *  - 'right' replaces any existing right assignment; left is unaffected.
 *  - Two instances can coexist as left + right simultaneously.
 */
function assignChannel(id, channel) {
    // ── Follower mode: delegate pan to FollowerRelay ──────────────────────────
    if (typeof isFollowerMode !== 'undefined' && isFollowerMode &&
        typeof _followerRelay !== 'undefined' && _followerRelay) {
        // Determine current assignment for toggle logic using followerPanMap
        // (activeRadios is empty in follower mode so panValue is not available)
        const curPan     = followerPanMap.get(id);   // -1 | 0 | 1 | undefined
        const curIsBoth  = leftChannelId === id && rightChannelId === null && curPan === 0;
        const curIsLeft  = leftChannelId === id && !curIsBoth;
        const curIsRight = rightChannelId === id && leftChannelId !== id;

        // Toggle off: removeFromChannel already clears followerPanMap and calls updateChannelUI
        if (channel === 'left'  && curIsLeft)  { removeFromChannel(id); _followerRelay.setInstancePan(id, null); return; }
        if (channel === 'right' && curIsRight) { removeFromChannel(id); _followerRelay.setInstancePan(id, null); return; }
        if (channel === 'both'  && curIsBoth)  { removeFromChannel(id); _followerRelay.setInstancePan(id, null); return; }

        if (channel === 'both') {
            if (leftChannelId  !== null) { _followerRelay.setInstancePan(leftChannelId, null);  followerPanMap.delete(leftChannelId);  leftChannelId  = null; }
            if (rightChannelId !== null) { _followerRelay.setInstancePan(rightChannelId, null); followerPanMap.delete(rightChannelId); rightChannelId = null; }
            leftChannelId  = id;
            rightChannelId = null;
            followerPanMap.set(id, 0);
            _followerRelay.setInstancePan(id, 0);
        } else if (channel === 'left') {
            if (leftChannelId !== null && leftChannelId !== id) { _followerRelay.setInstancePan(leftChannelId, null); followerPanMap.delete(leftChannelId); leftChannelId = null; }
            if (curIsBoth) { followerPanMap.delete(id); leftChannelId = null; }
            leftChannelId = id;
            followerPanMap.set(id, -1);
            _followerRelay.setInstancePan(id, -1);
        } else if (channel === 'right') {
            if (rightChannelId !== null && rightChannelId !== id) { _followerRelay.setInstancePan(rightChannelId, null); followerPanMap.delete(rightChannelId); rightChannelId = null; }
            if (curIsBoth) { followerPanMap.delete(id); leftChannelId = null; }
            rightChannelId = id;
            followerPanMap.set(id, 1);
            _followerRelay.setInstancePan(id, 1);
        }
        updateChannelUI();
        return;
    }

    // ── Normal (owner) mode ───────────────────────────────────────────────────
    const radio = activeRadios[id];
    if (!radio) return;

    // Determine current assignment of this instance
    const curIsBoth  = leftChannelId === id && rightChannelId === null && radio.panValue === 0.0;
    const curIsLeft  = leftChannelId === id && !curIsBoth;
    const curIsRight = rightChannelId === id && leftChannelId !== id;

    // Toggle off if already on exactly this channel
    if (channel === 'left'  && curIsLeft)  { removeFromChannel(id); return; }
    if (channel === 'right' && curIsRight) { removeFromChannel(id); return; }
    if (channel === 'both'  && curIsBoth)  { removeFromChannel(id); return; }

    // 'both' is exclusive — clear everything first
    if (channel === 'both') {
        if (leftChannelId  !== null) muteAndClearChannel('left');
        if (rightChannelId !== null) muteAndClearChannel('right');
        leftChannelId  = id;
        rightChannelId = null;
        radio.panValue     = 0.0;
        radio.currentVolume = 1.0;
        updateChannelUI();
        return;
    }

    // Remove this instance from any current assignment before reassigning
    if (curIsLeft  && channel !== 'left')  { leftChannelId  = null; }
    if (curIsRight && channel !== 'right') { rightChannelId = null; }
    // If currently 'both' and switching to L or R, clear the both slot
    if (curIsBoth) { leftChannelId = null; }

    if (channel === 'left') {
        // Mute whatever was previously on left
        if (leftChannelId !== null && leftChannelId !== id) {
            muteAndClearChannel('left');
        }
        leftChannelId   = id;
        radio.panValue      = -1.0;
        radio.currentVolume = 1.0;
    } else if (channel === 'right') {
        // Mute whatever was previously on right
        if (rightChannelId !== null && rightChannelId !== id) {
            muteAndClearChannel('right');
        }
        rightChannelId  = id;
        radio.panValue      = 1.0;
        radio.currentVolume = 1.0;
    }

    updateChannelUI();
}

/** Mute the instance on the given slot and clear the slot. */
function muteAndClearChannel(slot) {
    const id = slot === 'left' ? leftChannelId : rightChannelId;
    if (id === null) return;

    // Only mute if not also assigned to the other channel
    const otherSlotId = slot === 'left' ? rightChannelId : leftChannelId;
    if (otherSlotId !== id) {
        const radio = activeRadios[id];
        if (radio) radio.currentVolume = 0.0;
    }

    if (slot === 'left')  leftChannelId  = null;
    if (slot === 'right') rightChannelId = null;
}

/** Remove an instance from whichever channel(s) it currently occupies. */
function removeFromChannel(id) {
    if (leftChannelId  === id) leftChannelId  = null;
    if (rightChannelId === id) rightChannelId = null;

    followerPanMap.delete(id);

    const radio = activeRadios[id];
    if (radio) radio.currentVolume = 0.0;

    updateChannelUI();
}

/** Refresh all tile borders, badges, and button active states to match current channel state. */
function updateChannelUI() {
    // Notify shared session followers of channel change (owner only, debounced)
    // Skip when Smart Listen modal is open — Play Best manages channels automatically there
    const smartListenOpen = document.getElementById('snrModalOverlay')?.classList.contains('open') || false;
    if (!smartListenOpen &&
        typeof isOwnerMode !== 'undefined' && isOwnerMode &&
        typeof scheduleSharedSessionUpdate === 'function') {
        scheduleSharedSessionUpdate();
    }

    // In follower mode, activeRadios is empty — iterate tile IDs from selectedIds instead
    const isFollower = typeof isFollowerMode !== 'undefined' && isFollowerMode;
    const tileIds = isFollower
        ? Array.from(selectedIds || [])
        : Object.keys(activeRadios);

    for (const id of tileIds) {
        const tile  = document.getElementById(`tile-${id}`);
        const badge = document.getElementById(`ch-badge-${id}`);
        const btnL  = document.querySelector(`#ch-btns-${id} [data-ch="left"]`);
        const btnC  = document.querySelector(`#ch-btns-${id} [data-ch="both"]`);
        const btnR  = document.querySelector(`#ch-btns-${id} [data-ch="right"]`);

        if (!tile) continue;

        // isBoth: assigned to leftChannelId slot with pan=0 (centre), rightChannelId is null.
        // In follower mode use followerPanMap (activeRadios is empty); in owner mode use radio.panValue.
        const followerPan = isFollower ? followerPanMap.get(id) : undefined;
        const isBoth  = leftChannelId === id && rightChannelId === null &&
                        (isFollower ? followerPan === 0 : (activeRadios[id] && activeRadios[id].panValue === 0.0));
        // isLeft: in left slot but NOT in both mode (pan=-1)
        const isLeft  = leftChannelId  === id && !isBoth;
        // isRight: in right slot only
        const isRight = rightChannelId === id && leftChannelId !== id;

        // Remove all channel classes
        tile.classList.remove('ch-left', 'ch-right', 'ch-both');

        if (isBoth) {
            tile.classList.add('ch-both');
            if (badge) { badge.textContent = '🔊 L + R'; badge.className = 'channel-badge ch-both-badge'; }
        } else if (isLeft) {
            tile.classList.add('ch-left');
            if (badge) { badge.textContent = '◀ Left'; badge.className = 'channel-badge ch-left-badge'; }
        } else if (isRight) {
            tile.classList.add('ch-right');
            if (badge) { badge.textContent = 'Right ▶'; badge.className = 'channel-badge ch-right-badge'; }
        } else {
            if (badge) { badge.textContent = ''; badge.className = 'channel-badge'; }
        }

        // Update button active states
        if (btnL) btnL.classList.toggle('active', isLeft);
        if (btnC) btnC.classList.toggle('active', isBoth);
        if (btnR) btnR.classList.toggle('active', isRight);

        // Update map marker speaker badge
        const channel = isBoth ? 'both' : isLeft ? 'left' : isRight ? 'right' : null;
        updateMarkerChannel(id, channel);
    }
}

function stopAllAudio() {
    // Mute all radios and clear channel assignments
    setPlayBestPreUnmute(null);
    for (const radio of Object.values(activeRadios)) {
        radio.currentVolume = 0.0;
    }
    // Clear speaker badges from all map markers
    for (const id of Object.keys(activeRadios)) {
        updateMarkerChannel(id, null);
    }
    leftChannelId  = null;
    rightChannelId = null;
    followerPanMap.clear();
    // If "play best" was active, turn it off so it doesn't immediately re-assign
    if (playBestEnabled) {
        playBestEnabled        = false;
        playBestCurrentId      = null;
        playBestCandidateId    = null;
        playBestCandidateTicks = 0;
        const pbCb = document.getElementById('snrPlayBestToggle');
        if (pbCb) pbCb.checked = false;
    }
    updateChannelUI();
}

window.stopAllAudio = stopAllAudio;

// ─── Bridge mute (used by Firefox extension via radioAPI shim) ────────────────
// Saves and restores per-radio volumes so PTT mute doesn't destroy channel
// assignments or play-best state.  _muteActive also guards applyPlayBest() so
// it doesn't fight the mute while PTT is held.

let _muteActive       = false;
let _muteSavedVolumes = {};   // instanceId → saved currentVolume, '__preview' for previewRadio

function muteAllAudio(muted) {
    if (muted === _muteActive) return;   // idempotent
    _muteActive = muted;

    if (muted) {
        // Release any Smart Listen candidate too, or one stream would stay
        // unmuted at the server for the length of the transmission.
        setPlayBestPreUnmute(null);
        // Snapshot current volumes before silencing
        _muteSavedVolumes = {};
        for (const [id, radio] of Object.entries(activeRadios)) {
            _muteSavedVolumes[id] = radio.currentVolume;
        }
        if (previewRadio) _muteSavedVolumes['__preview'] = previewRadio.currentVolume;
        // Silence everything
        for (const radio of Object.values(activeRadios)) radio.currentVolume = 0;
        if (previewRadio) previewRadio.currentVolume = 0;
    } else {
        // Restore saved volumes
        for (const [id, radio] of Object.entries(activeRadios)) {
            if (_muteSavedVolumes[id] !== undefined) {
                radio.currentVolume = _muteSavedVolumes[id];
                // Do NOT reset the NR engine on unmute — the pipeline must stay
                // warm so processed output is available immediately.
            }
        }
        if (previewRadio && _muteSavedVolumes['__preview'] !== undefined) {
            previewRadio.currentVolume = _muteSavedVolumes['__preview'];
        }
        _muteSavedVolumes = {};
    }
}

// ─── Stop Monitoring / Back ───────────────────────────────────────────────────

async function stopMonitoring() {
    // Stop meter refresh
    if (meterUpdateTimer) {
        clearInterval(meterUpdateTimer);
        meterUpdateTimer = null;
    }

    // Cancel all pending reconnect timers so they don't fire after we leave monitor phase
    for (const [id, timer] of Object.entries(reconnectTimers)) {
        clearTimeout(timer);
    }
    reconnectTimers  = {};
    disconnectedIds.clear();

    // Disconnect all radios and tear down their NR engines
    for (const [id, radio] of Object.entries(activeRadios)) {
        // Disconnect NR processor and permanent panner before stopping the radio
        if (radio._nrProcessor) {
            try { radio._nrProcessor.disconnect(); } catch (e) { /* ignore */ }
            radio._nrProcessor = null;
        }
        if (radio._pannerNode) {
            try { radio._pannerNode.disconnect(); } catch (e) { /* ignore */ }
            radio._pannerNode = null;
        }
        radio._nrEngine = null;
        try {
            await radio.stopPreview();
        } catch (e) {
            console.warn(`Error stopping radio ${id}:`, e);
        }
    }
    activeRadios   = {};
    leftChannelId  = null;
    rightChannelId = null;
    followerPanMap.clear();

    // Reset NR global state and sync UI back to Off (radios are gone, engines already nulled above)
    nrGlobalEnabled = false;
    syncNRUI();

    // Destroy all sparkline charts and clear history
    for (const [id, chart] of Object.entries(signalCharts)) {
        try { chart.destroy(); } catch (e) { /* ignore */ }
    }
    signalCharts  = {};
    signalHistory = {};
    snrHistory    = {};
    historyTime       = {};
    historyIndex      = {};
    chartMode         = {};
    globalChartMode   = 'snr';
    sessionExpiry     = {};

    // Clear monitor grid
    document.getElementById('monitorGrid').innerHTML = '';

    // Switch back to selection phase
    document.getElementById('phase-monitor').style.display         = 'none';
    document.getElementById('monitor-toolbar-panel').style.display = 'none';
    document.getElementById('band-filter-panel').style.display     = '';
    document.getElementById('phase-select').style.display          = 'block';

    // Hide the audio output device selector until monitoring starts again
    const audioWrap = document.getElementById('audio-output-wrap');
    if (audioWrap) {
        audioWrap.style.display = 'none';
        audioWrap.classList.remove('open'); // close dropdown if open
    }

    // Restore map to show all filtered instances
    updateMap(filteredInstances);
    updateURL(); // clear ids from URL when returning to selection

    setStatus(`${filteredInstances.length} audio-capable online instance${filteredInstances.length !== 1 ? 's' : ''} available`, 'success');
}

window.stopMonitoring = stopMonitoring;

// ─── Meter Refresh ────────────────────────────────────────────────────────────

/** Format remaining seconds as MM:SS or "Unlimited". */
function formatCountdown(secsRemaining) {
    if (secsRemaining <= 0) return '0:00';
    const m = Math.floor(secsRemaining / 60);
    const s = Math.floor(secsRemaining % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Update the countdown display for a single tile. */
function updateSessionCountdown(id) {
    const el = document.getElementById(`countdown-${id}`);
    if (!el) return;
    const expiry = sessionExpiry[id];
    if (!expiry) {
        el.textContent = 'Unlimited';
        el.classList.remove('countdown-warning');
        return;
    }
    const secsLeft = (expiry - Date.now()) / 1000;
    el.textContent = formatCountdown(secsLeft);
    el.classList.toggle('countdown-warning', secsLeft <= 300);

    // When the session has expired and the radio is still nominally in activeRadios
    // (the server hasn't closed the socket yet, or the close event fired before we
    // noticed), proactively trigger the disconnect path so the tile shows an error
    // and schedules a reconnect rather than silently going idle.
    if (secsLeft <= 0 && activeRadios[id]) {
        const radio = activeRadios[id];
        if (radio.ws && radio.ws.readyState !== WebSocket.CLOSED &&
                        radio.ws.readyState !== WebSocket.CLOSING) {
            // Force-close the socket — the ws 'close' handler in connectInstance()
            // will fire and handle the rest (error state, reconnect scheduling).
            radio.ws.close(1000, 'Session expired');
        }
    }
}

function refreshAllMeters() {
    // Update session countdowns for all tiles
    for (const id of Object.keys(activeRadios)) {
        updateSessionCountdown(id);
    }

    for (const [id, radio] of Object.entries(activeRadios)) {
        // Dead-socket guard: if the WebSocket has closed without the close handler
        // having fired yet (race condition), surface the error immediately.
        if (radio.ws) {
            const wsState = radio.ws.readyState;
            if (wsState === WebSocket.CLOSED || wsState === WebSocket.CLOSING) {
                if (!disconnectedIds.has(id)) {
                    disconnectedIds.add(id);
                    setTileConnState(id, 'error', 'Connection lost');
                    const bar = document.getElementById(`bar-${id}`);
                    if (bar) bar.style.width = '0%';
                    document.querySelectorAll(`#ch-btns-${id} .ch-btn`).forEach(b => {
                        b.disabled = true;
                    });
                    if (leftChannelId === id || rightChannelId === id) {
                        removeFromChannel(id);
                        updateChannelUI();
                    }
                    if (playBestCurrentId === id) {
                        playBestCurrentId      = null;
                        playBestCandidateId    = null;
                        playBestCandidateTicks = 0;
                    }
                    delete activeRadios[id];
                    if (document.getElementById(`tile-${id}`)) {
                        setTileConnState(id, 'reconnecting');
                        reconnectTimers[id] = setTimeout(() => {
                            delete reconnectTimers[id];
                            if (document.getElementById(`tile-${id}`)) {
                                disconnectedIds.delete(id);
                                const inst = allInstances.find(i => i.id === id);
                                if (inst) connectInstance(inst);
                            }
                        }, RECONNECT_DELAY_MS);
                    }
                }
                continue;
            }
        }

        if (!radio.isPlaying) continue;

        const bar    = document.getElementById(`bar-${id}`);
        const dbfsEl = document.getElementById(`dbfs-${id}`);
        const snrEl  = document.getElementById(`snr-${id}`);

        if (!bar || !dbfsEl || !snrEl) continue;

        if (!radio.hasSignalQuality()) {
            dbfsEl.textContent = '-- dBFS';
            snrEl.textContent  = 'SNR: --';
            bar.style.width    = '0%';
            continue;
        }

        const dbfs = radio.basebandPower;
        const snr  = radio.signalSNR;

        // Bar fill — use SNR or dBFS depending on current chart mode
        const isSnrMode = chartMode[id] === 'snr';
        if (isSnrMode && snr !== null) {
            const pct = Math.max(0, Math.min(100, ((snr - SNR_MIN_DB) / (SNR_MAX_DB - SNR_MIN_DB)) * 100));
            bar.style.width = pct + '%';
            bar.style.background = snr >= SNR_GREEN_DB
                ? 'linear-gradient(90deg, #22c55e 0%, #4ade80 100%)'   // green  ≥ 15 dB
                : snr >= SNR_AMBER_DB
                    ? 'linear-gradient(90deg, #fbbf24 0%, #fcd34d 100%)' // amber 6–14 dB
                    : 'linear-gradient(90deg, #ef4444 0%, #f87171 100%)'; // red   below 6 dB
        } else {
            const pct = Math.max(0, Math.min(100,
                ((dbfs - SIG_MIN_DB) / (SIG_MAX_DB - SIG_MIN_DB)) * 100
            ));
            bar.style.width = pct + '%';
            if (dbfs > -60) {
                bar.style.background = 'linear-gradient(90deg, #22c55e 0%, #4ade80 100%)';
            } else if (dbfs > -90) {
                bar.style.background = 'linear-gradient(90deg, #fbbf24 0%, #fcd34d 100%)';
            } else {
                bar.style.background = 'linear-gradient(90deg, #ef4444 0%, #f87171 100%)';
            }
        }

        // Update map marker colour based on SNR (always, regardless of card view mode)
        updateMarkerSignalColor(id, snr);

        dbfsEl.textContent = `${dbfs.toFixed(1)} dBFS`;
        snrEl.textContent  = snr !== null ? `SNR: ${snr.toFixed(1)} dB` : 'SNR: --';

        // Push samples into both ring buffers
        if (signalHistory[id]) {
            const idx = historyIndex[id];
            signalHistory[id][idx] = dbfs;
            snrHistory[id][idx]    = snr;
            if (historyTime[id]) historyTime[id][idx] = performance.now();
            historyIndex[id] = (idx + 1) % HISTORY_SAMPLES;

            const chart = signalCharts[id];
            if (chart) {
                // Pick the active history based on current chart mode
                const history = chartMode[id] === 'snr' ? snrHistory[id] : signalHistory[id];
                // Reorder ring buffer into chronological order for Chart.js
                const ordered = [];
                for (let i = 0; i < HISTORY_SAMPLES; i++) {
                    ordered.push(history[(historyIndex[id] + i) % HISTORY_SAMPLES]);
                }
                chart.data.datasets[0].data = ordered;
                chart.update('none'); // 'none' skips animation for real-time feel
            }
        }
    }
}

// ─── Frequency Controls ───────────────────────────────────────────────────────

function setupFrequencyControls() {
    const slider  = document.getElementById('freqSlider');
    const input   = document.getElementById('freqInput');
    const display = document.getElementById('freqDisplay');
    const modeEl  = document.getElementById('modeIndicator');

    let applyFreqTimer = null;

    function applyFreq(mhz, immediate = false) {
        const valid = freqInRangeMhz(mhz);
        isFreqValid = valid;

        if (!valid) {
            input.classList.add('invalid');
            return;
        }
        input.classList.remove('invalid');

        // Update display immediately for responsiveness
        display.textContent = `${mhz.toFixed(6)} MHz`;
        const mode = resolveMode(mhz);
        modeEl.textContent = mode.toUpperCase();
        modeEl.classList.toggle('overridden', modeOverride !== null);
        currentFreqHz = Math.round(mhz * 1e6);
        currentMode   = mode;

        // Debounce the expensive operations (retune, filter rebuild, map update)
        if (!immediate) {
            clearTimeout(applyFreqTimer);
            applyFreqTimer = setTimeout(() => _commitFreq(false), 50);
        } else {
            _commitFreq(true); // init call — don't overwrite URL
        }
    }

    function _commitFreq(isInit = false) {
        const { bwl, bwh } = bandwidthForMode(currentMode);
        // Retune select-phase preview radio if active
        if (previewRadio) {
            previewRadio.changeFrequency(currentFreqHz, currentMode);
            previewRadio.bandwidthLow  = bwl;
            previewRadio.bandwidthHigh = bwh;
            sendTune(previewRadio);
        }
        // Retune all monitor radios and resync NR bin count to new bandwidth
        for (const radio of Object.values(activeRadios)) {
            if (radio.isPlaying) {
                radio.changeFrequency(currentFreqHz, currentMode);
                radio.bandwidthLow  = bwl;
                radio.bandwidthHigh = bwh;
                sendTune(radio);
                if (radio._nrEngine) {
                    const bw = Math.abs(bwh - bwl);
                    const binWidth = radio.audioContext ? radio.audioContext.sampleRate / 512 : 46.875;
                    let bins = Math.ceil(bw / binWidth) + 1;
                    if (bins < 4) bins = 4; if (bins > 257) bins = 257;
                    radio._nrEngine.nbins = bins;
                    resetRadioNR(radio);
                }
            }
        }
        updateSdrLinks();
        updateBandFilterUI();
        syncModalFreqMode();
        if (!isInit) updateURL(); // don't clobber URL on page load init
    }

    slider.addEventListener('input', e => {
        const mhz = parseFloat(e.target.value);
        input.value = mhz.toFixed(6);
        applyFreq(mhz);
    });

    input.addEventListener('input', e => {
        const mhz = parseFloat(e.target.value);
        if (!isNaN(mhz)) {
            slider.value = Math.max(minFreqHz / 1e6, Math.min(maxFreqHz / 1e6, mhz));
            applyFreq(mhz);
        } else if (e.target.value === '') {
            input.classList.add('invalid');
            isFreqValid = false;
        }
    });

    // Initialise display (immediate, no debounce needed on load)
    applyFreq(parseFloat(slider.value), true);
}

// ─── Modality (Phone / CW) ───────────────────────────────────────────────────

/** Resolve the SDR mode string from current modality + frequency, respecting any user override. */
function resolveMode(mhz) {
    if (modeOverride) return modeOverride;
    if (modality === 'cw') return mhz < 10 ? 'cwl' : 'cwu';
    return mhz < 10 ? 'lsb' : 'usb';
}

/**
 * Cycle the mode indicator: USB↔LSB (phone) or CWU↔CWL (CW).
 * Sets modeOverride so the choice persists across frequency changes.
 */
function cycleMode() {
    const mhz = currentFreqHz / 1e6;
    const natural = modality === 'cw'
        ? (mhz < 10 ? 'cwl' : 'cwu')
        : (mhz < 10 ? 'lsb' : 'usb');

    // Determine current effective mode
    const effective = modeOverride || natural;

    // Toggle to the opposite sideband within the same modality
    if (modality === 'cw') {
        modeOverride = effective === 'cwu' ? 'cwl' : 'cwu';
    } else {
        modeOverride = effective === 'usb' ? 'lsb' : 'usb';
    }

    currentMode = modeOverride;

    // Update indicator + overridden styling
    const modeEl = document.getElementById('modeIndicator');
    if (modeEl) {
        modeEl.textContent = currentMode.toUpperCase();
        modeEl.classList.add('overridden');
        modeEl.title = 'Click to toggle sideband (overridden — click again to cycle)';
    }

    // Update bandwidth and retune everything
    const { bwl, bwh } = bandwidthForMode(currentMode);
    if (previewRadio) {
        previewRadio.changeFrequency(currentFreqHz, currentMode);
        previewRadio.bandwidthLow  = bwl;
        previewRadio.bandwidthHigh = bwh;
        sendTune(previewRadio);
    }
    for (const radio of Object.values(activeRadios)) {
        if (radio.isPlaying) {
            radio.changeFrequency(currentFreqHz, currentMode);
            radio.bandwidthLow  = bwl;
            radio.bandwidthHigh = bwh;
            sendTune(radio);
            if (radio._nrEngine) {
                const bw = Math.abs(bwh - bwl);
                const binWidth = radio.audioContext ? radio.audioContext.sampleRate / 512 : 46.875;
                let bins = Math.ceil(bw / binWidth) + 1;
                if (bins < 4) bins = 4; if (bins > 257) bins = 257;
                radio._nrEngine.nbins = bins;
                resetRadioNR(radio);
            }
        }
    }
    updateSdrLinks();
    syncModalFreqMode();
    updateURL();
}

window.cycleMode = cycleMode;

/** Return {bwl, bwh} for the given mode string. */
function bandwidthForMode(mode) {
    if (mode === 'cwl' || mode === 'cwu') return { bwl: -200, bwh: 200 };
    if (mode === 'lsb') return { bwl: -2700, bwh: -50 };
    return { bwl: 50, bwh: 2700 }; // usb
}

/** Sync the Phone/CW toggle button states and hint text to current modality (no retune). */
function syncModalityUI() {
    const phoneBtn = document.getElementById('modalityPhone');
    const cwBtn    = document.getElementById('modalityCW');
    if (phoneBtn) phoneBtn.classList.toggle('active', modality === 'phone');
    if (cwBtn)    cwBtn.classList.toggle('active',    modality === 'cw');
    const hint = document.getElementById('modeHint');
    if (hint) {
        if (modality === 'cw') {
            hint.textContent = 'CW: CWL < 10 MHz, CWU ≥ 10 MHz • Bandwidth: ±200 Hz';
        } else {
            hint.textContent = 'Phone: LSB < 10 MHz, USB ≥ 10 MHz • Bandwidth: 2.7 kHz';
        }
    }
}

/**
 * Switch between 'phone' and 'cw' modality.
 * Re-resolves currentMode, retuning all active radios, updates UI + links + URL.
 */
function setModality(m) {
    if (m === modality) return;  // no-op if already in this modality
    modality = m;
    modeOverride = null;         // clear any user-forced sideband when switching modality
    const mhz = currentFreqHz / 1e6;
    currentMode = resolveMode(mhz);
    const { bwl, bwh } = bandwidthForMode(currentMode);

    // Update mode indicator and clear override styling
    const modeEl = document.getElementById('modeIndicator');
    if (modeEl) {
        modeEl.textContent = currentMode.toUpperCase();
        modeEl.classList.remove('overridden');
        modeEl.title = 'Click to toggle sideband';
    }

    // Update hint text
    const hint = document.getElementById('modeHint');
    if (hint) {
        if (modality === 'cw') {
            hint.textContent = 'CW: CWL < 10 MHz, CWU ≥ 10 MHz • Bandwidth: ±200 Hz';
        } else {
            hint.textContent = 'Phone: LSB < 10 MHz, USB ≥ 10 MHz • Bandwidth: 2.7 kHz';
        }
    }

    // Update toggle button states
    const phoneBtn = document.getElementById('modalityPhone');
    const cwBtn    = document.getElementById('modalityCW');
    if (phoneBtn) phoneBtn.classList.toggle('active', modality === 'phone');
    if (cwBtn)    cwBtn.classList.toggle('active',    modality === 'cw');

    // Retune preview radio
    if (previewRadio) {
        previewRadio.changeFrequency(currentFreqHz, currentMode);
        previewRadio.bandwidthLow  = bwl;
        previewRadio.bandwidthHigh = bwh;
        sendTune(previewRadio);
    }

    // Retune all monitor radios and resync NR bin count to new bandwidth
    for (const radio of Object.values(activeRadios)) {
        radio.changeFrequency(currentFreqHz, currentMode);
        radio.bandwidthLow  = bwl;
        radio.bandwidthHigh = bwh;
        sendTune(radio);
        if (radio._nrEngine) {
            const bw = Math.abs(bwh - bwl);
            const binWidth = radio.audioContext ? radio.audioContext.sampleRate / 512 : 46.875;
            let bins = Math.ceil(bw / binWidth) + 1;
            if (bins < 4) bins = 4; if (bins > 257) bins = 257;
            radio._nrEngine.nbins = bins;
            resetRadioNR(radio);
        }
    }

    updateSdrLinks();
    syncModalFreqMode();
    updateURL();
}

window.setModality = setModality;

/** Update all "Open SDR →" links to include frequency, mode and bandwidth params. */
function updateSdrLinks() {
    const { bwl, bwh } = bandwidthForMode(currentMode);
    document.querySelectorAll('.meter-connect-link[data-base-url]').forEach(a => {
        a.href = `${a.dataset.baseUrl}?freq=${currentFreqHz}&mode=${currentMode}&bwl=${bwl}&bwh=${bwh}`;
    });
}

/**
 * Nudge the current frequency by deltaHz (e.g. -100, +500, +1000).
 * Clamps to the receiver's own range, updates the slider and input, then retunes all
 * radios. Stopping at the edge is right for a relative step — the user asked to move,
 * not to go somewhere specific — which is the same call bridge/commands.js makes.
 */
function nudgeFreq(deltaHz) {
    const slider  = document.getElementById('freqSlider');
    const input   = document.getElementById('freqInput');
    const display = document.getElementById('freqDisplay');
    const modeEl  = document.getElementById('modeIndicator');

    // Apply delta in Hz, clamp to valid range
    const newHz  = Math.max(minFreqHz, Math.min(maxFreqHz, currentFreqHz + deltaHz));
    const newMhz = newHz / 1e6;

    // Update controls
    slider.value = newMhz;
    input.value  = newMhz.toFixed(6);
    input.classList.remove('invalid');

    display.textContent = `${newMhz.toFixed(6)} MHz`;

    const mode = resolveMode(newMhz);
    modeEl.textContent = mode.toUpperCase();
    modeEl.classList.toggle('overridden', modeOverride !== null);

    currentFreqHz = newHz;
    currentMode   = mode;
    isFreqValid   = true;

    const { bwl, bwh } = bandwidthForMode(mode);

    // Retune select-phase preview radio if active
    if (previewRadio) {
        previewRadio.changeFrequency(currentFreqHz, currentMode);
        previewRadio.bandwidthLow  = bwl;
        previewRadio.bandwidthHigh = bwh;
        sendTune(previewRadio);
    }

    // Retune all monitor radios and resync NR bin count to new bandwidth
    for (const radio of Object.values(activeRadios)) {
        if (radio.isPlaying) {
            radio.changeFrequency(currentFreqHz, currentMode);
            radio.bandwidthLow  = bwl;
            radio.bandwidthHigh = bwh;
            sendTune(radio);
            if (radio._nrEngine) {
                const bw = Math.abs(bwh - bwl);
                const binWidth = radio.audioContext ? radio.audioContext.sampleRate / 512 : 46.875;
                let bins = Math.ceil(bw / binWidth) + 1;
                if (bins < 4) bins = 4; if (bins > 257) bins = 257;
                radio._nrEngine.nbins = bins;
                resetRadioNR(radio);
            }
        }
    }
    updateSdrLinks();
    updateBandFilterUI();
    syncModalFreqMode();
    updateURL();
}

window.nudgeFreq = nudgeFreq;

/**
 * Jump the preview frequency to the centre of the named band.
 */
function jumpToBand(band) {
    const range = BAND_RANGES[band];
    if (!range) return;
    const centerMhz = (range.min + range.max) / 2;
    const centerHz  = Math.round(centerMhz * 1e6);

    const slider  = document.getElementById('freqSlider');
    const input   = document.getElementById('freqInput');
    const display = document.getElementById('freqDisplay');
    const modeEl  = document.getElementById('modeIndicator');

    slider.value = centerMhz;
    input.value  = centerMhz.toFixed(6);
    input.classList.remove('invalid');
    display.textContent = `${centerMhz.toFixed(6)} MHz`;

    const mode = resolveMode(centerMhz);
    currentFreqHz = centerHz;
    currentMode   = mode;
    isFreqValid   = true;
    if (modeEl) {
        modeEl.textContent = mode.toUpperCase();
        modeEl.classList.toggle('overridden', modeOverride !== null);
    }

    const { bwl, bwh } = bandwidthForMode(mode);

    // Retune any active preview radio
    if (previewRadio) {
        previewRadio.changeFrequency(centerHz, mode);
        previewRadio.bandwidthLow  = bwl;
        previewRadio.bandwidthHigh = bwh;
        sendTune(previewRadio);
    }

    // Retune all monitor radios if in monitor phase and resync NR bin count
    for (const radio of Object.values(activeRadios)) {
        radio.changeFrequency(centerHz, mode);
        radio.bandwidthLow  = bwl;
        radio.bandwidthHigh = bwh;
        sendTune(radio);
        if (radio._nrEngine) {
            const bw = Math.abs(bwh - bwl);
            const binWidth = radio.audioContext ? radio.audioContext.sampleRate / 512 : 46.875;
            let bins = Math.ceil(bw / binWidth) + 1;
            if (bins < 4) bins = 4; if (bins > 257) bins = 257;
            radio._nrEngine.nbins = bins;
            resetRadioNR(radio);
        }
    }

    updateSdrLinks();
    updateBandFilterUI();
    syncModalFreqMode();
    updateURL();
}

window.jumpToBand = jumpToBand;

// Send a tune command to a radio with current bandwidth settings
function sendTune(radio) {
    if (radio.ws && radio.ws.readyState === WebSocket.OPEN) {
        radio.ws.send(JSON.stringify({
            type:          'tune',
            frequency:     currentFreqHz,
            mode:          currentMode,
            bandwidthLow:  radio.bandwidthLow,
            bandwidthHigh: radio.bandwidthHigh
        }));
    }
}

// ─── Instance Map ─────────────────────────────────────────────────────────────

let instanceMap        = null;
let instanceMarkerById = new Map(); // id → { marker, inst }
let mapMonitorMode     = false;     // true when showing monitored instances
let geodesicLine       = null;      // current hover great-circle polyline
let selectedGeodesicLines = new Map(); // id → L.polyline for persistent selected-instance lines
let mapTerminator      = null;      // day/night terminator layer

function initMap() {
    if (instanceMap) return; // already initialised
    instanceMap = L.map('instanceMap', { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18
    }).addTo(instanceMap);

    // Day/night terminator
    if (typeof L.terminator === 'function') {
        mapTerminator = L.terminator({ fillOpacity: 0.3, color: '#000', weight: 2 }).addTo(instanceMap);
        setInterval(() => { if (mapTerminator) mapTerminator.setTime(); }, 60000);
    }
}

function makeMarkerIcon(inst, selected, previewing = false) {
    // Determine colour based on band quality at current frequency (if in a band)
    // FT8 SNR thresholds: poor <6, fair 6-19, good 20-29, excellent ≥30
    const mhz  = currentFreqHz / 1e6;
    const band = getBandForFreq(mhz);
    let color;
    if (band && inst.band_conditions && inst.band_conditions[band] != null) {
        const snr = inst.band_conditions[band];
        color = snr >= 30 ? '#22c55e'   // excellent
              : snr >= 20 ? '#fbbf24'   // good
              : snr >= 6  ? '#ff9800'   // fair
              :             '#ef4444';  // poor
    } else {
        // No band detected — fall back to online/offline green/red
        color = inst.is_online ? '#22c55e' : '#ef4444';
    }

    const size = 12;
    // Selected: same colour dot but with a matching colour halo
    const shadow = selected
        ? `0 0 0 3px ${color}, 0 0 8px 4px ${color}88`
        : '0 1px 4px rgba(0,0,0,0.5)';

    // Speaker badge below the dot when previewing
    const speakerHtml = previewing
        ? `<div style="position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);background:white;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);font-size:9px;line-height:1;">🔊</div>`
        : '';

    return L.divIcon({
        html: `<div style="position:relative;width:${size}px;height:${size}px;">
            <div style="
                background:${color};width:${size}px;height:${size}px;
                border-radius:50%;border:2px solid white;
                box-shadow:${shadow};
            "></div>
            ${speakerHtml}
        </div>`,
        className: '',
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

/** Shared SNR → colour for monitor markers and geodesic lines. */
function monitorSnrColor(snr) {
    return snr === null || snr === undefined ? '#94a3b8'  // grey = no data
         : snr >= SNR_GREEN_DB ? '#22c55e'   // green  ≥ 15 dB
         : snr >= SNR_AMBER_DB ? '#fbbf24'   // amber 6–14 dB
         :                       '#ef4444';  // red   below 6 dB
}

function makeMonitorMarkerIcon(snr, highlighted = false, channel = null) {
    // Colour matches SNR bar thresholds (see SNR_MIN_DB)
    const color = monitorSnrColor(snr);
    // Halo: bright cyan ring + outer glow, no colour change to dot
    const shadow = highlighted
        ? '0 0 0 3px #00e5ff, 0 0 10px 5px rgba(0,229,255,0.7)'
        : '0 1px 4px rgba(0,0,0,0.4)';
    const size = highlighted ? 16 : 14;

    // Speaker badge positioned relative to the dot based on channel
    let speakerStyle = '';
    if (channel === 'left') {
        speakerStyle = 'position:absolute;left:-18px;top:50%;transform:translateY(-50%);';
    } else if (channel === 'right') {
        speakerStyle = 'position:absolute;right:-18px;top:50%;transform:translateY(-50%);';
    } else if (channel === 'both') {
        speakerStyle = 'position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);';
    }
    const speakerHtml = channel
        ? `<div style="${speakerStyle}background:white;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);font-size:9px;line-height:1;">🔊</div>`
        : '';

    return L.divIcon({
        html: `<div style="position:relative;width:${size}px;height:${size}px;">
            <div style="
                background:${color};width:${size}px;height:${size}px;
                border-radius:50%;border:2px solid white;
                box-shadow:${shadow};
            "></div>
            ${speakerHtml}
        </div>`,
        className: '',
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

function updateMarkerSignalColor(id, snr) {
    const entry = instanceMarkerById.get(id);
    if (!entry || !mapMonitorMode) return;
    entry.snr = snr; // store latest SNR for halo/channel rebuilds
    entry.marker.setIcon(makeMonitorMarkerIcon(snr, entry.highlighted || false, entry.channel || null));
    // Update the geodesic line colour to match the marker
    const line = selectedGeodesicLines.get(id);
    if (line) {
        line.setStyle({ color: monitorSnrColor(snr) });
    }
}

function updateMarkerChannel(id, channel) {
    const entry = instanceMarkerById.get(id);
    if (!entry || !mapMonitorMode) return;
    entry.channel = channel; // null | 'left' | 'right' | 'both'
    entry.marker.setIcon(makeMonitorMarkerIcon(entry.snr ?? null, entry.highlighted || false, channel));
}

function refreshMapSelection() {
    instanceMarkerById.forEach(({ marker, inst }) => {
        const isSelected  = selectedIds.has(inst.id);
        const isPreviewing = inst.id === previewId;
        marker.setIcon(makeMarkerIcon(inst, isSelected, isPreviewing));

        // Update tooltip permanent state and content when selection changes
        const isPermanent = isSelected;
        marker.unbindTooltip();
        let tooltipContent;
        if (isPermanent) {
            tooltipContent = `<strong>${escHtml(inst.callsign)}</strong>`;
        } else {
            let distHtml = '';
            if (userLocation && inst.latitude != null && inst.longitude != null) {
                const km = haversineKm(userLocation.latitude, userLocation.longitude, inst.latitude, inst.longitude);
                distHtml = ` <span style="font-size:0.82em;font-weight:normal;opacity:0.8">${formatDistKm(km)}</span>`;
            }
            tooltipContent = `<strong>${escHtml(inst.callsign)}</strong>${distHtml}<br>${escHtml(inst.location)}`;
        }
        marker.bindTooltip(tooltipContent, {
            direction: 'top',
            offset: [0, -10],
            permanent: isPermanent
        });
    });

    // Redraw persistent geodesic lines for selected instances
    updateSelectedGeodesicLines();
}

/**
 * Draw persistent great-circle lines from the user to each selected instance.
 * Removes lines for deselected instances. No-op if user location is unknown.
 */
function updateSelectedGeodesicLines() {
    if (!instanceMap) return;

    // Remove lines for instances that are no longer selected
    selectedGeodesicLines.forEach((line, id) => {
        if (!selectedIds.has(id)) {
            instanceMap.removeLayer(line);
            selectedGeodesicLines.delete(id);
        }
    });

    if (!userLocation) return;

    // Add lines for newly selected instances
    selectedIds.forEach(id => {
        if (selectedGeodesicLines.has(id)) return; // already drawn
        const entry = instanceMarkerById.get(id);
        if (!entry || entry.inst.latitude == null || entry.inst.longitude == null) return;
        const pts = greatCirclePoints(
            userLocation.latitude, userLocation.longitude,
            entry.inst.latitude,  entry.inst.longitude
        );
        const line = L.polyline(pts, {
            color:     '#3b82f6',
            weight:    2,
            opacity:   0.5,
            dashArray: '6 4',
            interactive: false
        }).addTo(instanceMap);
        selectedGeodesicLines.set(id, line);
    });
}

/**
 * Generate N+1 lat/lon points along the great-circle arc between two points.
 * Uses spherical linear interpolation (slerp) in 3D then converts back to lat/lon.
 */
function greatCirclePoints(lat1, lon1, lat2, lon2, n = 50) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    const φ1 = toRad(lat1), λ1 = toRad(lon1);
    const φ2 = toRad(lat2), λ2 = toRad(lon2);

    // Convert to unit 3D vectors
    const x1 = Math.cos(φ1) * Math.cos(λ1), y1 = Math.cos(φ1) * Math.sin(λ1), z1 = Math.sin(φ1);
    const x2 = Math.cos(φ2) * Math.cos(λ2), y2 = Math.cos(φ2) * Math.sin(λ2), z2 = Math.sin(φ2);

    // Angular distance between the two points
    const dot = Math.min(1, Math.max(-1, x1*x2 + y1*y2 + z1*z2));
    const omega = Math.acos(dot);

    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        let x, y, z;
        if (omega < 1e-10) {
            x = x1; y = y1; z = z1;
        } else {
            const s = Math.sin(omega);
            const a = Math.sin((1 - t) * omega) / s;
            const b = Math.sin(t * omega) / s;
            x = a * x1 + b * x2;
            y = a * y1 + b * y2;
            z = a * z1 + b * z2;
        }
        pts.push([toDeg(Math.asin(z)), toDeg(Math.atan2(y, x))]);
    }
    return pts;
}

function highlightMapMarker(id, open) {
    const entry = instanceMarkerById.get(id);
    if (!entry) return;
    if (mapMonitorMode) {
        // In monitor mode: apply/remove halo without changing dot colour or tooltip
        entry.highlighted = open;
        entry.marker.setIcon(makeMonitorMarkerIcon(entry.snr ?? null, open, entry.channel || null));
    } else {
        // Only open/close hover tooltip if the marker doesn't have a permanent tooltip
        // (selected markers have permanent callsign tooltips that must not be closed)
        const hasPermanent = selectedIds.has(id);
        if (open) entry.marker.openTooltip();
        else if (!hasPermanent) entry.marker.closeTooltip();

        // Draw / remove geodesic line from user to instance (select phase only)
        if (geodesicLine) {
            instanceMap.removeLayer(geodesicLine);
            geodesicLine = null;
        }
        if (open && userLocation && entry.inst.latitude != null && entry.inst.longitude != null) {
            const pts = greatCirclePoints(
                userLocation.latitude, userLocation.longitude,
                entry.inst.latitude,  entry.inst.longitude
            );
            geodesicLine = L.polyline(pts, {
                color:     '#3b82f6',
                weight:    2.5,
                opacity:   0.7,
                dashArray: '6 4',
                interactive: false
            }).addTo(instanceMap);
        }
    }
}

// The instances the map is currently drawn for, and the mode it drew them in.
//
// updateMap rebuilds every marker and then fits the view to them, which is right
// when the set of stations has changed and wrong when it has not: selecting one
// goes through renderSelectGrid, which calls updateMap, which refits — so a
// click on a marker selected the station and then immediately zoomed back out to
// show all of them, throwing away wherever you had panned to find it.
//
// Refitting is therefore conditional on the set actually being different. The
// markers are still rebuilt either way; it is only the view that is left alone,
// because the view is the operator's.
let mapFittedFor = '';
const mapSignature = (instances, monitorMode) =>
    `${monitorMode ? 'm' : 's'}:${instances.map((i) => i.id).sort().join(',')}`;

function updateMap(instances, monitorMode = false) {
    if (!instanceMap) initMap();
    mapMonitorMode = monitorMode;

    const signature = mapSignature(instances, monitorMode);
    const refit = signature !== mapFittedFor;
    mapFittedFor = signature;

    // Remove old instance markers and any persistent geodesic lines
    instanceMarkerById.forEach(({ marker }) => marker.remove());
    instanceMarkerById = new Map();
    selectedGeodesicLines.forEach(line => instanceMap.removeLayer(line));
    selectedGeodesicLines = new Map();
    if (geodesicLine) { instanceMap.removeLayer(geodesicLine); geodesicLine = null; }

    // Place / refresh user location marker
    placeUserMarker();

    const validInsts = instances.filter(inst =>
        inst.latitude != null && inst.longitude != null &&
        !isNaN(inst.latitude) && !isNaN(inst.longitude)
    );

    if (validInsts.length === 0) return;

    const bounds = [];

    // Include user location in bounds so it's visible
    if (userLocation) {
        bounds.push([userLocation.latitude, userLocation.longitude]);
    }

    validInsts.forEach(inst => {
        const icon = monitorMode
            ? makeMonitorMarkerIcon(null)          // grey until first SNR reading
            : makeMarkerIcon(inst, selectedIds.has(inst.id));

        const isSelected = selectedIds.has(inst.id);
        const isPermanent = monitorMode || isSelected;

        let tooltipContent;
        if (monitorMode || isSelected) {
            // Permanent tooltip: callsign only
            tooltipContent = `<strong>${escHtml(inst.callsign)}</strong>`;
        } else {
            let distHtml = '';
            if (userLocation && inst.latitude != null && inst.longitude != null) {
                const km = haversineKm(userLocation.latitude, userLocation.longitude, inst.latitude, inst.longitude);
                distHtml = ` <span style="font-size:0.82em;font-weight:normal;opacity:0.8">${formatDistKm(km)}</span>`;
            }
            tooltipContent = `<strong>${escHtml(inst.callsign)}</strong>${distHtml}<br>${escHtml(inst.location)}`;
        }

        const marker = L.marker([inst.latitude, inst.longitude], { icon })
            .bindTooltip(tooltipContent, {
                direction: 'top',
                offset: [0, -10],
                permanent: isPermanent
            })
            .addTo(instanceMap);

        // Click on marker → toggle selection (only in select phase)
        marker.on('click', () => {
            if (document.getElementById('phase-select').style.display !== 'none') {
                toggleSelect(inst.id);
            }
        });

        // Hover on marker → geodesic line + card highlight (select phase only)
        if (!monitorMode) {
            marker.on('mouseover', () => {
                highlightMapMarker(inst.id, true);
                highlightSelectCard(inst.id, true);
            });
            marker.on('mouseout', () => {
                highlightMapMarker(inst.id, false);
                highlightSelectCard(inst.id, false);
            });
        }

        instanceMarkerById.set(inst.id, { marker, inst });
        bounds.push([inst.latitude, inst.longitude]);
    });

    // Draw persistent geodesic lines from user to each instance
    updateSelectedGeodesicLines();

    // Invalidate size first (layout may have just changed), then fit bounds —
    // but only when the stations on the map have changed. See mapFittedFor.
    setTimeout(() => {
        instanceMap.invalidateSize();
        if (!refit) return;
        if (bounds.length === 1) {
            instanceMap.setView(bounds[0], 6);
        } else {
            instanceMap.fitBounds(bounds, { padding: [50, 60], maxZoom: 10 });
        }
    }, 50);
}

function attachMapHoverHandlers(container) {
    // Only match top-level cards/tiles (select-card or meter-tile), not nested buttons
    container.querySelectorAll('.select-card[data-id], .meter-tile[data-id]').forEach(el => {
        const id = el.dataset.id;
        el.addEventListener('mouseenter', () => highlightMapMarker(id, true));
        el.addEventListener('mouseleave', () => highlightMapMarker(id, false));
    });
}

/**
 * Add/remove the .map-hover highlight class on a select-card when the
 * corresponding map marker is hovered.
 */
function highlightSelectCard(id, on) {
    const card = document.querySelector(`#selectGrid .select-card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    if (on) {
        card.classList.add('map-hover');
    } else {
        card.classList.remove('map-hover');
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Audio Output Device ──────────────────────────────────────────────────────

let selectedOutputDeviceId = '';  // '' = system default

/** Toggle the custom audio output dropdown open/closed. */
function toggleAudioOutputDropdown() {
    const wrap = document.getElementById('audio-output-wrap');
    if (!wrap) return;
    const isOpen = wrap.classList.toggle('open');
    if (isOpen) {
        // Close when clicking outside
        const handler = e => {
            if (!wrap.contains(e.target)) {
                wrap.classList.remove('open');
                document.removeEventListener('click', handler, true);
            }
        };
        document.addEventListener('click', handler, true);
    }
}

/**
 * Enumerate audiooutput devices and populate the custom dropdown.
 * Only called when setSinkId is supported (Chrome/Edge 110+).
 */
async function populateOutputDevices() {
    const list = document.getElementById('audio-output-list');
    if (!list) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        list.innerHTML = '';
        // Default item
        const defItem = document.createElement('div');
        defItem.className = 'audio-output-item' + (selectedOutputDeviceId === '' ? ' selected' : '');
        defItem.dataset.deviceId = '';
        defItem.textContent = '🔊 Default';
        defItem.addEventListener('click', () => selectOutputDevice('', '🔊 Default'));
        list.appendChild(defItem);

        for (const dev of outputs) {
            const label = dev.label || `Output ${dev.deviceId.slice(0, 8)}…`;
            const item = document.createElement('div');
            item.className = 'audio-output-item' + (dev.deviceId === selectedOutputDeviceId ? ' selected' : '');
            item.dataset.deviceId = dev.deviceId;
            item.textContent = label;
            item.addEventListener('click', () => selectOutputDevice(dev.deviceId, label));
            list.appendChild(item);
        }
    } catch (err) {
        console.warn('[AudioOutput] enumerateDevices failed:', err);
    }
}

/** Handle selection of an output device from the custom dropdown. */
async function selectOutputDevice(deviceId, label) {
    // Update button label
    const btnLabel = document.getElementById('audio-output-label');
    if (btnLabel) btnLabel.textContent = label;

    // Update selected state in list
    document.querySelectorAll('#audio-output-list .audio-output-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.deviceId === deviceId);
    });

    // Close dropdown
    const wrap = document.getElementById('audio-output-wrap');
    if (wrap) wrap.classList.remove('open');

    // Route audio
    await setOutputDevice(deviceId);
}

/**
 * Route all active AudioContexts (and future ones) to the chosen device.
 * deviceId = '' means system default.
 */
async function setOutputDevice(deviceId) {
    selectedOutputDeviceId = deviceId;
    const radios = [
        ...Object.values(activeRadios),
        ...(previewRadio ? [previewRadio] : [])
    ];
    for (const radio of radios) {
        if (radio.audioContext && 'setSinkId' in radio.audioContext) {
            try {
                await radio.audioContext.setSinkId(deviceId || 'default');
            } catch (err) {
                console.warn('[AudioOutput] setSinkId failed:', err);
            }
        }
    }
}

/**
 * Patch a MinimalRadio instance so that when its AudioContext is created
 * it immediately routes to the user-selected output device.
 */
function patchRadioOutputDevice(radio) {
    const _origInit = radio.initializeAudio.bind(radio);
    radio.initializeAudio = async function(sampleRate) {
        await _origInit(sampleRate);
        if (selectedOutputDeviceId && this.audioContext && 'setSinkId' in this.audioContext) {
            try {
                await this.audioContext.setSinkId(selectedOutputDeviceId);
            } catch (err) {
                console.warn('[AudioOutput] setSinkId on new context failed:', err);
            }
        }
    };
}

/**
 * Show the output device selector and populate it.
 * Called once when monitoring starts.
 * Only runs on browsers that support AudioContext.setSinkId (Chrome/Edge).
 * Requests audio permission first so that device labels are available.
 */
async function initOutputDeviceSelector() {
    // setSinkId on AudioContext is only supported in Chromium-based browsers.
    // Skip entirely on Firefox, Safari, and other unsupported browsers.
    const testCtx = typeof AudioContext !== 'undefined' ? new AudioContext() : null;
    const supported = testCtx && 'setSinkId' in testCtx;
    if (testCtx) testCtx.close();
    if (!supported) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    // Request microphone permission so the browser exposes labelled device names.
    // We immediately stop the stream — we only need the permission grant.
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
    } catch (err) {
        // Permission denied or not available — device labels may be empty, but
        // we can still show the selector with generic names.
        console.warn('[AudioOutput] getUserMedia permission request failed:', err);
    }

    const wrap = document.getElementById('audio-output-wrap');
    if (wrap) wrap.style.display = 'flex';
    await populateOutputDevices();
    // Re-populate if devices change (e.g. headphones plugged in)
    if (navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', populateOutputDevices);
    }
}

window.populateOutputDevices = populateOutputDevices;
window.setOutputDevice = setOutputDevice;
window.toggleAudioOutputDropdown = toggleAudioOutputDropdown;

// ─── SNR History Modal ────────────────────────────────────────────────────────

let snrHistoryChart = null;       // Chart.js instance for the combined modal chart
let snrModalUpdateTimer = null;   // setInterval handle while modal is open
// Smooth-scroll state. Each point is plotted at its absolute arrival time
// (performance.now()), and the x axis window is slid every animation frame. Because
// positions come from the wall clock rather than a sample counter, jitter in the
// push cadence can't stall or snap the trace — it just scrolls at a steady 1 ms/ms.
let snrChartRafId   = null;       // requestAnimationFrame handle while modal is open
let snrChartLastIdx = {};         // instanceId → last seen historyIndex (to detect new samples)
// The right edge lags real time by this much, so the newest sample is always already
// in the buffer by the time its position scrolls into view. Must exceed the worst-case
// gap between pushes (the relay path gates ~50 Hz frames through a 100 ms throttle,
// so real spacing lands at 100–140 ms); otherwise the trace pops in at the edge.
const SNR_CHART_LAG_MS = 300;
// Visible time span. The buffer holds HISTORY_SAMPLES samples spaced at least
// METER_UPDATE_INTERVAL apart, so in the worst (fastest) case it only covers
// (HISTORY_SAMPLES - 1) * METER_UPDATE_INTERVAL ms. The window must be that span minus
// the right-edge lag — which shifts the whole trace right — or the oldest sample stops
// short of the left axis. One extra sample of slack keeps it there through timing jitter.
const SNR_CHART_WINDOW_MS =
    (HISTORY_SAMPLES - 2) * METER_UPDATE_INTERVAL - SNR_CHART_LAG_MS;
let snrHighlightEnabled  = true;   // whether to highlight the best-SNR dataset
let playBestEnabled      = true;   // whether to auto-route audio to the best-SNR instance
let playBestCurrentId    = null;   // instance ID currently playing under "play best"
// Candidate debounce: a new best must hold the top position for playBestHoldTicks
// consecutive ticks before the switch is committed. Default 2 s (20 × 100 ms).
// Adjustable via the dropdown in the Smart Listen modal.
let playBestHoldTicks = 20;
let playBestCandidateId    = null; // instance ID that is currently the best but not yet committed
let playBestCandidateTicks = 0;    // how many consecutive ticks the candidate has been best

// Highlight best debounce — mirrors play best logic exactly (2 s hold before switching)
let highlightBestCurrentId    = null; // instance ID currently highlighted
let highlightBestCandidateId    = null;
let highlightBestCandidateTicks = 0;

// Best-time counters: track how many ticks each instance has been "play best"
// These accumulate for the lifetime of the monitoring session (reset on stopMonitoring).
let playBestTicks      = {};   // instanceId → number of ticks as play-best

// Distinct colours for up to 5 instances
const SNR_HISTORY_COLORS = [
    { border: 'rgba(96,  165, 250, 0.9)',  bg: 'rgba(96,  165, 250, 0.12)' },  // blue
    { border: 'rgba(34,  197,  94, 0.9)',  bg: 'rgba(34,  197,  94, 0.12)' },  // green
    { border: 'rgba(251, 191,  36, 0.9)',  bg: 'rgba(251, 191,  36, 0.12)' },  // amber
    { border: 'rgba(239,  68,  68, 0.9)',  bg: 'rgba(239,  68,  68, 0.12)' },  // red
    { border: 'rgba(167, 139, 250, 0.9)',  bg: 'rgba(167, 139, 250, 0.12)' },  // purple
];

/**
 * Sync the in-modal frequency/mode controls to the current global state.
 * Called whenever freq, mode, or modality changes while the modal is open,
 * and also when the modal is first opened.
 */
function syncModalFreqMode() {
    const mhz = currentFreqHz / 1e6;

    // Frequency display + input
    const display = document.getElementById('snrModalFreqDisplay');
    if (display) display.textContent = `${mhz.toFixed(6)} MHz`;

    const input = document.getElementById('snrModalFreqInput');
    if (input && document.activeElement !== input) {
        input.value = mhz.toFixed(6);
        input.classList.remove('invalid');
    }

    // Mode button
    const modeBtn = document.getElementById('snrModalModeBtn');
    if (modeBtn) {
        modeBtn.textContent = currentMode.toUpperCase();
        modeBtn.classList.toggle('overridden', modeOverride !== null);
        modeBtn.title = modeOverride
            ? 'Click to toggle sideband (overridden)'
            : 'Click to toggle sideband';
    }

    // Modality toggle
    const phoneBtn = document.getElementById('snrModalModalityPhone');
    const cwBtn    = document.getElementById('snrModalModalityCW');
    if (phoneBtn) phoneBtn.classList.toggle('active', modality === 'phone');
    if (cwBtn)    cwBtn.classList.toggle('active',    modality === 'cw');

    // Band jump button highlight
    const band = getBandForFreq(mhz);
    document.querySelectorAll('.snr-modal-band-btn').forEach(btn => {
        btn.classList.toggle('active-band', btn.textContent.trim() === band);
    });
}

/** Open the SNR history modal and start live updates. */
function openSnrHistoryModal() {
    const overlay = document.getElementById('snrModalOverlay');
    if (!overlay) return;
    overlay.classList.add('open');
    updateURL(); // add smart=1 to URL

    // Show audio-unlock overlay if any AudioContext is suspended (browser autoplay policy).
    // This happens when the modal is opened automatically via ?smart=1 URL restore with no
    // prior user gesture — the AudioContext is created but stays suspended until a click.
    const unlockOverlay = document.getElementById('audioUnlockOverlay');
    if (unlockOverlay) {
        const suspended = Object.values(activeRadios).some(
            r => r.audioContext && r.audioContext.state === 'suspended'
        );
        unlockOverlay.style.display = suspended ? 'flex' : 'none';
    }

    // Update modal title with current frequency and mode
    const freqModeSpan = document.getElementById('snrModalFreqMode');
    if (freqModeSpan) {
        const mhz = (currentFreqHz / 1e6).toFixed(6) + ' MHz';
        freqModeSpan.textContent = `${mhz} · ${currentMode.toUpperCase()}`;
    }

    // Sync in-modal freq/mode controls
    syncModalFreqMode();

    // Sync checkboxes to current state (they persist across open/close)
    const playBestChk = document.getElementById('snrPlayBestToggle');
    if (playBestChk) playBestChk.checked = playBestEnabled;

    // Reset play-best routing state so re-opening triggers a fresh immediate assignment
    // (the chart is rebuilt, so dataset meta / hidden state is also fresh)
    if (playBestEnabled) {
        const _isFollower = typeof isFollowerMode !== 'undefined' && isFollowerMode;
        if (_isFollower) {
            // Mute all follower players via relay pan
            if (typeof _followerRelay !== 'undefined' && _followerRelay) {
                for (const id of (selectedIds || [])) {
                    _followerRelay.setInstancePan(id, null);
                }
            }
        } else {
            for (const radio of Object.values(activeRadios)) radio.currentVolume = 0;
        }
        leftChannelId          = null;
        rightChannelId         = null;
        playBestCurrentId      = null;
        playBestCandidateId    = null;
        playBestCandidateTicks = 0;
        updateChannelUI();
    }

    // Reset highlight-best debounce state
    highlightBestCurrentId      = null;
    highlightBestCandidateId    = null;
    highlightBestCandidateTicks = 0;

    // Reset best-time counters each time the modal is opened so bars start fresh
    playBestTicks = {};
    for (const id of Object.keys(snrHistory)) {
        playBestTicks[id] = 0;
    }

    // Apply play-best synchronously while still inside the user gesture (click),
    // so AudioContext.resume() is allowed by the browser autoplay policy.
    if (playBestEnabled) applyPlayBest();

    // Defer chart build one frame so the modal has layout before Chart.js measures the wrapper
    requestAnimationFrame(() => {
        buildSnrHistoryChart();
        // Re-apply now that the chart exists so dataset visibility is respected
        if (playBestEnabled) applyPlayBest();
        // Refresh the chart at the same cadence as the meter tiles
        if (snrModalUpdateTimer) clearInterval(snrModalUpdateTimer);
        snrModalUpdateTimer = setInterval(updateSnrHistoryChart, METER_UPDATE_INTERVAL);
    });
}

/** Close the modal and stop live updates. */
function closeSnrHistoryModal() {
    const overlay = document.getElementById('snrModalOverlay');
    if (overlay) overlay.classList.remove('open');
    if (snrModalUpdateTimer) { clearInterval(snrModalUpdateTimer); snrModalUpdateTimer = null; }
    // Smart Listen stops ticking here, so nothing would ever release a pending
    // candidate — whatever it last picked keeps playing on its own volume.
    setPlayBestPreUnmute(null);
    stopSnrChartLoop();
    updateURL(); // remove smart=1 from URL
}

/** Close when clicking the backdrop (not the modal box itself). */
function snrModalOverlayClick(e) {
    if (e.target === document.getElementById('snrModalOverlay')) {
        closeSnrHistoryModal();
    }
}

/** Build (or rebuild) the combined Chart.js chart from current snrHistory buffers. */
function buildSnrHistoryChart() {
    const canvas = document.getElementById('snrHistoryChart');
    if (!canvas || typeof Chart === 'undefined') return;

    // Destroy any existing chart first
    if (snrHistoryChart) { snrHistoryChart.destroy(); snrHistoryChart = null; }

    // Set canvas dimensions explicitly from the wrapper so Chart.js respects the height
    const wrap = canvas.parentElement;
    if (wrap) {
        canvas.style.width  = '100%';
        canvas.style.height = wrap.clientHeight + 'px';
    }

    const ids = Object.keys(snrHistory);
    if (ids.length === 0) return;

    // Reset smooth-scroll tracking so the first frame rebuilds every series
    snrChartLastIdx = {};
    const nowMs = performance.now();

    // Determine which instance has the highest 1-second moving-average SNR for initial highlight
    let initBestIdx = -1;
    let initBestSnr = -Infinity;
    if (snrHighlightEnabled) {
        ids.forEach((id, idx) => {
            if (!snrHistory[id]) return;
            const avg = movingAvgSnr(snrHistory[id], historyIndex[id]);
            if (avg !== null && avg > initBestSnr) {
                initBestSnr = avg;
                initBestIdx = idx;
            }
        });
    }

    const datasets = ids.map((id, idx) => {
        const inst       = allInstances.find(i => i.id === id);
        const baseLabel  = inst ? inst.callsign : id;
        const label      = (playBestEnabled && id === playBestCurrentId) ? `🔊 ${baseLabel}` : baseLabel;
        const color      = SNR_HISTORY_COLORS[idx % SNR_HISTORY_COLORS.length];
        const isBest     = snrHighlightEnabled && idx === initBestIdx && initBestIdx !== -1;
        return {
            label,
            _baseLabel: baseLabel,
            // {x, y} points where x is the sample's absolute arrival time in ms
            data: buildSnrPoints(id),
            borderColor:     isBest ? color.border.replace(/[\d.]+\)$/, '1)')  : color.border,
            backgroundColor: isBest ? color.bg.replace(/[\d.]+\)$/, '0.25)')   : color.bg,
            borderWidth: isBest ? 3 : 2,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            spanGaps: false,
        };
    });

    snrHistoryChart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,      // data is already {x, y} — skip per-frame parsing
            normalized: true,    // points are sorted ascending by x
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: 'rgba(255,255,255,0.85)',
                        font: { size: 12 },
                        boxWidth: 14,
                    }
                },
                tooltip: {
                    enabled: true,
                    callbacks: {
                        title: items => `${((items[0].parsed.x - snrHistoryChart.scales.x.max) / 1000).toFixed(1)}s`,
                        label: item  => item.parsed.y !== null
                            ? `${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB SNR`
                            : `${item.dataset.label}: No data`
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    display: true,
                    // Window is set every frame by renderSnrChartFrame()
                    min: nowMs - SNR_CHART_LAG_MS - SNR_CHART_WINDOW_MS,
                    max: nowMs - SNR_CHART_LAG_MS,
                    // Ticks are pinned to whole seconds behind the right edge, so the
                    // gridlines hold still at fixed pixels while the data slides past.
                    afterBuildTicks: axis => {
                        const ticks = [];
                        // Whole seconds only — the window isn't an exact multiple of 1 s,
                        // so the trace runs slightly past the leftmost gridline.
                        for (let s = Math.floor(SNR_CHART_WINDOW_MS / 1000); s >= 0; s--) {
                            ticks.push({ value: axis.max - s * 1000 });
                        }
                        axis.ticks = ticks;
                    },
                    ticks: {
                        color: 'rgba(255,255,255,0.45)',
                        font: { size: 10 },
                        // Label relative to the right edge: -10s … 0s
                        callback: function (v) { return `${Math.round((v - this.max) / 1000)}s`; }
                    },
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    border: { display: false }
                },
                y: {
                    display: true,
                    // The Smart Listen traces are SNR in dB (see SNR_MIN_DB).
                    // This axis was 10-80 while the figure was S/N0 in dB·Hz —
                    // roughly 34 dB higher on a 2.65 kHz filter — which left
                    // every trace pinned below the bottom gridline once
                    // MinimalRadio started reporting a real SNR.
                    min: SNR_MIN_DB,
                    max: SNR_MAX_DB,
                    title: {
                        display: true,
                        text: 'SNR (dB)',
                        color: 'rgba(255,255,255,0.6)',
                        font: { size: 11 }
                    },
                    ticks: {
                        color: 'rgba(255,255,255,0.45)',
                        font: { size: 10 },
                        maxTicksLimit: 6,
                        callback: v => `${v} dB`
                    },
                    grid: { color: 'rgba(255,255,255,0.08)' },
                    border: { display: false }
                }
            }
        }
    });

    // Render the best-time bars immediately so they appear as soon as the modal opens
    renderBestTimeBars();

    // Start the smooth-scroll render loop
    startSnrChartLoop();
}

/**
 * Build the {x, y} point array for one instance from its ring buffers, oldest first.
 * x is the sample's absolute arrival time (performance.now() ms), y its SNR.
 * Slots that have never been written carry x = 0 / y = null: they sort ahead of real
 * samples (keeping the array ascending for `normalized`) and draw nothing.
 */
function buildSnrPoints(id) {
    const buf   = snrHistory[id];
    const times = historyTime[id];
    const next  = historyIndex[id];
    const pts   = new Array(HISTORY_SAMPLES);
    for (let i = 0; i < HISTORY_SAMPLES; i++) {
        const k = (next + i) % HISTORY_SAMPLES;
        pts[i] = { x: times ? times[k] : 0, y: buf[k] };
    }
    return pts;
}

/**
 * Slide the x-axis window to follow the wall clock. Called once per animation frame,
 * so the trace scrolls at display refresh rate instead of stepping once per sample.
 * Point coordinates are absolute times and only change when a new sample lands, which
 * keeps the per-frame work down to moving two numbers.
 */
function renderSnrChartFrame() {
    if (!snrHistoryChart) return;

    const ids = Object.keys(snrHistory);

    // Rebuild a series' points only when its ring buffer has actually advanced
    snrHistoryChart.data.datasets.forEach((ds, idx) => {
        const id = ids[idx];
        if (!id || !snrHistory[id]) return;
        const next = historyIndex[id];
        if (snrChartLastIdx[id] !== next) {
            snrChartLastIdx[id] = next;
            ds.data = buildSnrPoints(id);
        }
    });

    // Right edge trails real time by SNR_CHART_LAG_MS so samples are always in hand
    const right = performance.now() - SNR_CHART_LAG_MS;
    snrHistoryChart.options.scales.x.min = right - SNR_CHART_WINDOW_MS;
    snrHistoryChart.options.scales.x.max = right;

    snrHistoryChart.update('none');
}

/** Start (or restart) the per-frame chart render loop. */
function startSnrChartLoop() {
    stopSnrChartLoop();
    const tick = () => {
        if (!snrHistoryChart) { snrChartRafId = null; return; }
        renderSnrChartFrame();
        snrChartRafId = requestAnimationFrame(tick);
    };
    snrChartRafId = requestAnimationFrame(tick);
}

/** Stop the per-frame chart render loop. */
function stopSnrChartLoop() {
    if (snrChartRafId !== null) { cancelAnimationFrame(snrChartRafId); snrChartRafId = null; }
}

/** Push the latest SNR samples into the combined chart without rebuilding it.
 *  Also highlights the dataset with the highest current SNR value using the
 *  same 2-second debounce logic as "play best". */
function updateSnrHistoryChart() {
    if (!snrHistoryChart) return;

    // Keep modal title + in-modal freq/mode controls in sync
    const _freqModeSpan = document.getElementById('snrModalFreqMode');
    if (_freqModeSpan) {
        _freqModeSpan.textContent = (currentFreqHz / 1e6).toFixed(6) + ' MHz · ' + currentMode.toUpperCase();
    }
    syncModalFreqMode();

    const ids = Object.keys(snrHistory);

    // Find the instance with the highest 1-second moving-average SNR (raw candidate).
    // Datasets hidden via legend click are excluded from consideration.
    let rawBestId  = null;
    if (snrHighlightEnabled) {
        let bestSnr = -Infinity;
        ids.forEach((id, idx) => {
            if (!snrHistory[id]) return;
            if (snrHistoryChart.getDatasetMeta(idx).hidden) return;
            const avg = movingAvgSnr(snrHistory[id], historyIndex[id]);
            if (avg !== null && avg > bestSnr) {
                bestSnr = avg;
                rawBestId = id;
            }
        });
    }

    // Apply the same debounce as applyPlayBest:
    // first assignment is immediate; subsequent switches require playBestHoldTicks ticks.
    if (rawBestId !== null) {
        if (highlightBestCurrentId === null) {
            // First assignment — commit immediately
            highlightBestCurrentId      = rawBestId;
            highlightBestCandidateId    = null;
            highlightBestCandidateTicks = 0;
        } else if (rawBestId === highlightBestCurrentId) {
            // Still the same best — reset candidate
            highlightBestCandidateId    = null;
            highlightBestCandidateTicks = 0;
        } else {
            // Different candidate — track hold ticks
            if (rawBestId === highlightBestCandidateId) {
                highlightBestCandidateTicks++;
            } else {
                highlightBestCandidateId    = rawBestId;
                highlightBestCandidateTicks = 1;
            }
            // Commit only after holding for the configured hold time
            if (highlightBestCandidateTicks >= playBestHoldTicks) {
                highlightBestCurrentId      = highlightBestCandidateId;
                highlightBestCandidateId    = null;
                highlightBestCandidateTicks = 0;
            }
        }
    } else {
        // No visible candidate
        highlightBestCurrentId      = null;
        highlightBestCandidateId    = null;
        highlightBestCandidateTicks = 0;
    }

    // bestIdx is the chart dataset index for the committed highlight
    const bestIdx = snrHighlightEnabled && highlightBestCurrentId !== null
        ? ids.indexOf(highlightBestCurrentId)
        : -1;

    snrHistoryChart.data.datasets.forEach((ds, idx) => {
        const id = ids[idx];
        if (!id || !snrHistory[id]) return;
        // ds.data is refreshed every animation frame by renderSnrChartFrame()

        // Update legend label: prepend 🔊 for the currently-playing instance
        const baseLabel = ds._baseLabel || (allInstances.find(i => i.id === id)?.callsign ?? id);
        ds._baseLabel = baseLabel;
        ds.label = (playBestEnabled && id === playBestCurrentId) ? `🔊 ${baseLabel}` : baseLabel;

        const baseColor = SNR_HISTORY_COLORS[idx % SNR_HISTORY_COLORS.length];
        const isBest = snrHighlightEnabled && idx === bestIdx && bestIdx !== -1;

        if (isBest) {
            ds.borderWidth = 3;
            ds.borderColor = baseColor.border.replace(/[\d.]+\)$/, '1)');
            ds.backgroundColor = baseColor.bg.replace(/[\d.]+\)$/, '0.25)');
        } else {
            // When highlight off: restore full base colours; when on: dim others
            ds.borderWidth = snrHighlightEnabled ? 1.5 : 2;
            ds.borderColor = snrHighlightEnabled
                ? baseColor.border.replace(/[\d.]+\)$/, '0.35)')
                : baseColor.border;
            ds.backgroundColor = snrHighlightEnabled
                ? baseColor.bg.replace(/[\d.]+\)$/, '0.05)')
                : baseColor.bg;
        }
    });

    // No update() here — the rAF loop repaints every frame

    // Auto-route audio to the best instance if "play best" is active
    applyPlayBest();

    // Update the best-time bar graphs
    renderBestTimeBars();
}

/**
 * Toggle the "highlight best SNR" feature on/off.
 * Called by the checkbox in the modal header.
 */
function toggleSnrHighlight(enabled) {
    snrHighlightEnabled = enabled;
    // Immediately re-render with the new setting
    updateSnrHistoryChart();
}

window.toggleSnrHighlight = toggleSnrHighlight;

/**
 * Toggle "play best" mode on/off.
 * When enabled, the instance with the highest 1-second moving-average SNR is
 * automatically routed to both ears (L+R); all others are muted.
 * When disabled, all instances are muted and channel assignments are cleared.
 */
function togglePlayBest(enabled) {
    playBestEnabled = enabled;
    if (!enabled) {
        // Mute everything and clear all play-best state
        stopAllAudio();
        playBestCurrentId      = null;
        playBestCandidateId    = null;
        playBestCandidateTicks = 0;
    } else {
        // Immediately apply so there's no delay
        applyPlayBest();
    }
}

/**
 * Route audio to the instance with the highest moving-average SNR.
 * The very first assignment (nothing currently playing) is committed immediately.
 * Subsequent switches require the new best to hold the top position for
 * playBestHoldTicks consecutive ticks to prevent rapid churn.
 * Instances hidden via legend click in the SNR chart are excluded.
 * Called on every chart update tick while playBestEnabled is true.
 *
 * Wraps the routing decision so the pending candidate can be unmuted at the
 * server while it serves out its hold time — by the time the switch commits its
 * audio is already arriving, and the NR engine has had the hold period of real
 * signal to adapt to.  The candidate is released whenever it stops being one,
 * including on every path that clears play-best state.
 */
function applyPlayBest() {
    applyPlayBestRouting();
    setPlayBestPreUnmute(playBestPreUnmuteTarget());
}

// How much lead-in a pending switch gets, in 100 ms ticks.  A second covers the
// unmute round trip with enough real audio left over for the NR engine — which
// works in 4096-sample blocks, about a third of a second each — to have adapted
// to the band rather than to the silence it was being fed while muted.  Hold
// times run from 1 s to 5 s, so at the shortest setting this means "as soon as
// there is a candidate", which is the right answer there anyway.
const PLAY_BEST_PRE_UNMUTE_TICKS = 10;

/** The instance to unmute ahead of a switch, or null for none. */
function playBestPreUnmuteTarget() {
    if (!playBestEnabled || _muteActive) return null;
    if (playBestCandidateId === null) return null;
    // Only once the switch is imminent.  A candidate that flip-flops tick to
    // tick never gets near committing, and unmuting each one as it went past
    // would trade the gap we are removing for a stream of set_mute churn.
    if (playBestCandidateTicks < playBestHoldTicks - PLAY_BEST_PRE_UNMUTE_TICKS) return null;
    return playBestCandidateId;
}

function applyPlayBestRouting() {
    if (!playBestEnabled) return;
    if (_muteActive) return;   // don't fight the bridge mute while PTT is held

    const isFollower = typeof isFollowerMode !== 'undefined' && isFollowerMode;
    const ids = Object.keys(snrHistory);
    let bestId  = null;
    let bestAvg = -Infinity;

    ids.forEach((id, idx) => {
        if (!snrHistory[id]) return;
        // In owner mode, skip instances without an active radio
        if (!isFollower && !activeRadios[id]) return;
        // Respect legend visibility — hidden datasets are excluded
        // Chart.js v3/v4 stores hidden state in getDatasetMeta(), not ds.hidden
        if (snrHistoryChart && snrHistoryChart.getDatasetMeta(idx).hidden) return;
        const avg = movingAvgSnr(snrHistory[id], historyIndex[id]);
        if (avg !== null && avg > bestAvg) {
            bestAvg = avg;
            bestId  = id;
        }
    });

    // No visible candidate — if something is currently playing, mute it and reset state
    if (!bestId) {
        if (playBestCurrentId !== null) {
            if (isFollower) {
                // Mute all follower players via relay
                if (typeof _followerRelay !== 'undefined' && _followerRelay) {
                    for (const id of (selectedIds || [])) {
                        _followerRelay.setInstancePan(id, null);
                    }
                }
            } else {
                for (const radio of Object.values(activeRadios)) {
                    radio.currentVolume = 0;
                }
            }
            leftChannelId          = null;
            rightChannelId         = null;
            playBestCurrentId      = null;
            playBestCandidateId    = null;
            playBestCandidateTicks = 0;
            updateChannelUI();
        }
        return;
    }

    // Already playing the best — reset candidate, increment play-best tick, and return
    if (bestId === playBestCurrentId) {
        playBestCandidateId    = null;
        playBestCandidateTicks = 0;
        // Increment play-best time counter for the currently-playing instance
        if (playBestTicks[bestId] === undefined) playBestTicks[bestId] = 0;
        playBestTicks[bestId]++;
        return;
    }

    // First assignment — nothing is playing yet, commit immediately
    if (playBestCurrentId === null) {
        // fall through to commit block below
    } else {
        // Track how long this candidate has been the best
        if (bestId === playBestCandidateId) {
            playBestCandidateTicks++;
        } else {
            // New candidate — restart the hold counter
            playBestCandidateId    = bestId;
            playBestCandidateTicks = 1;
        }

        // Only commit the switch after the candidate has held for the configured hold time
        if (playBestCandidateTicks < playBestHoldTicks) return;
    }

    // Commit: mute all, then assign the new best to both channels (centre pan)
    if (isFollower) {
        // Route via FollowerRelay pan control
        if (typeof _followerRelay !== 'undefined' && _followerRelay) {
            for (const id of (selectedIds || [])) {
                _followerRelay.setInstancePan(id, id === bestId ? 0 : null);
            }
        }
        leftChannelId  = bestId;
        rightChannelId = null;
    } else {
        for (const radio of Object.values(activeRadios)) {
            radio.currentVolume = 0;
        }
        leftChannelId  = null;
        rightChannelId = null;

        const radio = activeRadios[bestId];
        if (radio) {
            radio.panValue      = 0.0;
            radio.currentVolume = 1.0;
            leftChannelId       = bestId;
            rightChannelId      = null;
            // Do NOT flush the NR ring buffer here — the pipeline runs continuously
            // regardless of volume, so processed output is already available.
        }
    }

    playBestCurrentId      = bestId;
    playBestCandidateId    = null;
    playBestCandidateTicks = 0;

    // Count this tick for the newly-committed instance
    if (playBestTicks[bestId] === undefined) playBestTicks[bestId] = 0;
    playBestTicks[bestId]++;

    updateChannelUI();
}

/**
 * Set the hold-time (in ticks) required before switching to a new best instance.
 * Called by the dropdown in the Smart Listen modal.
 * ticks = seconds × 10  (100 ms per tick)
 */
function setPlayBestHold(ticks) {
    playBestHoldTicks = ticks;
    // Reset candidate counters so the new threshold takes effect immediately
    playBestCandidateId         = null;
    playBestCandidateTicks      = 0;
    highlightBestCandidateId    = null;
    highlightBestCandidateTicks = 0;
}

window.setPlayBestHold  = setPlayBestHold;
window.togglePlayBest = togglePlayBest;

/**
 * Render the "play best" stacked bar graph in the Smart Listen modal.
 * The bar is 100% wide and divided into coloured segments proportional to
 * the number of ticks each instance has been "play best".
 * Colours match the SNR_HISTORY_COLORS palette used by the chart datasets.
 */
function renderBestTimeBars() {
    const ids = Object.keys(snrHistory);
    if (ids.length === 0) return;

    // Build a lookup: instanceId → dataset index (for colour)
    const idToIdx = {};
    ids.forEach((id, idx) => { idToIdx[id] = idx; });

    function buildBar(containerId, ticksObj) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const total = ids.reduce((sum, id) => sum + (ticksObj[id] || 0), 0);

        if (total === 0) {
            // No data yet — show a single grey placeholder
            container.innerHTML = '<div style="width:100%;height:100%;background:rgba(255,255,255,0.08);border-radius:9px;"></div>';
            return;
        }

        // Build segments in the same order as ids (= chart legend order)
        // so colours and positions match the legend exactly.
        // Instances with 0 ticks are included as zero-width (invisible) segments
        // to keep the colour mapping stable.
        const segments = ids.map(id => ({ id, ticks: ticksObj[id] || 0 }));

        // Determine first and last non-zero segments for border-radius
        const nonZero = segments.filter(s => s.ticks > 0);
        const firstId = nonZero.length > 0 ? nonZero[0].id : null;
        const lastId  = nonZero.length > 0 ? nonZero[nonZero.length - 1].id : null;

        container.innerHTML = segments.map(({ id, ticks }) => {
            const pct   = (ticks / total * 100).toFixed(3);
            const idx   = idToIdx[id] ?? 0;
            const color = SNR_HISTORY_COLORS[idx % SNR_HISTORY_COLORS.length];
            // Use the solid border colour (opacity 1) for the fill
            const fill  = color.border.replace(/[\d.]+\)$/, '0.85)');
            const inst  = allInstances.find(i => i.id === id);
            const label = inst ? inst.callsign : id;
            const secs  = (ticks * METER_UPDATE_INTERVAL / 1000).toFixed(1);
            // Apply rounded corners only to the visible first/last segments
            const isFirst  = id === firstId;
            const isLast   = id === lastId;
            const isOnly   = isFirst && isLast;
            const radius   = isOnly  ? '9px'
                           : isFirst ? '9px 0 0 9px'
                           : isLast  ? '0 9px 9px 0'
                           : '0';
            return `<div class="best-time-segment"
                         style="width:${pct}%;background:${fill};border-radius:${radius};"
                         title="${label}: ${secs}s (${parseFloat(pct).toFixed(1)}%)">
                        <span class="best-time-seg-label">${escHtml(label)}</span>
                    </div>`;
        }).join('');

        // Hide labels that don't fit cleanly inside their segment
        container.querySelectorAll('.best-time-segment').forEach(seg => {
            const span = seg.querySelector('.best-time-seg-label');
            if (!span) return;
            // scrollWidth > clientWidth means the text overflows — hide it
            if (span.scrollWidth > seg.clientWidth) {
                span.style.visibility = 'hidden';
            }
        });
    }

    buildBar('playBestBar', playBestTicks);
}

/**
 * Return the mean of the last `windowMs` milliseconds of SNR samples from a ring buffer.
 * Returns null if there are no valid samples in the window.
 */
function movingAvgSnr(buf, nextIdx, windowMs = 1000) {
    const samples = Math.round(windowMs / METER_UPDATE_INTERVAL);
    let sum = 0, count = 0;
    for (let i = 0; i < samples; i++) {
        // Walk backwards from the most-recently-written slot
        const slot = (nextIdx - 1 - i + HISTORY_SAMPLES) % HISTORY_SAMPLES;
        const v = buf[slot];
        if (v !== null && v !== undefined) { sum += v; count++; }
    }
    return count > 0 ? sum / count : null;
}

// Destroy the modal chart when monitoring stops so it is rebuilt fresh next time
const _origStopMonitoring = stopMonitoring;
window.stopMonitoring = async function() {
    closeSnrHistoryModal();
    stopSnrChartLoop();
    if (snrHistoryChart) { snrHistoryChart.destroy(); snrHistoryChart = null; }
    // Reset play-best state
    playBestEnabled        = false;
    playBestCurrentId      = null;
    playBestCandidateId    = null;
    playBestCandidateTicks = 0;
    const pbCb = document.getElementById('snrPlayBestToggle');
    if (pbCb) pbCb.checked = false;
    // Reset highlight-best debounce state
    highlightBestCurrentId      = null;
    highlightBestCandidateId    = null;
    highlightBestCandidateTicks = 0;
    // Reset best-time counters
    playBestTicks = {};
    // Cancel all pending reconnect timers (belt-and-suspenders — the inner
    // stopMonitoring() also does this, but clearing here first ensures no timer
    // fires between this wrapper and the inner call)
    for (const timer of Object.values(reconnectTimers)) clearTimeout(timer);
    reconnectTimers = {};
    disconnectedIds.clear();
    // If the owner was sharing, silently stop the share when leaving monitor phase.
    // _stopSharingCore() is defined in shared_session.js and clears share state +
    // disconnects the relay without showing a confirm dialog.
    if (typeof isOwnerMode !== 'undefined' && isOwnerMode &&
        typeof _stopSharingCore === 'function') {
        await _stopSharingCore();
    }
    await _origStopMonitoring();
};

/**
 * Called when the user clicks the audio-unlock overlay inside the Smart Listen modal.
 * Resumes all suspended AudioContexts (satisfying the browser autoplay policy),
 * hides the overlay, then re-applies play-best routing so audio starts immediately.
 */
async function unlockAudio() {
    const unlockOverlay = document.getElementById('audioUnlockOverlay');
    await Promise.allSettled(
        Object.values(activeRadios)
            .filter(r => r.audioContext && r.audioContext.state === 'suspended')
            .map(r => r.audioContext.resume())
    );
    if (unlockOverlay) unlockOverlay.style.display = 'none';
    // Re-apply play-best now that audio is unblocked
    if (playBestEnabled) applyPlayBest();
}

window.unlockAudio          = unlockAudio;
window.openSnrHistoryModal  = openSnrHistoryModal;
window.closeSnrHistoryModal = closeSnrHistoryModal;
window.snrModalOverlayClick = snrModalOverlayClick;

// ─── Named Sessions ───────────────────────────────────────────────────────────

const LS_SESSIONS_KEY = 'mm_named_sessions';

/** Load all saved sessions from localStorage. Returns an array (may be empty). */
function loadSessions() {
    try {
        const raw = localStorage.getItem(LS_SESSIONS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
}

/** Persist the sessions array to localStorage. */
function persistSessions(sessions) {
    try {
        localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(sessions));
    } catch (e) { /* quota / private browsing */ }
}

/** Generate a simple unique ID. */
function genSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Save the current freq / modality / modeOverride / selectedIds as a named session.
 * Called from the modal "Save Current" button.
 */
function saveCurrentSession() {
    const nameInput = document.getElementById('sessNameInput');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        if (nameInput) {
            nameInput.focus();
            nameInput.style.borderColor = '#ef4444';
            setTimeout(() => { nameInput.style.borderColor = ''; }, 1200);
        }
        return;
    }
    if (selectedIds.size === 0) {
        // Flash the save button to indicate nothing to save
        const saveBtn = document.querySelector('#sessModalOverlay .btn-success');
        if (saveBtn) {
            const orig = saveBtn.textContent;
            saveBtn.textContent = '⚠ No instances selected';
            saveBtn.disabled = true;
            setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 1800);
        }
        return;
    }

    const sessions = loadSessions();
    const session = {
        id:           genSessionId(),
        name,
        freq:         (currentFreqHz / 1e6).toFixed(6),
        modality:     modality,
        modeOverride: modeOverride || null,
        ids:          [...selectedIds],
        savedAt:      new Date().toISOString(),
    };
    sessions.push(session);
    persistSessions(sessions);

    if (nameInput) nameInput.value = '';
    renderSessionsModal();
    renderSessionsDropdown();
}

window.saveCurrentSession = saveCurrentSession;

/**
 * Load a session: apply its freq / modality / modeOverride, set selectedIds,
 * re-render the selection grid, and close any open dropdown/modal.
 */
function loadSession(id) {
    const sessions = loadSessions();
    const sess = sessions.find(s => s.id === id);
    if (!sess) return;

    closeSessionsDropdown();
    closeSessionsModal();

    // If currently monitoring, stop first — but warn the owner if they are sharing
    if (document.getElementById('phase-monitor').style.display !== 'none') {
        const sharing = typeof isOwnerMode !== 'undefined' && isOwnerMode;
        if (sharing) {
            showConfirmOverlay({
                icon:        '🔗',
                title:       'You\'re currently sharing',
                desc:        'Loading a session will stop monitoring and disconnect all listeners.',
                confirmText: '🛑 Stop Sharing & Load',
                confirmCls:  'btn-danger',
                cancelText:  'Keep Sharing',
                onConfirm:   () => stopMonitoring().then(() => _applySession(sess)),
            });
        } else {
            stopMonitoring().then(() => _applySession(sess));
        }
    } else {
        _applySession(sess);
    }
}

function _applySession(sess) {
    // Apply modality
    const newModality = sess.modality || 'phone';
    if (newModality !== modality) {
        modality = newModality;
        syncModalityUI();
    }

    // Apply mode override
    const validModes = ['usb', 'lsb', 'cwu', 'cwl'];
    modeOverride = (sess.modeOverride && validModes.includes(sess.modeOverride))
        ? sess.modeOverride : null;

    // Apply frequency
    const freq = parseFloat(sess.freq);
    if (!isNaN(freq) && freqInRangeMhz(freq)) {
        const slider  = document.getElementById('freqSlider');
        const input   = document.getElementById('freqInput');
        const display = document.getElementById('freqDisplay');
        const modeEl  = document.getElementById('modeIndicator');
        if (slider) slider.value = freq;
        if (input)  input.value  = freq.toFixed(6);
        currentFreqHz = Math.round(freq * 1e6);
        currentMode   = resolveMode(freq);
        if (display) display.textContent = `${freq.toFixed(6)} MHz`;
        if (modeEl) {
            modeEl.textContent = currentMode.toUpperCase();
            modeEl.classList.toggle('overridden', modeOverride !== null);
            modeEl.title = modeOverride
                ? 'Click to toggle sideband (overridden — click again to cycle)'
                : 'Click to toggle sideband';
        }
    }

    // Apply selected instances (only those that exist in allInstances)
    selectedIds.clear();
    if (Array.isArray(sess.ids)) {
        for (const id of sess.ids) {
            const inst = allInstances.find(i => i.id === id);
            if (inst && selectedIds.size < MAX_SELECTED) selectedIds.add(id);
        }
    }

    // Refresh UI
    updateBandFilterUI();
    renderSelectGrid();
    updateSelectCount();
    updateSdrLinks();
    updateURL();

    // Show a brief confirmation
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.textContent = `Session "${escHtml(sess.name)}" loaded`;
        statusEl.className = 'status-bar success';
        statusEl.style.display = 'block';
        setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    }
}

window.loadSession = loadSession;

/** Delete a session by ID. */
function deleteSession(id) {
    const sessions = loadSessions().filter(s => s.id !== id);
    persistSessions(sessions);
    renderSessionsModal();
    renderSessionsDropdown();
}

window.deleteSession = deleteSession;

/**
 * Switch a session list item into inline-edit mode.
 * Replaces the name text with an <input>, and the action buttons with ✓ / ✕.
 */
function renameSession(id) {
    const item = document.querySelector(`.sess-item[data-sess-id="${CSS.escape(id)}"]`);
    if (!item) return;

    const nameEl    = item.querySelector('.sess-item-name');
    const actionsEl = item.querySelector('.sess-item-actions');
    if (!nameEl || !actionsEl) return;

    const currentName = nameEl.textContent.trim();

    // Replace name div with an input
    const input = document.createElement('input');
    input.type      = 'text';
    input.value     = currentName;
    input.maxLength = 60;
    input.className = 'sess-name-input';
    input.style.cssText = 'width:100%; font-size:0.9em; padding:4px 8px;';
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    // Replace action buttons with ✓ / ✕
    const origActionsHTML = actionsEl.innerHTML;
    actionsEl.innerHTML = `
        <button class="sess-item-btn" title="Save name" onclick="commitRename('${escHtml(id)}')">✓</button>
        <button class="sess-item-btn danger" title="Cancel" onclick="cancelRename('${escHtml(id)}', ${JSON.stringify(currentName)})">✕</button>`;

    // Confirm on Enter, cancel on Escape
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commitRename(id); }
        if (e.key === 'Escape') { e.preventDefault(); cancelRename(id, currentName); }
    });
}

/** Commit the inline rename for a session. */
function commitRename(id) {
    const item  = document.querySelector(`.sess-item[data-sess-id="${CSS.escape(id)}"]`);
    if (!item) return;
    const input = item.querySelector('input.sess-name-input');
    const newName = input ? input.value.trim() : '';
    if (!newName) { input && input.focus(); return; }

    const sessions = loadSessions();
    const sess = sessions.find(s => s.id === id);
    if (sess) {
        sess.name = newName;
        persistSessions(sessions);
    }
    renderSessionsModal();
    renderSessionsDropdown();
}

/** Cancel the inline rename and restore the original name. */
function cancelRename(id, originalName) {
    const item = document.querySelector(`.sess-item[data-sess-id="${CSS.escape(id)}"]`);
    if (!item) { renderSessionsModal(); return; }
    // Just re-render — simpler than trying to restore the exact DOM state
    renderSessionsModal();
}

window.renameSession  = renameSession;
window.commitRename   = commitRename;
window.cancelRename   = cancelRename;

/** Export all sessions as a JSON file download. */
function exportSessions() {
    const sessions = loadSessions();
    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ubersdr-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

window.exportSessions = exportSessions;

/** Import sessions from a JSON file chosen by the user. Merges with existing sessions. */
function importSessions(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error('Not an array');
            const existing = loadSessions();
            const existingIds = new Set(existing.map(s => s.id));
            let added = 0;
            for (const sess of imported) {
                if (!sess.id || !sess.name) continue;
                // Avoid duplicates by ID; assign a new ID if collision
                if (existingIds.has(sess.id)) sess.id = genSessionId();
                existing.push(sess);
                added++;
            }
            persistSessions(existing);
            renderSessionsModal();
            renderSessionsDropdown();
            const statusEl = document.getElementById('status');
            if (statusEl) {
                statusEl.textContent = `Imported ${added} session${added !== 1 ? 's' : ''}`;
                statusEl.className = 'status-bar success';
                statusEl.style.display = 'block';
                setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
            }
        } catch (err) {
            alert('Failed to import sessions: ' + err.message);
        }
        // Reset file input so the same file can be re-imported
        input.value = '';
    };
    reader.readAsText(file);
}

window.importSessions = importSessions;

// ── Sessions dropdown ─────────────────────────────────────────────────────────

function toggleSessionsDropdown() {
    const wrap = document.getElementById('sessionsWrap');
    if (!wrap) return;
    const isOpen = wrap.classList.toggle('open');
    if (isOpen) {
        renderSessionsDropdown();
        // Close when clicking outside
        const handler = e => {
            if (!wrap.contains(e.target)) {
                wrap.classList.remove('open');
                document.removeEventListener('click', handler, true);
            }
        };
        document.addEventListener('click', handler, true);
    }
}

function closeSessionsDropdown() {
    const wrap = document.getElementById('sessionsWrap');
    if (wrap) wrap.classList.remove('open');
}

function renderSessionsDropdown() {
    const sessions = loadSessions();
    const emptyEl  = document.getElementById('sessionsDropdownEmpty');
    const listEl   = document.getElementById('sessionsDropdownList');
    if (!listEl) return;

    if (sessions.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        listEl.innerHTML = '';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    listEl.innerHTML = sessions.map(sess => {
        const modeLabel = sess.modeOverride
            ? sess.modeOverride.toUpperCase()
            : (sess.modality === 'cw' ? 'CW' : 'Phone');
        const instCount = Array.isArray(sess.ids) ? sess.ids.length : 0;
        return `<div class="sessions-dropdown-item" onclick="loadSession('${escHtml(sess.id)}')">
            <span class="sess-name">${escHtml(sess.name)}</span>
            <span class="sess-meta">${escHtml(sess.freq)} MHz · ${modeLabel} · ${instCount} inst</span>
        </div>`;
    }).join('');
}

window.toggleSessionsDropdown = toggleSessionsDropdown;
window.closeSessionsDropdown  = closeSessionsDropdown;

// ── Sessions modal ────────────────────────────────────────────────────────────

function openSessionsModal() {
    closeSessionsDropdown();
    renderSessionsModal();
    const overlay = document.getElementById('sessModalOverlay');
    if (overlay) overlay.classList.add('open');
}

function closeSessionsModal() {
    const overlay = document.getElementById('sessModalOverlay');
    if (overlay) overlay.classList.remove('open');
}

function sessModalOverlayClick(e) {
    if (e.target === document.getElementById('sessModalOverlay')) {
        closeSessionsModal();
    }
}

function renderSessionsModal() {
    const sessions  = loadSessions();
    const container = document.getElementById('sessListContainer');
    const emptyEl   = document.getElementById('sessListEmpty');
    if (!container) return;

    if (sessions.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        // Remove any previously rendered items (keep the empty message)
        container.querySelectorAll('.sess-item').forEach(el => el.remove());
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    // Re-render all items
    container.querySelectorAll('.sess-item').forEach(el => el.remove());
    sessions.forEach(sess => {
        const modeLabel = sess.modeOverride
            ? sess.modeOverride.toUpperCase()
            : (sess.modality === 'cw' ? 'CW' : 'Phone');
        const instCount = Array.isArray(sess.ids) ? sess.ids.length : 0;
        const savedDate = sess.savedAt
            ? new Date(sess.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : '';

        const item = document.createElement('div');
        item.className = 'sess-item';
        item.dataset.sessId = sess.id;
        item.innerHTML = `
            <div class="sess-item-info">
                <div class="sess-item-name">${escHtml(sess.name)}</div>
                <div class="sess-item-meta">${escHtml(sess.freq)} MHz · ${modeLabel} · ${instCount} instance${instCount !== 1 ? 's' : ''}${savedDate ? ' · ' + savedDate : ''}</div>
            </div>
            <div class="sess-item-actions">
                <button class="sess-item-btn" onclick="loadSession('${escHtml(sess.id)}'); closeSessionsModal();" title="Load this session">▶ Load</button>
                <button class="sess-item-btn" onclick="renameSession('${escHtml(sess.id)}')" title="Rename">✏</button>
                <button class="sess-item-btn danger" onclick="deleteSession('${escHtml(sess.id)}')" title="Delete">🗑</button>
            </div>`;
        container.appendChild(item);
    });
}

window.openSessionsModal     = openSessionsModal;
window.closeSessionsModal    = closeSessionsModal;
window.sessModalOverlayClick = sessModalOverlayClick;

function setStatus(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className   = `status-bar ${cls}`;
}

function snrClass(snr) {
    if (snr === null || snr === undefined) return 'unknown';
    if (snr < 6)  return 'poor';
    if (snr < 20) return 'fair';
    if (snr < 30) return 'good';
    return 'excellent';
}

/** Haversine distance in km between two lat/lon points. */
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Format distance for display: <100 km → 1 decimal, else integer. */
function formatDistKm(km) {
    return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * A two-letter country code as its flag, the way the chooser draws one.
 *
 * Upstream this page used `<img src="/flags/xx.svg">`, served from the
 * collector's own flags/ directory. There is no such directory here, and adding
 * one would mean a second way of drawing a flag inside one application: the
 * chooser, the v1 UI and v2 all build the character from a pair of regional
 * indicators and let the font draw it.
 *
 * The font is the point. Every platform but Windows has flag glyphs; Segoe UI
 * Emoji has none, so Chromium there draws two letters in boxes. `--font` in
 * chooser.css carries 'Twemoji Flags' for exactly that, limited by
 * unicode-range to this block so it costs nothing for ordinary text.
 *
 * Identical to countryFlag() in chooser/chooser.js.
 */
function countryFlag(code) {
    if (!code || code.length !== 2) return '';
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function escHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── UberSDR Firefox Extension Bridge ────────────────────────────────────────
// Exposes a minimal window.radioAPI + window.userSessionID shim so the UberSDR
// Firefox extension content script can detect, tune, and mute this page exactly
// as it does a regular single-instance UberSDR page.
//
// Must live at the bottom of multi_monitor.js so it has closure access to the
// module-level `let` state variables (currentFreqHz, currentMode, activeRadios,
// previewRadio) which are script-scoped and not reachable from a separate file.
//
// What the content script uses from radioAPI:
//   radioAPI.on('frequency_changed' | 'mode_changed' | 'bandwidth_changed' | 'mute_changed', cb)
//   radioAPI.getFrequency() → Hz
//   radioAPI.getMode()      → string
//   radioAPI.getBandwidth() → { low, high }
//   radioAPI.notifyFrequencyChange(hz)   — called by cmd:set_freq step 6
//   radioAPI.setMode(mode)
//   radioAPI.setBandwidth(low, high)
//   radioAPI.adjustFrequency(delta)
//   radioAPI.setMuted(bool)
//
// The content script also reads:
//   window.userSessionID              — for tab registration
//   window.currentBasebandPower       — signal quality polling (every 500 ms)
//   window.currentNoiseDensity        — noise floor for SNR calculation
//   window.autoTune()                 — called by cmd:set_freq step 7 to commit retune

(function () {

    // ── Minimal event emitter ─────────────────────────────────────────────────
    const _listeners = {};
    function _emit(event, data) {
        (_listeners[event] || []).forEach(function (cb) {
            try { cb(data); } catch (e) { /* ignore listener errors */ }
        });
    }

    // ── radioAPI shim ─────────────────────────────────────────────────────────
    window.radioAPI = {

        on: function (event, cb) {
            if (!_listeners[event]) _listeners[event] = [];
            _listeners[event].push(cb);
        },

        // ── Getters ───────────────────────────────────────────────────────────

        getFrequency: function () {
            return currentFreqHz;
        },

        getMode: function () {
            return currentMode;
        },

        getBandwidth: function () {
            var bw = bandwidthForMode(currentMode);
            return { low: bw.bwl, high: bw.bwh };
        },

        // ── Setters / actions ─────────────────────────────────────────────────

        // Called by content script cmd:set_freq step 6.
        // Updates internal state and emits events; step 7 calls window.autoTune()
        // which does the actual WebSocket retune of all active radios.
        // No-op in follower mode — frequency is controlled by the session owner.
        notifyFrequencyChange: function (hz) {
            if (typeof isFollowerMode !== 'undefined' && isFollowerMode) return;
            currentFreqHz = hz;
            currentMode   = resolveMode(hz / 1e6);
            // Keep the UI in sync
            var display = document.getElementById('freqDisplay');
            var modeEl  = document.getElementById('modeIndicator');
            var slider  = document.getElementById('freqSlider');
            var input   = document.getElementById('freqInput');
            var mhz     = hz / 1e6;
            if (display) display.textContent = mhz.toFixed(6) + ' MHz';
            if (modeEl)  modeEl.textContent  = currentMode.toUpperCase();
            if (slider)  slider.value        = mhz;
            if (input)   input.value         = mhz.toFixed(6);
            _emit('frequency_changed', { frequency: hz });
            _emit('mode_changed',      { mode: currentMode });
        },

        // No-op in follower mode — mode is controlled by the session owner.
        setMode: function (mode) {
            if (typeof isFollowerMode !== 'undefined' && isFollowerMode) return;
            var validModes = ['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'];
            if (validModes.indexOf(mode) === -1) return;
            modeOverride = mode;
            currentMode  = mode;
            var modeEl = document.getElementById('modeIndicator');
            if (modeEl) {
                modeEl.textContent = mode.toUpperCase();
                modeEl.classList.add('overridden');
            }
            var bw = bandwidthForMode(mode);
            for (var id in activeRadios) {
                var radio = activeRadios[id];
                if (radio && radio.isPlaying) {
                    radio.changeFrequency(currentFreqHz, mode);
                    radio.bandwidthLow  = bw.bwl;
                    radio.bandwidthHigh = bw.bwh;
                    sendTune(radio);
                }
            }
            if (previewRadio && previewRadio.isPlaying) {
                previewRadio.changeFrequency(currentFreqHz, mode);
                previewRadio.bandwidthLow  = bw.bwl;
                previewRadio.bandwidthHigh = bw.bwh;
                sendTune(previewRadio);
            }
            _emit('mode_changed', { mode: mode });
        },

        // multi_monitor uses fixed per-mode bandwidth — ignore external BW changes
        // but still emit the event so the content script stays consistent.
        setBandwidth: function (low, high) {
            _emit('bandwidth_changed', { low: low, high: high });
        },

        // No-op in follower mode — frequency is controlled by the session owner.
        adjustFrequency: function (delta) {
            if (typeof isFollowerMode !== 'undefined' && isFollowerMode) return;
            var newHz = currentFreqHz + delta;
            this.notifyFrequencyChange(newHz);
            if (window.autoTune) window.autoTune();
        },

        // Mute / unmute all active radios via the proper muteAllAudio() function
        // which saves/restores per-radio volumes and guards applyPlayBest().
        setMuted: function (muted) {
            muteAllAudio(muted);
            _emit('mute_changed', { muted: muted });
        },
    };

    // ── Stable per-page session ID ────────────────────────────────────────────
    // multi_monitor has no single session; we generate a stable UUID for the
    // lifetime of this page load so the extension can track this tab.
    window.userSessionID = 'multi-monitor-' +
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10);

    // ── window.autoTune — called by content script cmd:set_freq step 7 ────────
    // Retuning is done here after notifyFrequencyChange() has updated the state.
    // No-op in follower mode — frequency is controlled by the session owner.
    window.autoTune = function () {
        if (typeof isFollowerMode !== 'undefined' && isFollowerMode) return;
        var bw = bandwidthForMode(currentMode);
        for (var id in activeRadios) {
            var radio = activeRadios[id];
            if (radio && radio.isPlaying) {
                radio.changeFrequency(currentFreqHz, currentMode);
                radio.bandwidthLow  = bw.bwl;
                radio.bandwidthHigh = bw.bwh;
                sendTune(radio);
            }
        }
        if (previewRadio && previewRadio.isPlaying) {
            previewRadio.changeFrequency(currentFreqHz, currentMode);
            previewRadio.bandwidthLow  = bw.bwl;
            previewRadio.bandwidthHigh = bw.bwh;
            sendTune(previewRadio);
        }
        updateSdrLinks();
        updateURL();
    };

    // ── Signal quality globals (polled by content script every 500 ms) ────────
    // Expose the best-SNR active radio's metrics as the page-level globals the
    // content script reads: window.currentBasebandPower / window.currentNoiseDensity.
    // In follower mode, activeRadios is empty; signal data is cached per-instance
    // by updateMeterTileSignal() into window._followerSignalCache.
    //
    // currentNoiseDensity keeps its name because the page-world script reads it
    // by that name, but the figure it carries is now noise power over the
    // demodulator passband, so the script's (power - noise) is a true SNR in dB
    // rather than S/N0 in dB·Hz. See DEFAULT_PROTOCOL_VERSION in minimal-radio.js.
    window._followerSignalCache = {}; // { [instanceId]: { power, noisePower, snr } }
    setInterval(function () {
        var isFollower = typeof isFollowerMode !== 'undefined' && isFollowerMode;
        if (isFollower) {
            // Pick the best-SNR instance from the relay signal cache
            var bestSnr   = null;
            var bestPower = null;
            var bestNoise = null;
            var cache = window._followerSignalCache || {};
            for (var cid in cache) {
                var entry = cache[cid];
                if (entry && entry.snr !== null && (bestSnr === null || entry.snr > bestSnr)) {
                    bestSnr   = entry.snr;
                    bestPower = entry.power;
                    bestNoise = entry.noisePower;
                }
            }
            window.currentBasebandPower = bestPower;
            window.currentNoiseDensity  = bestNoise;
        } else {
            var bestSnr   = null;
            var bestPower = null;
            for (var id in activeRadios) {
                var radio = activeRadios[id];
                if (!radio) continue;
                var snr = radio.signalSNR;
                if (snr !== null && snr !== undefined) {
                    if (bestSnr === null || snr > bestSnr) {
                        bestSnr   = snr;
                        bestPower = radio.basebandPower;
                    }
                }
            }
            window.currentBasebandPower = bestPower;
            // content script computes SNR as (basebandPower - noise), so
            // derive the noise figure from the best radio's known SNR and power.
            window.currentNoiseDensity  = (bestSnr !== null && bestPower !== null)
                ? bestPower - bestSnr
                : null;
        }
    }, 500);

    // ── Hook page-UI frequency changes → emit radioAPI events ─────────────────
    // Listen on both the slider and the freq input so that owner-driven updates
    // (which dispatch 'input' on freqInput, not the slider) are also emitted.
    // A 60 ms delay ensures applyFreq()'s 50 ms debounce has fired first.
    // Note: this script is loaded at end-of-body so the DOM is already ready —
    // no DOMContentLoaded wrapper needed.
    function _emitFreqAfterDebounce() {
        setTimeout(function () {
            _emit('frequency_changed', { frequency: currentFreqHz });
            _emit('mode_changed',      { mode: currentMode });
        }, 60);
    }
    var _bridgeSlider = document.getElementById('freqSlider');
    if (_bridgeSlider) {
        _bridgeSlider.addEventListener('input', _emitFreqAfterDebounce);
    }
    var _bridgeInput = document.getElementById('freqInput');
    if (_bridgeInput) {
        _bridgeInput.addEventListener('input', _emitFreqAfterDebounce);
    }

    console.log('[UberSDR Bridge] multi_monitor radioAPI shim active');

})();

