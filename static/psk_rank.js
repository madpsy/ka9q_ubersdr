/**
 * psk_rank.js
 * PSKReporter Top-Monitor Ranking — admin modal
 *
 * Exposes public functions: openPSKRankModal(), closePSKRankModal(),
 * switchPSKRankTable(), switchPSKRankBand(), refreshPSKRank(),
 * pskRankSearchChanged()
 *
 * Fetches GET /admin/psk-rank?table=<t>&band=<b> and renders a
 * sortable, filterable leaderboard table inside a modal.
 *
 * Two table tabs:
 *   reports   — Top Monitors by reports (day/week = reception report counts)
 *   countries — Top Monitors by distinct countries (day/week = country counts)
 *
 * A band selector lets the user pick a single band or "All Bands".
 * Own-callsign rows are highlighted in gold.
 * The search box filters rows client-side (no re-fetch).
 */

'use strict';

(() => {

    // ── State ────────────────────────────────────────────────────────────────
    let _currentTable  = 'reports';   // 'reports' | 'countries'
    let _currentBand   = 'all';       // band name or 'all'
    let _lastData      = null;        // last full /admin/psk-rank response
    let _sortCol       = 'day';
    let _sortDir       = 'desc';
    let _refreshTimer  = null;
    let _ownCallsign   = '';
    let _searchFilter  = '';

    // ── Preferred HF band order for the band selector ────────────────────────
    // Matches the order PSKReporter uses on its own page.
    const BAND_ORDER = [
        '160m','80m','60m','40m','30m','20m','17m','15m','12m','10m',
        '6m','4m','2m','70cm','23cm',
        '8m','5m','3.4Ghz','33cm','76Ghz',
    ];

    // ── Modal open/close ─────────────────────────────────────────────────────
    function openPSKRankModal() {
        const modal = document.getElementById('pskRankModal');
        if (!modal) return;

        // Resolve own callsign from decoder config (if available in page scope).
        try {
            const cfg = (typeof currentDecoderConfig !== 'undefined') ? currentDecoderConfig : {};
            _ownCallsign = ((cfg.pskreporter_callsign || '').trim() ||
                            (cfg.receiver_callsign    || '').trim()).toUpperCase();
        } catch (_) {
            _ownCallsign = '';
        }

        // Reset search box
        const searchEl = document.getElementById('pskRankSearch');
        if (searchEl) searchEl.value = '';
        _searchFilter = '';

        modal.style.display = 'flex';
        _loadData();
    }

    function closePSKRankModal() {
        const modal = document.getElementById('pskRankModal');
        if (modal) modal.style.display = 'none';
    }

    // ── Table tab switching ──────────────────────────────────────────────────
    function switchPSKRankTable(t) {
        if (t !== 'reports' && t !== 'countries') return;
        _currentTable = t;

        const rBtn = document.getElementById('pskRankTabReports');
        const cBtn = document.getElementById('pskRankTabCountries');
        if (rBtn) {
            rBtn.style.background  = t === 'reports'   ? '#1b5e20' : '#e8f5e9';
            rBtn.style.color       = t === 'reports'   ? 'white'   : '#2e7d32';
            rBtn.style.fontWeight  = t === 'reports'   ? '600'     : '';
        }
        if (cBtn) {
            cBtn.style.background  = t === 'countries' ? '#1b5e20' : '#e8f5e9';
            cBtn.style.color       = t === 'countries' ? 'white'   : '#2e7d32';
            cBtn.style.fontWeight  = t === 'countries' ? '600'     : '';
        }

        if (_lastData) _renderTable(_lastData);
    }

    // ── Band selector ────────────────────────────────────────────────────────
    function switchPSKRankBand(b) {
        _currentBand = b || 'all';
        // Update the <select> element to match (in case called programmatically)
        const sel = document.getElementById('pskRankBandSelect');
        if (sel && sel.value !== _currentBand) sel.value = _currentBand;
        if (_lastData) _renderTable(_lastData);
    }

    // ── Search box handler ───────────────────────────────────────────────────
    function pskRankSearchChanged() {
        const el = document.getElementById('pskRankSearch');
        _searchFilter = el ? el.value.trim().toUpperCase() : '';
        if (_lastData) _renderTable(_lastData);
    }

    // ── Data fetch ───────────────────────────────────────────────────────────
    async function _loadData(forceRefresh) {
        _setStatus('Loading…');
        _setTableContent('<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">Loading…</td></tr>');

        const params = new URLSearchParams({ table: 'all' });
        if (forceRefresh) params.set('refresh', '1');

        try {
            const resp = await authenticatedFetch('/admin/psk-rank?' + params);
            if (!resp) return;

            if (resp.status === 202) {
                _setStatus('⏳ Data not yet available — initial fetch pending (5-min startup delay)');
                _setTableContent('<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">No data yet. Try again in a few minutes.</td></tr>');
                return;
            }

            if (resp.status === 429) {
                const body = await resp.json().catch(() => ({}));
                const secs = body.retry_after_secs || 60;
                _setStatus('⚠️ Rate limited — please wait ' + secs + 's before refreshing');
                _startRefreshCooldown(secs);
                return;
            }

            if (!resp.ok) {
                const body = await resp.json().catch(() => ({}));
                _setStatus('❌ Error: ' + (body.error || resp.statusText));
                return;
            }

            const data = await resp.json();
            _lastData = data;

            // Populate band selector from the data
            _populateBandSelector(data);

            _renderTable(data);

        } catch (e) {
            _setStatus('❌ Fetch error: ' + e.message);
        }
    }

    // ── Populate band <select> ───────────────────────────────────────────────
    function _populateBandSelector(data) {
        const sel = document.getElementById('pskRankBandSelect');
        if (!sel) return;

        // Collect all bands present in either table
        const bandSet = new Set();
        const rr = data.report_result  || {};
        const cr = data.country_result || {};
        Object.keys(rr).forEach(b => bandSet.add(b));
        Object.keys(cr).forEach(b => bandSet.add(b));

        // Sort by canonical order, then alphabetically for unknowns
        const ordered = BAND_ORDER.filter(b => bandSet.has(b));
        bandSet.forEach(b => { if (!ordered.includes(b)) ordered.push(b); });

        // Rebuild options (keep current selection if still valid)
        const prev = sel.value;
        sel.innerHTML = '<option value="all">All Bands</option>' +
            ordered.map(b => `<option value="${_esc(b)}">${_esc(b)}</option>`).join('');

        if (ordered.includes(prev)) {
            sel.value = prev;
            _currentBand = prev;
        } else {
            sel.value = 'all';
            _currentBand = 'all';
        }
    }

    // ── Manual refresh ───────────────────────────────────────────────────────
    async function refreshPSKRank() {
        const btn = document.getElementById('pskRankRefreshBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Refreshing…'; }
        await _loadData(true);
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }

    function _startRefreshCooldown(secs) {
        const btn = document.getElementById('pskRankRefreshBtn');
        if (!btn) return;
        if (_refreshTimer) clearInterval(_refreshTimer);
        let remaining = secs;
        btn.disabled = true;
        btn.textContent = '🔄 Refresh (' + remaining + 's)';
        _refreshTimer = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(_refreshTimer);
                _refreshTimer = null;
                btn.disabled = false;
                btn.textContent = '🔄 Refresh';
            } else {
                btn.textContent = '🔄 Refresh (' + remaining + 's)';
            }
        }, 1000);
    }

    // ── Table rendering ──────────────────────────────────────────────────────
    function _renderTable(data) {
        if (!data) return;

        // Pick the right source object based on current tab
        const src = _currentTable === 'countries'
            ? (data.country_result || {})
            : (data.report_result  || {});

        // Determine which bands to show
        let bandsToShow;
        if (_currentBand === 'all') {
            // All bands present in this table, in canonical order
            const bandSet = new Set(Object.keys(src));
            bandsToShow = BAND_ORDER.filter(b => bandSet.has(b));
            bandSet.forEach(b => { if (!bandsToShow.includes(b)) bandsToShow.push(b); });
        } else {
            bandsToShow = src[_currentBand] ? [_currentBand] : [];
        }

        // Flatten into rows: one row per callsign, columns = bands
        // Each cell = {day, week} for that band (or null)
        const callsignMap = {}; // callsign → {band → {day, week}}
        bandsToShow.forEach(band => {
            (src[band] || []).forEach(entry => {
                if (!callsignMap[entry.callsign]) callsignMap[entry.callsign] = {};
                callsignMap[entry.callsign][band] = { day: entry.day, week: entry.week };
            });
        });

        // Build flat rows with totals
        let rows = Object.entries(callsignMap).map(([callsign, bands]) => {
            let totalDay = 0, totalWeek = 0;
            bandsToShow.forEach(b => {
                if (bands[b]) { totalDay += bands[b].day; totalWeek += bands[b].week; }
            });
            return { callsign, bands, totalDay, totalWeek };
        });

        // Sort
        rows.sort((a, b) => {
            let va, vb;
            if (_sortCol === 'callsign') {
                return _sortDir === 'asc'
                    ? a.callsign.localeCompare(b.callsign)
                    : b.callsign.localeCompare(a.callsign);
            }
            if (_sortCol === 'totalDay')  { va = a.totalDay;  vb = b.totalDay;  }
            else if (_sortCol === 'totalWeek') { va = a.totalWeek; vb = b.totalWeek; }
            else {
                // band column — sort by day value
                va = (a.bands[_sortCol] || {}).day || 0;
                vb = (b.bands[_sortCol] || {}).day || 0;
            }
            return _sortDir === 'asc' ? va - vb : vb - va;
        });

        // Apply search filter
        const visible = _searchFilter
            ? rows.filter(r => r.callsign.toUpperCase().includes(_searchFilter))
            : rows;

        // Status line
        const fetchedAt = data.fetched_at
            ? new Date(data.fetched_at).toISOString().replace('T', ' ').substring(0, 19) + ' UTC'
            : '—';
        const tableLabel = _currentTable === 'countries' ? 'countries reported' : 'reception reports';
        _setStatus(
            'Fetched ' + fetchedAt + ' (' + (data.fetched_ms || 0) + ' ms) · ' +
            rows.length + ' reporters · sorted by 24h ' + tableLabel
        );

        if (rows.length === 0) {
            _renderHeaders(bandsToShow);
            _setTableContent('<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">No data available.</td></tr>');
            return;
        }

        // Per-band max (for green highlight)
        const bandDayMax = {};
        bandsToShow.forEach(b => {
            let max = 0;
            rows.forEach(r => { const v = (r.bands[b] || {}).day || 0; if (v > max) max = v; });
            bandDayMax[b] = max;
        });

        const dataRows = visible.map((row, idx) => {
            const isOwn = _ownCallsign && row.callsign.toUpperCase() === _ownCallsign;
            const rowBg = isOwn ? 'background:#fff8e1;outline:2px solid #f9a825;outline-offset:-2px;' : '';
            const csExtra = isOwn ? ' ⭐' : '';
            const rankStyle = isOwn
                ? 'padding:5px 8px;text-align:right;font-weight:700;color:#e65100;font-size:12px;'
                : 'padding:5px 8px;text-align:right;color:#888;font-size:12px;';

            const bandCells = bandsToShow.map(b => {
                const cell = row.bands[b];
                if (!cell || cell.day === 0) {
                    return `<td style="padding:5px 8px;text-align:right;color:#ccc;" title="${_esc(b)} week: ${cell ? cell.week : 0}">—</td>`;
                }
                const isBest = cell.day > 0 && cell.day === bandDayMax[b];
                const cellStyle = isBest
                    ? 'padding:5px 8px;text-align:right;outline:2px solid #2e7d32;outline-offset:-2px;font-weight:700;color:#1b5e20;'
                    : 'padding:5px 8px;text-align:right;';
                return `<td style="${cellStyle}" title="${_esc(b)} week: ${cell.week.toLocaleString()}">${cell.day.toLocaleString()}</td>`;
            }).join('');

            return `<tr style="${rowBg}">
                <td style="${rankStyle}">${idx + 1}</td>
                <td style="padding:5px 8px;font-weight:600;white-space:nowrap;">${_esc(row.callsign)}${csExtra}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:600;color:#1b5e20;">${row.totalDay.toLocaleString()}</td>
                <td style="padding:5px 8px;text-align:right;color:#555;">${row.totalWeek.toLocaleString()}</td>
                ${bandCells}
            </tr>`;
        }).join('');

        const noMatch = visible.length === 0
            ? '<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">No matching reporters.</td></tr>'
            : '';

        _renderHeaders(bandsToShow);
        _setTableContent(dataRows + noMatch);
    }

    function _renderHeaders(bands) {
        const thead = document.getElementById('pskRankThead');
        if (!thead) return;

        const isCountries = _currentTable === 'countries';
        const dayLabel  = isCountries ? '#Countries 24h' : '#Reports 24h';
        const weekLabel = isCountries ? '#Countries 7d'  : '#Reports 7d';
        const dayTitle  = isCountries ? 'Distinct countries reported in last 24h' : 'Reception reports in last 24h';
        const weekTitle = isCountries ? 'Distinct countries reported in last 7 days' : 'Reception reports in last 7 days';

        const makeTh = (col, label, title) => {
            const active = _sortCol === col;
            const arrow  = active ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            const tt     = title ? ` title="${_esc(title)}"` : '';
            return `<th${tt} data-col="${_esc(col)}" style="padding:7px 8px;white-space:nowrap;cursor:pointer;user-select:none;background:#1b5e20;color:white;${active ? 'text-decoration:underline;' : ''}">${_esc(label)}${arrow}</th>`;
        };

        thead.innerHTML = `<tr>
            ${makeTh('rank',      '#',         'Rank by 24h count')}
            ${makeTh('callsign',  'Reporter',  'Receiver callsign')}
            ${makeTh('totalDay',  dayLabel,    dayTitle)}
            ${makeTh('totalWeek', weekLabel,   weekTitle)}
            ${bands.map(b => makeTh(b, b, b + ' — 24h count (hover for 7-day)')).join('')}
        </tr>`;

        thead.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.col;
                if (_sortCol === col) {
                    _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    _sortCol = col;
                    _sortDir = col === 'callsign' ? 'asc' : 'desc';
                }
                if (_lastData) _renderTable(_lastData);
            });
        });
    }

    // ── DOM helpers ──────────────────────────────────────────────────────────
    function _setStatus(msg) {
        const el = document.getElementById('pskRankStatus');
        if (el) el.textContent = msg;
    }

    function _setTableContent(html) {
        const el = document.getElementById('pskRankTbody');
        if (el) el.innerHTML = html;
    }

    function _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Close on backdrop click ──────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        const modal = document.getElementById('pskRankModal');
        if (modal) {
            modal.addEventListener('click', e => {
                if (e.target === modal) closePSKRankModal();
            });
        }
    });

    // ── Public API ───────────────────────────────────────────────────────────
    window.openPSKRankModal      = openPSKRankModal;
    window.closePSKRankModal     = closePSKRankModal;
    window.switchPSKRankTable    = switchPSKRankTable;
    window.switchPSKRankBand     = switchPSKRankBand;
    window.refreshPSKRank        = refreshPSKRank;
    window.pskRankSearchChanged  = pskRankSearchChanged;

})();
