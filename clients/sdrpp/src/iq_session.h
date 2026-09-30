#pragma once
// One IQ stream from a receiver into SDR++.
//
// A single worker thread owns the connection end to end: it registers the
// session with /connection, opens the WebSocket, decodes every packet into the
// SDR++ stream, and sends tune, margin and keepalive messages between reads.
// Nothing else touches the socket, so the TLS state never sees two threads.
#include "http.h"
#include "server_api.h"

#include <dsp/stream.h>
#include <dsp/types.h>

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace ubersdr {
    class WebSocket;

    // Reduced-depth ("min quality") limits, from lossyMinMarginDB and
    // lossyMaxMarginDB in pcm_lossy.go. 0 asks for the lossless stream.
    const int kMarginMinDB = 10;
    const int kMarginMaxDB = 60;
    const int kMarginDefaultDB = 10;

    class IQSession {
    public:
        struct Params {
            Url url;
            std::string password;
            std::string sessionId;
            std::string mode;       // iq, iq48 ... iq384
            double frequency = 0;
            int minMarginDB = 0;    // 0 = lossless
            bool verify = true;
        };

        enum class State { Idle, Connecting, Streaming, Failed };

        struct Status {
            State state = State::Idle;
            std::string message;       // why it failed, or the last server notice
            double kbytesPerSec = 0;   // on the wire

            // This session's limits, from the /connection it made, and how long
            // it has been streaming: the server times a session from its first
            // stream, and each start is a new session.
            bool haveLimits = false;
            int maxSessionTime = 0;       // seconds, 0 = unlimited
            long long dailyRemaining = -1; // seconds at connect, -1 = unlimited
            double streamingSecs = 0;

            // Everything that /connection told this session, for a menu that
            // was started with Play alone and never ran Connect.
            ServerInfo server;
            std::string serverKey; // Url::str() of the receiver it came from
        };

        explicit IQSession(dsp::stream<dsp::complex_t>* out);
        ~IQSession();

        void start(const Params& p);
        void stop();

        // Safe from any thread; coalesced and sent by the worker.
        void tune(double freq);
        void setMinMargin(int db);

        Status status();

    private:
        void worker(Params p);
        void setState(State s, const std::string& msg = "");

        dsp::stream<dsp::complex_t>* out;
        std::thread thread;
        std::atomic<bool> stopping{ false };

        std::mutex wsMtx; // guards `live`, for stop() to abort it
        WebSocket* live = nullptr;

        std::atomic<double> pendingFreq{ 0 };
        std::atomic<int> pendingMargin{ -1 };

        std::mutex statusMtx;
        Status st;
        std::chrono::steady_clock::time_point streamStart;
    };
}
