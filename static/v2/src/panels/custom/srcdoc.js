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

// The colours a panel inherits. Read off the live document rather than
// hardcoded, so a panel follows the operator's theme — including one they
// changed while it was open, which remounts the frame with the new values.
const THEME_VARS = [
    '--bg', '--bg-raised', '--bg-sunken', '--fg', '--fg-dim', '--fg-faint',
    '--line', '--accent', '--accent-fg', '--ok', '--warn', '--bad',
    '--font', '--font-mono',
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
html,body{margin:0;padding:0}
body{
  background:transparent;color:var(--fg,#e8eaed);
  font-family:var(--font,system-ui,sans-serif);font-size:13px;line-height:1.45;
  -webkit-text-size-adjust:100%;
}
a{color:var(--accent,#7aa2f7)}
button,input,select,textarea{font:inherit;color:inherit}
button{
  background:var(--bg-raised,#232a35);color:inherit;
  border:1px solid var(--line,#39414f);border-radius:6px;
  padding:4px 10px;cursor:pointer;
}
button:hover{border-color:var(--accent,#7aa2f7)}
input,select,textarea{
  background:var(--bg-sunken,#161a21);border:1px solid var(--line,#39414f);
  border-radius:6px;padding:4px 8px;
}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:2px 6px;border-bottom:1px solid var(--line,#39414f)}
code,pre{font-family:var(--font-mono,ui-monospace,monospace)}
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
