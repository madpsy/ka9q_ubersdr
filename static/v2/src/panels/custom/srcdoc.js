// The document a panel actually runs in.
//
// What the author publishes is not what executes. The parent assembles the page
// around it: a base stylesheet so a panel looks like the rest of the interface
// without copying colours, the theme's own custom properties so it follows the
// operator's palette, the runtime that provides `ubersdr`, and only then the
// bundle's own markup and script.
//
// The frame is `sandbox="allow-scripts"` — no `allow-same-origin` — so this
// document has an opaque origin. It cannot read the parent's DOM, its storage or
// its cookies, and everything it does reaches the receiver over one port. See
// CUSTOM_PANELS.md §6 for what that is and is not buying.

// What a panel inherits from the page. Read off the live document rather than
// hardcoded, so a panel follows the operator's theme — including one they
// change while it is open, which is pushed to the frame (see hosts.js).
//
// `color-scheme` is first and is not a colour: it is the one that decides
// whether a panel has a white slab behind it.
//
// A frame is a document of its own and inherits no CSS, so without declaring a
// scheme it defaults to `light` — and the *canvas* of a light document is
// painted white by the browser. `background: transparent` on the body cannot
// help, because the canvas underneath is what is being painted. The result was
// every custom panel sitting on a white rectangle in a dark receiver, however
// carefully its author had used the theme variables.
const THEME_VARS = [
    'color-scheme',

    // Surfaces and text. These are the interface's own names — taken from the
    // `:root` block in styles.css, not invented here. An earlier version of this
    // list guessed at `--fg`, `--bg-raised` and `--line`; none of them exist, so
    // every one resolved to nothing and panels silently fell back to whatever
    // their author had hardcoded. That looked right on the dark theme and put
    // near-white text on a light surface. test/panelhost pins this list against
    // styles.css so it cannot drift again.
    '--bg', '--surface', '--surface-2', '--surface-3', '--surface-hover',
    '--text', '--text-dim', '--text-faint',
    '--border', '--border-strong',

    // Accent and state.
    '--accent', '--accent-ink', '--accent-soft', '--accent-line',
    '--good', '--warn', '--bad',

    // Type and shape, so a panel's corners and fonts match the dock it is in.
    '--font', '--mono', '--radius', '--radius-sm', '--radius-lg',

    // The operator's per-panel zoom. Custom properties do not cross into a
    // frame, so without carrying it explicitly a custom panel would be the one
    // panel in the dock that ignored the zoom buttons in its own header.
    '--ui-scale',
];

/** The theme, as declarations to put on the frame's own :root. */
export function themeDeclarations(el) {
    if (typeof getComputedStyle !== 'function') return '';
    let style;
    try {
        style = getComputedStyle(el || document.documentElement);
    } catch (e) {
        return '';
    }
    const out = [];
    for (const name of THEME_VARS) {
        const value = style.getPropertyValue(name);
        if (value && value.trim()) out.push(name + ':' + value.trim() + ';');
    }
    return out.join('');
}

// Deliberately small. A panel is a panel, not a page: it gets the interface's
// colours, its type and sane defaults for the elements everybody uses, and
// anything beyond that is the author's own stylesheet. A large framework here
// would be one every panel had to work around.
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
/* Both, explicitly: the root's background is what propagates to the canvas, so
   leaving it unset is what lets the UA paint one. With the scheme declared
   above, transparent here means the dock's own surface shows through. */
html,body{margin:0;padding:0;background:transparent}
body{
  background:transparent;color:var(--text,#e8eaed);
  font-family:var(--font,system-ui,sans-serif);
  /* Scaled by the operator's zoom for this panel, so anything sized in em or
     rem follows it. A panel using px throughout opts itself out. */
  font-size:calc(13px * var(--ui-scale, 1));
  line-height:1.45;
  -webkit-text-size-adjust:100%;
}
a{color:var(--accent,#7aa2f7)}
button,input,select,textarea{font:inherit;color:inherit}
button{
  background:var(--surface-2,#232a35);color:inherit;
  border:1px solid var(--border,#39414f);border-radius:var(--radius-sm,6px);
  padding:4px 10px;cursor:pointer;
}
button:hover{border-color:var(--accent,#7aa2f7)}
input,select,textarea{
  background:var(--surface-3,#161a21);border:1px solid var(--border,#39414f);
  border-radius:var(--radius-sm,6px);padding:4px 8px;
}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:2px 6px;border-bottom:1px solid var(--border,#39414f)}
code,pre{font-family:var(--mono,ui-monospace,monospace)}
img,svg,canvas,video{max-width:100%}
/* Wide content scrolls inside itself. A panel lives in a dock column that may be
   220px across, and a table that widens its own frame widens the panel. */
pre,table{overflow-x:auto;display:block}
`;

/**
 * Assemble the document for one panel.
 *
 * `runtime` is the built panel runtime as source text — inlined rather than
 * linked, so the frame needs no network of its own and cannot be handed a
 * different version of its own API than the page it is talking to.
 */
export function buildSrcdoc({ runtime, body, theme, minimal }) {
    return '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<style>:root{' + (theme || '') + '}' + BASE_CSS + '</style>'
        + '<script>window.__ubersdrPanel=' + JSON.stringify({ minimal: !!minimal }) + ';<\/script>'
        + '<script>' + runtime + '<\/script>'
        + '</head><body>' + (body || '') + '</body></html>';
}
