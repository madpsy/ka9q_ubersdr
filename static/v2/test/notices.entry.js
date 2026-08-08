// One bundle for the hardware-notice test.
//
// hardwareNotices.js and notifications.js must be bundled together or the test reads a
// different store from the one the detectors push into — separate esbuild bundles each get
// their own copy of the module. Same reason as dispatch.entry.js.

export * from '../src/lib/hardwareNotices.js';
export {
    notificationState, setSourceEnabled, _resetNotifications as _resetNotificationStore,
} from '../src/lib/notifications.js';
