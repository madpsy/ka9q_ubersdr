package main

import (
	"context"
	"fmt"
	"log"
	"runtime"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/push"
)

// PrometheusMetrics holds all Prometheus metric collectors for noisefloor data and system metrics
type PrometheusMetrics struct {
	// Noise floor metrics (all with 'band' label)
	noiseFloorP5     *prometheus.GaugeVec // 5th percentile (noise floor estimate)
	noiseFloorP10    *prometheus.GaugeVec // 10th percentile
	noiseFloorMedian *prometheus.GaugeVec // Median power level
	noiseFloorMean   *prometheus.GaugeVec // Mean power level
	noiseFloorP95    *prometheus.GaugeVec // 95th percentile (signal peaks)
	noiseFloorMax    *prometheus.GaugeVec // Maximum power level
	noiseFloorMin    *prometheus.GaugeVec // Minimum power level
	dynamicRange     *prometheus.GaugeVec // Dynamic range (P95 - P5)
	occupancyPercent *prometheus.GaugeVec // Percentage of bins above noise + 10dB
	ft8SNR           *prometheus.GaugeVec // FT8 SNR estimate
	lastUpdate       *prometheus.GaugeVec // Unix timestamp of last measurement

	// Digital decode metrics (with 'mode' and 'band' labels)
	digitalDecodesPerCycle1m  *prometheus.GaugeVec // Average decodes per cycle (last 1 minute)
	digitalDecodesPerCycle5m  *prometheus.GaugeVec // Average decodes per cycle (last 5 minutes)
	digitalDecodesPerCycle15m *prometheus.GaugeVec // Average decodes per cycle (last 15 minutes)
	digitalDecodesPerCycle30m *prometheus.GaugeVec // Average decodes per cycle (last 30 minutes)
	digitalDecodesPerCycle60m *prometheus.GaugeVec // Average decodes per cycle (last 60 minutes)
	digitalDecodesTotal1h     *prometheus.GaugeVec // Total decodes in last 1 hour
	digitalDecodesTotal3h     *prometheus.GaugeVec // Total decodes in last 3 hours
	digitalDecodesTotal6h     *prometheus.GaugeVec // Total decodes in last 6 hours
	digitalDecodesTotal12h    *prometheus.GaugeVec // Total decodes in last 12 hours
	digitalDecodesTotal24h    *prometheus.GaugeVec // Total decodes in last 24 hours
	digitalUniqueCallsigns1h  *prometheus.GaugeVec // Unique callsigns in last 1 hour
	digitalUniqueCallsigns3h  *prometheus.GaugeVec // Unique callsigns in last 3 hours
	digitalUniqueCallsigns6h  *prometheus.GaugeVec // Unique callsigns in last 6 hours
	digitalUniqueCallsigns12h *prometheus.GaugeVec // Unique callsigns in last 12 hours
	digitalUniqueCallsigns24h *prometheus.GaugeVec // Unique callsigns in last 24 hours
	digitalExecTime1mAvg      *prometheus.GaugeVec // Average decoder execution time (last 1 minute)
	digitalExecTime1mMin      *prometheus.GaugeVec // Minimum decoder execution time (last 1 minute)
	digitalExecTime1mMax      *prometheus.GaugeVec // Maximum decoder execution time (last 1 minute)
	digitalExecTime5mAvg      *prometheus.GaugeVec // Average decoder execution time (last 5 minutes)
	digitalExecTime5mMin      *prometheus.GaugeVec // Minimum decoder execution time (last 5 minutes)
	digitalExecTime5mMax      *prometheus.GaugeVec // Maximum decoder execution time (last 5 minutes)
	digitalExecTime10mAvg     *prometheus.GaugeVec // Average decoder execution time (last 10 minutes)
	digitalExecTime10mMin     *prometheus.GaugeVec // Minimum decoder execution time (last 10 minutes)
	digitalExecTime10mMax     *prometheus.GaugeVec // Maximum decoder execution time (last 10 minutes)

	// CW Skimmer metrics (with 'band' label)
	cwSpotsTotal1h       *prometheus.GaugeVec // Total CW spots in last 1 hour
	cwSpotsTotal3h       *prometheus.GaugeVec // Total CW spots in last 3 hours
	cwSpotsTotal6h       *prometheus.GaugeVec // Total CW spots in last 6 hours
	cwSpotsTotal12h      *prometheus.GaugeVec // Total CW spots in last 12 hours
	cwSpotsTotal24h      *prometheus.GaugeVec // Total CW spots in last 24 hours
	cwUniqueCallsigns1h  *prometheus.GaugeVec // Unique callsigns in last 1 hour
	cwUniqueCallsigns3h  *prometheus.GaugeVec // Unique callsigns in last 3 hours
	cwUniqueCallsigns6h  *prometheus.GaugeVec // Unique callsigns in last 6 hours
	cwUniqueCallsigns12h *prometheus.GaugeVec // Unique callsigns in last 12 hours
	cwUniqueCallsigns24h *prometheus.GaugeVec // Unique callsigns in last 24 hours
	cwWPMAvg1m           *prometheus.GaugeVec // Average WPM (last 1 minute)
	cwWPMMin1m           *prometheus.GaugeVec // Minimum WPM (last 1 minute)
	cwWPMMax1m           *prometheus.GaugeVec // Maximum WPM (last 1 minute)
	cwWPMAvg5m           *prometheus.GaugeVec // Average WPM (last 5 minutes)
	cwWPMMin5m           *prometheus.GaugeVec // Minimum WPM (last 5 minutes)
	cwWPMMax5m           *prometheus.GaugeVec // Maximum WPM (last 5 minutes)
	cwWPMAvg10m          *prometheus.GaugeVec // Average WPM (last 10 minutes)
	cwWPMMin10m          *prometheus.GaugeVec // Minimum WPM (last 10 minutes)
	cwWPMMax10m          *prometheus.GaugeVec // Maximum WPM (last 10 minutes)
	cwSpotsPerHour       *prometheus.GaugeVec // Spots per hour activity metric
	cwCallsignsPerHour   *prometheus.GaugeVec // Callsigns per hour activity metric

	// System metrics
	activeSessions         prometheus.Gauge // Total active sessions (audio + spectrum)
	activeUsers            prometheus.Gauge // Total unique users (by UUID)
	activeUsersRegular     prometheus.Gauge // Unique regular users (no bypass)
	activeUsersPassword    prometheus.Gauge // Unique password-bypassed users
	activeUsersBypassed    prometheus.Gauge // Unique IP-bypassed users
	activeAudioSessions    prometheus.Gauge // Active audio sessions only
	activeSpectrumSessions prometheus.Gauge // Active spectrum sessions only

	// Radiod channel metrics
	radiodChannelsTotal    prometheus.Gauge // Total active radiod channels
	radiodAudioChannels    prometheus.Gauge // Active audio radiod channels
	radiodSpectrumChannels prometheus.Gauge // Active spectrum radiod channels

	// WebSocket metrics
	wsConnectionsTotal      *prometheus.CounterVec // Total WebSocket connections established (by type)
	wsDisconnectsTotal      *prometheus.CounterVec // Total WebSocket disconnections (by type)
	wsActiveConnections     *prometheus.GaugeVec   // Currently active WebSocket connections (by type)
	wsMessagesReceivedTotal *prometheus.CounterVec // Total messages received (by type: audio, spectrum, dxcluster)
	wsMessagesSentTotal     *prometheus.CounterVec // Total messages sent (by type)

	// Data throughput metrics
	audioBytesTotal      prometheus.Counter // Total audio bytes sent
	spectrumPacketsTotal prometheus.Counter // Total spectrum packets sent

	// DX Cluster metrics
	dxSpotsTotal         *prometheus.CounterVec // Total DX spots received from cluster (by band)
	dxClusterConnections prometheus.Counter     // Total DX cluster connection attempts
	dxClusterDisconnects prometheus.Counter     // Total DX cluster disconnections
	dxClusterConnected   prometheus.Gauge       // Current DX cluster connection status (1=connected, 0=disconnected)

	// Error metrics
	sessionCreationErrors prometheus.Counter     // Failed session creations
	radiodErrors          prometheus.Counter     // Radiod communication errors
	rateLimitErrors       *prometheus.CounterVec // HTTP 429 rate limit errors (by type)
	idleTimeoutKicks      *prometheus.CounterVec // Users kicked due to idle timeout (by type)

	// Performance metrics
	sessionDuration  *prometheus.HistogramVec // Session duration histogram (by type: audio, spectrum)
	aggregateLatency prometheus.Histogram     // Aggregate endpoint request latency

	// Resource metrics
	goroutineCount   prometheus.Gauge // Current number of goroutines
	memoryAllocBytes prometheus.Gauge // Current memory allocated in bytes
	memoryTotalBytes prometheus.Gauge // Total memory allocated (cumulative)
	memoryHeapBytes  prometheus.Gauge // Current heap memory in bytes
	memoryStackBytes prometheus.Gauge // Current stack memory in bytes
	gcPauseSeconds   prometheus.Gauge // Last GC pause duration in seconds

	// Space weather metrics
	spaceWeatherSolarFlux      prometheus.Gauge     // Solar flux (10.7cm) in SFU
	spaceWeatherKIndex         prometheus.Gauge     // Planetary K-index (0-9)
	spaceWeatherAIndex         prometheus.Gauge     // Planetary A-index
	spaceWeatherSolarWindBz    prometheus.Gauge     // Solar wind Bz component in nT
	spaceWeatherBandConditions *prometheus.GaugeVec // Band conditions (1=Poor, 2=Fair, 3=Good, 4=Excellent) with band and time_of_day labels
	spaceWeatherLastUpdate     prometheus.Gauge     // Unix timestamp of last space weather update

	// Pushgateway metrics
	pushgatewayPushesTotal   prometheus.Counter // Total push attempts to Pushgateway
	pushgatewaySuccessTotal  prometheus.Counter // Successful pushes to Pushgateway
	pushgatewayFailuresTotal prometheus.Counter // Failed pushes to Pushgateway
	pushgatewayLastPushTime  prometheus.Gauge   // Unix timestamp of last successful push

	// MQTT publisher
	mqttPublisher *MQTTPublisher // MQTT publisher for metrics

	// Digital decode metrics tracker
	digitalMetrics *DigitalDecodeMetrics

	// CW Skimmer metrics tracker
	cwMetrics *CWSkimmerMetrics

	mu sync.RWMutex // Protects metric updates
}

// NewPrometheusMetrics creates and registers all Prometheus metrics
func NewPrometheusMetrics() *PrometheusMetrics {
	pm := &PrometheusMetrics{
		noiseFloorP5: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_p5_db",
				Help: "5th percentile noise floor in dB (noise floor estimate)",
			},
			[]string{"band"},
		),
		noiseFloorP10: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_p10_db",
				Help: "10th percentile noise floor in dB",
			},
			[]string{"band"},
		),
		noiseFloorMedian: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_median_db",
				Help: "Median noise floor power level in dB",
			},
			[]string{"band"},
		),
		noiseFloorMean: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_mean_db",
				Help: "Mean noise floor power level in dB",
			},
			[]string{"band"},
		),
		noiseFloorP95: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_p95_db",
				Help: "95th percentile signal peak in dB",
			},
			[]string{"band"},
		),
		noiseFloorMax: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_max_db",
				Help: "Maximum power level in dB",
			},
			[]string{"band"},
		),
		noiseFloorMin: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_min_db",
				Help: "Minimum power level in dB",
			},
			[]string{"band"},
		),
		dynamicRange: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_dynamic_range_db",
				Help: "Dynamic range in dB (P95 - P5)",
			},
			[]string{"band"},
		),
		occupancyPercent: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_occupancy_percent",
				Help: "Percentage of frequency bins above noise floor + 10dB",
			},
			[]string{"band"},
		),
		ft8SNR: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_ft8_snr_db",
				Help: "FT8 signal-to-noise ratio in dB",
			},
			[]string{"band"},
		),
		lastUpdate: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "noisefloor_last_update_timestamp",
				Help: "Unix timestamp of last noise floor measurement",
			},
			[]string{"band"},
		),
		digitalDecodesPerCycle1m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_per_cycle_avg_1m",
				Help: "Average decodes per cycle for the last 1 minute by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesPerCycle5m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_per_cycle_avg_5m",
				Help: "Average decodes per cycle for the last 5 minutes by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesPerCycle15m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_per_cycle_avg_15m",
				Help: "Average decodes per cycle for the last 15 minutes by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesPerCycle30m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_per_cycle_avg_30m",
				Help: "Average decodes per cycle for the last 30 minutes by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesPerCycle60m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_per_cycle_avg_60m",
				Help: "Average decodes per cycle for the last 60 minutes by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesTotal1h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_total_1h",
				Help: "Total decodes in the last 1 hour by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesTotal3h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_total_3h",
				Help: "Total decodes in the last 3 hours by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesTotal6h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_total_6h",
				Help: "Total decodes in the last 6 hours by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesTotal12h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_total_12h",
				Help: "Total decodes in the last 12 hours by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalDecodesTotal24h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decodes_total_24h",
				Help: "Total decodes in the last 24 hours by mode and band",
			},
			[]string{"mode", "band"},
		),
		digitalUniqueCallsigns1h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_unique_callsigns_1h",
				Help: "Unique callsign+band+mode combinations in the last 1 hour",
			},
			[]string{"mode", "band"},
		),
		digitalUniqueCallsigns3h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_unique_callsigns_3h",
				Help: "Unique callsign+band+mode combinations in the last 3 hours",
			},
			[]string{"mode", "band"},
		),
		digitalUniqueCallsigns6h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_unique_callsigns_6h",
				Help: "Unique callsign+band+mode combinations in the last 6 hours",
			},
			[]string{"mode", "band"},
		),
		digitalUniqueCallsigns12h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_unique_callsigns_12h",
				Help: "Unique callsign+band+mode combinations in the last 12 hours",
			},
			[]string{"mode", "band"},
		),
		digitalUniqueCallsigns24h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_unique_callsigns_24h",
				Help: "Unique callsign+band+mode combinations in the last 24 hours",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime1mAvg: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_1m_avg_seconds",
				Help: "Average decoder execution time in seconds (last 1 minute)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime1mMin: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_1m_min_seconds",
				Help: "Minimum decoder execution time in seconds (last 1 minute)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime1mMax: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_1m_max_seconds",
				Help: "Maximum decoder execution time in seconds (last 1 minute)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime5mAvg: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_5m_avg_seconds",
				Help: "Average decoder execution time in seconds (last 5 minutes)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime5mMin: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_5m_min_seconds",
				Help: "Minimum decoder execution time in seconds (last 5 minutes)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime5mMax: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_5m_max_seconds",
				Help: "Maximum decoder execution time in seconds (last 5 minutes)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime10mAvg: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_10m_avg_seconds",
				Help: "Average decoder execution time in seconds (last 10 minutes)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime10mMin: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_10m_min_seconds",
				Help: "Minimum decoder execution time in seconds (last 10 minutes)",
			},
			[]string{"mode", "band"},
		),
		digitalExecTime10mMax: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "digital_decoder_exec_time_10m_max_seconds",
				Help: "Maximum decoder execution time in seconds (last 10 minutes)",
			},
			[]string{"mode", "band"},
		),
		digitalMetrics: NewDigitalDecodeMetrics(),
		cwSpotsTotal1h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_spots_total_1h",
				Help: "Total CW spots in the last 1 hour by band",
			},
			[]string{"band"},
		),
		cwSpotsTotal3h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_spots_total_3h",
				Help: "Total CW spots in the last 3 hours by band",
			},
			[]string{"band"},
		),
		cwSpotsTotal6h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_spots_total_6h",
				Help: "Total CW spots in the last 6 hours by band",
			},
			[]string{"band"},
		),
		cwSpotsTotal12h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_spots_total_12h",
				Help: "Total CW spots in the last 12 hours by band",
			},
			[]string{"band"},
		),
		cwSpotsTotal24h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_spots_total_24h",
				Help: "Total CW spots in the last 24 hours by band",
			},
			[]string{"band"},
		),
		cwUniqueCallsigns1h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_unique_callsigns_1h",
				Help: "Unique callsigns in the last 1 hour by band",
			},
			[]string{"band"},
		),
		cwUniqueCallsigns3h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_unique_callsigns_3h",
				Help: "Unique callsigns in the last 3 hours by band",
			},
			[]string{"band"},
		),
		cwUniqueCallsigns6h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_unique_callsigns_6h",
				Help: "Unique callsigns in the last 6 hours by band",
			},
			[]string{"band"},
		),
		cwUniqueCallsigns12h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_unique_callsigns_12h",
				Help: "Unique callsigns in the last 12 hours by band",
			},
			[]string{"band"},
		),
		cwUniqueCallsigns24h: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_unique_callsigns_24h",
				Help: "Unique callsigns in the last 24 hours by band",
			},
			[]string{"band"},
		),
		cwWPMAvg1m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_avg_1m",
				Help: "Average WPM in the last 1 minute by band",
			},
			[]string{"band"},
		),
		cwWPMMin1m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_min_1m",
				Help: "Minimum WPM in the last 1 minute by band",
			},
			[]string{"band"},
		),
		cwWPMMax1m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_max_1m",
				Help: "Maximum WPM in the last 1 minute by band",
			},
			[]string{"band"},
		),
		cwWPMAvg5m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_avg_5m",
				Help: "Average WPM in the last 5 minutes by band",
			},
			[]string{"band"},
		),
		cwWPMMin5m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_min_5m",
				Help: "Minimum WPM in the last 5 minutes by band",
			},
			[]string{"band"},
		),
		cwWPMMax5m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_max_5m",
				Help: "Maximum WPM in the last 5 minutes by band",
			},
			[]string{"band"},
		),
		cwWPMAvg10m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_avg_10m",
				Help: "Average WPM in the last 10 minutes by band",
			},
			[]string{"band"},
		),
		cwWPMMin10m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_min_10m",
				Help: "Minimum WPM in the last 10 minutes by band",
			},
			[]string{"band"},
		),
		cwWPMMax10m: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_wpm_max_10m",
				Help: "Maximum WPM in the last 10 minutes by band",
			},
			[]string{"band"},
		),
		cwSpotsPerHour: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_spots_per_hour",
				Help: "CW spots per hour activity metric by band",
			},
			[]string{"band"},
		),
		cwCallsignsPerHour: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cw_callsigns_per_hour",
				Help: "Unique CW callsigns per hour activity metric by band",
			},
			[]string{"band"},
		),
	}

	log.Println("Prometheus metrics initialized for noisefloor monitoring, system stats, digital decodes, and CW Skimmer")
	return pm
}

// InitializeSystemMetrics adds system metrics to the Prometheus registry
func (pm *PrometheusMetrics) InitializeSystemMetrics() {
	// Session metrics
	pm.activeSessions = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_active_sessions_total",
			Help: "Total number of active sessions (audio + spectrum)",
		},
	)
	pm.activeUsers = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_active_users_total",
			Help: "Total number of unique active users (by user_session_id UUID)",
		},
	)
	pm.activeUsersRegular = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_active_users_regular",
			Help: "Number of unique regular users (no bypass authentication)",
		},
	)
	pm.activeUsersPassword = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_active_users_password_bypassed",
			Help: "Number of unique password-bypassed users",
		},
	)
	pm.activeUsersBypassed = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_active_users_ip_bypassed",
			Help: "Number of unique IP-bypassed users",
		},
	)
	pm.activeAudioSessions = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_active_audio_sessions_total",
			Help: "Total number of active audio sessions",
		},
	)
	pm.activeSpectrumSessions = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_active_spectrum_sessions_total",
			Help: "Total number of active spectrum sessions",
		},
	)

	// Radiod channel metrics
	pm.radiodChannelsTotal = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_radiod_channels_total",
			Help: "Total number of active radiod channels (audio + spectrum)",
		},
	)
	pm.radiodAudioChannels = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_radiod_audio_channels_total",
			Help: "Total number of active audio radiod channels",
		},
	)
	pm.radiodSpectrumChannels = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_radiod_spectrum_channels_total",
			Help: "Total number of active spectrum radiod channels",
		},
	)

	// WebSocket metrics
	pm.wsConnectionsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ubersdr_websocket_connections_total",
			Help: "Total number of WebSocket connections established by type",
		},
		[]string{"type"}, // audio, spectrum, dxcluster
	)
	pm.wsDisconnectsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ubersdr_websocket_disconnects_total",
			Help: "Total number of WebSocket disconnections by type",
		},
		[]string{"type"}, // audio, spectrum, dxcluster
	)
	pm.wsActiveConnections = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ubersdr_websocket_active_connections",
			Help: "Currently active WebSocket connections by type",
		},
		[]string{"type"}, // audio, spectrum, dxcluster
	)
	pm.wsMessagesReceivedTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ubersdr_websocket_messages_received_total",
			Help: "Total WebSocket messages received by type",
		},
		[]string{"type"}, // audio, spectrum, dxcluster
	)
	pm.wsMessagesSentTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ubersdr_websocket_messages_sent_total",
			Help: "Total WebSocket messages sent by type",
		},
		[]string{"type"}, // audio, spectrum, dxcluster
	)

	// Data throughput metrics
	pm.audioBytesTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_audio_bytes_total",
			Help: "Total audio bytes sent to clients",
		},
	)
	pm.spectrumPacketsTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_spectrum_packets_total",
			Help: "Total spectrum packets sent to clients",
		},
	)

	// DX Cluster metrics
	pm.dxSpotsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ubersdr_dx_spots_total",
			Help: "Total DX spots received from cluster by band",
		},
		[]string{"band"}, // 160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m, 6m, other
	)
	pm.dxClusterConnections = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_dx_cluster_connections_total",
			Help: "Total DX cluster connection attempts",
		},
	)
	pm.dxClusterDisconnects = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_dx_cluster_disconnects_total",
			Help: "Total DX cluster disconnections",
		},
	)
	pm.dxClusterConnected = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_dx_cluster_connected",
			Help: "Current DX cluster connection status (1=connected, 0=disconnected)",
		},
	)

	// Error metrics
	pm.sessionCreationErrors = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_session_creation_errors_total",
			Help: "Total number of failed session creations",
		},
	)
	pm.radiodErrors = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_radiod_errors_total",
			Help: "Total number of radiod communication errors",
		},
	)
	pm.rateLimitErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ubersdr_rate_limit_errors_total",
			Help: "Total number of HTTP 429 rate limit errors by type",
		},
		[]string{"type"}, // audio, spectrum, connection, aggregate, fft, etc.
	)
	pm.idleTimeoutKicks = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ubersdr_idle_timeout_kicks_total",
			Help: "Total number of users kicked due to idle timeout by session type",
		},
		[]string{"type"}, // audio, spectrum, mixed
	)

	// Performance metrics
	pm.sessionDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "ubersdr_session_duration_seconds",
			Help:    "Session duration in seconds",
			Buckets: []float64{1, 5, 10, 30, 60, 300, 600, 1800, 3600, 7200}, // 1s to 2h
		},
		[]string{"type"}, // audio, spectrum
	)
	pm.aggregateLatency = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "ubersdr_aggregate_request_duration_seconds",
			Help:    "Aggregate endpoint request duration in seconds",
			Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0}, // 10ms to 10s
		},
	)

	// Resource metrics
	pm.goroutineCount = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_goroutines_total",
			Help: "Current number of goroutines",
		},
	)
	pm.memoryAllocBytes = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_memory_alloc_bytes",
			Help: "Current memory allocated in bytes",
		},
	)
	pm.memoryTotalBytes = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_memory_total_bytes",
			Help: "Total memory allocated (cumulative) in bytes",
		},
	)
	pm.memoryHeapBytes = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_memory_heap_bytes",
			Help: "Current heap memory in bytes",
		},
	)
	pm.memoryStackBytes = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_memory_stack_bytes",
			Help: "Current stack memory in bytes",
		},
	)
	pm.gcPauseSeconds = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_gc_pause_seconds",
			Help: "Last garbage collection pause duration in seconds",
		},
	)

	// Pushgateway metrics
	pm.pushgatewayPushesTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_pushgateway_pushes_total",
			Help: "Total number of push attempts to Pushgateway",
		},
	)
	pm.pushgatewaySuccessTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_pushgateway_success_total",
			Help: "Total number of successful pushes to Pushgateway",
		},
	)
	pm.pushgatewayFailuresTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ubersdr_pushgateway_failures_total",
			Help: "Total number of failed pushes to Pushgateway",
		},
	)
	pm.pushgatewayLastPushTime = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ubersdr_pushgateway_last_push_timestamp",
			Help: "Unix timestamp of last successful push to Pushgateway",
		},
	)

	// Space weather metrics
	pm.spaceWeatherSolarFlux = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "spaceweather_solar_flux_sfu",
			Help: "Solar flux (10.7cm) in Solar Flux Units (SFU)",
		},
	)
	pm.spaceWeatherKIndex = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "spaceweather_k_index",
			Help: "Planetary K-index (0-9 scale)",
		},
	)
	pm.spaceWeatherAIndex = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "spaceweather_a_index",
			Help: "Planetary A-index",
		},
	)
	pm.spaceWeatherSolarWindBz = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "spaceweather_solar_wind_bz_nt",
			Help: "Solar wind Bz component in nanoTesla (nT), negative values can trigger geomagnetic storms",
		},
	)
	pm.spaceWeatherBandConditions = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "spaceweather_band_conditions",
			Help: "HF band propagation conditions (1=Poor, 2=Fair, 3=Good, 4=Excellent)",
		},
		[]string{"band", "time_of_day"}, // band: 160m, 80m, etc.; time_of_day: day, night
	)
	pm.spaceWeatherLastUpdate = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "spaceweather_last_update_timestamp",
			Help: "Unix timestamp of last space weather data update",
		},
	)

	log.Println("Prometheus system metrics initialized (sessions, radiod channels, websockets, throughput, errors, resources, space weather, pushgateway)")
}

// UpdateFromMeasurement updates all Prometheus metrics from a BandMeasurement
func (pm *PrometheusMetrics) UpdateFromMeasurement(m *BandMeasurement) {
	if pm == nil || m == nil {
		return
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Update all metrics with the band label
	bandLabel := prometheus.Labels{"band": m.Band}

	pm.noiseFloorP5.With(bandLabel).Set(float64(m.P5DB))
	pm.noiseFloorP10.With(bandLabel).Set(float64(m.P10DB))
	pm.noiseFloorMedian.With(bandLabel).Set(float64(m.MedianDB))
	pm.noiseFloorMean.With(bandLabel).Set(float64(m.MeanDB))
	pm.noiseFloorP95.With(bandLabel).Set(float64(m.P95DB))
	pm.noiseFloorMax.With(bandLabel).Set(float64(m.MaxDB))
	pm.noiseFloorMin.With(bandLabel).Set(float64(m.MinDB))
	pm.dynamicRange.With(bandLabel).Set(float64(m.DynamicRange))
	pm.occupancyPercent.With(bandLabel).Set(float64(m.OccupancyPct))
	pm.ft8SNR.With(bandLabel).Set(float64(m.FT8SNR))
	pm.lastUpdate.With(bandLabel).Set(float64(m.Timestamp.Unix()))
}

// UpdateMultipleMeasurements updates metrics for multiple bands at once
func (pm *PrometheusMetrics) UpdateMultipleMeasurements(measurements map[string]*BandMeasurement) {
	if pm == nil || len(measurements) == 0 {
		return
	}

	for _, m := range measurements {
		pm.UpdateFromMeasurement(m)
	}
}

// UpdateSessionMetrics updates session-related metrics from SessionManager
func (pm *PrometheusMetrics) UpdateSessionMetrics(sessions *SessionManager) {
	if pm == nil || sessions == nil {
		return
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Get session counts
	totalSessions := sessions.GetSessionCount()
	uniqueUsers := sessions.GetUniqueUserCount()

	// Count audio vs spectrum sessions and track unique users by auth method
	sessions.mu.RLock()
	audioCount := 0
	spectrumCount := 0
	regularUsers := make(map[string]bool)
	passwordUsers := make(map[string]bool)
	bypassedUsers := make(map[string]bool)

	for _, session := range sessions.sessions {
		// Count session types
		if session.IsSpectrum {
			spectrumCount++
		} else {
			audioCount++
		}

		// Track unique users by auth method (skip internal sessions)
		if session.UserSessionID != "" && session.ClientIP != "" {
			// Determine auth method
			if session.BypassPassword != "" {
				// Has password, check if it's valid
				if sessions.config.Server.IsIPTimeoutBypassed(session.ClientIP, session.BypassPassword) {
					passwordUsers[session.UserSessionID] = true
				} else {
					regularUsers[session.UserSessionID] = true
				}
			} else if sessions.config.Server.IsIPTimeoutBypassed(session.ClientIP) {
				// No password, but IP is bypassed
				bypassedUsers[session.UserSessionID] = true
			} else {
				// Regular user
				regularUsers[session.UserSessionID] = true
			}
		}
	}
	sessions.mu.RUnlock()

	// Update metrics
	pm.activeSessions.Set(float64(totalSessions))
	pm.activeUsers.Set(float64(uniqueUsers))
	pm.activeUsersRegular.Set(float64(len(regularUsers)))
	pm.activeUsersPassword.Set(float64(len(passwordUsers)))
	pm.activeUsersBypassed.Set(float64(len(bypassedUsers)))
	pm.activeAudioSessions.Set(float64(audioCount))
	pm.activeSpectrumSessions.Set(float64(spectrumCount))

	// Update radiod channel metrics
	radiodChannelsTotal := audioCount + spectrumCount
	pm.radiodChannelsTotal.Set(float64(radiodChannelsTotal))
	pm.radiodAudioChannels.Set(float64(audioCount))
	pm.radiodSpectrumChannels.Set(float64(spectrumCount))

	// Update resource metrics
	pm.updateResourceMetrics()
}

// updateResourceMetrics updates runtime resource metrics
func (pm *PrometheusMetrics) updateResourceMetrics() {
	if pm == nil {
		return
	}

	// Get runtime memory statistics
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	// Update goroutine count
	pm.goroutineCount.Set(float64(runtime.NumGoroutine()))

	// Update memory metrics
	pm.memoryAllocBytes.Set(float64(m.Alloc))      // Currently allocated bytes
	pm.memoryTotalBytes.Set(float64(m.TotalAlloc)) // Total allocated (cumulative)
	pm.memoryHeapBytes.Set(float64(m.HeapAlloc))   // Heap allocated bytes
	pm.memoryStackBytes.Set(float64(m.StackInuse)) // Stack in use

	// Update GC pause time (convert nanoseconds to seconds)
	if len(m.PauseNs) > 0 {
		// Get the most recent GC pause
		lastPause := m.PauseNs[(m.NumGC+255)%256]
		pm.gcPauseSeconds.Set(float64(lastPause) / 1e9)
	}
}

// WebSocket connection tracking methods
func (pm *PrometheusMetrics) RecordWSConnection(wsType string) {
	if pm == nil {
		return
	}
	pm.wsConnectionsTotal.WithLabelValues(wsType).Inc()
	pm.wsActiveConnections.WithLabelValues(wsType).Inc()
}

func (pm *PrometheusMetrics) RecordWSDisconnect(wsType string) {
	if pm == nil {
		return
	}
	pm.wsDisconnectsTotal.WithLabelValues(wsType).Inc()
	pm.wsActiveConnections.WithLabelValues(wsType).Dec()
}

func (pm *PrometheusMetrics) RecordWSMessageReceived(msgType string) {
	if pm == nil {
		return
	}
	pm.wsMessagesReceivedTotal.WithLabelValues(msgType).Inc()
}

func (pm *PrometheusMetrics) RecordWSMessageSent(msgType string) {
	if pm == nil {
		return
	}
	pm.wsMessagesSentTotal.WithLabelValues(msgType).Inc()
}

// Data throughput tracking methods
func (pm *PrometheusMetrics) RecordAudioBytes(bytes int) {
	if pm == nil {
		return
	}
	pm.audioBytesTotal.Add(float64(bytes))
}

func (pm *PrometheusMetrics) RecordSpectrumPacket() {
	if pm == nil {
		return
	}
	pm.spectrumPacketsTotal.Inc()
}

// DX Cluster tracking methods
func (pm *PrometheusMetrics) RecordDXSpot(band string) {
	if pm == nil {
		return
	}
	pm.dxSpotsTotal.WithLabelValues(band).Inc()
}

func (pm *PrometheusMetrics) RecordDXClusterConnection() {
	if pm == nil {
		return
	}
	pm.dxClusterConnections.Inc()
	pm.dxClusterConnected.Set(1)
}

func (pm *PrometheusMetrics) RecordDXClusterDisconnect() {
	if pm == nil {
		return
	}
	pm.dxClusterDisconnects.Inc()
	pm.dxClusterConnected.Set(0)
}

// Error tracking methods
func (pm *PrometheusMetrics) RecordSessionCreationError() {
	if pm == nil {
		return
	}
	pm.sessionCreationErrors.Inc()
}

func (pm *PrometheusMetrics) RecordRadiodError() {
	if pm == nil {
		return
	}
	pm.radiodErrors.Inc()
}

func (pm *PrometheusMetrics) RecordRateLimitError(errorType string) {
	if pm == nil {
		return
	}
	pm.rateLimitErrors.WithLabelValues(errorType).Inc()
}

func (pm *PrometheusMetrics) RecordIdleTimeoutKick(sessionType string) {
	if pm == nil {
		return
	}
	pm.idleTimeoutKicks.WithLabelValues(sessionType).Inc()
}

// Session duration tracking
func (pm *PrometheusMetrics) RecordSessionDuration(sessionType string, duration float64) {
	if pm == nil {
		return
	}
	pm.sessionDuration.WithLabelValues(sessionType).Observe(duration)
}

// Aggregate endpoint latency tracking
func (pm *PrometheusMetrics) RecordAggregateLatency(duration float64) {
	if pm == nil {
		return
	}
	pm.aggregateLatency.Observe(duration)
}

// UpdateSpaceWeather updates space weather metrics from SpaceWeatherData
func (pm *PrometheusMetrics) UpdateSpaceWeather(data *SpaceWeatherData) {
	if pm == nil || data == nil {
		return
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()

	pm.spaceWeatherSolarFlux.Set(data.SolarFlux)
	pm.spaceWeatherKIndex.Set(float64(data.KIndex))
	pm.spaceWeatherAIndex.Set(float64(data.AIndex))
	pm.spaceWeatherSolarWindBz.Set(data.SolarWindBz)
	pm.spaceWeatherLastUpdate.Set(float64(data.LastUpdate.Unix()))

	// Update band conditions (convert text to numeric: Poor=1, Fair=2, Good=3, Excellent=4)
	conditionToValue := map[string]float64{
		"Poor":      1.0,
		"Fair":      2.0,
		"Good":      3.0,
		"Excellent": 4.0,
	}

	// Update day conditions
	for band, condition := range data.BandConditionsDay {
		if value, ok := conditionToValue[condition]; ok {
			pm.spaceWeatherBandConditions.WithLabelValues(band, "day").Set(value)
		}
	}

	// Update night conditions
	for band, condition := range data.BandConditionsNight {
		if value, ok := conditionToValue[condition]; ok {
			pm.spaceWeatherBandConditions.WithLabelValues(band, "night").Set(value)
		}
	}

	if DebugMode {
		log.Printf("DEBUG: Updated Prometheus space weather metrics: SolarFlux=%.1f, K=%d, A=%d, Bz=%.2f, Bands=%d day + %d night",
			data.SolarFlux, data.KIndex, data.AIndex, data.SolarWindBz, len(data.BandConditionsDay), len(data.BandConditionsNight))
	}
}

// StartPushgatewayWorker starts a goroutine that periodically pushes metrics to Pushgateway
func (pm *PrometheusMetrics) StartPushgatewayWorker(ctx context.Context, config *Config) {
	if pm == nil || !config.Prometheus.Pushgateway.Enabled {
		return
	}

	pgConfig := config.Prometheus.Pushgateway

	// Validate configuration - silently skip if instance or token not configured
	// URL has a default value, so only check instance and token
	if pgConfig.Instance == "" || pgConfig.Token == "" {
		if DebugMode {
			log.Println("DEBUG: Pushgateway not fully configured (instance or token missing), skipping push worker")
		}
		return
	}

	// Hardcoded values
	const pushInterval = 60
	const jobName = "ka9q_ubersdr"

	log.Printf("Starting Pushgateway worker: URL=%s, Job=%s, Instance=%s, Interval=%ds",
		pgConfig.URL, jobName, pgConfig.Instance, pushInterval)

	// Start worker goroutine
	go func() {
		ticker := time.NewTicker(time.Duration(pushInterval) * time.Second)
		defer ticker.Stop()

		// Push immediately on start
		pm.pushgatewayPushesTotal.Inc()
		if err := pm.pushToGateway(config); err != nil {
			pm.pushgatewayFailuresTotal.Inc()
			log.Printf("ERROR: Failed to push metrics to Pushgateway: %v", err)
		} else {
			pm.pushgatewaySuccessTotal.Inc()
			pm.pushgatewayLastPushTime.Set(float64(time.Now().Unix()))
		}

		for {
			select {
			case <-ctx.Done():
				log.Println("Pushgateway worker stopped")
				return
			case <-ticker.C:
				// Record push attempt
				pm.pushgatewayPushesTotal.Inc()

				if err := pm.pushToGateway(config); err != nil {
					pm.pushgatewayFailuresTotal.Inc()
					log.Printf("ERROR: Failed to push metrics to Pushgateway: %v", err)
				} else {
					pm.pushgatewaySuccessTotal.Inc()
					pm.pushgatewayLastPushTime.Set(float64(time.Now().Unix()))
					if DebugMode {
						log.Printf("DEBUG: Successfully pushed metrics to Pushgateway")
					}
				}
			}
		}
	}()
}

// pushToGateway pushes all metrics to the Pushgateway with receiver info as labels
func (pm *PrometheusMetrics) pushToGateway(config *Config) error {
	if pm == nil {
		return fmt.Errorf("prometheus metrics not initialized")
	}

	pgConfig := config.Prometheus.Pushgateway

	// Hardcoded job name
	const jobName = "ka9q_ubersdr"

	// Create pusher with basic auth
	pusher := push.New(pgConfig.URL, jobName).
		Gatherer(prometheus.DefaultGatherer).
		BasicAuth(pgConfig.Instance, pgConfig.Token)

	// Use instance UUID as the Prometheus instance label
	pusher = pusher.Grouping("instance", pgConfig.Instance)

	// Add receiver information as grouping labels (always enabled)
	// Add callsign
	if config.Admin.Callsign != "" {
		pusher = pusher.Grouping("callsign", config.Admin.Callsign)
	}

	// Add GPS coordinates as strings
	if config.Admin.GPS.Lat != 0 || config.Admin.GPS.Lon != 0 {
		pusher = pusher.Grouping("latitude", fmt.Sprintf("%.6f", config.Admin.GPS.Lat))
		pusher = pusher.Grouping("longitude", fmt.Sprintf("%.6f", config.Admin.GPS.Lon))
	}

	// Add altitude
	if config.Admin.ASL != 0 {
		pusher = pusher.Grouping("altitude_m", fmt.Sprintf("%d", config.Admin.ASL))
	}

	// Add version
	pusher = pusher.Grouping("version", Version)

	// Push metrics
	if err := pusher.Push(); err != nil {
		return fmt.Errorf("failed to push to gateway: %w", err)
	}

	return nil
}

// StartMQTTPublisher starts the MQTT publisher worker if enabled
func (pm *PrometheusMetrics) StartMQTTPublisher(ctx context.Context, config *Config, noiseFloorMonitor *NoiseFloorMonitor, spaceWeatherMonitor *SpaceWeatherMonitor) error {
	if pm == nil || !config.MQTT.Enabled {
		return nil
	}

	// Validate configuration - silently skip if broker not configured
	if config.MQTT.Broker == "" {
		if DebugMode {
			log.Println("DEBUG: MQTT broker not configured, skipping MQTT publisher")
		}
		return nil
	}

	log.Printf("Starting MQTT publisher: Broker=%s, Topic=%s, Interval=%ds",
		config.MQTT.Broker, config.MQTT.TopicPrefix, config.MQTT.PublishInterval)

	// Create MQTT publisher
	publisher, err := NewMQTTPublisher(&config.MQTT, pm, noiseFloorMonitor, spaceWeatherMonitor)
	if err != nil {
		return fmt.Errorf("failed to create MQTT publisher: %w", err)
	}

	pm.mqttPublisher = publisher

	// Start publisher goroutine
	go publisher.StartPublisher(ctx, config)

	return nil
}

// RecordDigitalDecode records a digital decode event and updates metrics
func (pm *PrometheusMetrics) RecordDigitalDecode(mode, band, callsign string, cycleSeconds int) {
	if pm == nil || pm.digitalMetrics == nil {
		return
	}

	// Record in the metrics tracker
	pm.digitalMetrics.RecordDecode(mode, band, callsign)

	// Update Prometheus metrics
	pm.updateDigitalMetrics(mode, band, cycleSeconds)
}

// updateDigitalMetrics updates all digital decode Prometheus metrics for a mode/band
func (pm *PrometheusMetrics) updateDigitalMetrics(mode, band string, cycleSeconds int) {
	if pm == nil || pm.digitalMetrics == nil {
		return
	}

	labels := prometheus.Labels{"mode": mode, "band": band}

	// Average decodes per cycle for different time windows
	pm.digitalDecodesPerCycle1m.With(labels).Set(pm.digitalMetrics.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 1))
	pm.digitalDecodesPerCycle5m.With(labels).Set(pm.digitalMetrics.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 5))
	pm.digitalDecodesPerCycle15m.With(labels).Set(pm.digitalMetrics.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 15))
	pm.digitalDecodesPerCycle30m.With(labels).Set(pm.digitalMetrics.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 30))
	pm.digitalDecodesPerCycle60m.With(labels).Set(pm.digitalMetrics.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 60))

	// Total decodes in time windows
	pm.digitalDecodesTotal1h.With(labels).Set(float64(pm.digitalMetrics.GetTotalDecodes(mode, band, 1)))
	pm.digitalDecodesTotal3h.With(labels).Set(float64(pm.digitalMetrics.GetTotalDecodes(mode, band, 3)))
	pm.digitalDecodesTotal6h.With(labels).Set(float64(pm.digitalMetrics.GetTotalDecodes(mode, band, 6)))
	pm.digitalDecodesTotal12h.With(labels).Set(float64(pm.digitalMetrics.GetTotalDecodes(mode, band, 12)))
	pm.digitalDecodesTotal24h.With(labels).Set(float64(pm.digitalMetrics.GetTotalDecodes(mode, band, 24)))

	// Unique callsigns in time windows
	pm.digitalUniqueCallsigns1h.With(labels).Set(float64(pm.digitalMetrics.GetUniqueCallsigns(mode, band, 1)))
	pm.digitalUniqueCallsigns3h.With(labels).Set(float64(pm.digitalMetrics.GetUniqueCallsigns(mode, band, 3)))
	pm.digitalUniqueCallsigns6h.With(labels).Set(float64(pm.digitalMetrics.GetUniqueCallsigns(mode, band, 6)))
	pm.digitalUniqueCallsigns12h.With(labels).Set(float64(pm.digitalMetrics.GetUniqueCallsigns(mode, band, 12)))
	pm.digitalUniqueCallsigns24h.With(labels).Set(float64(pm.digitalMetrics.GetUniqueCallsigns(mode, band, 24)))

	// Decoder execution times (min/max/average)
	avg1m, min1m, max1m := pm.digitalMetrics.GetExecutionTimeStats(mode, band, 1)
	pm.digitalExecTime1mAvg.With(labels).Set(avg1m)
	pm.digitalExecTime1mMin.With(labels).Set(min1m)
	pm.digitalExecTime1mMax.With(labels).Set(max1m)

	avg5m, min5m, max5m := pm.digitalMetrics.GetExecutionTimeStats(mode, band, 5)
	pm.digitalExecTime5mAvg.With(labels).Set(avg5m)
	pm.digitalExecTime5mMin.With(labels).Set(min5m)
	pm.digitalExecTime5mMax.With(labels).Set(max5m)

	avg10m, min10m, max10m := pm.digitalMetrics.GetExecutionTimeStats(mode, band, 10)
	pm.digitalExecTime10mAvg.With(labels).Set(avg10m)
	pm.digitalExecTime10mMin.With(labels).Set(min10m)
	pm.digitalExecTime10mMax.With(labels).Set(max10m)
}

// UpdateAllDigitalMetrics updates metrics for all active mode/band combinations
func (pm *PrometheusMetrics) UpdateAllDigitalMetrics(modeBandCycles map[string]map[string]int) {
	if pm == nil || pm.digitalMetrics == nil {
		return
	}

	// Get all active combinations
	combinations := pm.digitalMetrics.GetAllModeBandCombinations()

	for _, combo := range combinations {
		cycleSeconds := 15 // Default for FT8
		if cycles, ok := modeBandCycles[combo.Mode]; ok {
			if cycle, ok := cycles[combo.Band]; ok {
				cycleSeconds = cycle
			}
		}
		pm.updateDigitalMetrics(combo.Mode, combo.Band, cycleSeconds)
	}
}

// StartDigitalMetricsCleanup starts a goroutine to periodically clean old data
func (pm *PrometheusMetrics) StartDigitalMetricsCleanup(ctx context.Context) {
	if pm == nil || pm.digitalMetrics == nil {
		return
	}

	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pm.digitalMetrics.CleanupOldData()
				if DebugMode {
					log.Println("DEBUG: Cleaned up old digital decode metrics data")
				}
			}
		}
	}()
}

// UpdateCWMetrics updates CW Skimmer Prometheus metrics for a band
func (pm *PrometheusMetrics) UpdateCWMetrics(band string, cwMetrics *CWSkimmerMetrics) {
	if pm == nil || cwMetrics == nil {
		return
	}

	labels := prometheus.Labels{"band": band}

	// Update spot counts for different time windows
	pm.cwSpotsTotal1h.With(labels).Set(float64(cwMetrics.GetTotalSpots(band, 1)))
	pm.cwSpotsTotal3h.With(labels).Set(float64(cwMetrics.GetTotalSpots(band, 3)))
	pm.cwSpotsTotal6h.With(labels).Set(float64(cwMetrics.GetTotalSpots(band, 6)))
	pm.cwSpotsTotal12h.With(labels).Set(float64(cwMetrics.GetTotalSpots(band, 12)))
	pm.cwSpotsTotal24h.With(labels).Set(float64(cwMetrics.GetTotalSpots(band, 24)))

	// Update unique callsigns for different time windows
	pm.cwUniqueCallsigns1h.With(labels).Set(float64(cwMetrics.GetUniqueCallsigns(band, 1)))
	pm.cwUniqueCallsigns3h.With(labels).Set(float64(cwMetrics.GetUniqueCallsigns(band, 3)))
	pm.cwUniqueCallsigns6h.With(labels).Set(float64(cwMetrics.GetUniqueCallsigns(band, 6)))
	pm.cwUniqueCallsigns12h.With(labels).Set(float64(cwMetrics.GetUniqueCallsigns(band, 12)))
	pm.cwUniqueCallsigns24h.With(labels).Set(float64(cwMetrics.GetUniqueCallsigns(band, 24)))

	// Update WPM statistics for 1 minute window
	avg1m, min1m, max1m := cwMetrics.GetWPMStats(band, 1)
	pm.cwWPMAvg1m.With(labels).Set(avg1m)
	pm.cwWPMMin1m.With(labels).Set(float64(min1m))
	pm.cwWPMMax1m.With(labels).Set(float64(max1m))

	// Update WPM statistics for 5 minute window
	avg5m, min5m, max5m := cwMetrics.GetWPMStats(band, 5)
	pm.cwWPMAvg5m.With(labels).Set(avg5m)
	pm.cwWPMMin5m.With(labels).Set(float64(min5m))
	pm.cwWPMMax5m.With(labels).Set(float64(max5m))

	// Update WPM statistics for 10 minute window
	avg10m, min10m, max10m := cwMetrics.GetWPMStats(band, 10)
	pm.cwWPMAvg10m.With(labels).Set(avg10m)
	pm.cwWPMMin10m.With(labels).Set(float64(min10m))
	pm.cwWPMMax10m.With(labels).Set(float64(max10m))

	// Update activity metrics (spots and callsigns per hour)
	pm.cwSpotsPerHour.With(labels).Set(float64(cwMetrics.GetTotalSpots(band, 1)))
	pm.cwCallsignsPerHour.With(labels).Set(float64(cwMetrics.GetUniqueCallsigns(band, 1)))
}

// UpdateAllCWMetrics updates CW Skimmer metrics for all active bands
func (pm *PrometheusMetrics) UpdateAllCWMetrics(cwMetrics *CWSkimmerMetrics) {
	if pm == nil || cwMetrics == nil {
		return
	}

	// Get all active bands from CW metrics
	bands := cwMetrics.GetAllBands()

	// Update metrics for each band
	for _, band := range bands {
		pm.UpdateCWMetrics(band, cwMetrics)
	}
}

// StartCWMetricsUpdater starts a goroutine to periodically update CW Skimmer metrics
func (pm *PrometheusMetrics) StartCWMetricsUpdater(ctx context.Context, cwMetrics *CWSkimmerMetrics) {
	if pm == nil || cwMetrics == nil {
		return
	}

	// Store reference to CW metrics
	pm.cwMetrics = cwMetrics

	go func() {
		// Update every minute (similar to digital metrics cleanup interval)
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()

		// Initial update
		pm.UpdateAllCWMetrics(cwMetrics)

		for {
			select {
			case <-ctx.Done():
				if DebugMode {
					log.Println("DEBUG: CW metrics updater stopped")
				}
				return
			case <-ticker.C:
				pm.UpdateAllCWMetrics(cwMetrics)
				if DebugMode {
					log.Println("DEBUG: Updated CW Skimmer Prometheus metrics")
				}
			}
		}
	}()

	log.Println("Started CW Skimmer Prometheus metrics updater (1 minute interval)")
}
