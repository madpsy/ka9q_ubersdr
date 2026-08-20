// The band noise store together with the feeds gate it polls behind.
//
// One bundle, because they have to be the same module instance: the gate is a
// module-level flag, and a separately-bundled copy of serverFeeds.js would give
// the test a switch wired to nothing.

export * from '../src/lib/bandNoise.js';
export { setFeedsAllowed, resetFeeds } from '../src/lib/serverFeeds.js';
