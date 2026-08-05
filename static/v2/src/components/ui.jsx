// Small, unopinionated control primitives every panel is built from. Keeping
// them here means a new panel is markup plus a handler, and restyling the whole
// app is a change to styles.css rather than to twenty components.

import React, { ReactDOM, useEffect, useLayoutEffect, useRef, useState } from '../react.js';
import Icon from './icons.jsx';

export function Button({ children, variant = 'default', size = 'md', active, icon, ...rest }) {
    const cls = ['btn', `btn--${variant}`, `btn--${size}`, active ? 'is-active' : '', icon && !children ? 'btn--icon' : '']
        .filter(Boolean).join(' ');
    return (
        <button type="button" className={cls} {...rest}>
            {icon}
            {children != null && <span>{children}</span>}
        </button>
    );
}

// Row of mutually exclusive options. `options` is [{value,label,title}].
//
// By default the options share one row. Pass `minItemWidth` to let them wrap
// onto as many rows as needed — the grid fits as many columns as will hold an
// item of that width, so labels never get ellipsed in a narrow dock. `columns`
// pins an exact column count instead.
export function Segmented({ options, value, onChange, size = 'md', columns, minItemWidth }) {
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
        <div className={`segmented segmented--${size}`} style={style} role="group">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    title={o.title || o.label}
                    className={`segmented__item${o.value === value ? ' is-active' : ''}`}
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
    track, level, clipping,
}) {
    // Percentage drives the filled-track gradient without a second element.
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
    // `track` replaces the accent fill with a gradient of its own, for scales
    // where the position means something (the EQ's cut/boost).
    const input = (
        <input
            type="range"
            className={`slider${track ? ' slider--track' : ''}`
                + `${level != null && !track ? ' slider--level' : ''}${clipping ? ' is-clip' : ''}`}
            style={{
                '--fill': `${pct}%`,
                ...(track ? { '--track': track } : {}),
                // A live level lights the track up from the left, so the
                // control and its meter are one object rather than two.
                ...(level != null ? { '--level': `${Math.max(0, Math.min(1, level)) * 100}%` } : {}),
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

// Popover anchored to its trigger; closes on outside click or Escape.
export function Menu({ trigger, children, align = 'end' }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const panelRef = useRef(null);
    // Horizontal nudge that keeps the panel on screen. A menu anchored in a
    // narrow side dock — or one whose trigger has wrapped to the dock's edge —
    // would otherwise open past the edge of the window and be unreadable.
    const [shift, setShift] = useState(0);

    useLayoutEffect(() => {
        if (!open) {
            setShift(0);
            return;
        }
        const el = panelRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const pad = 8;
        if (r.left < pad) setShift(pad - r.left);
        else if (r.right > window.innerWidth - pad) setShift(window.innerWidth - pad - r.right);
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div className="menu" ref={ref}>
            <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
            {open && (
                <div
                    ref={panelRef}
                    className={`menu__panel menu__panel--${align}`}
                    style={shift ? { transform: `translateX(${shift}px)` } : undefined}
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

export function MenuItem({ children, onClick, disabled, icon }) {
    return (
        <button type="button" className="menu__item" onClick={onClick} disabled={disabled}>
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
