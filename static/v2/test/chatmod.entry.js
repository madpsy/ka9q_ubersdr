// One bundle for the chat-moderation tests: the connection's message mapping,
// the pure bookkeeping in lib/chatModeration.js, and ChatProvider rendered under
// hookStub with the connection singleton it listens to — one copy of each, so an
// event emitted on `dxcluster` here is the one the provider subscribed to.
//
// hookStub first, for its side effect: src/react.js reads window.React at module
// scope. Same rule as statspanel.entry.js.
import { render, rerender, reset } from './hookStub.js';
import { ChatProvider } from '../src/chat/ChatContext.jsx';
import { DXClusterConnection, dxcluster } from '../src/radio/dxcluster-connection.js';
import * as mod from '../src/lib/chatModeration.js';

module.exports = {
    render, rerender, reset, ChatProvider, DXClusterConnection, dxcluster, mod,
};
