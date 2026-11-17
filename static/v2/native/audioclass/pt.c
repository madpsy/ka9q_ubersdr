/*
 * pt.c - reading a PyTorch state dict (.pt) without PyTorch: the Go original's
 * ptfile.go in C.
 *
 * A .pt file saved by torch.save (the zip format, PyTorch 1.6+) is a zip with
 * <prefix>/data.pkl, a pickle describing the state dict, and <prefix>/data/<key>
 * files holding each tensor's raw storage. torch.save stores every entry
 * uncompressed; a compressed one is refused. The pickle needs only a handful of
 * opcodes and four globals for a state dict of float tensors, which is all this
 * implements: a reader for model weights, not a general unpickler, and anything
 * outside that set is an error rather than a guess.
 *
 * Every byte comes off the network, so every read is bounds-checked and every
 * failure is an error message, never a trap. The tensors point into the file's
 * bytes, which the caller keeps for as long as it uses them.
 */
#include "audioclass.h"

/* ── zip ─────────────────────────────────────────────────────────────────── */

typedef struct {
    const char *name;
    int name_len;
    const uint8_t *data;
    uint32_t size;
} zentry;

static uint32_t le16(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8; }
static uint32_t le32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static int zip_entries(const uint8_t *z, size_t len, zentry **out, int *count, const char **err) {
    /* The end-of-central-directory record: 22 bytes plus up to 64 kB of comment. */
    if (len < 22) {
        *err = "pt: zip: not a valid zip file";
        return 0;
    }
    size_t eocd = 0;
    int found = 0;
    const size_t lowest = len > 22 + 65535 ? len - 22 - 65535 : 0;
    for (size_t i = len - 22 + 1; i-- > lowest;) {
        if (le32(z + i) == 0x06054b50) {
            eocd = i;
            found = 1;
            break;
        }
    }
    if (!found) {
        *err = "pt: zip: not a valid zip file";
        return 0;
    }
    const uint32_t n = le16(z + eocd + 10);
    const uint32_t cd_size = le32(z + eocd + 12);
    const uint32_t cd_off = le32(z + eocd + 16);
    if (n == 0xFFFF || cd_off == 0xFFFFFFFFu || (uint64_t)cd_off + cd_size > eocd) {
        *err = "pt: zip: unsupported or corrupt central directory";
        return 0;
    }
    zentry *e = ac_alloc(sizeof(zentry) * (n ? n : 1));
    if (!e) {
        *err = "pt: out of memory";
        return 0;
    }
    size_t p = cd_off;
    for (uint32_t i = 0; i < n; i++) {
        if (p + 46 > (size_t)cd_off + cd_size || le32(z + p) != 0x02014b50) {
            *err = "pt: zip: corrupt central directory";
            return 0;
        }
        const uint32_t method = le16(z + p + 10);
        const uint32_t csize = le32(z + p + 20);
        const uint32_t usize = le32(z + p + 24);
        const uint32_t nlen = le16(z + p + 28), xlen = le16(z + p + 30), clen = le16(z + p + 32);
        const uint32_t loc = le32(z + p + 42);
        if (p + 46 + nlen > (size_t)cd_off + cd_size) {
            *err = "pt: zip: corrupt central directory";
            return 0;
        }
        e[i].name = (const char *)(z + p + 46);
        e[i].name_len = (int)nlen;
        if (method != 0 || csize != usize) {
            *err = "pt: zip: a compressed entry (torch.save stores them uncompressed)";
            return 0;
        }
        if ((uint64_t)loc + 30 > len || le32(z + loc) != 0x04034b50) {
            *err = "pt: zip: corrupt local header";
            return 0;
        }
        const uint64_t data = (uint64_t)loc + 30 + le16(z + loc + 26) + le16(z + loc + 28);
        if (data + csize > len) {
            *err = "pt: zip: an entry runs past the end of the file";
            return 0;
        }
        e[i].data = z + data;
        e[i].size = csize;
        p += 46 + (size_t)nlen + xlen + clen;
    }
    *out = e;
    *count = (int)n;
    return 1;
}

static int str_eq(const char *a, int alen, const char *b, int blen) {
    return alen == blen && ac_memeq(a, b, (size_t)alen);
}

static int cstr_len(const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}

/* ── the pickle machine ──────────────────────────────────────────────────── */

enum { V_NONE, V_BOOL, V_INT, V_FLOAT, V_STR, V_TUPLE, V_DICT, V_MARK, V_GLOBAL, V_STORAGE, V_TENSOR };

typedef struct val val;
struct val {
    int type;
    int64_t i;               /* V_INT, V_BOOL */
    const char *s, *s2;      /* V_STR: s; V_GLOBAL: module s, name s2; V_STORAGE: kind s, key s2 */
    int slen, s2len;
    int n;                   /* V_TUPLE / V_DICT: items (a dict holds 2n: key, value, ...) */
    int cap;
    val **items;
    val *storage;            /* V_TENSOR */
    int64_t offset;          /* V_TENSOR */
    int ndim;                /* V_TENSOR */
    int64_t size[8], stride[8];
};

typedef struct {
    const uint8_t *b;
    size_t len, pos;
    val **stack;
    int sp, cap;
    val **memo;
    uint32_t memo_cap;
    const char *err;
} pk;

#define FAIL(msg)        \
    do {                 \
        P->err = (msg);  \
        return 0;        \
    } while (0)

static val *mk(pk *P, int type) {
    val *v = ac_alloc(sizeof(val));
    if (!v) {
        P->err = "pt: out of memory";
        return 0;
    }
    v->type = type;
    return v;
}

static int push(pk *P, val *v) {
    if (!v) return 0;
    if (P->sp == P->cap) FAIL("pt: pickle stack too deep");
    P->stack[P->sp++] = v;
    return 1;
}

static val *pop(pk *P) {
    if (P->sp == 0) {
        P->err = "pt: pickle stack underflow";
        return 0;
    }
    return P->stack[--P->sp];
}

static const uint8_t *need(pk *P, size_t n) {
    if (P->pos + n > P->len || P->pos + n < P->pos) {
        P->err = "pt: truncated pickle";
        return 0;
    }
    const uint8_t *s = P->b + P->pos;
    P->pos += n;
    return s;
}

static int read_line(pk *P, const char **s, int *len) {
    size_t i = P->pos;
    while (i < P->len && P->b[i] != '\n') i++;
    if (i >= P->len) FAIL("pt: truncated pickle");
    *s = (const char *)(P->b + P->pos);
    *len = (int)(i - P->pos);
    P->pos = i + 1;
    return 1;
}

/* The items above the topmost mark, as a fresh tuple; the mark is popped. */
static val *pop_mark(pk *P) {
    int i = P->sp - 1;
    while (i >= 0 && P->stack[i]->type != V_MARK) i--;
    if (i < 0) {
        P->err = "pt: pickle mark not found";
        return 0;
    }
    val *t = mk(P, V_TUPLE);
    if (!t) return 0;
    t->n = P->sp - i - 1;
    t->items = ac_alloc(sizeof(val *) * (size_t)(t->n ? t->n : 1));
    if (!t->items) {
        P->err = "pt: out of memory";
        return 0;
    }
    for (int k = 0; k < t->n; k++) t->items[k] = P->stack[i + 1 + k];
    P->sp = i;
    return t;
}

static int dict_set(pk *P, val *d, val *k, val *v) {
    /* Keys are the tensor names; a repeated key replaces, as a Python dict does. */
    for (int i = 0; i < d->n; i++) {
        val *e = d->items[2 * i];
        if (e->type == V_STR && k->type == V_STR && str_eq(e->s, e->slen, k->s, k->slen)) {
            d->items[2 * i + 1] = v;
            return 1;
        }
    }
    if (d->n == d->cap) {
        const int cap = d->cap ? 2 * d->cap : 64;
        val **items = ac_alloc(sizeof(val *) * 2 * (size_t)cap);
        if (!items) FAIL("pt: out of memory");
        for (int i = 0; i < 2 * d->n; i++) items[i] = d->items[i];
        d->items = items; /* the old array stays in the arena until the load ends */
        d->cap = cap;
    }
    d->items[2 * d->n] = k;
    d->items[2 * d->n + 1] = v;
    d->n++;
    return 1;
}

static int memo_put(pk *P, uint32_t idx, val *v) {
    if (idx >= (1u << 20)) FAIL("pt: pickle memo index out of range");
    if (idx >= P->memo_cap) {
        uint32_t cap = P->memo_cap ? P->memo_cap : 256;
        while (cap <= idx) cap *= 2;
        val **m = ac_alloc(sizeof(val *) * cap);
        if (!m) FAIL("pt: out of memory");
        for (uint32_t i = 0; i < P->memo_cap; i++) m[i] = P->memo[i];
        P->memo = m;
        P->memo_cap = cap;
    }
    P->memo[idx] = v;
    return 1;
}

static val *memo_get(pk *P, uint32_t idx) {
    if (idx >= P->memo_cap || !P->memo[idx]) {
        P->err = "pt: pickle get of an unknown memo";
        return 0;
    }
    return P->memo[idx];
}

static int is_global(const val *v, const char *mod, const char *name) {
    return v && v->type == V_GLOBAL && str_eq(v->s, v->slen, mod, cstr_len(mod)) &&
           str_eq(v->s2, v->s2len, name, cstr_len(name));
}

static int ints(const val *v, int64_t *out, int *n) {
    if (!v || v->type != V_TUPLE || v->n > 8) return 0;
    for (int i = 0; i < v->n; i++) {
        if (v->items[i]->type != V_INT) return 0;
        out[i] = v->items[i]->i;
    }
    *n = v->n;
    return 1;
}

static val *unpickle(pk *P) {
    for (;;) {
        const uint8_t *op = need(P, 1);
        if (!op) return 0;
        const uint8_t *a;
        val *v;
        switch (*op) {
        case 0x80: /* PROTO */
            if (!need(P, 1)) return 0;
            break;
        case '}': /* EMPTY_DICT */
            if (!push(P, mk(P, V_DICT))) return 0;
            break;
        case ')': /* EMPTY_TUPLE */
            if (!push(P, mk(P, V_TUPLE))) return 0;
            break;
        case '(': /* MARK */
            if (!push(P, mk(P, V_MARK))) return 0;
            break;
        case 'N': /* NONE */
            if (!push(P, mk(P, V_NONE))) return 0;
            break;
        case 0x88: /* NEWTRUE */
        case 0x89: /* NEWFALSE */
            if (!(v = mk(P, V_BOOL))) return 0;
            v->i = *op == 0x88;
            if (!push(P, v)) return 0;
            break;
        case 'K': /* BININT1 */
            if (!(a = need(P, 1)) || !(v = mk(P, V_INT))) return 0;
            v->i = a[0];
            if (!push(P, v)) return 0;
            break;
        case 'M': /* BININT2 */
            if (!(a = need(P, 2)) || !(v = mk(P, V_INT))) return 0;
            v->i = le16(a);
            if (!push(P, v)) return 0;
            break;
        case 'J': /* BININT */
            if (!(a = need(P, 4)) || !(v = mk(P, V_INT))) return 0;
            v->i = (int32_t)le32(a);
            if (!push(P, v)) return 0;
            break;
        case 0x8a: { /* LONG1 */
            const uint8_t *n = need(P, 1);
            if (!n || !(a = need(P, n[0]))) return 0;
            if (n[0] > 8) {
                P->err = "pt: integer too large";
                return 0;
            }
            uint64_t x = 0;
            for (int i = n[0] - 1; i >= 0; i--) x = x << 8 | a[i];
            int64_t sx = (int64_t)x;
            if (n[0] > 0 && n[0] < 8 && (a[n[0] - 1] & 0x80)) sx -= (int64_t)1 << (8 * n[0]);
            if (!(v = mk(P, V_INT))) return 0;
            v->i = sx;
            if (!push(P, v)) return 0;
            break;
        }
        case 'G': /* BINFLOAT, big-endian; only ever metadata here, so its value is not kept */
            if (!need(P, 8) || !push(P, mk(P, V_FLOAT))) return 0;
            break;
        case 'X': { /* BINUNICODE */
            const uint8_t *n = need(P, 4);
            if (!n) return 0;
            const uint32_t len = le32(n);
            if (!(a = need(P, len)) || !(v = mk(P, V_STR))) return 0;
            v->s = (const char *)a;
            v->slen = (int)len;
            if (!push(P, v)) return 0;
            break;
        }
        case 'c': /* GLOBAL */
            if (!(v = mk(P, V_GLOBAL))) return 0;
            if (!read_line(P, &v->s, &v->slen) || !read_line(P, &v->s2, &v->s2len) || !push(P, v)) return 0;
            break;
        case 'q': /* BINPUT */
            if (!(a = need(P, 1))) return 0;
            if (P->sp == 0) {
                P->err = "pt: BINPUT on empty stack";
                return 0;
            }
            if (!memo_put(P, a[0], P->stack[P->sp - 1])) return 0;
            break;
        case 'r': /* LONG_BINPUT */
            if (!(a = need(P, 4))) return 0;
            if (P->sp == 0) {
                P->err = "pt: LONG_BINPUT on empty stack";
                return 0;
            }
            if (!memo_put(P, le32(a), P->stack[P->sp - 1])) return 0;
            break;
        case 'h': /* BINGET */
            if (!(a = need(P, 1)) || !push(P, memo_get(P, a[0]))) return 0;
            break;
        case 'j': /* LONG_BINGET */
            if (!(a = need(P, 4)) || !push(P, memo_get(P, le32(a)))) return 0;
            break;
        case 't': /* TUPLE */
            if (!push(P, pop_mark(P))) return 0;
            break;
        case 0x85: /* TUPLE1 */
        case 0x86: /* TUPLE2 */
        case 0x87: { /* TUPLE3 */
            const int n = *op - 0x85 + 1;
            if (P->sp < n) {
                P->err = "pt: pickle stack underflow";
                return 0;
            }
            if (!(v = mk(P, V_TUPLE))) return 0;
            v->n = n;
            if (!(v->items = ac_alloc(sizeof(val *) * (size_t)n))) {
                P->err = "pt: out of memory";
                return 0;
            }
            for (int i = 0; i < n; i++) v->items[i] = P->stack[P->sp - n + i];
            P->sp -= n;
            if (!push(P, v)) return 0;
            break;
        }
        case 'Q': { /* BINPERSID: ('storage', torch.<Kind>Storage, key, location, numel) */
            val *pid = pop(P);
            if (!pid) return 0;
            if (pid->type != V_TUPLE || pid->n < 5) {
                P->err = "pt: unexpected persistent id";
                return 0;
            }
            val *tag = pid->items[0], *g = pid->items[1], *key = pid->items[2];
            if (tag->type != V_STR || !str_eq(tag->s, tag->slen, "storage", 7) || g->type != V_GLOBAL ||
                !str_eq(g->s, g->slen, "torch", 5) || key->type != V_STR || key->slen == 0) {
                P->err = "pt: unexpected persistent id";
                return 0;
            }
            if (!(v = mk(P, V_STORAGE))) return 0;
            v->s = g->s2;
            v->slen = g->s2len;
            v->s2 = key->s;
            v->s2len = key->slen;
            if (!push(P, v)) return 0;
            break;
        }
        case 'R': { /* REDUCE */
            val *args = pop(P);
            val *fn = args ? pop(P) : 0;
            if (!fn) return 0;
            if (is_global(fn, "collections", "OrderedDict")) {
                if (!push(P, mk(P, V_DICT))) return 0;
            } else if (is_global(fn, "torch._utils", "_rebuild_tensor_v2")) {
                if (args->type != V_TUPLE || args->n < 4 || args->items[0]->type != V_STORAGE ||
                    args->items[1]->type != V_INT) {
                    P->err = "pt: bad _rebuild_tensor_v2 call";
                    return 0;
                }
                if (!(v = mk(P, V_TENSOR))) return 0;
                int ns, nt;
                v->storage = args->items[0];
                v->offset = args->items[1]->i;
                if (!ints(args->items[2], v->size, &ns) || !ints(args->items[3], v->stride, &nt) || ns != nt) {
                    P->err = "pt: bad _rebuild_tensor_v2 call";
                    return 0;
                }
                v->ndim = ns;
                if (!push(P, v)) return 0;
            } else if (fn->type == V_GLOBAL) {
                P->err = "pt: unsupported call in the pickle";
                return 0;
            } else {
                P->err = "pt: unsupported call in the pickle";
                return 0;
            }
            break;
        }
        case 's': { /* SETITEM */
            val *x = pop(P);
            val *k = x ? pop(P) : 0;
            if (!k) return 0;
            if (P->sp == 0) {
                P->err = "pt: SETITEM without a dict";
                return 0;
            }
            val *d = P->stack[P->sp - 1];
            if (d->type != V_DICT) {
                P->err = "pt: SETITEM on a non-dict";
                return 0;
            }
            if (!dict_set(P, d, k, x)) return 0;
            break;
        }
        case 'u': { /* SETITEMS */
            val *t = pop_mark(P);
            if (!t) return 0;
            if (P->sp == 0 || (t->n & 1)) {
                P->err = "pt: bad SETITEMS";
                return 0;
            }
            val *d = P->stack[P->sp - 1];
            if (d->type != V_DICT) {
                P->err = "pt: SETITEMS on a non-dict";
                return 0;
            }
            for (int i = 0; i < t->n; i += 2)
                if (!dict_set(P, d, t->items[i], t->items[i + 1])) return 0;
            break;
        }
        case 'b': /* BUILD: state for the object below; a state dict's is metadata */
            if (!pop(P)) return 0;
            break;
        case '.': /* STOP */
            return pop(P);
        default:
            P->err = "pt: unsupported pickle opcode";
            return 0;
        }
    }
}

/* ── the state dict ──────────────────────────────────────────────────────── */

static const zentry *zfind(const zentry *e, int n, const char *prefix, int plen, const char *name, int nlen) {
    for (int i = 0; i < n; i++) {
        if (e[i].name_len == plen + nlen && ac_memeq(e[i].name, prefix, (size_t)plen) &&
            ac_memeq(e[i].name + plen, name, (size_t)nlen))
            return &e[i];
    }
    return 0;
}

const pt_dict *pt_read(const uint8_t *pt, size_t len, const char **err) {
    zentry *ze;
    int nz;
    if (!zip_entries(pt, len, &ze, &nz, err)) return 0;

    const zentry *pkl = 0;
    for (int i = 0; i < nz; i++) {
        if (ze[i].name_len >= 9 && ac_memeq(ze[i].name + ze[i].name_len - 9, "/data.pkl", 9)) {
            pkl = &ze[i];
            break;
        }
    }
    if (!pkl) {
        *err = "pt: no data.pkl (not a zip-format torch.save file)";
        return 0;
    }
    const char *prefix = pkl->name;
    const int plen = pkl->name_len - 8; /* keeps the trailing slash */

    const zentry *bo = zfind(ze, nz, prefix, plen, "byteorder", 9);
    if (bo) {
        int n = (int)bo->size;
        while (n > 0 && (bo->data[n - 1] == '\n' || bo->data[n - 1] == ' ' || bo->data[n - 1] == '\r')) n--;
        if (!str_eq((const char *)bo->data, n, "little", 6)) {
            *err = "pt: byte order not supported";
            return 0;
        }
    }

    pk P = {0};
    P.b = pkl->data;
    P.len = pkl->size;
    P.cap = 1 << 16;
    P.stack = ac_alloc(sizeof(val *) * (size_t)P.cap);
    if (!P.stack) {
        *err = "pt: out of memory";
        return 0;
    }
    val *root = unpickle(&P);
    if (!root) {
        *err = P.err ? P.err : "pt: bad pickle";
        return 0;
    }
    if (root->type != V_DICT) {
        *err = "pt: the pickle is not a state dict";
        return 0;
    }

    pt_dict *d = ac_alloc(sizeof(pt_dict));
    if (!d || !(d->t = ac_alloc(sizeof(pt_tensor) * (size_t)(root->n ? root->n : 1)))) {
        *err = "pt: out of memory";
        return 0;
    }
    for (int i = 0; i < root->n; i++) {
        const val *k = root->items[2 * i], *v = root->items[2 * i + 1];
        if (k->type != V_STR || k->slen == 0 || v->type != V_TENSOR) continue;
        const val *st = v->storage;
        /* Integer tensors (BatchNorm's num_batches_tracked) are skipped. */
        if (!str_eq(st->s, st->slen, "FloatStorage", 12)) continue;
        if (st->s2len > 200) {
            *err = "pt: storage key too long";
            return 0;
        }
        char key[208];
        memcpy(key, "data/", 5);
        memcpy(key + 5, st->s2, (size_t)st->s2len);
        const zentry *se = zfind(ze, nz, prefix, plen, key, 5 + st->s2len);
        if (!se) {
            *err = "pt: a tensor's storage is missing";
            return 0;
        }
        pt_tensor *t = &d->t[d->n];
        int64_t numel = 1;
        for (int j = 0; j < v->ndim; j++) {
            if (v->size[j] < 0 || v->size[j] > (1 << 28)) {
                *err = "pt: a tensor's shape is out of range";
                return 0;
            }
            numel *= v->size[j];
            if (numel > (1 << 28)) {
                *err = "pt: a tensor's shape is out of range";
                return 0;
            }
            t->shape[j] = (int)v->size[j];
        }
        /* Contiguous row-major only: every tensor in a saved state dict is. */
        int64_t want = 1;
        for (int j = v->ndim - 1; j >= 0; j--) {
            if (v->size[j] != 1 && v->stride[j] != want) {
                *err = "pt: a tensor is not contiguous";
                return 0;
            }
            want *= v->size[j];
        }
        if (v->offset < 0 || (uint64_t)(v->offset + numel) * 4 > se->size) {
            *err = "pt: a tensor runs past its storage";
            return 0;
        }
        t->name = k->s;
        t->name_len = k->slen;
        t->ndim = v->ndim;
        t->numel = (int)numel;
        t->data = se->data + v->offset * 4;
        d->n++;
    }
    return d;
}

const pt_tensor *pt_find(const pt_dict *d, const char *name) {
    const int n = cstr_len(name);
    for (int i = 0; i < d->n; i++)
        if (str_eq(d->t[i].name, d->t[i].name_len, name, n)) return &d->t[i];
    return 0;
}
