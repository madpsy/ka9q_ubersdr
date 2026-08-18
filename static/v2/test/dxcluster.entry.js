// One bundle for the spot-socket test.
//
// The connection reads the page's session id from radio/session.js, and the test has to
// be able to move it — that is what powerOn does, and half the behaviour under test is
// about what the socket does when it moves. Separate esbuild bundles each get their own
// copy of a module, so requiring session.js on its own would hand the test a second
// `currentId` that the connection never looks at. Same reason as lightningstream.entry.js.

export * from '../src/radio/dxcluster-connection.js';
export { getSessionId, newSessionId } from '../src/radio/session.js';
