'use strict';

// The local plugin: everything the chooser needs that a WebView cannot do.
//
// Implemented in android/app/src/main/java/org/ubersdr/mobile/. It is registered
// by MainActivity rather than installed as a package — it is this client's own
// platform half, not a library, and a plugin published to npm to be consumed by
// the one app in the repository that uses it would be ceremony.
//
//   getJson       one HTTP path for every call the discovery layer makes, with
//                 per-receiver certificate trust the page could not express
//   mdnsBrowse    _ubersdr._tcp on the local network
//   secretGet/Set/Has/Clear
//                 the bypass password, sealed with a key in the Android
//                 keystore. `secretGet` is deliberately not reachable from the
//                 chooser — see api.js.
//   openReceiver  opens a receiver
//   closeReceiver / receiverState
//                 which receiver is open, if any

import { registerPlugin } from '@capacitor/core';

export const UberSdr = registerPlugin('UberSdr');
