// How the interface looks, from the top bar.
//
// This was a sun/moon button that flipped between the two themes, and two things
// stopped that being enough: there are now eight colour schemes as well, and the
// two axes are not the same question. Dark or light is the room you are sitting
// in; the scheme is what the receiver looks like in it. Most schemes pin a base
// — amber on white is a highlighter — but the default one works in either, and
// nothing else in the app would let you say so.
//
// So: a menu with both, the base first because it is the thing changed daily and
// the one that used to be a single click. The Display panel has the same two
// controls at length, with the pickers underneath for building a scheme of your
// own; this is the shortcut.

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

    // The base on its own leaves the colours alone: somebody who has built an
    // amber scheme and wants it on a white page is entitled to ask for that, and
    // the schemes that would rather not be there say so by carrying a base of
    // their own.
    const setBase = (v) => d.set({ theme: v });

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
                    title={`Theme: ${theme}${named ? ` · ${named.name}` : ' · custom colours'}`}
                    aria-label="Theme and colours"
                    icon={(
                        <span className="thememenu__icon">
                            {theme === 'dark' ? <Icon.Moon /> : <Icon.Sun />}
                            {/* The accent in force, as a dot beside the glyph.
                                The base is only half the answer: on an amber or a
                                green scheme a moon on its own says almost nothing
                                about what is on screen. */}
                            <span className="thememenu__dot" />
                        </span>
                    )}
                />
            )}
        >
            <div className="menu__label">Theme</div>
            {[['dark', 'Dark'], ['light', 'Light']].map(([id, label]) => (
                <MenuItem
                    key={id}
                    active={theme === id}
                    icon={id === 'dark' ? <Icon.Moon size={14} /> : <Icon.Sun size={14} />}
                    onClick={() => setBase(id)}
                >
                    {label}
                </MenuItem>
            ))}

            <div className="menu__sep" />
            <div className="menu__label">Colours</div>
            {UI_THEMES.map((preset) => {
                const sw = themeSwatch(preset);
                return (
                    <MenuItem
                        key={preset.id}
                        active={on === preset.id}
                        icon={(
                            // The scheme's own accent over its own page, which is
                            // the same swatch the Display panel's grid draws — a
                            // scheme is recognised on sight, and "Phosphor" means
                            // nothing until you have seen it once.
                            <span className="thememenu__swatch" style={{ background: sw.bg }}>
                                <span style={{ background: sw.accent }} />
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
