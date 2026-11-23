/*
 * Reference vectors for the ELAD TM-2 driver (static/v2/src/controls/tm2*.js),
 * produced by the Tmate2_C project's own code rather than restated from it:
 * github.com/microenh/Tmate2_C — tmate2/bitfields.h, tmate2.c and the two
 * *_layout.c font tables, which drive a real TM-2 over hidapi.
 *
 * Regenerate (needs gcc and a Tmate2_C checkout):
 *
 *   T=/path/to/Tmate2_C/tmate2
 *   gcc -mno-ms-bitfields -w -I. -I$T -o /tmp/tm2gen tm2gen.c \
 *       $T/main_layout.c $T/smeter_layout.c
 *   /tmp/tm2gen > ../tm2.tmate2c.json
 *
 * tmate2.c is #included, not linked, so each scenario can start from a zeroed
 * frame: its write buffer is static. -mno-ms-bitfields is what its CMakeLists
 * sets, and is what packs the bitfields the way the device reads them.
 *
 * Output frames are the 44 bytes tmate2.c hands hid_write (report ID 0 first,
 * then the 43-byte report). Input reports are the 9 bytes hid_read returns,
 * built through Tmate2_C's own read_bitfield so the field offsets are its.
 */
#include <stdio.h>
#include <string.h>
#include "hidapi/hidapi.h"
#include "tmate2.c"

hid_device *hid_open(unsigned short v, unsigned short p, const void *s) { return 0; }
int hid_read(hid_device *h, unsigned char *d, int n) { return 0; }
int hid_write(hid_device *h, const unsigned char *d, int n) { return n; }
void hid_close(hid_device *h) {}

static int first = 1;

static void hex(const char *d, int n) {
    for (int i = 0; i < n; i++) printf("%s%02x", i ? " " : "", (unsigned char)d[i]);
}

static void frame(const char *name) {
    printf("%s\n    {\"name\": \"%s\", \"hex\": \"", first ? "" : ",", name);
    hex(write_data.d, 44);
    printf("\"}");
    first = 0;
}

static void reset(void) { memset(&write_data, 0, sizeof write_data); }

static void text(const char *s) {     /* right-aligned in the 9 digits, as tm2frame.js does */
    int n = (int)strlen(s);
    for (int i = 0; i < 9; i++) update_main_digit(i, i < n ? s[n - 1 - i] : ' ');
}

struct input { const char *name; unsigned main, e1, e2; int pressed[9]; };

int main(void) {
    printf("{\n  \"source\": \"Tmate2_C (bitfields.h, tmate2.c, main_layout.c, smeter_layout.c)\",\n");
    printf("  \"outputs\": [");

    reset(); frame("blank");

    /* What init_tmate2() sets before its first write. */
    reset();
    set_rgb(0xff, 0xff, 0xff);
    display_main_number(0);
    main_encoder_setup(1, 100, 1000, 32, 64, 10);
    write_data.w.hz = 1;
    frame("init");

    reset(); display_main_number(7074000); frame("main 7074000");
    reset(); display_main_number(14074000); frame("main 14074000");
    reset(); display_main_number(29999999); frame("main 29999999");
    reset(); display_main_number(198000); frame("main 198000");
    reset(); display_main_number(500); frame("main 500");
    reset(); display_main_number(-1234); frame("main -1234");
    reset(); display_main_number(1000000000); frame("main blank");

    reset(); display_smeter_number(-107); frame("smeter -107");
    reset(); display_smeter_number(42); frame("smeter 42");
    reset(); display_smeter_number(5); frame("smeter 5");
    reset(); display_smeter_number(1000); frame("smeter blank");

    reset(); text("VOL   100"); frame("text VOL   100");
    reset(); text("STEP 1K"); frame("text STEP 1K");
    reset(); text("HI  -2700"); frame("text HI  -2700");
    reset(); text("ABCDEFGHI"); frame("text ABCDEFGHI");
    reset(); text("JKLMNOPQR"); frame("text JKLMNOPQR");
    reset(); text("STUVWXYZ0"); frame("text STUVWXYZ0");

    reset(); set_smeter_graph(1); frame("smeter graph");
    reset(); set_smeter_s(1); frame("smeter s on");
    reset(); set_smeter_s(0); frame("smeter s off");

    reset(); set_rgb(0x12, 0x34, 0x56); set_contrast(77); frame("rgb 123456 contrast 77");
    reset(); main_encoder_setup(1, 2, 5, 32, 64, 10); frame("encoder 1 2 5 32 64");

    reset(); write_data.w.click = 1; frame("click");
    reset(); write_data.w.usb_led = 1; frame("usb led");
    reset(); write_data.w.lock_led = 1; frame("lock led");

    printf("\n  ],\n  \"inputs\": [");
    /* pressed[]: f1..f6, main, e1, e2 — 1 for held down (the bit reads 0). */
    struct input ins[] = {
        { "idle", 0, 0, 0, {0} },
        { "encoders 1000 3000 2000", 1000, 3000, 2000, {0} },
        { "encoders wrapped", 65535, 1, 32768, {0} },
        { "F1 down", 5, 6, 7, {1, 0, 0, 0, 0, 0, 0, 0, 0} },
        { "F6 down", 5, 6, 7, {0, 0, 0, 0, 0, 1, 0, 0, 0} },
        { "main push down", 5, 6, 7, {0, 0, 0, 0, 0, 0, 1, 0, 0} },
        { "E1 push down", 5, 6, 7, {0, 0, 0, 0, 0, 0, 0, 1, 0} },
        { "E2 push down", 5, 6, 7, {0, 0, 0, 0, 0, 0, 0, 0, 1} },
        { "all down", 0x1234, 0x5678, 0x9abc, {1, 1, 1, 1, 1, 1, 1, 1, 1} },
    };
    for (unsigned i = 0; i < sizeof ins / sizeof ins[0]; i++) {
        union read_buffer r;
        memset(&r, 0, sizeof r);
        r.d[0] = 1;   /* "The first byte is a 1" — Tmate2_C's readme */
        r.r.main_encoder = ins[i].main;
        r.r.e1_encoder = ins[i].e1;
        r.r.e2_encoder = ins[i].e2;
        int *p = ins[i].pressed;
        r.r.f1_button = !p[0]; r.r.f2_button = !p[1]; r.r.f3_button = !p[2];
        r.r.f4_button = !p[3]; r.r.f5_button = !p[4]; r.r.f6_button = !p[5];
        r.r.main_button = !p[6]; r.r.e1_button = !p[7]; r.r.e2_button = !p[8];
        printf("%s\n    {\"name\": \"%s\", \"main\": %u, \"e1\": %u, \"e2\": %u, \"pressed\": [",
            i ? "," : "", ins[i].name, ins[i].main, ins[i].e1, ins[i].e2);
        for (int k = 0; k < 9; k++) printf("%s%d", k ? ", " : "", p[k]);
        printf("], \"hex\": \"");
        hex(r.d, 9);
        printf("\"}");
    }
    printf("\n  ]\n}\n");
    return 0;
}
