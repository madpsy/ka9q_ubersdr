// Entry point for the start map's render test. The hook stub first, for the
// reason ifpanel.entry.js gives.
import { render, reset, walk } from './hookStub.js';
import StartMap from '../src/components/StartMap.jsx';
import { _resetMyIp } from '../src/lib/myip.js';
import * as nearby from '../src/lib/nearbyReceivers.js';

module.exports = { render, reset, walk, StartMap, _resetMyIp, nearby };
