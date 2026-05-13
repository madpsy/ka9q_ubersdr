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
    'vlf','4000m','2200m','1000m','630m','600m','560m','160m','80m','60m',
    '40m','30m','20m','17m','15m','12m','10m','6m','4m','2m','1.25m',
    '70cm','33cm','23cm','13cm','9cm','6cm','3cm','1.25cm','6mm','4mm',
    '2.5mm','2mm','1mm','All','invalid',
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
    }) + ' UTC';
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
    activeTab: 'wspr',
    stationCallsign: '',   // from /api/description receiver.callsign
    callsign: '',          // user-entered filter

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
    wsprUniqueWin: 'rolling_24h',
    wsprRankWin:   'rolling_24h',

    // active band for PSK charts
    pskReportsBand:    'All',
    pskCountriesBand:  'All',
    pskFullBand:       'All',

    // raw fetched data
    wsprData: null,
    pskData:  null,
    rbnData:  null,
};

// ── Initialise ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    bindTabs();
    bindControls();
    bindWindowTabs();
    setDefaultDates();
    // Load description first (pre-fills callsign), then auto-run the initial query.
    loadDescription().then(() => loadAll());
});

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

        // Station callsign — prefer receiver.callsign, fall back to cw_skimmer_callsign
        const cs = (d.receiver?.callsign || d.cw_skimmer_callsign || '').trim().toUpperCase();
        if (cs && cs !== 'N0CALL') {
            state.stationCallsign = cs;
            const inp = document.getElementById('callsign-input');
            if (!inp.value) inp.value = cs;
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
function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => {
                c.classList.toggle('hidden', !c.id.endsWith(tab));
                c.classList.toggle('active', c.id.endsWith(tab));
            });
            state.activeTab = tab;
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

    document.getElementById('callsign-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') loadAll();
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
    state.callsign = cs; // always uppercase

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
        const [wsprRes, pskRes, rbnRes] = await Promise.all([
            fetch(`/api/stats/wspr-rank?${params}`),
            fetch(`/api/stats/psk-rank?${params}`),
            fetch(`/api/stats/rbn?${params}`),
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

        renderWSPR(wsprJson);
        renderPSK(pskJson);
        renderRBN(rbnJson);

        const total = (wsprJson.count || 0) + (pskJson.count || 0) + (rbnJson.count || 0);
        setStatus(
            `Loaded — WSPR: ${wsprJson.count} snapshots · PSK: ${pskJson.count} snapshots · RBN: ${rbnJson.count} days`,
            'success'
        );
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

// ── Awards helpers ────────────────────────────────────────────────────────

const MEDAL_CLASS = ['gold', 'silver', 'bronze'];
const MEDAL_EMOJI = ['🥇', '🥈', '🥉'];

/**
 * Render an awards bar from a flat list of badge objects.
 * Badges are sorted by rank (1→2→3) then by their existing order (priority).
 *
 * @param {string} containerId
 * @param {Array}  badges  - [{rank (1-3), text, priority (lower = first within same rank)}]
 */
function renderAwards(containerId, badges) {
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
        return;
    }
    noData.classList.add('hidden');
    renderWSPRAwards(data);
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

        // Overall rank for this window — priority 0 (before per-band)
        if (w.rank >= 1 && w.rank <= 3) {
            badges.push({ rank: w.rank, text: `${WIN_LABELS[win]} Overall`, priority: wi * 1000 });
        }

        // Per-band ranks — priority 1+ within the window
        if (w.band_ranks) {
            Object.entries(w.band_ranks)
                .filter(([, r]) => r >= 1 && r <= 3)
                .forEach(([band, r], bi) => {
                    badges.push({ rank: r, text: `${WIN_LABELS[win]} ${band}`, priority: wi * 1000 + 1 + bi });
                });
        }
    });

    renderAwards('wspr-awards', badges);
}

function getWSPRWindow(snap, win) {
    // snap may have full window objects or callsign_rank
    if (snap.callsign_rank) return snap.callsign_rank[win] || null;
    return snap[win] || null;
}

function renderWSPRUnique(data) {
    const win = state.wsprUniqueWin;
    const cs  = state.callsign;

    const labels   = [];
    const uniqueVals = [];
    const rawVals    = [];

    for (const snap of data.snapshots) {
        const w = getWSPRWindow(snap, win);
        if (!w) continue;
        labels.push(fmtTime(snap.generated_at));

        if (cs) {
            // callsign_rank mode: unique / raw per window
            uniqueVals.push(w.unique ?? null);
            rawVals.push(w.raw ?? null);
        } else {
            // full window: sum all rows
            const rows = w.data || [];
            uniqueVals.push(rows.reduce((s, r) => s + (r.unique || 0), 0));
            rawVals.push(rows.reduce((s, r) => s + (r.raw || 0), 0));
        }
    }

    const datasets = cs
        ? [
            { label: 'Unique', data: uniqueVals, borderColor: PALETTE[0], backgroundColor: PALETTE[0]+'33', tension: 0.3, fill: true, pointRadius: 3 },
            { label: 'Raw',    data: rawVals,    borderColor: PALETTE[1], backgroundColor: PALETTE[1]+'33', tension: 0.3, fill: false, pointRadius: 3 },
          ]
        : [
            { label: 'Total Unique', data: uniqueVals, borderColor: PALETTE[0], backgroundColor: PALETTE[0]+'33', tension: 0.3, fill: true, pointRadius: 3 },
            { label: 'Total Raw',    data: rawVals,    borderColor: PALETTE[2], backgroundColor: PALETTE[2]+'22', tension: 0.3, fill: false, pointRadius: 3 },
          ];

    const ctx = document.getElementById('wspr-unique-chart');
    if (state.charts.wsprUnique) state.charts.wsprUnique.destroy();
    state.charts.wsprUnique = new Chart(ctx, makeChartConfig(labels, datasets, 'Spots'));
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
    document.getElementById('wspr-rank-label').textContent = cs ? `— ${cs}` : '';

    const labels = [];
    const ranks  = [];

    for (const snap of data.snapshots) {
        const w = getWSPRWindow(snap, win);
        if (!w) continue;
        labels.push(fmtTime(snap.generated_at));
        ranks.push(w.rank ?? null);
    }

    const datasets = [{
        label: 'Rank',
        data: ranks,
        borderColor: PALETTE[3],
        backgroundColor: PALETTE[3]+'33',
        tension: 0.3,
        fill: true,
        pointRadius: 3,
    }];

    const ctx = document.getElementById('wspr-rank-chart');
    if (state.charts.wsprRank) state.charts.wsprRank.destroy();
    state.charts.wsprRank = new Chart(ctx, makeChartConfig(labels, datasets, 'Rank (lower = better)', true));
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

    renderAwards('psk-awards', badges);
}

function renderPSK(data) {
    const noData = document.getElementById('psk-no-data');
    if (!data.snapshots || data.snapshots.length === 0) {
        noData.classList.remove('hidden');
        ['pskReports','pskCountries','pskFull'].forEach(k => {
            if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
        });
        document.getElementById('psk-awards').classList.add('hidden');
        return;
    }
    noData.classList.add('hidden');
    renderPSKAwards(data);

    const cs = state.callsign;

    if (cs) {
        // Callsign mode: rank over time per band
        document.getElementById('psk-full-card').classList.add('hidden');

        // Collect all bands present across all snapshots
        const reportBands   = new Set();
        const countryBands  = new Set();
        for (const snap of data.snapshots) {
            const cr = snap.callsign_rank;
            if (!cr) continue;
            Object.keys(cr.reports   || {}).forEach(b => reportBands.add(b));
            Object.keys(cr.countries || {}).forEach(b => countryBands.add(b));
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

        document.getElementById('psk-reports-label').textContent   = `— ${cs}`;
        document.getElementById('psk-countries-label').textContent = `— ${cs}`;
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

    const labels = [];
    const ranks  = [];
    const days   = [];

    for (const snap of data.snapshots) {
        const cr = snap.callsign_rank;
        if (!cr) continue;
        const src = table === 'reports' ? cr.reports : cr.countries;
        const entry = src?.[activeBand];
        labels.push(fmtTime(snap.fetched_at));
        ranks.push(entry?.rank ?? null);
        days.push(entry?.day  ?? null);
    }

    const datasets = [
        { label: 'Rank',      data: ranks, borderColor: PALETTE[3], backgroundColor: PALETTE[3]+'33', tension: 0.3, fill: true,  pointRadius: 3, yAxisID: 'yRank' },
        { label: 'Day count', data: days,  borderColor: PALETTE[0], backgroundColor: PALETTE[0]+'22', tension: 0.3, fill: false, pointRadius: 3, yAxisID: 'yCount' },
    ];

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
                x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.06)' } },
                yRank:  { type: 'linear', position: 'left',  reverse: true,  title: { display: true, text: 'Rank', color: '#a0aec0' }, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { precision: 0 } },
                yCount: { type: 'linear', position: 'right', reverse: false, title: { display: true, text: 'Day count', color: '#a0aec0' }, grid: { drawOnChartArea: false }, ticks: { precision: 0 } },
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
    }];

    const ctx = document.getElementById(canvasId);
    if (state.charts[chartKey]) state.charts[chartKey].destroy();
    state.charts[chartKey] = new Chart(ctx, makeChartConfig(labels, datasets, 'Count'));
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

    renderAwards('rbn-awards', [{ label: 'Overall', badges: [{ rank, text: `#${rank} Spot count` }] }]);
}

function renderRBN(data) {
    const noData = document.getElementById('rbn-no-data');
    if (!data.snapshots || data.snapshots.length === 0) {
        noData.classList.remove('hidden');
        ['rbnSpots','rbnRank','rbnSkew'].forEach(k => {
            if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
        });
        document.getElementById('rbn-awards').classList.add('hidden');
        return;
    }
    noData.classList.add('hidden');
    renderRBNAwards(data);

    const cs = state.callsign;

    const labels     = [];
    const spotCounts = [];
    const ranks      = [];
    const skewLabels = [];
    const skewVals   = [];

    for (const snap of data.snapshots) {
        const label = fmtDate(snap.fetched_at);

        if (cs) {
            // Callsign mode
            const cd = snap.callsign_data;
            if (!cd) continue;
            labels.push(label);
            spotCounts.push(cd.statistics?.spot_count ?? null);
            ranks.push(cd.stats_rank > 0 ? cd.stats_rank : null);
        } else {
            // Full mode: sum all spot counts
            labels.push(label);
            const total = (snap.stats_entries || []).reduce((s, e) => s + (e.spot_count || 0), 0);
            spotCounts.push(total);
            ranks.push(null);
        }
    }

    // Spot count chart
    {
        const datasets = [{
            label: cs ? `${cs} spot count` : 'Total spot count',
            data: spotCounts,
            borderColor: PALETTE[0],
            backgroundColor: PALETTE[0]+'33',
            tension: 0.3,
            fill: true,
            pointRadius: 4,
        }];
        const ctx = document.getElementById('rbn-spots-chart');
        if (state.charts.rbnSpots) state.charts.rbnSpots.destroy();
        state.charts.rbnSpots = new Chart(ctx, makeChartConfig(labels, datasets, 'Spot count'));
        document.getElementById('rbn-spots-label').textContent = cs ? `— ${cs}` : '';
    }

    // Rank chart (callsign mode only)
    const rankCard = document.getElementById('rbn-rank-chart').closest('.chart-card');
    if (cs) {
        rankCard.classList.remove('hidden');
        document.getElementById('rbn-rank-label').textContent = `— ${cs}`;
        const datasets = [{
            label: 'Rank',
            data: ranks,
            borderColor: PALETTE[3],
            backgroundColor: PALETTE[3]+'33',
            tension: 0.3,
            fill: true,
            pointRadius: 4,
        }];
        const ctx = document.getElementById('rbn-rank-chart');
        if (state.charts.rbnRank) state.charts.rbnRank.destroy();
        state.charts.rbnRank = new Chart(ctx, makeChartConfig(labels, datasets, 'Rank (lower = better)', true));
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
        for (const snap of data.snapshots) {
            const skewEntry = snap.callsign_data?.skew;
            if (skewEntry == null) continue;
            skewLabels.push(fmtDate(snap.fetched_at));
            skewVals.push(typeof skewEntry.skew === 'number' ? skewEntry.skew : null);
        }
        if (skewLabels.length) {
            skewCard.classList.remove('hidden');
            const datasets = [{
                label: `${cs} skew (Hz)`,
                data: skewVals,
                borderColor: PALETTE[4],
                backgroundColor: PALETTE[4]+'33',
                tension: 0.3,
                fill: true,
                pointRadius: 4,
            }];
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