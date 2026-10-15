package org.ubersdr.mobile;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;
import android.util.Log;

import androidx.annotation.RequiresApi;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.FileDescriptor;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Speech-to-text on the device, for v2's Whisper extension in local mode.
 *
 * <p>The page transcribes the <em>receiver's</em> audio, not the microphone: it
 * taps its own audio graph before the volume and the mute, resamples to 16 kHz
 * mono PCM16 and pushes it here about ten times a second (the contract is at
 * the top of static/v2/src/extensions/whisper/engines/host.js, the messages
 * that carry it in src/hostspeech.js). Android's WebView has no Web Speech
 * recogniser at all, so without this there is no local mode on the phone. The
 * iOS half is OnDeviceSpeech.swift, and this answers the same messages with
 * the same meanings.
 *
 * <p>Three rules, each a promise the page makes to the person using it:
 *
 * <ul>
 *   <li><b>Never the network.</b> {@code createOnDeviceSpeechRecognizer} and
 *       nothing else: there is no fallback to the ordinary recogniser, which
 *       may be a cloud service. A language that is not installed on the device
 *       is refused at Start.
 *   <li><b>Never the microphone.</b> The audio goes in through a pipe, as
 *       {@code EXTRA_AUDIO_SOURCE}. The app does not declare RECORD_AUDIO, and
 *       that is deliberate rather than an omission: a recogniser that ignored
 *       the pipe and went to the microphone instead would be transcribing the
 *       room. Without the permission it cannot — it fails, and the failure says
 *       what happened (see {@link #fatal}).
 *   <li><b>Never a loop of errors.</b> A session that ends by itself is started
 *       again quietly; one that fails at once, repeatedly, gives up and says so.
 * </ul>
 *
 * <p>Android 13 (API 33) is the floor, because that is where a recogniser
 * learned to take its audio from a file descriptor and to run as a segmented
 * session. Below it ReceiverActivity does not set the page's {@code sttHost}
 * flag, and the page offers what it offered before.
 *
 * <p>What the recogniser actually does, measured on a Pixel 8a (the service is
 * Google's, in com.google.android.as) — and most of it is not what the
 * documentation would lead you to expect:
 *
 * <ul>
 *   <li>Run as a <em>segmented</em> session, it reads the pipe for as long as
 *       the pipe is open, says {@code onSegmentResults} for each stretch of
 *       speech (a third of a second to a second after it ends), and calls
 *       {@code onEndOfSegmentedSession} only when the pipe closes. Unbroken
 *       talk is cut into segments of about a minute, without losing audio. An
 *       ordinary session was less steady: one stalled reading the pipe for four
 *       seconds.
 *   <li>Partial results arrive about every 100 ms, each the whole hypothesis
 *       for the utterance in progress — which is exactly the page's
 *       {@code final: false}.
 *   <li>In an ordinary session the <em>final</em> hypothesis arrives as a
 *       partial carrying {@code final_result=true}, and {@code onResults} is
 *       then called with a null Bundle. So finals are taken from either place,
 *       and from segment results, and never sent twice (see {@link #settle}).
 *   <li>A cold start — the first session after the phone boots or the app is
 *       installed, and often the first after a few idle minutes — spends
 *       six to twelve seconds getting ready and reads nothing meanwhile —
 *       though it may well say it is ready for speech straight away. The page
 *       shows "starting" until {@code stt-started}, which is sent when the
 *       recogniser says it is listening; and the pipe is fed from its own
 *       thread through a bounded queue, so a recogniser that is not reading
 *       holds the audio back, and past a limit loses the oldest of it, rather
 *       than holding up the WebView. Neither end calls the wait a failure.
 * </ul>
 *
 * <p>Everything here runs on the main thread — the page's messages arrive
 * there, and SpeechRecognizer insists on it for its own calls and callbacks —
 * except the writing of the pipe, which is the {@link Feeder}'s.
 */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
final class Recognition {

    private static final String TAG = "UberSDR";

    /** Where replies go, already in the host channel's `prefix:payload` form. */
    interface Sink {
        void send(String message);
    }

    static final int RATE = 16000;

    /**
     * Whether the page should be told there is a recogniser — the `sttHost`
     * flag, which has to be decided at document start, synchronously.
     *
     * <p>Which languages are installed is only known asynchronously
     * ({@code checkRecognitionSupport}), so this is the cheaper question: is
     * there an on-device recognition service at all. The list comes later,
     * from {@link #languages}, and an empty one is the page's cue to say there
     * are none.
     */
    static boolean offered(Context context) {
        try {
            return SpeechRecognizer.isOnDeviceRecognitionAvailable(context);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not ask for an on-device recogniser", e);
            return false;
        }
    }

    // About four seconds of audio, once a session is reading. Room for the
    // gap while a session is replaced (a retune, or one that ended by itself),
    // which is a fraction of a second; a recogniser further behind than this
    // is not going to catch up, and audio that old would only put the
    // transcript further behind the receiver. The pipe's own buffer, 64 KB, is
    // two seconds more.
    static final int QUEUE_BYTES = RATE * 2 * 4;
    // Fifteen seconds, until it is. A cold start says it is ready at once and
    // then reads nothing for six to twelve seconds; kept, that audio is read
    // when the recogniser gets going — faster than it was spoken, so the
    // transcript catches up within a few lines — rather than the first thing
    // anybody transcribes after a reboot starting halfway through a sentence.
    // As the backlog drains the queue shrinks back to QUEUE_BYTES (see
    // Feeder.offer).
    static final int WARM_BYTES = RATE * 2 * 15;
    // How long a recogniser gets to say it is listening before the start is
    // called a failure. Longer than the twelve seconds a cold start was
    // measured at, shorter than the page's own minute (hostspeech.js
    // TIMEOUTS.startMs), so the page is told why rather than that nothing
    // answered.
    private static final long READY_MS = 45000;
    // How long the installed-languages check may take before Start carries on
    // without it and lets the recogniser be the judge.
    private static final long CHECK_MS = 5000;
    // How long after a recogniser is destroyed before the next one starts.
    // See quietUntil.
    private static final long QUIET_MS = 250;
    // A session that ends within this long of starting, having heard nothing,
    // counts as a strike; this many in a row and it gives up. As iOS.
    private static final long QUICK_FAILURE_MS = 1500;
    private static final int MAX_STRIKES = 5;

    // Where a final came from, for telling a duplicate apart from the next line.
    private static final int FROM_PARTIAL = 1;
    private static final int FROM_SEGMENT = 2;
    private static final int FROM_RESULTS = 3;
    private static final int FROM_END = 4;
    private static final int FROM_RESTART = 5;
    // How long a line the recogniser has moved on from waits for its own
    // final before it is settled as last heard. Most such finals came within
    // two and a half seconds of the next line's first words; waiting for the
    // stragglers would freeze the page's live line for as long.
    private static final long PENDING_MS = 3000;

    // The key the Pixel's recogniser marks a final partial with. Not an SDK
    // constant.
    private static final String FINAL_RESULT = "final_result";

    private final Context context;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final int queueBytes;

    /** One recogniser session: its recogniser, its pipe, its writer. */
    private static final class Native {
        final int gen;
        long began = SystemClock.elapsedRealtime();
        SpeechRecognizer recognizer;
        ParcelFileDescriptor readEnd;
        Feeder feeder;
        /** The recogniser has shown it is taking audio: a level, speech, text. */
        boolean reading;
        boolean heard;

        void reading() {
            if (reading) return;
            reading = true;
            if (feeder != null) feeder.settle();
            Log.i(TAG, "stt: session " + gen + " reading after " + (SystemClock.elapsedRealtime() - began) + " ms");
        }

        Native(int gen) {
            this.gen = gen;
        }
    }

    /** The page's session, or -1. Every reply carries it. */
    private int session = -1;
    private String lang = "";
    private int gen;
    private Native current;
    private int strikes;
    /** stt-started has yet to be sent for this session. */
    private boolean starting;
    private boolean fellBehind;
    private boolean warmingDrop;
    /** The recogniser produced text at some point in this page session. */
    private boolean everHeard;
    private boolean visible = true;

    // The utterance in progress, as the page last saw it.
    private String interim = "";
    /** An interim has been sent since the last final: an utterance is open. */
    private boolean open;
    private String lastFinal = "";
    private int lastFinalFrom;
    /**
     * A line the recogniser moved on from without settling, whose final is
     * still expected — see {@link #hypothesis} — and the newer line's latest
     * interim, held back until that final has come.
     */
    private String pending;
    private String held;
    /** The last few lines settled, for knowing one that arrives twice. */
    private final ArrayDeque<String> recent = new ArrayDeque<>();
    private final Runnable pendingTimeout = () -> {
        if (pending != null) givePending();
    };

    private final Runnable readyTimeout = () -> {
        if (session < 0 || !starting) return;
        failStart("start-failed", "the phone's recogniser didn't get ready");
    };
    private final Runnable relaunch = this::launch;
    /**
     * When the last recogniser to be destroyed has had time to go. A new one
     * started sooner sometimes fails at once with "server disconnected": the
     * old one's cancel and destroy travel to the service over their own
     * connection, and one that lands after the new session has begun can take
     * that session with it. Seen on the Pixel three times in a handful of
     * runs — at the start, beside the language check's recogniser, and on a
     * retune — and not since this gap.
     */
    private long quietUntil;

    /** The installed languages last reported, for when a check fails. */
    private static List<String> lastInstalled;

    Recognition(Context context, Sink sink) {
        this(context, sink, QUEUE_BYTES);
    }

    /** With a queue of another size — for the instrumentation test. */
    Recognition(Context context, Sink sink, int queueBytes) {
        this.context = context.getApplicationContext();
        this.sink = sink;
        this.queueBytes = queueBytes;
    }

    // ---- from the page -----------------------------------------------------

    /**
     * The languages installed for recognition on the device — not the ones it
     * could do with a download, and not the ones the network could.
     *
     * <p>Asked of a recogniser made for the purpose. It is the same service the
     * session uses, so the answer is about the thing that will do the work.
     */
    void languages() {
        checkSupport(null, (installed) -> reply("stt-languages", new JSONArray(installed)));
    }

    void start(int id, String language, int sampleRate) {
        teardown();
        session = id;
        lang = language == null ? "" : language;
        strikes = 0;
        starting = true;
        fellBehind = false;
        warmingDrop = false;
        everHeard = false;
        forget();
        if (sampleRate != RATE) {
            failStart("start-failed", "the app takes 16 kHz audio, and was offered " + sampleRate + " Hz");
            return;
        }
        main.postDelayed(readyTimeout, READY_MS);
        checkSupport(lang, (installed) -> {
            if (session != id) return;
            // Refused here rather than left to the recogniser, which might
            // otherwise be the one to decide what "on the device" means for a
            // language it does not have. An empty list is a check that told
            // us nothing, not a device with no languages — the page asked for
            // the list first and only offers what was on it.
            if (!installed.isEmpty() && !contains(installed, lang)) {
                failStart("language-not-supported", lang + " can't be recognised on this phone.");
                return;
            }
            launch();
        });
    }

    /**
     * One push: base64 of little-endian Int16 at 16 kHz, mono, already in the
     * byte order the recogniser was told to expect.
     *
     * <p>Decoded here and handed to the writer, which is all the main thread
     * does with it. Audio that arrives with no session to take it — between a
     * session ending and the next starting — is dropped.
     */
    void push(int id, String base64) {
        if (session != id || current == null || current.feeder == null) return;
        byte[] pcm;
        try {
            pcm = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return;
        }
        if (pcm.length < 2) return;
        if (!current.feeder.offer(pcm)) return;
        // Something was dropped to make room.
        if (!current.reading) {
            // A recogniser still getting ready — a cold start that has gone on
            // longer than WARM_BYTES — rather than one falling behind. Not
            // worth a note: it has not started transcribing yet, and will
            // read what is left when it does.
            if (!warmingDrop) Log.i(TAG, "stt: the recogniser is not reading yet; dropping the oldest audio");
            warmingDrop = true;
            return;
        }
        if (fellBehind) return;
        fellBehind = true;
        Log.w(TAG, "stt: the recogniser fell behind; dropping the oldest audio");
        error("falling-behind", "On-device recognition fell behind the receiver's audio, so some of it was skipped.",
                false);
    }

    /**
     * The receiver has been retuned: forget the line in progress, unreported,
     * and carry on. The session is replaced rather than told, because
     * forgetting is not something a recogniser can be asked to do — and the
     * audio already queued for it is from the frequency the operator has just
     * left.
     */
    void reset(int id) {
        if (session != id) return;
        forget();
        if (current == null) return;
        Native old = current;
        current = null;
        dispose(old);
        main.removeCallbacks(relaunch);
        launch();
    }

    void stop(int id) {
        if (session != id) return;
        teardown();
    }

    /** The page has gone, or the receiver is closing, whatever the page last said. */
    void stopAll() {
        teardown();
    }

    /**
     * Whether the receiver is on screen. Recognition carries on behind the lock
     * screen — the playback service keeps the process and the page running —
     * but an error there is not retried: see {@link #ended}.
     */
    void setVisible(boolean visible) {
        this.visible = visible;
    }

    // ---- sessions ----------------------------------------------------------

    private void launch() {
        if (session < 0) return;
        main.removeCallbacks(relaunch);
        if (current != null) {
            Native old = current;
            current = null;
            dispose(old);
        }
        final Native n = new Native(++gen);
        current = n;
        ParcelFileDescriptor[] pipe;
        try {
            pipe = ParcelFileDescriptor.createPipe();
        } catch (IOException e) {
            Log.w(TAG, "stt: no pipe", e);
            end("start-failed", "the app couldn't open a pipe to the recogniser");
            return;
        }
        n.readEnd = pipe[0];
        try {
            n.feeder = new Feeder(pipe[1], queueBytes, Math.max(queueBytes, WARM_BYTES));
        } catch (ErrnoException e) {
            Log.w(TAG, "stt: the pipe would not go non-blocking", e);
            closeQuietly(pipe[1]);
            end("start-failed", "the app couldn't set up the pipe to the recogniser");
            return;
        }
        n.feeder.start();

        // The pipe and its queue exist from here, so the page's audio is kept
        // while the recogniser waits its turn.
        long wait = quietUntil - SystemClock.elapsedRealtime();
        if (wait > 0) {
            main.postDelayed(() -> {
                if (current == n) listen(n);
            }, wait);
        } else {
            listen(n);
        }
    }

    /** The recogniser for a session: made, and given the read end of its pipe. */
    private void listen(Native n) {
        n.began = SystemClock.elapsedRealtime();
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        // Belt and braces: the recogniser is the on-device one already.
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, n.readEnd);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, RATE);
        // Segmented: one session for as long as the pipe is open, a result per
        // stretch of speech. The value names the extra whose end ends the
        // session — the audio source.
        intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);

        try {
            n.recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
            n.recognizer.setRecognitionListener(new Listener(n.gen));
            n.recognizer.startListening(intent);
        } catch (RuntimeException e) {
            // A recogniser that will not even take the request. Counted like
            // one that failed at once, which is what it is.
            Log.w(TAG, "stt: the recogniser would not start", e);
            main.post(() -> {
                if (current == n) ended(n, SpeechRecognizer.ERROR_CLIENT);
            });
        }
    }

    /** Callbacks for one session, ignored once it is not the current one. */
    private final class Listener implements RecognitionListener {
        private final int id;

        Listener(int id) {
            this.id = id;
        }

        private Native mine() {
            Native n = current;
            return n != null && n.gen == id ? n : null;
        }

        @Override public void onReadyForSpeech(Bundle params) {
            if (mine() != null) started();
        }

        @Override public void onBeginningOfSpeech() {
            Native n = mine();
            if (n == null) return;
            n.reading();
            started();
        }

        @Override public void onRmsChanged(float rmsdB) {
            Native n = mine();
            if (n == null) return;
            n.reading();
        }

        @Override public void onBufferReceived(byte[] buffer) {}

        @Override public void onEndOfSpeech() {}

        @Override public void onPartialResults(Bundle partial) {
            Native n = mine();
            if (n == null || partial == null) return;
            n.reading();
            started();
            String text = best(partial);
            if (partial.getBoolean(FINAL_RESULT, false)) {
                settle(n, text, FROM_PARTIAL);
            } else {
                hypothesis(n, text);
            }
        }

        @Override public void onSegmentResults(Bundle segment) {
            Native n = mine();
            if (n == null) return;
            n.reading();
            settle(n, best(segment), FROM_SEGMENT);
        }

        @Override public void onResults(Bundle results) {
            Native n = mine();
            if (n == null) return;
            // Null on the Pixel, whose final has already come as a partial.
            if (results != null) {
                String text = best(results);
                if (!text.isEmpty()) settle(n, text, FROM_RESULTS);
            }
            ended(n, -1);
        }

        @Override public void onEndOfSegmentedSession() {
            Native n = mine();
            if (n != null) ended(n, -1);
        }

        @Override public void onError(int error) {
            Native n = mine();
            if (n != null) ended(n, error);
        }

        @Override public void onEvent(int eventType, Bundle params) {}
    }

    private void started() {
        if (!starting || session < 0) return;
        starting = false;
        main.removeCallbacks(readyTimeout);
        try {
            reply("stt-started", new JSONObject().put("session", session));
        } catch (org.json.JSONException ignored) {
            // A JSONObject with one integer in it.
        }
    }

    /**
     * An interim: the whole hypothesis for the utterance in progress.
     *
     * <p>Usually the recogniser says a line is over with a final, and then
     * starts the next. But catching up on a backlog — after a cold start, or
     * a session replaced on a retune — it moves straight on: the next line's
     * interims start (a short hypothesis, unrelated to the long one before)
     * and the earlier line's final arrives seconds later — eight, once — or
     * not at all: on the Pixel, every backlog tried had a line whose final
     * never came. So a line the recogniser has visibly moved on from is held
     * as {@link #pending}: the next line's interims are kept back, its final
     * is waited for — up to PENDING_MS — and if it does not come the line is
     * settled as last heard rather than lost. (One that comes later still is
     * recognised as a copy and dropped; see {@link #settle}.) The page reads "final" as
     * settling the line it is showing, which is why the newer interims wait:
     * reaching it first, they would be what got settled.
     */
    private void hypothesis(Native n, String text) {
        if (text.isEmpty()) return;
        n.heard = true;
        everHeard = true;
        strikes = 0;
        if (pending != null) {
            // Moved on again while still waiting: two lines back is too far
            // to match a late final to, so the older one is settled now.
            if (held == null || !restarted(held, text)) {
                held = text;
                return;
            }
            givePending();
        }
        // Partials repeat themselves several times a second; the page wants
        // one each time the words change. And the line just settled, said
        // again as a partial, is not the start of the next one.
        if (open ? text.equals(interim) : text.equals(lastFinal)) return;
        if (open && restarted(interim, text)) {
            pending = interim;
            held = text;
            open = false;
            main.postDelayed(pendingTimeout, PENDING_MS);
            return;
        }
        interim = text;
        open = true;
        result(text, false);
    }

    /**
     * A final: the utterance is settled.
     *
     * <p>Finals reach here by three roads — a segment result, a partial marked
     * final, and onResults — and one utterance can come down more than one of
     * them. Each road delivers one final per utterance and every utterance
     * starts with interims, so a final is the same line again when no interim
     * has arrived since the last final and it either repeats that final's
     * words or is much the same line by a different road. Two finals in a row
     * from the same road with different words are two lines. And one that is
     * much like a line settled a moment ago, and unlike the line it ought to
     * be about — the one in progress, or the one awaiting its final — is a
     * late copy of the former: the recogniser does send one line's final
     * twice, seconds apart, when it is catching up.
     *
     * <p>An empty final with an interim showing is passed on: the page settles
     * the interim it has (localSegments.js foldResult), which is the best
     * reading of a recogniser that has decided it heard nothing after all.
     */
    private void settle(Native n, String text, int from) {
        if (!text.isEmpty()) {
            n.heard = true;
            everHeard = true;
            strikes = 0;
        }
        // The line this final ought to be about: the one awaiting its final,
        // or the one being spoken.
        String about = pending != null ? pending : open ? interim : null;
        boolean late = about != null && !text.isEmpty() && !similar(text, about) && settledRecently(text);
        boolean again = about == null && lastFinalFrom != 0
                && (text.equals(lastFinal) || (from != lastFinalFrom && similar(text, lastFinal)));
        if (late || again) {
            Log.d(TAG, "stt: dropping a repeated final (" + from + ")");
            return;
        }
        if (pending != null) {
            // The final owed for the line the recogniser moved on from.
            String line = text.isEmpty() ? pending : text;
            main.removeCallbacks(pendingTimeout);
            pending = null;
            emitFinal(line, from);
            flushHeld();
            return;
        }
        if (text.isEmpty() && !open) return;
        emitFinal(text, from);
    }

    private void emitFinal(String text, int from) {
        lastFinal = text;
        lastFinalFrom = from;
        open = false;
        interim = "";
        if (!text.isEmpty()) {
            recent.addLast(text);
            while (recent.size() > 3) recent.removeFirst();
        }
        result(text, true);
    }

    /** The newer line's interim, kept back while a final was awaited, now shown. */
    private void flushHeld() {
        String h = held;
        held = null;
        if (h == null) return;
        interim = h;
        open = true;
        result(h, false);
    }

    /** The wait for a line's own final is over: it is settled as last heard. */
    private void givePending() {
        main.removeCallbacks(pendingTimeout);
        String line = pending;
        pending = null;
        emitFinal(line, FROM_RESTART);
        flushHeld();
    }

    /** Forget the utterance in progress without settling it. */
    private void forget() {
        main.removeCallbacks(pendingTimeout);
        pending = null;
        held = null;
        recent.clear();
        open = false;
        interim = "";
        lastFinal = "";
        lastFinalFrom = 0;
    }

    /**
     * A short, unrelated hypothesis replacing a long one: the recogniser has
     * started a new line. Deliberately strict, and the same test as iOS's —
     * recognisers revise their opening words all the time, and treating a
     * revision as a new line would settle half-sentences.
     */
    static boolean restarted(String old, String now) {
        if (old.length() < 12 || now.length() >= old.length() / 2) return false;
        String head = now.toLowerCase(Locale.ROOT);
        head = head.substring(0, Math.min(8, head.length()));
        return !old.toLowerCase(Locale.ROOT).startsWith(head);
    }

    private boolean settledRecently(String text) {
        for (String r : recent) if (similar(text, r)) return true;
        return false;
    }

    /**
     * Much the same words: two readings of one utterance, which differ in a
     * word or two ("Sapal" for "so Paul") and a little in where they end. Most
     * of the longer one's words are in the shorter, so a short line is not
     * "similar" to a long one merely by being inside it — a broadcast repeats
     * itself, and the start of the next line is often in the last one. A line
     * of one or two words has to match exactly.
     */
    static boolean similar(String a, String b) {
        String[] x = words(a);
        String[] y = words(b);
        if (x.length == 0 || y.length == 0) return false;
        if (Math.min(x.length, y.length) < 3) return java.util.Arrays.equals(x, y);
        java.util.HashMap<String, Integer> count = new java.util.HashMap<>();
        for (String w : x) count.merge(w, 1, Integer::sum);
        int common = 0;
        for (String w : y) {
            Integer c = count.get(w);
            if (c != null && c > 0) {
                common++;
                count.put(w, c - 1);
            }
        }
        return common * 10 >= Math.max(x.length, y.length) * 6;
    }

    private static String[] words(String s) {
        String t = s.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}']+", " ").trim();
        return t.isEmpty() ? new String[0] : t.split(" ");
    }

    /**
     * A session ended without being asked to: the recogniser finished, gave
     * up, or failed. {@code error} is a SpeechRecognizer code, or -1 for none.
     *
     * <p>Most endings are not worth a word to the page: "no match" after a
     * quiet spell, a service that restarted. So a session is started again
     * quietly — at once if it had been working, after a growing pause if it
     * died at birth or failed without a word — and only a run of those, or an
     * error that no retry can fix, reaches the page.
     */
    private void ended(Native n, int error) {
        if (current != n) return;
        current = null;
        dispose(n);
        // Words heard and not yet settled were heard all the same.
        if (pending != null) givePending();
        if (open) settle(n, interim, FROM_END);
        if (error >= 0) Log.i(TAG, "stt: session " + n.gen + " ended: " + errorName(error));

        String[] fatal = error >= 0 ? fatal(error) : null;
        if (fatal != null) {
            end(fatal[0], fatal[1]);
            return;
        }
        // Behind the lock screen a failure is not retried. It may well be the
        // background itself that the recogniser objects to, and retrying it
        // there is battery spent on something nobody is watching; the page
        // shows why when the receiver is looked at again.
        if (!visible && error >= 0 && !benign(error)) {
            end("background", "On-device recognition stopped while UberSDR was in the background. "
                    + "Press Start to carry on.");
            return;
        }
        // A strike: a session that died at birth, or one that failed without
        // ever producing a word. One that heard something clears the count —
        // it was working, and its ending is the kind a restart fixes.
        long ran = SystemClock.elapsedRealtime() - n.began;
        boolean quick = !n.heard && !n.reading && ran < QUICK_FAILURE_MS;
        boolean barren = !n.heard && error >= 0 && !benign(error);
        if (!quick && !barren) {
            if (n.heard) strikes = 0;
            launch();
            return;
        }
        strikes += 1;
        if (strikes >= MAX_STRIKES) {
            // 'keeps-stopping' is the page's own word for this, and it has a
            // sentence for it; the detail is in the log above.
            end("keeps-stopping", errorName(error));
            return;
        }
        long delay = Math.min(250L << (strikes - 1), 4000L);
        main.postDelayed(relaunch, delay);
    }

    /**
     * Errors that a retry cannot fix, as the page's codes and messages — or
     * null for one worth retrying.
     */
    private String[] fatal(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                // Behind the lock screen, after it has been working: the
                // background, not the audio source. See ended.
                if (!visible && everHeard) {
                    return new String[]{ "background",
                            "On-device recognition stopped while UberSDR was in the background. "
                                    + "Press Start to carry on." };
                }
                // A recogniser that wanted the microphone rather than the
                // audio it was handed — which is the one permission this app
                // will never ask for. Not 'not-allowed': the page's sentence
                // for that tells the user to grant a permission, and granting
                // this one is exactly what must not happen. A code the page
                // does not know, so this sentence is the one it shows.
                return new String[]{ "audio-source-unsupported",
                        "This phone's speech recogniser can't take the receiver's audio — it will only "
                                + "listen to the microphone, which is not what is being transcribed." };
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return new String[]{ "language-not-supported", lang + " can't be recognised on this phone." };
            default:
                return null;
        }
    }

    /** The quiet endings: nothing heard for a while. */
    private static boolean benign(int error) {
        return error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
    }

    /**
     * One session's recogniser, pipe and writer, gone. The recogniser first,
     * so it stops reading and calling back; then the writer, which closes its
     * end; then this end, which a writer still waiting on a full pipe would
     * otherwise wait on for ever.
     */
    private void dispose(Native n) {
        // Off the current slot before anything is called on it (every caller
        // sees to that), so a callback it makes while being cancelled finds
        // itself stale rather than ending — and restarting — the session.
        SpeechRecognizer recognizer = n.recognizer;
        n.recognizer = null;
        if (recognizer != null) {
            quietUntil = SystemClock.elapsedRealtime() + QUIET_MS;
            try {
                recognizer.cancel();
            } catch (RuntimeException ignored) {
                // Not listening.
            }
            try {
                recognizer.destroy();
            } catch (RuntimeException ignored) {
                // Already unbound.
            }
        }
        if (n.feeder != null) {
            n.feeder.close();
            n.feeder = null;
        }
        if (n.readEnd != null) {
            closeQuietly(n.readEnd);
            n.readEnd = null;
        }
    }

    /**
     * Everything stops, and nothing still on its way will speak for it: the
     * session is cleared first, and every callback checks it.
     */
    private void teardown() {
        session = -1;
        main.removeCallbacks(readyTimeout);
        main.removeCallbacks(relaunch);
        if (current != null) {
            Native old = current;
            current = null;
            dispose(old);
        }
        starting = false;
        strikes = 0;
        forget();
    }

    // ---- installed languages -----------------------------------------------

    private interface Installed {
        void onInstalled(List<String> tags);
    }

    /**
     * The installed on-device languages, hyphenated as the page writes them,
     * or an empty list if the recogniser will not say. Answers exactly once.
     *
     * <p>A failed check answers with the last list there was, if there was
     * one: the languages installed on a phone do not change from one minute to
     * the next, but a service that is busy getting ready can fail a question.
     */
    private void checkSupport(String language, Installed done) {
        final boolean[] answered = { false };
        final SpeechRecognizer[] probe = { null };
        final Runnable finish = () -> {
            if (probe[0] != null) {
                quietUntil = SystemClock.elapsedRealtime() + QUIET_MS;
                try {
                    probe[0].destroy();
                } catch (RuntimeException ignored) {
                    // Already gone.
                }
                probe[0] = null;
            }
        };
        final Runnable late = () -> {
            if (answered[0]) return;
            answered[0] = true;
            finish.run();
            Log.w(TAG, "stt: the language check did not answer");
            done.onInstalled(lastInstalled == null ? new ArrayList<>() : lastInstalled);
        };
        try {
            probe[0] = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            if (language != null && !language.isEmpty()) {
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            }
            main.postDelayed(late, CHECK_MS);
            probe[0].checkRecognitionSupport(intent, context.getMainExecutor(), new RecognitionSupportCallback() {
                @Override public void onSupportResult(RecognitionSupport support) {
                    if (answered[0]) return;
                    answered[0] = true;
                    main.removeCallbacks(late);
                    List<String> tags = new ArrayList<>();
                    for (String t : support.getInstalledOnDeviceLanguages()) {
                        String tag = t.replace('_', '-');
                        if (!contains(tags, tag)) tags.add(tag);
                    }
                    java.util.Collections.sort(tags);
                    if (!tags.isEmpty()) lastInstalled = tags;
                    // Off the callback — destroying the recogniser from
                    // inside its own callback is asking for trouble — and
                    // before the answer, so a session started on it waits
                    // for the probe to have gone (see quietUntil).
                    main.post(() -> {
                        finish.run();
                        done.onInstalled(tags);
                    });
                }

                @Override public void onError(int error) {
                    if (answered[0]) return;
                    answered[0] = true;
                    main.removeCallbacks(late);
                    Log.w(TAG, "stt: the language check failed: " + errorName(error));
                    main.post(() -> {
                        finish.run();
                        done.onInstalled(lastInstalled == null ? new ArrayList<>() : lastInstalled);
                    });
                }
            });
        } catch (RuntimeException e) {
            Log.w(TAG, "stt: could not check the installed languages", e);
            main.removeCallbacks(late);
            if (!answered[0]) {
                answered[0] = true;
                finish.run();
                done.onInstalled(lastInstalled == null ? new ArrayList<>() : lastInstalled);
            }
        }
    }

    private static boolean contains(List<String> tags, String tag) {
        for (String t : tags) if (t.equalsIgnoreCase(tag)) return true;
        return false;
    }

    // ---- to the page -------------------------------------------------------

    /** The top hypothesis, trimmed: segment results begin with a space. */
    private static String best(Bundle b) {
        if (b == null) return "";
        ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (r == null || r.isEmpty() || r.get(0) == null) return "";
        return r.get(0).trim();
    }

    private void result(String text, boolean isFinal) {
        if (session < 0) return;
        try {
            reply("stt-result", new JSONObject().put("session", session).put("text", text).put("final", isFinal));
        } catch (org.json.JSONException ignored) {
            // Strings and a boolean.
        }
    }

    private void error(String code, String message, boolean isFatal) {
        if (session < 0) return;
        try {
            reply("stt-error", new JSONObject().put("session", session).put("code", code)
                    .put("message", message).put("fatal", isFatal).put("retryable", false));
        } catch (org.json.JSONException ignored) {
            // Strings and booleans.
        }
    }

    /**
     * A start that failed. After a session would have been reported started
     * this is an error and the end instead, which is what the page expects of
     * a session that died a moment in.
     */
    private void failStart(String code, String message) {
        if (session < 0) return;
        if (!starting) {
            end(code, message);
            return;
        }
        int id = session;
        teardown();
        try {
            reply("stt-start-failed", new JSONObject().put("session", id).put("code", code).put("message", message));
        } catch (org.json.JSONException ignored) {
            // Strings and an integer.
        }
    }

    /** The session is over, for a reason the page is told. */
    private void end(String code, String message) {
        if (session < 0) return;
        if (starting) {
            failStart(code, message);
            return;
        }
        int id = session;
        error(code, message, true);
        teardown();
        try {
            reply("stt-end", new JSONObject().put("session", id));
        } catch (org.json.JSONException ignored) {
            // An integer.
        }
    }

    private void reply(String prefix, Object payload) {
        sink.send(prefix + ":" + payload);
    }

    private static void closeQuietly(ParcelFileDescriptor pfd) {
        try {
            pfd.close();
        } catch (IOException ignored) {
            // Closing is all that was wanted.
        }
    }

    static String errorName(int e) {
        switch (e) {
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "network timeout";
            case SpeechRecognizer.ERROR_NETWORK: return "network";
            case SpeechRecognizer.ERROR_AUDIO: return "audio";
            case SpeechRecognizer.ERROR_SERVER: return "server";
            case SpeechRecognizer.ERROR_CLIENT: return "client";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "speech timeout";
            case SpeechRecognizer.ERROR_NO_MATCH: return "no match";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "recogniser busy";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "insufficient permissions";
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS: return "too many requests";
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED: return "server disconnected";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED: return "language not supported";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "language unavailable";
            case SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT: return "cannot check support";
            default: return "error " + e;
        }
    }

    // ---- the writer --------------------------------------------------------

    /**
     * Writes one session's pipe, on its own thread, from a bounded queue.
     *
     * <p>A recogniser reads the pipe when it reads it — not at all for the
     * first dozen seconds of a cold start — and a write to a full pipe blocks.
     * So the page's pushes go into a queue that drops its oldest audio when it
     * is full, and only this thread ever waits on the pipe. The queue is
     * larger until the recogniser has started reading ({@link #settle}), and
     * then shrinks back as it drains.
     *
     * <p>The pipe is non-blocking and waited on with poll, in short steps, so
     * that {@link #close} is answered within a tenth of a second however
     * stuck the reader is. A blocking write would hold this thread, and the
     * pipe, for as long as the recogniser held its end — which for one that
     * has hung is for ever.
     */
    static final class Feeder extends Thread {
        private final ParcelFileDescriptor writeEnd;
        private final FileDescriptor fd;
        private final int floor;
        private int limit;
        private boolean settled;
        private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
        private int queued;
        private boolean closed;

        Feeder(ParcelFileDescriptor writeEnd, int capacity, int warm) throws ErrnoException {
            super("stt-pipe");
            this.writeEnd = writeEnd;
            this.fd = writeEnd.getFileDescriptor();
            this.floor = capacity;
            this.limit = warm;
            Os.fcntlInt(fd, OsConstants.F_SETFL, OsConstants.O_NONBLOCK);
            setDaemon(true);
        }

        /** Queue a push. True if older audio was dropped to make room. */
        synchronized boolean offer(byte[] pcm) {
            if (closed) return false;
            // Down with the backlog, never back up, and always QUEUE_BYTES
            // above it: a reader catching up is not steady about it, and a
            // moment's slowness on the way down is not falling behind. Once
            // the backlog has gone the limit is QUEUE_BYTES.
            if (settled) limit = Math.max(floor, Math.min(limit, queued + floor));
            boolean dropped = false;
            while (!queue.isEmpty() && queued + pcm.length > limit) {
                queued -= queue.pollFirst().length;
                dropped = true;
            }
            queue.addLast(pcm);
            queued += pcm.length;
            notifyAll();
            return dropped;
        }

        /** The recogniser is reading: from now on the queue only shrinks. */
        synchronized void settle() {
            settled = true;
        }

        synchronized void close() {
            closed = true;
            queue.clear();
            queued = 0;
            notifyAll();
        }

        private synchronized boolean isClosed() {
            return closed;
        }

        @Override public void run() {
            StructPollfd[] wait = { new StructPollfd() };
            wait[0].fd = fd;
            wait[0].events = (short) OsConstants.POLLOUT;
            try {
                while (true) {
                    byte[] pcm;
                    synchronized (this) {
                        while (queue.isEmpty() && !closed) wait();
                        if (closed) return;
                        pcm = queue.pollFirst();
                        queued -= pcm.length;
                    }
                    int off = 0;
                    while (off < pcm.length) {
                        try {
                            off += Os.write(fd, pcm, off, pcm.length - off);
                        } catch (ErrnoException e) {
                            if (e.errno != OsConstants.EAGAIN) return;   // the reader has gone
                            if (isClosed()) return;
                            try {
                                Os.poll(wait, 100);
                            } catch (ErrnoException again) {
                                if (again.errno != OsConstants.EINTR) return;
                            }
                        }
                    }
                }
            } catch (InterruptedException | java.io.InterruptedIOException e) {
                // Interrupted or the pipe broke: either way, this session is over.
            } finally {
                try {
                    writeEnd.close();
                } catch (IOException ignored) {
                    // The point was to close it.
                }
            }
        }
    }
}
