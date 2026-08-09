'use strict';

// Chooser page logic. Everything talks to the main process through the
// window.ubersdr surface exposed by preload.js; the DOM is built with
// createElement throughout so instance-supplied strings are never markup.

const api = window.ubersdr;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

let builtinAvailable = false;

// ---- row rendering ---------------------------------------------------------

// Primary/secondary line format follows the TUI picker: "CALLSIGN · Name",
// then "Location · host · n/m free · SNR · vX".
function describe(row) {
    let primary = row.label || row.name || `${row.host}:${row.port}`;
    if (row.callsign && !primary.toUpperCase().includes(row.callsign.toUpperCase())) {
        primary = `${row.callsign} · ${primary}`;
    }
    const parts = [];
    if (row.location) parts.push(row.location);
    parts.push(`${row.tls ? 'https' : 'http'}://${row.host}:${row.port}`);
    if (row.availableClients >= 0 && row.maxClients > 0) {
        parts.push(`${row.availableClients}/${row.maxClients} free`);
    }
    if (row.snr > 0) parts.push(`SNR ${row.snr} dB`);
    if (row.version) parts.push(`v${row.version}`);
    return { primary, secondary: parts.join(' · ') };
}

function makeRow(row, actions) {
    const div = el('div', 'row');
    const info = el('div', 'info');
    const { primary, secondary } = describe(row);
    const primaryEl = el('div', 'primary', primary);
    if (row.running) primaryEl.appendChild(el('span', 'live', '● connected'));
    info.appendChild(primaryEl);
    info.appendChild(el('div', 'secondary', secondary));
    div.appendChild(info);
    const actionBox = el('div', 'actions');
    for (const action of actions) actionBox.appendChild(action);
    div.appendChild(actionBox);
    return div;
}

function connectButton(desc, statusEl) {
    const btn = el('button', null, desc.running ? 'Show' : 'Connect');
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await api.connect(desc);
        btn.disabled = false;
        if (!res.ok) showStatus(statusEl, res.error, true);
        else refreshSaved();
    });
    return btn;
}

function showStatus(node, text, isError) {
    if (!node) return;
    node.textContent = text || '';
    if (node.classList.contains('status')) {
        node.hidden = !text;
        node.classList.toggle('error', !!isError);
    }
}

// ---- saved receivers -------------------------------------------------------

async function refreshSaved() {
    const list = document.getElementById('saved-list');
    const empty = document.getElementById('saved-empty');
    const entries = await api.saved();
    entries.sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''));
    list.replaceChildren();
    empty.hidden = entries.length > 0;

    for (const entry of entries) {
        const uiSelect = el('select');
        for (const [value, label] of [['builtin', 'built-in UI'], ['remote', "instance's UI"]]) {
            const opt = el('option', null, label);
            opt.value = value;
            uiSelect.appendChild(opt);
        }
        uiSelect.value = entry.ui === 'remote' || !builtinAvailable ? 'remote' : 'builtin';
        uiSelect.disabled = !builtinAvailable;
        uiSelect.title = builtinAvailable
            ? 'Which frontend to run: the bundle shipped with this app, or the one the instance serves'
            : 'No bundled UI staged — run build.sh to enable the built-in option';
        uiSelect.addEventListener('change', () => api.update(entry.id, { ui: uiSelect.value }));

        const remove = el('button', 'danger', 'Remove');
        remove.addEventListener('click', async () => {
            await api.remove(entry.id);
            refreshSaved();
        });

        const status = document.getElementById('add-status');
        document.getElementById('saved-list').appendChild(
            makeRow(entry, [uiSelect, connectButton({ id: entry.id, running: entry.running }, status), remove]),
        );
    }
}

// ---- LAN discovery ---------------------------------------------------------

async function scanLan() {
    const btn = document.getElementById('lan-scan');
    const status = document.getElementById('lan-status');
    const list = document.getElementById('lan-list');
    btn.disabled = true;
    status.textContent = 'scanning…';
    try {
        const rows = await api.lan();
        list.replaceChildren();
        for (const row of rows) {
            list.appendChild(makeRow(row, [connectButton(row, document.getElementById('add-status'))]));
        }
        status.textContent = rows.length
            ? `${rows.length} found`
            : 'none found (instances advertise via mDNS — see install-ubersdr-mdns.sh)';
    } catch (err) {
        status.textContent = `scan failed: ${err.message}`;
    }
    btn.disabled = false;
}

// ---- public directory ------------------------------------------------------

let directoryRows = [];

function renderDirectory() {
    const filter = document.getElementById('dir-filter').value.trim().toLowerCase();
    const list = document.getElementById('dir-list');
    const status = document.getElementById('dir-status');
    const rows = directoryRows.filter((row) => {
        if (!filter) return true;
        return [row.name, row.callsign, row.location, row.host]
            .some((field) => field && field.toLowerCase().includes(filter));
    });
    list.replaceChildren();
    for (const row of rows) {
        list.appendChild(makeRow(row, [connectButton(row, document.getElementById('add-status'))]));
    }
    status.textContent = `${rows.length}${filter ? ` of ${directoryRows.length}` : ''} receivers`;
}

async function loadDirectory() {
    const status = document.getElementById('dir-status');
    status.textContent = 'loading…';
    try {
        directoryRows = await api.directory();
        renderDirectory();
    } catch (err) {
        status.textContent = `directory unavailable: ${err.message}`;
    }
}

// ---- manual add ------------------------------------------------------------

async function addManual() {
    const input = document.getElementById('add-input');
    const btn = document.getElementById('add-btn');
    const status = document.getElementById('add-status');
    const text = input.value.trim();
    if (!text) return;

    btn.disabled = true;
    showStatus(status, `probing ${text}…`);
    const res = await api.resolve(text);
    if (res.ok) {
        const connected = await api.connect(res.row);
        showStatus(status, connected.ok ? '' : connected.error, !connected.ok);
        if (connected.ok) input.value = '';
        refreshSaved();
    } else if (res.certError) {
        // Self-signed (or otherwise untrusted) certificate: make accepting it
        // an explicit click, scoped to this one receiver.
        showStatus(status, `${res.error} — `, true);
        const trust = el('button', null, 'Trust this receiver anyway');
        trust.addEventListener('click', async () => {
            trust.disabled = true;
            const retry = await api.resolve(text, { insecureTLS: true });
            if (!retry.ok) return showStatus(status, retry.error, true);
            const connected = await api.connect({ ...retry.row, insecureTLS: true });
            showStatus(status, connected.ok ? '' : connected.error, !connected.ok);
            if (connected.ok) input.value = '';
            refreshSaved();
        });
        status.appendChild(trust);
    } else {
        showStatus(status, res.error, true);
    }
    btn.disabled = false;
}

// ---- startup ---------------------------------------------------------------

document.getElementById('add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    addManual();
});
document.getElementById('lan-scan').addEventListener('click', scanLan);
document.getElementById('shared-prefs-box').addEventListener('change', async (event) => {
    // The main process answers with what it actually set, so the box can never
    // show a state the store doesn't hold.
    event.target.checked = await api.setSharedPrefs(event.target.checked);
});
document.getElementById('dir-refresh').addEventListener('click', loadDirectory);
document.getElementById('dir-filter').addEventListener('input', renderDirectory);
api.onChanged(refreshSaved);

(async () => {
    const info = await api.appInfo();
    builtinAvailable = info.builtinAvailable;
    document.getElementById('shared-prefs-box').checked = await api.sharedPrefs();
    document.getElementById('footer').textContent = builtinAvailable
        ? `bundled v2 UI: ${info.buildInfo || 'staged'} · electron ${info.electron}`
        : 'no bundled UI staged (run build.sh) — receivers open with the UI they serve · electron ' + info.electron;
    refreshSaved();
    scanLan();
    loadDirectory();
})();
