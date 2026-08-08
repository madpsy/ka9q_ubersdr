// Small, unopinionated control primitives every panel is built from. Keeping
// them here means a new panel is markup plus a handler, and restyling the whole
// app is a change to styles.css rather than to twenty components.

import React, { ReactDOM, useEffect, useLayoutEffect, useRef, useState } from '../react.js';
import Icon from './icons.jsx';
import { useMediaQuery } from '../lib/useMediaQuery.js';

// `className` is pulled out and merged rather than left in `rest`: spread after
// className={cls} it would replace the lot — btn, the variant, the size and is-active
// — and the button would come out unstyled while looking like a perfectly ordinary
// call. That is a silent failure, so it is a merge.
export function Button({ children, variant = 'default', size = 'md', active, icon, className, ...rest }) {
    const cls = [
        'btn', `btn--${variant}`, `btn--${size}`,
        active ? 'is-active' : '',
        icon && !children ? 'btn--icon' : '',
        className,
    ].filter(Boolean).join(' ');
    return (
        <button type="button" className={cls} {...rest}>
            {icon}
            {children != null && <span>{children}</span>}
        </button>
    );
}

// Row of mutually exclusive options. `options` is [{value,label,title,className}].
//
// By default the options share one row. Pass `minItemWidth` to let them wrap
// onto as many rows as needed — the grid fits as many columns as will hold an
// item of that width, so labels never get ellipsed in a narrow dock. `columns`
// pins an exact column count instead.
//
// `className` on an option is for a set whose members carry a meaning of their
// own on top of which one is chosen — the Multipad's band row, where each button
// is painted with that band's conditions. It is deliberately per option rather
// than a render prop: anything that needs more than a class wants a row of
// buttons, not a control that says "one of these".
export function Segmented({ options, value, onChange, size = 'md', columns, minItemWidth, className }) {
    let style;
    if (minItemWidth) {
        // auto-flow must become `row`, or the items extend the track sideways
        // into implicit columns instead of wrapping.
        style = {
            gridTemplateColumns: `repeat(auto-fit, minmax(${minItemWidth}px, 1fr))`,
            gridAutoFlow: 'row',
        };
    } else if (columns) {
        style = {
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridAutoFlow: 'row',
        };
    }
    return (
        <div className={`segmented segmented--${size}${className ? ` ${className}` : ''}`} style={style} role="group">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    title={o.title || o.label}
                    className={`segmented__item${o.className ? ` ${o.className}` : ''}${o.value === value ? ' is-active' : ''}`}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function Field({ label, hint, children, inline }) {
    return (
        <label className={`field${inline ? ' field--inline' : ''}`}>
            <span className="field__label">
                {label}
                {hint != null && <span className="field__hint">{hint}</span>}
            </span>
            {children}
        </label>
    );
}

// `marker` overlays a live value on the track (e.g. current SNR against a
// squelch threshold). It is in the same units as the slider and is positioned
// inside the thumb's travel, so it lines up with where the thumb would sit.
export function Slider({
    value, min, max, step = 1, onChange, onCommit, disabled, marker, markerTone, markerTitle,
    track, level, fillColor,
}) {
    // Percentage drives the filled-track gradient without a second element.
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
    // A live level takes the filled part of the track over from the value.
    //
    // The thumb still shows where the control is set — the browser positions
    // that from `value`, not from this — so the two readings coexist on one
    // control: thumb for what you asked for, fill for what is coming out. That
    // is a fader with its meter in the track, which is what a mixing desk does
    // and why the volume slider needs no separate VU bar beside it.
    //
    // Not when there is a `track`, though. Those sliders draw a gradient of
    // their own instead of a fill — the EQ's cut-to-boost ramp — and take their
    // level as a brightening overlay through `--level` rather than as a length.
    const levelPct = level == null ? null : Math.max(0, Math.min(1, level)) * 100;
    const fillPct = levelPct != null && !track ? levelPct : pct;
    // `track` replaces the accent fill with a gradient of its own, for scales
    // where the position means something (the EQ's cut/boost).
    const input = (
        <input
            type="range"
            className={`slider${track ? ' slider--track' : ''}`}
            style={{
                '--fill': `${fillPct}%`,
                ...(track ? { '--track': track } : {}),
                // Colours the filled part of the track. The volume slider uses
                // it to carry its own output level, so the control and its
                // meter are one bar rather than two.
                ...(fillColor ? { '--fill-color': fillColor } : {}),
                // Read by .slider--track, whose meter is an overlay rather than
                // the fill itself.
                ...(levelPct != null ? { '--level': `${levelPct}%` } : {}),
            }}
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
            onPointerUp={onCommit ? () => onCommit() : undefined}
        />
    );
    if (marker == null || !Number.isFinite(marker)) return input;

    const frac = max === min ? 0 : Math.max(0, Math.min(1, (marker - min) / (max - min)));
    return (
        <div className="slider-wrap">
            {input}
            <span
                className={`slider-marker${markerTone ? ` slider-marker--${markerTone}` : ''}`}
                style={{ left: `calc(7px + ${frac} * (100% - 14px))` }}
                title={markerTitle}
            />
        </div>
    );
}

/**
 * Two thumbs on one track: a range with a bottom and a top.
 *
 * Written by hand rather than as two overlapping `<input type=range>`s, which is the
 * usual trick and brings two problems with it — the thumb on top swallows every drag
 * near the middle, and neither input can be told to stop at the other. Here the pointer
 * simply grabs whichever thumb it is nearer, and each end is clamped a `gap` away from
 * the other, so the two can never cross or meet.
 *
 * The keyboard gets both ends too: each thumb is a real focusable element with arrow keys
 * on it, because a control that can only be set by dragging is a control some people
 * cannot set at all.
 */
export function RangeSlider({
    low, high, min, max, step = 1, gap = 10, onChange, onCommit, format,
}) {
    const trackRef = useRef(null);
    // Which end a drag is moving. Decided on the way down and held, so a fast drag past
    // the other thumb keeps moving the one it started on rather than swapping.
    const dragging = useRef(null);

    const span = max - min || 1;
    const pct = (v) => ((v - min) / span) * 100;
    const round = (v) => Math.round(v / step) * step;

    const clampLow = (v) => Math.max(min, Math.min(round(v), high - gap));
    const clampHigh = (v) => Math.min(max, Math.max(round(v), low + gap));

    const valueAt = (clientX) => {
        const el = trackRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r.width) return null;
        return min + ((clientX - r.left) / r.width) * span;
    };

    const onDown = (e) => {
        const at = valueAt(e.clientX);
        if (at == null) return;
        // Nearer end wins, and a tie goes to the one with room to move.
        const end = Math.abs(at - low) <= Math.abs(at - high) ? 'low' : 'high';
        dragging.current = end;
        e.currentTarget.setPointerCapture(e.pointerId);
        onChange(end === 'low' ? { low: clampLow(at), high } : { low, high: clampHigh(at) });
    };

    const onMove = (e) => {
        if (!dragging.current) return;
        const at = valueAt(e.clientX);
        if (at == null) return;
        if (dragging.current === 'low') onChange({ low: clampLow(at), high });
        else onChange({ low, high: clampHigh(at) });
    };

    const onUp = (e) => {
        if (!dragging.current) return;
        dragging.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
        if (onCommit) onCommit();
    };

    const onKey = (end) => (e) => {
        const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1
            : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
        if (!dir) return;
        e.preventDefault();
        const by = dir * step * (e.shiftKey ? 5 : 1);
        if (end === 'low') onChange({ low: clampLow(low + by), high });
        else onChange({ low, high: clampHigh(high + by) });
        if (onCommit) onCommit();
    };

    const thumb = (end, v) => (
        <span
            className={`range__thumb range__thumb--${end}`}
            style={{ left: `${pct(v)}%` }}
            role="slider"
            tabIndex={0}
            aria-valuenow={v}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-label={end === 'low' ? 'Lower limit' : 'Upper limit'}
            title={format ? format(v) : String(v)}
            onKeyDown={onKey(end)}
        />
    );

    return (
        <div
            className="range"
            ref={trackRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
        >
            <span className="range__track" />
            <span
                className="range__fill"
                style={{ left: `${pct(low)}%`, width: `${Math.max(0, pct(high) - pct(low))}%` }}
            />
            {thumb('low', low)}
            {thumb('high', high)}
        </div>
    );
}

// `title` is the hover explanation. A switch's label has room for two words at
// most, which is rarely enough to say what turning it on actually does, so the
// sentence goes here rather than into the label or a note beside it.
export function Switch({ checked, onChange, label, disabled, title }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={!!checked}
            disabled={disabled}
            title={title}
            className={`switch${checked ? ' is-on' : ''}`}
            onClick={() => onChange(!checked)}
        >
            <span className="switch__track"><span className="switch__thumb" /></span>
            {label && <span className="switch__label">{label}</span>}
        </button>
    );
}

/**
 * A colour swatch that opens the platform's own picker.
 *
 * `<input type="color">` rather than a wheel of our own: every OS and browser
 * already ships a good one, it is the picker the user has used before, and on a
 * phone it is a full-screen native sheet instead of a gradient square being
 * aimed at with a fingertip. All this does is hide the default chrome so the
 * control reads as a swatch.
 *
 * `onClear` makes the swatch clearable — a second button that puts the value
 * back to whatever it was inheriting. `inherited` says it is on that already, so
 * the button can be disabled rather than looking like it does nothing.
 */
export function ColorPicker({
    value, onChange, onClear, inherited, clearLabel = 'Auto', title, ariaLabel,
}) {
    return (
        <span className="colorpick">
            <input
                className="colorpick__input"
                type="color"
                value={value}
                title={title}
                aria-label={ariaLabel}
                onChange={(e) => onChange(e.target.value)}
            />
            {onClear && (
                <button
                    type="button"
                    className="colorpick__clear"
                    onClick={onClear}
                    disabled={inherited}
                    title={inherited ? 'Already following the default' : 'Back to the default'}
                >
                    {clearLabel}
                </button>
            )}
        </span>
    );
}

// `tone` picks one of the themed colours; `color` overrides it outright, for
// values that carry a continuous scale of their own (the SNR ramp).
export function Readout({ label, value, unit, tone, color }) {
    return (
        <div className={`readout${tone ? ` readout--${tone}` : ''}`}>
            <div className="readout__label">{label}</div>
            <div className="readout__value" style={color ? { color } : undefined}>
                {value}
                {unit && <span className="readout__unit">{unit}</span>}
            </div>
        </div>
    );
}

// Horizontal bar for levels, with an optional peak tick.
export function Bar({ value, min = 0, max = 1, peak, tone = 'accent', color }) {
    const clampPct = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
    return (
        <div className={`bar bar--${tone}`}>
            <div className="bar__fill" style={{ width: `${clampPct(value)}%`, background: color || undefined }} />
            {peak != null && <div className="bar__peak" style={{ left: `${clampPct(peak)}%` }} />}
        </div>
    );
}

/**
 * A dropdown anchored under its trigger.
 *
 * Positioned fixed and placed by measurement rather than laid out inside the
 * trigger, for the reason Modal gives below: a panel that fills its dock clips
 * its body, and a menu that belongs to the panel's own chrome has no business
 * being cropped to it. Made small enough and a docked panel is narrower than its
 * own move menu, which then opened half off the left edge with no way to read
 * it. Nothing between here and the viewport establishes a containing block, so
 * fixed escapes the clip without a portal.
 *
 * `align` says which edge of the menu meets which edge of the trigger; either
 * way it is then nudged back on screen, since being readable outranks being
 * aligned.
 */
// How long a pointer has to rest on a hover-opening trigger, and how long it can be
// away before the menu closes.
//
// The open delay is what stops the menu appearing every time somebody crosses the top
// bar on the way to something else; the close delay is what lets them travel the few
// pixels of gap between the trigger and the panel without it vanishing under the
// pointer. Both are the numbers the dock's own hover-to-peek uses, because it is the
// same gesture and two different feels for it would be noticed.
const HOVER_OPEN_MS = 180;
const HOVER_CLOSE_MS = 220;

/**
 * `openOnHover` adds hovering to the ways it opens; clicking still works, and still
 * toggles. For a menu that is a look at what is available rather than a form to fill in
 * — the theme's colour schemes — reaching it should not cost a click.
 *
 * Only where hovering is something the pointer does: on a touch screen the enter event
 * arrives with the tap that is already toggling the menu, so it would open and close in
 * the same gesture. Same test the dock makes for the same reason.
 */
export function Menu({ trigger, children, align = 'end', openOnHover = false }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const panelRef = useRef(null);
    const [pos, setPos] = useState(null);
    const canHover = useMediaQuery('(hover: hover) and (pointer: fine)');
    const hoverable = openOnHover && canHover;
    const hoverTimer = useRef(null);

    const clearHover = () => { clearTimeout(hoverTimer.current); hoverTimer.current = null; };
    useEffect(() => clearHover, []);

    const onEnter = hoverable ? () => {
        clearHover();
        hoverTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_MS);
    } : undefined;
    // On the whole menu, trigger and panel together, so moving from one to the other is
    // not a departure. A pointer that leaves and comes back inside the delay keeps it.
    const onLeave = hoverable ? () => {
        clearHover();
        hoverTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
    } : undefined;

    useLayoutEffect(() => {
        if (!open) {
            setPos(null);
            return;
        }
        const trig = ref.current;
        const el = panelRef.current;
        if (!trig || !el) return;
        const t = trig.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const pad = 8;
        const gap = 5;

        const left = Math.max(pad, Math.min(
            align === 'end' ? t.right - r.width : t.left,
            window.innerWidth - r.width - pad,
        ));
        // Below the trigger, or above it when there is no room below — a menu
        // that runs off the bottom of the window is as unreachable as one that
        // runs off the side.
        const below = t.bottom + gap;
        const top = below + r.height > window.innerHeight - pad
            ? Math.max(pad, t.top - r.height - gap)
            : below;
        setPos({ left, top });
    }, [open, align]);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (ref.current && ref.current.contains(e.target)) return;
            if (panelRef.current && panelRef.current.contains(e.target)) return;
            setOpen(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        const close = () => setOpen(false);
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        // Fixed means it does not travel with the dock it was opened in, so a
        // scroll would leave it hanging over whatever is now underneath.
        // Capture, to hear scrolls on the dock rather than only on the page.
        document.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [open]);

    return (
        <div
            className="menu"
            ref={ref}
            onPointerEnter={onEnter}
            onPointerLeave={onLeave}
        >
            {/* A click still toggles, and cancels any pending hover so the two cannot
                fight: clicking a menu that was about to open on its own should close it,
                which is what somebody who has just clicked it expects. */}
            <span onClick={() => { clearHover(); setOpen((o) => !o); }}>{trigger}</span>
            {open && (
                <div
                    ref={panelRef}
                    className="menu__panel"
                    // Hidden until measured, or the first paint puts it at the
                    // top-left of the window and it visibly jumps into place.
                    style={{
                        left: pos ? pos.left : 0,
                        top: pos ? pos.top : 0,
                        visibility: pos ? 'visible' : 'hidden',
                    }}
                    onClick={() => setOpen(false)}
                >
                    {children}
                </div>
            )}
        </div>
    );
}

// Centred overlay, closed by Escape, by clicking the backdrop, or by the close
// button. Same dismissal rules as Menu above.
//
// Rendered through a portal into <body> rather than in place: panels that fill
// their dock clip their body (`overflow: hidden`), and a dialog inside one has
// no business being cropped to it or inheriting its stacking order.
export function Modal({ children, onClose, label }) {
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return ReactDOM.createPortal(
        <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={label}
            // Backdrop only: a click that started inside the content and
            // drifted out (selecting text, dragging an image) must not close it.
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal__body">
                {children}
                <button type="button" className="modal__close" title="Close" onClick={onClose}>
                    <Icon.Close size={18} />
                </button>
            </div>
        </div>,
        document.body,
    );
}

// `active` marks the one in force. Menus here are mostly lists of commands, where
// nothing is "on" — but a menu that picks between things (a theme, a colour
// scheme) has to say which is current, or it is a list of buttons that all look
// equally unpressed.
export function MenuItem({ children, onClick, disabled, icon, active }) {
    return (
        <button
            type="button"
            className={`menu__item${active ? ' is-active' : ''}`}
            aria-pressed={active === undefined ? undefined : !!active}
            onClick={onClick}
            disabled={disabled}
        >
            {icon && <span className="menu__icon">{icon}</span>}
            <span>{children}</span>
        </button>
    );
}

export function Empty({ children }) {
    return <div className="empty">{children}</div>;
}

// Panels have no scroller of their own — the dock scrolls — so a list of a few
// hundred rows would make the dock unusably long. Lists render a page at a time
// and grow on demand instead.
export function ShowMore({ shown, total, onMore, label = 'Show more' }) {
    if (shown >= total) {
        return total > 0 ? <div className="list__count">{total} shown</div> : null;
    }
    return (
        <button type="button" className="show-more" onClick={onMore}>
            {label} <span className="show-more__count">{shown} of {total}</span>
        </button>
    );
}

export { Icon };
