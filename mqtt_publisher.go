package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// MQTTPublisher manages MQTT publishing of metrics
type MQTTPublisher struct {
	client              mqtt.Client
	config              *MQTTConfig
	metrics             *PrometheusMetrics
	noiseFloorMonitor   *NoiseFloorMonitor
	spaceWeatherMonitor *SpaceWeatherMonitor
}

// MetricPayload represents a metric message for MQTT
type MetricPayload struct {
	Timestamp int64              `json:"timestamp"`
	Metrics   map[string]float64 `json:"metrics"`
	Labels    map[string]string  `json:"labels,omitempty"`
}

// generateClientID creates a random client ID for MQTT connection
func generateClientID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "ubersdr_" + hex.EncodeToString(bytes)
}

// loadTLSConfig loads TLS configuration from files
func loadTLSConfig(tlsConfig MQTTTLSConfig) (*tls.Config, error) {
	if !tlsConfig.Enabled {
		return nil, nil
	}

	config := &tls.Config{}

	// Load CA certificate if provided
	if tlsConfig.CACert != "" {
		caCert, err := os.ReadFile(tlsConfig.CACert)
		if err != nil {
			return nil, fmt.Errorf("failed to read CA certificate: %w", err)
		}
		caCertPool := x509.NewCertPool()
		if !caCertPool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("failed to parse CA certificate")
		}
		config.RootCAs = caCertPool
	}

	// Load client certificate and key if provided
	if tlsConfig.ClientCert != "" && tlsConfig.ClientKey != "" {
		cert, err := tls.LoadX509KeyPair(tlsConfig.ClientCert, tlsConfig.ClientKey)
		if err != nil {
			return nil, fmt.Errorf("failed to load client certificate: %w", err)
		}
		config.Certificates = []tls.Certificate{cert}
	}

	return config, nil
}

// NewMQTTPublisher creates a new MQTT publisher
func NewMQTTPublisher(config *MQTTConfig, metrics *PrometheusMetrics, noiseFloorMonitor *NoiseFloorMonitor, spaceWeatherMonitor *SpaceWeatherMonitor) (*MQTTPublisher, error) {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(config.Broker)
	opts.SetClientID(generateClientID())

	if config.Username != "" {
		opts.SetUsername(config.Username)
	}
	if config.Password != "" {
		opts.SetPassword(config.Password)
	}

	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(10 * time.Second)
	opts.SetKeepAlive(60 * time.Second)
	opts.SetPingTimeout(10 * time.Second)

	// TLS configuration if enabled
	if config.TLS.Enabled {
		tlsConfig, err := loadTLSConfig(config.TLS)
		if err != nil {
			return nil, fmt.Errorf("failed to load TLS config: %w", err)
		}
		opts.SetTLSConfig(tlsConfig)
	}

	// Set connection handlers
	opts.SetOnConnectHandler(func(client mqtt.Client) {
		log.Println("MQTT: Connected to broker")
	})
	opts.SetConnectionLostHandler(func(client mqtt.Client, err error) {
		log.Printf("MQTT: Connection lost: %v", err)
	})
	opts.SetReconnectingHandler(func(client mqtt.Client, opts *mqtt.ClientOptions) {
		log.Println("MQTT: Attempting to reconnect...")
	})

	client := mqtt.NewClient(opts)
	if token := client.Connect(); token.Wait() && token.Error() != nil {
		return nil, fmt.Errorf("failed to connect to MQTT broker: %w", token.Error())
	}

	log.Printf("MQTT: Successfully connected to broker: %s", config.Broker)

	return &MQTTPublisher{
		client:              client,
		config:              config,
		metrics:             metrics,
		noiseFloorMonitor:   noiseFloorMonitor,
		spaceWeatherMonitor: spaceWeatherMonitor,
	}, nil
}

// StartPublisher starts the background publishing goroutines
func (mp *MQTTPublisher) StartPublisher(ctx context.Context, appConfig *Config) {
	// Start metrics publisher
	go mp.startMetricsPublisher(ctx, appConfig)

	// Start spectrum publisher if enabled
	if mp.config.SpectrumPublishEnabled && mp.noiseFloorMonitor != nil {
		go mp.startSpectrumPublisher(ctx, appConfig)
	}
}

// startMetricsPublisher publishes aggregate metrics at the configured interval
func (mp *MQTTPublisher) startMetricsPublisher(ctx context.Context, appConfig *Config) {
	ticker := time.NewTicker(time.Duration(mp.config.PublishInterval) * time.Second)
	defer ticker.Stop()

	log.Printf("MQTT: Metrics publisher started with %d second interval", mp.config.PublishInterval)

	// Publish immediately on start
	mp.publishAllMetrics(appConfig)

	for {
		select {
		case <-ctx.Done():
			log.Println("MQTT: Metrics publisher stopped")
			return
		case <-ticker.C:
			mp.publishAllMetrics(appConfig)
		}
	}
}

// startSpectrumPublisher publishes spectrum FFT data at the configured interval
func (mp *MQTTPublisher) startSpectrumPublisher(ctx context.Context, appConfig *Config) {
	ticker := time.NewTicker(time.Duration(mp.config.SpectrumPublishInterval) * time.Second)
	defer ticker.Stop()

	log.Printf("MQTT: Spectrum publisher started with %d second interval", mp.config.SpectrumPublishInterval)

	// Publish immediately on start
	mp.publishSpectrumData(appConfig)

	for {
		select {
		case <-ctx.Done():
			log.Println("MQTT: Spectrum publisher stopped")
			mp.client.Disconnect(250)
			return
		case <-ticker.C:
			mp.publishSpectrumData(appConfig)
		}
	}
}

// publishAllMetrics publishes all metric categories by gathering from Prometheus
func (mp *MQTTPublisher) publishAllMetrics(config *Config) {
	timestamp := time.Now().Unix()

	// Gather all metrics from Prometheus registry
	metricFamilies, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		log.Printf("MQTT ERROR: Failed to gather Prometheus metrics: %v", err)
		return
	}

	// Group metrics by category based on metric name prefix
	noisefloorMetrics := make(map[string]map[string]interface{})
	systemMetrics := make(map[string]interface{})
	spaceweatherMetrics := make(map[string]interface{})
	resourceMetrics := make(map[string]interface{})
	websocketMetrics := make(map[string]interface{})
	dxclusterMetrics := make(map[string]interface{})
	pushgatewayMetrics := make(map[string]interface{})
	digitalDecodeMetrics := make(map[string]map[string]interface{}) // mode_band -> metrics
	cwSkimmerMetrics := make(map[string]map[string]interface{})     // band -> metrics

	// Process each metric family
	for _, mf := range metricFamilies {
		metricName := mf.GetName()

		// Process each metric in the family
		for _, m := range mf.GetMetric() {
			value := extractMetricValue(m)
			if value == nil {
				continue
			}

			// Extract labels
			labels := make(map[string]string)
			for _, label := range m.GetLabel() {
				labels[label.GetName()] = label.GetValue()
			}

			// Route to appropriate category based on metric name
			switch {
			case len(metricName) >= 3 && metricName[:3] == "cw_":
				// CW Skimmer metrics - group by band
				if band, ok := labels["band"]; ok {
					if cwSkimmerMetrics[band] == nil {
						cwSkimmerMetrics[band] = make(map[string]interface{})
					}
					cwSkimmerMetrics[band][metricName] = value
				}

			case len(metricName) >= 7 && metricName[:7] == "digital":
				// Digital decode metrics - group by mode and band
				if mode, modeOk := labels["mode"]; modeOk {
					if band, bandOk := labels["band"]; bandOk {
						key := mode + "_" + band
						if digitalDecodeMetrics[key] == nil {
							digitalDecodeMetrics[key] = make(map[string]interface{})
							digitalDecodeMetrics[key]["mode"] = mode
							digitalDecodeMetrics[key]["band"] = band
						}
						digitalDecodeMetrics[key][metricName] = value
					}
				}

			case len(metricName) >= 10 && metricName[:10] == "noisefloor":
				// Noise floor metrics - group by band
				if band, ok := labels["band"]; ok {
					if noisefloorMetrics[band] == nil {
						noisefloorMetrics[band] = make(map[string]interface{})
					}
					noisefloorMetrics[band][metricName] = value
				}

			case len(metricName) >= 12 && metricName[:12] == "spaceweather":
				// Space weather metrics
				if len(labels) > 0 {
					// For metrics with labels (like band_conditions), create a composite key
					key := metricName
					for k, v := range labels {
						key += "_" + k + "_" + v
					}
					spaceweatherMetrics[key] = value
				} else {
					spaceweatherMetrics[metricName] = value
				}

			case len(metricName) >= 7 && metricName[:7] == "ubersdr":
				// UberSDR system metrics
				subCategory := ""
				if len(metricName) >= 16 && metricName[8:16] == "websocket" {
					subCategory = "websocket"
				} else if len(metricName) >= 18 && metricName[8:18] == "dx_cluster" {
					subCategory = "dxcluster"
				} else if len(metricName) >= 19 && metricName[8:19] == "pushgateway" {
					subCategory = "pushgateway"
				}

				if len(labels) > 0 {
					// For metrics with labels, create a composite key
					key := metricName
					for k, v := range labels {
						key += "_" + k + "_" + v
					}
					switch subCategory {
					case "websocket":
						websocketMetrics[key] = value
					case "dxcluster":
						dxclusterMetrics[key] = value
					case "pushgateway":
						pushgatewayMetrics[key] = value
					default:
						systemMetrics[key] = value
					}
				} else {
					switch subCategory {
					case "websocket":
						websocketMetrics[metricName] = value
					case "dxcluster":
						dxclusterMetrics[metricName] = value
					case "pushgateway":
						pushgatewayMetrics[metricName] = value
					default:
						systemMetrics[metricName] = value
					}
				}

			default:
				// Other metrics (resource metrics, etc.)
				if len(labels) > 0 {
					key := metricName
					for k, v := range labels {
						key += "_" + k + "_" + v
					}
					resourceMetrics[key] = value
				} else {
					resourceMetrics[metricName] = value
				}
			}
		}
	}

	// Publish each category
	mp.publishMetricCategory("noisefloor", noisefloorMetrics, timestamp)
	mp.publishMetricCategory("system", map[string]map[string]interface{}{"metrics": systemMetrics}, timestamp)
	mp.publishMetricCategory("resources", map[string]map[string]interface{}{"metrics": resourceMetrics}, timestamp)
	mp.publishMetricCategory("websocket", map[string]map[string]interface{}{"metrics": websocketMetrics}, timestamp)
	mp.publishMetricCategory("dxcluster", map[string]map[string]interface{}{"metrics": dxclusterMetrics}, timestamp)
	mp.publishMetricCategory("pushgateway", map[string]map[string]interface{}{"metrics": pushgatewayMetrics}, timestamp)
	mp.publishDigitalDecodeMetrics(digitalDecodeMetrics, timestamp)
	mp.publishCWSkimmerMetrics(cwSkimmerMetrics, timestamp)

	// Publish space weather with text fields separately
	mp.publishSpaceWeather(spaceweatherMetrics, timestamp)
}

// extractMetricValue extracts the numeric value from a Prometheus metric
func extractMetricValue(m *dto.Metric) interface{} {
	if m.GetGauge() != nil {
		return m.GetGauge().GetValue()
	}
	if m.GetCounter() != nil {
		return m.GetCounter().GetValue()
	}
	if m.GetHistogram() != nil {
		return m.GetHistogram().GetSampleSum()
	}
	if m.GetSummary() != nil {
		return m.GetSummary().GetSampleSum()
	}
	return nil
}

// publishMetricCategory publishes a category of metrics
func (mp *MQTTPublisher) publishMetricCategory(category string, data map[string]map[string]interface{}, timestamp int64) {
	for subKey, metrics := range data {
		if len(metrics) == 0 {
			continue
		}

		// Convert interface{} map to float64 map for JSON serialization
		floatMetrics := make(map[string]float64)
		for k, v := range metrics {
			switch val := v.(type) {
			case float64:
				floatMetrics[k] = val
			case float32:
				floatMetrics[k] = float64(val)
			case int:
				floatMetrics[k] = float64(val)
			case int64:
				floatMetrics[k] = float64(val)
			}
		}

		if len(floatMetrics) == 0 {
			continue
		}

		payload := MetricPayload{
			Timestamp: timestamp,
			Metrics:   floatMetrics,
		}

		// Build topic based on category and subkey
		var topic string
		if subKey == "metrics" {
			topic = fmt.Sprintf("%s/%s", mp.config.TopicPrefix, category)
		} else {
			topic = fmt.Sprintf("%s/%s/%s", mp.config.TopicPrefix, category, subKey)
		}

		mp.publish(topic, payload)
	}
}

// publish sends a payload to an MQTT topic
func (mp *MQTTPublisher) publish(topic string, payload MetricPayload) {
	// Skip if no metrics to publish
	if len(payload.Metrics) == 0 {
		return
	}

	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("MQTT ERROR: Failed to marshal payload for topic %s: %v", topic, err)
		return
	}

	token := mp.client.Publish(topic, mp.config.QoS, mp.config.Retain, data)
	if token.Wait() && token.Error() != nil {
		log.Printf("MQTT ERROR: Failed to publish to topic %s: %v", topic, token.Error())
		return
	}
}

// publishSpectrumData publishes FFT spectrum data for all bands
func (mp *MQTTPublisher) publishSpectrumData(config *Config) {
	if mp.noiseFloorMonitor == nil {
		return
	}

	timestamp := time.Now().Unix()

	// Get FFT data for each configured band
	for _, band := range config.NoiseFloor.Bands {
		fft := mp.noiseFloorMonitor.GetLatestFFT(band.Name)
		if fft == nil || len(fft.Data) == 0 {
			continue
		}

		// Create spectrum payload
		spectrumPayload := map[string]interface{}{
			"timestamp":  timestamp,
			"band":       fft.Band,
			"start_freq": fft.StartFreq,
			"end_freq":   fft.EndFreq,
			"bin_width":  fft.BinWidth,
			"bin_count":  len(fft.Data),
			"data":       fft.Data,
		}

		// Add markers if present
		if len(fft.Markers) > 0 {
			markers := make([]map[string]interface{}, len(fft.Markers))
			for i, marker := range fft.Markers {
				markers[i] = map[string]interface{}{
					"display_name": marker.DisplayName,
					"frequency":    marker.Frequency,
					"bandwidth":    marker.Bandwidth,
					"sideband":     marker.Sideband,
				}
			}
			spectrumPayload["markers"] = markers
		}

		// Publish to band-specific spectrum topic
		topic := fmt.Sprintf("%s/spectrum/%s", mp.config.TopicPrefix, band.Name)

		data, err := json.Marshal(spectrumPayload)
		if err != nil {
			log.Printf("MQTT ERROR: Failed to marshal spectrum payload for band %s: %v", band.Name, err)
			continue
		}

		token := mp.client.Publish(topic, mp.config.QoS, mp.config.Retain, data)
		if token.Wait() && token.Error() != nil {
			log.Printf("MQTT ERROR: Failed to publish spectrum for band %s: %v", band.Name, token.Error())
			continue
		}
	}
}

// publishSpaceWeather publishes space weather metrics with text fields
func (mp *MQTTPublisher) publishSpaceWeather(numericMetrics map[string]interface{}, timestamp int64) {
	// Start with numeric metrics from Prometheus
	payload := make(map[string]interface{})

	// Add numeric metrics
	for k, v := range numericMetrics {
		payload[k] = v
	}

	// Add text fields from SpaceWeatherMonitor if available
	if mp.spaceWeatherMonitor != nil {
		data := mp.spaceWeatherMonitor.GetData()
		if data != nil {
			// Add text status fields
			payload["k_index_status"] = data.KIndexStatus
			payload["propagation_quality"] = data.PropagationQuality

			// Add forecast text fields if available
			if data.Forecast != nil {
				payload["forecast_geomagnetic_storm"] = data.Forecast.GeomagneticStorm
				payload["forecast_radio_blackout"] = data.Forecast.RadioBlackout
				payload["forecast_solar_radiation"] = data.Forecast.SolarRadiation
				payload["forecast_summary"] = data.Forecast.Summary
			}
		}
	}

	// Publish to spaceweather topic
	topic := fmt.Sprintf("%s/spaceweather", mp.config.TopicPrefix)

	fullPayload := map[string]interface{}{
		"timestamp": timestamp,
		"data":      payload,
	}

	data, err := json.Marshal(fullPayload)
	if err != nil {
		log.Printf("MQTT ERROR: Failed to marshal spaceweather payload: %v", err)
		return
	}

	token := mp.client.Publish(topic, mp.config.QoS, mp.config.Retain, data)
	if token.Wait() && token.Error() != nil {
		log.Printf("MQTT ERROR: Failed to publish spaceweather: %v", token.Error())
		return
	}

	if DebugMode {
		log.Printf("MQTT DEBUG: Published spaceweather with %d fields", len(payload))
	}
}

// PublishDigitalDecode publishes a digital mode decode to MQTT
// Topic structure: {prefix}/digital_modes/{mode}/{band}
// Uses the same JSON format as websocket messages for consistency
func (mp *MQTTPublisher) PublishDigitalDecode(decode DecodeInfo, bandName string) {
	if mp == nil || !mp.client.IsConnected() {
		return
	}

	// Create decode payload matching websocket format (see dxcluster_websocket.go BroadcastDigitalSpot)
	decodePayload := map[string]interface{}{
		"mode":         decode.Mode,
		"band":         bandName,
		"callsign":     decode.Callsign,
		"locator":      decode.Locator,
		"country":      decode.Country,
		"CQZone":       decode.CQZone,
		"ITUZone":      decode.ITUZone,
		"Continent":    decode.Continent,
		"TimeOffset":   decode.TimeOffset,
		"snr":          decode.SNR,
		"frequency":    decode.Frequency,
		"timestamp":    decode.Timestamp,
		"message":      decode.Message,
		"dt":           decode.DT,
		"drift":        decode.Drift,
		"dbm":          decode.DBm,
		"tx_frequency": decode.TxFrequency,
	}

	// Build topic: {prefix}/digital_modes/{mode}/{band}
	// e.g., ubersdr/metrics/digital_modes/FT8/40m
	topic := fmt.Sprintf("%s/digital_modes/%s/%s",
		mp.config.TopicPrefix,
		decode.Mode,
		bandName)

	data, err := json.Marshal(decodePayload)
	if err != nil {
		log.Printf("MQTT ERROR: Failed to marshal digital decode payload: %v", err)
		return
	}

	// Publish asynchronously - don't wait for completion (prevents blocking)
	token := mp.client.Publish(topic, mp.config.QoS, mp.config.Retain, data)

	// Check for errors in background goroutine
	go func() {
		if token.Wait() && token.Error() != nil {
			log.Printf("MQTT ERROR: Failed to publish digital decode to %s: %v", topic, token.Error())
		}
	}()
}

// PublishCWSpot publishes a CW Skimmer spot to MQTT
// Topic structure: {prefix}/cw_spots/{band}
// Uses the same JSON format as websocket messages for consistency
func (mp *MQTTPublisher) PublishCWSpot(spot CWSkimmerSpot) {
	if mp == nil || !mp.client.IsConnected() {
		return
	}

	// Create spot payload matching websocket format (see dxcluster_websocket.go BroadcastCWSpot)
	spotPayload := map[string]interface{}{
		"frequency": spot.Frequency,
		"dx_call":   spot.DXCall,
		"spotter":   spot.Spotter,
		"snr":       spot.SNR,
		"wpm":       spot.WPM,
		"comment":   spot.Comment,
		"time":      spot.Time,
		"band":      spot.Band,
		"country":   spot.Country,
		"cq_zone":   spot.CQZone,
		"itu_zone":  spot.ITUZone,
		"continent": spot.Continent,
		"latitude":  spot.Latitude,
		"longitude": spot.Longitude,
	}

	// Add optional distance and bearing if present
	if spot.DistanceKm != nil {
		spotPayload["distance_km"] = *spot.DistanceKm
	}
	if spot.BearingDeg != nil {
		spotPayload["bearing_deg"] = *spot.BearingDeg
	}

	// Build topic: {prefix}/cw_spots/{band}
	// e.g., ubersdr/metrics/cw_spots/40m
	topic := fmt.Sprintf("%s/cw_spots/%s",
		mp.config.TopicPrefix,
		spot.Band)

	data, err := json.Marshal(spotPayload)
	if err != nil {
		log.Printf("MQTT ERROR: Failed to marshal CW spot payload: %v", err)
		return
	}

	// Publish asynchronously - don't wait for completion (prevents blocking)
	token := mp.client.Publish(topic, mp.config.QoS, mp.config.Retain, data)

	// Check for errors in background goroutine
	go func() {
		if token.Wait() && token.Error() != nil {
			log.Printf("MQTT ERROR: Failed to publish CW spot to %s: %v", topic, token.Error())
		}
	}()
}

// publishDigitalDecodeMetrics publishes digital decode metrics grouped by mode and band
func (mp *MQTTPublisher) publishDigitalDecodeMetrics(metrics map[string]map[string]interface{}, timestamp int64) {
	for _, data := range metrics {
		if len(data) == 0 {
			continue
		}

		// Extract mode and band from the data
		mode, modeOk := data["mode"].(string)
		band, bandOk := data["band"].(string)
		if !modeOk || !bandOk {
			continue
		}

		// Convert interface{} map to float64 map for JSON serialization
		floatMetrics := make(map[string]float64)
		for k, v := range data {
			// Skip the mode and band keys as they're used in the topic
			if k == "mode" || k == "band" {
				continue
			}
			switch val := v.(type) {
			case float64:
				floatMetrics[k] = val
			case float32:
				floatMetrics[k] = float64(val)
			case int:
				floatMetrics[k] = float64(val)
			case int64:
				floatMetrics[k] = float64(val)
			}
		}

		if len(floatMetrics) == 0 {
			continue
		}

		payload := MetricPayload{
			Timestamp: timestamp,
			Metrics:   floatMetrics,
			Labels: map[string]string{
				"mode": mode,
				"band": band,
			},
		}

		// Build topic: {prefix}/digital_decodes/{mode}/{band}
		topic := fmt.Sprintf("%s/digital_decodes/%s/%s", mp.config.TopicPrefix, mode, band)

		mp.publish(topic, payload)
	}
}

// publishCWSkimmerMetrics publishes CW Skimmer metrics grouped by band
func (mp *MQTTPublisher) publishCWSkimmerMetrics(metrics map[string]map[string]interface{}, timestamp int64) {
	for band, data := range metrics {
		if len(data) == 0 {
			continue
		}

		// Convert interface{} map to float64 map for JSON serialization
		floatMetrics := make(map[string]float64)
		for k, v := range data {
			switch val := v.(type) {
			case float64:
				floatMetrics[k] = val
			case float32:
				floatMetrics[k] = float64(val)
			case int:
				floatMetrics[k] = float64(val)
			case int64:
				floatMetrics[k] = float64(val)
			}
		}

		if len(floatMetrics) == 0 {
			continue
		}

		payload := MetricPayload{
			Timestamp: timestamp,
			Metrics:   floatMetrics,
			Labels: map[string]string{
				"band": band,
			},
		}

		// Build topic: {prefix}/cw_skimmer/{band}
		topic := fmt.Sprintf("%s/cw_skimmer/%s", mp.config.TopicPrefix, band)

		mp.publish(topic, payload)
	}
}

// Disconnect gracefully disconnects from the MQTT broker
func (mp *MQTTPublisher) Disconnect() {
	if mp.client != nil && mp.client.IsConnected() {
		mp.client.Disconnect(250)
		log.Println("MQTT: Disconnected from broker")
	}
}
