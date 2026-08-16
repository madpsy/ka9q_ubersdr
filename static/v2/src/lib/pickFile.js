// Asking for a file, from a panel that may not be there when it arrives.
//
// The obvious way — a hidden <input type="file"> in the panel's own markup and
// a ref to click it — has a failure that is invisible until somebody reports
// it: the input has to still be mounted when the dialog closes. React attaches
// its listeners at the root of the tree, so a change event on an element that
// has since been detached reaches nothing at all. No error, no handler, no
// picked file. The button appears to do nothing.
//
// Which is exactly what a desktop browser arranges. Opening the file dialog
// takes the pointer off the page, and a dock collapsed to a rail and *peeked*
// by hovering unmounts a third of a second later (Dock.jsx, PEEK_CLOSE_MS) —
// taking the panel and its input with it. On iOS there is no hover to peek at
// all, which is why the same code worked there and nowhere else.
//
// So the input belongs to nobody: created here, listened to directly rather
// than through React, and thrown away when it answers. A direct listener fires
// whether or not anything is still on screen, and the promise carries the file
// back to whatever asked — which is then free to have been unmounted, because
// what it does with it is its own business.

/**
 * Opens the browser's file picker and resolves with the chosen File, or null if
 * the operator backed out.
 *
 * `accept` is the HTML accept attribute — ".json,application/json" and the
 * like. Cancellation is the `cancel` event, which every current browser fires;
 * on one that does not, the promise simply never settles, which costs a hidden
 * element and no behaviour — the alternative, guessing from window focus, ends
 * a real pick as a cancellation whenever the change event is a moment late.
 */
export function pickFile({ accept = '', multiple = false } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        if (multiple) input.multiple = true;
        // Off-screen rather than display:none: a picker is opened by a click on
        // an element, and `display: none` is the one state some browsers have
        // refused that from.
        input.style.position = 'fixed';
        input.style.left = '-10000px';
        input.style.top = '0';

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(value);
        };

        input.addEventListener('change', () => {
            const files = input.files ? Array.from(input.files) : [];
            finish(multiple ? files : (files[0] || null));
        });
        input.addEventListener('cancel', () => finish(multiple ? [] : null));

        document.body.appendChild(input);
        input.click();
    });
}

/**
 * The text of a picked file.
 *
 * File.text() is what this wants and what every browser this UI supports has;
 * FileReader is behind it because the failure without one is silent — an async
 * handler calling a method that is not there throws into a promise nobody is
 * watching, and the panel sits there having apparently ignored the file.
 */
export function readText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
        reader.readAsText(file);
    });
}
