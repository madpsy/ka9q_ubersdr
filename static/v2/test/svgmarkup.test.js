// React icon elements, serialised to standalone SVG.
//
// The desktop client draws these into its native Layout menu, so what matters
// is that the markup parses on its own — outside a page, with no React and no
// stylesheet. A wrong attribute name produces an icon that silently fails to
// load, which is indistinguishable from having no icon at all.

const assert = require('assert');
const { svgMarkup } = require('./.build/svgmarkup.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// React elements are plain objects; no React needed to build one.
const h = (type, props = {}, ...children) => ({
    type, props: { ...props, children: children.length === 1 ? children[0] : (children.length ? children : undefined) },
});

t('an element becomes a self-closing tag with its attributes', () => {
    assert.strictEqual(svgMarkup(h('path', { d: 'M0 0' })), '<path d="M0 0" />');
});

t('camelCase props become the SVG spelling', () => {
    const out = svgMarkup(h('svg', { strokeWidth: 1.7, strokeLinecap: 'round', className: 'x' }));
    assert.match(out, /stroke-width="1.7"/);
    assert.match(out, /stroke-linecap="round"/);
    assert.match(out, /class="x"/);
});

t('viewBox keeps its capital, because SVG spells it that way', () => {
    // Hyphenated it would be ignored, and the icon would render at the wrong
    // scale or not at all.
    assert.match(svgMarkup(h('svg', { viewBox: '0 0 24 24' })), /viewBox="0 0 24 24"/);
});

t('a component is called and its output serialised', () => {
    const Wrapper = (p) => h('svg', { viewBox: '0 0 24 24' }, p.children);
    const Icon = () => h(Wrapper, {}, h('circle', { cx: 12, cy: 12, r: 2 }));
    assert.strictEqual(
        svgMarkup(h(Icon, {})),
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2" /></svg>',
    );
});

t('children nest, and several of them stay in order', () => {
    const out = svgMarkup(h('svg', {}, h('path', { d: 'a' }), h('path', { d: 'b' })));
    assert.strictEqual(out, '<svg><path d="a" /><path d="b" /></svg>');
});

t('handlers, styles and absent values are left out', () => {
    // A function or an object would serialise to something that does not parse.
    const out = svgMarkup(h('svg', {
        onClick: () => {}, style: { color: 'red' }, fill: null, stroke: undefined, hidden: false,
    }));
    assert.strictEqual(out, '<svg />');
});

t('attribute values are escaped', () => {
    assert.match(svgMarkup(h('path', { d: 'a"b' })), /d="a&quot;b"/);
    assert.match(svgMarkup(h('path', { d: 'a&b' })), /d="a&amp;b"/);
});

t('anything it cannot serialise is nothing, not a throw', () => {
    // An icon is a nicety; a menu without one still works.
    assert.strictEqual(svgMarkup(null), '');
    assert.strictEqual(svgMarkup(undefined), '');
    assert.strictEqual(svgMarkup('text'), '');
    assert.strictEqual(svgMarkup(h(() => { throw new Error('boom'); }, {})), '');
});

console.log(`\n${pass} passed`);
