// A small popup menu, placed at a point.
//
// Written for the spectrum's right-click menu — hence the name and the class —
// but it knows nothing about the spectrum: the menu is a list of items the
// caller passes in, so the top bar's mode picker is the same component opened
// under a button instead of at a pointer.
//
// The floating, placing and dismissing is Popover's; this is the list of items
// that goes inside one.

import React from '../react.js';
import Popover from './Popover.jsx';

export default function SpectrumMenu({ at, items, onClose }) {
    return (
        <Popover at={at} onClose={onClose} role="menu" remeasure={items.length}>
            {items.map((item) => (
                item.separator ? (
                    <div key={item.key} className="specmenu__sep" />
                ) : (
                    <button
                        key={item.key}
                        type="button"
                        role="menuitem"
                        className="specmenu__item"
                        disabled={item.disabled}
                        title={item.title}
                        onClick={() => { onClose(); item.onSelect(); }}
                    >
                        {item.label}
                    </button>
                )
            ))}
        </Popover>
    );
}
