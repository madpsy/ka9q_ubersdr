// One bundle for the frame-cap test. The stub must come first — see
// reactStub.js — because DisplayContext reads window.React as it loads.
import './reactStub.js';

export { resolveMaxFps } from '../src/display/DisplayContext.jsx';
export { resolveShell, shellChoosable } from '../src/lib/shellPref.js';
