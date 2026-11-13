// Entry point for the chat panel's render test — the moderator's tools and what
// a moderated listener sees.
//
// hookStub first, for its side effect: src/react.js reads window.React at
// module scope. Same rule as hdradiopanel.entry.js.
import { deep, render, rerender, reset, walk, words } from './hookStub.js';
import ChatPanel, {
    CHAT_BAN_PRESETS, ModBadge, ModSheet, WARN_CHIPS, banText, modBanFor, modWarningsFor,
    recordLine, untilText,
} from '../src/panels/ChatPanel.jsx';

module.exports = {
    deep, render, rerender, reset, walk, words,
    ChatPanel, CHAT_BAN_PRESETS, ModBadge, ModSheet, WARN_CHIPS, banText, modBanFor,
    modWarningsFor, recordLine, untilText,
};
