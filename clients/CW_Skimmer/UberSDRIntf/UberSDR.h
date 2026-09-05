#pragma once

#include <string>
#include <vector>
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>

// IXWebSocket library
#include "IXWebSocket/ixwebsocket/IXWebSocket.h"
#include "pcm_v4.hpp"

// Forward declaration
struct UberSDRSharedStatus;

#pragma comment(lib, "ws2_32.lib")

#define MAX_RX_COUNT 8

namespace UberSDRIntf
{
    // WebSocket connection state
    enum ConnectionState {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        ERROR_STATE
    };

    // The ring buffer level the consumer aims to hold, in milliseconds.
    //
    // One number used twice: the cushion a receiver builds before it joins the
    // mix, and the level the consumer's rate trim settles at. They have to be
    // the same or the trim spends its first minutes undoing the priming.
    //
    // 100 ms is five times the ~20 ms burst the server delivers in and past the
    // 90 ms worst gap measured across eight concurrent 96 kHz IQ streams, at a
    // latency no skimmer notices.
    static const int RING_TARGET_MS = 100;

    // Ring buffer for smoothing WebSocket data arrival
    struct RingBuffer {
        std::vector<float> buffer;  // Interleaved I/Q samples (float)
        size_t writePos;
        size_t readPos;
        size_t capacity;            // Total capacity in samples (I/Q pairs)
        CRITICAL_SECTION lock;
        int underrunCount;
        int overrunCount;

        // The cushion the buffer builds before the consumer takes anything
        // from it, and whether it is building one now.
        //
        // Samples do not arrive one at a time. Measured against a live
        // receiver, eight 96 kHz IQ streams arrive in bursts of about 20 ms
        // with occasional gaps of 90, so a buffer the consumer starts draining
        // the instant the socket opens spends the first tenth of a second
        // empty and then rides at whatever level the burst pattern happens to
        // leave. Holding a receiver out of the mix until it has a cushion
        // costs that receiver a tenth of a second of silence once, and removes
        // every underrun after it: simulated against a recorded arrival trace,
        // 7,200 underruns per receiver per start became none.
        size_t primeTarget;
        bool priming;

        // How long priming may hold a receiver out of the mix while data is
        // actually arriving, and whether it has given up doing so.
        //
        // A link that cannot carry the stream would otherwise leave a receiver
        // priming for ever -- silent, where before this it was merely degraded.
        // Only time spent with something in the buffer counts towards the
        // limit: a socket that is down leaves it at zero, and waiting is the
        // right answer there, which is what keeps an outage in silenceCount
        // instead of running the underrun figure back up.
        //
        // Giving up latches until the next reprime(), so a starved receiver
        // pays the wait once per connection rather than once per dry buffer.
        size_t primeStall;
        size_t primeGiveUp;
        bool primeLatched;

        // Frames of silence fed while priming or while the socket is down,
        // counted apart from underrunCount.
        //
        // They were the same figure, and that is what made the monitor's
        // underrun column unreadable. A receiver whose socket drops keeps
        // being drained -- deliberately, so the other seven stay in step --
        // so five minutes off the air was 29 million "underruns" that stayed
        // on the display for the rest of the session, drowning the handful
        // that meant the buffer had actually run dry under load.
        int silenceCount;

        RingBuffer() : writePos(0), readPos(0), capacity(0), underrunCount(0), overrunCount(0),
                       primeTarget(0), priming(true), primeStall(0), primeGiveUp(0),
                       primeLatched(false), silenceCount(0) {
            InitializeCriticalSection(&lock);
        }
        
        ~RingBuffer() {
            DeleteCriticalSection(&lock);
        }
        
        void init(size_t capacityInSamples, size_t primeSamples, size_t primeGiveUpSamples) {
            EnterCriticalSection(&lock);
            capacity = capacityInSamples;
            buffer.resize(capacity * 2);  // *2 for I and Q
            writePos = 0;
            readPos = 0;
            underrunCount = 0;
            overrunCount = 0;
            silenceCount = 0;
            primeTarget = primeSamples;
            primeGiveUp = primeGiveUpSamples;
            priming = true;
            primeStall = 0;
            primeLatched = false;
            LeaveCriticalSection(&lock);
        }

        // Build the cushion again from here. Called wherever a socket is
        // opened: the stream restarts with an empty buffer, and a consumer
        // that resumes on the first frame to arrive would then underrun on
        // every gap in the burst pattern, for the life of the connection,
        // because nothing else ever puts a cushion back.
        void reprime() {
            EnterCriticalSection(&lock);
            priming = true;
            primeStall = 0;
            primeLatched = false;
            LeaveCriticalSection(&lock);
        }
        
        size_t available() {
            // Returns number of samples available to read
            return (writePos - readPos + capacity) % capacity;
        }
        
        size_t space() {
            // Returns number of samples that can be written
            return capacity - available() - 1;
        }
        
        bool write(float I, float Q) {
            EnterCriticalSection(&lock);
            
            if (space() < 1) {
                if (overrunCount < 0x7fffffff) overrunCount++;
                LeaveCriticalSection(&lock);
                return false;  // Buffer full
            }
            
            size_t idx = writePos * 2;
            buffer[idx] = I;
            buffer[idx + 1] = Q;
            writePos = (writePos + 1) % capacity;
            
            LeaveCriticalSection(&lock);
            return true;
        }
        
        bool read(float& I, float& Q) {
            EnterCriticalSection(&lock);

            const size_t avail = available();

            if (priming) {
                if (avail >= primeTarget) {
                    priming = false;
                } else if (avail > 0 && ++primeStall >= primeGiveUp) {
                    // Data is arriving but never enough to build the cushion.
                    // Take what there is rather than stay silent; see
                    // primeStall.
                    priming = false;
                    primeLatched = true;
                } else {
                    // Saturating: an int counts 6.2 hours at 96 kHz, and this
                    // is the counter that a receiver stuck offline runs up.
                    // Wrapping it would report the outage as a negative time.
                    if (silenceCount < 0x7fffffff) silenceCount++;
                    LeaveCriticalSection(&lock);
                    return false;  // Still building the cushion
                }
            }

            if (avail < 1) {
                if (underrunCount < 0x7fffffff) underrunCount++;
                // Rebuild the cushion rather than grind on an empty buffer.
                // Without this the first gap that catches the buffer out
                // leaves it with nothing, and every gap after it underruns
                // again -- one loss becomes a permanent condition.
                if (!primeLatched) {
                    priming = true;
                    primeStall = 0;
                }
                LeaveCriticalSection(&lock);
                return false;  // Buffer empty
            }
            
            size_t idx = readPos * 2;
            I = buffer[idx];
            Q = buffer[idx + 1];
            readPos = (readPos + 1) % capacity;
            
            LeaveCriticalSection(&lock);
            return true;
        }
        
        float fillLevel() {
            // Returns fill level as percentage (0.0 to 1.0)
            return (float)available() / (float)capacity;
        }

        // available() under the lock, for the consumer's rate trim: it reads
        // this once a second from another thread, where an unlocked read of
        // the two cursors could tear.
        size_t availableSafe() {
            EnterCriticalSection(&lock);
            const size_t n = available();
            LeaveCriticalSection(&lock);
            return n;
        }

        bool isPriming() {
            EnterCriticalSection(&lock);
            const bool p = priming;
            LeaveCriticalSection(&lock);
            return p;
        }
    };

    // Receiver information
    struct ReceiverInfo {
        int frequency;
        std::string mode;
        bool active;
        ConnectionState state;
        std::string sessionId;
        ix::WebSocket* wsClient;
        RingBuffer ringBuffer;  // 500ms buffer for smoothing WebSocket data
        int generation;  // Incremented on each reconnection to detect stale callbacks
        CRITICAL_SECTION lock;  // Mutex for thread-safe access
        bool needsReconnect;    // Flag set by close callback
        HANDLE reconnectThread; // Handle to reconnection thread
        int perReceiverOffset;  // Per-receiver frequency offset in Hz (dynamic)
        
        // Software frequency shifting (applied in IQ processing, not at tune)
        double phaseAccumulator;  // Current phase for frequency shift
        double phaseIncrement;    // Phase increment per sample (2*PI*offset/sampleRate)

        // Protocol version 4 decoder, one per receiver.
        //
        // The predictor adapts from the samples already decoded, so its state
        // belongs to a single socket: it must be reset on every (re)connect, or
        // the new stream is decoded against the old stream's filter taps and
        // comes out as plausible noise rather than as an error. See the reset
        // in ConnectWebSocket.
        ubersdr::PCMv4StreamDecoder pcmDecoder;

        // Set when a packet fails to decode, which ends the stream rather than
        // costing one packet: the decoder's filters no longer stand where the
        // server's do, and nothing in the protocol puts them back. The socket
        // is closed so the reconnection path can build a new one; the flag is
        // what keeps the packets still in flight behind it from repeating the
        // close and the log line. Cleared in ConnectWebSocket beside the reset.
        bool pcmStreamBroken;

        ReceiverInfo() : frequency(14074000), mode("iq192"), active(false),
                        state(DISCONNECTED), wsClient(nullptr), generation(0),
                        needsReconnect(false), reconnectThread(NULL), perReceiverOffset(0),
                        phaseAccumulator(0.0), phaseIncrement(0.0), pcmStreamBroken(false) {
            InitializeCriticalSection(&lock);
        }
        
        ~ReceiverInfo() {
            DeleteCriticalSection(&lock);
        }
    };

    class UberSDR
    {
    public:
        // Configuration from INI file
        std::string configHost;
        int configPort;
        bool configFromFilename;
        bool debugRec;  // Enable 10-second WAV recording on start

        // Append every packet, exactly as it came off the socket, to
        // rawN.bin before the decoder is allowed near it.
        //
        // The decoder is backward-adaptive, so a stream that turns to noise
        // cannot be diagnosed from its output: by the time anything looks
        // wrong the taps have been wrong for thousands of packets and the
        // cause is long gone. Capturing the wire separates the only two
        // possibilities left -- bytes that are not what the server sent, or
        // decoder state corrupted between packets -- because the same bytes
        // can then be decoded offline, single-threaded, by a decoder known to
        // reproduce the server's fixtures.
        bool debugRaw;
        int frequencyOffset;  // Frequency correction in Hz (can be positive or negative)
        bool swapIQ;  // Swap I and Q channels (default: true for backward compatibility)
        int minMargin;  // Reduced-depth IQ margin in dB, or 0 for a lossless stream

        // The server's own limits, from lossyMinMarginDB and lossyMaxMarginDB in
        // pcm_lossy.go, repeated here so a value outside them is refused with a
        // reason rather than silently clamped to a different one. The same two
        // numbers appear in clients/hpsdr and clients/soapy_driver.
        static const int kMinMarginMinDB = 15;
        static const int kMinMarginMaxDB = 60;

        // What an installation that has not said otherwise streams at, and the
        // one place this driver differs from the HPSDR bridge and the SoapySDR
        // driver, which both default to lossless.
        //
        // 26 dB is the measured transparent setting -- MARGIN_DEFAULT_DB in
        // static/v2/src/radio/constants.js -- where every FT8 decode survives
        // with its reported strength intact for about half the bytes. It costs
        // about 0.01 dB of noise floor, which is two orders of magnitude below
        // what a receiver's own readings resolve, and the added noise is white,
        // so the penalty does not grow when Skimmer narrows to a CW passband.
        //
        // On by default because this driver only ever tunes IQ, which is the
        // only mode the mode applies to, and because halving the traffic of
        // eight 192 kHz receivers is worth more to a skimmer operator than a
        // hundredth of a decibel. An operator who is recording or measuring the
        // IQ sets min_margin=0 and gets the bit-exact stream back.
        static const int kMinMarginDefaultDB = 26;
        
        // Server connection
        std::string serverHost;
        int serverPort;
        bool useSSL;
        
        // Receiver management
        ReceiverInfo receivers[MAX_RX_COUNT];
        int maxReceivers;
        int activeReceivers;
        
        // Sample rate mapping
        int sampleRate;
        std::string iqMode;  // "iq48", "iq96", or "iq192"
        
        UberSDR(void);
        ~UberSDR(void);
        
        // Connection management
        int Connect(const std::string& host, int port, bool ssl);
        int Disconnect(void);
        bool CheckConnectionAllowed(int receiverID);
        
        // Receiver control
        int StartReceiver(int receiverID, int frequency, const std::string& mode);
        int StopReceiver(int receiverID);
        int SetFrequency(int receiverID, int frequency);
        
        // WebSocket operations
        std::string BuildWebSocketURL(int receiverID, int frequency, const std::string& mode);
        int ConnectWebSocket(int receiverID, const std::string& url);
        void DisconnectWebSocket(int receiverID);
        void HandleWebSocketMessage(int receiverID, const std::string& message);
        void HandleTextMessage(int receiverID, const std::string& message);
        void CaptureRawPacket(int receiverID, const uint8_t *wire, size_t wireSize);
        void SendKeepalive(int receiverID);
        
        // Reconnection thread
        static DWORD WINAPI ReconnectionThreadProc(LPVOID param);
        void HandleReconnection(int receiverID);
        
        // HTTP operations
        bool HttpPost(const std::string& path, const std::string& body, std::string& response);
        
        // Command processing
        void ProcessCommands(struct UberSDRSharedStatus* pSharedStatus);
        int GetTotalFrequencyOffset(int receiverID);
        
    private:
        WSADATA wsaData;
        bool wsaInitialized;
        
        // INI file configuration
        int loadConfigFromIni(void);
        bool isValidHostname(const std::string& host);
        bool isValidPort(int port);
        static int ParseMinMargin(const char* text);
        
        // Mode selection based on sample rate
        std::string selectIQMode(int rateID);
    };
}