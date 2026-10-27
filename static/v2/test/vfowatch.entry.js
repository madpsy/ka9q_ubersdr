// Entry point for the simultaneous-VFO watcher and the Audio panel's note.
//
// The hook stub first, for the reason given in wavlossless.entry.js.
import { deep, render, reset, words } from './hookStub.js';
import SubReceiversWatch from '../src/components/SubReceiversWatch.jsx';
import AudioPanel from '../src/panels/AudioPanel.jsx';
import { getSubReceivers } from '../src/radio/subReceivers.js';
import { useSubReceivers } from '../src/radio/useSubReceivers.js';

module.exports = {
    deep, render, reset, words, SubReceiversWatch, AudioPanel, getSubReceivers, useSubReceivers,
};
