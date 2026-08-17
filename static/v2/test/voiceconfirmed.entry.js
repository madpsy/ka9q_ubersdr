// One bundle for the confirmed-voice test.
//
// The store both draws markers and raises notifications, so voiceConfirmed.js and
// notifications.js have to be bundled together or the test reads a different store from
// the one the poll pushes into — separate esbuild bundles each get their own copy of the
// module. Same reason as notices.entry.js and dispatch.entry.js.

export * from '../src/lib/voiceConfirmed.js';
export {
    notificationState, setSourceEnabled, sourceEnabled,
    _resetNotifications as _resetNotificationStore,
} from '../src/lib/notifications.js';
