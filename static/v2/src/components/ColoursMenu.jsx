// Colours, from the top bar: how the interface is painted, and how the spectrum
// and waterfall are.
//
// It was a sun/moon toggle, then a menu with the base and the schemes as two
// sections, and the two sections were one question too many. Every scheme carries
// the base it was drawn for — amber on white is a highlighter, ink on black is
// not paper — so choosing one already answers dark or light, and offering both
// meant offering combinations that no scheme was designed for and that most
// schemes overrode on the next click anyway.
//
// So the base moved out of here. It is still explicit in the Display panel, where
// somebody deliberately building their own scheme can put any colours on either
// page; this is the shortcut, and the shortcut is "make it look like this".
//
// The waterfall's colour map then joined it, because it is the same question
// asked of the other half of the screen and it was the one setting people opened
// the Display panel for. Having found the schemes, somebody looking for the
// palette should not have to go anywhere else — so one button, two sections,
// rather than two buttons that would have to explain the difference between them.
//
// Both sections are lists of colours to look at rather than forms, which is why
// the menu opens on hover as well as on click: trying a scheme or a palette on
// should not cost a click.

import React from '../react.js';
import { Button, Icon, Menu, MenuItem } from './ui.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { UI_THEMES, matchUiTheme, themeSwatch, uiColorsFrom } from '../lib/uiColors.js';
import { PALETTE_NAMES, paletteGradient } from '../lib/palettes.js';

export default function ColoursMenu() {
    const d = useDisplay();
    const theme = d.theme === 'light' ? 'light' : 'dark';
    const mine = d.uiColors || {};
    const on = matchUiTheme(mine);
    const named = UI_THEMES.find((p) => p.id === on);
    // A stored palette this build no longer has still colours the canvas —
    // getPalette falls back to turbo — so the menu says turbo too, rather than
    // showing nothing as current.
    const pal = PALETTE_NAMES.includes(d.palette) ? d.palette : 'turbo';

    // A scheme sets its colours and its base together, which is the whole point of it
    // being one choice.
    const apply = (preset) => d.set({
        uiColors: uiColorsFrom(preset),
        ...(preset.theme ? { theme: preset.theme } : {}),
    });

    return (
        <Menu
            align="end"
            /* Pointer devices only — see Menu. */
            openOnHover
            trigger={(
                <Button
                    size="sm"
                    variant="ghost"
                    title={`Colours — interface: ${named ? named.name : 'custom'}, spectrum: ${pal}`}
                    aria-label="Colours"
                    icon={(
                        <span className="colmenu__icon">
                            {/* Still a moon or a sun, but as a readout rather than a
                                toggle: it says which way the page is, which the accent
                                dot beside it does not — an amber scheme and a paper one
                                are both warm and only one of them is dark. */}
                            {theme === 'dark' ? <Icon.Moon /> : <Icon.Sun />}
                            {/* The accent in force. The base is only half the answer:
                                on an amber or a green scheme a moon on its own says
                                almost nothing about what is on screen. */}
                            <span className="colmenu__dot" />
                        </span>
                    )}
                />
            )}
        >
            <div className="menu__label">Interface</div>
            {UI_THEMES.map((preset) => {
                const sw = themeSwatch(preset);
                return (
                    <MenuItem
                        key={preset.id}
                        active={on === preset.id}
                        icon={(
                            // The scheme's page with its accent and its text on
                            // it — the same three-colour swatch the Display
                            // panel's grid draws, for the same reason: the page
                            // alone is near-black on seven of these and tells you
                            // nothing about which is which.
                            //
                            // Only the swatch is in the scheme's colours. The row
                            // itself belongs to whatever scheme is running, or a
                            // menu of them would be a menu you cannot read.
                            <span className="colmenu__swatch" style={{ background: sw.bg }}>
                                <i style={{ background: sw.accent }} />
                                <i style={{ background: sw.text }} />
                            </span>
                        )}
                        onClick={() => apply(preset)}
                    >
                        {preset.name}
                    </MenuItem>
                );
            })}

            <div className="menu__sep" />

            {/* The Display panel's palette grid, not a second list of named rows:
                a colour map is a strip of colour and the name above it adds
                nothing you cannot see, whereas nine more rows would have made
                this menu taller than a short window. The names are on hover, the
                same as they are in the panel. */}
            <div className="menu__label">Spectrum</div>
            <div className="colmenu__pals">
                <div className="palette-grid">
                    {PALETTE_NAMES.map((name) => (
                        <button
                            key={name}
                            type="button"
                            title={name}
                            aria-label={name}
                            aria-pressed={pal === name}
                            className={`palette${pal === name ? ' is-active' : ''}`}
                            style={{ backgroundImage: paletteGradient(name) }}
                            onClick={() => d.set({ palette: name })}
                        />
                    ))}
                </div>
            </div>
        </Menu>
    );
}
