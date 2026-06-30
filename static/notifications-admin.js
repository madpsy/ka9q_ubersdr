'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — filter field definitions per event type
// ═══════════════════════════════════════════════════════════════════════════════

const FILTER_FIELDS = {
    cw_spot: [
        { name: 'callsigns',         type: 'string_list', label: 'Callsigns',         hint: 'Exact match, e.g. G3XYZ, M0ABC' },
        { name: 'callsign_prefixes', type: 'string_list', label: 'Callsign Prefixes', hint: 'e.g. 3Y, JD1, VK0' },
        { name: 'countries',         type: 'string_list', label: 'Countries',          hint: 'CTY country name, e.g. Japan' },
        { name: 'country_codes',     type: 'string_list', label: 'Country Codes',      hint: 'ISO alpha-2, e.g. JP, AU' },
        { name: 'continents',        type: 'enum_list',   label: 'Continents',         values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'cq_zones',          type: 'int_list',    label: 'CQ Zones',           hint: 'e.g. 3, 14, 28' },
        { name: 'itu_zones',         type: 'int_list',    label: 'ITU Zones',          hint: 'e.g. 6, 7' },
        { name: 'bands',             type: 'string_list', label: 'Bands',              hint: 'e.g. 40m, 20m' },
        { name: 'modes',             type: 'enum_list',   label: 'Modes',              values: ['CW','RTTY'] },
        { name: 'min_snr',           type: 'int',         label: 'Min SNR (dB)',       hint: 'Minimum SNR inclusive' },
        { name: 'max_snr',           type: 'int',         label: 'Max SNR (dB)',       hint: 'Maximum SNR inclusive' },
        { name: 'min_wpm',           type: 'int',         label: 'Min WPM',            hint: 'Minimum speed in WPM' },
        { name: 'min_distance_km',   type: 'float',       label: 'Min Distance (km)',  hint: 'Requires locator data' },
        { name: 'max_distance_km',   type: 'float',       label: 'Max Distance (km)',  hint: '' },
    ],
    dx_spot: [
        { name: 'callsigns',         type: 'string_list', label: 'Callsigns',          hint: 'Exact match' },
        { name: 'callsign_prefixes', type: 'string_list', label: 'Callsign Prefixes',  hint: 'e.g. 3Y, JD1' },
        { name: 'countries',         type: 'string_list', label: 'Countries',           hint: 'CTY country name' },
        { name: 'country_codes',     type: 'string_list', label: 'Country Codes',       hint: 'ISO alpha-2' },
        { name: 'continents',        type: 'enum_list',   label: 'Continents',          values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'cq_zones',          type: 'int_list',    label: 'CQ Zones',            hint: '' },
        { name: 'itu_zones',         type: 'int_list',    label: 'ITU Zones',           hint: '' },
        { name: 'bands',             type: 'string_list', label: 'Bands',               hint: 'e.g. 20m' },
        { name: 'comment_contains',  type: 'string_list', label: 'Comment Contains',    hint: 'Case-insensitive substrings' },
        { name: 'spotters',          type: 'string_list', label: 'Spotters',            hint: 'Spotter callsign exact match' },
    ],
    digital_decode: [
        { name: 'callsigns',         type: 'string_list', label: 'Callsigns',          hint: 'Exact match' },
        { name: 'callsign_prefixes', type: 'string_list', label: 'Callsign Prefixes',  hint: '' },
        { name: 'countries',         type: 'string_list', label: 'Countries',           hint: '' },
        { name: 'country_codes',     type: 'string_list', label: 'Country Codes',       hint: 'ISO alpha-2' },
        { name: 'continents',        type: 'enum_list',   label: 'Continents',          values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'cq_zones',          type: 'int_list',    label: 'CQ Zones',            hint: '' },
        { name: 'itu_zones',         type: 'int_list',    label: 'ITU Zones',           hint: '' },
        { name: 'bands',             type: 'string_list', label: 'Bands',               hint: 'e.g. 20m, 40m' },
        { name: 'digital_modes',     type: 'enum_list',   label: 'Digital Modes',       values: ['FT8','FT4','WSPR','JS8'] },
        { name: 'min_snr',           type: 'int',         label: 'Min SNR (dB)',        hint: '' },
        { name: 'max_snr',           type: 'int',         label: 'Max SNR (dB)',        hint: '' },
        { name: 'message_contains',  type: 'string_list', label: 'Message Contains',    hint: 'Decoded message substrings' },
        { name: 'min_distance_km',   type: 'float',       label: 'Min Distance (km)',   hint: '' },
        { name: 'max_distance_km',   type: 'float',       label: 'Max Distance (km)',   hint: '' },
    ],
    space_weather: [
        { name: 'k_min',   type: 'int',   label: 'K-index Min',  hint: 'Fire when K-index >= this' },
        { name: 'k_max',   type: 'int',   label: 'K-index Max',  hint: 'Fire when K-index <= this' },
        { name: 'a_min',   type: 'int',   label: 'A-index Min',  hint: 'Fire when A-index >= this' },
        { name: 'sfi_min', type: 'float', label: 'SFI Min',      hint: 'Fire when SFI >= this' },
        { name: 'sfi_max', type: 'float', label: 'SFI Max',      hint: 'Fire when SFI <= this' },
    ],
    antenna_switch: [
        { name: 'ant_actions', type: 'enum_list', label: 'Actions',      values: ['select','ground','add','remove','default'] },
        { name: 'ant_numbers', type: 'int_list',  label: 'Ant Numbers',  hint: 'Specific antenna port numbers' },
        { name: 'ant_sources', type: 'enum_list', label: 'Sources',      values: ['public','admin','startup','scheduler'] },
    ],
    rotator: [
        { name: 'rotator_moving', type: 'bool_optional', label: 'Moving State', hint: 'true=only when starts moving; false=only when stops; blank=any change' },
    ],
    system_monitor: [
        { name: 'components',   type: 'enum_list', label: 'Components',    values: ['noise_floor','space_weather','decoder','cw_skimmer','mqtt','rotator','ant_switch','frequency_reference','instance_reporter','sdr_frontend','gpsdo','system_load','cpu_temperature'] },
        { name: 'on_unhealthy', type: 'bool',      label: 'On Unhealthy',  hint: 'Fire only on healthy to unhealthy transition' },
        { name: 'on_recovery',  type: 'bool',      label: 'On Recovery',   hint: 'Fire only on unhealthy to healthy transition' },
    ],
    user_session: [
        { name: 'session_actions',       type: 'enum_list',   label: 'Actions',             values: ['connected','disconnected'] },
        { name: 'session_country_codes', type: 'string_list', label: 'Country Codes',       hint: 'ISO alpha-2, e.g. US, CA' },
        { name: 'session_continents',    type: 'enum_list',   label: 'Continents',          values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'user_agent_contains',   type: 'string_list', label: 'User-Agent Contains', hint: 'e.g. bot, curl' },
        { name: 'client_ips',            type: 'string_list', label: 'Client IPs',          hint: 'Specific IP addresses' },
    ],
    voice_activity: [
        { name: 'voice_bands',          type: 'string_list', label: 'Bands',           hint: 'e.g. 20m, 40m; empty = all' },
        { name: 'voice_country_codes',  type: 'string_list', label: 'Country Codes',   hint: 'DX cluster enriched, ISO alpha-2' },
        { name: 'voice_continents',     type: 'enum_list',   label: 'Continents',      values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'voice_callsigns',      type: 'string_list', label: 'Callsigns',       hint: 'DX cluster enriched, exact match' },
        { name: 'voice_min_snr',        type: 'float',       label: 'Min SNR (dB)',    hint: 'Minimum detected SNR' },
        { name: 'voice_min_confidence', type: 'float',       label: 'Min Confidence',  hint: '0.0 to 1.0' },
    ],
    server_startup: [],
};

const EVENT_TYPES = Object.keys(FILTER_FIELDS);

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let localConfig = {
    enabled: false,
    channels: {},
    rules: [],
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

async function apiFetch(url, options) {
    options = options || {};
    const resp = await fetch(url, options);
    if (resp.status === 401) {
        const returnUrl = encodeURIComponent(window.location.pathname);
        window.location.href = '/admin.html?return=' + returnUrl;
        throw new Error('Redirecting to login');
    }
    return resp;
}

function showAlert(container, type, message, autoDismiss) {
    if (autoDismiss === undefined) autoDismiss = true;
    const div = document.createElement('div');
    div.className = 'alert alert-' + type;
    div.innerHTML = '<span>' + escHtml(message) + '</span><span class="alert-dismiss" title="Dismiss">&#x2715;</span>';
    div.querySelector('.alert-dismiss').addEventListener('click', function() { div.remove(); });
    container.prepend(div);
    if (autoDismiss) {
        setTimeout(function() { if (div.parentNode) div.remove(); }, 4000);
    }
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function parseCSV(str) {
    return str.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function parseIntCSV(str) {
    return str.split(',').map(function(s) { return parseInt(s.trim(), 10); }).filter(function(n) { return !isNaN(n); });
}

function fmtDate(str) {
    if (!str || str === '0001-01-01T00:00:00Z') return '\u2014';
    try { return new Date(str).toLocaleString(); } catch(e) { return str; }
}

function el(id) { return document.getElementById(id); }

// ═══════════════════════════════════════════════════════════════════════════════
// TAB SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

function initTabs() {
    document.querySelectorAll('.tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
            tab.classList.add('active');
            el('tab-' + tab.dataset.tab).classList.add('active');
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1 — OVERVIEW / HEALTH
// ═══════════════════════════════════════════════════════════════════════════════

async function loadHealth() {
    const loading = el('healthLoading');
    const content = el('healthContent');
    loading.style.display = 'flex';
    content.style.display = 'none';

    try {
        const resp = await apiFetch('/admin/notifications/health');
        const data = await resp.json();

        el('masterEnable').checked = !!data.enabled;

        const stats = data.stats || {};
        const statsGrid = el('statsGrid');
        const statItems = [
            { label: 'Published',    value: stats.total_published    != null ? stats.total_published    : 0 },
            { label: 'Sent',         value: stats.total_sent         != null ? stats.total_sent         : 0 },
            { label: 'Errors',       value: stats.total_errors       != null ? stats.total_errors       : 0 },
            { label: 'Rate-Limited', value: stats.total_rate_limited != null ? stats.total_rate_limited : 0 },
        ];
        statsGrid.innerHTML = statItems.map(function(s) {
            return '<div class="stat-card"><div class="stat-value">' + s.value + '</div><div class="stat-label">' + s.label + '</div></div>';
        }).join('');

        const dotClass = data.enabled ? 'green' : 'grey';
        const lastSent  = fmtDate(stats.last_sent_at);
        const lastError = fmtDate(stats.last_error_at);
        el('statusDetails').innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
                '<span class="status-dot ' + dotClass + '"></span>' +
                '<strong>' + (data.enabled ? 'Enabled' : 'Disabled') + '</strong>' +
            '</div>' +
            '<div style="font-size:0.875rem;color:#555;display:grid;grid-template-columns:auto 1fr;gap:4px 16px">' +
                '<span style="color:#888">Last sent:</span><span>' + lastSent + '</span>' +
                '<span style="color:#888">Last error:</span><span>' + lastError + '</span>' +
            '</div>';

        const issues = data.issues || [];
        const issuesSection = el('issuesSection');
        const issuesList    = el('issuesList');
        if (issues.length > 0) {
            issuesList.innerHTML = issues.map(function(i) { return '<li>' + escHtml(i) + '</li>'; }).join('');
            issuesSection.style.display = 'block';
        } else {
            issuesSection.style.display = 'none';
        }

        loading.style.display = 'none';
        content.style.display = 'block';
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        loading.style.display = 'none';
        content.style.display = 'block';
        showAlert(el('overviewAlerts'), 'error', 'Failed to load health: ' + err.message, false);
    }
}

async function loadConfig() {
    try {
        const resp = await apiFetch('/admin/notifications/config');
        if (!resp.ok) return;
        const data = await resp.json();

        localConfig.enabled = !!data.enabled;

        const serverChannels = data.channels || {};
        const merged = {};
        for (const name in serverChannels) {
            const ch = serverChannels[name];
            const existing = localConfig.channels[name];
            merged[name] = {
                type:               ch.type              || 'telegram',
                bot_token:          (existing && existing.bot_token && existing.bot_token !== '********')
                                        ? existing.bot_token
                                        : (ch.bot_token_set ? '********' : ''),
                chat_id:            ch.chat_id            || '',
                parse_mode:         ch.parse_mode         || 'HTML',
                rate_limit_minutes: ch.rate_limit_minutes != null ? ch.rate_limit_minutes : 10,
            };
        }
        localConfig.channels = merged;

        const serverRules = data.rules || [];
        localConfig.rules = serverRules.map(function(sr) {
            return {
                name:     sr.name,
                enabled:  sr.enabled,
                event:    sr.event,
                channels: sr.channels || [],
                filters:  sr.filters  || {},
                template: sr.template || '',
            };
        });

        el('masterEnable').checked = localConfig.enabled;
        renderChannels();
        renderRules();
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        console.error('loadConfig error:', err);
    }
}

function initOverview() {
    el('btnRefreshHealth').addEventListener('click', loadHealth);

    el('btnSaveEnable').addEventListener('click', async function() {
        localConfig.enabled = el('masterEnable').checked;
        const ok = await saveConfig(el('overviewAlerts'));
        if (ok) await loadHealth();
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVE CONFIG (shared)
// ═══════════════════════════════════════════════════════════════════════════════

async function saveConfig(alertContainer) {
    const payload = {
        enabled:  localConfig.enabled,
        channels: {},
        rules:    [],
    };

    for (const name in localConfig.channels) {
        const ch = localConfig.channels[name];
        payload.channels[name] = {
            type:               ch.type,
            bot_token:          ch.bot_token || '********',
            chat_id:            ch.chat_id,
            parse_mode:         ch.parse_mode || 'HTML',
            rate_limit_minutes: Number(ch.rate_limit_minutes) || 10,
        };
    }

    localConfig.rules.forEach(function(rule) {
        const r = {
            name:     rule.name,
            enabled:  rule.enabled,
            event:    rule.event,
            channels: rule.channels,
            filters:  buildFiltersPayload(rule.event, rule.filters),
        };
        if (rule.template) r.template = rule.template;
        payload.rules.push(r);
    });

    try {
        const resp = await apiFetch('/admin/notifications/config', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
        const data = await resp.json();

        if (resp.ok && data.ok) {
            showAlert(alertContainer, 'success', data.message || 'Configuration saved.');
            return true;
        } else {
            const issues = data.issues ? '\n' + data.issues.join('\n') : '';
            showAlert(alertContainer, 'error', (data.error || 'Save failed.') + issues, false);
            return false;
        }
    } catch (err) {
        if (err.message === 'Redirecting to login') return false;
        showAlert(alertContainer, 'error', 'Save error: ' + err.message, false);
        return false;
    }
}

function buildFiltersPayload(eventType, filters) {
    if (!filters) return {};
    const fields = FILTER_FIELDS[eventType] || [];
    const out = {};
    fields.forEach(function(fd) {
        const val = filters[fd.name];
        if (val === undefined || val === null || val === '') return;
        if (fd.type === 'string_list' || fd.type === 'enum_list') {
            const arr = Array.isArray(val) ? val : parseCSV(String(val));
            if (arr.length > 0) out[fd.name] = arr;
        } else if (fd.type === 'int_list') {
            const arr = Array.isArray(val) ? val : parseIntCSV(String(val));
            if (arr.length > 0) out[fd.name] = arr;
        } else if (fd.type === 'int') {
            const n = parseInt(val, 10);
            if (!isNaN(n)) out[fd.name] = n;
        } else if (fd.type === 'float') {
            const n = parseFloat(val);
            if (!isNaN(n)) out[fd.name] = n;
        } else if (fd.type === 'bool') {
            if (val !== '' && val !== undefined) out[fd.name] = (val === true || val === 'true');
        } else if (fd.type === 'bool_optional') {
            if (val !== '' && val !== undefined && val !== null) {
                out[fd.name] = (val === true || val === 'true');
            }
        }
    });
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2 — CHANNELS
// ═══════════════════════════════════════════════════════════════════════════════

function renderChannels() {
    const list = el('channelList');
    const channels = localConfig.channels;
    const names = Object.keys(channels);

    if (names.length === 0) {
        list.innerHTML =
            '<div class="empty-state">' +
                '<div class="empty-state-icon">&#x1F4E1;</div>' +
                '<p>No channels configured yet.</p>' +
                '<p style="font-size:0.85rem;margin-top:4px">Click &ldquo;Add Channel&rdquo; to create one.</p>' +
            '</div>';
        return;
    }

    list.innerHTML = names.map(function(name) {
        const ch = channels[name];
        let tokenBadge;
        if (ch.bot_token && ch.bot_token !== '********') {
            tokenBadge = '<span class="badge badge-green">Token entered</span>';
        } else if (ch.bot_token === '********') {
            tokenBadge = '<span class="badge badge-yellow">Token set (hidden)</span>';
        } else {
            tokenBadge = '<span class="badge badge-red">No token</span>';
        }
        return '<div class="item-card" data-channel="' + escHtml(name) + '">' +
            '<div class="item-card-header">' +
                '<div>' +
                    '<div class="item-card-title">&#x1F4E1; ' + escHtml(name) + '</div>' +
                    '<div class="item-card-meta">' +
                        '<span class="badge badge-blue">' + escHtml(ch.type) + '</span>' +
                        tokenBadge +
                        (ch.chat_id ? '<span class="badge badge-grey">chat: ' + escHtml(ch.chat_id) + '</span>' : '') +
                        '<span class="badge badge-grey">' + escHtml(ch.parse_mode || 'HTML') + '</span>' +
                        '<span class="badge badge-grey">rate: ' + (ch.rate_limit_minutes != null ? ch.rate_limit_minutes : 10) + ' min</span>' +
                    '</div>' +
                '</div>' +
                '<div class="item-card-actions">' +
                    '<button class="btn btn-sm btn-secondary btn-test-channel" data-name="' + escHtml(name) + '">&#x1F9EA; Test</button>' +
                    '<button class="btn btn-sm btn-edit-channel" data-name="' + escHtml(name) + '">&#x270F;&#xFE0F; Edit</button>' +
                    '<button class="btn btn-sm btn-danger btn-delete-channel" data-name="' + escHtml(name) + '">&#x1F5D1;&#xFE0F; Delete</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');

    list.querySelectorAll('.btn-test-channel').forEach(function(btn) {
        btn.addEventListener('click', function() { testChannel(btn.dataset.name); });
    });
    list.querySelectorAll('.btn-edit-channel').forEach(function(btn) {
        btn.addEventListener('click', function() { showChannelForm(btn.dataset.name); });
    });
    list.querySelectorAll('.btn-delete-channel').forEach(function(btn) {
        btn.addEventListener('click', function() { deleteChannel(btn.dataset.name); });
    });
}

function deleteChannel(name) {
    if (!confirm('Delete channel "' + name + '"? It will also be removed from any rules that reference it.')) return;
    delete localConfig.channels[name];
    localConfig.rules.forEach(function(rule) {
        rule.channels = rule.channels.filter(function(c) { return c !== name; });
    });
    renderChannels();
    renderRules();
    showAlert(el('channelsAlerts'), 'warning', 'Channel "' + name + '" removed. Click "Save All Changes" to persist.');
}

async function testChannel(name) {
    const alertEl = el('channelsAlerts');
    const ch = localConfig.channels[name];
    if (!ch) return;

    let body;
    if (ch.bot_token && ch.bot_token !== '********') {
        body = { type: ch.type, bot_token: ch.bot_token, chat_id: ch.chat_id, parse_mode: ch.parse_mode || 'HTML' };
    } else {
        body = { channel: name };
    }

    showAlert(alertEl, 'info', 'Sending test to "' + name + '"...', true);
    try {
        const resp = await apiFetch('/admin/notifications/test', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        const data = await resp.json();
        if (data.ok) {
            showAlert(alertEl, 'success', 'Test sent to "' + name + '" in ' + data.duration_ms + 'ms');
        } else {
            showAlert(alertEl, 'error', 'Test failed: ' + (data.error || 'unknown error'), false);
        }
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        showAlert(alertEl, 'error', 'Test error: ' + err.message, false);
    }
}

function showChannelForm(editName) {
    const container = el('channelFormContainer');
    const isEdit = editName !== null && editName !== undefined;
    const ch = isEdit ? Object.assign({}, localConfig.channels[editName]) : {
        type: 'telegram', bot_token: '', chat_id: '', parse_mode: 'HTML', rate_limit_minutes: 10,
    };

    const nameReadonly = isEdit ? 'readonly style="background:#f0f0f0"' : '';
    const parseModes = ['HTML','Markdown','MarkdownV2',''];
    const parseModeOptions = parseModes.map(function(m) {
        return '<option value="' + m + '"' + (ch.parse_mode === m ? ' selected' : '') + '>' + (m || 'plain') + '</option>';
    }).join('');

    const tokenPlaceholder = (isEdit && ch.bot_token === '********')
        ? 'Leave blank to keep existing token'
        : 'e.g. 7123456789:AAFxxxxxxxxxxxxxxxx';

    container.style.display = 'block';
    container.innerHTML =
        '<div class="inline-form">' +
            '<div class="inline-form-title">' + (isEdit ? 'Edit Channel: ' + escHtml(editName) : '+ New Channel') + '</div>' +
            '<div class="form-row">' +
                '<div class="form-group">' +
                    '<label>Channel Name *</label>' +
                    '<input type="text" id="chName" value="' + escHtml(isEdit ? editName : '') + '" placeholder="e.g. telegram_main" ' + nameReadonly + '>' +
                    '<div class="form-hint">Unique identifier used in rules. Letters, numbers, underscores.</div>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Type *</label>' +
                    '<select id="chType"><option value="telegram" selected>telegram</option></select>' +
                '</div>' +
            '</div>' +
            '<div class="form-group">' +
                '<label>Bot Token' + (isEdit && ch.bot_token === '********' ? ' (currently set)' : ' *') + '</label>' +
                '<div class="input-group">' +
                    '<input type="password" id="chBotToken" value="" placeholder="' + tokenPlaceholder + '" autocomplete="new-password">' +
                    '<button type="button" class="btn btn-secondary btn-sm" id="btnDiscoverChats">Discover Chats</button>' +
                '</div>' +
                '<div class="form-hint">From @BotFather. Leave blank to keep existing token when editing.</div>' +
            '</div>' +
            '<div id="chatDiscoveryResult"></div>' +
            '<div class="form-row">' +
                '<div class="form-group">' +
                    '<label>Chat ID *</label>' +
                    '<input type="text" id="chChatId" value="' + escHtml(ch.chat_id) + '" placeholder="e.g. -1001234567890">' +
                    '<div class="form-hint">Negative for groups/channels, positive for personal chats.</div>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Parse Mode</label>' +
                    '<select id="chParseMode">' + parseModeOptions + '</select>' +
                '</div>' +
            '</div>' +
            '<div class="form-group" style="max-width:200px">' +
                '<label>Rate Limit (minutes)</label>' +
                '<input type="number" id="chRateLimit" value="' + (ch.rate_limit_minutes != null ? ch.rate_limit_minutes : 10) + '" min="0" max="1440">' +
                '<div class="form-hint">Suppress duplicate alerts within this window. 0 = no limit.</div>' +
            '</div>' +
            '<div class="form-actions">' +
                '<button type="button" class="btn" id="btnSaveChannel">Save Channel</button>' +
                '<button type="button" class="btn btn-secondary" id="btnCancelChannel">Cancel</button>' +
            '</div>' +
        '</div>';

    // Wire up discover chats
    el('btnDiscoverChats').addEventListener('click', function() { discoverChats(editName); });

    el('btnCancelChannel').addEventListener('click', function() {
        container.style.display = 'none';
        container.innerHTML = '';
    });

    el('btnSaveChannel').addEventListener('click', function() {
        const name = el('chName').value.trim();
        if (!name) { showAlert(el('channelsAlerts'), 'error', 'Channel name is required.', false); return; }
        if (!/^[a-zA-Z0-9_]+$/.test(name)) { showAlert(el('channelsAlerts'), 'error', 'Channel name must be letters, numbers, underscores only.', false); return; }

        const newToken = el('chBotToken').value.trim();
        let finalToken;
        if (newToken) {
            finalToken = newToken;
        } else if (isEdit && ch.bot_token === '********') {
            finalToken = '********';
        } else {
            finalToken = '';
        }

        const chatId = el('chChatId').value.trim();
        if (!chatId) { showAlert(el('channelsAlerts'), 'error', 'Chat ID is required.', false); return; }

        localConfig.channels[name] = {
            type:               'telegram',
            bot_token:          finalToken,
            chat_id:            chatId,
            parse_mode:         el('chParseMode').value,
            rate_limit_minutes: parseInt(el('chRateLimit').value, 10) || 0,
        };

        container.style.display = 'none';
        container.innerHTML = '';
        renderChannels();
        showAlert(el('channelsAlerts'), 'success', 'Channel "' + name + '" ' + (isEdit ? 'updated' : 'added') + '. Click "Save All Changes" to persist.');
    });
}

async function discoverChats(editName) {
    const token = el('chBotToken').value.trim();
    const resultEl = el('chatDiscoveryResult');

    if (!token) {
        resultEl.innerHTML = '<div class="alert alert-warning" style="margin-top:8px">Enter a bot token first.</div>';
        return;
    }

    resultEl.innerHTML = '<div class="loading-overlay" style="padding:8px 0"><div class="spinner"></div> Querying Telegram...</div>';

    try {
        const resp = await apiFetch('/admin/notifications/telegram-updates', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ bot_token: token }),
        });
        const data = await resp.json();

        if (!data.ok) {
            resultEl.innerHTML = '<div class="alert alert-error" style="margin-top:8px">Error: ' + escHtml(data.error || 'Unknown error') + '</div>';
            return;
        }

        let html = '<div class="config-section" style="margin-top:12px">' +
            '<div class="config-section-title">Bot: @' + escHtml(data.bot_username || '?') + '</div>';

        if (!data.chats || data.chats.length === 0) {
            html += '<p style="font-size:0.875rem;color:#888">' + escHtml(data.hint || 'No chats found. Send a message to your bot then try again.') + '</p>';
        } else {
            html += '<ul class="chat-list">';
            data.chats.forEach(function(chat) {
                const displayName = chat.title || (chat.first_name ? chat.first_name + (chat.last_name ? ' ' + chat.last_name : '') : '') || String(chat.id);
                html += '<li class="chat-item">' +
                    '<div class="chat-item-info">' +
                        '<span class="chat-item-name">' + escHtml(displayName) + '</span>' +
                        '<span class="chat-item-id">ID: ' + chat.id + ' &bull; ' + escHtml(chat.type) + '</span>' +
                    '</div>' +
                    '<button type="button" class="btn btn-xs" data-chatid="' + chat.id + '">Use this</button>' +
                '</li>';
            });
            html += '</ul>';
        }
        html += '</div>';
        resultEl.innerHTML = html;

        resultEl.querySelectorAll('[data-chatid]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                el('chChatId').value = btn.dataset.chatid;
                resultEl.innerHTML = '<div class="alert alert-success" style="margin-top:8px">Chat ID set to ' + escHtml(btn.dataset.chatid) + '</div>';
            });
        });
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        resultEl.innerHTML = '<div class="alert alert-error" style="margin-top:8px">Error: ' + escHtml(err.message) + '</div>';
    }
}

function initChannels() {
    el('btnAddChannel').addEventListener('click', function() { showChannelForm(null); });
    el('btnSaveChannels').addEventListener('click', async function() {
        await saveConfig(el('channelsAlerts'));
    });
}

// =============================================================================
// TAB 3 — RULES
// =============================================================================

function renderRules() {
    const list = el('ruleList');
    const rules = localConfig.rules;

    if (rules.length === 0) {
        list.innerHTML =
            '<div class="empty-state">' +
                '<div class="empty-state-icon">&#x1F4CB;</div>' +
                '<p>No rules configured yet.</p>' +
                '<p style="font-size:0.85rem;margin-top:4px">Click &ldquo;Add Rule&rdquo; to create one.</p>' +
            '</div>';
        return;
    }

    list.innerHTML = rules.map(function(rule, idx) {
        const enabledBadge = rule.enabled
            ? '<span class="badge badge-green">Enabled</span>'
            : '<span class="badge badge-grey">Disabled</span>';
        const channelBadges = (rule.channels || []).map(function(c) {
            return '<span class="badge badge-blue">' + escHtml(c) + '</span>';
        }).join('');
        const filterCount = rule.filters ? Object.keys(rule.filters).length : 0;
        const filterBadge = filterCount > 0
            ? '<span class="badge badge-purple">' + filterCount + ' filter' + (filterCount !== 1 ? 's' : '') + '</span>'
            : '';
        const templateBadge = rule.template
            ? '<span class="badge badge-yellow">custom template</span>'
            : '';

        return '<div class="item-card" data-rule-idx="' + idx + '">' +
            '<div class="item-card-header">' +
                '<div>' +
                    '<div class="item-card-title">&#x1F4CB; ' + escHtml(rule.name) + '</div>' +
                    '<div class="item-card-meta">' +
                        enabledBadge +
                        '<span class="badge badge-grey">' + escHtml(rule.event) + '</span>' +
                        channelBadges +
                        filterBadge +
                        templateBadge +
                    '</div>' +
                '</div>' +
                '<div class="item-card-actions">' +
                    '<label class="toggle-switch" title="' + (rule.enabled ? 'Disable' : 'Enable') + '">' +
                        '<input type="checkbox" class="rule-toggle" data-idx="' + idx + '"' + (rule.enabled ? ' checked' : '') + '>' +
                        '<span class="toggle-slider"></span>' +
                    '</label>' +
                    '<button class="btn btn-sm btn-edit-rule" data-idx="' + idx + '">&#x270F;&#xFE0F; Edit</button>' +
                    '<button class="btn btn-sm btn-danger btn-delete-rule" data-idx="' + idx + '">&#x1F5D1;&#xFE0F; Delete</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');

    list.querySelectorAll('.rule-toggle').forEach(function(chk) {
        chk.addEventListener('change', function() {
            const idx = parseInt(chk.dataset.idx, 10);
            localConfig.rules[idx].enabled = chk.checked;
            renderRules();
            showAlert(el('rulesAlerts'), 'info', 'Rule "' + localConfig.rules[idx].name + '" ' + (chk.checked ? 'enabled' : 'disabled') + '. Click "Save All Changes" to persist.');
        });
    });
    list.querySelectorAll('.btn-edit-rule').forEach(function(btn) {
        btn.addEventListener('click', function() { showRuleForm(parseInt(btn.dataset.idx, 10)); });
    });
    list.querySelectorAll('.btn-delete-rule').forEach(function(btn) {
        btn.addEventListener('click', function() { deleteRule(parseInt(btn.dataset.idx, 10)); });
    });
}

function deleteRule(idx) {
    const rule = localConfig.rules[idx];
    if (!rule) return;
    if (!confirm('Delete rule "' + rule.name + '"?')) return;
    localConfig.rules.splice(idx, 1);
    renderRules();
    showAlert(el('rulesAlerts'), 'warning', 'Rule "' + rule.name + '" removed. Click "Save All Changes" to persist.');
}

function showRuleForm(editIdx) {
    const container = el('ruleFormContainer');
    const isEdit = editIdx !== null && editIdx !== undefined && editIdx >= 0;
    const rule = isEdit ? Object.assign({}, localConfig.rules[editIdx], { filters: Object.assign({}, localConfig.rules[editIdx].filters) }) : {
        name: '', enabled: true, event: 'dx_spot', channels: [], filters: {}, template: '',
    };

    const eventOptions = EVENT_TYPES.map(function(et) {
        return '<option value="' + et + '"' + (rule.event === et ? ' selected' : '') + '>' + et + '</option>';
    }).join('');

    const channelCheckboxes = Object.keys(localConfig.channels).map(function(name) {
        const checked = (rule.channels || []).indexOf(name) >= 0 ? ' checked' : '';
        return '<label class="checkbox-item"><input type="checkbox" class="rule-channel-cb" value="' + escHtml(name) + '"' + checked + '> ' + escHtml(name) + '</label>';
    }).join('');

    container.style.display = 'block';
    container.innerHTML =
        '<div class="inline-form">' +
            '<div class="inline-form-title">' + (isEdit ? 'Edit Rule: ' + escHtml(rule.name) : '+ New Rule') + '</div>' +
            '<div class="form-row">' +
                '<div class="form-group">' +
                    '<label>Rule Name *</label>' +
                    '<input type="text" id="ruleName" value="' + escHtml(rule.name) + '" placeholder="e.g. DX Alerts">' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Event Type *</label>' +
                    '<select id="ruleEvent">' + eventOptions + '</select>' +
                '</div>' +
            '</div>' +
            '<div class="toggle-row" style="margin-bottom:16px">' +
                '<label class="toggle-switch">' +
                    '<input type="checkbox" id="ruleEnabled"' + (rule.enabled ? ' checked' : '') + '>' +
                    '<span class="toggle-slider"></span>' +
                '</label>' +
                '<span class="toggle-label">Rule Enabled</span>' +
            '</div>' +
            '<div class="config-section">' +
                '<div class="config-section-title">Channels</div>' +
                (Object.keys(localConfig.channels).length === 0
                    ? '<p style="font-size:0.875rem;color:#888">No channels configured. Add a channel first.</p>'
                    : '<div class="checkbox-group" id="ruleChannels">' + channelCheckboxes + '</div>') +
            '</div>' +
            '<div class="config-section" id="filterSection">' +
                '<div class="config-section-title">Filters <span style="font-weight:400;font-size:0.8rem;color:#888">(all optional — leave blank to match everything)</span></div>' +
                '<div class="filter-fields-container" id="filterFields"></div>' +
            '</div>' +
            '<div class="config-section">' +
                '<div class="config-section-title">Template <span style="font-weight:400;font-size:0.8rem;color:#888">(optional — leave blank to use default)</span></div>' +
                '<div class="form-group" style="margin-bottom:0">' +
                    '<textarea id="ruleTemplate" rows="4" placeholder="Go template, e.g. DX: {{.DXCall}} on {{khz .Frequency}} kHz">' + escHtml(rule.template || '') + '</textarea>' +
                    '<div class="form-hint">Uses Go text/template syntax. Available fields depend on the event type.</div>' +
                '</div>' +
            '</div>' +
            '<div class="form-actions">' +
                '<button type="button" class="btn" id="btnSaveRule">Save Rule</button>' +
                '<button type="button" class="btn btn-secondary" id="btnCancelRule">Cancel</button>' +
            '</div>' +
        '</div>';

    // Render filter fields for current event
    renderFilterFields(rule.event, rule.filters);

    // Re-render filters when event type changes
    el('ruleEvent').addEventListener('change', function() {
        renderFilterFields(el('ruleEvent').value, {});
    });

    el('btnCancelRule').addEventListener('click', function() {
        container.style.display = 'none';
        container.innerHTML = '';
    });

    el('btnSaveRule').addEventListener('click', function() {
        const name = el('ruleName').value.trim();
        if (!name) { showAlert(el('rulesAlerts'), 'error', 'Rule name is required.', false); return; }

        const selectedChannels = [];
        container.querySelectorAll('.rule-channel-cb:checked').forEach(function(cb) {
            selectedChannels.push(cb.value);
        });

        const eventType = el('ruleEvent').value;
        const filters = readFilterFields(eventType);
        const template = el('ruleTemplate').value.trim();

        const newRule = {
            name:     name,
            enabled:  el('ruleEnabled').checked,
            event:    eventType,
            channels: selectedChannels,
            filters:  filters,
            template: template,
        };

        if (isEdit) {
            localConfig.rules[editIdx] = newRule;
        } else {
            localConfig.rules.push(newRule);
        }

        container.style.display = 'none';
        container.innerHTML = '';
        renderRules();
        showAlert(el('rulesAlerts'), 'success', 'Rule "' + name + '" ' + (isEdit ? 'updated' : 'added') + '. Click "Save All Changes" to persist.');
    });
}

function renderFilterFields(eventType, currentFilters) {
    const container = el('filterFields');
    const fields = FILTER_FIELDS[eventType] || [];

    if (fields.length === 0) {
        container.innerHTML = '<p style="font-size:0.875rem;color:#888">No filters available for this event type.</p>';
        return;
    }

    container.innerHTML = fields.map(function(fd) {
        const val = currentFilters && currentFilters[fd.name] !== undefined ? currentFilters[fd.name] : '';
        let inputHtml = '';

        if (fd.type === 'enum_list') {
            const selectedVals = Array.isArray(val) ? val : (val ? parseCSV(String(val)) : []);
            inputHtml = '<div class="checkbox-group">' +
                fd.values.map(function(v) {
                    const checked = selectedVals.indexOf(v) >= 0 ? ' checked' : '';
                    return '<label class="checkbox-item"><input type="checkbox" class="filter-enum" data-field="' + fd.name + '" value="' + escHtml(v) + '"' + checked + '> ' + escHtml(v) + '</label>';
                }).join('') +
            '</div>';
        } else if (fd.type === 'bool') {
            const boolVal = val === true || val === 'true' ? 'true' : (val === false || val === 'false' ? 'false' : '');
            inputHtml = '<select class="filter-input" data-field="' + fd.name + '" data-type="' + fd.type + '">' +
                '<option value=""' + (boolVal === '' ? ' selected' : '') + '>-- not set --</option>' +
                '<option value="true"' + (boolVal === 'true' ? ' selected' : '') + '>true</option>' +
                '<option value="false"' + (boolVal === 'false' ? ' selected' : '') + '>false</option>' +
            '</select>';
        } else if (fd.type === 'bool_optional') {
            const boolVal = val === true || val === 'true' ? 'true' : (val === false || val === 'false' ? 'false' : '');
            inputHtml = '<select class="filter-input" data-field="' + fd.name + '" data-type="' + fd.type + '">' +
                '<option value=""' + (boolVal === '' ? ' selected' : '') + '>-- any --</option>' +
                '<option value="true"' + (boolVal === 'true' ? ' selected' : '') + '>true (moving)</option>' +
                '<option value="false"' + (boolVal === 'false' ? ' selected' : '') + '>false (stopped)</option>' +
            '</select>';
        } else {
            const displayVal = Array.isArray(val) ? val.join(', ') : (val !== null && val !== undefined ? String(val) : '');
            const placeholder = fd.hint || '';
            inputHtml = '<input type="text" class="filter-input" data-field="' + fd.name + '" data-type="' + fd.type + '" value="' + escHtml(displayVal) + '" placeholder="' + escHtml(placeholder) + '">';
        }

        return '<div class="filter-field-row">' +
            '<div>' +
                '<div class="filter-field-label">' + escHtml(fd.label) + '</div>' +
                (fd.hint ? '<div class="filter-field-hint">' + escHtml(fd.hint) + '</div>' : '') +
            '</div>' +
            '<div>' + inputHtml + '</div>' +
        '</div>';
    }).join('');
}

function readFilterFields(eventType) {
    const fields = FILTER_FIELDS[eventType] || [];
    const out = {};
    const container = el('filterFields');
    if (!container) return out;

    fields.forEach(function(fd) {
        if (fd.type === 'enum_list') {
            const checked = [];
            container.querySelectorAll('.filter-enum[data-field="' + fd.name + '"]:checked').forEach(function(cb) {
                checked.push(cb.value);
            });
            if (checked.length > 0) out[fd.name] = checked;
        } else {
            const input = container.querySelector('.filter-input[data-field="' + fd.name + '"]');
            if (!input) return;
            const raw = input.value.trim();
            if (!raw) return;
            if (fd.type === 'string_list') {
                const arr = parseCSV(raw);
                if (arr.length > 0) out[fd.name] = arr;
            } else if (fd.type === 'int_list') {
                const arr = parseIntCSV(raw);
                if (arr.length > 0) out[fd.name] = arr;
            } else if (fd.type === 'int') {
                const n = parseInt(raw, 10);
                if (!isNaN(n)) out[fd.name] = n;
            } else if (fd.type === 'float') {
                const n = parseFloat(raw);
                if (!isNaN(n)) out[fd.name] = n;
            } else if (fd.type === 'bool' || fd.type === 'bool_optional') {
                if (raw === 'true') out[fd.name] = true;
                else if (raw === 'false') out[fd.name] = false;
            }
        }
    });
    return out;
}

function initRules() {
    el('btnAddRule').addEventListener('click', function() { showRuleForm(null); });
    el('btnSaveRules').addEventListener('click', async function() {
        await saveConfig(el('rulesAlerts'));
    });
}

// =============================================================================
// INIT
// =============================================================================

async function init() {
    initTabs();
    initOverview();
    initChannels();
    initRules();

    // Auth check + initial data load
    try {
        await loadHealth();
        await loadConfig();
    } catch (err) {
        if (err.message !== 'Redirecting to login') {
            showAlert(el('globalAlerts'), 'error', 'Initialisation error: ' + err.message, false);
        }
    }
}

document.addEventListener('DOMContentLoaded', init);
