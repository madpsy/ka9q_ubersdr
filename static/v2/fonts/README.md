# v2 fonts

Self-hosted, so the app makes no third-party request and works on a receiver
with no route to the internet. Declared in `src/styles.css` (the `@font-face`
block at the top) and reached through the `--font` and `--mono` tokens.

| file | family | bytes | when it is fetched |
|---|---|---|---|
| `inter-latin.woff2` | Inter | 48 K | always |
| `inter-latin-ext.woff2` | Inter | 85 K | only if an accented character appears |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | 31 K | always |
| `jetbrains-mono-latin-ext.woff2` | JetBrains Mono | 12 K | only if an accented character appears |

**A cold load costs 79 K** — the two `latin` files. The `latin-ext` pair is
gated behind its `unicode-range`, so a session that never shows a name with a
diacritic in it never asks for them.

Both are **variable** fonts covering weights 400–700 in a single file, which is
smaller than the two static weights each would otherwise need.

## Why these two

Inter is drawn for interfaces at small sizes, which is what this one is: a tall
x-height and open apertures keep it readable at the 10–11 px a lot of this UI
runs at, and it has genuine tabular figures, so the `font-variant-numeric:
tabular-nums` the stylesheet asks for in eighty-odd places is honoured rather
than approximated by the fallback.

JetBrains Mono is used where the monospace is doing a job rather than setting a
mood — the teleprinter, NAVTEX and soundmodem consoles print text whose column
widths the *sender* chose — and it is unusually legible at small sizes for a
monospace.

The OS stack stays behind both in `--font` and `--mono`. If a file fails to load
the UI renders exactly as it did before these were added.

## Where they came from

Google Fonts' own `latin` and `latin-ext` subsets, fetched from `fonts.gstatic.com`
via the CSS v2 API — the same route `static/fonts/fonts.css` documents for the v1
frontend. The `unicode-range` values in `styles.css` are Google's, copied
verbatim rather than retyped.

To refresh, request the CSS with a modern browser `User-Agent` (the API serves
`woff2` only to browsers that support it), take the `latin` and `latin-ext`
blocks, and replace both the files and their ranges together — a range that
disagrees with its file silently stops glyphs resolving:

```sh
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap'
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..700&display=swap'
```

## Licence

Both are under the SIL Open Font License 1.1, reproduced here as `OFL-Inter.txt`
and `OFL-JetBrainsMono.txt`. The OFL requires the licence and copyright notice to
be distributed with the font files, which is why those two files are in this
directory and not only in a list somewhere.

* Inter — Copyright (c) 2016 The Inter Project Authors, https://github.com/rsms/inter
* JetBrains Mono — Copyright 2020 The JetBrains Mono Project Authors, https://github.com/JetBrains/JetBrainsMono
