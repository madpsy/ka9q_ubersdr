// snr-monitor.js — the "SNR Monitor" section of noisefloor.html.
//
// Polls /api/snr for one range (a preset from /api/snr/ranges, or a custom lo/hi),
// plots p5/p50/p95 and SNR over time, and records every reading in the browser so it
// can be downloaded as CSV. Nothing is stored on the server. Markers drop a labelled
// line on the chart and into the CSV, for A/B antenna comparisons.
//
// The pure helpers at the bottom are exported for node when `module` exists, so they
// can be checked without a browser.

(function () {
    'use strict';

    const MAX_ROWS = 21600;          // 6 hours at one reading a second
    const DEFAULT_RANGE = '20m';
    const MAX_CAPTURES = 20;
    const MIN_CAPTURE_READINGS = 3;
    const MAX_CAPTURE_READINGS = 3600;
    const CAPTURE_STORE = 'ubersdr.snr.captures.v1';
    const CSV_FIELDS = ['timestamp', 'range', 'lo_khz', 'hi_khz', 'source', 'bin_width_hz', 'bins',
        'avg_sec', 'samples', 'min_db', 'max_db', 'mean_db', 'p5_db', 'p10_db', 'p50_db', 'p95_db',
        'snr_db', 'occupancy_pct', 'marker'];

    // ── pure helpers ──────────────────────────────────────────────────────────

    function groupRanges(ranges) {
        const groups = { amateur: [], broadcast: [], wide: [] };
        for (const r of ranges || []) {
            if (r.name === 'all' || r.name === 'hf') groups.wide.push(r);
            else if (/^bc/i.test(r.name)) groups.broadcast.push(r);
            else groups.amateur.push(r);
        }
        return groups;
    }

    // Builds the query for a selection, or returns {error} for input the server
    // would refuse anyway, so the user sees why before a request is made.
    function buildQuery(sel) {
        const params = new URLSearchParams();
        if (sel.mode === 'custom') {
            const lo = Number(sel.lo), hi = Number(sel.hi);
            if (sel.lo === '' || sel.hi === '' || !Number.isFinite(lo) || !Number.isFinite(hi)) {
                return { error: 'Enter both frequencies in kHz' };
            }
            if (lo < 0 || hi < 0) return { error: 'Frequencies cannot be negative' };
            if (hi <= lo) return { error: 'High edge must be above low edge' };
            params.set('lo', String(lo));
            params.set('hi', String(hi));
        } else {
            if (!sel.range) return { error: 'Choose a range' };
            params.set('range', sel.range);
        }
        const avg = Number(sel.avg);
        if (!Number.isInteger(avg) || avg < 0 || avg > 60) {
            return { error: 'Averaging must be 0-60 seconds' };
        }
        if (avg > 0) params.set('avg', String(avg));
        return { query: params.toString() };
    }

    function csvCell(v) {
        if (v === undefined || v === null) return '';
        const s = String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function toCSV(rows) {
        const lines = [CSV_FIELDS.join(',')];
        for (const r of rows) lines.push(CSV_FIELDS.map(f => csvCell(r[f])).join(','));
        return lines.join('\n') + '\n';
    }

    function shellQuote(s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    function curlExamples(origin, query) {
        const api = origin + '/api/snr';
        const current = api + '?' + query;
        return [
            {
                title: 'List the ranges this receiver can measure',
                note: 'Each entry gives the span, and the source and bin width it is measured from.',
                cmd: 'curl -s ' + shellQuote(api + '/ranges'),
            },
            {
                title: 'One reading of your current selection',
                cmd: 'curl -s ' + shellQuote(current),
            },
            {
                title: 'A whole amateur band',
                cmd: 'curl -s ' + shellQuote(api + '?range=20m'),
            },
            {
                title: 'A custom range in kHz, averaged over 5 seconds',
                note: 'Fits inside 20m, so it is measured from the 20m channel at full resolution.',
                cmd: 'curl -s ' + shellQuote(api + '?lo=14000&hi=14070&avg=5'),
            },
            {
                title: 'A broadcast band',
                note: 'Not a monitored band, so it is sliced from the wideband spectrum (coarser bins).',
                cmd: 'curl -s ' + shellQuote(api + '?range=bc49m'),
            },
            {
                title: 'Poll once a second and print time, SNR, p50, p95 (needs jq)',
                cmd: 'while true; do\n  curl -s ' + shellQuote(current) +
                    " | jq -r '[.timestamp, .snr_db, .p50_db, .p95_db] | @tsv'\n  sleep 1\ndone",
            },
            {
                title: 'Log to a CSV file once a second (needs jq; Ctrl-C to stop)',
                cmd: "echo 'timestamp,snr_db,p5_db,p50_db,p95_db' > snr.csv\nwhile true; do\n  curl -s " +
                    shellQuote(current) +
                    " | jq -r 'select(.snr_db != null) | [.timestamp, .snr_db, .p5_db, .p50_db, .p95_db] | @csv' >> snr.csv\n  sleep 1\ndone",
            },
            {
                title: 'See why a request is refused',
                note: 'Errors come back as {"error": "..."} with a 4xx/5xx status. This range is too narrow.',
                cmd: 'curl -s -w \'\\nHTTP %{http_code}\\n\' ' + shellQuote(api + '?lo=14000&hi=14001'),
            },
        ];
    }

    // ── captures (A/B comparison) ─────────────────────────────────────────────

    const CAPTURE_METRICS = [
        { key: 'snr_db', label: 'SNR' },
        { key: 'p5_db', label: 'p5 (noise)' },
        { key: 'p10_db', label: 'p10' },
        { key: 'p50_db', label: 'p50' },
        { key: 'p95_db', label: 'p95' },
        { key: 'mean_db', label: 'Mean' },
        { key: 'max_db', label: 'Max' },
        { key: 'occupancy_pct', label: 'Occupancy %' },
    ];

    // Two captures can only be compared when they measured the same bins the same
    // way: percentiles move with range, resolution and averaging.
    function captureKey(row) {
        return [row.source, row.lo_khz, row.hi_khz, row.bin_width_hz, row.avg_sec].join('|');
    }

    function describeKey(c) {
        return `${c.range || 'custom'} ${c.lo_khz}-${c.hi_khz} kHz · ${c.source} @ ` +
            `${Math.round(c.bin_width_hz * 100) / 100} Hz · avg ${c.avg_sec}s`;
    }

    // Summarises readings into one data set: per metric, the mean, sample standard
    // deviation, min and max of the readings. Means are of the dB values, as the
    // readings themselves are.
    function summarizeCapture(name, rows) {
        if (!rows.length) return null;
        const first = rows[0];
        const stats = {};
        for (const m of CAPTURE_METRICS) {
            const v = rows.map(r => r[m.key]).filter(x => typeof x === 'number' && Number.isFinite(x));
            if (!v.length) continue;
            const mean = v.reduce((a, b) => a + b, 0) / v.length;
            const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
            stats[m.key] = { mean, sd, min: Math.min(...v), max: Math.max(...v) };
        }
        return {
            id: 'c' + Date.parse(first.timestamp) + '-' + Math.random().toString(36).slice(2, 7),
            name,
            key: captureKey(first),
            range: first.range || '',
            lo_khz: first.lo_khz,
            hi_khz: first.hi_khz,
            source: first.source,
            bin_width_hz: first.bin_width_hz,
            avg_sec: first.avg_sec,
            readings: rows.length,
            start: rows[0].timestamp,
            end: rows[rows.length - 1].timestamp,
            stats,
        };
    }

    // One comparison row per capture: its stats plus the difference from the
    // baseline, or comparable:false when it measured something else.
    function compareCaptures(captures, baselineId) {
        const base = captures.find(c => c.id === baselineId) || captures[0];
        return captures.map(c => {
            const comparable = !!base && c.key === base.key;
            const delta = {};
            if (comparable && c !== base) {
                for (const m of CAPTURE_METRICS) {
                    if (c.stats[m.key] && base.stats[m.key]) delta[m.key] = c.stats[m.key].mean - base.stats[m.key].mean;
                }
            }
            return { capture: c, isBaseline: c === base, comparable, delta };
        });
    }

    function comparisonCSV(captures, baselineId) {
        const head = ['name', 'baseline', 'comparable', 'range', 'lo_khz', 'hi_khz', 'source', 'bin_width_hz',
            'avg_sec', 'readings', 'start', 'end'];
        for (const m of CAPTURE_METRICS) head.push(m.key + '_mean', m.key + '_sd', m.key + '_min', m.key + '_max', m.key + '_delta');
        const lines = [head.join(',')];
        for (const row of compareCaptures(captures, baselineId)) {
            const c = row.capture;
            const cells = [c.name, row.isBaseline, row.comparable, c.range, c.lo_khz, c.hi_khz, c.source,
                c.bin_width_hz, c.avg_sec, c.readings, c.start, c.end];
            for (const m of CAPTURE_METRICS) {
                const s = c.stats[m.key] || {};
                const r = x => (typeof x === 'number' ? Math.round(x * 100) / 100 : '');
                cells.push(r(s.mean), r(s.sd), r(s.min), r(s.max), r(row.delta[m.key]));
            }
            lines.push(cells.map(csvCell).join(','));
        }
        return lines.join('\n') + '\n';
    }

    // Drops anything in storage that isn't a well-formed capture, so a corrupted
    // or hand-edited entry can't break the page.
    function sanitizeCaptures(list) {
        if (!Array.isArray(list)) return [];
        return list.filter(c => c && typeof c === 'object' && typeof c.id === 'string' &&
            typeof c.name === 'string' && typeof c.key === 'string' && c.stats && typeof c.stats === 'object' &&
            Number.isFinite(c.readings)).slice(0, MAX_CAPTURES);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            groupRanges, buildQuery, toCSV, csvCell, shellQuote, curlExamples, CSV_FIELDS,
            CAPTURE_METRICS, captureKey, summarizeCapture, compareCaptures, comparisonCSV, sanitizeCaptures,
        };
        return;
    }

    // ── browser ───────────────────────────────────────────────────────────────

    const $ = id => document.getElementById(id);

    const state = {
        ranges: [],
        rows: [],
        timer: null,
        running: true,
        inflight: false,
        lastTimestamp: null,
        pendingMarker: '',
        query: '',
        chart: null,
        markerCount: 0,
        capture: null,       // in progress: {name, rows, endsAt, timer}
        captures: [],        // saved data sets
        baselineId: null,
        compareChart: null,
        tz: 'local',         // 'utc' | 'local' | 'receiver' (snr-tz)
        receiverTz: null,    // IANA name from /api/description, e.g. "Europe/London"
        lastReading: null,
    };

    const TZ_PREF = 'snrMonitorTimezone';

    // ── times ─────────────────────────────────────────────────────────────────
    // Every time on the section is formatted here, always 24-hour, in the zone picked
    // in snr-tz. The chart's date adapter only knows the browser's zone, so the axis
    // and tooltip go through these too rather than through its displayFormats.

    function tzName() {
        if (state.tz === 'utc') return 'UTC';
        if (state.tz === 'receiver' && state.receiverTz) return state.receiverTz;
        return undefined; // browser's own zone
    }

    const fmtCache = new Map();
    function formatTime(ms, { seconds = true, date = false } = {}) {
        const zone = tzName();
        const key = `${zone}|${seconds}|${date}`;
        let f = fmtCache.get(key);
        if (!f) {
            const opts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
            if (seconds) opts.second = '2-digit';
            if (date) Object.assign(opts, { day: '2-digit', month: 'short', year: 'numeric' });
            try {
                f = new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: zone }, opts));
            } catch (e) { // unknown IANA name: fall back to the browser's zone
                f = new Intl.DateTimeFormat('en-GB', opts);
            }
            fmtCache.set(key, f);
        }
        return f.format(new Date(ms));
    }

    function tzLabel() {
        if (state.tz === 'utc') return 'UTC';
        if (state.tz === 'receiver' && state.receiverTz) return state.receiverTz;
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    }

    function fmt(v, digits = 1) {
        return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(digits) : '--';
    }

    function setStatus(text, kind) {
        const el = $('snr-status');
        el.textContent = text;
        el.className = 'snr-status' + (kind ? ' ' + kind : '');
    }

    function selection() {
        const rangeSel = $('snr-range');
        const custom = rangeSel.value === '__custom';
        return {
            mode: custom ? 'custom' : 'preset',
            range: custom ? '' : rangeSel.value,
            lo: $('snr-lo').value.trim(),
            hi: $('snr-hi').value.trim(),
            avg: $('snr-avg').value,
        };
    }

    function addOptions(group, label, list) {
        if (!list.length) return;
        const og = document.createElement('optgroup');
        og.label = label;
        for (const r of list) {
            const o = document.createElement('option');
            o.value = r.name;
            o.textContent = `${r.name}  (${r.lo_khz}-${r.hi_khz} kHz)`;
            og.appendChild(o);
        }
        group.appendChild(og);
    }

    async function loadRanges() {
        const sel = $('snr-range');
        try {
            const res = await fetch('/api/snr/ranges', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            state.ranges = await res.json();
        } catch (e) {
            setStatus('Could not load ranges: ' + e.message, 'error');
            state.ranges = [];
        }
        sel.textContent = '';
        const g = groupRanges(state.ranges);
        addOptions(sel, 'Amateur bands (band channel)', g.amateur);
        addOptions(sel, 'Broadcast bands (wideband)', g.broadcast);
        addOptions(sel, 'Wideband', g.wide);
        const custom = document.createElement('option');
        custom.value = '__custom';
        custom.textContent = 'Custom range…';
        sel.appendChild(custom);

        const fallback = state.ranges.find(r => r.name === DEFAULT_RANGE) || g.amateur[0] || g.wide[0];
        sel.value = fallback ? fallback.name : '__custom';
        fillEdgesFromPreset();
    }

    function fillEdgesFromPreset() {
        const r = state.ranges.find(x => x.name === $('snr-range').value);
        const custom = $('snr-range').value === '__custom';
        $('snr-custom').style.display = custom ? 'flex' : 'none';
        if (r) {
            $('snr-lo').value = r.lo_khz;
            $('snr-hi').value = r.hi_khz;
        }
    }

    function makeChart() {
        const ctx = $('snr-chart').getContext('2d');
        const line = (label, color, axis, extra = {}) => Object.assign({
            label, data: [], borderColor: color, backgroundColor: color, yAxisID: axis,
            borderWidth: 1.5, pointRadius: 0, tension: 0.2, spanGaps: false,
        }, extra);
        state.chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    line('p95', '#FF9800', 'y'),
                    line('p50', '#64B5F6', 'y'),
                    line('p5 (noise)', '#4CAF50', 'y'),
                    line('SNR (p95 − p5)', '#FFEB3B', 'snr', { borderWidth: 2.5 }),
                ],
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: '#fff' } },
                    annotation: { annotations: {} },
                    tooltip: {
                        callbacks: {
                            title: items => items.length ? formatTime(items[0].parsed.x) : '',
                            label: c => `${c.dataset.label}: ${fmt(c.parsed.y)} dB`,
                        },
                    },
                },
                scales: {
                    x: {
                        type: 'time',
                        // With only a few seconds of data Chart.js picks 'millisecond' ticks,
                        // whose labels pile on top of each other; minUnit stops that. Labels
                        // come from formatTime so they follow the snr-tz zone.
                        time: { minUnit: 'second' },
                        title: { display: true, text: '', color: '#fff' },
                        ticks: {
                            color: '#fff', maxRotation: 0, autoSkip: true, autoSkipPadding: 20, maxTicksLimit: 10,
                            callback: (value, i, ticks) => {
                                const step = ticks.length > 1 ? ticks[1].value - ticks[0].value : 1000;
                                return formatTime(value, {
                                    seconds: step % 60000 !== 0,
                                    date: step >= 24 * 3600 * 1000,
                                });
                            },
                        },
                        grid: { color: 'rgba(255,255,255,0.1)' },
                    },
                    y: {
                        position: 'left',
                        title: { display: true, text: 'Level (dB)', color: '#fff' },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255,255,255,0.1)' },
                    },
                    snr: {
                        position: 'right',
                        title: { display: true, text: 'SNR (dB)', color: '#FFEB3B' },
                        ticks: { color: '#FFEB3B' },
                        grid: { drawOnChartArea: false },
                    },
                },
            },
        });
    }

    function windowMs() {
        return Number($('snr-window').value) * 60 * 1000;
    }

    function redrawChart() {
        if (!state.chart) return;
        const cutoff = Date.now() - windowMs();
        const visible = state.rows.filter(r => r._t >= cutoff);
        const ds = state.chart.data.datasets;
        ds[0].data = visible.map(r => ({ x: r._t, y: r.p95_db }));
        ds[1].data = visible.map(r => ({ x: r._t, y: r.p50_db }));
        ds[2].data = visible.map(r => ({ x: r._t, y: r.p5_db }));
        ds[3].data = visible.map(r => ({ x: r._t, y: r.snr_db }));

        // Give the axis at least a minute of span so a fresh capture fills in from the left
        // instead of stretching its first couple of points across the whole width.
        const x = state.chart.options.scales.x;
        if (visible.length) {
            const first = visible[0]._t, last = visible[visible.length - 1]._t;
            x.min = first;
            x.max = Math.max(last, first + Math.min(60 * 1000, windowMs()));
        } else {
            delete x.min;
            delete x.max;
        }

        const ann = {};
        visible.forEach((r, i) => {
            if (!r.marker) return;
            ann['m' + i] = {
                type: 'line', scaleID: 'x', value: r._t,
                borderColor: '#E040FB', borderWidth: 2, borderDash: [4, 4],
                label: {
                    display: true, content: r.marker, position: 'start',
                    backgroundColor: 'rgba(224,64,251,0.85)', color: '#fff', font: { size: 11 },
                },
            };
        });
        state.chart.options.plugins.annotation.annotations = ann;
        state.chart.options.scales.x.title.text = `Time (${tzLabel()})`;
        state.chart.update('none');
    }

    function showReading(st) {
        state.lastReading = st;
        $('snr-v-snr').textContent = fmt(st.snr_db);
        $('snr-v-p5').textContent = fmt(st.p5_db);
        $('snr-v-p10').textContent = fmt(st.p10_db);
        $('snr-v-p50').textContent = fmt(st.p50_db);
        $('snr-v-p95').textContent = fmt(st.p95_db);
        $('snr-v-min').textContent = fmt(st.min_db);
        $('snr-v-max').textContent = fmt(st.max_db);
        $('snr-v-mean').textContent = fmt(st.mean_db);
        $('snr-v-occ').textContent = fmt(st.occupancy_pct) + '%';
        const what = st.range ? st.range : 'custom';
        $('snr-meta').textContent =
            `${what} · ${st.lo_khz}-${st.hi_khz} kHz · source ${st.source} · ` +
            `${st.bins} bins × ${fmt(st.bin_width_hz, st.bin_width_hz < 100 ? 2 : 0)} Hz · ` +
            `avg ${st.avg_sec}s (${st.samples} sweep${st.samples === 1 ? '' : 's'}) · ` +
            `${formatTime(Date.parse(st.timestamp))} ${tzLabel()}`;
        $('snr-count').textContent = `${state.rows.length} reading${state.rows.length === 1 ? '' : 's'} recorded`;
    }

    // The section is hidden in historical mode; don't spend requests (or the
    // per-IP rate limit) on something nobody can see. A capture in progress keeps
    // polling in a background tab, so switching away doesn't starve it.
    function sectionVisible() {
        return (!document.hidden || !!state.capture) && $('snrSection').offsetParent !== null;
    }

    async function poll() {
        if (!state.running || state.inflight || !state.query || !sectionVisible()) return;
        state.inflight = true;
        const query = state.query;
        try {
            const res = await fetch('/api/snr?' + query, { cache: 'no-store' });
            let body = null;
            try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
            if (query !== state.query) return; // selection changed while in flight
            if (!res.ok) {
                const msg = (body && body.error) || `HTTP ${res.status}`;
                if (res.status === 400) {
                    setStatus(msg, 'error');
                    stop();
                } else {
                    setStatus(msg + ' (retrying)', res.status === 429 ? 'warn' : 'error');
                }
                return;
            }
            if (body.timestamp === state.lastTimestamp) {
                setStatus('Live · waiting for the next sweep', 'ok');
                return;
            }
            state.lastTimestamp = body.timestamp;
            const row = Object.assign({}, body, { _t: Date.parse(body.timestamp), marker: state.pendingMarker });
            if (state.pendingMarker) state.pendingMarker = '';
            state.rows.push(row);
            if (state.rows.length > MAX_ROWS) state.rows.splice(0, state.rows.length - MAX_ROWS);
            if (state.capture) captureReading(row);
            showReading(body);
            redrawChart();
            setStatus('Live', 'ok');
        } catch (e) {
            setStatus('Network error: ' + e.message + ' (retrying)', 'error');
        } finally {
            state.inflight = false;
        }
    }

    function schedule() {
        clearInterval(state.timer);
        state.timer = setInterval(poll, Number($('snr-interval').value) * 1000);
    }

    function start() {
        state.running = true;
        $('snr-toggle').textContent = '⏸ Pause';
        schedule();
        poll();
    }

    function stop() {
        if (state.capture) cancelCapture('Capture cancelled: polling stopped');
        state.running = false;
        clearInterval(state.timer);
        $('snr-toggle').textContent = '▶ Resume';
    }

    // Applies the current controls. Changing what is measured starts a new
    // recording: readings of different ranges or windows aren't comparable.
    function apply() {
        const q = buildQuery(selection());
        if (q.error) {
            setStatus(q.error, 'error');
            return;
        }
        if (q.query !== state.query) {
            state.query = q.query;
            clearRecording();
        }
        updateHelpCommands();
        start();
    }

    function clearRecording() {
        state.rows = [];
        state.lastTimestamp = null;
        $('snr-count').textContent = '0 readings recorded';
        redrawChart();
    }

    function addMarker() {
        const input = $('snr-marker-text');
        state.markerCount++;
        const text = input.value.trim().slice(0, 40) || `Mark ${state.markerCount}`;
        state.pendingMarker = text;
        input.value = '';
        setStatus(`Marker "${text}" will be placed on the next reading`, 'ok');
    }

    function downloadCSV() {
        if (!state.rows.length) {
            setStatus('Nothing recorded yet', 'warn');
            return;
        }
        const blob = new Blob([toCSV(state.rows)], { type: 'text/csv' });
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const what = (state.rows[state.rows.length - 1].range || 'custom').replace(/[^\w.-]/g, '_');
        a.href = URL.createObjectURL(blob);
        a.download = `snr-${what}-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async function copyText(text, button) {
        let ok = false;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch (_) { /* fall through */ }
        if (!ok) {
            // Clipboard API needs a secure context; plain-http receivers are common.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
            ta.remove();
        }
        const old = button.textContent;
        button.textContent = ok ? 'Copied' : 'Select and copy';
        setTimeout(() => { button.textContent = old; }, 1500);
    }

    function updateHelpCommands() {
        const list = $('snr-help-examples');
        if (!list) return;
        list.textContent = '';
        const query = state.query || 'range=' + DEFAULT_RANGE;
        for (const ex of curlExamples(window.location.origin, query)) {
            const item = document.createElement('div');
            item.className = 'snr-example';
            const h = document.createElement('h4');
            h.textContent = ex.title;
            item.appendChild(h);
            if (ex.note) {
                const p = document.createElement('p');
                p.textContent = ex.note;
                item.appendChild(p);
            }
            const wrap = document.createElement('div');
            wrap.className = 'snr-code-wrap';
            const pre = document.createElement('pre');
            pre.textContent = ex.cmd;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'snr-copy';
            btn.textContent = 'Copy';
            btn.addEventListener('click', () => copyText(ex.cmd, btn));
            wrap.appendChild(pre);
            wrap.appendChild(btn);
            item.appendChild(wrap);
            list.appendChild(item);
        }
        $('snr-help-origin').textContent = window.location.origin;
    }

    function openHelp() {
        updateHelpCommands();
        $('snrHelpModal').classList.add('active');
        $('snr-help-close').focus();
    }

    function closeHelp() {
        $('snrHelpModal').classList.remove('active');
        $('snr-help-btn').focus();
    }

    // ── captures ─────────────────────────────────────────────────────────────

    function loadCaptures() {
        try {
            const raw = localStorage.getItem(CAPTURE_STORE);
            const parsed = raw ? JSON.parse(raw) : null;
            state.captures = sanitizeCaptures(parsed && parsed.captures);
            state.baselineId = parsed && typeof parsed.baselineId === 'string' ? parsed.baselineId : null;
        } catch (_) {
            state.captures = [];
            state.baselineId = null;
        }
    }

    function saveCaptures() {
        try {
            localStorage.setItem(CAPTURE_STORE, JSON.stringify({ captures: state.captures, baselineId: state.baselineId }));
            return true;
        } catch (_) {
            return false; // private window or storage blocked: captures last until reload
        }
    }

    function setCaptureControlsLocked(locked) {
        for (const id of ['snr-range', 'snr-lo', 'snr-hi', 'snr-apply', 'snr-avg', 'snr-toggle',
            'snr-cap-name', 'snr-cap-duration']) {
            $(id).disabled = locked;
        }
        $('snr-cap-start').textContent = locked ? '■ Stop & save' : '⏺ Capture';
        $('snr-cap-cancel').style.display = locked ? '' : 'none';
    }

    function startCapture() {
        if (state.capture) {
            finishCapture();
            return;
        }
        if (state.captures.length >= MAX_CAPTURES) {
            setCaptureStatus(`At most ${MAX_CAPTURES} captures can be kept; delete one first`, 'warn');
            return;
        }
        const name = $('snr-cap-name').value.trim().slice(0, 40) || `Capture ${state.captures.length + 1}`;
        const secs = Number($('snr-cap-duration').value);
        if (!state.running) apply();
        if (!state.running || !state.query) return;
        state.capture = { name, rows: [], endsAt: secs > 0 ? Date.now() + secs * 1000 : 0, timer: null };
        state.capture.timer = setInterval(updateCaptureProgress, 500);
        setCaptureControlsLocked(true);
        state.pendingMarker = `▶ ${name}`;
        updateCaptureProgress();
    }

    function captureReading(row) {
        const cap = state.capture;
        // A different key mid-capture can't happen while the controls are locked,
        // but check anyway rather than average two different measurements.
        if (cap.rows.length && captureKey(row) !== captureKey(cap.rows[0])) {
            cancelCapture('Capture cancelled: the measurement changed');
            return;
        }
        cap.rows.push(row);
        if (cap.rows.length >= MAX_CAPTURE_READINGS) finishCapture();
    }

    function updateCaptureProgress() {
        const cap = state.capture;
        if (!cap) return;
        if (cap.endsAt && Date.now() >= cap.endsAt) {
            finishCapture();
            return;
        }
        const left = cap.endsAt ? ` · ${Math.ceil((cap.endsAt - Date.now()) / 1000)} s left` : ' · click Stop & save when done';
        setCaptureStatus(`Capturing "${cap.name}": ${cap.rows.length} reading${cap.rows.length === 1 ? '' : 's'}${left}`, 'ok');
    }

    function endCapture() {
        const cap = state.capture;
        clearInterval(cap.timer);
        state.capture = null;
        setCaptureControlsLocked(false);
        return cap;
    }

    function cancelCapture(msg) {
        if (!state.capture) return;
        endCapture();
        setCaptureStatus(msg || 'Capture cancelled', 'warn');
    }

    function finishCapture() {
        const cap = endCapture();
        if (cap.rows.length < MIN_CAPTURE_READINGS) {
            setCaptureStatus(`Not saved: only ${cap.rows.length} reading${cap.rows.length === 1 ? '' : 's'}, at least ${MIN_CAPTURE_READINGS} needed`, 'warn');
            return;
        }
        const summary = summarizeCapture(cap.name, cap.rows);
        state.captures.push(summary);
        if (!state.captures.some(c => c.id === state.baselineId)) state.baselineId = summary.id;
        state.pendingMarker = `■ ${cap.name}`;
        const stored = saveCaptures();
        $('snr-cap-name').value = '';
        setCaptureStatus(`Saved "${cap.name}" (${cap.rows.length} readings)` +
            (stored ? '' : ' — browser storage is unavailable, so it will be lost on reload'), stored ? 'ok' : 'warn');
        renderComparison();
    }

    function setCaptureStatus(text, kind) {
        const el = $('snr-cap-status');
        el.textContent = text;
        el.className = 'snr-status' + (kind ? ' ' + kind : '');
    }

    function deleteCapture(id) {
        state.captures = state.captures.filter(c => c.id !== id);
        if (state.baselineId === id) state.baselineId = state.captures.length ? state.captures[0].id : null;
        saveCaptures();
        renderComparison();
    }

    function td(text, cls) {
        const el = document.createElement('td');
        el.textContent = text;
        if (cls) el.className = cls;
        return el;
    }

    function renderComparison() {
        const wrap = $('snr-compare');
        const body = $('snr-compare-body');
        body.textContent = '';
        wrap.style.display = state.captures.length ? '' : 'none';
        if (!state.captures.length) {
            if (state.compareChart) { state.compareChart.destroy(); state.compareChart = null; }
            return;
        }
        const shown = ['snr_db', 'p5_db', 'p50_db', 'p95_db', 'occupancy_pct'];
        const rows = compareCaptures(state.captures, state.baselineId);
        for (const row of rows) {
            const c = row.capture;
            const tr = document.createElement('tr');
            if (row.isBaseline) tr.className = 'baseline';

            const baseCell = document.createElement('td');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'snr-baseline';
            radio.checked = row.isBaseline;
            radio.title = 'Use as baseline';
            radio.addEventListener('change', () => { state.baselineId = c.id; saveCaptures(); renderComparison(); });
            baseCell.appendChild(radio);
            tr.appendChild(baseCell);

            const nameCell = td(c.name);
            const sub = document.createElement('div');
            sub.className = 'snr-compare-sub';
            sub.textContent = `${formatTime(Date.parse(c.start), { seconds: false, date: true })} ${tzLabel()} · ${c.readings} readings`;
            nameCell.appendChild(sub);
            tr.appendChild(nameCell);

            const what = td(describeKey(c));
            if (!row.comparable) {
                const warn = document.createElement('div');
                warn.className = 'snr-compare-warn';
                warn.textContent = '⚠ Not comparable with the baseline';
                what.appendChild(warn);
            }
            tr.appendChild(what);

            for (const key of shown) {
                const s = c.stats[key];
                const cell = td(s ? `${fmt(s.mean)} ± ${fmt(s.sd)}` : '--');
                const d = row.delta[key];
                if (typeof d === 'number') {
                    const dd = document.createElement('div');
                    dd.className = 'snr-delta' + (key === 'snr_db' ? (d > 0 ? ' up' : d < 0 ? ' down' : '') : '');
                    dd.textContent = `Δ ${d > 0 ? '+' : ''}${fmt(d)}`;
                    cell.appendChild(dd);
                } else if (row.isBaseline && state.captures.length > 1) {
                    const dd = document.createElement('div');
                    dd.className = 'snr-delta';
                    dd.textContent = 'baseline';
                    cell.appendChild(dd);
                }
                tr.appendChild(cell);
            }

            const delCell = document.createElement('td');
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'snr-del';
            del.textContent = '✕';
            del.title = `Delete "${c.name}"`;
            del.addEventListener('click', () => deleteCapture(c.id));
            delCell.appendChild(del);
            tr.appendChild(delCell);
            body.appendChild(tr);
        }
        renderCompareChart(rows);
    }

    const COMPARE_COLORS = ['#FFEB3B', '#4CAF50', '#FF9800', '#64B5F6', '#E040FB', '#F44336', '#00BCD4', '#CDDC39'];

    // Level profile of each capture comparable with the baseline: noise (p5)
    // through peaks (p95), with ±1 sd whiskers drawn as a tooltip value.
    function renderCompareChart(rows) {
        const levels = [['p5_db', 'p5'], ['p10_db', 'p10'], ['p50_db', 'p50'], ['p95_db', 'p95'], ['max_db', 'max']];
        const datasets = rows.filter(r => r.comparable).map((r, i) => {
            const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
            const snr = r.capture.stats.snr_db;
            return {
                label: `${r.capture.name} (SNR ${snr ? fmt(snr.mean) : '--'} dB)`,
                data: levels.map(([k]) => (r.capture.stats[k] ? r.capture.stats[k].mean : null)),
                sd: levels.map(([k]) => (r.capture.stats[k] ? r.capture.stats[k].sd : null)),
                borderColor: color, backgroundColor: color,
                borderWidth: r.isBaseline ? 3 : 2, borderDash: r.isBaseline ? [] : [6, 3],
                pointRadius: 5, tension: 0,
            };
        });
        const data = { labels: levels.map(([, l]) => l), datasets };
        if (state.compareChart) {
            state.compareChart.data = data;
            state.compareChart.update('none');
            return;
        }
        state.compareChart = new Chart($('snr-compare-chart').getContext('2d'), {
            type: 'line',
            data,
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: '#fff' } },
                    tooltip: {
                        callbacks: {
                            label: c => `${c.dataset.label.replace(/ \(SNR.*$/, '')}: ${fmt(c.parsed.y)} ± ${fmt(c.dataset.sd[c.dataIndex])} dB`,
                        },
                    },
                },
                scales: {
                    x: { ticks: { color: '#fff' }, grid: { color: 'rgba(255,255,255,0.1)' } },
                    y: {
                        title: { display: true, text: 'Level (dB)', color: '#fff' },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255,255,255,0.1)' },
                    },
                },
            },
        });
    }

    function downloadComparison() {
        if (!state.captures.length) return;
        const blob = new Blob([comparisonCSV(state.captures, state.baselineId)], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `snr-comparison-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function clearCaptures() {
        if (!state.captures.length) return;
        state.captures = [];
        state.baselineId = null;
        saveCaptures();
        renderComparison();
        setCaptureStatus('All captures deleted', 'ok');
    }

    function applyTimezone() {
        state.tz = $('snr-tz').value;
        try { localStorage.setItem(TZ_PREF, state.tz); } catch (e) { /* private mode */ }
        redrawChart();
        if (state.lastReading) showReading(state.lastReading);
        renderComparison();
    }

    // The receiver's zone is the admin-configured IANA name (config admin.timezone,
    // default "UTC"), published under receiver.timezone in /api/description.
    async function loadReceiverTimezone() {
        const opt = $('snr-tz').querySelector('option[value="receiver"]');
        try {
            const res = await fetch('/api/description');
            const body = await res.json();
            const tz = body && body.receiver && body.receiver.timezone;
            if (tz) {
                state.receiverTz = tz;
                opt.textContent = `Receiver's time (${tz})`;
                return;
            }
        } catch (e) { /* fall through */ }
        opt.textContent = "Receiver's time (unknown)";
        opt.disabled = true;
        if ($('snr-tz').value === 'receiver') {
            $('snr-tz').value = 'local';
            state.tz = 'local';
        }
    }

    async function init() {
        if (!$('snrSection')) return;
        try {
            const saved = localStorage.getItem(TZ_PREF);
            if (['utc', 'local', 'receiver'].includes(saved)) $('snr-tz').value = saved;
        } catch (e) { /* private mode */ }
        state.tz = $('snr-tz').value;
        makeChart();
        $('snr-tz').addEventListener('change', applyTimezone);
        loadReceiverTimezone().then(() => { redrawChart(); if (state.lastReading) showReading(state.lastReading); renderComparison(); });
        $('snr-range').addEventListener('change', () => {
            fillEdgesFromPreset();
            if ($('snr-range').value !== '__custom') apply();
        });
        $('snr-apply').addEventListener('click', apply);
        for (const id of ['snr-lo', 'snr-hi']) {
            $(id).addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
        }
        $('snr-avg').addEventListener('change', apply);
        $('snr-interval').addEventListener('change', () => { if (state.running) schedule(); });
        $('snr-window').addEventListener('change', redrawChart);
        $('snr-toggle').addEventListener('click', () => (state.running ? stop() : apply()));
        $('snr-clear').addEventListener('click', clearRecording);
        $('snr-csv').addEventListener('click', downloadCSV);
        $('snr-mark').addEventListener('click', addMarker);
        $('snr-marker-text').addEventListener('keydown', e => { if (e.key === 'Enter') addMarker(); });
        $('snr-help-btn').addEventListener('click', openHelp);
        $('snr-help-close').addEventListener('click', closeHelp);
        $('snrHelpModal').addEventListener('click', e => { if (e.target === $('snrHelpModal')) closeHelp(); });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && $('snrHelpModal').classList.contains('active')) closeHelp();
        });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

        $('snr-cap-start').addEventListener('click', startCapture);
        $('snr-cap-cancel').addEventListener('click', () => cancelCapture());
        $('snr-cap-name').addEventListener('keydown', e => { if (e.key === 'Enter') startCapture(); });
        $('snr-cap-csv').addEventListener('click', downloadComparison);
        $('snr-cap-clear').addEventListener('click', clearCaptures);
        loadCaptures();
        renderComparison();

        await loadRanges();
        apply(); // loads 20m (or the first band) by default
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
