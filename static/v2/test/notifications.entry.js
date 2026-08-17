// One bundle for the notification test.
//
// The store, the ding and the actions have to be bundled together or the test's fake sound
// card is installed in a different copy of noticeSound.js from the one pushNotification
// calls, and the action it validates is a different module from the one it runs — separate
// esbuild bundles each get their own. Same reason as notices.entry.js.

export * from '../src/lib/notifications.js';
export { MIN_GAP_MS, _resetNoticeSound } from '../src/lib/noticeSound.js';
export {
    noticeActionLabel, normaliseNoticeAction, runNoticeAction, tuneAction,
} from '../src/lib/noticeActions.js';
