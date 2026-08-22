// The panel runtime, as its own bundle.
//
// Built separately from the app (see build.sh) because it does not run in the
// app: it runs inside each panel's sandboxed frame, and is inlined into that
// frame's document by srcdoc.js. Separate rather than fetched by the frame
// itself, so a panel needs no network of its own and cannot end up holding a
// different version of the API than the page it is talking to.
import { startPanelRuntime } from './runtime.js';

startPanelRuntime(window);
