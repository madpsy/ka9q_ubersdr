// Entry point for the DemodChain equivalence tests: the live chain, and the
// frozen copy of it from before it was split into lib/dsp/ primitives.
import { DemodChain, planFor } from '../src/lib/iqDemod.js';
import { DemodChain as RefChain, planFor as refPlanFor } from './reference/iqDemod.ref.js';

module.exports = { DemodChain, planFor, RefChain, refPlanFor };
