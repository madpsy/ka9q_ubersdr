// Weather fax as blocks: the raster that turns an FM level into pictures, and
// the chain of ordinary blocks that makes that level from audio.
//
// The FM half is not a fax block at all. A Hilbert transform makes the audio
// complex, a shift brings the 1900 Hz carrier to zero, a complex low-pass keeps
// the ±400 Hz swing and its sidebands, and the FM discriminator reads the
// frequency, full deviation at ±1: −1 black (1500 Hz), +1 white (2300 Hz).
// Measured against the ACfax 17-tap front end in image/wefax.js (the one the
// ubersdr_wefax Go uses), on the same synthetic transmissions, it is as good
// clean and better in noise — the low-pass is designed for the rate it runs
// at, where the 17 fixed taps are only right near 12 kHz — so there is no
// fax-only demodulator. What is fax-specific is the raster: lines, tones,
// phasing, IOC and slant (WefaxRaster, ported from ubersdr_wefax).

import { MESSAGE, REAL } from '../block.js';
import { WefaxRaster } from '../image/wefax.js';
import { pictureBlock } from './imaging.js';

const FAX_RASTER_KEYS = ['lpm', 'ioc', 'autoIoc', 'width', 'usePhasing', 'autoStart', 'autoStop', 'includeHeaders', 'slantPpm'];

/**
 * The raster. Input `level` is an FM discriminator's output scaled so the
 * deviation reads 1: −1 is black, +1 white, 0 mid-grey; beyond ±1 clips. Any
 * rate: a line is rate·60/LPM samples, averaged into its pixels.
 */
export const FaxRasterBlock = {
    type: 'fax-raster',
    label: 'Fax raster',
    category: 'Radio',
    summary: 'Draws radiofax from an FM level (−1 black, +1 white): starts on the START tone, lines up on the phasing, stops on STOP. Feed it an FM discriminator set to the fax deviation; wire its images to an Image viewer.',
    inputs: [{ name: 'level', kind: REAL, audio: false }],
    outputs: [{ name: 'images', kind: MESSAGE }, { name: 'text', kind: MESSAGE }],
    activity: 'Receiving',
    params: {
        lpm: { kind: 'choice', label: 'Lines a minute', default: 120, options: [60, 90, 120].map((v) => ({ value: v, label: String(v) })) },
        ioc: { kind: 'choice', label: 'IOC', default: 576, options: [576, 288].map((v) => ({ value: v, label: String(v) })) },
        autoIoc: { kind: 'bool', label: 'IOC from the START tone', default: true, control: false },
        // 0 is π·IOC, square pixels; anything else rescales the picture both ways.
        width: { kind: 'number', label: 'Width', unit: 'px', default: 0, min: 0, max: 4000, step: 1, control: false },
        usePhasing: { kind: 'bool', label: 'Line up on phasing', default: true, control: false },
        autoStart: { kind: 'bool', label: 'Start on the START tone', default: true, control: false },
        autoStop: { kind: 'bool', label: 'Stop on the STOP tone', default: true, control: false },
        includeHeaders: { kind: 'bool', label: 'Draw the tones and phasing', default: false, control: false },
        slantPpm: { kind: 'number', label: 'Slant', unit: 'ppm', default: 0, min: -500, max: 500, step: 1, control: false },
    },
    create: pictureBlock(
        (p, r) => new WefaxRaster({ sampleRate: r, ...Object.fromEntries(FAX_RASTER_KEYS.map((k) => [k, p[k]])) }),
        (p) => FAX_RASTER_KEYS.map((k) => p[k]).join('/'),
    ),
};

/**
 * The front end as stages, in insideAudio's shape (decoders.js): audio in at
 * the Hilbert transform, the level out of the discriminator. A 1 kHz low-pass
 * with a 400 Hz skirt measured best across 8–48 kHz, clean and in noise.
 */
export function wefaxFrontEndStages({ carrier = 1900, deviation = 400, cutoffHz = 1000 } = {}) {
    return [
        { id: 'analytic', type: 'hilbert', params: { taps: 65 } },
        { id: 'tocarrier', type: 'shift', params: { frequencyHz: -carrier } },
        { id: 'channel', type: 'lowpass', params: { cutoffHz, transitionHz: 400 } },
        { id: 'fm', type: 'fm-discriminator', params: { deviationHz: deviation } },
    ];
}
