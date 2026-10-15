// Entry point for the Speech-to-Text extension's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope, and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// ifpanel.entry.js.
import { deep, render, rerender, reset, walk, words } from './hookStub.js';
import WhisperExtension from '../src/extensions/whisper/WhisperExtension.jsx';
import { dxcluster } from '../src/radio/dxcluster-connection.js';

module.exports = { deep, render, rerender, reset, walk, words, WhisperExtension, dxcluster };
