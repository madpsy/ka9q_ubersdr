'use strict';

// The serial picker page. Built with createElement throughout, like the
// chooser: these strings come off the device layer and are never markup.

const api = window.serialPicker;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

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

function detail(port) {
    const parts = [];
    if (port.portName && port.portName !== label(port)) parts.push(port.portName);
    if (port.vendorId && port.productId) parts.push(`USB ${port.vendorId}:${port.productId}`);
    if (port.serialNumber) parts.push(`s/n ${port.serialNumber}`);
    return parts.join(' · ');
}

function render(ports) {
    const list = document.getElementById('port-list');
    const empty = document.getElementById('port-empty');
    // Keep the focused port focused across a re-render — the list redraws
    // whenever any device is plugged in anywhere, and moving somebody's
    // selection because an unrelated dongle appeared is how a wrong port gets
    // picked.
    const focusedId = document.activeElement && document.activeElement.dataset
        ? document.activeElement.dataset.portId
        : null;

    list.replaceChildren();
    empty.hidden = ports.length > 0;

    for (const port of ports) {
        const btn = el('button', 'port');
        btn.type = 'button';
        btn.dataset.portId = port.portId;
        btn.setAttribute('role', 'option');
        btn.appendChild(el('div', 'name', label(port)));
        const meta = detail(port);
        if (meta) btn.appendChild(el('div', 'meta', meta));
        btn.addEventListener('click', () => api.choose(port.portId));
        list.appendChild(btn);
    }

    const restore = focusedId && list.querySelector(`[data-port-id="${CSS.escape(focusedId)}"]`);
    (restore || list.firstElementChild || document.getElementById('cancel')).focus();
}

// Up and down the list, wrapping. Buttons are focusable but the browser only
// moves between them with Tab, and a list somebody is choosing from should
// answer the arrow keys.
function moveFocus(delta) {
    const rows = [...document.querySelectorAll('.port')];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement);
    const next = at === -1 ? 0 : (at + delta + rows.length) % rows.length;
    rows[next].focus();
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        api.choose('');
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveFocus(1);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(-1);
    }
    // Enter needs no handling: the rows are buttons, and the focused one is
    // what Enter presses.
});

document.getElementById('cancel').addEventListener('click', () => api.choose(''));

api.onPorts(render);
(async () => {
    render(await api.ports());
})();
