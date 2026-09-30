#include "iq_session.h"
#include "server_api.h"
#include "websocket.h"

#include <pcm_v4.hpp>
#include <json.hpp>
#include <utils/flog.h>

#include <algorithm>
#include <chrono>
#include <cmath>

using nlohmann::json;

namespace ubersdr {
    namespace {
        // The server allows at least 50 commands a second per session; dragging
        // the waterfall produces more, so tunes are coalesced to 20 a second and
        // only the latest frequency is ever sent.
        const auto kTuneInterval = std::chrono::milliseconds(50);
        // Matches the other clients: keeps the session from idling out.
        const auto kPingInterval = std::chrono::seconds(30);
    }

    IQSession::IQSession(dsp::stream<dsp::complex_t>* out) : out(out) {}

    IQSession::~IQSession() { stop(); }

    void IQSession::setState(State s, const std::string& msg) {
        std::lock_guard<std::mutex> lck(statusMtx);
        st.state = s;
        st.message = msg;
        if (s != State::Streaming) {
            st.kbytesPerSec = 0;
        }
    }

    IQSession::Status IQSession::status() {
        std::lock_guard<std::mutex> lck(statusMtx);
        return st;
    }

    void IQSession::start(const Params& p) {
        stop();
        stopping = false;
        pendingFreq = p.frequency;
        pendingMargin = -1;
        setState(State::Connecting, "");
        thread = std::thread(&IQSession::worker, this, p);
    }

    void IQSession::stop() {
        stopping = true;
        {
            std::lock_guard<std::mutex> lck(wsMtx);
            if (live) { live->abort(); }
        }
        // Release the worker if it is blocked handing samples to SDR++.
        out->stopWriter();
        if (thread.joinable()) { thread.join(); }
        out->clearWriteStop();
        std::lock_guard<std::mutex> lck(statusMtx);
        if (st.state != State::Failed) {
            st = Status();
        }
    }

    void IQSession::tune(double freq) { pendingFreq = freq; }

    void IQSession::setMinMargin(int db) { pendingMargin = db; }

    void IQSession::worker(Params p) {
        std::unique_ptr<WebSocket> ws;
        std::string serverError; // the server's own words, which beat "connection closed"
        try {
            // Registers this session id with the receiver, which the WebSocket
            // then requires, and confirms the mode is still ours to use: the
            // grant is per IP and password and can change between connects.
            ServerInfo info = probeServer(p.url, p.password, p.sessionId, p.verify);
            if (std::find(info.allowedModes.begin(), info.allowedModes.end(), p.mode) == info.allowedModes.end()) {
                throw std::runtime_error(std::string(findIQMode(p.mode) ? findIQMode(p.mode)->label : p.mode.c_str()) +
                                         " is not available to this client on this receiver");
            }
            if (stopping) { return; }

            double f = std::clamp(p.frequency, p.minFreq, p.maxFreq);
            std::string q = "/ws?frequency=" + std::to_string((long long)std::llround(f));
            q += "&mode=" + p.mode;
            // "pcm-zstd" is still the server's name for the lossless format; from
            // version 4 it carries the predictive codec, not zstd.
            q += "&format=pcm-zstd&version=4";
            // Absent is not the same as zero to the server: absent means the
            // lossless path, which is what 0 has to give.
            if (p.minMarginDB > 0) { q += "&min_margin=" + std::to_string(p.minMarginDB); }
            q += "&user_session_id=" + p.sessionId;
            if (!p.password.empty()) { q += "&password=" + urlEncode(p.password); }

            ws = WebSocket::connect(p.url, q, p.verify);
            {
                std::lock_guard<std::mutex> lck(wsMtx);
                live = ws.get();
            }
            if (stopping) { throw NetError("stopped"); }
            setState(State::Streaming);
            flog::info("UberSDR: streaming {0} from {1}", p.mode, p.url.str());

            PCMv4StreamDecoder decoder;
            double sentFreq = f;
            int sentMargin = p.minMarginDB;
            auto lastTune = std::chrono::steady_clock::now() - kTuneInterval;
            auto lastPing = std::chrono::steady_clock::now();
            auto rateStart = std::chrono::steady_clock::now();
            size_t rateBytes = 0;

            WebSocket::Message msg;
            while (!stopping) {
                auto now = std::chrono::steady_clock::now();

                double want = std::clamp((double)pendingFreq, p.minFreq, p.maxFreq);
                if (want != sentFreq && now - lastTune >= kTuneInterval) {
                    // The mode goes with every tune: the server treats a tune
                    // without one as a request to keep the current mode, but
                    // saying it is cheap and survives any server-side default.
                    ws->sendText("{\"type\":\"tune\",\"frequency\":" + std::to_string((long long)std::llround(want)) +
                                 ",\"mode\":\"" + p.mode + "\"}");
                    sentFreq = want;
                    lastTune = now;
                }
                int m = pendingMargin.exchange(-1);
                if (m >= 0 && m != sentMargin) {
                    // Retargets the next packet; lossless <-> lossy rebuilds the
                    // encoder server side, and the stream says so in-band.
                    ws->sendText("{\"type\":\"set_min_margin\",\"min_margin\":" + std::to_string(m) + "}");
                    sentMargin = m;
                }
                if (now - lastPing >= kPingInterval) {
                    ws->sendText("{\"type\":\"ping\"}");
                    lastPing = now;
                }

                if (!ws->recv(msg, 50)) { continue; }

                if (!msg.binary) {
                    json j = json::parse(msg.data.begin(), msg.data.end(), nullptr, false);
                    if (!j.is_object()) { continue; }
                    std::string type = j.value("type", "");
                    if (type == "error") {
                        std::string e = j.value("error", "server error");
                        flog::warn("UberSDR: server says: {0}", e);
                        serverError = e;
                        std::lock_guard<std::mutex> lck(statusMtx);
                        st.message = e;
                    }
                    continue;
                }

                const uint8_t* data = msg.data.data();
                size_t size = msg.data.size();
                rateBytes += size;
                if (PCMv4StreamDecoder::isZstdFrame(data, size)) {
                    throw std::runtime_error("this receiver is too old for this plugin (needs UberSDR 0.1.63 or later)");
                }

                // Every packet goes through the decoder, even one we could not
                // deliver: its predictor adapts on each one, and skipping a
                // packet desynchronises it from the server's for good.
                PCMv4Header h;
                std::string err;
                if (!decoder.decode(data, size, h, err)) {
                    throw std::runtime_error("stream decode failed: " + err);
                }
                if (h.channels != 2 || h.sampleCount % 2 != 0) {
                    throw std::runtime_error("expected interleaved I/Q, got " + std::to_string(h.channels) + " channel(s)");
                }

                const int16_t* pcm = decoder.samples();
                int frames = h.sampleCount / 2;
                int done = 0;
                while (done < frames) {
                    int n = std::min(frames - done, (int)STREAM_BUFFER_SIZE);
                    for (int i = 0; i < n; i++) {
                        out->writeBuf[i].re = pcm[(done + i) * 2] / 32768.0f;
                        out->writeBuf[i].im = pcm[(done + i) * 2 + 1] / 32768.0f;
                    }
                    if (!out->swap(n)) { throw NetError("stopped"); }
                    done += n;
                }

                auto el = std::chrono::duration<double>(now - rateStart).count();
                std::lock_guard<std::mutex> lck(statusMtx);
                st.shift = h.shift;
                st.basebandPower = h.basebandPower;
                st.noise = h.noise;
                if (el >= 1.0) {
                    st.kbytesPerSec = rateBytes / el / 1000.0;
                    rateBytes = 0;
                    rateStart = now;
                }
            }
        }
        catch (const std::exception& e) {
            if (!stopping) {
                std::string why = serverError.empty() ? std::string(e.what()) : serverError;
                flog::error("UberSDR: {0}", why);
                setState(State::Failed, why);
            }
        }
        {
            std::lock_guard<std::mutex> lck(wsMtx);
            live = nullptr;
        }
        if (ws) { ws->close(); }
    }
}
