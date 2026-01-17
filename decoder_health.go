package main

import (
	"sync"
	"time"
)

// DecoderHealthStatus represents the health status of the decoder system
type DecoderHealthStatus struct {
	Enabled           bool                  `json:"enabled"`
	Healthy           bool                  `json:"healthy"`
	BandCount         int                   `json:"band_count"`
	Bands             []DecoderBandHealth   `json:"bands"`
	PSKReporterStatus *ReporterHealthStatus `json:"psk_reporter_status,omitempty"`
	WSPRNetStatus     *ReporterHealthStatus `json:"wspr_net_status,omitempty"`
	Issues            []string              `json:"issues"`
	LastUpdateTime    time.Time             `json:"last_update_time"`
}

// DecoderBandHealth represents health information for a single decoder band
type DecoderBandHealth struct {
	Name              string    `json:"name"`
	Mode              string    `json:"mode"`
	Frequency         uint64    `json:"frequency"`
	LastDecoderInvoke time.Time `json:"last_decoder_invoke"`
	LastDataTime      time.Time `json:"last_data_time"`
	IsStale           bool      `json:"is_stale"`
}

// ReporterHealthStatus represents health information for spot reporters
type ReporterHealthStatus struct {
	Enabled      bool      `json:"enabled"`
	LastSendTime time.Time `json:"last_send_time"`
	IsStale      bool      `json:"is_stale"`
	SendCount    int       `json:"send_count"`
}

// DecoderHealthDiagnostics provides detailed diagnostic information
type DecoderHealthDiagnostics struct {
	Config            DecoderHealthConfig      `json:"config"`
	BandDetails       []DecoderBandDiagnostics `json:"band_details"`
	PSKReporterDetail *ReporterDiagnostics     `json:"psk_reporter_detail,omitempty"`
	WSPRNetDetail     *ReporterDiagnostics     `json:"wspr_net_detail,omitempty"`
}

// DecoderHealthConfig contains configuration information
type DecoderHealthConfig struct {
	DataDir            string `json:"data_dir"`
	JT9Path            string `json:"jt9_path"`
	WSPRDPath          string `json:"wsprd_path"`
	ReceiverCallsign   string `json:"receiver_callsign"`
	ReceiverLocator    string `json:"receiver_locator"`
	KeepWav            bool   `json:"keep_wav"`
	KeepLogs           bool   `json:"keep_logs"`
	PSKReporterEnabled bool   `json:"psk_reporter_enabled"`
	WSPRNetEnabled     bool   `json:"wspr_net_enabled"`
	SpotsLogEnabled    bool   `json:"spots_log_enabled"`
	MetricsLogEnabled  bool   `json:"metrics_log_enabled"`
}

// DecoderBandDiagnostics provides detailed band diagnostics
type DecoderBandDiagnostics struct {
	Name              string        `json:"name"`
	Mode              string        `json:"mode"`
	Frequency         uint64        `json:"frequency"`
	SSRC              uint32        `json:"ssrc"`
	SessionID         string        `json:"session_id"`
	LastDecoderInvoke time.Time     `json:"last_decoder_invoke"`
	LastDataTime      time.Time     `json:"last_data_time"`
	TimeSinceInvoke   string        `json:"time_since_invoke"`
	TimeSinceData     string        `json:"time_since_data"`
	CycleTime         time.Duration `json:"cycle_time"`
	IsStale           bool          `json:"is_stale"`
}

// ReporterDiagnostics provides detailed reporter diagnostics
type ReporterDiagnostics struct {
	Enabled       bool      `json:"enabled"`
	LastSendTime  time.Time `json:"last_send_time"`
	TimeSinceSend string    `json:"time_since_send"`
	SendCount     int       `json:"send_count"`
	QueueSize     int       `json:"queue_size"`
	IsStale       bool      `json:"is_stale"`
}

var (
	lastDecoderInvokeTimes = make(map[string]time.Time)
	lastDecoderInvokeMu    sync.RWMutex

	lastPSKReporterSend  time.Time
	lastPSKReporterMu    sync.RWMutex
	pskReporterSendCount int

	lastWSPRNetSend  time.Time
	lastWSPRNetMu    sync.RWMutex
	wsprNetSendCount int
)

// RecordDecoderInvoke records when a decoder binary was invoked for a band
func RecordDecoderInvoke(bandName string) {
	lastDecoderInvokeMu.Lock()
	defer lastDecoderInvokeMu.Unlock()
	lastDecoderInvokeTimes[bandName] = time.Now()
}

// RecordPSKReporterSend records when data was sent to PSKReporter
func RecordPSKReporterSend() {
	lastPSKReporterMu.Lock()
	defer lastPSKReporterMu.Unlock()
	lastPSKReporterSend = time.Now()
	pskReporterSendCount++
}

// RecordWSPRNetSend records when data was sent to WSPRNet
func RecordWSPRNetSend() {
	lastWSPRNetMu.Lock()
	defer lastWSPRNetMu.Unlock()
	lastWSPRNetSend = time.Now()
	wsprNetSendCount++
}

// GetHealthStatus returns the current health status of the decoder system
func (md *MultiDecoder) GetHealthStatus() DecoderHealthStatus {
	if md == nil {
		return DecoderHealthStatus{
			Enabled: false,
			Healthy: true,
			Issues:  []string{"Decoder system is not enabled"},
		}
	}

	status := DecoderHealthStatus{
		Enabled:        true,
		Healthy:        true,
		BandCount:      len(md.decoderBands),
		Bands:          make([]DecoderBandHealth, 0, len(md.decoderBands)),
		Issues:         make([]string, 0),
		LastUpdateTime: time.Now(),
	}

	// Check each band
	for _, band := range md.decoderBands {
		modeInfo := GetModeInfo(band.Config.Mode)

		lastDecoderInvokeMu.RLock()
		lastInvoke := lastDecoderInvokeTimes[band.Config.Name]
		lastDecoderInvokeMu.RUnlock()

		band.mu.Lock()
		lastData := band.LastDataTime
		band.mu.Unlock()

		// Consider stale if no decoder invocation in 3x cycle time OR no data in 3x cycle time
		staleThreshold := modeInfo.CycleTime * 3
		timeSinceInvoke := time.Since(lastInvoke)
		timeSinceData := time.Since(lastData)

		// Band is stale if:
		// 1. Decoder hasn't been invoked in 3x cycle time (and has been invoked at least once)
		// 2. OR no data processed in 3x cycle time (and has processed data at least once)
		// This ensures WSPR (2min cycle) isn't marked stale within its normal cycle
		isStale := (!lastInvoke.IsZero() && timeSinceInvoke > staleThreshold) ||
			(!lastData.IsZero() && timeSinceData > staleThreshold)

		bandHealth := DecoderBandHealth{
			Name:              band.Config.Name,
			Mode:              band.Config.Mode.String(),
			Frequency:         band.Config.Frequency,
			LastDecoderInvoke: lastInvoke,
			LastDataTime:      lastData,
			IsStale:           isStale,
		}

		status.Bands = append(status.Bands, bandHealth)

		// Add issues - skip decoder invocation check for streaming modes
		if !modeInfo.IsStreaming {
			if lastInvoke.IsZero() {
				status.Issues = append(status.Issues, "Band "+band.Config.Name+": decoder has never been invoked")
				status.Healthy = false
			} else if isStale {
				status.Issues = append(status.Issues, "Band "+band.Config.Name+": no decoder invocation in "+timeSinceInvoke.Round(time.Second).String())
				status.Healthy = false
			}
		}

		// Check for data flow - use same threshold as decoder invocation (3x cycle time)
		if lastData.IsZero() {
			status.Issues = append(status.Issues, "Band "+band.Config.Name+": no audio data received")
			status.Healthy = false
		} else {
			timeSinceData := time.Since(lastData)
			dataStaleThreshold := staleThreshold // Use same 3x cycle time threshold
			if timeSinceData > dataStaleThreshold {
				status.Issues = append(status.Issues, "Band "+band.Config.Name+": no audio data in "+timeSinceData.Round(time.Second).String())
				status.Healthy = false
			}
		}
	}

	// Check PSKReporter status
	if md.pskReporter != nil {
		lastPSKReporterMu.RLock()
		lastSend := lastPSKReporterSend
		sendCount := pskReporterSendCount
		lastPSKReporterMu.RUnlock()

		// Consider stale if no send in 10 minutes (should send every 18-38 seconds)
		isStale := !lastSend.IsZero() && time.Since(lastSend) > 10*time.Minute

		status.PSKReporterStatus = &ReporterHealthStatus{
			Enabled:      true,
			LastSendTime: lastSend,
			IsStale:      isStale,
			SendCount:    sendCount,
		}

		if lastSend.IsZero() {
			status.Issues = append(status.Issues, "PSKReporter: no data has been sent yet")
		} else if isStale {
			status.Issues = append(status.Issues, "PSKReporter: no data sent in "+time.Since(lastSend).Round(time.Second).String())
		}
	}

	// Check WSPRNet status
	if md.wsprNet != nil {
		lastWSPRNetMu.RLock()
		lastSend := lastWSPRNetSend
		sendCount := wsprNetSendCount
		lastWSPRNetMu.RUnlock()

		// Consider stale if no send in 10 minutes
		isStale := !lastSend.IsZero() && time.Since(lastSend) > 10*time.Minute

		status.WSPRNetStatus = &ReporterHealthStatus{
			Enabled:      true,
			LastSendTime: lastSend,
			IsStale:      isStale,
			SendCount:    sendCount,
		}

		if lastSend.IsZero() {
			status.Issues = append(status.Issues, "WSPRNet: no data has been sent yet")
		} else if isStale {
			status.Issues = append(status.Issues, "WSPRNet: no data sent in "+time.Since(lastSend).Round(time.Second).String())
		}
	}

	return status
}

// IsHealthy returns true if the decoder system is healthy
func (md *MultiDecoder) IsHealthy() bool {
	if md == nil {
		return true // Not enabled, so not unhealthy
	}

	status := md.GetHealthStatus()
	return status.Healthy
}

// GetStartupDiagnostics returns detailed diagnostic information
func (md *MultiDecoder) GetStartupDiagnostics() DecoderHealthDiagnostics {
	if md == nil {
		return DecoderHealthDiagnostics{}
	}

	diag := DecoderHealthDiagnostics{
		Config: DecoderHealthConfig{
			DataDir:            md.config.DataDir,
			JT9Path:            md.config.JT9Path,
			WSPRDPath:          md.config.WSPRDPath,
			ReceiverCallsign:   md.config.ReceiverCallsign,
			ReceiverLocator:    md.config.ReceiverLocator,
			KeepWav:            md.config.KeepWav,
			KeepLogs:           md.config.KeepLogs,
			PSKReporterEnabled: md.config.PSKReporterEnabled,
			WSPRNetEnabled:     md.config.WSPRNetEnabled,
			SpotsLogEnabled:    md.config.SpotsLogEnabled,
			MetricsLogEnabled:  md.config.MetricsLogEnabled,
		},
		BandDetails: make([]DecoderBandDiagnostics, 0, len(md.decoderBands)),
	}

	// Get band details
	for _, band := range md.decoderBands {
		modeInfo := GetModeInfo(band.Config.Mode)

		lastDecoderInvokeMu.RLock()
		lastInvoke := lastDecoderInvokeTimes[band.Config.Name]
		lastDecoderInvokeMu.RUnlock()

		band.mu.Lock()
		lastData := band.LastDataTime
		band.mu.Unlock()

		timeSinceInvoke := time.Since(lastInvoke)
		timeSinceData := time.Since(lastData)
		staleThreshold := modeInfo.CycleTime * 3

		// Band is stale if:
		// 1. Decoder hasn't been invoked in 3x cycle time (and has been invoked at least once)
		// 2. OR no audio data received in 30 seconds (and has received data at least once)
		isStale := (!lastInvoke.IsZero() && timeSinceInvoke > staleThreshold) ||
			(!lastData.IsZero() && timeSinceData > 30*time.Second)

		bandDiag := DecoderBandDiagnostics{
			Name:              band.Config.Name,
			Mode:              band.Config.Mode.String(),
			Frequency:         band.Config.Frequency,
			SSRC:              band.SSRC,
			SessionID:         band.SessionID,
			LastDecoderInvoke: lastInvoke,
			LastDataTime:      lastData,
			TimeSinceInvoke:   timeSinceInvoke.Round(time.Second).String(),
			TimeSinceData:     timeSinceData.Round(time.Second).String(),
			CycleTime:         modeInfo.CycleTime,
			IsStale:           isStale,
		}

		diag.BandDetails = append(diag.BandDetails, bandDiag)
	}

	// Get PSKReporter details
	if md.pskReporter != nil {
		lastPSKReporterMu.RLock()
		lastSend := lastPSKReporterSend
		sendCount := pskReporterSendCount
		lastPSKReporterMu.RUnlock()

		md.pskReporter.queueMutex.Lock()
		queueSize := len(md.pskReporter.reportQueue)
		md.pskReporter.queueMutex.Unlock()

		timeSinceSend := time.Since(lastSend)
		isStale := !lastSend.IsZero() && timeSinceSend > 10*time.Minute

		diag.PSKReporterDetail = &ReporterDiagnostics{
			Enabled:       true,
			LastSendTime:  lastSend,
			TimeSinceSend: timeSinceSend.Round(time.Second).String(),
			SendCount:     sendCount,
			QueueSize:     queueSize,
			IsStale:       isStale,
		}
	}

	// Get WSPRNet details
	if md.wsprNet != nil {
		lastWSPRNetMu.RLock()
		lastSend := lastWSPRNetSend
		sendCount := wsprNetSendCount
		lastWSPRNetMu.RUnlock()

		md.wsprNet.queueMutex.Lock()
		queueSize := len(md.wsprNet.reportQueue)
		md.wsprNet.queueMutex.Unlock()

		timeSinceSend := time.Since(lastSend)
		isStale := !lastSend.IsZero() && timeSinceSend > 10*time.Minute

		diag.WSPRNetDetail = &ReporterDiagnostics{
			Enabled:       true,
			LastSendTime:  lastSend,
			TimeSinceSend: timeSinceSend.Round(time.Second).String(),
			SendCount:     sendCount,
			QueueSize:     queueSize,
			IsStale:       isStale,
		}
	}

	return diag
}
