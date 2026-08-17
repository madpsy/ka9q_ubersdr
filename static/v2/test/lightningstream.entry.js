// One bundle for the lightning-stream test.
//
// The store both feeds the panel and raises notifications, so lightningStream.js and
// notifications.js have to be bundled together or the test reads a different store from
// the one the strikes push into — separate esbuild bundles each get their own copy of the
// module. Same reason as notices.entry.js and voiceconfirmed.entry.js.

export * from '../src/lib/lightningStream.js';
export {
    notificationState, setSourceEnabled, _resetNotifications as _resetNotificationStore,
} from '../src/lib/notifications.js';
// The gate starts closed, because `running` starts false — a test that did not open it
// would be testing a stopped receiver. See lib/serverFeeds.js.
export { setFeedsAllowed } from '../src/lib/serverFeeds.js';
