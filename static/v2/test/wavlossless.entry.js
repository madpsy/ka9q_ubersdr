// Entry point for "WAV recording raises the stream to lossless".
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// iqdemod.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import RecorderPanel from '../src/panels/RecorderPanel.jsx';
import RecorderFormatWatch from '../src/components/RecorderFormatWatch.jsx';
import AudioPanel, { FormatPicker } from '../src/panels/AudioPanel.jsx';
import { getRecorder } from '../src/lib/recorder.js';

module.exports = {
    deep, render, reset, walk, words,
    RecorderPanel, RecorderFormatWatch, AudioPanel, FormatPicker, getRecorder,
};
