'use strict';

// The serial picker page. Built with createElement throughout, like the
// chooser: these strings come off the device layer and are never markup.
//
// Selecting and connecting are two steps. They used to be one — a click on a
// row handed that port straight to the page — which is a lot of consequence to
// hang on a single click in a list that redraws itself whenever anybody plugs
// anything in anywhere on the machine. Now a click arms a row, Connect commits
// it, and a device appearing mid-decision cannot move what is armed.
//
// The filter box above the list searches everything a row shows, and arming
// follows it: type enough to leave one match and Enter connects that match.

const api = window.serialPicker;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const listEl = document.getElementById('port-list');
const filterEl = document.getElementById('filter');
const emptyEl = document.getElementById('port-empty');
const emptyTitleEl = document.getElementById('empty-title');
const emptyBodyEl = document.getElementById('empty-body');
const connectEl = document.getElementById('connect');
const cancelEl = document.getElementById('cancel');
const subtitleEl = document.getElementById('subtitle');
const hintEl = document.getElementById('hint');

// Everything attached, and the subset the filter box currently lets through.
// Selection and the arrow keys work off `shown`, never off `ports`: an armed
// row somebody cannot see is one they cannot check before pressing Connect.
let ports = [];
let shown = [];
let tokens = [];
let selectedId = null;
// Whether anything has ever been armed. Until it has, the first port is armed
// for you, so the keyboard works the moment the window opens. After it has, a
// *device change* that takes the armed port away leaves nothing armed rather
// than sliding the selection onto a neighbour — the device somebody chose was
// just unplugged, and quietly arming a different one is how the wrong radio
// gets opened. Filtering is the other case, and render() explains why it does
// the opposite.
let everSelected = false;
let origin = '';

// What to call a port, and what to say underneath it.
//
// Chromium fills these in as far as the platform lets it: `displayName` comes
// from the device's USB descriptor and is the one a human recognises
// ("FlexControl"), `portName` is the path it was given this time round
// (/dev/ttyUSB0, COM3). Neither is guaranteed, and the pair is worth showing
// together — the name says which device, the path says which of two identical
// ones. The IDs are the fallback identity when the descriptor says nothing,
// which on a generic USB-serial bridge is the usual case.
function label(port) {
    return port.displayName || port.portName || `Port ${port.portId}`;
}

// The second line, as separate strings so they can be joined with a dimmed
// separator rather than one baked into the text. All three are identifiers and
// all three are set in the mono face by the caller.
function detail(port) {
    const parts = [];
    if (port.portName && port.portName !== label(port)) parts.push(port.portName);
    if (port.vendorId && port.productId) parts.push(`USB ${port.vendorId}:${port.productId}`);
    if (port.serialNumber) parts.push(`s/n ${port.serialNumber}`);
    return parts;
}

// Every string a row shows, which is exactly what the filter box searches:
// typing what you can see should find it, and nothing you cannot see should
// make a row match.
function haystack(port) {
    return [
        label(port),
        port.portName,
        port.vendorId && port.productId ? `USB ${port.vendorId}:${port.productId}` : '',
        port.serialNumber ? `s/n ${port.serialNumber}` : '',
    ].join(' ').toLowerCase();
}

// Whitespace-separated, and every token has to match somewhere — so "flex usb0"
// narrows to the FlexControl on ttyUSB0 rather than widening to both.
function parseQuery(text) {
    return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(port) {
    const hay = haystack(port);
    return tokens.every((t) => hay.includes(t));
}

// Appends `text` to `parent`, wrapping in <mark> whatever the query matched, so
// it is obvious why a row survived the filter. Character flags rather than a
// split-and-join because tokens can overlap ("usb", "sb0") and overlapping
// marks would otherwise nest.
function appendMatched(parent, text) {
    if (tokens.length === 0) {
        parent.appendChild(document.createTextNode(text));
        return;
    }
    const lower = text.toLowerCase();
    const hit = new Array(text.length).fill(false);
    for (const token of tokens) {
        for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + 1)) {
            for (let i = at; i < at + token.length; i += 1) hit[i] = true;
        }
    }
    for (let i = 0; i < text.length;) {
        let j = i;
        while (j < text.length && hit[j] === hit[i]) j += 1;
        const chunk = text.slice(i, j);
        parent.appendChild(hit[i] ? el('mark', null, chunk) : document.createTextNode(chunk));
        i = j;
    }
}

// Alphabetical by what the row says, then by path. The list arrives in
// whatever order the device layer last touched it, and a list that reorders
// itself under the pointer is one somebody misclicks.
function ordered(list) {
    return [...list].sort((a, b) => (
        label(a).localeCompare(label(b)) || a.portName.localeCompare(b.portName)
    ));
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function selectedPort() {
    return shown.find((p) => p.portId === selectedId) || null;
}

function setSelected(portId, { scroll = false } = {}) {
    selectedId = portId;
    if (portId) everSelected = true;

    let active = '';
    for (const row of listEl.children) {
        const on = row.dataset.portId === portId;
        row.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
            active = row.id;
            if (scroll) row.scrollIntoView({ block: 'nearest' });
        }
    }
    // The rows are not focusable; the listbox is, and this is what tells a
    // screen reader which row the focused listbox is currently on.
    listEl.setAttribute('aria-activedescendant', active);
    connectEl.disabled = !active;
}

function connect() {
    const port = selectedPort();
    if (port) api.choose(port.portId);
}

/**
 * Redraw the list.
 *
 * `reason` decides what happens to the armed row when it is no longer in the
 * list, and the two cases genuinely differ. 'query' is somebody narrowing the
 * list on purpose, so the top match is armed and Enter connects it — type
 * "flex", press Enter, done. 'ports' is a device having been unplugged, where
 * arming its neighbour instead is how the wrong radio gets opened.
 */
function render(list, reason) {
    if (list) ports = ordered(list);
    shown = ports.filter(matches);

    listEl.replaceChildren();
    for (const [index, port] of shown.entries()) {
        const row = el('div', 'port');
        row.id = `port-option-${index}`;
        row.dataset.portId = port.portId;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');

        row.appendChild(el('span', 'dot'));
        const info = el('div', 'info');
        const name = el('div', 'name');
        appendMatched(name, label(port));
        info.appendChild(name);
        const parts = detail(port);
        if (parts.length) {
            const meta = el('div', 'meta');
            for (const [i, part] of parts.entries()) {
                if (i) meta.appendChild(el('span', 'sep', '·'));
                const ident = el('span', 'ident');
                appendMatched(ident, part);
                meta.appendChild(ident);
            }
            info.appendChild(meta);
        }
        row.appendChild(info);

        row.addEventListener('click', () => setSelected(port.portId));
        // The shortcut for people who already know which one it is. The click
        // handler has armed the row by the time this runs, so it only ever
        // connects to what the pointer is on.
        row.addEventListener('dblclick', connect);
        listEl.appendChild(row);
    }

    emptyEl.hidden = shown.length > 0;
    listEl.hidden = shown.length === 0;
    if (emptyEl.hidden === false) {
        // Saying "no ports found" while a filter is hiding six of them is how a
        // picker gets called broken.
        const filtering = tokens.length > 0;
        emptyTitleEl.textContent = filtering ? 'No matching ports' : 'No serial ports found';
        emptyBodyEl.textContent = filtering
            ? `Nothing here matches that. ${plural(ports.length, 'device')} attached.`
            : 'Plug the device in — this list updates on its own.';
    }

    const stillThere = shown.some((p) => p.portId === selectedId);
    const first = shown.length ? shown[0].portId : null;
    let next;
    if (stillThere) next = selectedId;
    else if (reason === 'query') next = first;          // narrowing on purpose
    else next = everSelected ? null : first;            // see everSelected
    setSelected(next);

    const count = tokens.length > 0
        ? `${shown.length} of ${plural(ports.length, 'device')}`
        : `${plural(ports.length, 'device')} found`;
    subtitleEl.textContent = origin ? `${origin} wants to connect · ${count}` : count;
    // What Escape does depends on whether there is a query to clear, so the
    // hint has to say which one it will do right now.
    const escape = tokens.length > 0 ? 'Esc to clear the filter' : 'Esc to cancel';
    hintEl.textContent = shown.length
        ? `Arrow keys to choose · Enter to connect · ${escape}`
        : escape;
}

function moveSelection(delta) {
    if (shown.length === 0) return;
    const at = shown.findIndex((p) => p.portId === selectedId);
    // No selection yet: down goes to the top of the list, up to the bottom.
    const next = at === -1
        ? (delta > 0 ? 0 : shown.length - 1)
        : (at + delta + shown.length) % shown.length;
    setSelected(shown[next].portId, { scroll: true });
}

// Shared by the list and the filter box, so the arrow keys and Enter keep
// working while somebody is still typing — having to leave the box to pick
// what you just narrowed the list down to is the thing that makes a filter
// annoying rather than useful.
function navigationKey(event) {
    const moves = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key in moves) {
        event.preventDefault();
        moveSelection(moves[event.key]);
        return true;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        connect();
        return true;
    }
    return false;
}

listEl.addEventListener('keydown', (event) => {
    if (navigationKey(event)) return;
    // Only on the list: in the filter box these two belong to the caret.
    if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (shown.length) {
            const port = event.key === 'Home' ? shown[0] : shown[shown.length - 1];
            setSelected(port.portId, { scroll: true });
        }
    }
});

filterEl.addEventListener('keydown', navigationKey);
filterEl.addEventListener('input', () => {
    tokens = parseQuery(filterEl.value);
    render(null, 'query');
});

// Escape belongs to the window rather than to any one control, and Enter is
// handled here too so it works while the list has never been touched — with
// focus sitting on the body, nothing else would see it.
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        // A typed filter is what Escape clears first. Closing the window
        // instead refuses the page's request outright, and getting the picker
        // back means going round the whole connect flow again — too much to
        // spend on the key everyone presses to undo their typing.
        if (tokens.length > 0 || filterEl.value !== '') {
            filterEl.value = '';
            tokens = [];
            render(null, 'query');
            filterEl.focus();
            return;
        }
        api.choose('');
    } else if (event.key === 'Enter' && event.target === document.body) {
        event.preventDefault();
        connect();
    }
});

connectEl.addEventListener('click', connect);
cancelEl.addEventListener('click', () => api.choose(''));

// Device arrivals and departures while the window is open. Only the list
// changes; the origin cannot.
api.onPorts((list) => render(list, 'ports'));

(async () => {
    const info = await api.info();
    origin = info.origin || '';
    render(info.ports, 'init');
    // The filter box takes focus: typing narrows the list straight away, and
    // the arrow keys and Enter work from in there too, so this costs the
    // keyboard nothing and saves a click for anyone with a long list.
    filterEl.focus();
})();
