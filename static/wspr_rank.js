/**
 * wspr_rank.js
 * WSPR Live Receiver Ranking — admin modal
 *
 * Exposes public functions: openWSPRRankModal(), closeWSPRRankModal(),
 * switchWSPRRankWindow(), refreshWSPRRank(), wsprRankSearchChanged(),
 * clearWSPRRankSelection()
 *
 * Fetches GET /admin/wspr-rank?format=table&window=<w> and renders a
 * sortable, filterable leaderboard table inside a modal.  Three window
 * buttons let the user switch between:
 *   yesterday   — midnight-to-midnight UTC yesterday  (default)
 *   rolling_24h — last 24 hours to now
 *   today       — midnight UTC today to now
 *
 * Own-callsign rows are highlighted in gold.
 * The search box filters rows client-side (no re-fetch).
 *
 * Row-click selection: clicking a row toggles it into a "selected" set.
 * When any rows are selected the table is filtered to show only those rows.
 * Clicking a selected row deselects it.  The Clear button (and
 * clearWSPRRankSelection()) resets the selection entirely.
 */

'use strict';

(() => {

    // ── State ────────────────────────────────────────────────────────────────
    let _currentWindow      = 'yesterday'; // default window
    let _lastData           = null;        // last WSPRRankTable response
    let _sortCol            = 'unique';
    let _sortDir            = 'desc';
    let _refreshTimer       = null;        // rate-limit cooldown timer
    let _ownCallsign        = '';          // set when modal opens; used for row highlight
    let _searchFilter       = '';          // current search box value (uppercased)
    let _continentFilter    = '';          // two-letter continent code, or '' for all
    let _countryFilter      = '';          // country name string, or '' for all
    let _selectedCallsigns  = new Set();   // row-click selection
    let _viewMode           = 'table';     // 'table' | 'map'
    let _visibleRows        = [];          // rows surviving sort+filter, shared by both views
    let _visibleBands       = [];          // band column order for the current dataset
    let _showMapLabels      = true;        // permanent marker tooltips on/off
    let _leafletPromise     = null;        // lazy Leaflet loader
    let _map                = null;        // L.Map instance (created on first map view)
    let _markerLayer        = null;        // L.LayerGroup holding the receiver markers
    let _lastFitKey         = '';          // marker-set signature; refit bounds when it changes

    // ── Constants ────────────────────────────────────────────────────────────
    const WINDOW_LABELS = {
        yesterday:   '📅 Yesterday (UTC)',
        rolling_24h: '🕐 Rolling 24h',
        today:       '☀️ Today (UTC)',
    };

    // Two-letter ham-radio continent codes → human-readable names.
    const CONTINENT_NAMES = {
        AF: 'Africa',
        AN: 'Antarctica',
        AS: 'Asia',
        EU: 'Europe',
        NA: 'North America',
        OC: 'Oceania',
        SA: 'South America',
    };

    const WINDOW_ORDER = ['yesterday', 'rolling_24h', 'today'];

    // ── Modal open/close ─────────────────────────────────────────────────────
    function openWSPRRankModal() {
        const modal = document.getElementById('wsprRankModal');
        if (!modal) return;

        // Resolve own callsign from decoder config (if available in page scope).
        try {
            const cfg = (typeof currentDecoderConfig !== 'undefined') ? currentDecoderConfig : {};
            _ownCallsign = ((cfg.wsprnet_callsign || '').trim() ||
                            (cfg.receiver_callsign || '').trim()).toUpperCase();
        } catch (_) {
            _ownCallsign = '';
        }

        // Reset search, continent and country filters
        const searchEl = document.getElementById('wsprRankSearch');
        if (searchEl) searchEl.value = '';
        _searchFilter = '';
        const contEl = document.getElementById('wsprRankContinentFilter');
        if (contEl) contEl.value = '';
        _continentFilter = '';
        const countryEl = document.getElementById('wsprRankCountryFilter');
        if (countryEl) countryEl.value = '';
        _countryFilter = '';

        modal.style.display = 'flex';
        switchView(_viewMode);        // syncs tab styles + shows the right pane
        switchWindow(_currentWindow); // also syncs button highlight styles
    }

    function closeWSPRRankModal() {
        const modal = document.getElementById('wsprRankModal');
        if (modal) modal.style.display = 'none';
    }

    // ── Window switching ─────────────────────────────────────────────────────
    function switchWindow(w) {
        if (!WINDOW_LABELS[w]) return;
        _currentWindow = w;

        // Update button active states via inline style (overrides initial inline style).
        WINDOW_ORDER.forEach(key => {
            const btn = document.getElementById('wsprRankBtn_' + key);
            if (!btn) return;
            if (key === w) {
                btn.style.background = '#3f51b5';
                btn.style.color      = 'white';
                btn.style.fontWeight = '600';
            } else {
                btn.style.background = '#e8eaf6';
                btn.style.color      = '#283593';
                btn.style.fontWeight = '';
            }
        });

        _loadWindow(w);
    }

    // ── Search box handler ───────────────────────────────────────────────────
    function wsprRankSearchChanged() {
        const el = document.getElementById('wsprRankSearch');
        _searchFilter = el ? el.value.trim().toUpperCase() : '';
        if (_lastData) _renderTable(_lastData);
    }

    // ── Continent dropdown handler ────────────────────────────────────────────
    function wsprRankContinentChanged() {
        const el = document.getElementById('wsprRankContinentFilter');
        _continentFilter = el ? el.value : '';
        // Reset country filter when continent changes — the country list will be
        // repopulated to only show countries present in the new filtered set.
        const countryEl = document.getElementById('wsprRankCountryFilter');
        if (countryEl) countryEl.value = '';
        _countryFilter = '';
        if (_lastData) _renderTable(_lastData);
    }

    // ── Country dropdown handler ──────────────────────────────────────────────
    function wsprRankCountryChanged() {
        const el = document.getElementById('wsprRankCountryFilter');
        _countryFilter = el ? el.value : '';
        if (_lastData) _renderTable(_lastData);
    }

    // ── Populate country dropdown from current data ───────────────────────────
    // Called after every render so the list reflects the continent filter.
    // Preserves the current selection if the country is still present.
    function _populateCountryDropdown(rows) {
        const el = document.getElementById('wsprRankCountryFilter');
        if (!el) return;

        // Collect unique countries from rows that pass the continent filter,
        // sorted alphabetically.  Include flag emoji for visual consistency.
        const seen = new Map(); // country name → country_code
        rows.forEach(r => {
            if (r.country && !seen.has(r.country)) {
                seen.set(r.country, r.country_code || '');
            }
        });
        const sorted = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        const prev = el.value; // preserve selection if still valid
        el.innerHTML = '<option value="">🏳 All countries</option>';
        sorted.forEach(([name, code]) => {
            const flag = code && code.length === 2
                ? String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0))) + '\u202F'
                : '';
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = flag + name;
            el.appendChild(opt);
        });
        // Restore previous selection only if it still exists in the new list
        if (prev && seen.has(prev)) {
            el.value = prev;
        } else if (prev) {
            // Previously selected country no longer in list — clear the filter
            _countryFilter = '';
        }
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

    function clearWSPRRankSelection() {
        _selectedCallsigns.clear();
        _updateSelectionBadge();
        // Also clear the text search, continent and country filters
        const searchEl = document.getElementById('wsprRankSearch');
        if (searchEl) searchEl.value = '';
        _searchFilter = '';
        const contEl = document.getElementById('wsprRankContinentFilter');
        if (contEl) contEl.value = '';
        _continentFilter = '';
        const countryEl = document.getElementById('wsprRankCountryFilter');
        if (countryEl) countryEl.value = '';
        _countryFilter = '';
        if (_lastData) _renderTable(_lastData);
    }

    function _updateSelectionBadge() {
        const badge = document.getElementById('wsprRankSelectionBadge');
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
    async function _loadWindow(w, forceRefresh) {
        _setStatus('Loading…');
        _setTableContent('<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">Loading…</td></tr>');

        const params = new URLSearchParams({ format: 'table', window: w });
        if (forceRefresh) params.set('refresh', '1');

        try {
            // authenticatedFetch is defined in admin.html
            const resp = await authenticatedFetch('/admin/wspr-rank?' + params);
            if (!resp) return; // auth redirect handled by authenticatedFetch

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
            _renderTable(data);

        } catch (e) {
            _setStatus('❌ Fetch error: ' + e.message);
        }
    }

    // ── Manual refresh ───────────────────────────────────────────────────────
    async function refreshWSPRRank() {
        const btn = document.getElementById('wsprRankRefreshBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Refreshing…'; }
        await _loadWindow(_currentWindow, true);
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }

    function _startRefreshCooldown(secs) {
        const btn = document.getElementById('wsprRankRefreshBtn');
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

        const bands = data.bands || [];
        const rows  = data.rows  || [];

        // Status line
        const fetchedAt = data.fetched_at
            ? new Date(data.fetched_at).toISOString().replace('T', ' ').substring(0, 19) + ' UTC'
            : '—';
        const rowsBefore = data.rows_before_limit != null ? data.rows_before_limit : '';
        const isUberSDRRow = r => r.versions && r.versions.some(v => v === 'UberSDR');
        const uberSdrTotal = rows.filter(isUberSDRRow).length;
        const uberSdrTop25 = rows.slice(0, 25).filter(isUberSDRRow).length;
        _setStatus(
            'Fetched ' + fetchedAt +
            ' (' + data.fetched_ms + ' ms) · ' +
            'Showing ' + rows.length + ' receivers' +
            (rowsBefore ? ' of ' + rowsBefore.toLocaleString() + ' total' : '') +
            (_selectedCallsigns.size > 0 ? ' · ' + _selectedCallsigns.size + ' selected' : ''),
            uberSdrTotal, uberSdrTop25
        );

        if (rows.length === 0) {
            _setTableContent('<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">No data for this window.</td></tr>');
            _renderHeaders(bands);
            _visibleRows  = [];
            _visibleBands = bands;
            _renderMap();
            return;
        }

        // Sort
        const sorted = [...rows].sort((a, b) => {
            let va, vb;
            if (_sortCol === 'reporter') {
                va = a.reporter; vb = b.reporter;
                return _sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            if (_sortCol === 'locator') {
                va = a.locator; vb = b.locator;
                return _sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            if (_sortCol === 'country') {
                va = a.country || ''; vb = b.country || '';
                return _sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            if (_sortCol === 'continent') {
                va = a.continent || ''; vb = b.continent || '';
                return _sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            if (bands.includes(_sortCol)) {
                va = (a.band_uniques || {})[_sortCol] || 0;
                vb = (b.band_uniques || {})[_sortCol] || 0;
            } else {
                va = a[_sortCol] ?? 0;
                vb = b[_sortCol] ?? 0;
            }
            return _sortDir === 'asc' ? va - vb : vb - va;
        });

        // Float selected rows to the top; the full table always remains visible
        // so the user can keep clicking rows to add them to the comparison.
        let reordered = sorted;
        if (_selectedCallsigns.size > 0) {
            const selected   = sorted.filter(r =>  _selectedCallsigns.has(r.reporter));
            const unselected = sorted.filter(r => !_selectedCallsigns.has(r.reporter));
            reordered = [...selected, ...unselected];
        }

        // Apply text search, continent and country filters (on the full reordered list)
        let visible = reordered;
        if (_searchFilter) {
            visible = visible.filter(r => r.reporter.toUpperCase().includes(_searchFilter));
        }
        if (_continentFilter) {
            visible = visible.filter(r => (r.continent || '') === _continentFilter);
        }
        if (_countryFilter) {
            visible = visible.filter(r => (r.country || '') === _countryFilter);
        }

        // Share the filtered result with the map view so both tabs show the
        // same set of receivers under the same filters.
        _visibleRows  = visible;
        _visibleBands = bands;

        // Populate the country dropdown from rows that pass the continent filter
        // (but not the country filter itself, so all countries remain selectable).
        const rowsForCountryList = _continentFilter
            ? sorted.filter(r => (r.continent || '') === _continentFilter)
            : sorted;
        _populateCountryDropdown(rowsForCountryList);

        // Compute per-band maximum across ALL rows (not just filtered visible ones),
        // so the green highlight always means "best in the full leaderboard".
        const bandMax = {};
        bands.forEach(b => {
            let max = 0;
            sorted.forEach(r => { const v = (r.band_uniques || {})[b] || 0; if (v > max) max = v; });
            bandMax[b] = max;
        });

        // Totals row (only over visible rows when filtering)
        const totals = data.totals || {};
        const totalRaw    = (data.total_raw    || 0).toLocaleString();
        const totalDupes  = (data.total_dupes  || 0).toLocaleString();
        const totalUnique = (data.total_unique || 0).toLocaleString();

        const isFiltered = _searchFilter || _continentFilter || _countryFilter;
        const totalsRow = isFiltered ? '' : `<tr style="background:#f0f4ff;font-weight:bold;border-bottom:2px solid #9fa8da;">
            <td style="padding:6px 8px;text-align:right;color:#555;">Totals</td>
            <td style="padding:6px 8px;"></td>
            <td style="padding:6px 8px;text-align:right;">${totalRaw}</td>
            <td style="padding:6px 8px;text-align:right;">${totalDupes}</td>
            <td style="padding:6px 8px;text-align:right;">${totalUnique}</td>
            ${bands.map(b => `<td style="padding:6px 8px;text-align:right;">${((totals[b] || 0)).toLocaleString()}</td>`).join('')}
        </tr>`;

        const dataRows = visible.map(row => {
            const bu = row.band_uniques || {};
            const isOwn      = _ownCallsign && row.reporter.toUpperCase() === _ownCallsign;
            const isSelected = _selectedCallsigns.has(row.reporter);
            let rowBg;
            if (isSelected) {
                rowBg = 'background:#e3f2fd;outline:2px solid #1976d2;outline-offset:-2px;cursor:pointer;';
            } else if (isOwn) {
                rowBg = 'background:#fff8e1;outline:2px solid #f9a825;outline-offset:-2px;cursor:pointer;';
            } else {
                rowBg = 'cursor:pointer;';
            }
            const rankStyle = isOwn
                ? 'padding:5px 8px;text-align:right;font-weight:700;color:#e65100;font-size:12px;'
                : 'padding:5px 8px;text-align:right;color:#888;font-size:12px;';
            const reporterExtra = isOwn ? ' ⭐' : '';
            // UberSDR favicon badge
            const isUberSDR = row.versions && row.versions.some(v => v === 'UberSDR');
            const uberBadge = isUberSDR
                ? ' <img src="images/favicon-16x16.png" width="16" height="16" style="vertical-align:middle;display:inline-block;" alt="UberSDR">'
                : '';
            // Tooltip on the reporter cell — shows software version (if known)
            // plus country name and continent on a new line (if CTY data present).
            const continentName = row.continent ? (CONTINENT_NAMES[row.continent] || row.continent) : '';
            const ctyLine = row.country
                ? (row.country + (continentName ? ', ' + continentName : ''))
                : '';
            const verLine = row.versions && row.versions.length > 0
                ? '💻 ' + row.versions.join(' / ')
                : '';
            const tooltipParts = [verLine, ctyLine].filter(Boolean);
            const verTitle = tooltipParts.length > 0
                ? ` title="${_esc(tooltipParts.join('\n'))}"`
                : '';
            // Encode reporter callsign for use in onclick attribute
            const repEsc = _esc(row.reporter).replace(/'/g, '&#39;');
            // Flag emoji from ISO 3166-1 alpha-2 country code using regional indicator symbols.
            // The 'Twemoji Flags' font is already in the admin.html body font stack.
            // Falls back gracefully to nothing when CTY lookup failed or globalCTY is nil.
            const flagEmoji = row.country_code
                ? String.fromCodePoint(...[...row.country_code.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)))
                : '';
            const flagSpan = flagEmoji
                ? `<span title="${_esc(row.country)}${row.continent ? ' · ' + _esc(row.continent) : ''}" style="margin-right:4px;line-height:1;">${flagEmoji}</span>`
                : '';
            return `<tr style="${rowBg}" onclick="wsprRankRowClicked('${repEsc}')" title="Click to select/deselect for comparison">
                <td style="${rankStyle}">${row.rank}</td>
                <td style="padding:5px 8px;font-weight:600;white-space:nowrap;"${verTitle}>
                    ${flagSpan}${_esc(row.reporter)}${uberBadge}${reporterExtra}${isSelected ? ' 🔵' : ''}
                    <span style="color:#888;font-size:11px;margin-left:4px;">${_esc(row.locator)}</span>
                </td>
                <td style="padding:5px 8px;text-align:right;">${(row.raw || 0).toLocaleString()}</td>
                <td style="padding:5px 8px;text-align:right;">${(row.dupes || 0).toLocaleString()}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:600;color:#283593;">${(row.unique || 0).toLocaleString()}</td>
                ${bands.map(b => {
                    const v = bu[b] || 0;
                    const isBest = v > 0 && v === bandMax[b];
                    const cellStyle = isBest
                        ? 'padding:5px 8px;text-align:right;outline:2px solid #2e7d32;outline-offset:-2px;font-weight:700;color:#1b5e20;'
                        : (v > 0 ? 'padding:5px 8px;text-align:right;' : 'padding:5px 8px;text-align:right;color:#ccc;');
                    return `<td style="${cellStyle}">${v > 0 ? v.toLocaleString() : '—'}</td>`;
                }).join('')}
            </tr>`;
        }).join('');

        const noMatch = visible.length === 0
            ? '<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">No matching receivers.</td></tr>'
            : '';

        _renderHeaders(bands);
        _setTableContent(totalsRow + dataRows + noMatch);
        _renderMap();
    }

    function _renderHeaders(bands) {
        const thead = document.getElementById('wsprRankThead');
        if (!thead) return;

        const makeTh = (col, label, title) => {
            const active = _sortCol === col;
            const arrow  = active ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            const tt     = title ? ` title="${_esc(title)}"` : '';
            return `<th${tt} data-col="${_esc(col)}" style="padding:7px 8px;white-space:nowrap;cursor:pointer;user-select:none;background:#3f51b5;color:white;${active ? 'text-decoration:underline;' : ''}">${_esc(label)}${arrow}</th>`;
        };

        thead.innerHTML = `<tr>
            ${makeTh('rank',     '#',       'Rank by unique spots')}
            ${makeTh('reporter', 'Reporter','Receiver callsign & locator')}
            ${makeTh('raw',      '#Raw',    'Total spots including duplicates')}
            ${makeTh('dupes',    '#Dupes',  'Duplicate spots (same tx/time/band)')}
            ${makeTh('unique',   '#Unique', 'Unique transmitters heard')}
            ${bands.map(b => makeTh(b, b, b + ' unique count')).join('')}
        </tr>`;

        // Attach sort click handlers
        thead.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.col;
                if (_sortCol === col) {
                    _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    _sortCol = col;
                    _sortDir = (col === 'reporter' || col === 'locator') ? 'asc' : 'desc';
                }
                if (_lastData) _renderTable(_lastData);
            });
        });
    }

    // ── Map view ─────────────────────────────────────────────────────────────
    // The map shows exactly the rows the table would show (same sort + filters),
    // positioned from the lat/lon the API derives from each reporter's locator.

    function switchView(mode) {
        if (mode !== 'table' && mode !== 'map') return;
        _viewMode = mode;

        const tableBtn = document.getElementById('wsprRankViewBtn_table');
        const mapBtn   = document.getElementById('wsprRankViewBtn_map');
        [[tableBtn, 'table'], [mapBtn, 'map']].forEach(([btn, key]) => {
            if (!btn) return;
            const active = key === mode;
            btn.style.background = active ? '#3f51b5' : '#e8eaf6';
            btn.style.color      = active ? 'white'   : '#283593';
            btn.style.fontWeight = active ? '600'     : '';
        });

        const tableView = document.getElementById('wsprRankTableView');
        const mapView   = document.getElementById('wsprRankMapView');
        if (tableView) tableView.style.display = (mode === 'table') ? ''     : 'none';
        if (mapView)   mapView.style.display   = (mode === 'map')   ? 'flex' : 'none';
        const labelsToggle = document.getElementById('wsprRankMapLabelsToggle');
        if (labelsToggle) labelsToggle.style.display = (mode === 'map') ? 'flex' : 'none';

        if (mode === 'map') {
            _lastFitKey = ''; // refit whenever the map tab is entered
            _renderMap();
        }
    }

    function wsprRankMapLabelsChanged() {
        const el = document.getElementById('wsprRankMapLabels');
        _showMapLabels = el ? el.checked : true;
        _renderMap();
    }

    // Loads leaflet.css + leaflet.js on demand — admin.html does not ship them.
    function _ensureLeaflet() {
        if (window.L) return Promise.resolve();
        if (_leafletPromise) return _leafletPromise;
        _leafletPromise = new Promise((resolve, reject) => {
            const css = document.createElement('link');
            css.rel  = 'stylesheet';
            css.href = 'leaflet.css';
            document.head.appendChild(css);

            const style = document.createElement('style');
            style.textContent =
                '.wspr-rank-tip{background:rgba(255,255,255,0.88);border:1px solid #9fa8da;border-radius:3px;' +
                'padding:1px 4px;font-size:11px;font-weight:600;color:#283593;box-shadow:none;white-space:nowrap;}' +
                '.wspr-rank-tip::before{display:none;}' +
                '.wspr-rank-tip-own{background:rgba(255,248,225,0.95);border-color:#f9a825;color:#e65100;}' +
                '.wspr-rank-tip-sel{background:rgba(227,242,253,0.95);border-color:#1976d2;color:#0d47a1;}';
            document.head.appendChild(style);

            const s = document.createElement('script');
            s.src     = 'leaflet.js';
            s.onload  = () => resolve();
            s.onerror = () => { _leafletPromise = null; reject(new Error('failed to load leaflet.js')); };
            document.head.appendChild(s);
        });
        return _leafletPromise;
    }

    function _flagEmoji(code) {
        if (!code || code.length !== 2) return '';
        return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
    }

    // Popup body — mirrors every column the table shows for this receiver.
    function _mapPopupHTML(row) {
        const bands = _visibleBands;
        const bu    = row.band_uniques || {};
        const continentName = row.continent ? (CONTINENT_NAMES[row.continent] || row.continent) : '';
        const isOwn      = _ownCallsign && row.reporter.toUpperCase() === _ownCallsign;
        const isSelected = _selectedCallsigns.has(row.reporter);
        const isUberSDR  = row.versions && row.versions.some(v => v === 'UberSDR');

        const bandCells = bands
            .filter(b => (bu[b] || 0) > 0)
            .map(b => `<span style="display:inline-block;margin:1px 4px 1px 0;padding:1px 5px;background:#e8eaf6;border:1px solid #c5cae9;border-radius:3px;">
                    <b>${_esc(b)}</b> ${(bu[b] || 0).toLocaleString()}</span>`)
            .join('');

        const line = (label, value) =>
            `<tr><td style="padding:1px 8px 1px 0;color:#666;white-space:nowrap;">${label}</td>
                 <td style="padding:1px 0;text-align:right;font-weight:600;">${value}</td></tr>`;

        const repEsc = _esc(row.reporter).replace(/'/g, '&#39;');
        return `<div style="font-size:12px;min-width:210px;">
            <div style="font-size:14px;font-weight:700;color:#283593;margin-bottom:2px;">
                ${_flagEmoji(row.country_code)} ${_esc(row.reporter)}
                ${isUberSDR ? '<img src="images/favicon-16x16.png" width="14" height="14" style="vertical-align:middle;" alt="UberSDR">' : ''}
                ${isOwn ? ' ⭐' : ''}${isSelected ? ' 🔵' : ''}
            </div>
            <div style="color:#666;margin-bottom:6px;">
                Rank #${row.rank} · ${_esc(row.locator)}
                ${(row.lat != null && row.lon != null) ? ' · ' + row.lat.toFixed(3) + ', ' + row.lon.toFixed(3) : ''}
            </div>
            ${row.country ? `<div style="margin-bottom:6px;color:#444;">${_esc(row.country)}${continentName ? ', ' + _esc(continentName) : ''}</div>` : ''}
            <table style="border-collapse:collapse;width:100%;margin-bottom:6px;">
                ${line('#Raw',    (row.raw    || 0).toLocaleString())}
                ${line('#Dupes',  (row.dupes  || 0).toLocaleString())}
                ${line('#Unique', `<span style="color:#283593;">${(row.unique || 0).toLocaleString()}</span>`)}
            </table>
            ${bandCells ? `<div style="margin-bottom:6px;line-height:1.7;">${bandCells}</div>` : ''}
            ${row.versions && row.versions.length ? `<div style="color:#666;margin-bottom:6px;">💻 ${_esc(row.versions.join(' / '))}</div>` : ''}
            <button onclick="wsprRankRowClicked('${repEsc}')"
                style="padding:3px 8px;border:1px solid #9fa8da;border-radius:4px;font-size:11px;cursor:pointer;background:#e8eaf6;color:#283593;">
                ${isSelected ? '✕ Remove from comparison' : '🔵 Add to comparison'}</button>
        </div>`;
    }

    async function _renderMap() {
        if (_viewMode !== 'map') return;

        const host = document.getElementById('wsprRankMap');
        if (!host) return;

        try {
            await _ensureLeaflet();
        } catch (e) {
            host.innerHTML = '<div style="padding:20px;color:#888;font-size:12px;">Map unavailable: ' + _esc(e.message) + '</div>';
            return;
        }
        if (_viewMode !== 'map') return; // tab switched while Leaflet was loading

        if (!_map) {
            _map = L.map(host, { worldCopyJump: true, preferCanvas: true }).setView([25, 0], 2);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19,
            }).addTo(_map);
            _markerLayer = L.layerGroup().addTo(_map);
        }
        _map.invalidateSize();
        _markerLayer.clearLayers();

        const rows = _visibleRows.filter(r => typeof r.lat === 'number' && typeof r.lon === 'number');
        const bounds = [];

        rows.forEach(row => {
            const isOwn      = _ownCallsign && row.reporter.toUpperCase() === _ownCallsign;
            const isSelected = _selectedCallsigns.has(row.reporter);
            const colour = isSelected ? '#1976d2' : (isOwn ? '#f9a825' : '#3f51b5');

            const marker = L.circleMarker([row.lat, row.lon], {
                radius:      (isSelected || isOwn) ? 7 : 5,
                color:       '#ffffff',
                weight:      1,
                fillColor:   colour,
                fillOpacity: 0.9,
            });

            marker.bindPopup(_mapPopupHTML(row), { maxWidth: 320 });
            if (_showMapLabels) {
                const cls = 'wspr-rank-tip' +
                    (isSelected ? ' wspr-rank-tip-sel' : (isOwn ? ' wspr-rank-tip-own' : ''));
                marker.bindTooltip(
                    `${_flagEmoji(row.country_code)} ${_esc(row.reporter)} <span style="color:#777;font-weight:400;">#${row.rank}</span>`,
                    { permanent: true, direction: 'right', offset: [6, 0], className: cls }
                );
            }
            marker.on('mouseover', () => { if (!marker.isPopupOpen()) marker.openPopup(); });

            marker.addTo(_markerLayer);
            bounds.push([row.lat, row.lon]);
        });

        // Refit only when the marker set actually changes, so panning/zooming
        // survives re-renders caused by selection toggles.
        const fitKey = rows.map(r => r.reporter).join(',');
        if (bounds.length > 0 && fitKey !== _lastFitKey) {
            _map.fitBounds(bounds, { padding: [30, 30], maxZoom: 6 });
        }
        _lastFitKey = fitKey;
    }

    // ── DOM helpers ──────────────────────────────────────────────────────────
    function _setStatus(msg, uberSdrCount, uberSdrTop25) {
        const el = document.getElementById('wsprRankStatus');
        if (!el) return;
        if (uberSdrCount !== undefined && uberSdrCount > 0) {
            el.style.display = 'flex';
            el.style.justifyContent = 'space-between';
            el.style.alignItems = 'center';
            const top25Str = uberSdrTop25 > 0 ? ', ' + uberSdrTop25 + ' in top 25' : '';
            el.innerHTML =
                '<span>' + _esc(msg) + '</span>' +
                '<span style="white-space:nowrap;color:#555;"><img src="images/favicon-16x16.png" width="16" height="16" style="vertical-align:middle;display:inline-block;" alt="UberSDR"> ' +
                uberSdrCount + ' UberSDR reporter' + (uberSdrCount !== 1 ? 's' : '') + top25Str + '</span>';
        } else {
            el.style.display = '';
            el.style.justifyContent = '';
            el.style.alignItems = '';
            el.textContent = msg;
        }
    }

    function _setTableContent(html) {
        const el = document.getElementById('wsprRankTbody');
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
        const modal = document.getElementById('wsprRankModal');
        if (modal) {
            modal.addEventListener('click', e => {
                if (e.target === modal) closeWSPRRankModal();
            });
        }
    });

    // ── Public API ───────────────────────────────────────────────────────────
    window.openWSPRRankModal        = openWSPRRankModal;
    window.closeWSPRRankModal       = closeWSPRRankModal;
    window.switchWSPRRankWindow     = switchWindow;
    window.refreshWSPRRank          = refreshWSPRRank;
    window.wsprRankSearchChanged    = wsprRankSearchChanged;
    window.wsprRankContinentChanged = wsprRankContinentChanged;
    window.wsprRankCountryChanged   = wsprRankCountryChanged;
    window.clearWSPRRankSelection   = clearWSPRRankSelection;
    window.switchWSPRRankView       = switchView;
    window.wsprRankMapLabelsChanged = wsprRankMapLabelsChanged;
    // Called from inline onclick on table rows
    window.wsprRankRowClicked       = _toggleCallsignSelection;

})();
