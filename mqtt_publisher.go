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
	"runtime"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// MQTTPublisher manages MQTT publishing of metrics
type MQTTPublisher struct {
	client  mqtt.Client
	config  *MQTTConfig
	metrics *PrometheusMetrics
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
func NewMQTTPublisher(config *MQTTConfig, metrics *PrometheusMetrics) (*MQTTPublisher, error) {
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
		client:  client,
		config:  config,
		metrics: metrics,
	}, nil
}

// StartPublisher starts the background publishing goroutine
func (mp *MQTTPublisher) StartPublisher(ctx context.Context, appConfig *Config) {
	ticker := time.NewTicker(time.Duration(mp.config.PublishInterval) * time.Second)
	defer ticker.Stop()

	log.Printf("MQTT: Publisher started with %d second interval", mp.config.PublishInterval)

	// Publish immediately on start
	mp.publishAllMetrics(appConfig)

	for {
		select {
		case <-ctx.Done():
			log.Println("MQTT: Publisher stopped")
			mp.client.Disconnect(250)
			return
		case <-ticker.C:
			mp.publishAllMetrics(appConfig)
		}
	}
}

// publishAllMetrics publishes all metric categories
func (mp *MQTTPublisher) publishAllMetrics(config *Config) {
	timestamp := time.Now().Unix()

	// Publish noise floor metrics (per band)
	mp.publishNoiseFloorMetrics(timestamp)

	// Publish system metrics
	mp.publishSystemMetrics(timestamp)

	// Publish space weather metrics
	mp.publishSpaceWeatherMetrics(timestamp)

	// Publish resource metrics
	mp.publishResourceMetrics(timestamp)
}

// publishNoiseFloorMetrics publishes noise floor data for each band
func (mp *MQTTPublisher) publishNoiseFloorMetrics(timestamp int64) {
	if mp.metrics == nil {
		return
	}

	// Get all configured bands
	bands := []string{"160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"}

	for _, band := range bands {
		metrics := make(map[string]float64)

		// Collect all noise floor metrics for this band
		// Note: We can't directly read Prometheus metrics, so we'll need to track them
		// For now, we'll publish what we can access
		// In a production implementation, you'd want to cache these values

		payload := MetricPayload{
			Timestamp: timestamp,
			Labels:    map[string]string{"band": band},
			Metrics:   metrics,
		}

		topic := fmt.Sprintf("%s/noisefloor/%s", mp.config.TopicPrefix, band)
		mp.publish(topic, payload)
	}
}

// publishSystemMetrics publishes system-level metrics
func (mp *MQTTPublisher) publishSystemMetrics(timestamp int64) {
	if mp.metrics == nil {
		return
	}

	metrics := make(map[string]float64)

	// System metrics would be collected here
	// For a complete implementation, you'd need to expose these values
	// from the PrometheusMetrics struct

	payload := MetricPayload{
		Timestamp: timestamp,
		Metrics:   metrics,
	}

	topic := fmt.Sprintf("%s/system", mp.config.TopicPrefix)
	mp.publish(topic, payload)
}

// publishSpaceWeatherMetrics publishes space weather data
func (mp *MQTTPublisher) publishSpaceWeatherMetrics(timestamp int64) {
	if mp.metrics == nil {
		return
	}

	metrics := make(map[string]float64)

	// Space weather metrics would be collected here

	payload := MetricPayload{
		Timestamp: timestamp,
		Metrics:   metrics,
	}

	topic := fmt.Sprintf("%s/spaceweather", mp.config.TopicPrefix)
	mp.publish(topic, payload)
}

// publishResourceMetrics publishes resource usage metrics
func (mp *MQTTPublisher) publishResourceMetrics(timestamp int64) {
	metrics := make(map[string]float64)

	// Get runtime memory statistics
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	metrics["goroutines_total"] = float64(runtime.NumGoroutine())
	metrics["memory_alloc_bytes"] = float64(m.Alloc)
	metrics["memory_total_bytes"] = float64(m.TotalAlloc)
	metrics["memory_heap_bytes"] = float64(m.HeapAlloc)
	metrics["memory_stack_bytes"] = float64(m.StackInuse)

	// GC pause time
	if len(m.PauseNs) > 0 {
		lastPause := m.PauseNs[(m.NumGC+255)%256]
		metrics["gc_pause_seconds"] = float64(lastPause) / 1e9
	}

	payload := MetricPayload{
		Timestamp: timestamp,
		Metrics:   metrics,
	}

	topic := fmt.Sprintf("%s/resources", mp.config.TopicPrefix)
	mp.publish(topic, payload)
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

	if DebugMode {
		log.Printf("MQTT DEBUG: Published to %s: %d metrics", topic, len(payload.Metrics))
	}
}

// Disconnect gracefully disconnects from the MQTT broker
func (mp *MQTTPublisher) Disconnect() {
	if mp.client != nil && mp.client.IsConnected() {
		mp.client.Disconnect(250)
		log.Println("MQTT: Disconnected from broker")
	}
}
