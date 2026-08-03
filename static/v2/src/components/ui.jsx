// Small, unopinionated control primitives every panel is built from. Keeping
// them here means a new panel is markup plus a handler, and restyling the whole
// app is a change to styles.css rather than to twenty components.

import React, { useEffect, useRef, useState } from '../react.js';
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
export function Segmented({ options, value, onChange, size = 'md', columns }) {
    const style = columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined;
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

export function Slider({ value, min, max, step = 1, onChange, onCommit, disabled }) {
    // Percentage drives the filled-track gradient without a second element.
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
    return (
        <input
            type="range"
            className="slider"
            style={{ '--fill': `${pct}%` }}
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
            onPointerUp={onCommit ? () => onCommit() : undefined}
        />
    );
}

export function Switch({ checked, onChange, label, disabled }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={!!checked}
            disabled={disabled}
            className={`switch${checked ? ' is-on' : ''}`}
            onClick={() => onChange(!checked)}
        >
            <span className="switch__track"><span className="switch__thumb" /></span>
            {label && <span className="switch__label">{label}</span>}
        </button>
    );
}

export function Readout({ label, value, unit, tone }) {
    return (
        <div className={`readout${tone ? ` readout--${tone}` : ''}`}>
            <div className="readout__label">{label}</div>
            <div className="readout__value">
                {value}
                {unit && <span className="readout__unit">{unit}</span>}
            </div>
        </div>
    );
}

// Horizontal bar for levels, with an optional peak tick.
export function Bar({ value, min = 0, max = 1, peak, tone = 'accent' }) {
    const clampPct = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
    return (
        <div className={`bar bar--${tone}`}>
            <div className="bar__fill" style={{ width: `${clampPct(value)}%` }} />
            {peak != null && <div className="bar__peak" style={{ left: `${clampPct(peak)}%` }} />}
        </div>
    );
}

// Popover anchored to its trigger; closes on outside click or Escape.
export function Menu({ trigger, children, align = 'end' }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

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
                <div className={`menu__panel menu__panel--${align}`} onClick={() => setOpen(false)}>
                    {children}
                </div>
            )}
        </div>
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

export { Icon };
