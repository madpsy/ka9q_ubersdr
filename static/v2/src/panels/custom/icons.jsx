// A manifest names an icon; this turns the name into one.
//
// Built-in panels write `icon: <Icon.Radio />` — a React element from the map in
// components/icons.jsx, every entry of which renders through the same `Svg`
// wrapper: 24-unit viewBox, 16 px default, `currentColor`, one stroke weight.
// That is why a panel's icon looks right in the dock header, the mobile tab row,
// the layout manager and the notice list without any of them styling it.
//
// A manifest cannot carry a React element, so it carries a key of that map. The
// keys are therefore a **published contract**: a manifest out on the collector
// naming `"Bars"` breaks on every receiver that has it enabled if that key is
// ever renamed. Add, never rename — see the note in components/icons.jsx.

import React from '../../react.js';
import Icon from '../../components/icons.jsx';

// The names a manifest may use, for the picker in the admin editor and for the
// assistant's brief — which will otherwise invent them.
export const PANEL_ICONS = Object.keys(Icon);

/**
 * The key a manifest's `icon` actually resolves to.
 *
 * An own-property check rather than `Icon[name]`, because a plain object
 * inherits from `Object.prototype`: a manifest naming `"constructor"`,
 * `"toString"` or `"__proto__"` would otherwise resolve to something that is not
 * a component at all, and React would be handed it to render.
 *
 * An unknown or missing name gets the fallback rather than nothing: a panel with
 * no icon is unfindable in the mobile tab row, which is icons only, and a hole
 * in the row in the layout manager.
 */
export function iconName(name) {
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(Icon, name)) return name;
    return 'Custom';
}

/** The element for a manifest's `icon`. */
export function panelIcon(name) {
    const Glyph = Icon[iconName(name)];
    return <Glyph />;
}
