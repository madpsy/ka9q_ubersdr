# vendor (fetched, do not edit)

React 18 UMD builds, fetched once so the v2 frontend needs no npm/node_modules —
`build.sh` only needs `esbuild`, matching the rest of this repo's toolchain.

    curl -fsSL -o react.production.min.js     https://unpkg.com/react@18.3.1/umd/react.production.min.js
    curl -fsSL -o react-dom.production.min.js https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js

React 18 is used rather than 19 because 19 no longer ships UMD builds. The app
code reaches React through `src/react.js`, so swapping to a bundled copy later
is a one-file change.
