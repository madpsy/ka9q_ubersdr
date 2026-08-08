// How the interface looks, from the top bar: a list of colour schemes, and nothing else.
//
// It was a sun/moon toggle, then a menu with the base and the schemes as two sections,
// and the two sections were one question too many. Every scheme carries the base it was
// drawn for — amber on white is a highlighter, ink on black is not paper — so choosing
// one already answers dark or light, and offering both meant offering combinations that
// no scheme was designed for and that most schemes overrode on the next click anyway.
//
// So the base moved out of here. It is still explicit in the Display panel, where
// somebody deliberately building their own scheme can put any colours on either page;
// this is the shortcut, and the shortcut is "make it look like this".

import React from '../react.js';
import { Button, Icon, Menu, MenuItem } from './ui.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { UI_THEMES, matchUiTheme, themeSwatch, uiColorsFrom } from '../lib/uiColors.js';

export default function ThemeMenu() {
    const d = useDisplay();
    const theme = d.theme === 'light' ? 'light' : 'dark';
    const mine = d.uiColors || {};
    const on = matchUiTheme(mine);
    const named = UI_THEMES.find((p) => p.id === on);

    // A scheme sets its colours and its base together, which is the whole point of it
    // being one choice.
    const apply = (preset) => d.set({
        uiColors: uiColorsFrom(preset),
        ...(preset.theme ? { theme: preset.theme } : {}),
    });

    return (
        <Menu
            align="end"
            trigger={(
                <Button
                    size="sm"
                    variant="ghost"
                    title={named ? `Colours: ${named.name}` : 'Colours: custom'}
                    aria-label="Colour scheme"
                    icon={(
                        <span className="thememenu__icon">
                            {/* Still a moon or a sun, but as a readout rather than a
                                toggle: it says which way the page is, which the accent
                                dot beside it does not — an amber scheme and a paper one
                                are both warm and only one of them is dark. */}
                            {theme === 'dark' ? <Icon.Moon /> : <Icon.Sun />}
                            {/* The accent in force. The base is only half the answer:
                                on an amber or a green scheme a moon on its own says
                                almost nothing about what is on screen. */}
                            <span className="thememenu__dot" />
                        </span>
                    )}
                />
            )}
        >
            <div className="menu__label">Colours</div>
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
                            <span className="thememenu__swatch" style={{ background: sw.bg }}>
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
        </Menu>
    );
}
