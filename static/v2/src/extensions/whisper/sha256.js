// SHA-256, a chunk at a time, for checking a downloaded speech model against
// its pin while it arrives.
//
// Not crypto.subtle: it hashes a whole buffer, not a stream, so a 60 MB model
// would be held twice to be checked once; and it is not there at all on a page
// served over plain HTTP, which is how many receivers are reached. This runs at
// a few hundred MB/s, so checking a model as it downloads costs well under a
// second all told, spread over the download.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** `{update(bytes), hex()}`: feed Uint8Arrays in order, then read the digest once. */
export function createSha256() {
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const block = new Uint8Array(64);
    let fill = 0;
    let length = 0;  // bytes, as a double: exact far beyond any model

    function compress(b, o) {
        for (let i = 0; i < 16; i++) {
            const j = o + i * 4;
            w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15];
            const c = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let A = h[0]; let B = h[1]; let C = h[2]; let D = h[3];
        let E = h[4]; let F = h[5]; let G = h[6]; let H = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
            const ch = (E & F) ^ (~E & G);
            const t1 = (H + S1 + ch + K[i] + w[i]) | 0;
            const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
            const maj = (A & B) ^ (A & C) ^ (B & C);
            const t2 = (S0 + maj) | 0;
            H = G; G = F; F = E; E = (D + t1) | 0;
            D = C; C = B; B = A; A = (t1 + t2) | 0;
        }
        h[0] += A; h[1] += B; h[2] += C; h[3] += D;
        h[4] += E; h[5] += F; h[6] += G; h[7] += H;
    }

    function update(bytes) {
        let i = 0;
        const n = bytes.length;
        length += n;
        if (fill) {
            const take = Math.min(64 - fill, n);
            block.set(bytes.subarray(0, take), fill);
            fill += take;
            i = take;
            if (fill < 64) return;
            compress(block, 0);
            fill = 0;
        }
        for (; i + 64 <= n; i += 64) compress(bytes, i);
        if (i < n) {
            block.set(bytes.subarray(i), 0);
            fill = n - i;
        }
    }

    function hex() {
        const bits = length * 8;
        const tail = new Uint8Array(((fill + 9 + 63) >> 6) << 6);
        tail.set(block.subarray(0, fill));
        tail[fill] = 0x80;
        const hi = Math.floor(bits / 0x100000000);
        const lo = bits >>> 0;
        const e = tail.length;
        tail[e - 8] = hi >>> 24; tail[e - 7] = hi >>> 16; tail[e - 6] = hi >>> 8; tail[e - 5] = hi;
        tail[e - 4] = lo >>> 24; tail[e - 3] = lo >>> 16; tail[e - 2] = lo >>> 8; tail[e - 1] = lo;
        for (let o = 0; o < e; o += 64) compress(tail, o);
        let out = '';
        for (let i = 0; i < 8; i++) out += (h[i] >>> 0).toString(16).padStart(8, '0');
        return out;
    }

    return { update, hex };
}
