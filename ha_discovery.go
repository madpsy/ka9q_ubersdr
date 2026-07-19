package main

import (
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
)

// Home Assistant MQTT Discovery
// ------------------------------
// This file makes UberSDR's existing MQTT feed self-describing to Home
// Assistant. On (re)connect it publishes retained discovery config messages to
//   {ha_prefix}/{component}/{node_id}/{object_id}/config
// which cause Home Assistant to automatically create sensors / binary_sensors,
// all grouped under a single HA "device" representing this receiver.
//
// No entity data is duplicated: every discovered entity simply points its
// state_topic at the topics the MQTT publisher already writes
// (ubersdr/metrics/...) and extracts a value with a value_template. Availability
// is driven by the retained {prefix}/status topic (birth "online" / LWT
// "offline"), so entities go unavailable if UberSDR drops off the broker.
//
// Enable with mqtt.homeassistant_discovery: true in config.yaml.

// haDevice is the shared Home Assistant device block. Every entity references
// the same device so they group together in the HA UI.
type haDevice struct {
	Identifiers   []string `json:"identifiers"`
	Name          string   `json:"name"`
	Manufacturer  string   `json:"manufacturer"`
	Model         string   `json:"model,omitempty"`
	SwVersion     string   `json:"sw_version,omitempty"`
	HWVersion     string   `json:"hw_version,omitempty"`
	SerialNumber  string   `json:"serial_number,omitempty"`
	SuggestedArea string   `json:"suggested_area,omitempty"`
	ConfigURL     string   `json:"configuration_url,omitempty"`
}

// haEntity is a single Home Assistant MQTT Discovery config payload. Fields are
// omitempty so each entity only emits what it needs; the JSON shape matches the
// HA MQTT sensor / binary_sensor discovery schema.
type haEntity struct {
	Name              string `json:"name"`
	UniqueID          string `json:"unique_id"`
	ObjectID          string `json:"object_id,omitempty"`
	StateTopic        string `json:"state_topic"`
	ValueTemplate     string `json:"value_template,omitempty"`
	UnitOfMeasurement string `json:"unit_of_measurement,omitempty"`
	DeviceClass       string `json:"device_class,omitempty"`
	StateClass        string `json:"state_class,omitempty"`
	Icon              string `json:"icon,omitempty"`
	EntityCategory    string `json:"entity_category,omitempty"`

	JSONAttributesTopic    string `json:"json_attributes_topic,omitempty"`
	JSONAttributesTemplate string `json:"json_attributes_template,omitempty"`

	// binary_sensor
	PayloadOn  string `json:"payload_on,omitempty"`
	PayloadOff string `json:"payload_off,omitempty"`

	// availability
	AvailabilityTopic   string `json:"availability_topic,omitempty"`
	PayloadAvailable    string `json:"payload_available,omitempty"`
	PayloadNotAvailable string `json:"payload_not_available,omitempty"`

	Device haDevice `json:"device"`

	// component is the HA platform ("sensor" / "binary_sensor"); used to build
	// the discovery topic. Unexported, so it is not serialized into the payload.
	component string
	// skipAvailability, when true, tells add() not to attach the shared
	// availability block. Used by the connectivity sensor, which IS the
	// availability signal and must stay available to report offline.
	skipAvailability bool
}

var haSlugRe = regexp.MustCompile(`[^a-z0-9_]+`)

// haSlug normalizes an arbitrary string into an MQTT-topic / HA-id safe slug.
func haSlug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "_")
	s = haSlugRe.ReplaceAllString(s, "_")
	s = strings.Trim(s, "_")
	if s == "" {
		s = "x"
	}
	return s
}

// onConnectHomeAssistant publishes the birth ("online") status and, once the
// app config is available, the retained discovery configs. Invoked from the
// MQTT OnConnect handler (in a goroutine) on every (re)connect.
func (mp *MQTTPublisher) onConnectHomeAssistant() {
	if !mp.config.HomeAssistant {
		return
	}
	mp.publishOnlineStatus()

	if cfg := mp.publisherConfig; cfg != nil {
		mp.publishHADiscovery(cfg)
	}
}

// publishOnlineStatus publishes the retained "online" birth message that HA
// uses as the availability signal for every discovered entity.
func (mp *MQTTPublisher) publishOnlineStatus() {
	if mp.client == nil {
		return
	}
	statusTopic := mp.config.TopicPrefix + "/status"
	token := mp.client.Publish(statusTopic, 1, true, "online")
	token.Wait()
}

// publishHADiscovery builds and publishes (retained) all Home Assistant
// discovery config messages for the entities UberSDR can populate.
func (mp *MQTTPublisher) publishHADiscovery(appConfig *Config) {
	if mp.client == nil || !mp.isConnected() {
		return
	}

	entities := mp.buildHAEntities(appConfig)
	haPrefix := mp.config.HomeAssistantPrefix
	nodeID := mp.haNodeID(appConfig)

	published := 0
	for _, e := range entities {
		topic := fmt.Sprintf("%s/%s/%s/%s/config", haPrefix, e.component, nodeID, e.ObjectID)
		data, err := json.Marshal(e)
		if err != nil {
			log.Printf("MQTT ERROR: Failed to marshal HA discovery entity %s: %v", e.ObjectID, err)
			continue
		}
		// Retained so HA picks up the config whenever it (re)subscribes.
		token := mp.client.Publish(topic, 1, true, data)
		if token.Wait() && token.Error() != nil {
			mp.logPublishError("MQTT ERROR: Failed to publish HA discovery %s: %v", topic, token.Error())
			continue
		}
		published++
	}
	log.Printf("MQTT: Published %d Home Assistant discovery configs (node=%s)", published, nodeID)
}

// haNodeID derives a stable, topic-safe node id for this receiver from its
// callsign (falling back to a generic id).
func (mp *MQTTPublisher) haNodeID(appConfig *Config) string {
	call := appConfig.Admin.Callsign
	if call == "" || call == "N0CALL" {
		return "ubersdr"
	}
	return "ubersdr_" + haSlug(call)
}

// haSerialNumber returns a stable serial for the HA device block. Uses the
// instance's public UUID when the instance reporter is available; otherwise
// empty (the device identifiers already make it unique).
func (mp *MQTTPublisher) haSerialNumber() string {
	if mp.instanceReporter == nil {
		return ""
	}
	status := mp.instanceReporter.GetReportStatus()
	if uuid, ok := status["public_uuid"].(string); ok {
		return uuid
	}
	return ""
}

// buildHAEntities returns the full list of discovery entities for the current
// configuration. Only entities whose subsystem is enabled are included.
func (mp *MQTTPublisher) buildHAEntities(appConfig *Config) []haEntity {
	prefix := mp.config.TopicPrefix
	statusTopic := prefix + "/status"
	nodeID := mp.haNodeID(appConfig)

	call := appConfig.Admin.Callsign
	if call == "" {
		call = "UberSDR"
	}
	device := haDevice{
		Identifiers:   []string{nodeID},
		Name:          "UberSDR " + call,
		Manufacturer:  "UberSDR",
		Model:         appConfig.Admin.Name, // receiver name, e.g. "RX888 with end-fed long wire"
		SwVersion:     Version,
		HWVersion:     appConfig.Admin.Antenna, // antenna description
		SerialNumber:  mp.haSerialNumber(),     // stable public UUID when available
		SuggestedArea: appConfig.Admin.Location, // HA groups the device under this area
		ConfigURL:     appConfig.Admin.PublicURL,
	}

	var entities []haEntity

	// add appends an entity, filling in the boilerplate shared by every entity:
	// unique_id, object_id, availability topic and the device block.
	//
	// unique_id is callsign-scoped so it is globally unique (multiple UberSDR
	// instances into one HA never collide in the registry). object_id — which
	// drives the entity_id — is deliberately callsign-FREE (e.g.
	// "ubersdr_active_users" -> sensor.ubersdr_active_users) so a dashboard can
	// reference entities without hardcoding any callsign. The per-instance
	// identity still shows via the device name and the receiver_info attributes.
	// (If two instances share one HA, the second instance's entity_ids get an
	// automatic _2 suffix; unique_ids stay distinct either way.)
	add := func(e haEntity) {
		slug := haSlug(e.ObjectID)
		e.UniqueID = nodeID + "_" + slug
		e.ObjectID = "ubersdr_" + slug
		if !e.skipAvailability && e.AvailabilityTopic == "" {
			e.AvailabilityTopic = statusTopic
			e.PayloadAvailable = "online"
			e.PayloadNotAvailable = "offline"
		}
		e.Device = device
		entities = append(entities, e)
	}

	// --- Availability / connectivity -------------------------------------
	// This sensor IS the availability signal, so it carries no availability
	// block (skipAvailability): it must stay available to report "off" when the
	// receiver drops. The retained status topic gives it an immediate value.
	add(haEntity{
		component:        "binary_sensor",
		Name:             "UberSDR Online",
		ObjectID:         "online",
		StateTopic:       statusTopic,
		PayloadOn:        "online",
		PayloadOff:       "offline",
		DeviceClass:      "connectivity",
		EntityCategory:   "diagnostic",
		skipAvailability: true,
	})

	// --- User sessions (headline) ----------------------------------------
	// active_users carries the full session array as attributes so a Lovelace
	// map / table card can render live listeners (lat/lon/freq/mode/country).
	add(haEntity{
		component:              "sensor",
		Name:                   "Active Users",
		ObjectID:               "active_users",
		StateTopic:             prefix + "/sessions",
		ValueTemplate:          "{{ value_json.count }}",
		UnitOfMeasurement:      "users",
		StateClass:             "measurement",
		Icon:                   "mdi:account-group",
		JSONAttributesTopic:    prefix + "/sessions",
		JSONAttributesTemplate: "{{ {'sessions': value_json.sessions} | tojson }}",
	})

	// --- Space weather ----------------------------------------------------
	sw := prefix + "/spaceweather"
	add(haEntity{
		component: "sensor", Name: "Solar Flux Index", ObjectID: "solar_flux",
		StateTopic: sw, ValueTemplate: "{{ value_json.data.spaceweather_solar_flux_sfu }}",
		UnitOfMeasurement: "SFU", StateClass: "measurement", Icon: "mdi:white-balance-sunny",
	})
	add(haEntity{
		component: "sensor", Name: "K-Index", ObjectID: "k_index",
		StateTopic: sw, ValueTemplate: "{{ value_json.data.spaceweather_k_index }}",
		StateClass: "measurement", Icon: "mdi:sine-wave",
	})
	add(haEntity{
		component: "sensor", Name: "A-Index", ObjectID: "a_index",
		StateTopic: sw, ValueTemplate: "{{ value_json.data.spaceweather_a_index }}",
		StateClass: "measurement", Icon: "mdi:sine-wave",
	})
	add(haEntity{
		component: "sensor", Name: "Solar Wind Bz", ObjectID: "solar_wind_bz",
		StateTopic: sw, ValueTemplate: "{{ value_json.data.spaceweather_solar_wind_bz_nt }}",
		UnitOfMeasurement: "nT", StateClass: "measurement", Icon: "mdi:weather-windy",
	})
	add(haEntity{
		component: "sensor", Name: "Propagation Quality", ObjectID: "propagation_quality",
		StateTopic: sw, ValueTemplate: "{{ value_json.data.propagation_quality }}",
		Icon: "mdi:radio-tower",
	})
	add(haEntity{
		component: "sensor", Name: "K-Index Status", ObjectID: "k_index_status",
		StateTopic: sw, ValueTemplate: "{{ value_json.data.k_index_status }}",
		Icon: "mdi:information-outline",
	})

	// --- Receiver identity & status --------------------------------------
	// A single diagnostic sensor whose state is the version and whose
	// attributes carry the full /api/description-style identity (callsign,
	// name, location, grid, antenna, ASL, lat/lon, timezone, feature flags),
	// plus a few live counters broken out as their own sensors.
	ri := prefix + "/receiver_info"
	add(haEntity{
		component: "sensor", Name: "Receiver Info", ObjectID: "receiver_info",
		StateTopic: ri, ValueTemplate: "{{ value_json.version }}",
		JSONAttributesTopic: ri, EntityCategory: "diagnostic", Icon: "mdi:radio-tower",
	})
	add(haEntity{
		component: "sensor", Name: "Grid Square", ObjectID: "grid_square",
		StateTopic: ri, ValueTemplate: "{{ value_json.grid_square }}",
		Icon: "mdi:map-marker", EntityCategory: "diagnostic",
	})
	add(haEntity{
		component: "sensor", Name: "Available Slots", ObjectID: "available_clients",
		StateTopic: ri, ValueTemplate: "{{ value_json.available_clients }}",
		UnitOfMeasurement: "slots", StateClass: "measurement", Icon: "mdi:account-multiple-plus-outline",
	})
	add(haEntity{
		component: "sensor", Name: "Chat Users", ObjectID: "chat_users",
		StateTopic: ri, ValueTemplate: "{{ value_json.chat_users }}",
		UnitOfMeasurement: "users", StateClass: "measurement", Icon: "mdi:chat",
	})
	add(haEntity{
		component: "sensor", Name: "SNR 0-30 MHz", ObjectID: "snr_0_30",
		StateTopic: ri, ValueTemplate: "{{ value_json.snr_0_30_mhz }}",
		UnitOfMeasurement: "dB", StateClass: "measurement", Icon: "mdi:signal",
	})
	add(haEntity{
		component: "sensor", Name: "SNR 1.8-30 MHz", ObjectID: "snr_1_8_30",
		StateTopic: ri, ValueTemplate: "{{ value_json.snr_1_8_30_mhz }}",
		UnitOfMeasurement: "dB", StateClass: "measurement", Icon: "mdi:signal",
	})

	// --- Frequency reference (GPSDO discipline), when enabled -------------
	if appConfig.FrequencyReference.Enabled {
		fr := prefix + "/frequency_reference"
		add(haEntity{
			component: "sensor", Name: "Frequency Reference Offset", ObjectID: "freq_ref_offset",
			StateTopic: fr, ValueTemplate: "{{ value_json.frequency_offset }}",
			UnitOfMeasurement: "Hz", StateClass: "measurement", Icon: "mdi:sine-wave",
			EntityCategory: "diagnostic",
		})
		add(haEntity{
			component: "sensor", Name: "Frequency Reference SNR", ObjectID: "freq_ref_snr",
			StateTopic: fr, ValueTemplate: "{{ value_json.snr }}",
			UnitOfMeasurement: "dB", StateClass: "measurement", Icon: "mdi:signal",
			EntityCategory: "diagnostic",
		})
	}

	// --- Terrestrial (local) weather, when available ---------------------
	// UberSDR fetches OpenWeatherMap current-weather via the instance reporter;
	// weather is available when the reporter source is configured (same gate as
	// WeatherService.Start()). The raw OWM JSON is published to {prefix}/weather.
	ir := appConfig.InstanceReporting
	if ir.InstanceUUID != "" && ir.Hostname != "" && ir.Port != 0 {
		wx := prefix + "/weather"
		add(haEntity{
			component: "sensor", Name: "Outside Temperature", ObjectID: "weather_temp",
			StateTopic: wx, ValueTemplate: "{{ value_json.main.temp }}",
			UnitOfMeasurement: "°C", DeviceClass: "temperature", StateClass: "measurement",
		})
		add(haEntity{
			component: "sensor", Name: "Feels Like", ObjectID: "weather_feels_like",
			StateTopic: wx, ValueTemplate: "{{ value_json.main.feels_like }}",
			UnitOfMeasurement: "°C", DeviceClass: "temperature", StateClass: "measurement",
		})
		add(haEntity{
			component: "sensor", Name: "Humidity", ObjectID: "weather_humidity",
			StateTopic: wx, ValueTemplate: "{{ value_json.main.humidity }}",
			UnitOfMeasurement: "%", DeviceClass: "humidity", StateClass: "measurement",
		})
		add(haEntity{
			component: "sensor", Name: "Pressure", ObjectID: "weather_pressure",
			StateTopic: wx, ValueTemplate: "{{ value_json.main.pressure | default('', true) }}",
			UnitOfMeasurement: "hPa", DeviceClass: "atmospheric_pressure", StateClass: "measurement",
		})
		add(haEntity{
			component: "sensor", Name: "Wind Speed", ObjectID: "weather_wind_speed",
			StateTopic: wx, ValueTemplate: "{{ value_json.wind.speed }}",
			UnitOfMeasurement: "m/s", DeviceClass: "wind_speed", StateClass: "measurement",
			Icon: "mdi:weather-windy",
		})
		add(haEntity{
			component: "sensor", Name: "Wind Bearing", ObjectID: "weather_wind_bearing",
			StateTopic: wx, ValueTemplate: "{{ value_json.wind.deg | default('', true) }}",
			UnitOfMeasurement: "°", StateClass: "measurement", Icon: "mdi:compass-outline",
		})
		add(haEntity{
			component: "sensor", Name: "Weather Condition", ObjectID: "weather_condition",
			StateTopic: wx, ValueTemplate: "{{ value_json.weather[0].main }}",
			Icon: "mdi:weather-partly-cloudy",
		})
		add(haEntity{
			component: "sensor", Name: "Weather Description", ObjectID: "weather_description",
			StateTopic: wx, ValueTemplate: "{{ value_json.weather[0].description | title }}",
			Icon: "mdi:text-short",
		})
	}

	// --- Latest chat message, when chat is enabled -----------------------
	// Real-time: UberSDR already publishes every message to {prefix}/chat as it
	// is sent, so this sensor updates the instant a message arrives. It holds
	// the LATEST message (state) with username/message/ip/timestamp as
	// attributes. A rolling last-N history is accumulated HA-side by the
	// optional trigger-based template sensor documented in home_assistant.md.
	if appConfig.Chat.Enabled {
		chat := prefix + "/chat"
		add(haEntity{
			component: "sensor", Name: "Last Chat Message", ObjectID: "last_chat_message",
			StateTopic:          chat,
			ValueTemplate:       "{{ (value_json.username ~ ': ' ~ value_json.message) | truncate(250) }}",
			JSONAttributesTopic: chat,
			Icon:                "mdi:chat-outline",
		})
	}

	// --- Antenna rotator (position), when enabled ------------------------
	if appConfig.Rotctl.Enabled {
		rot := prefix + "/rotator_status"
		add(haEntity{
			component: "sensor", Name: "Antenna Azimuth", ObjectID: "rotator_azimuth",
			StateTopic: rot, ValueTemplate: "{{ value_json.position.azimuth }}",
			UnitOfMeasurement: "°", StateClass: "measurement", Icon: "mdi:compass-outline",
		})
		add(haEntity{
			component: "sensor", Name: "Antenna Elevation", ObjectID: "rotator_elevation",
			StateTopic: rot, ValueTemplate: "{{ value_json.position.elevation }}",
			UnitOfMeasurement: "°", StateClass: "measurement", Icon: "mdi:angle-acute",
		})
		add(haEntity{
			component: "binary_sensor", Name: "Rotator Moving", ObjectID: "rotator_moving",
			StateTopic: rot, ValueTemplate: "{{ 'ON' if value_json.moving else 'OFF' }}",
			PayloadOn: "ON", PayloadOff: "OFF",
			DeviceClass: "moving", Icon: "mdi:rotate-right",
		})
		add(haEntity{
			component: "binary_sensor", Name: "Rotator Connected", ObjectID: "rotator_connected",
			StateTopic: rot, ValueTemplate: "{{ 'ON' if value_json.connected else 'OFF' }}",
			PayloadOn: "ON", PayloadOff: "OFF",
			DeviceClass: "connectivity", EntityCategory: "diagnostic",
		})
	}

	// --- Antenna switch, when enabled ------------------------------------
	if appConfig.AntSwitch.Enabled {
		as := prefix + "/ant_switch_status"
		add(haEntity{
			component: "sensor", Name: "Antenna", ObjectID: "antenna_switch",
			StateTopic: as, ValueTemplate: "{{ value_json.active }}",
			Icon: "mdi:antenna",
			// selected[], antenna_labels[], num_antennas, thunderstorm, last_error
			// are exposed as attributes for cards/automations.
			JSONAttributesTopic: as,
		})
		add(haEntity{
			component: "binary_sensor", Name: "Antenna Grounded", ObjectID: "antenna_grounded",
			StateTopic: as, ValueTemplate: "{{ 'ON' if value_json.grounded else 'OFF' }}",
			PayloadOn: "ON", PayloadOff: "OFF",
			Icon: "mdi:power-plug-off-outline",
		})
		add(haEntity{
			component: "binary_sensor", Name: "Thunderstorm Protection", ObjectID: "antenna_thunderstorm",
			StateTopic: as, ValueTemplate: "{{ 'ON' if value_json.thunderstorm else 'OFF' }}",
			PayloadOn: "ON", PayloadOff: "OFF",
			// No device_class: "on" means protection is enabled (a safe state),
			// which the "safety" class would mislabel as "Unsafe".
			Icon: "mdi:weather-lightning", EntityCategory: "diagnostic",
		})
	}

	// --- Per-band noise floor --------------------------------------------
	for _, band := range appConfig.NoiseFloor.Bands {
		bandName := band.Name
		if bandName == "" {
			continue
		}
		bt := fmt.Sprintf("%s/noisefloor/%s", prefix, bandName)
		add(haEntity{
			component: "sensor", Name: fmt.Sprintf("Noise Floor %s Occupancy", bandName),
			ObjectID:   "noisefloor_" + bandName + "_occupancy",
			StateTopic: bt, ValueTemplate: "{{ value_json.metrics.noisefloor_occupancy_percent | round(1) }}",
			UnitOfMeasurement: "%", StateClass: "measurement", Icon: "mdi:radio",
		})
		add(haEntity{
			component: "sensor", Name: fmt.Sprintf("Noise Floor %s FT8 SNR", bandName),
			ObjectID:   "noisefloor_" + bandName + "_ft8_snr",
			StateTopic: bt, ValueTemplate: "{{ value_json.metrics.noisefloor_ft8_snr_db | round(1) }}",
			UnitOfMeasurement: "dB", StateClass: "measurement", Icon: "mdi:signal",
		})
	}

	// --- System load / CPU (diagnostic) ----------------------------------
	sl := prefix + "/system_load"
	add(haEntity{
		component: "sensor", Name: "System Load (1m)", ObjectID: "system_load_1m",
		StateTopic: sl, ValueTemplate: "{{ value_json.load_1min | float }}",
		StateClass: "measurement", Icon: "mdi:gauge", EntityCategory: "diagnostic",
	})
	add(haEntity{
		component: "sensor", Name: "CPU Temperature", ObjectID: "cpu_temp",
		StateTopic: sl, ValueTemplate: "{{ value_json.cpu_temp_c | float }}",
		UnitOfMeasurement: "°C", DeviceClass: "temperature", StateClass: "measurement",
		EntityCategory: "diagnostic",
	})

	// --- Component health (binary_sensor, device_class problem) ----------
	// value_template emits "ON" only when the payload's "healthy" field is
	// explicitly false — the HA-idiomatic sense for device_class "problem".
	// Using "== false" (rather than "not") means a missing/undefined healthy
	// field defaults to OK instead of raising a false alarm. These topics
	// (dsp_health, instance_reporter_health, ntp_health) all carry a boolean
	// "healthy".
	healthProblem := func(name, objectID, topic string) haEntity {
		return haEntity{
			component: "binary_sensor", Name: name, ObjectID: objectID,
			StateTopic:    topic,
			ValueTemplate: "{{ 'ON' if value_json.healthy == false else 'OFF' }}",
			PayloadOn:     "ON", PayloadOff: "OFF",
			DeviceClass: "problem", EntityCategory: "diagnostic",
		}
	}

	// NTP health always publishes.
	add(healthProblem("NTP Health", "ntp_health", prefix+"/ntp_health"))
	add(haEntity{
		component: "sensor", Name: "NTP Offset", ObjectID: "ntp_offset",
		StateTopic: prefix + "/ntp_health", ValueTemplate: "{{ value_json.offset_ms | float }}",
		UnitOfMeasurement: "ms", StateClass: "measurement", EntityCategory: "diagnostic",
		Icon: "mdi:clock-outline",
	})

	if appConfig.DSP.Enabled {
		add(healthProblem("DSP Health", "dsp_health", prefix+"/dsp_health"))
	}
	if appConfig.InstanceReporting.Enabled {
		add(healthProblem("Instance Reporter Health", "instance_reporter_health", prefix+"/instance_reporter_health"))
	}
	if appConfig.InstanceReporting.TunnelServerEnabled {
		// The tunnel_server_health payload has no "healthy" field — it sets
		// "error": true only on connection/parse failures (and returns the
		// remote status otherwise). So flag a problem on "error", which
		// defaults to OK when the field is absent.
		add(haEntity{
			component: "binary_sensor", Name: "Tunnel Server Health", ObjectID: "tunnel_server_health",
			StateTopic:    prefix + "/tunnel_server_health",
			ValueTemplate: "{{ 'ON' if value_json.error else 'OFF' }}",
			PayloadOn:     "ON", PayloadOff: "OFF",
			DeviceClass: "problem", EntityCategory: "diagnostic",
		})
	}

	return entities
}
