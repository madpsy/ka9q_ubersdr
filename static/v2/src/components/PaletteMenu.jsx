// The waterfall colour map, from the top bar.
//
// The same choice as the Display panel's palette grid — one setting, one list,
// PALETTE_NAMES in both places — put where it can be reached without opening a
// panel. It belongs up here for the reason the theme menu does: which colour map
// reads best depends on what is on the screen and on the room, so it is changed
// while looking at a signal rather than once when settling in, and hunting for it
// in a dock costs more than the bar space it takes.
//
// A menu rather than a button that cycles: there are eight maps and no order
// anybody would guess, so cycling would mean pressing until the right one turns
// up. Opening on hover makes trying one on free, the same as ThemeMenu.

import React from '../react.js';
import { Button, Menu, MenuItem } from './ui.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { PALETTE_NAMES, paletteGradient } from '../lib/palettes.js';

// The keys are lowercase because they are what gets stored and sent; a menu row
// is prose, so it gets a capital.
function label(name) {
    return name.charAt(0).toUpperCase() + name.slice(1);
}

export default function PaletteMenu() {
    const d = useDisplay();
    // The trigger paints itself in whatever is in force, including a stored name
    // this build no longer has — getPalette falls back to turbo for the canvas,
    // so paletteGradient does the same here and the two cannot disagree.
    const on = PALETTE_NAMES.includes(d.palette) ? d.palette : 'turbo';

    return (
        <Menu
            align="end"
            /* Pointer devices only — see Menu. */
            openOnHover
            trigger={(
                <Button
                    size="sm"
                    variant="ghost"
                    title={`Spectrum colours: ${label(on)}`}
                    aria-label="Spectrum colours"
                    icon={(
                        // The map itself, not a glyph of one. A palette is a
                        // strip of colour and there is no drawing of it that
                        // says more than the strip does.
                        <span
                            className="palmenu__icon"
                            style={{ backgroundImage: paletteGradient(on) }}
                        />
                    )}
                />
            )}
        >
            <div className="menu__label">Spectrum colours</div>
            {PALETTE_NAMES.map((name) => (
                <MenuItem
                    key={name}
                    active={on === name}
                    icon={(
                        <span
                            className="palmenu__swatch"
                            style={{ backgroundImage: paletteGradient(name) }}
                        />
                    )}
                    onClick={() => d.set({ palette: name })}
                >
                    {label(name)}
                </MenuItem>
            ))}
        </Menu>
    );
}
