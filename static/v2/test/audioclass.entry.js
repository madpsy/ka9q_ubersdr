// Entry point for the audio classifier's tests (audioclass.test.js).
//
// The hook stub first, for its side effect: src/react.js reads window.React at
// module scope.
import { deep, render, rerender, reset, walk, words } from './hookStub.js';
import AudioClassTag from '../src/components/AudioClassTag.jsx';
import AudioClassWatch from '../src/components/AudioClassWatch.jsx';
import DisplayPanel from '../src/panels/DisplayPanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';
import * as verdict from '../src/lib/audioClass/verdict.js';
import * as classifier from '../src/lib/audioClass/classifier.js';
import { createWorkerHost } from '../src/lib/audioClass/workerHost.js';
import * as signals from '../src/lib/audioClass/signals.js';
import { hintIsPhrase } from '../src/components/ui.jsx';

export {
    deep, render, rerender, reset, walk, words,
    AudioClassTag, AudioClassWatch, DisplayPanel, DEFAULTS,
    verdict, classifier, createWorkerHost, signals, hintIsPhrase,
};
