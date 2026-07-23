'use strict';

// stats_history.js — Stats History page controller
// Fetches /api/stats/wspr-rank, /api/stats/psk-rank, /api/stats/rbn
// and renders Chart.js charts for each.

// ── Chart.js global defaults ──────────────────────────────────────────────
Chart.defaults.color = '#a0aec0';
Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';

// ── Colour palette ────────────────────────────────────────────────────────
const PALETTE = [
    '#63b3ed','#68d391','#f6ad55','#fc8181','#b794f4',
    '#76e4f7','#faf089','#f687b3','#9ae6b4','#fed7aa',
];

// ── PSK band order (low → high frequency) ────────────────────────────────
const PSK_BAND_ORDER = [
    'All',
    'vlf','4000m','2200m','1000m','630m','600m','560m','160m','80m','60m',
    '40m','30m','20m','17m','15m','12m','10m','6m','4m','2m','1.25m',
    '70cm','33cm','23cm','13cm','9cm','6cm','3cm','1.25cm','6mm','4mm',
    '2.5mm','2mm','1mm','invalid',
];

function pskBandSort(a, b) {
    const ia = PSK_BAND_ORDER.indexOf(a);
    const ib = PSK_BAND_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtTime(iso) {
    // Returns a short label: "May 13 09:00" or just "May 13" for daily data
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'UTC',
    });
}

function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function destroyChart(ref) {
    if (ref && ref.chart) { ref.chart.destroy(); ref.chart = null; }
}

function makeChartConfig(labels, datasets, yLabel, invertY = false) {
    return {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } },
                tooltip: { callbacks: {
                    title: items => items[0]?.label || '',
                } },
            },
            scales: {
                x: {
                    title: { display: true, text: 'Time (UTC)', color: '#a0aec0' },
                    ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
                    grid: { color: 'rgba(255,255,255,0.06)' },
                },
                y: {
                    reverse: invertY,
                    title: { display: !!yLabel, text: yLabel, color: '#a0aec0' },
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    ticks: { precision: 0 },
                },
            },
        },
    };
}

function makeBarConfig(labels, datasets, yLabel) {
    return {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {},
            },
            scales: {
                x: {
                    title: { display: true, text: 'Time (UTC)', color: '#a0aec0' },
                    ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 30, font: { size: 10 } },
                    grid: { color: 'rgba(255,255,255,0.06)' },
                },
                y: {
                    title: { display: !!yLabel, text: yLabel, color: '#a0aec0' },
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    ticks: { precision: 0 },
                },
            },
        },
    };
}

// ── App state ─────────────────────────────────────────────────────────────
const state = {
    activeTab: 'psk',
    stationCallsign: '',   // from /api/description receiver.callsign
    callsign: '',          // user-entered filter
    callsign2: '',         // optional second station to compare against callsign

    // chart refs
    charts: {
        wsprUnique: null,
        wsprRank:   null,
        pskReports:   null,
        pskCountries: null,
        pskFull:      null,
        rbnSpots:  null,
        rbnRank:   null,
        rbnSkew:   null,
    },

    // active window for WSPR charts
    wsprUniqueWin:  'rolling_24h',
    wsprRankWin:    'rolling_24h',
    wsprUniqueBand: 'All',   // 'All' or a specific band name (callsign mode only)

    // active band for PSK charts
    pskReportsBand:    'All',
    pskCountriesBand:  'All',
    pskFullBand:       'All',

    // point-in-time (?at=) snapshots
    pskAtBand:     'All',          // active band chip on the PSK card
    wsprAtWindow:  'rolling_24h',  // active window chip on the WSPR card

    // raw fetched data
    wsprData: null,
    pskData:  null,
    rbnData:  null,

    // last ?at= response per source, or null
    atData: { psk: null, wspr: null, rbn: null },

    // space weather overlay
    swData:   null,   // array of SpaceWeatherData records, or null if unavailable
};

// ── Space weather helpers ─────────────────────────────────────────────────

/** Returns true if the SW overlay checkbox is checked */
function swOverlayEnabled() {
    const cb = document.getElementById('sw-overlay');
    return cb ? cb.checked : false;
}

/**
 * Build a lookup function from an array of SW records.
 * Given an ISO timestamp string, returns the nearest SW record (or null).
 */
function buildSWLookup(swRecords) {
    if (!swRecords || swRecords.length === 0) return () => null;
    return function (iso) {
        const t = new Date(iso).getTime();
        let best = null, bestDiff = Infinity;
        for (const r of swRecords) {
            const diff = Math.abs(new Date(r.timestamp).getTime() - t);
            if (diff < bestDiff) { bestDiff = diff; best = r; }
        }
        return best;
    };
}

/**
 * Convert the current period selector to explicit from/to date strings
 * (YYYY-MM-DD) for use with /api/spaceweather/history.
 */
function getSWDateRange() {
    const period = document.getElementById('period-select').value;
    const today  = new Date();
    const fmt    = d => d.toISOString().slice(0, 10);
    if (period === 'custom') {
        const from = document.getElementById('from-date').value;
        const to   = document.getElementById('to-date').value || fmt(today);
        return { from, to };
    }
    const days = period === '24h' ? 1 : period === '7d' ? 7 : 30;
    const from = new Date(today);
    from.setDate(today.getDate() - (days - 1));
    return { from: fmt(from), to: fmt(today) };
}

/**
 * Fetch space weather history for the current date range.
 * Returns an array of records, or [] if unavailable / not enabled.
 */
async function fetchSpaceWeather() {
    const { from, to } = getSWDateRange();
    if (!from) return [];
    try {
        const res = await fetch(`/api/spaceweather/history?from_date=${from}&to_date=${to}`);
        if (!res.ok) return [];          // 404 = CSV logging disabled, 503 = SW disabled
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn('Space weather fetch failed:', e);
        return [];
    }
}

/**
 * Build a Chart.js dataset for Solar Flux Index (SFI) overlay.
 * @param {string[]} labels  - ISO timestamp labels already on the chart
 * @param {Function} lookup  - result of buildSWLookup()
 */
function makeSFIDataset(labels, lookup, axisId = 'ySW') {
    const data = labels.map(lbl => {
        const r = lookup(lbl);
        return r ? r.solar_flux : null;
    });
    return {
        label: 'Solar Flux (SFU)',
        data,
        borderColor: '#f6ad55',
        backgroundColor: 'rgba(246,173,85,0.08)',
        borderDash: [5, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
        yAxisID: axisId,
        order: 10,   // draw behind main datasets
    };
}

/**
 * Build a Chart.js dataset for K-index overlay.
 */
function makeKIndexDataset(labels, lookup, axisId = 'ySW') {
    const data = labels.map(lbl => {
        const r = lookup(lbl);
        return r ? r.k_index : null;
    });
    return {
        label: 'K-index',
        data,
        borderColor: '#fc8181',
        backgroundColor: 'rgba(252,129,129,0.08)',
        borderDash: [5, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: false,
        yAxisID: axisId,
        order: 10,
    };
}

/**
 * Build a Chart.js dataset for A-index overlay (daily geomagnetic index).
 * For daily-resolution charts (RBN), use the last SW record of each day.
 */
function makeAIndexDataset(labels, lookup, axisId = 'ySW') {
    // labels must be ISO timestamp strings (fetched_at), not formatted display labels
    const data = labels.map(lbl => {
        const r = lookup(lbl);
        return r ? r.a_index : null;
    });
    return {
        label: 'A-index',
        data,
        borderColor: '#fc8181',
        backgroundColor: 'rgba(252,129,129,0.08)',
        borderDash: [5, 4],
        borderWidth: 1.5,
        pointRadius: 2,
        tension: 0.2,
        fill: false,
        yAxisID: axisId,
        order: 10,
    };
}

/**
 * Return a right-side Y-axis config for SW overlays.
 * @param {string} label  - axis title
 * @param {number} min
 * @param {number} suggestedMax
 */
function makeSWAxis(label, min, suggestedMax) {
    return {
        type: 'linear',
        position: 'right',
        title: { display: true, text: label, color: '#f6ad55', font: { size: 11 } },
        grid: { drawOnChartArea: false },
        ticks: { color: '#f6ad55', precision: 0 },
        min,
        suggestedMax,
    };
}

// ── Initialise ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    bindTabs();
    bindControls();
    bindWindowTabs();
    bindAtCards();
    setDefaultDates();
    // Apply URL ?callsign= param before description fetch so it takes priority.
    applyURLParams();
    // Apply hash-based tab selection before loading data.
    applyHashTab();
    // Load description first (pre-fills callsign if not already set), then auto-run.
    loadDescription().then(() => loadAll());
});

// Handle browser back/forward navigation between tabs.
window.addEventListener('hashchange', () => applyHashTab());

/**
 * Read ?callsign= from the URL query string and pre-fill the callsign input.
 * This runs before loadDescription so a URL-supplied callsign takes priority
 * over the station's own callsign.
 */
function applyURLParams() {
    const params = new URLSearchParams(location.search);
    const cs = (params.get('callsign') || '').trim().toUpperCase();
    if (cs) {
        const inp = document.getElementById('callsign-input');
        if (inp) inp.value = cs;
        // Mark as URL-supplied so loadDescription won't overwrite it.
        state._urlCallsign = cs;
    }

    // ?callsign2= makes a two-station comparison shareable as a link.
    const cs2 = (params.get('callsign2') || '').trim().toUpperCase();
    if (cs2) {
        const inp2 = document.getElementById('callsign2-input');
        if (inp2) inp2.value = cs2;
    }
}

async function loadDescription() {
    try {
        const r = await fetch('/api/description');
        if (!r.ok) return;
        const d = await r.json();

        // Receiver name in subtitle
        if (d.receiver?.name) {
            document.getElementById('receiver-name').textContent =
                `${d.receiver.name} — WSPR · PSK · RBN Historical Data`;
        }

        // Station callsign — only pre-fill if not already set by URL param.
        const cs = (d.receiver?.callsign || d.cw_skimmer_callsign || '').trim().toUpperCase();
        if (cs && cs !== 'N0CALL') {
            state.stationCallsign = cs;
            const inp = document.getElementById('callsign-input');
            // Don't overwrite a callsign that came from the URL.
            if (!state._urlCallsign && !inp.value) inp.value = cs;
        }

        // Version in footer
        if (d.version) {
            const el = document.getElementById('footer-version');
            if (el) el.textContent = ` · v${d.version}`;
        }
    } catch (e) {
        console.warn('loadDescription:', e);
    }
}

function setDefaultDates() {
    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);
    const week = new Date(today); week.setDate(today.getDate() - 6);
    document.getElementById('from-date').value = fmt(week);
    document.getElementById('to-date').value   = fmt(today);
}

// ── Tab switching ─────────────────────────────────────────────────────────
const VALID_TABS = new Set(['psk', 'wspr', 'rbn']);

function switchTab(tab) {
    if (!VALID_TABS.has(tab)) return;
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.toggle('hidden', !c.id.endsWith(tab));
        c.classList.toggle('active', c.id.endsWith(tab));
    });
    state.activeTab = tab;
}

function applyHashTab() {
    const hash = location.hash.replace('#', '').toLowerCase();
    if (VALID_TABS.has(hash)) switchTab(hash);
}

function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
            // Update URL hash without triggering a page scroll.
            history.replaceState(null, '', `#${tab}`);
        });
    });
}

// ── Period / custom date controls ─────────────────────────────────────────
function bindControls() {
    const periodSel = document.getElementById('period-select');
    periodSel.addEventListener('change', () => {
        const custom = periodSel.value === 'custom';
        document.getElementById('custom-dates').classList.toggle('hidden', !custom);
        document.getElementById('custom-dates-to').classList.toggle('hidden', !custom);
    });

    document.getElementById('load-btn').addEventListener('click', loadAll);

    ['callsign-input', 'callsign2-input'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') loadAll();
        });
    });

    // SW overlay checkbox: re-run loadAll so SW data is fetched (or dropped) and
    // charts are re-rendered.  Only fires if data has already been loaded once.
    document.getElementById('sw-overlay').addEventListener('change', () => {
        if (state.wsprData || state.pskData || state.rbnData) loadAll();
    });
}

// ── WSPR window sub-tabs ──────────────────────────────────────────────────
function bindWindowTabs() {
    // WSPR unique chart window tabs
    document.querySelectorAll('#wspr-unique-card .win-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#wspr-unique-card .win-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.wsprUniqueWin = btn.dataset.win;
            if (state.wsprData) renderWSPRUnique(state.wsprData);
        });
    });

    // WSPR rank chart window tabs
    document.querySelectorAll('#wspr-rank-card .win-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#wspr-rank-card .win-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.wsprRankWin = btn.dataset.win;
            if (state.wsprData) renderWSPRRank(state.wsprData);
        });
    });
}

// ── Build query params ────────────────────────────────────────────────────
function buildParams() {
    const period = document.getElementById('period-select').value;
    // Callsign is uppercased by the backend (ParseStatsQueryParams); CSS forces
    // uppercase display in the input.  We still uppercase here so local label
    // comparisons (e.g. filterWSPRRankWindowByCallsign) work correctly.
    const cs     = document.getElementById('callsign-input').value.trim().toUpperCase();
    const cs2    = document.getElementById('callsign2-input').value.trim().toUpperCase();
    state.callsign = cs; // always uppercase

    // Mirror the backend's rules (ParseStatsQueryParams) so the user gets the
    // reason here rather than a 400 from the API.
    if (cs2 && !cs) {
        setStatus('Enter a primary callsign to compare against.', 'error');
        return null;
    }
    if (cs2 && cs2 === cs) {
        setStatus('The compare-with callsign must differ from the primary callsign.', 'error');
        return null;
    }
    state.callsign2 = cs2;

    const params = new URLSearchParams();
    if (period !== 'custom') {
        params.set('period', period);
    } else {
        const from = document.getElementById('from-date').value;
        const to   = document.getElementById('to-date').value;
        if (!from) { setStatus('Please select a from date.', 'error'); return null; }
        params.set('from_date', from);
        if (to) params.set('to_date', to);
    }
    if (cs) params.set('callsign', cs);
    if (state.callsign2) params.set('callsign2', state.callsign2);
    return params;
}

// ── Load all three datasets ───────────────────────────────────────────────
async function loadAll() {
    const params = buildParams();
    if (!params) return;

    const btn = document.getElementById('load-btn');
    btn.disabled = true;
    setStatus('Loading…', 'loading');

    try {
        // Fetch stats data + space weather in parallel (SW failure is non-fatal)
        const swEnabled = swOverlayEnabled();
        const [wsprRes, pskRes, rbnRes, swRecords] = await Promise.all([
            fetch(`/api/stats/wspr-rank?${params}`),
            fetch(`/api/stats/psk-rank?${params}`),
            fetch(`/api/stats/rbn?${params}`),
            swEnabled ? fetchSpaceWeather() : Promise.resolve([]),
        ]);

        const [wsprJson, pskJson, rbnJson] = await Promise.all([
            wsprRes.json(),
            pskRes.json(),
            rbnRes.json(),
        ]);

        if (wsprJson.error) throw new Error(`WSPR: ${wsprJson.error}`);
        if (pskJson.error)  throw new Error(`PSK: ${pskJson.error}`);
        if (rbnJson.error)  throw new Error(`RBN: ${rbnJson.error}`);

        state.wsprData = wsprJson;
        state.pskData  = pskJson;
        state.rbnData  = rbnJson;
        state.swData   = swEnabled ? swRecords : null;

        renderWSPR(wsprJson);
        renderPSK(pskJson);
        renderRBN(rbnJson);

        let statusMsg = `Loaded — WSPR: ${wsprJson.count} snapshots · PSK: ${pskJson.count} snapshots · RBN: ${rbnJson.count} days`;
        if (comparing()) statusMsg += ` · comparing ${state.callsign} vs ${state.callsign2}`;
        if (swEnabled) {
            statusMsg += swRecords.length > 0
                ? ` · ☀️ SW: ${swRecords.length} records`
                : ' · ☀️ SW: unavailable';
        }
        setStatus(statusMsg, 'success');
    } catch (e) {
        setStatus(`Error: ${e.message}`, 'error');
        console.error(e);
    } finally {
        btn.disabled = false;
    }
}

function setStatus(msg, cls = '') {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status-bar' + (cls ? ` ${cls}` : '');
}

// ── Two-callsign comparison helpers ───────────────────────────────────────
//
// When a second callsign is set, every callsign-mode chart carries one series
// per station. The primary keeps the colour it had on its own; the comparison
// station gets a contrasting one, and both series are labelled with the
// callsign so the legend is unambiguous.

const CMP_PRIMARY   = PALETTE[0];  // blue   — primary station, value series
const CMP_PRIMARY_R = PALETTE[3];  // red    — primary station, rank series
const CMP_SECOND    = PALETTE[1];  // green  — comparison station, value series
const CMP_SECOND_R  = PALETTE[4];  // purple — comparison station, rank series

/** True when a distinct second callsign is active. */
function comparing() {
    return !!(state.callsign && state.callsign2);
}

/**
 * Label a series. In comparison mode the callsign is prefixed so two otherwise
 * identical series ("Rank", "Rank") stay distinguishable.
 */
function seriesLabel(base, callsign) {
    return comparing() ? `${callsign} ${base}` : base;
}

/** Suffix for a chart heading: "— G0ABC" or "— G0ABC vs M0XYZ". */
function callsignHeading() {
    if (!state.callsign) return '';
    return comparing() ? `— ${state.callsign} vs ${state.callsign2}` : `— ${state.callsign}`;
}

/**
 * Wrap one or two per-station summary fragments. With a single station the
 * fragment is returned untouched, so the existing single-callsign bar is
 * unchanged; with two, each is prefixed by its callsign.
 */
function joinSummaries(fragments) {
    const present = fragments.filter(f => f.html);
    if (present.length === 0) return '';
    if (present.length === 1 && !comparing()) return present[0].html;
    return present
        .map(f => `<span class="summary-group summary-station">${escHtml(f.callsign)}</span>${f.html}`)
        .join('<span class="summary-divider"></span>');
}

/** Line-series defaults shared by every comparison chart. */
function cmpSeries(label, data, color, opts = {}) {
    return {
        label,
        data,
        borderColor: color,
        backgroundColor: color + '33',
        tension: 0.3,
        fill: false,
        pointRadius: 3,
        spanGaps: true,   // a station missing from one snapshot must not split the line
        ...opts,
    };
}

// ── Awards helpers ────────────────────────────────────────────────────────

const MEDAL_CLASS = ['gold', 'silver', 'bronze'];
const MEDAL_EMOJI = ['🥇', '🥈', '🥉'];

/**
 * Render an awards bar from a flat list of badge objects.
 * Badges are sorted by rank (1→2→3) then by their existing order (priority).
 *
 * @param {string} containerId
 * @param {Array}  badges  - [{rank (1-3), text, priority (lower = first within same rank)}]
 * @param {string} [stationLabel] - callsign to name the bar after; used when a
 *        comparison is active, since the medals belong to the primary station.
 */
function renderAwards(containerId, badges, stationLabel) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const valid = badges.filter(b => b.rank >= 1 && b.rank <= 3);
    if (valid.length === 0) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }

    // Sort: primary = rank asc, secondary = priority asc (insertion order if equal)
    valid.sort((a, b) => a.rank !== b.rank ? a.rank - b.rank : (a.priority || 0) - (b.priority || 0));

    const parts = valid.map(b => {
        const cls = MEDAL_CLASS[b.rank - 1];
        const em  = MEDAL_EMOJI[b.rank - 1];
        return `<span class="award-badge ${cls}">${em} ${escHtml(b.text)}</span>`;
    });

    if (stationLabel) {
        parts.unshift(`<span class="awards-bar-label">${escHtml(stationLabel)}</span>`);
    }

    el.innerHTML = parts.join('');
    el.classList.remove('hidden');
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── WSPR rendering ────────────────────────────────────────────────────────
function renderWSPR(data) {
    const noData = document.getElementById('wspr-no-data');
    if (!data.snapshots || data.snapshots.length === 0) {
        noData.classList.remove('hidden');
        destroyChart({ chart: state.charts.wsprUnique });
        destroyChart({ chart: state.charts.wsprRank });
        document.getElementById('wspr-awards').classList.add('hidden');
        document.getElementById('wspr-summary').classList.add('hidden');
        return;
    }
    noData.classList.add('hidden');
    renderWSPRAwards(data);
    renderWSPRSummary(data);
    renderWSPRUnique(data);
    renderWSPRRank(data);
}

/**
 * WSPR awards — latest snapshot only, callsign mode.
 * Flat badge list sorted by rank, then window order (24h → yesterday → today),
 * then overall before per-band.
 */
function renderWSPRAwards(data) {
    const cs = state.callsign;
    if (!cs || !data.snapshots || data.snapshots.length === 0) {
        document.getElementById('wspr-awards').classList.add('hidden');
        return;
    }

    const latest = data.snapshots[data.snapshots.length - 1];
    if (!latest?.callsign_rank) {
        document.getElementById('wspr-awards').classList.add('hidden');
        return;
    }

    const WINDOWS = ['rolling_24h', 'yesterday', 'today'];
    const WIN_LABELS = { rolling_24h: '24h', yesterday: 'Yesterday', today: 'Today' };

    const badges = [];

    WINDOWS.forEach((win, wi) => {
        const w = latest.callsign_rank[win];
        if (!w) return;

        // Overall rank for this window.
        if (w.rank >= 1 && w.rank <= 3) {
            badges.push({ rank: w.rank, text: `${WIN_LABELS[win]} Overall`, priority: wi * 1000 });
        }

        // Per-band rank — computed server-side by comparing against all rows.
        if (w.band_ranks) {
            Object.entries(w.band_ranks)
                .filter(([, r]) => r >= 1 && r <= 3)
                .forEach(([band, r], bi) => {
                    badges.push({ rank: r, text: `${WIN_LABELS[win]} ${band}`, priority: wi * 1000 + 1 + bi });
                });
        }
    });

    renderAwards('wspr-awards', badges, comparing() ? state.callsign : '');
}

/**
 * WSPR snapshot summary — shows current spots and rank for each window
 * that has data for the callsign (or overall totals in full mode).
 * In callsign mode also shows per-band unique counts + per-band ranks.
 */
function renderWSPRSummary(data) {
    const el = document.getElementById('wspr-summary');
    if (!data.snapshots || data.snapshots.length === 0) { el.classList.add('hidden'); return; }

    const latest = data.snapshots[data.snapshots.length - 1];
    const cs = state.callsign;

    const WINDOWS = ['rolling_24h', 'yesterday', 'today'];
    const WIN_LABELS = { rolling_24h: '24h', yesterday: 'Yesterday', today: 'Today' };

    // Build pill HTML helper
    const pill = (key, val, extraClass = '') =>
        `<span class="summary-pill"><span class="pill-key">${key}</span><span class="pill-val${extraClass ? ' ' + extraClass : ''}">${val}</span></span>`;

    // Sort bands by numeric frequency (e.g. 160m < 80m < ... < 10m)
    const bandFreqOrder = band => {
        const m = band.match(/^(\d+)/);
        return m ? parseInt(m[1], 10) : 9999;
    };

    // One station's per-window rows, or '' when it has no data in any window.
    const stationHTML = (rank) => {
        if (!rank) return '';
        const sections = [];
        WINDOWS.forEach(win => {
            const w = rank[win];
            if (!w) return;

            // Overall row
            let overallParts = '';
            if (w.unique != null) overallParts += pill('Unique', w.unique.toLocaleString());
            if (w.raw    != null) overallParts += pill('Raw',    w.raw.toLocaleString());
            if (w.rank   != null) overallParts += pill('Rank',   `#${w.rank}`, 'pill-rank');
            if (!overallParts) return;

            let winHtml = `<span class="summary-group"><span class="summary-label">${WIN_LABELS[win]}</span>${overallParts}</span>`;

            // Per-band row (only if band_uniques present)
            if (w.band_uniques && Object.keys(w.band_uniques).length) {
                const bands = Object.keys(w.band_uniques).sort((a, b) => bandFreqOrder(a) - bandFreqOrder(b));
                let bandParts = '';
                for (const band of bands) {
                    const u = w.band_uniques[band];
                    const r = w.band_ranks?.[band];
                    let inner = `<span class="pill-key">${band}</span><span class="pill-val">${u.toLocaleString()}</span>`;
                    if (r != null) inner += `<span class="pill-rank">#${r}</span>`;
                    bandParts += `<span class="summary-pill">${inner}</span>`;
                }
                if (bandParts) {
                    winHtml += `<span class="summary-group"><span class="summary-label" style="opacity:0.5">bands</span>${bandParts}</span>`;
                }
            }

            sections.push(winHtml);
        });
        return sections.join('<span class="summary-divider"></span>');
    };

    let html = '';

    if (cs) {
        html = joinSummaries([
            { callsign: cs,              html: stationHTML(latest?.callsign_rank) },
            { callsign: state.callsign2, html: stationHTML(latest?.callsign_rank2) },
        ]);
        if (!html) { el.classList.add('hidden'); return; }
    } else {
        // Full mode: sum all rows across windows
        const groups = [];
        WINDOWS.forEach(win => {
            const w = latest?.[win];
            if (!w?.data?.length) return;
            const totalUnique = w.data.reduce((s, r) => s + (r.unique || 0), 0);
            const totalRaw    = w.data.reduce((s, r) => s + (r.raw    || 0), 0);
            let parts = pill('Unique', totalUnique.toLocaleString()) + pill('Raw', totalRaw.toLocaleString());
            groups.push(`<span class="summary-label">${WIN_LABELS[win]}</span>${parts}`);
        });

        if (!groups.length) { el.classList.add('hidden'); return; }
        html = groups.map(g => `<span class="summary-group">${g}</span>`).join(
            '<span class="summary-divider"></span>'
        );
    }

    el.innerHTML = html;
    el.classList.remove('hidden');
}

function getWSPRWindow(snap, win) {
    // snap may have full window objects or callsign_rank
    if (snap.callsign_rank) return snap.callsign_rank[win] || null;
    return snap[win] || null;
}

/** The comparison station's window data for a snapshot, or null. */
function getWSPRWindow2(snap, win) {
    return snap.callsign_rank2 ? (snap.callsign_rank2[win] || null) : null;
}

function renderWSPRUnique(data) {
    const win = state.wsprUniqueWin;
    const cs  = state.callsign;

    // In callsign mode, collect all bands present across all snapshots for this
    // window — for both stations, so the chips cover either one.
    if (cs) {
        const bandSet = new Set(['All']);
        for (const snap of data.snapshots) {
            for (const w of [getWSPRWindow(snap, win), getWSPRWindow2(snap, win)]) {
                if (w?.bands) w.bands.forEach(b => bandSet.add(b));
            }
        }
        const bands = ['All', ...[...bandSet].filter(b => b !== 'All')];

        // Ensure active band is still valid.
        if (!bandSet.has(state.wsprUniqueBand)) state.wsprUniqueBand = 'All';

        buildBandSelector('wspr-band-selector', bands, state.wsprUniqueBand, b => {
            state.wsprUniqueBand = b;
            renderWSPRUnique(data);
        });
        document.getElementById('wspr-band-selector').classList.remove('hidden');
        document.getElementById('wspr-unique-label').textContent = callsignHeading();
    } else {
        document.getElementById('wspr-band-selector').innerHTML = '';
        document.getElementById('wspr-band-selector').classList.add('hidden');
        document.getElementById('wspr-unique-label').textContent = '';
    }

    const labels     = [];
    const isoLabels  = [];   // raw ISO timestamps for SW lookup
    const uniqueVals = [];
    const rawVals    = [];
    const uniqueVals2 = [];
    const rawVals2    = [];

    const band = state.wsprUniqueBand;
    const isBandFiltered = cs && band !== 'All';

    // One station's [unique, raw] for a window, honouring the band selector.
    const valuesFor = (w) => {
        if (!w) return [null, null];
        if (band === 'All') return [w.unique ?? null, w.raw ?? null];
        return [w.band_uniques?.[band] ?? null, null]; // raw is not available per-band
    };

    for (const snap of data.snapshots) {
        const w = getWSPRWindow(snap, win);
        // In callsign mode a snapshot may hold only the comparison station, so
        // it is kept as long as either has data — otherwise the axes diverge.
        const w2 = getWSPRWindow2(snap, win);
        if (!w && !w2) continue;

        labels.push(fmtTime(snap.generated_at));
        isoLabels.push(snap.generated_at);

        if (cs) {
            const [u, r]   = valuesFor(w);
            const [u2, r2] = valuesFor(w2);
            uniqueVals.push(u);
            rawVals.push(r);
            uniqueVals2.push(u2);
            rawVals2.push(r2);
        } else {
            // Full window: sum all rows.
            const rows = w.data || [];
            uniqueVals.push(rows.reduce((s, r) => s + (r.unique || 0), 0));
            rawVals.push(rows.reduce((s, r) => s + (r.raw || 0), 0));
        }
    }

    let datasets;
    if (!cs) {
        datasets = [
            cmpSeries('Total Unique', uniqueVals, PALETTE[0], { fill: true }),
            cmpSeries('Total Raw',    rawVals,    PALETTE[2]),
        ];
    } else {
        const uniqueLabel = isBandFiltered ? `${band} Unique` : 'Unique';
        datasets = [cmpSeries(seriesLabel(uniqueLabel, cs), uniqueVals, CMP_PRIMARY, { fill: !comparing() })];
        if (!isBandFiltered) {
            datasets.push(cmpSeries(seriesLabel('Raw', cs), rawVals, PALETTE[2]));
        }
        if (comparing()) {
            datasets.push(cmpSeries(seriesLabel(uniqueLabel, state.callsign2), uniqueVals2, CMP_SECOND,
                { borderDash: [6, 3] }));
            if (!isBandFiltered) {
                datasets.push(cmpSeries(seriesLabel('Raw', state.callsign2), rawVals2, PALETTE[5],
                    { borderDash: [6, 3] }));
            }
        }
    }

    const swEnabled = swOverlayEnabled() && state.swData && state.swData.length > 0;
    if (swEnabled) {
        const lookup = buildSWLookup(state.swData);
        datasets.push(makeSFIDataset(isoLabels, lookup, 'ySFI'));
        datasets.push(makeKIndexDataset(isoLabels, lookup, 'yK'));
    }

    const ctx = document.getElementById('wspr-unique-chart');
    if (state.charts.wsprUnique) state.charts.wsprUnique.destroy();
    state.charts.wsprUnique = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } } },
            scales: {
                x: { title: { display: true, text: 'Time (UTC)', color: '#a0aec0' }, ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.06)' } },
                y: { title: { display: true, text: 'Spots', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0 } },
                ...(swEnabled ? {
                    ySFI: makeSWAxis('Solar Flux (SFU)', 60, 220),
                    yK:   { type: 'linear', position: 'right', title: { display: true, text: 'K-index', color: '#fc8181', font: { size: 11 } }, grid: { drawOnChartArea: false }, ticks: { color: '#fc8181', precision: 0 }, min: 0, suggestedMax: 9 },
                } : {}),
            },
        },
    });
}

function renderWSPRRank(data) {
    const win = state.wsprRankWin;
    const cs  = state.callsign;

    // Only meaningful when a callsign is set
    const rankCard = document.getElementById('wspr-rank-card');
    if (!cs) {
        rankCard.classList.add('hidden');
        return;
    }
    rankCard.classList.remove('hidden');
    document.getElementById('wspr-rank-label').textContent = callsignHeading();

    const labels    = [];
    const isoLabels = [];   // raw ISO timestamps for SW lookup
    const ranks     = [];
    const ranks2    = [];

    for (const snap of data.snapshots) {
        const w  = getWSPRWindow(snap, win);
        const w2 = getWSPRWindow2(snap, win);
        if (!w && !w2) continue;
        labels.push(fmtTime(snap.generated_at));
        isoLabels.push(snap.generated_at);
        ranks.push(w?.rank ?? null);
        ranks2.push(w2?.rank ?? null);
    }

    const datasets = [
        cmpSeries(seriesLabel('Rank', cs), ranks, CMP_PRIMARY_R, { fill: !comparing(), pointRadius: 3 }),
    ];
    if (comparing()) {
        datasets.push(cmpSeries(seriesLabel('Rank', state.callsign2), ranks2, CMP_SECOND_R,
            { borderDash: [6, 3] }));
    }

    const swEnabled = swOverlayEnabled() && state.swData && state.swData.length > 0;
    if (swEnabled) {
        const lookup = buildSWLookup(state.swData);
        datasets.push(makeSFIDataset(isoLabels, lookup, 'ySFI'));
        datasets.push(makeKIndexDataset(isoLabels, lookup, 'yK'));
    }

    const ctx = document.getElementById('wspr-rank-chart');
    if (state.charts.wsprRank) state.charts.wsprRank.destroy();
    state.charts.wsprRank = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } } },
            scales: {
                x: { title: { display: true, text: 'Time (UTC)', color: '#a0aec0' }, ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.06)' } },
                y: { reverse: true, title: { display: true, text: 'Rank (lower = better)', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0 } },
                ...(swEnabled ? {
                    ySFI: makeSWAxis('Solar Flux (SFU)', 60, 220),
                    yK:   { type: 'linear', position: 'right', title: { display: true, text: 'K-index', color: '#fc8181', font: { size: 11 } }, grid: { drawOnChartArea: false }, ticks: { color: '#fc8181', precision: 0 }, min: 0, suggestedMax: 9 },
                } : {}),
            },
        },
    });
}

// ── PSK rendering ─────────────────────────────────────────────────────────

/**
 * PSK awards — latest snapshot only, callsign mode.
 * Flat badge list sorted by rank first, then:
 *   Reports before Countries (table priority 0 vs 1)
 *   "All" band before per-band (pskBandSort puts All first)
 */
function renderPSKAwards(data) {
    const cs = state.callsign;
    if (!cs || !data.snapshots || data.snapshots.length === 0) {
        document.getElementById('psk-awards').classList.add('hidden');
        return;
    }

    const latest = data.snapshots[data.snapshots.length - 1];
    const cr = latest?.callsign_rank;
    if (!cr) {
        document.getElementById('psk-awards').classList.add('hidden');
        return;
    }

    // Build a sorted band list so "All" comes first, then numeric bands low→high
    const bandOrder = band => {
        if (band === 'All') return -1;
        const m = band.match(/^(\d+)/);
        return m ? parseInt(m[1], 10) : 9999;
    };

    const badges = [];

    // Reports — table priority 0
    if (cr.reports) {
        Object.entries(cr.reports)
            .filter(([, v]) => v?.rank >= 1 && v.rank <= 3)
            .forEach(([band, v]) => {
                badges.push({
                    rank: v.rank,
                    text: `${band} Reports`,
                    priority: 0 * 100000 + bandOrder(band),
                });
            });
    }

    // Countries — table priority 1
    if (cr.countries) {
        Object.entries(cr.countries)
            .filter(([, v]) => v?.rank >= 1 && v.rank <= 3)
            .forEach(([band, v]) => {
                badges.push({
                    rank: v.rank,
                    text: `${band} Countries`,
                    priority: 1 * 100000 + bandOrder(band),
                });
            });
    }

    renderAwards('psk-awards', badges, comparing() ? state.callsign : '');
}

/**
 * PSK snapshot summary — for callsign mode shows current rank + count for
 * every band that has data, one line for Reports and one for Countries.
 * In full mode shows total day-count across all bands.
 */
function renderPSKSummary(data) {
    const el = document.getElementById('psk-summary');
    if (!data.snapshots || data.snapshots.length === 0) { el.classList.add('hidden'); return; }

    const latest = data.snapshots[data.snapshots.length - 1];
    const cs = state.callsign;

    const pill = (key, val, extraClass = '') =>
        `<span class="summary-pill"><span class="pill-key">${key}</span><span class="pill-val${extraClass ? ' ' + extraClass : ''}">${val}</span></span>`;

    // Sort bands: All first, then numeric ascending
    const bandOrder = band => {
        if (band === 'All') return -1;
        const m = band.match(/^(\d+)/);
        return m ? parseInt(m[1], 10) : 9999;
    };
    const sortBands = bands => [...bands].sort((a, b) => bandOrder(a) - bandOrder(b));

    // One station's Reports + Countries rows, or '' when it has no data.
    const stationHTML = (cr) => {
        if (!cr) return '';
        const row = (src, label) => {
            if (!src || !Object.keys(src).length) return '';
            let parts = '';
            for (const band of sortBands(Object.keys(src))) {
                const v = src[band];
                if (!v) continue;
                let inner = `<span class="pill-key">${band}</span>`;
                if (v.day  != null) inner += `<span class="pill-val">${v.day.toLocaleString()}</span>`;
                if (v.rank != null) inner += `<span class="pill-rank">#${v.rank}</span>`;
                parts += `<span class="summary-pill">${inner}</span>`;
            }
            return parts ? `<span class="summary-group"><span class="summary-label">${label}</span>${parts}</span>` : '';
        };
        const reports   = row(cr.reports,   'Reports');
        const countries = row(cr.countries, 'Countries');
        if (reports && countries) return reports + '<span class="summary-divider"></span>' + countries;
        return reports || countries;
    };

    if (cs) {
        const html = joinSummaries([
            { callsign: cs,              html: stationHTML(latest?.callsign_rank) },
            { callsign: state.callsign2, html: stationHTML(latest?.callsign_rank2) },
        ]);
        if (!html) { el.classList.add('hidden'); return; }
        el.innerHTML = html;
        el.classList.remove('hidden');
    } else {
        // Full mode: total day-count from latest snapshot
        let totalReports   = 0;
        let totalCountries = 0;
        for (const entries of Object.values(latest?.report_result  || {})) {
            if (Array.isArray(entries)) entries.forEach(e => { totalReports   += e.day || 0; });
        }
        for (const entries of Object.values(latest?.country_result || {})) {
            if (Array.isArray(entries)) entries.forEach(e => { totalCountries += e.day || 0; });
        }
        if (!totalReports && !totalCountries) { el.classList.add('hidden'); return; }
        let html = '<span class="summary-group">';
        if (totalReports)   html += pill('Reports today',   totalReports.toLocaleString());
        if (totalCountries) html += pill('Countries today', totalCountries.toLocaleString());
        html += '</span>';
        el.innerHTML = html;
        el.classList.remove('hidden');
    }
}

function renderPSK(data) {
    const noData = document.getElementById('psk-no-data');
    if (!data.snapshots || data.snapshots.length === 0) {
        noData.classList.remove('hidden');
        ['pskReports','pskCountries','pskFull'].forEach(k => {
            if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
        });
        document.getElementById('psk-awards').classList.add('hidden');
        document.getElementById('psk-summary').classList.add('hidden');
        return;
    }
    noData.classList.add('hidden');
    renderPSKAwards(data);
    renderPSKSummary(data);

    const cs = state.callsign;

    if (cs) {
        // Callsign mode: rank over time per band
        document.getElementById('psk-full-card').classList.add('hidden');

        // Collect all bands present across all snapshots
        // Union both stations' bands so the chips cover either one.
        const reportBands   = new Set();
        const countryBands  = new Set();
        for (const snap of data.snapshots) {
            for (const cr of [snap.callsign_rank, snap.callsign_rank2]) {
                if (!cr) continue;
                Object.keys(cr.reports   || {}).forEach(b => reportBands.add(b));
                Object.keys(cr.countries || {}).forEach(b => countryBands.add(b));
            }
        }

        const rBands = [...reportBands].sort(pskBandSort);
        const cBands = [...countryBands].sort(pskBandSort);

        // Default active band
        if (!rBands.includes(state.pskReportsBand))   state.pskReportsBand   = rBands[0] || 'All';
        if (!cBands.includes(state.pskCountriesBand)) state.pskCountriesBand = cBands[0] || 'All';

        buildBandSelector('psk-band-selector',          rBands, state.pskReportsBand,   b => { state.pskReportsBand   = b; renderPSKRankChart(data, 'reports',   rBands); });
        buildBandSelector('psk-countries-band-selector', cBands, state.pskCountriesBand, b => { state.pskCountriesBand = b; renderPSKRankChart(data, 'countries', cBands); });

        renderPSKRankChart(data, 'reports',   rBands);
        renderPSKRankChart(data, 'countries', cBands);

        document.getElementById('psk-reports-label').textContent   = callsignHeading();
        document.getElementById('psk-countries-label').textContent = callsignHeading();
    } else {
        // Full mode: top reporters bar chart from latest snapshot
        document.getElementById('psk-full-card').classList.remove('hidden');
        document.getElementById('psk-reports-label').textContent   = '';
        document.getElementById('psk-countries-label').textContent = '';

        // Collect all bands from latest snapshot
        const latest = data.snapshots[data.snapshots.length - 1];
        const allBands = new Set();
        Object.keys(latest?.report_result  || {}).forEach(b => allBands.add(b));
        const bands = [...allBands].sort(pskBandSort);

        if (!bands.includes(state.pskFullBand)) state.pskFullBand = bands.includes('All') ? 'All' : (bands[0] || 'All');

        buildBandSelector('psk-full-band-selector', bands, state.pskFullBand, b => {
            state.pskFullBand = b;
            renderPSKFullChart(data);
        });

        renderPSKTrendChart(data, 'reports',   'psk-reports-chart', 'pskReports');
        renderPSKTrendChart(data, 'countries', 'psk-countries-chart', 'pskCountries');
        renderPSKFullChart(data);
    }
}

// ── Point-in-time snapshots (?at=) ────────────────────────────────────────
//
// Each of the three sources stores complete snapshots, so the backend can
// replay the whole leaderboard as it stood at a chosen instant (?at=…). This
// section drives one such card per tab. It is independent of the Load Data
// controls above: the card fetches only its own source.

// Matches the datetime-local value shape ("YYYY-MM-DDTHH:MM", optional :SS).
// The backend validates the same value again; this only avoids a pointless
// round trip when the field is empty or a browser hands back something odd.
const RE_AT_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// Rows requested per table. The backend caps this at 1000.
const AT_ROW_LIMIT = 200;

// wspr.live reports bands as integer metres; mirror of wsprBandOrder in
// wspr_rank.go so the Bands column can show names.
const WSPR_METRES_NAME = {
    '-1': 'LF', '0': 'MF', '1': '160m', '3': '80m', '5': '60m', '7': '40m',
    '10': '30m', '13': '22m', '14': '20m', '18': '17m', '21': '15m',
    '24': '12m', '28': '10m', '50': '6m', '70': '4m', '144': '2m',
    '432': '70cm', '1296': '23cm',
};

const AT_SOURCES = {
    psk:  { endpoint: '/api/stats/psk-rank',  render: renderPSKAt,  snapshotTime: j => j.fetched_at },
    wspr: { endpoint: '/api/stats/wspr-rank', render: renderWSPRAt, snapshotTime: j => j.generated_at },
    rbn:  { endpoint: '/api/stats/rbn',       render: renderRBNAt,  snapshotTime: j => j.fetched_at },
};

/** Format an offset in seconds as a human phrase relative to the request. */
function fmtAtDrift(offsetSeconds) {
    const s = Math.abs(offsetSeconds);
    if (s < 60) return 'exact match';
    const mins  = Math.round(s / 60);
    const label = mins < 90 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`;
    return offsetSeconds < 0 ? `${label} earlier` : `${label} later`;
}

/** "2026-07-22T12:00:00Z" → "2026-07-22 12:00:00 UTC" */
function fmtAtStamp(iso) {
    return String(iso || '').replace('T', ' ').replace('Z', ' UTC');
}

/** Set one card's own status line. */
function setAtStatus(src, msg, cls = '') {
    const el = document.getElementById(`${src}-at-status`);
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.className = 'status-bar' + (cls ? ` ${cls}` : '');
    el.classList.remove('hidden');
}

/** Bind one card's input and button, pre-filling the current UTC hour. */
function bindAtCard(src) {
    const btn = document.getElementById(`${src}-at-btn`);
    const inp = document.getElementById(`${src}-at-input`);
    if (!btn || !inp) return;

    if (!inp.value) {
        const now = new Date();
        now.setUTCMinutes(0, 0, 0);
        inp.value = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM, UTC
    }
    btn.addEventListener('click', () => loadAt(src));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') loadAt(src); });
}

function bindAtCards() {
    Object.keys(AT_SOURCES).forEach(bindAtCard);
}

async function loadAt(src) {
    const cfg = AT_SOURCES[src];
    const inp = document.getElementById(`${src}-at-input`);
    const btn = document.getElementById(`${src}-at-btn`);
    const raw = (inp.value || '').trim();

    if (!RE_AT_LOCAL.test(raw)) {
        setAtStatus(src, 'Please choose a date and time.', 'error');
        return;
    }

    btn.disabled = true;
    setAtStatus(src, 'Loading snapshot…', 'loading');
    try {
        // The field is labelled UTC and the backend parses a bare timestamp as
        // UTC, so the value is sent through unchanged.
        const params = new URLSearchParams({ at: raw });
        if (src !== 'psk') params.set('limit', String(AT_ROW_LIMIT));

        const res  = await fetch(`${cfg.endpoint}?${params}`);
        const json = await res.json();
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);

        state.atData[src] = json;
        cfg.render(json);

        const stamp = fmtAtStamp(cfg.snapshotTime(json));
        document.getElementById(`${src}-at-drift`).textContent = `— ${stamp}`;
        setAtStatus(src, `Snapshot ${stamp} — ${fmtAtDrift(json.offset_seconds)}`, 'success');
    } catch (e) {
        state.atData[src] = null;
        clearAtCard(src);
        setAtStatus(src, `Error: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
    }
}

function clearAtCard(src) {
    const tables = document.getElementById(`${src}-at-tables`);
    if (tables) tables.innerHTML = '';
    const sel = document.getElementById(`${src}-at-selector`);
    if (sel) sel.innerHTML = '';
    const drift = document.getElementById(`${src}-at-drift`);
    if (drift) drift.textContent = '';
}

/** Render a list of table specs into a card, or a placeholder when all empty. */
function renderAtTables(src, specs, emptyMsg) {
    const host = document.getElementById(`${src}-at-tables`);
    host.innerHTML = '';
    let rendered = 0;
    for (const spec of specs) {
        if (!Array.isArray(spec.rows) || spec.rows.length === 0) continue;
        host.appendChild(buildRankTable(spec.title, spec.rows, spec.columns, spec.note));
        rendered++;
    }
    if (rendered === 0) {
        const p = document.createElement('div');
        p.className = 'no-data';
        p.textContent = emptyMsg;
        host.appendChild(p);
    }
}

// ── PSK point-in-time ─────────────────────────────────────────────────────

function renderPSKAt(json) {
    const bands = new Set();
    Object.keys(json.report_result  || {}).forEach(b => bands.add(b));
    Object.keys(json.country_result || {}).forEach(b => bands.add(b));
    const sorted = [...bands].sort(pskBandSort);

    if (!sorted.includes(state.pskAtBand)) {
        state.pskAtBand = sorted.includes('All') ? 'All' : (sorted[0] || 'All');
    }

    buildBandSelector('psk-at-selector', sorted, state.pskAtBand, b => {
        state.pskAtBand = b;
        renderPSKAtTables(json);
    });

    renderPSKAtTables(json);
}

function pskAtColumns(valueLabel) {
    return [
        { label: '#',                  cls: 'rank',     text: (e, i) => String(i + 1) },
        { label: 'Callsign',           cls: 'call',     text: e => e.callsign || '' },
        { label: `${valueLabel} 24h`,  cls: 'num',      text: e => (e.day  || 0).toLocaleString() },
        { label: `${valueLabel} 7d`,   cls: 'num',      text: e => (e.week || 0).toLocaleString() },
        { label: 'Software',           cls: 'software', text: e => fmtSoftware(e.software) },
    ];
}

function fmtSoftware(list) {
    return (list || []).map(s => s.version ? `${s.name} ${s.version}` : s.name).join(', ');
}

function renderPSKAtTables(json) {
    const band = state.pskAtBand;
    renderAtTables('psk', [
        {
            title:   `Top Monitors by Reports — ${band}`,
            rows:    (json.report_result  || {})[band],
            columns: pskAtColumns('Reports'),
        },
        {
            title:   `Top Monitors by Countries — ${band}`,
            rows:    (json.country_result || {})[band],
            columns: pskAtColumns('Countries'),
        },
    ], `No entries for ${band} in this snapshot.`);
}

// ── WSPR point-in-time ────────────────────────────────────────────────────

const WSPR_AT_WINDOWS = [
    ['rolling_24h', 'Rolling 24h'],
    ['yesterday',   'Yesterday'],
    ['today',       'Today'],
];

function renderWSPRAt(json) {
    const present = WSPR_AT_WINDOWS.filter(([key]) => json[key]).map(([key]) => key);
    if (!present.includes(state.wsprAtWindow)) state.wsprAtWindow = present[0] || 'rolling_24h';

    const labels = present.map(k => (WSPR_AT_WINDOWS.find(([key]) => key === k) || [k, k])[1]);
    const activeLabel = labels[present.indexOf(state.wsprAtWindow)];

    buildBandSelector('wspr-at-selector', labels, activeLabel, label => {
        state.wsprAtWindow = present[labels.indexOf(label)];
        renderWSPRAtTables(json);
    });

    renderWSPRAtTables(json);
}

function fmtWSPRBands(row) {
    const metres  = row.bands   || [];
    const uniques = row.uniques || [];
    return metres
        .map((m, i) => `${WSPR_METRES_NAME[String(m)] || `${m}m`} ${(uniques[i] || 0).toLocaleString()}`)
        .join(', ');
}

function renderWSPRAtTables(json) {
    const key = state.wsprAtWindow;
    const win = json[key] || {};
    const label = (WSPR_AT_WINDOWS.find(([k]) => k === key) || [key, key])[1];

    let note = '';
    if (win.total_rows && win.data && win.total_rows > win.data.length) {
        note = `Showing top ${win.data.length} of ${win.total_rows.toLocaleString()} receivers.`;
    }

    renderAtTables('wspr', [{
        title: `Receivers — ${label}`,
        rows:  win.data,
        note,
        columns: [
            { label: '#',        cls: 'rank', text: (r, i) => String(i + 1) },
            { label: 'Callsign', cls: 'call', text: r => r.rx_sign || '' },
            { label: 'Locator',  cls: 'call', text: r => r.rx_loc  || '' },
            { label: 'Unique',   cls: 'num',  text: r => (r.unique || 0).toLocaleString() },
            { label: 'Raw',      cls: 'num',  text: r => (r.raw    || 0).toLocaleString() },
            { label: 'Dupe',     cls: 'num',  text: r => (r.dupe   || 0).toLocaleString() },
            { label: 'Bands',    cls: 'software', text: fmtWSPRBands },
        ],
    }], `No receiver data in the ${label} window of this snapshot.`);
}

// ── RBN point-in-time ─────────────────────────────────────────────────────

function renderRBNAt(json) {
    const noteFor = (shown, total) =>
        total > shown ? `Showing top ${shown} of ${total.toLocaleString()} skimmers.` : '';

    renderAtTables('rbn', [
        {
            title: 'Skimmers by Spot Count',
            rows:  json.stats_entries,
            note:  noteFor((json.stats_entries || []).length, json.total_stats_entries || 0),
            columns: [
                { label: '#',        cls: 'rank', text: (e, i) => String(i + 1) },
                { label: 'Callsign', cls: 'call', text: e => e.callsign || '' },
                { label: 'Spots',    cls: 'num',  text: e => (e.spot_count || 0).toLocaleString() },
            ],
        },
        {
            title: 'Frequency Skew (largest first)',
            rows:  json.skew_entries,
            note:  noteFor((json.skew_entries || []).length, json.total_skew_entries || 0),
            columns: [
                { label: '#',          cls: 'rank', text: (e, i) => String(i + 1) },
                { label: 'Callsign',   cls: 'call', text: e => e.callsign || '' },
                { label: 'Skew (Hz)',  cls: 'num',  text: e => (e.skew ?? 0).toFixed(2) },
                { label: 'Spots',      cls: 'num',  text: e => (e.spots || 0).toLocaleString() },
                { label: 'Correction', cls: 'num',  text: e => (e.correction_factor ?? 0).toFixed(6) },
            ],
        },
    ], 'No skimmer data in this snapshot.');
}

// ── Shared table builder ──────────────────────────────────────────────────

/**
 * Build one ranking table from a column spec. Every cell is filled via
 * textContent — callsigns, locators and software strings originate from
 * third-party sources and are never treated as markup.
 */
function buildRankTable(title, rows, columns, note) {
    const wrap = document.createElement('div');
    wrap.className = 'rank-table-wrap';

    const h3 = document.createElement('h3');
    h3.textContent = title;
    wrap.appendChild(h3);

    if (note) {
        const p = document.createElement('div');
        p.className = 'rank-table-note';
        p.textContent = note;
        wrap.appendChild(p);
    }

    const scroll = document.createElement('div');
    scroll.className = 'rank-table-scroll';

    const table = document.createElement('table');
    table.className = 'rank-table';

    const thead = document.createElement('thead');
    const hrow  = document.createElement('tr');
    columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col.label;
        if (col.cls === 'num') th.style.textAlign = 'right';
        hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const station = (state.callsign || state.stationCallsign || '').toUpperCase();

    rows.forEach((row, i) => {
        const tr = document.createElement('tr');
        const call = (row.callsign || row.rx_sign || '').toUpperCase();
        if (station && call === station) tr.classList.add('is-station');
        if ((row.software || []).some(s => (s.name || '').startsWith('UberSDR'))) {
            tr.classList.add('is-ubersdr');
        }
        columns.forEach(col => {
            const td = document.createElement('td');
            td.className = col.cls;
            td.textContent = col.text(row, i);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    return wrap;
}


function buildBandSelector(containerId, bands, activeBand, onChange) {
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    bands.forEach(b => {
        const btn = document.createElement('button');
        btn.className = 'band-btn' + (b === activeBand ? ' active' : '');
        btn.textContent = b;
        btn.addEventListener('click', () => {
            el.querySelectorAll('.band-btn').forEach(x => x.classList.remove('active'));
            btn.classList.add('active');
            onChange(b);
        });
        el.appendChild(btn);
    });
}

function renderPSKRankChart(data, table, bands) {
    const activeBand = table === 'reports' ? state.pskReportsBand : state.pskCountriesBand;
    const chartId    = table === 'reports' ? 'psk-reports-chart' : 'psk-countries-chart';
    const chartKey   = table === 'reports' ? 'pskReports' : 'pskCountries';

    // Labels come from every returned snapshot, not just the ones holding a
    // match: with two stations a snapshot may carry either or both, and the
    // series must stay aligned on one time axis. Missing values become null.
    const labels    = [];
    const isoLabels = [];
    const ranks     = [];
    const days      = [];
    const ranks2    = [];
    const days2     = [];

    const pick = (cr) => {
        if (!cr) return null;
        const src = table === 'reports' ? cr.reports : cr.countries;
        return src?.[activeBand] ?? null;
    };

    for (const snap of data.snapshots) {
        labels.push(fmtTime(snap.fetched_at));
        isoLabels.push(snap.fetched_at);

        const a = pick(snap.callsign_rank);
        ranks.push(a?.rank ?? null);
        days.push(a?.day ?? null);

        const b = pick(snap.callsign_rank2);
        ranks2.push(b?.rank ?? null);
        days2.push(b?.day ?? null);
    }

    const swEnabled = swOverlayEnabled() && state.swData && state.swData.length > 0;
    const datasets = [
        cmpSeries(seriesLabel('Rank', state.callsign), ranks, CMP_PRIMARY_R,
            { fill: !comparing(), yAxisID: 'yRank' }),
        cmpSeries(seriesLabel('Day count', state.callsign), days, CMP_PRIMARY,
            { yAxisID: 'yCount' }),
    ];
    if (comparing()) {
        datasets.push(
            cmpSeries(seriesLabel('Rank', state.callsign2), ranks2, CMP_SECOND_R,
                { yAxisID: 'yRank', borderDash: [6, 3] }),
            cmpSeries(seriesLabel('Day count', state.callsign2), days2, CMP_SECOND,
                { yAxisID: 'yCount', borderDash: [6, 3] }),
        );
    }
    if (swEnabled) {
        const lookup = buildSWLookup(state.swData);
        datasets.push(makeKIndexDataset(isoLabels, lookup));
    }

    const ctx = document.getElementById(chartId);
    if (state.charts[chartKey]) state.charts[chartKey].destroy();
    state.charts[chartKey] = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } } },
            scales: {
                x: { title: { display: true, text: 'Time (UTC)', color: '#a0aec0' }, ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.06)' } },
                yRank:  { type: 'linear', position: 'left',  reverse: true,  title: { display: true, text: 'Rank', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0 } },
                yCount: { type: 'linear', position: 'right', reverse: false, title: { display: true, text: 'Day count', color: '#a0aec0' }, grid: { drawOnChartArea: false }, ticks: { precision: 0 } },
                ...(swEnabled ? { ySW: makeSWAxis('K-index', 0, 9) } : {}),
            },
        },
    });
}

function renderPSKTrendChart(data, table, canvasId, chartKey) {
    // Show total day-count trend across all bands (no callsign filter)
    const labels = [];
    const totals = [];

    for (const snap of data.snapshots) {
        const src = table === 'reports' ? snap.report_result : snap.country_result;
        if (!src) continue;
        labels.push(fmtTime(snap.fetched_at));
        let total = 0;
        for (const entries of Object.values(src)) {
            if (Array.isArray(entries)) entries.forEach(e => { total += e.day || 0; });
        }
        totals.push(total);
    }

    const datasets = [{
        label: table === 'reports' ? 'Total reports (day)' : 'Total countries (day)',
        data: totals,
        borderColor: table === 'reports' ? PALETTE[0] : PALETTE[1],
        backgroundColor: (table === 'reports' ? PALETTE[0] : PALETTE[1]) + '33',
        tension: 0.3,
        fill: true,
        pointRadius: 3,
        yAxisID: 'y',
    }];

    const isoLabels = data.snapshots
        .filter(snap => (table === 'reports' ? snap.report_result : snap.country_result))
        .map(snap => snap.fetched_at);

    const swEnabled = swOverlayEnabled() && state.swData && state.swData.length > 0;
    if (swEnabled) {
        const lookup = buildSWLookup(state.swData);
        datasets.push(makeKIndexDataset(isoLabels, lookup));
    }

    const ctx = document.getElementById(canvasId);
    if (state.charts[chartKey]) state.charts[chartKey].destroy();
    state.charts[chartKey] = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } } },
            scales: {
                x: { title: { display: true, text: 'Time (UTC)', color: '#a0aec0' }, ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.06)' } },
                y: { title: { display: true, text: 'Count', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0 } },
                ...(swEnabled ? { ySW: makeSWAxis('K-index', 0, 9) } : {}),
            },
        },
    });
}

function renderPSKFullChart(data) {
    // Bar chart: top 20 reporters for the selected band in the latest snapshot
    const latest = data.snapshots[data.snapshots.length - 1];
    if (!latest) return;

    const band    = state.pskFullBand;
    const entries = (latest.report_result?.[band] || []).slice(0, 20);

    const labels   = entries.map(e => e.callsign);
    const dayVals  = entries.map(e => e.day);
    const weekVals = entries.map(e => e.week);

    const datasets = [
        { label: 'Day',  data: dayVals,  backgroundColor: PALETTE[0]+'cc' },
        { label: 'Week', data: weekVals, backgroundColor: PALETTE[2]+'88' },
    ];

    const ctx = document.getElementById('psk-full-chart');
    if (state.charts.pskFull) state.charts.pskFull.destroy();
    state.charts.pskFull = new Chart(ctx, makeBarConfig(labels, datasets, 'Reports'));
    // Re-enable legend for this chart
    state.charts.pskFull.options.plugins.legend.display = true;
    state.charts.pskFull.update();
}

// ── RBN rendering ─────────────────────────────────────────────────────────

/**
 * RBN awards — latest snapshot only, callsign mode.
 * Shows a rank medal if stats_rank ≤ 3.
 */
function renderRBNAwards(data) {
    const cs = state.callsign;
    if (!cs || !data.snapshots || data.snapshots.length === 0) {
        document.getElementById('rbn-awards').classList.add('hidden');
        return;
    }

    const latest = data.snapshots[data.snapshots.length - 1];
    const cd = latest?.callsign_data;
    if (!cd) {
        document.getElementById('rbn-awards').classList.add('hidden');
        return;
    }

    const rank = cd.stats_rank;
    if (!rank || rank < 1 || rank > 3) {
        document.getElementById('rbn-awards').classList.add('hidden');
        return;
    }

    renderAwards('rbn-awards', [{ rank, text: 'Spot count', priority: 0 }], comparing() ? state.callsign : '');
}

/**
 * RBN snapshot summary — shows current spot count, rank, and skew
 * for the callsign (callsign mode) or total spot count (full mode).
 */
function renderRBNSummary(data) {
    const el = document.getElementById('rbn-summary');
    if (!data.snapshots || data.snapshots.length === 0) { el.classList.add('hidden'); return; }

    const latest = data.snapshots[data.snapshots.length - 1];
    const cs = state.callsign;

    const pill = (key, val, extraClass = '') =>
        `<span class="summary-pill"><span class="pill-key">${key}</span><span class="pill-val${extraClass ? ' ' + extraClass : ''}">${val}</span></span>`;

    // One station's pills, or '' when it has neither spots nor a rank.
    const stationHTML = (cd) => {
        if (!cd) return '';
        const spotCount = cd.statistics?.spot_count;
        if (!spotCount && !cd.stats_rank) return '';

        let html = '<span class="summary-group">';
        if (spotCount != null) html += pill('Spots', spotCount.toLocaleString());
        if (cd.stats_rank > 0) html += pill('Rank', `#${cd.stats_rank}`, 'pill-rank');
        if (cd.skew?.skew != null) {
            const skewVal = cd.skew.skew;
            html += pill('Skew', (skewVal >= 0 ? '+' : '') + skewVal.toFixed(2) + ' Hz');
        }
        return html + '</span>';
    };

    if (cs) {
        const html = joinSummaries([
            { callsign: cs,              html: stationHTML(latest?.callsign_data) },
            { callsign: state.callsign2, html: stationHTML(latest?.callsign_data2) },
        ]);
        if (!html) { el.classList.add('hidden'); return; }
        el.innerHTML = html;
        el.classList.remove('hidden');
    } else {
        // Full mode: total spot count from latest snapshot
        const total = (latest?.stats_entries || []).reduce((s, e) => s + (e.spot_count || 0), 0);
        if (!total) { el.classList.add('hidden'); return; }
        el.innerHTML = `<span class="summary-group">${pill('Total spots', total.toLocaleString())}</span>`;
        el.classList.remove('hidden');
    }
}

function renderRBN(data) {
    const noData = document.getElementById('rbn-no-data');
    if (!data.snapshots || data.snapshots.length === 0) {
        noData.classList.remove('hidden');
        ['rbnSpots','rbnRank','rbnSkew'].forEach(k => {
            if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
        });
        document.getElementById('rbn-awards').classList.add('hidden');
        document.getElementById('rbn-summary').classList.add('hidden');
        return;
    }
    noData.classList.add('hidden');
    renderRBNAwards(data);
    renderRBNSummary(data);

    const cs = state.callsign;

    const labels      = [];
    const isoLabels   = [];
    const spotCounts  = [];
    const ranks       = [];
    const spotCounts2 = [];
    const ranks2      = [];

    for (const snap of data.snapshots) {
        const label = fmtDate(snap.fetched_at);

        if (cs) {
            // Callsign mode. A day is kept when either station reported, so
            // both series stay on the same axis; the absent one gets a null.
            const cd  = snap.callsign_data;
            const cd2 = snap.callsign_data2;
            if (!cd && !cd2) continue;
            labels.push(label);
            isoLabels.push(snap.fetched_at);
            spotCounts.push(cd?.statistics?.spot_count ?? null);
            ranks.push(cd?.stats_rank > 0 ? cd.stats_rank : null);
            spotCounts2.push(cd2?.statistics?.spot_count ?? null);
            ranks2.push(cd2?.stats_rank > 0 ? cd2.stats_rank : null);
        } else {
            // Full mode: sum all spot counts
            labels.push(label);
            isoLabels.push(snap.fetched_at);
            const total = (snap.stats_entries || []).reduce((s, e) => s + (e.spot_count || 0), 0);
            spotCounts.push(total);
            ranks.push(null);
        }
    }

    // Spot count chart
    {
        const datasets = [
            cmpSeries(cs ? seriesLabel('spot count', cs) : 'Total spot count',
                spotCounts, CMP_PRIMARY, { fill: !comparing(), pointRadius: 4, yAxisID: 'y' }),
        ];
        if (comparing()) {
            datasets.push(cmpSeries(seriesLabel('spot count', state.callsign2), spotCounts2,
                CMP_SECOND, { pointRadius: 4, yAxisID: 'y', borderDash: [6, 3] }));
        }

        const swEnabled = swOverlayEnabled() && state.swData && state.swData.length > 0;
        if (swEnabled) {
            const lookup = buildSWLookup(state.swData);
            datasets.push(makeSFIDataset(isoLabels, lookup, 'ySFI'));
            datasets.push(makeAIndexDataset(isoLabels, lookup, 'yA'));
        }

        const ctx = document.getElementById('rbn-spots-chart');
        if (state.charts.rbnSpots) state.charts.rbnSpots.destroy();
        state.charts.rbnSpots = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } } },
                scales: {
                    x: { title: { display: true, text: 'Time (UTC)', color: '#a0aec0' }, ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.06)' } },
                    y: { title: { display: true, text: 'Spot count', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0 } },
                    ...(swEnabled ? {
                        ySFI: makeSWAxis('Solar Flux (SFU)', 60, 220),
                        yA:   { type: 'linear', position: 'right', title: { display: true, text: 'A-index', color: '#fc8181', font: { size: 11 } }, grid: { drawOnChartArea: false }, ticks: { color: '#fc8181', precision: 0 }, min: 0, suggestedMax: 50 },
                    } : {}),
                },
            },
        });
        document.getElementById('rbn-spots-label').textContent = callsignHeading();
    }

    // Rank chart (callsign mode only)
    const rankCard = document.getElementById('rbn-rank-chart').closest('.chart-card');
    if (cs) {
        rankCard.classList.remove('hidden');
        document.getElementById('rbn-rank-label').textContent = callsignHeading();
        const swEnabled = swOverlayEnabled() && state.swData && state.swData.length > 0;
        const datasets = [
            cmpSeries(seriesLabel('Rank', cs), ranks, CMP_PRIMARY_R,
                { fill: !comparing(), pointRadius: 4, yAxisID: 'y' }),
        ];
        if (comparing()) {
            datasets.push(cmpSeries(seriesLabel('Rank', state.callsign2), ranks2, CMP_SECOND_R,
                { pointRadius: 4, yAxisID: 'y', borderDash: [6, 3] }));
        }
        if (swEnabled) {
            const lookup = buildSWLookup(state.swData);
            datasets.push(makeSFIDataset(isoLabels, lookup, 'ySFI'));
            datasets.push(makeAIndexDataset(isoLabels, lookup, 'yA'));
        }
        const ctx = document.getElementById('rbn-rank-chart');
        if (state.charts.rbnRank) state.charts.rbnRank.destroy();
        state.charts.rbnRank = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 14 } } },
                scales: {
                    x: { title: { display: true, text: 'Time (UTC)', color: '#a0aec0' }, ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.06)' } },
                    y: { reverse: true, title: { display: true, text: 'Rank (lower = better)', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0 } },
                    ...(swEnabled ? {
                        ySFI: makeSWAxis('Solar Flux (SFU)', 60, 220),
                        yA:   { type: 'linear', position: 'right', title: { display: true, text: 'A-index', color: '#fc8181', font: { size: 11 } }, grid: { drawOnChartArea: false }, ticks: { color: '#fc8181', precision: 0 }, min: 0, suggestedMax: 50 },
                    } : {}),
                },
            },
        });
    } else {
        rankCard.classList.add('hidden');
    }

    // Skew chart
    const skewCard = document.getElementById('rbn-skew-card');
    const latest = data.snapshots[data.snapshots.length - 1];
    const ctx = document.getElementById('rbn-skew-chart');
    if (state.charts.rbnSkew) { state.charts.rbnSkew.destroy(); state.charts.rbnSkew = null; }

    if (cs) {
        // Callsign mode: skew over time as a line chart
        const skewLabels = [];
        const skewVals   = [];
        const skewVals2  = [];
        const skewOf = (cd) => {
            const e = cd?.skew;
            return (e && typeof e.skew === 'number') ? e.skew : null;
        };
        for (const snap of data.snapshots) {
            const a = skewOf(snap.callsign_data);
            const b = skewOf(snap.callsign_data2);
            if (a == null && b == null) continue;
            skewLabels.push(fmtDate(snap.fetched_at));
            skewVals.push(a);
            skewVals2.push(b);
        }
        if (skewLabels.length) {
            skewCard.classList.remove('hidden');
            const datasets = [
                cmpSeries(seriesLabel('skew (Hz)', cs), skewVals, PALETTE[4],
                    { fill: !comparing(), pointRadius: 4 }),
            ];
            if (comparing()) {
                datasets.push(cmpSeries(seriesLabel('skew (Hz)', state.callsign2), skewVals2,
                    PALETTE[5], { pointRadius: 4, borderDash: [6, 3] }));
            }
            state.charts.rbnSkew = new Chart(ctx, makeChartConfig(skewLabels, datasets, 'Skew (Hz)'));
        } else {
            skewCard.classList.add('hidden');
        }
    } else if (latest?.skew_entries?.length) {
        // Full mode: bar chart of top 30 skimmers by |skew| from latest snapshot
        skewCard.classList.remove('hidden');
        const sorted = [...latest.skew_entries]
            .sort((a, b) => Math.abs(b.skew) - Math.abs(a.skew))
            .slice(0, 30);
        const skLabels = sorted.map(e => e.callsign);
        const skValues = sorted.map(e => e.skew);
        const skColors = skValues.map(v => v >= 0 ? PALETTE[0]+'cc' : PALETTE[3]+'cc');

        state.charts.rbnSkew = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: skLabels,
                datasets: [{ label: 'Skew (Hz)', data: skValues, backgroundColor: skColors }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: item => `${item.raw > 0 ? '+' : ''}${item.raw.toFixed(2)} Hz` } },
                },
                scales: {
                    x: { ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 30, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
                    y: { title: { display: true, text: 'Skew (Hz)', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' } },
                },
            },
        });
    } else {
        skewCard.classList.add('hidden');
    }
}