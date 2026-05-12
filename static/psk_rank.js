/**
 * psk_rank.js
 * PSKReporter Top-Monitor Ranking — admin modal
 *
 * Exposes public functions: openPSKRankModal(), closePSKRankModal(),
 * switchPSKRankTable(), switchPSKRankBand(), refreshPSKRank(),
 * pskRankSearchChanged(), clearPSKRankSelection()
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
 *
 * Row-click selection: clicking a row toggles it into a "selected" set.
 * When any rows are selected the table is filtered to show only those rows.
 * Clicking a selected row deselects it.  The Clear button (and
 * clearPSKRankSelection()) resets the selection entirely.
 */

'use strict';

(() => {

    // ── State ────────────────────────────────────────────────────────────────
    let _currentTable      = 'reports';   // 'reports' | 'countries'
    let _currentBand       = 'all';       // band name or 'all'
    let _lastData          = null;        // last full /admin/psk-rank response
    let _sortCol           = 'totalDay';
    let _sortDir           = 'desc';
    let _refreshTimer      = null;
    let _ownCallsign       = '';
    let _searchFilter      = '';
    let _selectedCallsigns = new Set();   // row-click selection

    // ── Band order: lowest frequency (longest wavelength) → highest frequency.
    // Exact band key strings as returned by PSKReporter's reportResult/countryResult.
    // Sorted by actual centre frequency, VLF → 76 GHz.
    // 'vlf' and 'invalid' are real PSKReporter band keys shown as columns (vlf first, invalid last).
    // Only 'All' and 'dummy' are excluded (not real bands).
    const BAND_ORDER = [
        // VLF catch-all (PSKReporter key 'vlf')
        'vlf',
        // VLF / LF / MF
        '4000m',            // ~75 kHz
        '2200m',            // 136 kHz
        '600m',             // 500 kHz
        // HF
        '160m',             // 1.8 MHz
        '80m',              // 3.5 MHz
        '60m',              // 5.3 MHz
        '40m',              // 7 MHz
        '30m',              // 10.1 MHz
        '20m',              // 14 MHz
        '17m',              // 18.1 MHz
        '15m',              // 21 MHz
        '12m',              // 24.9 MHz
        '11m',              // 27 MHz (CB / beacons)
        '10m',              // 28 MHz
        // VHF
        '8m',               // ~40 MHz
        '6m',               // 50 MHz
        '5m',               // ~60 MHz
        '4m',               // 70 MHz
        '2m',               // 144 MHz
        '1.25m',            // 222 MHz
        // UHF
        '70cm',             // 432 MHz
        '33cm',             // ~900 MHz
        '23cm',             // 1296 MHz
        // Microwave (GHz names)
        '2.4Ghz',           // 2400 MHz
        '3.4Ghz',           // 3400 MHz
        '5.8Ghz',           // 5760 MHz
        '10Ghz',            // 10 GHz
        '24Ghz',            // 24 GHz
        '76Ghz',            // 76 GHz
        // Unknown / unclassified (PSKReporter key 'invalid') — shown last
        'invalid',
    ];

    // Band keys from PSKReporter that are NOT shown as columns.
    // 'All' is the pre-computed cross-band total used for the Unique columns.
    // 'dummy' is a placeholder integer value (not an array), skipped during parse.
    // 'uhf' is a generic catch-all already covered by the cm/GHz bands above.
    const BAND_JUNK = new Set(['All', 'dummy', 'uhf']);

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

    // ── Row-click selection ──────────────────────────────────────────────────
    function _toggleCallsignSelection(callsign) {
        if (_selectedCallsigns.has(callsign)) {
            _selectedCallsigns.delete(callsign);
        } else {
            _selectedCallsigns.add(callsign);
        }
        _updateSelectionBadge();
        if (_lastData) _renderTable(_lastData);
    }

    function clearPSKRankSelection() {
        _selectedCallsigns.clear();
        _updateSelectionBadge();
        // Also clear the text search
        const searchEl = document.getElementById('pskRankSearch');
        if (searchEl) searchEl.value = '';
        _searchFilter = '';
        if (_lastData) _renderTable(_lastData);
    }

    function _updateSelectionBadge() {
        const badge = document.getElementById('pskRankSelectionBadge');
        if (!badge) return;
        if (_selectedCallsigns.size === 0) {
            badge.style.display = 'none';
            badge.textContent = '';
        } else {
            const list = [..._selectedCallsigns].join(', ');
            badge.textContent = '🔵 Comparing: ' + list;
            badge.style.display = 'inline-block';
        }
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

        // Collect all real bands present in either table (skip junk keys)
        const bandSet = new Set();
        const rr = data.report_result  || {};
        const cr = data.country_result || {};
        Object.keys(rr).forEach(b => { if (!BAND_JUNK.has(b)) bandSet.add(b); });
        Object.keys(cr).forEach(b => { if (!BAND_JUNK.has(b)) bandSet.add(b); });

        // Sort by canonical order, then alphabetically for any unknown bands
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

        // Determine which bands to show (always exclude junk keys)
        let bandsToShow;
        if (_currentBand === 'all') {
            // All real bands present in this table, in canonical order
            const bandSet = new Set(Object.keys(src).filter(b => !BAND_JUNK.has(b)));
            bandsToShow = BAND_ORDER.filter(b => bandSet.has(b));
            bandSet.forEach(b => { if (!bandsToShow.includes(b)) bandsToShow.push(b); });
        } else {
            bandsToShow = (src[_currentBand] && !BAND_JUNK.has(_currentBand)) ? [_currentBand] : [];
        }

        // Build a lookup from the pre-computed "All" band entry (server-side unique totals).
        // This is NOT a sum of per-band values — PSKReporter deduplicates server-side.
        // For reports: "All".day = unique reports across all bands
        // For countries: "All".day = unique countries across all bands (not a sum, avoids double-counting)
        const allBandMap = {};
        (src['All'] || []).forEach(e => {
            allBandMap[e.callsign] = { day: e.day, week: e.week };
        });

        // Flatten into rows: one row per callsign, columns = bands
        // Each cell = {day, week} for that band (or null)
        const callsignMap = {}; // callsign → {band → {day, week}}
        bandsToShow.forEach(band => {
            (src[band] || []).forEach(entry => {
                if (!callsignMap[entry.callsign]) callsignMap[entry.callsign] = {};
                callsignMap[entry.callsign][band] = { day: entry.day, week: entry.week };
            });
        });
        // Also include any callsigns that appear in "All" but not in any specific band
        // (shouldn't happen, but ensures the total column is always populated)
        (src['All'] || []).forEach(entry => {
            if (!callsignMap[entry.callsign]) callsignMap[entry.callsign] = {};
        });

        // Build flat rows with totals — use the pre-computed "All" band for totalDay/totalWeek
        let rows = Object.entries(callsignMap).map(([callsign, bands]) => {
            const allEntry = allBandMap[callsign] || { day: 0, week: 0 };
            return { callsign, bands, totalDay: allEntry.day, totalWeek: allEntry.week };
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

        // Assign original rank after sorting (1-based), before filtering
        rows.forEach((r, i) => { r.rank = i + 1; });

        // Float selected rows to the top; the full table always remains visible
        // so the user can keep clicking rows to add them to the comparison.
        if (_selectedCallsigns.size > 0) {
            const selected   = rows.filter(r =>  _selectedCallsigns.has(r.callsign));
            const unselected = rows.filter(r => !_selectedCallsigns.has(r.callsign));
            rows = [...selected, ...unselected];
        }

        // Apply text search filter (operates on the full reordered list)
        let visible = _searchFilter
            ? rows.filter(r => r.callsign.toUpperCase().includes(_searchFilter))
            : rows;

        // Status line
        const fetchedAt = data.fetched_at
            ? new Date(data.fetched_at).toISOString().replace('T', ' ').substring(0, 19) + ' UTC'
            : '—';
        const tableLabel = _currentTable === 'countries' ? 'countries reported' : 'reception reports';
        _setStatus(
            'Fetched ' + fetchedAt + ' (' + (data.fetched_ms || 0) + ' ms) · ' +
            rows.length + ' reporters · sorted by 24h ' + tableLabel +
            (_selectedCallsigns.size > 0 ? ' · ' + _selectedCallsigns.size + ' selected' : '')
        );

        if (rows.length === 0) {
            _renderHeaders(bandsToShow);
            _setTableContent('<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">No data available.</td></tr>');
            return;
        }

        // Per-band max (for green highlight) — computed over ALL rows, not just visible
        const bandDayMax = {};
        bandsToShow.forEach(b => {
            let max = 0;
            rows.forEach(r => { const v = (r.bands[b] || {}).day || 0; if (v > max) max = v; });
            bandDayMax[b] = max;
        });

        const dataRows = visible.map((row) => {
            const isOwn      = _ownCallsign && row.callsign.toUpperCase() === _ownCallsign;
            const isSelected = _selectedCallsigns.has(row.callsign);
            let rowBg;
            if (isSelected) {
                rowBg = 'background:#e3f2fd;outline:2px solid #1976d2;outline-offset:-2px;cursor:pointer;';
            } else if (isOwn) {
                rowBg = 'background:#fff8e1;outline:2px solid #f9a825;outline-offset:-2px;cursor:pointer;';
            } else {
                rowBg = 'cursor:pointer;';
            }
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

            // Encode callsign for use in onclick attribute
            const csEsc = _esc(row.callsign).replace(/'/g, '&#39;');
            return `<tr style="${rowBg}" onclick="pskRankRowClicked('${csEsc}')" title="Click to select/deselect for comparison">
                <td style="${rankStyle}">${row.rank}</td>
                <td style="padding:5px 8px;font-weight:600;white-space:nowrap;">${_esc(row.callsign)}${csExtra}${isSelected ? ' 🔵' : ''}</td>
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
        const allDayLabel  = 'Unique 24h';
        const allWeekLabel = 'Unique 7d';
        const bandDayLabel = isCountries ? '24h countries'     : '24h reports';
        const allDayTitle  = isCountries
            ? 'Unique countries reported across all bands in last 24h (pre-computed by PSKReporter, not a sum)'
            : 'Unique reception reports across all bands in last 24h (pre-computed by PSKReporter, not a sum)';
        const allWeekTitle = isCountries
            ? 'Unique countries reported across all bands in last 7 days (pre-computed by PSKReporter, not a sum)'
            : 'Unique reception reports across all bands in last 7 days (pre-computed by PSKReporter, not a sum)';

        const makeTh = (col, label, title) => {
            const active = _sortCol === col;
            const arrow  = active ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            const tt     = title ? ` title="${_esc(title)}"` : '';
            return `<th${tt} data-col="${_esc(col)}" style="padding:7px 8px;white-space:nowrap;cursor:pointer;user-select:none;background:#1b5e20;color:white;${active ? 'text-decoration:underline;' : ''}">${_esc(label)}${arrow}</th>`;
        };

        thead.innerHTML = `<tr>
            <th title="Rank by 24h total" style="padding:7px 8px;white-space:nowrap;cursor:default;user-select:none;background:#1b5e20;color:white;">#</th>
            ${makeTh('callsign',  'Reporter',    'Receiver callsign')}
            ${makeTh('totalDay',  allDayLabel,   allDayTitle)}
            ${makeTh('totalWeek', allWeekLabel,  allWeekTitle)}
            ${bands.map(b => makeTh(b, b, b + ' — ' + bandDayLabel + ' (hover for 7-day)')).join('')}
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
    window.clearPSKRankSelection = clearPSKRankSelection;
    // Called from inline onclick on table rows
    window.pskRankRowClicked     = _toggleCallsignSelection;

})();
