// A React element tree, as SVG markup.
//
// For handing an icon to something that is not a browser page: the desktop
// client's native menus want a picture beside each panel name, and the icons
// are React elements (components/icons.jsx) that only mean anything once
// rendered.
//
// Rendering them for real is the obvious way and the wrong one. `flushSync`
// does not flush when it is called from inside an effect — React warns and
// defers — so the detached node is still empty on the next line, which is a
// bug that looks exactly like "the icons are missing". Walking the tree instead
// is synchronous by construction, needs no DOM, and can be tested without
// either.
//
// Deliberately small: it serialises what this icon set is made of — nested
// elements, string and number attributes, no text nodes, no dangerouslySetInnerHTML
// — and refuses to guess at anything else.

// SVG attributes that are genuinely camelCase, and React props whose DOM name
// differs. Everything else with a capital in it is hyphenated, which is the
// rule for the rest of SVG (strokeWidth → stroke-width).
const KEEP_CAMEL = new Set(['viewBox', 'preserveAspectRatio', 'baseProfile', 'gradientUnits']);
const RENAME = { className: 'class', htmlFor: 'for' };

function attrName(key) {
    if (RENAME[key]) return RENAME[key];
    if (KEEP_CAMEL.has(key)) return key;
    return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

const escapeAttr = (v) => String(v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * @param node  a React element, or an array of them
 * @returns SVG markup, or '' for anything it cannot serialise
 */
export function svgMarkup(node) {
    if (node === null || node === undefined || node === false || node === true) return '';
    if (Array.isArray(node)) return node.map(svgMarkup).join('');
    // Text would be a label, and this icon set has none. Numbers likewise.
    if (typeof node === 'string' || typeof node === 'number') return '';
    if (!node.props && !node.type) return '';

    const { type, props = {} } = node;

    // A component: call it and serialise what it returns. The icons are one
    // wrapper deep — `Icon.Radio` renders `<Svg>` — and this handles any depth.
    if (typeof type === 'function') {
        try {
            return svgMarkup(type(props));
        } catch (e) {
            return '';
        }
    }
    if (typeof type !== 'string') return '';   // Fragment, portal, something else

    const attrs = [];
    for (const [key, value] of Object.entries(props)) {
        if (key === 'children' || key === 'key' || key === 'ref') continue;
        if (value === null || value === undefined || value === false) continue;
        // A handler or a style object has no meaning in a standalone file, and
        // emitting `[object Object]` would produce markup that fails to parse.
        if (typeof value === 'function' || typeof value === 'object') continue;
        attrs.push(`${attrName(key)}="${escapeAttr(value === true ? '' : value)}"`);
    }

    const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
    const inner = svgMarkup(props.children);
    return inner ? `${open}>${inner}</${type}>` : `${open} />`;
}
