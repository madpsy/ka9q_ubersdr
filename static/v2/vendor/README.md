# vendor (fetched, do not edit)

React 18 UMD builds, fetched once so the v2 frontend needs no npm/node_modules —
`build.sh` only needs `esbuild`, matching the rest of this repo's toolchain.

    curl -fsSL -o react.production.min.js     https://unpkg.com/react@18.3.1/umd/react.production.min.js
    curl -fsSL -o react-dom.production.min.js https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js

React 18 is used rather than 19 because 19 no longer ships UMD builds. The app
code reaches React through `src/react.js`, so swapping to a bundled copy later
is a one-file change.

fzstd is the zstd inflater for the lossless audio format (`format=pcm-zstd`),
imported by `src/radio/pcm-stream.js`. The ESM build, so esbuild bundles and
minifies it into v2.js like any other module — around 8 KB of the bundle.

    curl -fsSL -o fzstd.js https://unpkg.com/fzstd@0.1.1/esm/index.mjs

Bundled rather than loaded from a script tag at runtime: root assets like
`/opus-decoder.min.js` are served by the receiver, and the desktop client points
a bundle built from HEAD at whatever receiver you connect to — so a separate
file 404s against every receiver that has yet to be updated. Decompression only;
the encoder half of zstd is never needed here.
