// Load a classic script from the site root, once.
//
// v2 is bundled, but a few v1 modules are worth reusing as-is rather than
// reimplementing — they are large, self-contained and already correct. They are
// classic scripts with UMD/global dependencies, so they are appended to the
// document and awaited instead of being imported.
//
// Promises are cached per URL: several callers (or a component remounting) share
// one network request and one execution.

const cache = new Map();

export function loadScript(src) {
    const hit = cache.get(src);
    if (hit) return hit;

    const p = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = false;            // preserve order between chained loads
        el.onload = () => resolve();
        el.onerror = () => {
            cache.delete(src);       // let a later attempt retry
            reject(new Error(`failed to load ${src}`));
        };
        document.head.appendChild(el);
    });

    cache.set(src, p);
    return p;
}

// Load in sequence, for scripts that depend on earlier ones being present.
export async function loadScripts(list) {
    for (const src of list) await loadScript(src);
}
