'use strict';

// The chooser's host.
//
// Bundled to www/app.js and loaded by the staged chooser page *before*
// chooser.js, which is the only ordering requirement in the whole client:
// chooser.js reads `window.ubersdr` while it is being parsed (it registers
// api.onChanged at the top level), so the object has to exist synchronously.
// Every method on it is async, so nothing else here has to be.

import { api } from './api.js';

window.ubersdr = api;
