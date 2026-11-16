# Audio classifier assets

Served at `/v2/audioclass/` to the v2 page's audio classifier
(`src/lib/audioClass/`), which shows whether the audio being listened to is
voice, music or noise.

| File | What it is | Made by |
|---|---|---|
| `audioclass.wasm` | The classifier, Go compiled to WebAssembly | `../native/audioclass/build.sh` |
| `mn05_as_mAP_443.pt` | EfficientAT mn05 weights, the official release file | Not built: committed as published |

`mn05_as_mAP_443.pt` is the file from
<https://github.com/fschmid56/EfficientAT/releases/tag/v0.0.1>, unchanged:
5,878,097 bytes, SHA-256
`97f00bb717ce957dbdf60c26d4de8b161dd7c2593fbe6424859fad7e5569fd7f`.
`static/v2/native/audioclass` has a test that checks it against that pin and
loads it.

It is committed rather than fetched so a receiver never has to reach GitHub
for it. A page could not fetch it from GitHub anyway, because GitHub's release
downloads carry no CORS headers.

## Licences

**EfficientAT** (the weights, and the network they are loaded into) is under
the MIT licence:

> MIT License
>
> Copyright (c) 2022 Florian Schmid
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

**The AudioSet class labels** embedded in the module
(`../native/audioclass/audioset_labels.csv`) are Google's, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

**The voice / music / noise rules** are NightDX's
(<https://github.com/marcozennaro/nightdx>, MIT, © Marco Zennaro).
