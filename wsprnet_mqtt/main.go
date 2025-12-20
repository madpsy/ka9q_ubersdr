package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

var (
	Version = "1.0.0"
)

func main() {
	// Parse command line flags
	configFile := flag.String("config", "config.yaml", "Path to configuration file")
	flag.Parse()

	log.Printf("WSPR MQTT Aggregator v%s starting...", Version)

	// Load configuration
	config, err := LoadConfig(*configFile)
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	if err := config.Validate(); err != nil {
		log.Fatalf("Invalid configuration: %v", err)
	}

	log.Printf("Receiver: %s (%s)", config.Receiver.Callsign, config.Receiver.Locator)
	log.Printf("MQTT Broker: %s", config.MQTT.Broker)
	log.Printf("Subscribing to %d instance(s):", len(config.MQTT.Instances))
	for _, inst := range config.MQTT.Instances {
		log.Printf("  - %s: %s/digital_modes/WSPR/+", inst.Name, inst.TopicPrefix)
	}

	if config.DryRun {
		log.Println("*** DRY RUN MODE ENABLED - No reports will be sent to WSPRNet ***")
	}

	// Initialize WSPRNet client
	wsprNet, err := NewWSPRNet(
		config.Receiver.Callsign,
		config.Receiver.Locator,
		"UberSDR",
		"", // Empty version string - WSPRNet will receive just "UberSDR"
		config.DryRun,
	)
	if err != nil {
		log.Fatalf("Failed to initialize WSPRNet: %v", err)
	}

	// Connect to WSPRNet
	if err := wsprNet.Connect(); err != nil {
		log.Fatalf("Failed to connect to WSPRNet: %v", err)
	}
	defer wsprNet.Stop()

	log.Println("WSPRNet client initialized")

	// Initialize statistics tracker
	stats := NewStatisticsTracker()

	// Set receiver location for distance calculations
	stats.SetReceiverLocation(config.Receiver.Locator)

	// Load persisted statistics if available
	var wsprnetStats *WSPRNetStats
	if config.PersistenceFile != "" {
		log.Printf("Loading persisted statistics from %s...", config.PersistenceFile)
		var err error
		wsprnetStats, err = stats.LoadFromFile(config.PersistenceFile)
		if err != nil {
			log.Printf("Warning: Failed to load persisted statistics: %v", err)
		} else {
			log.Printf("Successfully loaded persisted statistics")
			if wsprnetStats != nil {
				log.Printf("Restoring WSPRNet stats: %d successful, %d failed, %d retries",
					wsprnetStats.Successful, wsprnetStats.Failed, wsprnetStats.Retries)
				wsprNet.SetStats(wsprnetStats.Successful, wsprnetStats.Failed, wsprnetStats.Retries)
			}
		}
	}

	// Initialize spot aggregator for deduplication
	aggregator := NewSpotAggregator(wsprNet, stats, config.PersistenceFile)
	aggregator.Start()
	defer aggregator.Stop()

	log.Println("Spot aggregator initialized (4-minute window for deduplication)")

	// Initialize web server
	webServer := NewWebServer(stats, aggregator, wsprNet, config, config.WebPort, *configFile)
	if err := webServer.Start(); err != nil {
		log.Fatalf("Failed to start web server: %v", err)
	}
	log.Printf("Web dashboard available at http://localhost:%d", config.WebPort)

	// Initialize MQTT client with instance name mapping
	mqttClient, err := NewMQTTClient(config, aggregator, stats)
	if err != nil {
		log.Fatalf("Failed to initialize MQTT client: %v", err)
	}

	// Connect to MQTT broker
	if err := mqttClient.Connect(); err != nil {
		log.Fatalf("Failed to connect to MQTT broker: %v", err)
	}
	defer mqttClient.Disconnect()

	log.Println("MQTT client connected and subscribed")

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	log.Println("WSPR MQTT Aggregator running. Press Ctrl+C to stop.")

	<-sigChan
	log.Println("Shutting down...")
}

// MQTTClient handles MQTT connection and message processing
type MQTTClient struct {
	config       *Config
	client       mqtt.Client
	aggregator   *SpotAggregator
	stats        *StatisticsTracker
	msgCount     int64
	prefixToName map[string]string // Maps topic prefix to instance name
	startTime    time.Time         // Application start time for filtering retained messages
}

// NewMQTTClient creates a new MQTT client
func NewMQTTClient(config *Config, aggregator *SpotAggregator, stats *StatisticsTracker) (*MQTTClient, error) {
	// Build prefix to name mapping
	prefixToName := make(map[string]string)
	for _, inst := range config.MQTT.Instances {
		prefixToName[inst.TopicPrefix] = inst.Name
	}

	mc := &MQTTClient{
		config:       config,
		aggregator:   aggregator,
		stats:        stats,
		prefixToName: prefixToName,
		startTime:    time.Now(),
	}

	opts := mqtt.NewClientOptions()
	opts.AddBroker(config.MQTT.Broker)
	opts.SetClientID(fmt.Sprintf("wsprnet_mqtt_%d", time.Now().Unix()))

	if config.MQTT.Username != "" {
		opts.SetUsername(config.MQTT.Username)
	}
	if config.MQTT.Password != "" {
		opts.SetPassword(config.MQTT.Password)
	}

	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(10 * time.Second)
	opts.SetKeepAlive(60 * time.Second)

	opts.SetOnConnectHandler(func(client mqtt.Client) {
		log.Println("MQTT: Connected to broker")
		mc.subscribe()
	})

	opts.SetConnectionLostHandler(func(client mqtt.Client, err error) {
		log.Printf("MQTT: Connection lost: %v", err)
	})

	opts.SetReconnectingHandler(func(client mqtt.Client, opts *mqtt.ClientOptions) {
		log.Println("MQTT: Attempting to reconnect...")
	})

	mc.client = mqtt.NewClient(opts)

	return mc, nil
}

// Connect connects to the MQTT broker
func (mc *MQTTClient) Connect() error {
	if token := mc.client.Connect(); token.Wait() && token.Error() != nil {
		return fmt.Errorf("failed to connect to MQTT broker: %w", token.Error())
	}

	log.Println("MQTT: Successfully connected to broker")
	return nil
}

// subscribe subscribes to WSPR topics for all configured instances
func (mc *MQTTClient) subscribe() {
	// Subscribe to all WSPR bands under each instance's topic prefix
	// Format: {prefix}/digital_modes/WSPR/+
	for _, inst := range mc.config.MQTT.Instances {
		topic := fmt.Sprintf("%s/digital_modes/WSPR/+", inst.TopicPrefix)

		token := mc.client.Subscribe(topic, byte(mc.config.MQTT.QoS), mc.messageHandler)
		if token.Wait() && token.Error() != nil {
			log.Printf("MQTT: Failed to subscribe to %s (%s): %v", topic, inst.Name, token.Error())
			continue
		}

		log.Printf("MQTT: Subscribed to %s (%s)", topic, inst.Name)
	}
}

// messageHandler processes incoming MQTT messages
func (mc *MQTTClient) messageHandler(client mqtt.Client, msg mqtt.Message) {
	mc.msgCount++

	// Extract topic prefix and instance name from the message topic
	// Topic format: {prefix}/digital_modes/WSPR/{band}
	topic := msg.Topic()
	topicPrefix := ""
	instanceName := ""
	for _, inst := range mc.config.MQTT.Instances {
		if len(topic) > len(inst.TopicPrefix) && topic[:len(inst.TopicPrefix)] == inst.TopicPrefix {
			topicPrefix = inst.TopicPrefix
			instanceName = inst.Name
			break
		}
	}

	if instanceName == "" {
		instanceName = topicPrefix // Fallback to prefix if name not found
	}

	// Parse the WSPR decode from JSON
	var decode WSPRDecode
	if err := json.Unmarshal(msg.Payload(), &decode); err != nil {
		log.Printf("MQTT: Failed to parse message: %v", err)
		return
	}

	// Validate the decode
	if decode.Mode != "WSPR" {
		return
	}

	if decode.Callsign == "" || decode.Locator == "" {
		log.Printf("MQTT: Skipping decode without callsign or locator")
		return
	}

	// Filter out hashed callsigns
	if decode.Callsign == "<...>" {
		return
	}

	// Parse timestamp
	timestamp, err := time.Parse(time.RFC3339, decode.Timestamp)
	if err != nil {
		log.Printf("MQTT: Failed to parse timestamp: %v", err)
		return
	}

	// Ignore messages with timestamps before application startup (retained messages)
	if timestamp.Before(mc.startTime) {
		if mc.msgCount <= 100 {
			// Log first few rejections so user knows filtering is working
			log.Printf("MQTT: Ignoring retained message from %s (timestamp: %s, before startup at %s)",
				decode.Callsign, timestamp.Format("15:04:05"), mc.startTime.Format("15:04:05"))
		}
		return
	}

	// Create WSPRNet report
	report := WSPRReport{
		Callsign:     decode.Callsign,
		Locator:      decode.Locator,
		SNR:          decode.SNR,
		Frequency:    decode.TxFrequency,
		ReceiverFreq: decode.Frequency,
		DT:           float32(decode.DT),
		Drift:        decode.Drift,
		DBm:          decode.DBm,
		EpochTime:    timestamp,
		Mode:         decode.Mode,
	}

	// Add to aggregator for deduplication (with instance name and country for statistics)
	mc.aggregator.AddSpot(&report, instanceName, decode.Country)

	if mc.msgCount%100 == 0 {
		log.Printf("MQTT: Processed %d messages", mc.msgCount)
	}
}

// Disconnect disconnects from the MQTT broker
func (mc *MQTTClient) Disconnect() {
	if mc.client.IsConnected() {
		mc.client.Disconnect(250)
		log.Println("MQTT: Disconnected from broker")
	}
}

// WSPRDecode represents a WSPR decode from MQTT
type WSPRDecode struct {
	Mode        string  `json:"mode"`
	Band        string  `json:"band"`
	Callsign    string  `json:"callsign"`
	Locator     string  `json:"locator"`
	Country     string  `json:"country"`
	CQZone      int     `json:"CQZone"`
	ITUZone     int     `json:"ITUZone"`
	Continent   string  `json:"Continent"`
	TimeOffset  float64 `json:"TimeOffset"`
	SNR         int     `json:"snr"`
	Frequency   uint64  `json:"frequency"`
	Timestamp   string  `json:"timestamp"`
	Message     string  `json:"message"`
	DT          float64 `json:"dt"`
	Drift       int     `json:"drift"`
	DBm         int     `json:"dbm"`
	TxFrequency uint64  `json:"tx_frequency"`
}
