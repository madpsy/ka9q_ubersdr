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
	mp.publishMetricCategory("spaceweather", map[string]map[string]interface{}{"metrics": spaceweatherMetrics}, timestamp)
	mp.publishMetricCategory("resources", map[string]map[string]interface{}{"metrics": resourceMetrics}, timestamp)
	mp.publishMetricCategory("websocket", map[string]map[string]interface{}{"metrics": websocketMetrics}, timestamp)
	mp.publishMetricCategory("dxcluster", map[string]map[string]interface{}{"metrics": dxclusterMetrics}, timestamp)
	mp.publishMetricCategory("pushgateway", map[string]map[string]interface{}{"metrics": pushgatewayMetrics}, timestamp)
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
