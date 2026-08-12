package org.ubersdr.mobile;

import android.util.Log;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * A one-shot mDNS-SD browse for {@code _ubersdr._tcp.local}, ported from
 * clients/electron/mdns.js.
 *
 * <p>The query is a "legacy unicast" one (RFC 6762 §6.7): the socket is bound to
 * an ephemeral port rather than 5353, so responders address their replies
 * directly back to it. On the desktop that sidesteps sharing port 5353 with
 * whatever mDNS stack already owns it. Here it buys something better — the
 * replies arrive as ordinary unicast UDP, so this needs no
 * {@code MulticastLock}, no {@code CHANGE_WIFI_MULTICAST_STATE}, and none of
 * NsdManager, whose discovery limits and lifecycle would otherwise be the
 * hardest part of the LAN tab.
 *
 * <p>IPv4 only, deliberately, and for the same reason the desktop client and
 * clients/tui are: a LAN receiver reachable only by link-local IPv6 needs a
 * zone id the client would have to guess, so an instance advertising nothing
 * but AAAA is skipped rather than listed unreachable.
 */
final class Mdns {

    private static final String TAG = "UberSDR";
    private static final String MDNS_ADDR = "224.0.0.251";
    private static final int MDNS_PORT = 5353;
    private static final String SERVICE = "_ubersdr._tcp.local";

    private static final int TYPE_A = 1;
    private static final int TYPE_PTR = 12;
    private static final int TYPE_TXT = 16;
    private static final int TYPE_SRV = 33;

    static final class Service {
        final String name;
        final String host;
        final int port;

        Service(String name, String host, int port) {
            this.name = name;
            this.host = host;
            this.port = port;
        }
    }

    private Mdns() {}

    /** Query, collect for timeoutMs, return what answered. Never throws. */
    static List<Service> browse(int timeoutMs) {
        Map<String, String> ptrs = new HashMap<>();   // lowercased instance -> display name
        Map<String, Srv> srvs = new HashMap<>();      // lowercased instance -> {port, target}
        Map<String, String> addrs = new HashMap<>();  // lowercased hostname -> IPv4
        Set<String> asked = new HashSet<>();

        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setSoTimeout(250);
            InetAddress group = InetAddress.getByName(MDNS_ADDR);

            // One socket on the default route, where the desktop client opens
            // one per external interface. A phone has one LAN — the Wi-Fi it is
            // associated with — and the receivers this tab is for are on it; a
            // device bridging two networks at once is a laptop's situation, not
            // this one's.
            byte[] query = buildQuery(Collections.singletonList(new Question(SERVICE, TYPE_PTR)));
            send(sock, query, group);

            long deadline = System.currentTimeMillis() + timeoutMs;
            boolean repeated = false;
            byte[] buf = new byte[8192];
            while (System.currentTimeMillis() < deadline) {
                // One repeat, per RFC 6762 — a single query lost to a dropped
                // packet would otherwise be an empty Local network tab.
                if (!repeated && System.currentTimeMillis() > deadline - timeoutMs + 1000) {
                    repeated = true;
                    send(sock, query, group);
                }
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(packet);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                List<Record> records = parseRecords(packet.getData(), packet.getLength());
                for (Record rec : records) {
                    if (rec.type == TYPE_PTR && SERVICE.equals(rec.name) && rec.ptr != null) {
                        String key = rec.ptr.toLowerCase(Locale.ROOT);
                        if (!ptrs.containsKey(key)) {
                            // The instance label, e.g. "UberSDR on host".
                            ptrs.put(key, rec.ptr.split("\\.")[0]);
                        }
                    } else if (rec.type == TYPE_SRV && rec.target != null) {
                        srvs.put(rec.name, new Srv(rec.port, rec.target));
                    } else if (rec.type == TYPE_A && rec.address != null) {
                        addrs.put(rec.name, rec.address);
                    }
                }

                // Avahi normally packs SRV/TXT/A into the additionals of the PTR
                // response; when a responder does not, chase the gaps.
                List<Question> followUps = new ArrayList<>();
                for (String key : ptrs.keySet()) {
                    if (!srvs.containsKey(key) && !asked.contains(key)) {
                        asked.add(key);
                        followUps.add(new Question(key, TYPE_SRV));
                        followUps.add(new Question(key, TYPE_TXT));
                    }
                    Srv srv = srvs.get(key);
                    if (srv != null && !addrs.containsKey(srv.target) && !asked.contains(srv.target)) {
                        asked.add(srv.target);
                        followUps.add(new Question(srv.target, TYPE_A));
                    }
                }
                if (!followUps.isEmpty()) send(sock, buildQuery(followUps), group);
            }
        } catch (IOException e) {
            Log.w(TAG, "mDNS browse failed", e);
        } finally {
            if (sock != null) sock.close();
        }

        List<Service> out = new ArrayList<>();
        for (Map.Entry<String, String> entry : ptrs.entrySet()) {
            Srv srv = srvs.get(entry.getKey());
            if (srv == null || srv.port <= 0) continue;
            // Prefer the A record; fall back to the advertised hostname and let
            // the system resolver (which may itself speak mDNS) try it.
            String address = addrs.get(srv.target);
            String host = address != null ? address : srv.target.replaceAll("\\.$", "");
            out.add(new Service(entry.getValue(), host, srv.port));
        }
        return out;
    }

    private static void send(DatagramSocket sock, byte[] query, InetAddress group) {
        try {
            sock.send(new DatagramPacket(query, query.length, new InetSocketAddress(group, MDNS_PORT)));
        } catch (IOException e) {
            // An interface that went away mid-scan. The other answers stand.
            Log.d(TAG, "mDNS send failed: " + e.getMessage());
        }
    }

    // --- the wire format -----------------------------------------------------

    private static final class Question {
        final String name;
        final int type;

        Question(String name, int type) {
            this.name = name;
            this.type = type;
        }
    }

    private static final class Srv {
        final int port;
        final String target;

        Srv(int port, String target) {
            this.port = port;
            this.target = target;
        }
    }

    private static final class Record {
        String name;
        int type;
        String ptr;
        String target;
        String address;
        int port;
    }

    private static byte[] buildQuery(List<Question> questions) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        // id 0 and flags 0, per mDNS.
        out.write(new byte[]{0, 0, 0, 0});
        out.write((questions.size() >> 8) & 0xff);
        out.write(questions.size() & 0xff);
        out.write(new byte[]{0, 0, 0, 0, 0, 0});
        for (Question q : questions) {
            writeName(out, q.name);
            out.write((q.type >> 8) & 0xff);
            out.write(q.type & 0xff);
            out.write(0);
            out.write(1); // class IN
        }
        return out.toByteArray();
    }

    private static void writeName(ByteArrayOutputStream out, String name) throws IOException {
        for (String part : name.replaceAll("\\.$", "").split("\\.")) {
            byte[] bytes = part.getBytes("UTF-8");
            out.write(bytes.length);
            out.write(bytes);
        }
        out.write(0);
    }

    /** A possibly-compressed name, and the offset just past it in the unjumped stream. */
    private static String[] readName(byte[] buf, int len, int off) {
        StringBuilder name = new StringBuilder();
        int next = -1;
        int jumps = 0;
        while (true) {
            if (off >= len) throw new IllegalArgumentException("truncated name");
            int size = buf[off] & 0xff;
            if (size == 0) {
                if (next < 0) next = off + 1;
                break;
            }
            if ((size & 0xc0) == 0xc0) {
                if (off + 1 >= len) throw new IllegalArgumentException("truncated pointer");
                if (next < 0) next = off + 2;
                if (++jumps > 32) throw new IllegalArgumentException("compression loop");
                off = ((size & 0x3f) << 8) | (buf[off + 1] & 0xff);
                continue;
            }
            if (off + 1 + size > len) throw new IllegalArgumentException("truncated label");
            if (name.length() > 0) name.append('.');
            name.append(new String(buf, off + 1, size, java.nio.charset.StandardCharsets.UTF_8));
            off += 1 + size;
        }
        return new String[]{name.toString(), String.valueOf(next)};
    }

    /**
     * Answers, authority and additionals flattened into one record list. A parse
     * error keeps whatever was read before it rather than dropping the packet —
     * one responder's malformed additional should not lose the answer it came
     * attached to.
     */
    private static List<Record> parseRecords(byte[] buf, int len) {
        List<Record> records = new ArrayList<>();
        if (len < 12) return records;
        int questions = ((buf[4] & 0xff) << 8) | (buf[5] & 0xff);
        int rrs = (((buf[6] & 0xff) << 8) | (buf[7] & 0xff))
                + (((buf[8] & 0xff) << 8) | (buf[9] & 0xff))
                + (((buf[10] & 0xff) << 8) | (buf[11] & 0xff));
        int off = 12;
        try {
            for (int i = 0; i < questions; i++) off = Integer.parseInt(readName(buf, len, off)[1]) + 4;
            for (int i = 0; i < rrs; i++) {
                String[] parsed = readName(buf, len, off);
                off = Integer.parseInt(parsed[1]);
                int type = ((buf[off] & 0xff) << 8) | (buf[off + 1] & 0xff);
                int rdlen = ((buf[off + 8] & 0xff) << 8) | (buf[off + 9] & 0xff);
                int rdoff = off + 10;
                off = rdoff + rdlen;
                if (off > len) break;

                Record rec = new Record();
                rec.name = parsed[0].toLowerCase(Locale.ROOT);
                rec.type = type;
                if (type == TYPE_PTR) {
                    rec.ptr = readName(buf, len, rdoff)[0];
                } else if (type == TYPE_SRV && rdlen >= 7) {
                    rec.port = ((buf[rdoff + 4] & 0xff) << 8) | (buf[rdoff + 5] & 0xff);
                    rec.target = readName(buf, len, rdoff + 6)[0].toLowerCase(Locale.ROOT);
                } else if (type == TYPE_A && rdlen == 4) {
                    rec.address = (buf[rdoff] & 0xff) + "." + (buf[rdoff + 1] & 0xff) + "."
                            + (buf[rdoff + 2] & 0xff) + "." + (buf[rdoff + 3] & 0xff);
                }
                records.add(rec);
            }
        } catch (RuntimeException e) {
            // Keep the partial list.
        }
        return records;
    }
}
