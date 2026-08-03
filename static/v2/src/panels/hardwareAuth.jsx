// Password handling shared by the two hardware panels.
//
// The rotator and the antenna switch each guard their POST endpoints with an
// operator-set password, and v1 keeps the one you typed in localStorage
// ('rotctl_password' / 'ant_switch_password'). The same keys are used here, so
// a password entered in /rotator.html or /switch.html — or in v1 — works in v2
// without typing it again, and a 401 clears it in both UIs.

import React, { useCallback, useState } from '../react.js';

export function usePassword(storageKey) {
    const [password, setPassword] = useState(() => {
        try { return localStorage.getItem(storageKey) || ''; } catch (e) { return ''; }
    });

    const save = useCallback((pw) => {
        try { localStorage.setItem(storageKey, pw); } catch (e) { /* private mode */ }
        setPassword(pw);
    }, [storageKey]);

    const clear = useCallback(() => {
        try { localStorage.removeItem(storageKey); } catch (e) { /* private mode */ }
        setPassword('');
    }, [storageKey]);

    return { password, save, clear };
}

// Inline prompt, shown only once an action needs a password it does not have —
// the same "click first, authenticate second" flow as v1's control panel.
export function PasswordRow({ error, onSubmit, onCancel }) {
    const [value, setValue] = useState('');

    const submit = () => {
        const pw = value.trim();
        if (pw) onSubmit(pw);
    };

    return (
        <div className="pw-row">
            <input
                className="input pw-row__input"
                type="password"
                placeholder="Password…"
                value={value}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') onCancel();
                }}
            />
            <button type="button" className="btn btn--primary btn--sm" onClick={submit}>OK</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
            {error && <span className="pw-row__error">{error}</span>}
        </div>
    );
}
