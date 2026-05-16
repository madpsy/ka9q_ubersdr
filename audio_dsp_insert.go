package main

// audio_dsp_insert.go — per-session DSP noise-reduction insert via ubersdr-dsp gRPC container.
//
// Architecture
// ────────────
// Each session that has the DSP insert enabled owns one DSPInsert value, which
// holds a single bidirectional gRPC ProcessAudio stream to the ubersdr-dsp
// container.  Two goroutines run for the lifetime of the insert:
//
//   sendLoop  — reads from sendChan, wraps PCM bytes in an AudioChunk, and
//               sends them to the server.  Also forwards ParamUpdate messages
//               from paramChan.
//
//   recvLoop  — reads AudioResponse messages from the server and forwards
//               processed PCM bytes to recvChan.  On any stream error it
//               closes recvChan so streamAudio() can detect the failure.
//
// Fail-open guarantee
// ───────────────────
// If the container is unreachable at enable time, NewDSPInsert returns an
// error and the caller leaves session.dspInsert nil — audio is unaffected.
// If the container crashes mid-stream, recvLoop closes recvChan; streamAudio()
// detects the nil/closed channel and falls back to the original PCM.
//
// Wire format
// ───────────
// SessionConfig is sent with pcm_encoding = PCM_INT16_BE so the container
// handles the int16 ↔ float32 conversion internally.  ubersdr sends and
// receives radiod's native big-endian int16 bytes verbatim — no conversion
// is needed here.

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	dspv1 "github.com/cwsl/ka9q_ubersdr/dsp"
	"google.golang.org/grpc"
)

// dspSendItem is a single PCM chunk queued for the send goroutine.
type dspSendItem struct {
	pcm    []byte
	seqNum uint64
}

// DSPInsert manages a single bidirectional gRPC ProcessAudio stream for one
// session.  It is created by NewDSPInsert and torn down by Close.
type DSPInsert struct {
	stream    dspv1.DspService_ProcessAudioClient
	streamCtx context.Context
	cancel    context.CancelFunc

	sendChan  chan dspSendItem       // PCM chunks to send (buffered)
	recvChan  chan []byte            // processed PCM chunks received (buffered)
	paramChan chan map[string]string // runtime parameter updates

	seqNum uint64 // atomic counter for AudioChunk.sequence_num

	closeOnce sync.Once
	wg        sync.WaitGroup // tracks sendLoop + recvLoop; Close waits on this
}

// dspFilterCache caches the GetFilters response so we only call it once per
// server connection.  Protected by dspFilterMu.
var (
	dspFilterCache   *dspv1.GetFiltersResponse
	dspFilterMu      sync.RWMutex
	dspFilterFetched bool
)

// DSPGetFilters returns the cached filter list, fetching it from the server if
// not yet available.  Returns nil if the server is unreachable.
func DSPGetFilters(conn *grpc.ClientConn) *dspv1.GetFiltersResponse {
	dspFilterMu.RLock()
	if dspFilterFetched {
		resp := dspFilterCache
		dspFilterMu.RUnlock()
		return resp
	}
	dspFilterMu.RUnlock()

	dspFilterMu.Lock()
	defer dspFilterMu.Unlock()

	// Double-check after acquiring write lock.
	if dspFilterFetched {
		return dspFilterCache
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	stub := dspv1.NewDspServiceClient(conn)
	resp, err := stub.GetFilters(ctx, &dspv1.GetFiltersRequest{})
	if err != nil {
		log.Printf("DSP: GetFilters failed: %v", err)
		dspFilterFetched = true // mark as attempted so we don't retry on every request
		dspFilterCache = nil
		return nil
	}

	dspFilterFetched = true
	dspFilterCache = resp
	log.Printf("DSP: cached %d filters from server", len(resp.Filters))
	return resp
}

// DSPInvalidateFilterCache clears the cached filter list so it will be
// re-fetched on the next call to DSPGetFilters.
func DSPInvalidateFilterCache() {
	dspFilterMu.Lock()
	dspFilterFetched = false
	dspFilterCache = nil
	dspFilterMu.Unlock()
}

// NewDSPInsert opens a ProcessAudio gRPC stream to the DSP container, sends
// the SessionConfig, waits for the ack (with a 1-second deadline), and starts
// the send/recv goroutines.
//
// Parameters:
//   - conn       — shared *grpc.ClientConn (one per server, created at startup)
//   - filter     — filter name: "nr2", "rn2", "nr4", "dfnr", "bnr"
//   - sampleRate — session sample rate (must be 12000 or 24000)
//   - channels   — number of channels (1 = mono, 2 = stereo)
//   - params     — initial filter parameters (may be nil)
//
// Returns an error if the container is unreachable, the filter is unknown, or
// the SessionConfig is rejected.  On error the caller should leave
// session.dspInsert nil so audio streams unaffected.
func NewDSPInsert(conn *grpc.ClientConn, filter string, sampleRate, channels int, params map[string]string) (*DSPInsert, error) {
	if conn == nil {
		return nil, fmt.Errorf("DSP: gRPC connection is nil (DSP not configured)")
	}

	// Validate sample rate — ubersdr-dsp only supports 12000 and 24000 Hz.
	if sampleRate != 12000 && sampleRate != 24000 {
		return nil, fmt.Errorf("DSP: unsupported sample rate %d Hz (must be 12000 or 24000)", sampleRate)
	}

	// Use a 1-second deadline for the setup phase (SessionConfig + ack).
	setupCtx, setupCancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer setupCancel()

	stub := dspv1.NewDspServiceClient(conn)

	// Open the bidirectional stream.  The stream itself runs on a long-lived
	// context that is cancelled only by Close().
	streamCtx, streamCancel := context.WithCancel(context.Background())

	stream, err := stub.ProcessAudio(streamCtx)
	if err != nil {
		streamCancel()
		return nil, fmt.Errorf("DSP: failed to open ProcessAudio stream: %w", err)
	}

	// Build SessionConfig.
	cfg := &dspv1.SessionConfig{
		Filter:      filter,
		Block:       0, // advisory only — server accepts any chunk size
		SampleRate:  int32(sampleRate),
		Channels:    int32(channels),
		PcmEncoding: dspv1.PcmEncoding_PCM_INT16_BE,
	}
	if len(params) > 0 {
		cfg.Params = params
	}

	// Send SessionConfig (first message on the stream).
	if err := stream.Send(&dspv1.AudioRequest{
		Payload: &dspv1.AudioRequest_Config{Config: cfg},
	}); err != nil {
		streamCancel()
		return nil, fmt.Errorf("DSP: failed to send SessionConfig: %w", err)
	}

	// Wait for the ack within the setup deadline.
	// We use a goroutine + channel so we can respect the setupCtx deadline.
	type recvResult struct {
		resp *dspv1.AudioResponse
		err  error
	}
	ackCh := make(chan recvResult, 1)
	go func() {
		resp, err := stream.Recv()
		ackCh <- recvResult{resp, err}
	}()

	select {
	case <-setupCtx.Done():
		streamCancel()
		return nil, fmt.Errorf("DSP: timed out waiting for SessionConfig ack (container unreachable or slow)")
	case result := <-ackCh:
		if result.err != nil {
			streamCancel()
			return nil, fmt.Errorf("DSP: error receiving SessionConfig ack: %w", result.err)
		}
		// Check for in-band error response.
		if errResp := result.resp.GetError(); errResp != nil {
			streamCancel()
			return nil, fmt.Errorf("DSP: filter init failed [%s]: %s", errResp.Code, errResp.Message)
		}
		// Expect an empty ParamAck.
		if result.resp.GetAck() == nil {
			streamCancel()
			return nil, fmt.Errorf("DSP: unexpected first response type (expected ParamAck)")
		}
	}

	ins := &DSPInsert{
		stream:    stream,
		streamCtx: streamCtx,
		cancel:    streamCancel,
		sendChan:  make(chan dspSendItem, 32),
		recvChan:  make(chan []byte, 32),
		paramChan: make(chan map[string]string, 8),
	}

	ins.wg.Add(2)
	go ins.sendLoop()
	go ins.recvLoop()

	log.Printf("DSP: insert active (filter=%s, rate=%d, ch=%d)", filter, sampleRate, channels)
	return ins, nil
}

// Send queues a PCM chunk for processing.  It is non-blocking: if the send
// channel is full (DSP container is slow) the chunk is dropped and the
// original PCM should be used by the caller (fail-open).
//
// Returns true if the chunk was queued, false if it was dropped.
func (ins *DSPInsert) Send(pcm []byte) bool {
	seq := atomic.AddUint64(&ins.seqNum, 1)
	// Copy the slice — the caller's buffer may be reused.
	cp := make([]byte, len(pcm))
	copy(cp, pcm)
	select {
	case ins.sendChan <- dspSendItem{pcm: cp, seqNum: seq}:
		return true
	default:
		return false
	}
}

// Recv returns the channel on which processed PCM chunks arrive.
// The channel is closed when the DSP stream terminates (error or Close).
// Callers should use a select with a timeout to implement fail-open.
func (ins *DSPInsert) Recv() <-chan []byte {
	return ins.recvChan
}

// UpdateParams sends a runtime parameter update to the DSP container.
// Non-blocking: if the param channel is full the update is silently dropped.
func (ins *DSPInsert) UpdateParams(params map[string]string) {
	select {
	case ins.paramChan <- params:
	default:
		log.Printf("DSP: param update dropped (channel full)")
	}
}

// Close tears down the DSP insert: cancels the stream context, closes the
// internal channels, and waits for both goroutines to exit.
// Safe to call multiple times.
func (ins *DSPInsert) Close() {
	ins.closeOnce.Do(func() {
		ins.cancel() // cancels streamCtx → unblocks stream.Send / stream.Recv
		close(ins.sendChan)
		close(ins.paramChan)
		ins.wg.Wait() // wait for both sendLoop and recvLoop to exit
		log.Printf("DSP: insert closed")
	})
}

// sendLoop reads from sendChan and paramChan and forwards them to the gRPC
// stream.  Exits when sendChan is closed (by Close) or the stream context is
// cancelled.
func (ins *DSPInsert) sendLoop() {
	defer ins.wg.Done()
	defer func() {
		// Half-close the send side so the server knows we're done.
		_ = ins.stream.CloseSend()
	}()

	for {
		select {
		case <-ins.streamCtx.Done():
			return

		case item, ok := <-ins.sendChan:
			if !ok {
				// sendChan closed by Close() — we're done.
				return
			}
			if err := ins.stream.Send(&dspv1.AudioRequest{
				Payload: &dspv1.AudioRequest_Audio{
					Audio: &dspv1.AudioChunk{
						PcmData:     item.pcm,
						SequenceNum: item.seqNum,
						TimestampUs: uint64(time.Now().UnixMicro()),
					},
				},
			}); err != nil {
				if ins.streamCtx.Err() == nil {
					log.Printf("DSP: send error: %v", err)
				}
				return
			}

		case params, ok := <-ins.paramChan:
			if !ok {
				return
			}
			if err := ins.stream.Send(&dspv1.AudioRequest{
				Payload: &dspv1.AudioRequest_ParamUpdate{
					ParamUpdate: &dspv1.ParamUpdate{Params: params},
				},
			}); err != nil {
				if ins.streamCtx.Err() == nil {
					log.Printf("DSP: param update send error: %v", err)
				}
				return
			}
		}
	}
}

// recvLoop reads AudioResponse messages from the gRPC stream and forwards
// processed PCM to recvChan.  Closes recvChan on any error so streamAudio()
// can detect the failure and fall back to original PCM.
func (ins *DSPInsert) recvLoop() {
	defer ins.wg.Done()
	defer close(ins.recvChan)

	for {
		resp, err := ins.stream.Recv()
		if err != nil {
			if ins.streamCtx.Err() == nil {
				// Unexpected error — log it.
				log.Printf("DSP: recv error: %v", err)
			}
			return
		}

		switch p := resp.Payload.(type) {
		case *dspv1.AudioResponse_Audio:
			if p.Audio == nil || len(p.Audio.PcmData) == 0 {
				continue
			}
			// Forward processed PCM.  Non-blocking: if recvChan is full
			// (streamAudio is slow) drop the chunk — the caller will use
			// the original PCM via its timeout path.
			select {
			case ins.recvChan <- p.Audio.PcmData:
			default:
				// Drop — caller's timeout will handle fail-open.
			}

		case *dspv1.AudioResponse_Ack:
			// ParamAck — log applied/rejected for debugging.
			if p.Ack != nil && DebugMode {
				log.Printf("DSP: ParamAck applied=%v rejected=%v",
					p.Ack.Applied, p.Ack.Rejected)
			}

		case *dspv1.AudioResponse_Error:
			if p.Error != nil {
				log.Printf("DSP: server error [%s]: %s", p.Error.Code, p.Error.Message)
			}
			// Non-fatal in-band errors (e.g. FILTER_CHANGE_NOT_ALLOWED) —
			// stream stays open per the protocol spec.
		}
	}
}

// buildDSPInfo returns a map suitable for JSON serialisation describing the
// DSP configuration.  Used by /api/description and the instance reporter.
// When DSP is disabled the map contains only {"enabled": false}.
// When enabled it also lists the filter names that are allowed by config.
func buildDSPInfo(cfg *DSPConfig) map[string]interface{} {
	if !cfg.Enabled {
		return map[string]interface{}{
			"enabled": false,
		}
	}
	// Collect the names of filters that are enabled in config.
	var filters []string
	for _, name := range []string{"nr2", "rn2", "nr4", "dfnr", "bnr"} {
		if cfg.IsFilterAllowed(name) {
			filters = append(filters, name)
		}
	}
	maxUsers := cfg.MaxUsers // 0 = unlimited
	return map[string]interface{}{
		"enabled":   true,
		"filters":   filters,
		"max_users": maxUsers,
	}
}
