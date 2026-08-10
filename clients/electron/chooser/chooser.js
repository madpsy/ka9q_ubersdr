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
let sortBy = 'used';

// How the saved list is ordered.
//
// By use, because the question this page answers is "where do I listen", and
// the answer is a receiver somebody keeps coming back to rather than whichever
// one they happened to open last — one evening spent trying receivers from the
// directory would otherwise bury a daily driver under a dozen one-offs.
//
// Recency is the tie-break, not the rule: it is what separates entries that are
// level (including every entry saved before counting existed, which start at
// zero together), and it keeps the order stable rather than arbitrary. Somebody
// who does want the old behaviour has the picker beside the heading.
const SORTS = {
    used: (a, b) => (b.useCount || 0) - (a.useCount || 0)
        || (b.lastUsed || '').localeCompare(a.lastUsed || ''),
    recent: (a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''),
};

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
    // Saved receivers only; LAN and directory rows have no count to show.
    // Silent at zero rather than reading "0 visits", which would be a claim
    // about a receiver saved before counting existed — those have been visited
    // an unknown number of times, not none.
    if (row.useCount > 0) parts.push(`${row.useCount} ${row.useCount === 1 ? 'visit' : 'visits'}`);
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

// ---- the password key ------------------------------------------------------
//
// Optional, and rarely wanted: most receivers ask for nothing, so this is an
// icon rather than a field on every row — a box marked "password" beside two
// hundred directory entries would suggest they all need one. The icon lights up
// where a password is set, which is the one thing worth seeing at a glance.
//
// What it holds is v2's bypass password (see static/v2/src/radio/session.js).
// In a browser it is typed into the start overlay and forgotten when the tab
// closes; the desktop client's saved list exists so that things are not typed
// twice, so here it is kept — in the OS keychain where the platform has one.

const SVG_NS = 'http://www.w3.org/2000/svg';

function keyIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const bow = document.createElementNS(SVG_NS, 'circle');
    bow.setAttribute('cx', '8');
    bow.setAttribute('cy', '15.5');
    bow.setAttribute('r', '4');
    const blade = document.createElementNS(SVG_NS, 'path');
    blade.setAttribute('d', 'M10.9 12.6 20.5 3M18 5.5l2.5 2.5M15 8.5l2 2');
    svg.appendChild(bow);
    svg.appendChild(blade);
    return svg;
}

// One modal at a time, and Escape closes it — a dialog that can be stacked or
// stranded is a dialog somebody has to close by quitting the app.
let openModal = null;

function closeModal() {
    if (!openModal) return;
    openModal.remove();
    openModal = null;
}

/**
 * @param {object} row     the receiver — a saved entry, or a LAN/directory row
 * @param {function} done  called with the new hasPassword once it is settled
 */
function askPassword(row, done) {
    closeModal();
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal');
    const { primary } = describe(row);

    modal.appendChild(el('h3', null, 'Password'));
    modal.appendChild(el('p', 'modal-target', primary));
    modal.appendChild(el('p', null,
        'Optional. A bypass password given to you by this receiver’s operator — it '
        + 'is sent to this receiver only, and is used automatically every time you connect.'));

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = row.hasPassword ? 'Saved — type to replace' : 'Password';
    input.autocomplete = 'off';
    modal.appendChild(input);

    const note = el('div', 'modal-note');
    note.hidden = true;
    modal.appendChild(note);

    const actions = el('div', 'modal-actions');
    const clear = el('button', 'danger', 'Clear');
    // Nothing to clear on a receiver that has none: a button that cannot do
    // anything is one somebody clicks to find out.
    clear.disabled = !row.hasPassword;
    const cancel = el('button', 'ghost', 'Cancel');
    const save = el('button', null, 'Save');

    const settle = async (password) => {
        save.disabled = true;
        clear.disabled = true;
        const res = await api.setPassword({
            id: row.id, host: row.host, port: row.port, tls: row.tls,
        }, password);
        if (!res.saved) {
            // Not a saved receiver yet — one from the scan or the directory.
            // It travels with the connect that creates the entry.
            row.password = password;
        }
        row.hasPassword = !!password;
        closeModal();
        if (done) done(row.hasPassword);
    };

    save.addEventListener('click', () => {
        const value = input.value.trim();
        if (!value) {
            note.textContent = 'Enter a password, or use Clear to remove the one saved.';
            note.hidden = false;
            input.focus();
            return;
        }
        settle(value);
    });
    clear.addEventListener('click', () => settle(''));
    cancel.addEventListener('click', closeModal);

    actions.appendChild(clear);
    actions.appendChild(el('span', 'modal-spacer'));
    actions.appendChild(cancel);
    actions.appendChild(save);
    modal.appendChild(actions);

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); save.click(); }
    });
    backdrop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    });
    // A click on the page behind it, not one that started inside and ended out.
    backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) closeModal();
    });

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    openModal = backdrop;
    input.focus();
}

function keyButton(row, done) {
    const btn = el('button', 'ghost key-btn');
    // Explicit, because this one sits inside the address form, and a button in a
    // form with no type is a submit button — clicking the key would connect.
    btn.type = 'button';
    btn.appendChild(keyIcon());
    const label = () => {
        btn.classList.toggle('set', !!row.hasPassword);
        btn.title = row.hasPassword
            ? 'A password is saved for this receiver — click to change or clear it'
            : 'Set a password for this receiver (optional)';
        btn.setAttribute('aria-label', btn.title);
    };
    label();
    btn.addEventListener('click', () => askPassword(row, () => {
        label();
        if (done) done();
    }));
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
    entries.sort(SORTS[sortBy] || SORTS.used);
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
            makeRow(entry, [
                keyButton(entry),
                uiSelect,
                connectButton({ id: entry.id, running: entry.running }, status),
                remove,
            ]),
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
            list.appendChild(makeRow(row, [
                keyButton(row),
                connectButton(row, document.getElementById('add-status')),
            ]));
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
        list.appendChild(makeRow(row, [
            keyButton(row),
            connectButton(row, document.getElementById('add-status')),
        ]));
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

// A password for a receiver that does not exist yet: typed against the address
// in the box, carried into the connect that saves it. Kept here rather than
// asked for afterwards because a receiver that wants a password wants it on the
// first connection, and being bounced to the start overlay to find that out is
// the long way round.
//
// Its label is read rather than stored: the dialog names the receiver it is for,
// and for this one that is whatever is in the address box at the moment the key
// is used — by mouse or by keyboard, which is why it is not copied on a click.
const manualPending = {};
Object.defineProperty(manualPending, 'label', {
    get: () => document.getElementById('add-input').value.trim() || 'New receiver',
});

async function addManual() {
    const input = document.getElementById('add-input');
    const btn = document.getElementById('add-btn');
    const status = document.getElementById('add-status');
    const text = input.value.trim();
    if (!text) return;
    const password = manualPending.password || undefined;

    const done = (connected) => {
        showStatus(status, connected.ok ? '' : connected.error, !connected.ok);
        if (connected.ok) {
            input.value = '';
            delete manualPending.password;
            manualPending.hasPassword = false;
        }
        refreshSaved();
    };

    btn.disabled = true;
    showStatus(status, `probing ${text}…`);
    const res = await api.resolve(text);
    if (res.ok) {
        done(await api.connect({ ...res.row, password }));
    } else if (res.certError) {
        // Self-signed (or otherwise untrusted) certificate: make accepting it
        // an explicit click, scoped to this one receiver.
        showStatus(status, `${res.error} — `, true);
        const trust = el('button', null, 'Trust this receiver anyway');
        trust.addEventListener('click', async () => {
            trust.disabled = true;
            const retry = await api.resolve(text, { insecureTLS: true });
            if (!retry.ok) return showStatus(status, retry.error, true);
            done(await api.connect({ ...retry.row, insecureTLS: true, password }));
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
document.getElementById('add-form').insertBefore(
    keyButton(manualPending), document.getElementById('add-btn'),
);
document.getElementById('lan-scan').addEventListener('click', scanLan);
document.getElementById('saved-sort').addEventListener('change', async (event) => {
    sortBy = await api.setSort(event.target.value);
    event.target.value = sortBy;
    refreshSaved();
});
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
    sortBy = await api.sort();
    document.getElementById('saved-sort').value = sortBy;
    document.getElementById('footer').textContent = builtinAvailable
        ? `bundled v2 UI: ${info.buildInfo || 'staged'} · electron ${info.electron}`
        : 'no bundled UI staged (run build.sh) — receivers open with the UI they serve · electron ' + info.electron;
    refreshSaved();
    scanLan();
    loadDirectory();
})();
