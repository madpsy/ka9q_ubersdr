/*
 * shim.c - the freestanding runtime: memory and the three mem* functions the
 * compiler may call on its own. No libc is linked, so the module imports
 * nothing and instantiates with an empty import object.
 *
 * The allocator is deliberately small, because what it serves is small: codec
 * structs, all one size, and a handful of scratch buffers in api.c that only
 * ever grow, by doubling. Memory comes from a bump pointer that starts at the
 * linker's __heap_base and grows the WebAssembly memory a page at a time when
 * it runs out. A freed block goes on a free list and is handed back to the
 * next request of exactly the same rounded size, which is every codec after
 * the first; a scratch buffer outgrown by doubling is left on the list, so the
 * waste is bounded by the size of the largest buffer. Memory is never returned
 * to the host, which WebAssembly cannot do anyway.
 */
#include "pcmv4.h"

extern unsigned char __heap_base;

typedef struct free_block {
    struct free_block *next;
    size_t size;
} free_block;

static uintptr_t g_brk;
static free_block *g_free;

#define PAGE 65536u

static size_t round16(size_t n) { return (n + 15) & ~(size_t)15; }

void *pv4_alloc(size_t n) {
    if (n == 0) n = 16;
    n = round16(n);
    for (free_block **pp = &g_free; *pp; pp = &(*pp)->next) {
        if ((*pp)->size == n) {
            free_block *b = *pp;
            *pp = b->next;
            memset(b, 0, n);
            return b;
        }
    }
    if (!g_brk) g_brk = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
    const uintptr_t start = g_brk;
    if (n > (uintptr_t)0 - start) return 0;
    const uintptr_t end = start + n;
    const uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) * PAGE;
    if (end > have) {
        const uintptr_t pages = (end - have + PAGE - 1) / PAGE;
        if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
    }
    g_brk = end;
    /* Nothing has ever been written above the break -- the stack is below the
     * data (build.sh links with --stack-first) -- so this block is still the
     * zero the memory was created or grown with. */
    return (void *)start;
}

void pv4_free(void *p, size_t n) {
    if (!p) return;
    free_block *b = p;
    b->size = round16(n ? n : 16);
    b->next = g_free;
    g_free = b;
}

/* Plain loops. -ffreestanding (and build.sh's -fno-builtin-mem*) keeps the
 * compiler from recognising them as the very functions they define and
 * compiling them into calls to themselves. memset and memcpy run on codec
 * creation and on the few bytes of input slack; nothing per-sample uses them. */
void *memset(void *d, int c, size_t n) {
    unsigned char *p = d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}

void *memcpy(void *__restrict d, const void *__restrict s, size_t n) {
    unsigned char *p = d;
    const unsigned char *q = s;
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
