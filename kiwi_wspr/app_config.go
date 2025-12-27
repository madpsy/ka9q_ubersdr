package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// AppConfig represents the application configuration
type AppConfig struct {
	MQTT          MQTTConfig     `yaml:"mqtt"`
	KiwiInstances []KiwiInstance `yaml:"kiwi_instances"`
	WSPRBands     []WSPRBand     `yaml:"wspr_bands"`
	Decoder       DecoderConfig  `yaml:"decoder"`
	Logging       LoggingConfig  `yaml:"logging"`
}

// MQTTConfig holds MQTT broker configuration
type MQTTConfig struct {
	Enabled     bool   `yaml:"enabled"`
	Host        string `yaml:"host"`
	Port        int    `yaml:"port"`
	UseTLS      bool   `yaml:"use_tls"`
	Username    string `yaml:"username"`
	Password    string `yaml:"password"`
	TopicPrefix string `yaml:"topic_prefix"`
	QoS         byte   `yaml:"qos"`
	Retain      bool   `yaml:"retain"`
}

// KiwiInstance represents a KiwiSDR instance
type KiwiInstance struct {
	Name            string `yaml:"name"`
	Host            string `yaml:"host"`
	Port            int    `yaml:"port"`
	Password        string `yaml:"password"`
	User            string `yaml:"user"`
	Enabled         bool   `yaml:"enabled"`
	MQTTTopicPrefix string `yaml:"mqtt_topic_prefix"` // Optional: Override global MQTT topic prefix for this instance
}

// WSPRBand represents a WSPR band configuration
type WSPRBand struct {
	Name      string  `yaml:"name"`
	Frequency float64 `yaml:"frequency"`
	Instance  string  `yaml:"instance"`
	Enabled   bool    `yaml:"enabled"`
}

// DecoderConfig holds decoder settings
type DecoderConfig struct {
	WSPRDPath   string `yaml:"wsprd_path"`
	WorkDir     string `yaml:"work_dir"`
	KeepWav     bool   `yaml:"keep_wav"`
	Compression bool   `yaml:"compression"`
}

// LoggingConfig holds logging settings
type LoggingConfig struct {
	Level string `yaml:"level"`
	Quiet bool   `yaml:"quiet"`
}

// LoadConfig loads configuration from a YAML file
func LoadConfig(filename string) (*AppConfig, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var config AppConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	// Validate configuration
	if err := config.Validate(); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	return &config, nil
}

// Validate checks if the configuration is valid
func (c *AppConfig) Validate() error {
	if c.MQTT.Enabled {
		if c.MQTT.Host == "" {
			return fmt.Errorf("MQTT host is required when MQTT is enabled")
		}
		if c.MQTT.Port == 0 {
			return fmt.Errorf("MQTT port is required when MQTT is enabled")
		}
		if c.MQTT.TopicPrefix == "" {
			return fmt.Errorf("MQTT topic prefix is required")
		}
	}

	if len(c.KiwiInstances) == 0 {
		return fmt.Errorf("at least one KiwiSDR instance is required")
	}

	// Validate that each band references a valid instance
	instanceMap := make(map[string]bool)
	for _, inst := range c.KiwiInstances {
		instanceMap[inst.Name] = true
	}

	for _, band := range c.WSPRBands {
		if band.Enabled {
			if !instanceMap[band.Instance] {
				return fmt.Errorf("band %s references unknown instance %s", band.Name, band.Instance)
			}
		}
	}

	if c.Decoder.WSPRDPath == "" {
		return fmt.Errorf("wsprd_path is required")
	}

	return nil
}

// GetInstance returns a KiwiSDR instance by name
func (c *AppConfig) GetInstance(name string) *KiwiInstance {
	for i := range c.KiwiInstances {
		if c.KiwiInstances[i].Name == name {
			return &c.KiwiInstances[i]
		}
	}
	return nil
}

// GetEnabledBands returns all enabled WSPR bands
func (c *AppConfig) GetEnabledBands() []WSPRBand {
	var enabled []WSPRBand
	for _, band := range c.WSPRBands {
		if band.Enabled {
			enabled = append(enabled, band)
		}
	}
	return enabled
}
