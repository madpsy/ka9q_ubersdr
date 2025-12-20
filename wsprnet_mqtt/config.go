package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config represents the application configuration
type Config struct {
	Receiver        ReceiverConfig `yaml:"receiver" json:"receiver"`
	MQTT            MQTTConfig     `yaml:"mqtt" json:"mqtt"`
	WebPort         int            `yaml:"web_port" json:"web_port"`
	DryRun          bool           `yaml:"dry_run" json:"dry_run"`
	PersistenceFile string         `yaml:"persistence_file" json:"persistence_file"`
	AdminPassword   string         `yaml:"admin_password" json:"admin_password"`
}

// ReceiverConfig contains receiver station information
type ReceiverConfig struct {
	Callsign string `yaml:"callsign" json:"callsign"`
	Locator  string `yaml:"locator" json:"locator"`
}

// MQTTConfig contains MQTT broker configuration
type MQTTConfig struct {
	Broker    string           `yaml:"broker" json:"broker"`
	Username  string           `yaml:"username" json:"username"`
	Password  string           `yaml:"password" json:"password"`
	Instances []InstanceConfig `yaml:"instances" json:"instances"`
	QoS       int              `yaml:"qos" json:"qos"`

	// Deprecated: Use Instances instead
	TopicPrefixes []string `yaml:"topic_prefixes,omitempty" json:"topic_prefixes,omitempty"`
}

// InstanceConfig represents a single UberSDR instance
type InstanceConfig struct {
	Name        string `yaml:"name" json:"name"`
	TopicPrefix string `yaml:"topic_prefix" json:"topic_prefix"`
}

// LoadConfig loads configuration from a YAML file
func LoadConfig(filename string) (*Config, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	return &config, nil
}

// Validate validates the configuration
func (c *Config) Validate() error {
	if c.Receiver.Callsign == "" {
		return fmt.Errorf("receiver callsign is required")
	}

	if c.Receiver.Locator == "" {
		return fmt.Errorf("receiver locator is required")
	}

	if len(c.Receiver.Locator) < 4 || len(c.Receiver.Locator) > 6 {
		return fmt.Errorf("receiver locator must be 4 or 6 characters")
	}

	if c.MQTT.Broker == "" {
		return fmt.Errorf("MQTT broker is required")
	}

	// Support both old and new config formats
	if len(c.MQTT.Instances) == 0 && len(c.MQTT.TopicPrefixes) == 0 {
		return fmt.Errorf("at least one MQTT instance is required")
	}

	// Convert old format to new format if needed
	if len(c.MQTT.Instances) == 0 && len(c.MQTT.TopicPrefixes) > 0 {
		c.MQTT.Instances = make([]InstanceConfig, len(c.MQTT.TopicPrefixes))
		for i, prefix := range c.MQTT.TopicPrefixes {
			c.MQTT.Instances[i] = InstanceConfig{
				Name:        prefix, // Use prefix as name for backward compatibility
				TopicPrefix: prefix,
			}
		}
	}

	// Validate instances
	for i, inst := range c.MQTT.Instances {
		if inst.TopicPrefix == "" {
			return fmt.Errorf("instance %d: topic_prefix is required", i)
		}
		if inst.Name == "" {
			// Default to topic prefix if name not provided
			c.MQTT.Instances[i].Name = inst.TopicPrefix
		}
	}

	if c.MQTT.QoS < 0 || c.MQTT.QoS > 2 {
		c.MQTT.QoS = 0
	}

	// Set default web port if not specified
	if c.WebPort == 0 {
		c.WebPort = 9009
	}

	// Set default persistence file if not specified
	if c.PersistenceFile == "" {
		c.PersistenceFile = "wsprnet_stats.jsonl"
	}

	return nil
}
