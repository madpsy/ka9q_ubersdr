// A spinning drum, for a thumb.
//
// Everything about how it moves is in lib/barrel.js; this is the surface it
// moves on. The drum is a strip of detents drawn either side of a fixed index
// line: dragging slides the strip under the line, crossing a detent fires one
// step, and letting go with the thumb still moving carries on spinning until
// friction stops it.
//
// Two things about it are deliberate and easy to get wrong the other way:
//
//   The value never lives here. The strip is redrawn from `label(i)` on every
//   render, i being detents from the centre, and the owner applies the steps to
//   whatever it is the drum is turning. So a barrel over a frequency and a
//   barrel over the zoom ladder are the same component, and a value changed
//   from somewhere else — a bookmark, a pinch on the spectrum — moves the drum
//   with no message passing at all.
//
//   The strip is moved by hand, not by React. A drag produces a transform per
//   frame and the labels only change when a step is actually taken, so the sub-
//   detent movement is a style write on one element rather than a re-render of
//   thirty spans. Same reasoning as the spectrum canvas: the frame rate and the
//   render rate are different clocks and mixing them is what makes a phone
//   stutter.

import React, { useCallback, useEffect, useRef } from '../react.js';
import {
    clampSpeed, decayVelocity, flingVelocity, settleOffset, takeDetents,
} from '../lib/barrel.js';
import { haptic } from '../lib/haptics.js';

// Half the strip's width, CSS px. Anything wider than the barrel is clipped, so
// this only has to cover the widest place a barrel is drawn — a floating panel
// or the bottom dock, not just a phone.
const HALF_STRIP_PX = 620;

/**
 * `label(i)` returns the text for the detent i steps from the centre, or null
 * for one that carries a tick but no text — how a scale gets a label every fifth
 * detent — and undefined for a detent past the end of the scale, which is drawn
 * as nothing at all.
 *
 * `onStep(n)` applies n detents (positive = rightwards along the scale) and
 * returns how many it could actually take. Anything less than asked for is a
 * stop: the spin ends there rather than grinding on against a limit.
 */
export default function Barrel({
    detent = 46,
    label,
    onStep,
    onSettle,
    disabled,
    ariaLabel,
    className = '',
    children,
}) {
    const stripRef = useRef(null);
    const state = useRef({ rest: 0, vel: 0, at: 0, samples: [], raf: 0, drag: null });

    // Latest handlers, without re-binding the gesture on every render: the owner
    // rebuilds these closures whenever its value changes, which is every step.
    const stepRef = useRef(onStep);
    stepRef.current = onStep;
    const settleRef = useRef(onSettle);
    settleRef.current = onSettle;
    const detentRef = useRef(detent);
    detentRef.current = detent;

    const draw = useCallback(() => {
        const el = stripRef.current;
        if (el) el.style.transform = `translate3d(${state.current.rest}px,0,0)`;
    }, []);

    // Moves the strip by dx px, taking whatever whole detents that crosses.
    // Returns false when a limit stopped it, which ends a spin.
    const move = useCallback((dx) => {
        const s = state.current;
        const { steps, rest } = takeDetents(s.rest + dx, detentRef.current);
        s.rest = rest;
        let ok = true;
        if (steps) {
            // The strip follows the thumb, so dragging right brings the values
            // on the *left* of the scale to the index line — the same direction
            // the spectrum pans in.
            const want = -steps;
            const got = stepRef.current ? stepRef.current(want) : want;
            const applied = got == null ? want : got;
            if (applied !== want) {
                s.rest = 0;
                s.vel = 0;
                ok = false;
                haptic('bump', 'spectrum');
            } else {
                haptic('step', 'spectrum');
            }
        }
        draw();
        return ok;
    }, [draw]);

    const stop = useCallback(() => {
        const s = state.current;
        if (s.raf) cancelAnimationFrame(s.raf);
        s.raf = 0;
    }, []);

    // One loop for both halves of the ending: the spin decays, and once it has
    // stopped the leftover fraction of a detent eases back onto the index line.
    const tick = useCallback(() => {
        const s = state.current;
        const now = performance.now();
        const dt = (now - s.at) / 1000;
        s.at = now;

        if (s.vel) {
            if (move(s.vel * dt)) s.vel = decayVelocity(s.vel, dt);
        } else if (s.rest) {
            s.rest = settleOffset(s.rest, dt);
            draw();
        }

        if (s.vel || s.rest) {
            s.raf = requestAnimationFrame(tick);
            return;
        }
        s.raf = 0;
        if (settleRef.current) settleRef.current();
    }, [move, draw]);

    const spin = useCallback(() => {
        const s = state.current;
        if (s.raf) return;
        s.at = performance.now();
        s.raf = requestAnimationFrame(tick);
    }, [tick]);

    useEffect(() => stop, [stop]);

    // A notch of the wheel is a detent, for the desktop the pad is not really
    // for but can be dragged onto anyway. Native and non-passive: React
    // registers wheel handlers passively, so preventDefault() there is ignored
    // and the dock scrolls along with the drum being turned — the same trap the
    // Receiver panel's dial fell into.
    const rootRef = useRef(null);
    useEffect(() => {
        const el = rootRef.current;
        if (!el || disabled) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            stop();
            const s = state.current;
            s.vel = 0;
            s.rest = 0;
            // Scroll up is a step *up* the scale, as the dial's digits are, so
            // the strip moves the opposite way to the notch.
            move((e.deltaY < 0 ? -1 : 1) * detentRef.current);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [disabled, move, stop]);

    const onPointerDown = (e) => {
        if (disabled) return;
        const s = state.current;
        stop();
        s.vel = 0;
        // A touch on a spinning drum catches it, as it would a real one. The
        // remainder is kept: the drum stops where it was, not on the nearest
        // detent, or catching it would move the value you caught it to stop.
        s.drag = { x: e.clientX, id: e.pointerId };
        s.samples = [{ x: e.clientX, t: e.timeStamp || performance.now() }];
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };

    const onPointerMove = (e) => {
        const s = state.current;
        if (!s.drag || s.drag.id !== e.pointerId) return;
        const dx = e.clientX - s.drag.x;
        s.drag.x = e.clientX;
        s.samples.push({ x: e.clientX, t: e.timeStamp || performance.now() });
        // Only the tail decides the throw, so the rest is dead weight.
        if (s.samples.length > 12) s.samples.shift();
        move(dx);
    };

    const endDrag = (e, fling) => {
        const s = state.current;
        if (!s.drag || s.drag.id !== e.pointerId) return;
        s.drag = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        s.vel = fling
            ? clampSpeed(flingVelocity(s.samples, e.timeStamp || performance.now()))
            : 0;
        s.samples = [];
        // Even with nothing thrown there is a fraction of a detent to settle.
        if (s.vel || s.rest) spin();
        else if (settleRef.current) settleRef.current();
    };

    // Cells are placed from the centre outwards and clipped by the barrel, so
    // the count only has to cover the widest barrel we draw rather than being
    // measured — a measurement would make the first frame after every resize
    // wrong, for spans nobody can see anyway.
    const reach = Math.max(1, Math.ceil(HALF_STRIP_PX / detent));
    const cells = [];
    for (let i = -reach; i <= reach; i++) {
        const text = label ? label(i) : null;
        if (text === undefined) continue;   // past the end of the scale
        cells.push(
            <span
                key={i}
                className={`barrel__cell${text ? ' is-major' : ''}${i === 0 ? ' is-centre' : ''}`}
                style={{ transform: `translateX(${i * detent}px)` }}
                aria-hidden="true"
            >
                <i className="barrel__tick" />
                {text && <b className="barrel__text">{text}</b>}
            </span>
        );
    }

    return (
        <div
            className={`barrel${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
            role="group"
            aria-label={ariaLabel}
            /* pan-y, not none: a horizontal drag is ours and a vertical one is
               the sheet's, so a barrel near the bottom of a panel does not trap
               the scroll that was trying to get past it. */
            ref={rootRef}
            style={{ touchAction: 'pan-y' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => endDrag(e, true)}
            onPointerCancel={(e) => endDrag(e, false)}
            /* Its own gesture, so the delegated press pulse would be a second
               buzz on top of the per-detent one. */
            data-haptic="off"
        >
            <div className="barrel__strip" ref={stripRef}>{cells}</div>
            <span className="barrel__index" aria-hidden="true" />
            {children}
        </div>
    );
}
