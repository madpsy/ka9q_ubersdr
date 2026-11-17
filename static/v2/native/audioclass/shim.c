/*
 * shim.c - the freestanding runtime: memory, and the mem* functions the
 * compiler may call on its own. No libc is linked, so the module imports
 * nothing.
 *
 * Memory is one bump arena from the linker's __heap_base, growing the
 * WebAssembly memory as it needs to. Nothing is freed one block at a time:
 * what is allocated belongs to a region -- the model, the stream, one call --
 * and a region is freed whole by moving the break back to its mark
 * (ac_mark / ac_release). The regions nest in that order, which is the order
 * the page creates them in: load once, reset per stream, scratch per call.
 *
 * Released memory is zeroed again before it is handed out a second time, so
 * every allocation reads as zero, as fresh WebAssembly memory does.
 */
#include "audioclass.h"

extern unsigned char __heap_base;

#define PAGE 65536u

static uintptr_t g_base, g_brk, g_dirty; /* g_dirty: highest address ever handed out */

static void init(void) {
    if (!g_base) {
        g_base = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
        g_brk = g_dirty = g_base;
    }
}

void *ac_alloc(size_t n) {
    init();
    n = (n + 15) & ~(size_t)15;
    if (n == 0) n = 16;
    const uintptr_t start = g_brk;
    if (n > (uintptr_t)0 - start) return 0;
    const uintptr_t end = start + n;
    const uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) * PAGE;
    if (end > have) {
        const uintptr_t pages = (end - have + PAGE - 1) / PAGE;
        if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
    }
    /* Below g_dirty the memory may hold an earlier region's data. */
    if (start < g_dirty) memset((void *)start, 0, (end < g_dirty ? end : g_dirty) - start);
    if (end > g_dirty) g_dirty = end;
    g_brk = end;
    return (void *)start;
}

size_t ac_mark(void) {
    init();
    return g_brk;
}

void ac_release(size_t mark) {
    init();
    if (mark >= g_base && mark <= g_brk) g_brk = mark;
}

/* The compiler is told (build.sh: -fno-builtin-mem*) not to turn these loops
 * into calls to themselves. */
void *memset(void *d, int c, size_t n) {
    unsigned char *p = d;
    if (n >= 16 && ((uintptr_t)p & 3) == 0) {
        const uint32_t v = 0x01010101u * (unsigned char)c;
        uint32_t *w = (uint32_t *)p;
        for (size_t i = 0, m = n / 4; i < m; i++) w[i] = v;
        p += n & ~(size_t)3;
        n &= 3;
    }
    while (n--) *p++ = (unsigned char)c;
    return d;
}

void *memcpy(void *d, const void *s, size_t n) {
    unsigned char *p = d;
    const unsigned char *q = s;
    if (n >= 16 && (((uintptr_t)p | (uintptr_t)q) & 3) == 0) {
        uint32_t *w = (uint32_t *)p;
        const uint32_t *r = (const uint32_t *)q;
        for (size_t i = 0, m = n / 4; i < m; i++) w[i] = r[i];
        p += n & ~(size_t)3;
        q += n & ~(size_t)3;
        n &= 3;
    }
    while (n--) *p++ = *q++;
    return d;
}

void *memmove(void *d, const void *s, size_t n) {
    unsigned char *p = d;
    const unsigned char *q = s;
    if (p < q) {
        while (n--) *p++ = *q++;
    } else if (p > q) {
        p += n;
        q += n;
        while (n--) *--p = *--q;
    }
    return d;
}

int ac_memeq(const void *a, const void *b, size_t n) {
    const unsigned char *p = a, *q = b;
    for (size_t i = 0; i < n; i++)
        if (p[i] != q[i]) return 0;
    return 1;
}
