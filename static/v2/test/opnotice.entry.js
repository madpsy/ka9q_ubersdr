// Entry point for the operator notice's tests.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// filterreset.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import OperatorNotice from '../src/components/OperatorNotice.jsx';
import { parseNotice, parseNotices, noticeLinkOk } from '../src/display/uiConfig.js';
import { noticeLinksAllowedByHost } from '../src/lib/hostPanels.js';

module.exports = {
    deep, render, reset, walk, words, OperatorNotice, parseNotice, parseNotices, noticeLinkOk, noticeLinksAllowedByHost,
};
