/*
 * verdict.c - from AudioSet tags to voice / music / noise, as NightDX's
 * classify.py folds the AST model's tags, and as the Go original did:
 * the best voice, music and noise label among the top 40, and the strongest
 * radio-relevant labels among the top five to show beside the verdict.
 *
 * NightDX: github.com/marcozennaro/nightdx, MIT, (c) Marco Zennaro. The
 * labels are the AudioSet ontology's (Google, CC BY 4.0), generated into
 * labels.gen.h from audioset_labels.csv by build.sh.
 */
#include "audioclass.h"
#include "labels.gen.h"

static const char *const VOICE[] = {
    "Speech", "Male speech, man speaking", "Female speech, woman speaking", "Child speech, kid speaking",
    "Conversation", "Narration, monologue", "Speech synthesizer", "Babbling", "Whispering", "Chant", "Mantra",
};

static const char *const MUSIC_HINTS[] = {
    "music", "singing", "song", "guitar", "piano", "drum", "orchestra", "violin", "flute", "trumpet",
    "choir", "synthesizer", "jingle", "instrument", "bass", "beat", "hip hop", "pop", "rock", "jazz",
    "a capella", "sitar", "tabla", "accordion", "organ", "harmonica", "saxophone", "chord",
};

/* Hum and buzz are deliberately absent (NightDX): they ride on top of a
 * programme, and a channel of nothing but hum is noise anyway because no
 * speech or music is found. */
static const char *const NOISE[] = {
    "Static", "Noise", "White noise", "Pink noise", "Hiss", "Environmental noise", "Silence", "Radio",
    "Sine wave", "Electronic tuner", "Beep, bleep", "Rumble", "Distortion", "Tick", "Clicking",
};

/* radioTag's extra lower-case names. */
static const char *const RADIO_LOWER[] = {"speech", "music", "static", "hum", "mains hum", "radio"};

#define N(a) ((int)(sizeof(a) / sizeof((a)[0])))

enum { F_VOICE = 1, F_MUSIC = 2, F_NOISE = 4, F_RADIO = 8 };
static uint8_t g_flags[EAT_CLASSES];
static int g_ready;

static int clen(const char *s) {
    int n = 0;
    while (s[n]) n++;
    return n;
}

static char lower(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c; }

/* Go's strings.ToLower is Unicode-aware; the AudioSet labels' non-ASCII
 * letters (in a few names) are never part of a hint, so ASCII folding finds
 * the same matches. */
static int contains_lower(const char *s, int n, const char *needle) {
    const int m = clen(needle);
    for (int i = 0; i + m <= n; i++) {
        int k = 0;
        while (k < m && lower(s[i + k]) == needle[k]) k++;
        if (k == m) return 1;
    }
    return 0;
}

static int equals(const char *s, int n, const char *t) { return n == clen(t) && ac_memeq(s, t, (size_t)n); }

static int equals_lower(const char *s, int n, const char *t) {
    if (n != clen(t)) return 0;
    for (int i = 0; i < n; i++)
        if (lower(s[i]) != t[i]) return 0;
    return 1;
}

void verdict_init(void) {
    if (g_ready) return;
    for (int i = 0; i < EAT_CLASSES; i++) {
        const char *s = LABELS[i];
        const int n = LABEL_LEN[i];
        uint8_t f = 0;
        for (int k = 0; k < N(VOICE); k++)
            if (equals(s, n, VOICE[k])) f |= F_VOICE;
        for (int k = 0; k < N(MUSIC_HINTS); k++)
            if (contains_lower(s, n, MUSIC_HINTS[k])) f |= F_MUSIC;
        for (int k = 0; k < N(NOISE); k++)
            if (equals(s, n, NOISE[k])) f |= F_NOISE;
        if (f) f |= F_RADIO;
        for (int k = 0; k < N(RADIO_LOWER); k++)
            if (equals_lower(s, n, RADIO_LOWER[k])) f |= F_RADIO;
        g_flags[i] = f;
    }
    g_ready = 1;
}

const char *label_name(int i, int *len) {
    if (i < 0 || i >= EAT_CLASSES) {
        *len = 0;
        return "";
    }
    *len = LABEL_LEN[i];
    return LABELS[i];
}

#define MIN_SCORE 0.12 /* NightDX's floor: neither voice nor music this likely means noise */

void verdict_fold(const float *probs, ac_result *res) {
    verdict_init();
    /* The top 40, strongest first; ties keep the lower index first, as Go's
     * stable sort does. */
    int top[40];
    static uint8_t taken[EAT_CLASSES];
    for (int i = 0; i < EAT_CLASSES; i++) taken[i] = 0;
    for (int r = 0; r < 40; r++) {
        int best = -1;
        for (int i = 0; i < EAT_CLASSES; i++)
            if (!taken[i] && (best < 0 || probs[i] > probs[best])) best = i;
        top[r] = best;
        taken[best] = 1;
    }
    double v = 0, m = 0, z = 0;
    for (int r = 0; r < 40; r++) {
        const int i = top[r];
        const double p = (double)probs[i];
        if ((g_flags[i] & F_VOICE) && p > v) v = p;
        if ((g_flags[i] & F_MUSIC) && p > m) m = p;
        if ((g_flags[i] & F_NOISE) && p > z) z = p;
    }
    const double best = v > m ? v : m;
    double conf;
    if (best < MIN_SCORE || z > 1.5 * best) {
        res->label = LABEL_NOISE;
        conf = z > 1 - best ? z : 1 - best;
    } else if (v >= m) {
        res->label = LABEL_VOICE;
        conf = v;
    } else {
        res->label = LABEL_MUSIC;
        conf = m;
    }
    res->confidence = go_round(conf * 1000) / 1000;
    res->ntags = 0;
    for (int r = 0; r < 5; r++) {
        const int i = top[r];
        if (g_flags[i] & F_RADIO) {
            res->tag[res->ntags] = i;
            res->score[res->ntags] = go_round((double)probs[i] * 1000) / 1000;
            res->ntags++;
        }
    }
}
