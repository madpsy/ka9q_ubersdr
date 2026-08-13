'use strict';

// The chooser's host.
//
// Bundled to www/app.js and loaded by the staged chooser page *before*
// chooser.js, which is the only ordering requirement in the whole client:
// chooser.js reads `window.ubersdr` while it is being parsed (it registers
// api.onChanged at the top level), so the object has to exist synchronously.
// Every method on it is async, so nothing else here has to be.

import { api } from './api.js';
import { install as installDeepLinks } from './deeplink.js';

window.ubersdr = api;

// Here rather than in the page, and before it: a link that started the app has
// already been delivered to the plugin by the time this bundle runs, and is
// held there until something is listening for it. See deeplink.js.
installDeepLinks();
