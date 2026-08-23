// Entry point for the floating-window drag test.
//
// The hook stub first and for its side effect, as in vfospanel.entry.js:
// src/react.js reads window.React at module scope, and useFloatDrag is a hook
// like any other — useCallback and useRef have to be real for `start` to exist
// at all.
import { render, reset } from './hookStub.js';
import { useFloatDrag } from '../src/lib/useFloatDrag.js';

module.exports = { render, reset, useFloatDrag };
