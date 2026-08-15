package org.ubersdr.mobile;

import android.content.Context;
import android.os.Debug;
import android.util.Log;

import java.io.RandomAccessFile;

/**
 * What this app is costing the device, for the stats readout over the waterfall.
 *
 * <p>Asked for by the page once a second while that readout is open, and never
 * otherwise — see src/receiver.js and static/v2/src/lib/appStats.js. The pull
 * shape is what keeps this cheap: nothing here runs on a timer, so a receiver
 * whose operator has the readout switched off does none of this work.
 *
 * <p>Both figures are about *this process*, not the device. "The phone is at
 * 80%" is not the question somebody asks with a receiver open; "is this app the
 * reason the battery is going" is.
 */
final class AppLoad {

    private static final String TAG = "UberSDR";

    /** Ticks of processor time the process had used when last asked. */
    private long lastTicks = -1;
    private long lastAtMs;

    /**
     * Processor time as a share of one core, as every system monitor reports
     * it — so a phone with eight of them can legitimately show more than 100.
     *
     * <p>Read from /proc/self/stat, which is the kernel's own accounting for
     * this process: fields 14 and 15 are user and system time in clock ticks.
     * There is no supported API for this — {@code Process.getElapsedCpuTime()}
     * is the whole process too but has no way to say what a tick is worth, and
     * Debug's counters are for tracing rather than reporting.
     *
     * <p>A rate needs two readings, so the first call answers nothing rather
     * than dividing the app's whole lifetime by the second since it started.
     */
    private double cpuPercent() {
        long ticks;
        try (RandomAccessFile stat = new RandomAccessFile("/proc/self/stat", "r")) {
            String line = stat.readLine();
            if (line == null) return -1;
            // The second field is the executable name in brackets and may
            // itself contain spaces, so the split starts after it rather than
            // at the beginning of the line.
            int close = line.lastIndexOf(')');
            if (close < 0 || close + 2 >= line.length()) return -1;
            String[] f = line.substring(close + 2).split(" ");
            // Fields 14 and 15 of the line, which are 11 and 12 of what is left
            // once the pid and the name have been taken off the front.
            if (f.length < 13) return -1;
            ticks = Long.parseLong(f[11]) + Long.parseLong(f[12]);
        } catch (Exception e) {
            // A kernel that will not show us our own accounting is not worth a
            // line in the log every second.
            return -1;
        }

        long now = android.os.SystemClock.elapsedRealtime();
        long wasTicks = lastTicks;
        long wasAt = lastAtMs;
        lastTicks = ticks;
        lastAtMs = now;
        if (wasTicks < 0 || now <= wasAt) return -1;

        // 100 ticks a second is the kernel's USER_HZ, fixed on Android and not
        // readable from Java without loading the C library for sysconf.
        double seconds = (ticks - wasTicks) / 100.0;
        double elapsed = (now - wasAt) / 1000.0;
        double percent = (seconds / elapsed) * 100.0;
        return percent >= 0 ? percent : -1;
    }

    /**
     * Real memory, in bytes: total PSS.
     *
     * <p>Proportional set size rather than the Java heap, which is the figure
     * the system itself uses when it decides what to kill — and on this app the
     * heap is a minority of the total, because the waterfall's bitmaps, the
     * WebView's own process-shared pages and the audio buffers are all outside
     * it. Reporting the heap would be a number that is always small and always
     * reassuring.
     */
    private long memoryBytes(Context context) {
        try {
            Debug.MemoryInfo info = new Debug.MemoryInfo();
            Debug.getMemoryInfo(info);
            return info.getTotalPss() * 1024L;
        } catch (Exception e) {
            Log.w(TAG, "could not read this process's memory use", e);
            return -1;
        }
    }

    /** Both figures as the page's JSON, leaving out whatever could not be read. */
    String json(Context context) {
        double cpu = cpuPercent();
        long mem = memoryBytes(context);
        StringBuilder sb = new StringBuilder("{");
        if (cpu >= 0) sb.append("\"cpu\":").append(Math.round(cpu * 10) / 10.0);
        if (mem > 0) {
            if (sb.length() > 1) sb.append(',');
            sb.append("\"mem\":").append(mem);
        }
        return sb.append('}').toString();
    }
}
