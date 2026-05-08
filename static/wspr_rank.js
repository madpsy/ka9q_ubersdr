/**
 * wspr_rank.js
 * WSPR Live Receiver Ranking — admin modal
 *
 * Exposes one public function: openWSPRRankModal()
 * Called from the Decoder tab in admin.html.
 *
 * Fetches GET /admin/wspr-rank?format=table&window=<w> and renders a
 * sortable leaderboard table inside a modal.  Three window buttons let the
 * user switch between:
 *   yesterday   — midnight-to-midnight UTC yesterday  (default)
 *   rolling_24h — last 24 hours to now
 *   today       — midnight UTC today to now
 */

'use strict';

(() => {

    // ── State ────────────────────────────────────────────────────────────────
    let _currentWindow = 'yesterday'; // default window
    let _lastData      = null;        // last WSPRRankTable response
    let _sortCol       = 'unique';
    let _sortDir       = 'desc';
    let _refreshTimer  = null;        // rate-limit cooldown timer

    // ── Constants ────────────────────────────────────────────────────────────
    const WINDOW_LABELS = {
        yesterday:   '📅 Yesterday (UTC)',
        rolling_24h: '🕐 Rolling 24h',
        today:       '☀️ Today (UTC)',
    };

    const WINDOW_ORDER = ['yesterday', 'rolling_24h', 'today'];

    // ── Modal open/close ─────────────────────────────────────────────────────
    function openWSPRRankModal() {
        const modal = document.getElementById('wsprRankModal');
        if (!modal) return;
        modal.style.display = 'flex';
        _loadWindow(_currentWindow);
    }

    function closeWSPRRankModal() {
        const modal = document.getElementById('wsprRankModal');
        if (modal) modal.style.display = 'none';
    }

    // ── Window switching ─────────────────────────────────────────────────────
    function switchWindow(w) {
        if (!WINDOW_LABELS[w]) return;
        _currentWindow = w;

        // Update button active states
        WINDOW_ORDER.forEach(key => {
            const btn = document.getElementById('wsprRankBtn_' + key);
            if (btn) btn.classList.toggle('wspr-rank-btn-active', key === w);
        });

        _loadWindow(w);
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
        _setStatus(
            'Fetched ' + fetchedAt +
            ' (' + data.fetched_ms + ' ms) · ' +
            'Showing ' + rows.length + ' receivers' +
            (rowsBefore ? ' of ' + rowsBefore.toLocaleString() + ' total' : '')
        );

        if (rows.length === 0) {
            _setTableContent('<tr><td colspan="99" style="text-align:center;padding:20px;color:#888;">No data for this window.</td></tr>');
            _renderHeaders(bands);
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
            if (bands.includes(_sortCol)) {
                va = (a.band_uniques || {})[_sortCol] || 0;
                vb = (b.band_uniques || {})[_sortCol] || 0;
            } else {
                va = a[_sortCol] ?? 0;
                vb = b[_sortCol] ?? 0;
            }
            return _sortDir === 'asc' ? va - vb : vb - va;
        });

        // Totals row
        const totals = data.totals || {};
        const totalRaw    = (data.total_raw    || 0).toLocaleString();
        const totalDupes  = (data.total_dupes  || 0).toLocaleString();
        const totalUnique = (data.total_unique || 0).toLocaleString();

        const totalsRow = `<tr style="background:#f0f4ff;font-weight:bold;border-bottom:2px solid #9fa8da;">
            <td style="padding:6px 8px;text-align:right;color:#555;">Totals</td>
            <td style="padding:6px 8px;"></td>
            <td style="padding:6px 8px;text-align:right;">${totalRaw}</td>
            <td style="padding:6px 8px;text-align:right;">${totalDupes}</td>
            <td style="padding:6px 8px;text-align:right;">${totalUnique}</td>
            ${bands.map(b => `<td style="padding:6px 8px;text-align:right;">${((totals[b] || 0)).toLocaleString()}</td>`).join('')}
        </tr>`;

        const dataRows = sorted.map(row => {
            const bu = row.band_uniques || {};
            return `<tr>
                <td style="padding:5px 8px;text-align:right;color:#888;font-size:12px;">${row.rank}</td>
                <td style="padding:5px 8px;font-weight:600;white-space:nowrap;">
                    ${_esc(row.reporter)}
                    <span style="color:#888;font-size:11px;margin-left:4px;">${_esc(row.locator)}</span>
                </td>
                <td style="padding:5px 8px;text-align:right;">${(row.raw || 0).toLocaleString()}</td>
                <td style="padding:5px 8px;text-align:right;">${(row.dupes || 0).toLocaleString()}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:600;color:#283593;">${(row.unique || 0).toLocaleString()}</td>
                ${bands.map(b => {
                    const v = bu[b] || 0;
                    return `<td style="padding:5px 8px;text-align:right;${v > 0 ? '' : 'color:#ccc;'}">${v > 0 ? v.toLocaleString() : '—'}</td>`;
                }).join('')}
            </tr>`;
        }).join('');

        _renderHeaders(bands);
        _setTableContent(totalsRow + dataRows);
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

    // ── DOM helpers ──────────────────────────────────────────────────────────
    function _setStatus(msg) {
        const el = document.getElementById('wsprRankStatus');
        if (el) el.textContent = msg;
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
    window.openWSPRRankModal  = openWSPRRankModal;
    window.closeWSPRRankModal = closeWSPRRankModal;
    window.switchWSPRRankWindow = switchWindow;
    window.refreshWSPRRank    = refreshWSPRRank;

})();
