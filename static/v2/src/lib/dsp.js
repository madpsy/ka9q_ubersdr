// DSP filter parameter schema handling.
//
// The server answers `get_dsp_filters` with a description of every filter the
// operator has enabled, each carrying its own parameter list:
//
//   { name, type: 'int'|'float'|'bool'|'string', default, min, max,
//     description, runtime_safe }
//
// Everything arrives as strings, including numbers and booleans, and params are
// sent back the same way — matching v1. These helpers turn a descriptor into a
// control choice; the panel just renders what they decide.

// Params that cannot be changed mid-stream are not shown at all: the server
// rejects them, and offering a control that always errors is worse than none.
// (dfnr's `model` is the current example.)
export function runtimeParams(filter) {
    return ((filter && filter.params) || []).filter((p) => p.runtime_safe !== false);
}

export function defaultParams(filter) {
    const out = {};
    for (const p of runtimeParams(filter)) out[p.name] = p.default ?? '';
    return out;
}

const num = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
};

export function isBool(param) {
    return String(param.type || '').toLowerCase() === 'bool';
}

export function isInt(param) {
    return String(param.type || '').toLowerCase() === 'int';
}

export function hasRange(param) {
    return param.min !== undefined && param.max !== undefined
        && param.min !== '' && param.max !== ''
        && Number.isFinite(parseFloat(param.min)) && Number.isFinite(parseFloat(param.max));
}

// Several int params enumerate their values in the description, e.g.
// "Gain method: 0=Linear 1=Log 2=Gamma 3=Trained". Those make far better sense
// as labelled choices than as a slider, so they are parsed out when the options
// found cover exactly the declared min..max range.
export function parseEnum(param) {
    if (!isInt(param) || !hasRange(param) || !param.description) return null;
    const options = [];
    const re = /(-?\d+)\s*=\s*([^\s,;]+)/g;
    let m;
    while ((m = re.exec(param.description)) !== null) {
        options.push({ value: Number(m[1]), label: m[2] });
    }
    if (options.length < 2) return null;
    const min = num(param.min, 0);
    const max = num(param.max, 0);
    if (options.length !== max - min + 1) return null;
    if (options.some((o, i) => o.value !== min + i)) return null;
    return options;
}

// 'bool' | 'enum' | 'slider' | 'text'
export function controlKind(param) {
    if (isBool(param)) return 'bool';
    if (parseEnum(param)) return 'enum';
    if (hasRange(param)) return 'slider';
    return 'text';
}

// Step size for a slider, following v1 — except that integer params step by 1
// rather than inheriting a fractional step from their range, which would send
// values the server would have to round anyway.
export function computeStep(param) {
    if (isInt(param)) return 1;
    const range = num(param.max, 100) - num(param.min, 0);
    if (range <= 1) return 0.01;
    if (range <= 10) return 0.1;
    if (range <= 100) return 1;
    return Math.pow(10, Math.floor(Math.log10(range)) - 1);
}

// "gain-method" -> "Gain method". Only the first word is capitalised: these read
// as sentences next to their description, not as headings.
export function formatParamName(name) {
    const words = String(name).replace(/[-_]/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatParamValue(value, param) {
    const v = num(value, 0);
    if (isInt(param)) return String(Math.round(v));
    const range = num(param.max, 100) - num(param.min, 0);
    if (range <= 1) return v.toFixed(3);
    if (range <= 10) return v.toFixed(2);
    return v.toFixed(1);
}

// The description usually repeats the enum mapping already shown as labels, so
// strip that part rather than print it twice.
export function paramHelp(param) {
    const d = String(param.description || '').trim();
    if (!d) return '';
    if (controlKind(param) !== 'enum') return d;
    const cut = d.replace(/(-?\d+\s*=\s*[^\s,;]+[\s,;]*)+$/, '').trim();
    return cut.replace(/[:\-–]\s*$/, '').trim();
}

export function boolValue(v) {
    return v === true || v === 'true' || v === '1';
}

// Params travel as strings in both directions.
export function toWire(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}
