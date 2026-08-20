// The 24-hour history store together with the feeds gate it polls behind.
//
// One bundle, for the reason bandnoise.entry.js is one: the gate is a
// module-level flag, and a separately-bundled copy of serverFeeds.js would give
// the test a switch wired to nothing.

export * from '../src/lib/noiseTrend.js';
export { setFeedsAllowed, resetFeeds } from '../src/lib/serverFeeds.js';
