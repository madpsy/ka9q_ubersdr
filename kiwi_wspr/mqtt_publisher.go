package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// MQTTPublisher handles publishing WSPR decodes to MQTT
type MQTTPublisher struct {
	client mqtt.Client
	config *MQTTConfig
}

// WSPRDecodeMessage represents a WSPR decode for MQTT publishing
// Matches the format from the main application's PublishDigitalDecode
type WSPRDecodeMessage struct {
	Mode        string    `json:"mode"`
	Band        string    `json:"band"`
	Callsign    string    `json:"callsign"`
	Locator     string    `json:"locator"`
	Country     string    `json:"country"`
	CQZone      int       `json:"CQZone"`
	ITUZone     int       `json:"ITUZone"`
	Continent   string    `json:"Continent"`
	TimeOffset  float64   `json:"TimeOffset"`
	SNR         int       `json:"snr"`
	Frequency   uint64    `json:"frequency"`
	Timestamp   time.Time `json:"timestamp"`
	Message     string    `json:"message"`
	DT          float64   `json:"dt"`
	Drift       int       `json:"drift"`
	DBm         int       `json:"dbm"`
	TxFrequency uint64    `json:"tx_frequency"`
}

// generateClientID creates a random MQTT client ID
func generateClientID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "kiwi_wspr_" + hex.EncodeToString(bytes)
}

// NewMQTTPublisher creates a new MQTT publisher
func NewMQTTPublisher(config *MQTTConfig) (*MQTTPublisher, error) {
	if !config.Enabled {
		return nil, nil
	}

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
		client: client,
		config: config,
	}, nil
}

// PublishWSPRDecode publishes a WSPR decode to MQTT
// Topic structure: {prefix}/digital_modes/WSPR/{band}
func (mp *MQTTPublisher) PublishWSPRDecode(decode *WSPRDecode, bandName string, dialFreq uint64) error {
	if mp == nil || !mp.client.IsConnected() {
		return fmt.Errorf("MQTT not connected")
	}

	// Lookup CTY information for the callsign
	ctyInfo := GetCallsignInfo(decode.Callsign)

	// Build message matching the main application's format
	msg := WSPRDecodeMessage{
		Mode:        "WSPR",
		Band:        bandName,
		Callsign:    decode.Callsign,
		Locator:     decode.Locator,
		SNR:         decode.SNR,
		Frequency:   dialFreq,
		Timestamp:   decode.Timestamp,
		Message:     fmt.Sprintf("%s %s %d", decode.Callsign, decode.Locator, decode.Power),
		DT:          decode.DT,
		Drift:       decode.Drift,
		DBm:         decode.Power,
		TxFrequency: uint64(decode.Frequency * 1e6),
	}

	// Add CTY information if available
	if ctyInfo != nil {
		msg.Country = ctyInfo.Country
		msg.CQZone = ctyInfo.CQZone
		msg.ITUZone = ctyInfo.ITUZone
		msg.Continent = ctyInfo.Continent
		msg.TimeOffset = ctyInfo.TimeOffset
	}

	// Build topic: {prefix}/digital_modes/WSPR/{band}
	topic := fmt.Sprintf("%s/digital_modes/WSPR/%s",
		mp.config.TopicPrefix,
		bandName)

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	// Publish asynchronously
	token := mp.client.Publish(topic, mp.config.QoS, mp.config.Retain, data)

	// Wait for completion in background
	go func() {
		if token.Wait() && token.Error() != nil {
			log.Printf("MQTT ERROR: Failed to publish to %s: %v", topic, token.Error())
		} else {
			log.Printf("MQTT: Published %s spot to %s", decode.Callsign, topic)
		}
	}()

	return nil
}

// Disconnect gracefully disconnects from the MQTT broker
func (mp *MQTTPublisher) Disconnect() {
	if mp != nil && mp.client != nil && mp.client.IsConnected() {
		mp.client.Disconnect(250)
		log.Println("MQTT: Disconnected from broker")
	}
}
