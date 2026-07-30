package main

import (
	"bytes"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const (
	defaultReceiverMinHz = uint64(10_000)
	defaultReceiverMaxHz = uint64(30_000_000)
)

// ReceiverConfig describes the receiver service used by UberSDR and the RF
// coverage that it makes available. KA9Q radiod remains the channel engine;
// the backend/driver metadata lets the rest of UberSDR stop assuming RX888/HF.
type ReceiverConfig struct {
	Backend         string            `yaml:"backend" json:"backend"`
	Driver          string            `yaml:"driver" json:"driver"`
	Device          string            `yaml:"device,omitempty" json:"device,omitempty"`
	Description     string            `yaml:"description,omitempty" json:"description,omitempty"`
	Serial          string            `yaml:"serial,omitempty" json:"serial,omitempty"`
	SampleRate      uint64            `yaml:"sample_rate,omitempty" json:"sample_rate,omitempty"`
	CenterFrequency uint64            `yaml:"center_frequency,omitempty" json:"center_frequency,omitempty"`
	FrequencyMinHz  uint64            `yaml:"frequency_min_hz" json:"frequency_min_hz"`
	FrequencyMaxHz  uint64            `yaml:"frequency_max_hz" json:"frequency_max_hz"`
	Options         map[string]string `yaml:"options,omitempty" json:"options,omitempty"`
}

func (c *ReceiverConfig) applyDefaults() {
	if c.Backend == "" {
		c.Backend = "ka9q-radiod"
	}
	if c.Driver == "" && c.Backend == "ka9q-radiod" {
		c.Driver = "rx888"
	}
	if c.Device == "" && c.Backend == "ka9q-radiod" {
		c.Device = c.Driver
	}
	if c.FrequencyMinHz == 0 {
		c.FrequencyMinHz = defaultReceiverMinHz
	}
	if c.FrequencyMaxHz == 0 {
		c.FrequencyMaxHz = defaultReceiverMaxHz
	}
}

func (c ReceiverConfig) Validate() error {
	c.applyDefaults()
	if _, ok := defaultSDRBackends.Lookup(c.Backend); !ok {
		return fmt.Errorf("receiver.backend %q is not registered (available: %s)",
			c.Backend, strings.Join(defaultSDRBackends.IDs(), ", "))
	}
	if c.FrequencyMaxHz <= c.FrequencyMinHz {
		return fmt.Errorf("receiver.frequency_max_hz must be greater than receiver.frequency_min_hz")
	}
	if c.CenterFrequency != 0 &&
		(c.CenterFrequency < c.FrequencyMinHz || c.CenterFrequency > c.FrequencyMaxHz) {
		return fmt.Errorf("receiver.center_frequency must be inside configured receiver coverage")
	}
	if c.Backend == "ka9q-radiod" {
		if _, ok := defaultSDRDeviceProfiles.Lookup(c.Driver); !ok {
			return fmt.Errorf("receiver.driver %q is not a supported KA9Q Radio driver (available: %s)",
				c.Driver, strings.Join(defaultSDRDeviceProfiles.IDs(), ", "))
		}
	}
	return validateReceiverOptions(c.Options)
}

// FrequencyRange returns the configured RF coverage. LoadConfig applies legacy
// defaults, but this fallback also keeps directly-constructed Config values safe.
func (c *Config) FrequencyRange() (uint64, uint64) {
	minHz, maxHz := c.Receiver.FrequencyMinHz, c.Receiver.FrequencyMaxHz
	if minHz == 0 {
		minHz = defaultReceiverMinHz
	}
	if maxHz <= minHz {
		minHz, maxHz = defaultReceiverMinHz, defaultReceiverMaxHz
	}
	return minHz, maxHz
}

// SpectrumRange returns the largest contiguous range that can be sampled at
// once. Tunable coverage can be much wider than instantaneous sample rate for
// devices such as RTL-SDR, Airspy, and HackRF.
func (c *Config) SpectrumRange() (uint64, uint64) {
	minHz, maxHz := c.FrequencyRange()
	coverageSpan := maxHz - minHz
	if c.Receiver.SampleRate == 0 || c.Receiver.SampleRate >= coverageSpan {
		return minHz, maxHz
	}

	span := c.Receiver.SampleRate
	center := c.Receiver.CenterFrequency
	if center < minHz || center > maxHz {
		center = minHz + coverageSpan/2
	}
	start := minHz
	if center > span/2 {
		start = center - span/2
	}
	if start < minHz {
		start = minHz
	}
	if start > maxHz-span {
		start = maxHz - span
	}
	return start, start + span
}

func (c *Config) IsFrequencySupported(frequency uint64) bool {
	minHz, maxHz := c.FrequencyRange()
	return frequency >= minHz && frequency <= maxHz
}

func (c *Config) FrequencyRangeLabel() string {
	minHz, maxHz := c.FrequencyRange()
	return fmt.Sprintf("%d-%d Hz", minHz, maxHz)
}

// SDRCapabilities declares the limits that planning, validation, and the UI
// need before opening a receiver. Values are in Hz; a zero maximum means the
// backend cannot state a reliable limit.
type SDRCapabilities struct {
	MinFrequencyHz uint64 `json:"min_frequency_hz"`
	MaxFrequencyHz uint64 `json:"max_frequency_hz"`
	MaxSampleRate  uint64 `json:"max_sample_rate"`
	Channels       int    `json:"channels"`
	SupportsIQ     bool   `json:"supports_iq"`
	SupportsGPSDO  bool   `json:"supports_gpsdo"`
	SupportsGain   bool   `json:"supports_gain"`
}

// SDRBackend is a hardware or receiver-service adapter. It intentionally
// describes capability and configuration validation separately from UberSDR's
// session/channel API; direct-IQ backends can be added without making USB or
// network details leak into SessionManager.
type SDRBackend interface {
	ID() string
	DisplayName() string
	Capabilities() SDRCapabilities
	ValidateConfig(map[string]any) error
}

type SDRBackendRegistry struct {
	mu       sync.RWMutex
	backends map[string]SDRBackend
}

func NewSDRBackendRegistry() *SDRBackendRegistry {
	return &SDRBackendRegistry{backends: make(map[string]SDRBackend)}
}

func (r *SDRBackendRegistry) Register(backend SDRBackend) error {
	if backend == nil || backend.ID() == "" {
		return fmt.Errorf("SDR backend must have an ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.backends[backend.ID()]; exists {
		return fmt.Errorf("SDR backend %q is already registered", backend.ID())
	}
	r.backends[backend.ID()] = backend
	return nil
}

func (r *SDRBackendRegistry) Lookup(id string) (SDRBackend, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	backend, ok := r.backends[id]
	return backend, ok
}

func (r *SDRBackendRegistry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.backends))
	for id := range r.backends {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// radiodBackend is the initial adapter. It represents the existing KA9Q
// receiver service, preserving its multicast control/data model while giving
// new source adapters a stable catalog entry point.
type radiodBackend struct{}

func (radiodBackend) ID() string          { return "ka9q-radiod" }
func (radiodBackend) DisplayName() string { return "KA9Q radiod receiver service" }
func (radiodBackend) Capabilities() SDRCapabilities {
	return SDRCapabilities{Channels: 1, SupportsIQ: true, SupportsGain: true}
}
func (radiodBackend) ValidateConfig(config map[string]any) error {
	if config == nil {
		return fmt.Errorf("ka9q-radiod requires status_group and data_group configuration")
	}
	for _, key := range []string{"status_group", "data_group"} {
		if value, ok := config[key].(string); !ok || value == "" {
			return fmt.Errorf("ka9q-radiod requires %s", key)
		}
	}
	return nil
}

// externalRadiodBackend accepts any hardware or bridge that exposes the KA9Q
// multicast control/status/data protocol. This is the escape hatch for SoapySDR
// sidecars, remote receivers, and vendor devices not compiled into local radiod.
type externalRadiodBackend struct{}

func (externalRadiodBackend) ID() string          { return "external-radiod" }
func (externalRadiodBackend) DisplayName() string { return "External KA9Q-compatible receiver service" }
func (externalRadiodBackend) Capabilities() SDRCapabilities {
	return SDRCapabilities{Channels: 1, SupportsIQ: true}
}
func (externalRadiodBackend) ValidateConfig(config map[string]any) error {
	return radiodBackend{}.ValidateConfig(config)
}

var defaultSDRBackends = newBuiltinSDRBackendRegistry()

func newBuiltinSDRBackendRegistry() *SDRBackendRegistry {
	registry := NewSDRBackendRegistry()
	for _, backend := range []SDRBackend{radiodBackend{}, externalRadiodBackend{}} {
		if err := registry.Register(backend); err != nil {
			panic(err)
		}
	}
	return registry
}

// SDRDeviceProfile describes a receive driver that current KA9Q Radio builds
// can load. Frequency limits remain deployment configuration because device
// revisions, converter offsets, front-end filters, and antenna systems differ.
type SDRDeviceProfile struct {
	Driver            string   `json:"driver"`
	DisplayName       string   `json:"display_name"`
	Family            string   `json:"family"`
	Native            bool     `json:"native"`
	ReceiveOnly       bool     `json:"receive_only"`
	ConfigurationKeys []string `json:"configuration_keys"`
	Notes             string   `json:"notes,omitempty"`
}

type SDRDeviceProfileRegistry struct {
	mu       sync.RWMutex
	profiles map[string]SDRDeviceProfile
}

func NewSDRDeviceProfileRegistry() *SDRDeviceProfileRegistry {
	return &SDRDeviceProfileRegistry{profiles: make(map[string]SDRDeviceProfile)}
}

func (r *SDRDeviceProfileRegistry) Register(profile SDRDeviceProfile) error {
	if profile.Driver == "" {
		return fmt.Errorf("SDR device profile must have a driver")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.profiles[profile.Driver]; exists {
		return fmt.Errorf("SDR device profile %q is already registered", profile.Driver)
	}
	r.profiles[profile.Driver] = profile
	return nil
}

func (r *SDRDeviceProfileRegistry) Lookup(driver string) (SDRDeviceProfile, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	profile, ok := r.profiles[driver]
	return profile, ok
}

func (r *SDRDeviceProfileRegistry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.profiles))
	for id := range r.profiles {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (r *SDRDeviceProfileRegistry) Profiles() []SDRDeviceProfile {
	ids := r.IDs()
	profiles := make([]SDRDeviceProfile, 0, len(ids))
	for _, id := range ids {
		profile, _ := r.Lookup(id)
		profiles = append(profiles, profile)
	}
	return profiles
}

var defaultSDRDeviceProfiles = newBuiltinSDRDeviceProfileRegistry()

func newBuiltinSDRDeviceProfileRegistry() *SDRDeviceProfileRegistry {
	registry := NewSDRDeviceProfileRegistry()
	profiles := []SDRDeviceProfile{
		{Driver: "airspy", DisplayName: "Airspy R2 / Mini", Family: "Airspy", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "frequency", "converter", "calibrate", "linearity", "lna-agc", "mixer-agc", "lna-gain", "mixer-gain", "vga-gain", "gainstep", "bias", "agc-high-threshold", "agc-low-threshold"}},
		{Driver: "airspyhf", DisplayName: "Airspy HF+ family", Family: "Airspy", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "frequency", "hf-agc", "agc-thresh", "hf-att", "hf-lna", "lib-dsp", "calibrate"}},
		{Driver: "bladerf", DisplayName: "Nuand bladeRF family", Family: "bladeRF", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "frequency", "bandwidth", "gain", "bias", "calibrate"}},
		{Driver: "fobos", DisplayName: "RigExpert Fobos SDR", Family: "Fobos", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "frequency", "lna_gain", "vga_gain", "direct_sampling", "clk_source", "ext_clock"}},
		{Driver: "funcube", DisplayName: "FUNcube Dongle Pro+", Family: "FUNcube", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"number", "frequency", "agc", "bias", "calibrate"}},
		{Driver: "hackrf", DisplayName: "HackRF family", Family: "HackRF", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "index", "frequency", "lna-gain", "mixer-gain", "if-gain"}},
		{Driver: "hydrasdr", DisplayName: "HydraSDR family", Family: "HydraSDR", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "frequency", "converter", "calibrate", "linearity", "lna-agc", "rf-agc", "mixer-agc", "filter-agc", "lna-gain", "rf-gain", "mixer-gain", "filter-gain", "vga-gain", "gainstep", "bias", "agc-high-threshold", "agc-low-threshold"}},
		{Driver: "rtlsdr", DisplayName: "RTL-SDR compatible dongles", Family: "RTL-SDR", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "frequency", "gain", "agc", "bias", "direct_sampling", "calibrate"}},
		{Driver: "rx888", DisplayName: "RX-888 MkII and compatible", Family: "RX-888", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "gainmode", "gain", "att", "atten", "featten", "rfatten", "rfgain", "rxgain", "fegain", "gaincal", "firmware", "dither", "rand", "reference", "undersample", "queuedepth", "reqsize", "reset"}},
		{Driver: "sdrplay", DisplayName: "SDRplay RSP family", Family: "SDRplay", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "serial", "frequency", "rspduo-mode", "antenna", "ifreq", "bandwidth", "calibrate", "lna-state", "rf-att", "rf-gr", "if-att", "if-gr", "if-agc", "if-agc-rate", "if-agc-setpoint-dbfs", "dc-offset-corr", "iq-imbalance-corr", "bulk-transfer-mode", "rf-notch", "dab-notch", "am-notch", "bias-t"}},
		{Driver: "sig_gen", DisplayName: "Synthetic signal generator", Family: "Test", Native: true, ReceiveOnly: true, ConfigurationKeys: []string{"samprate", "frequency", "signal-frequency", "signal-amplitude", "noise-amplitude"}},
	}
	for _, profile := range profiles {
		if err := registry.Register(profile); err != nil {
			panic(err)
		}
	}
	return registry
}

var radiodOptionNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

func validateReceiverOptions(options map[string]string) error {
	for key, value := range options {
		if !radiodOptionNamePattern.MatchString(key) {
			return fmt.Errorf("receiver.options key %q contains unsupported characters", key)
		}
		if strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("receiver.options.%s must be a single line", key)
		}
	}
	return nil
}

// BuildRadiodConfig renders a minimal dynamic-channel KA9Q Radio configuration
// for every native driver profile. Driver-specific settings pass through the
// validated options map so new upstream knobs do not require an UberSDR release.
func BuildRadiodConfig(receiver ReceiverConfig, radiod RadiodConfig) (string, error) {
	receiver.applyDefaults()
	if receiver.Backend != "ka9q-radiod" {
		return "", fmt.Errorf("radiod config generation is only available for receiver.backend ka9q-radiod")
	}
	if err := receiver.Validate(); err != nil {
		return "", err
	}
	if radiod.StatusGroup == "" || radiod.DataGroup == "" {
		return "", fmt.Errorf("radiod.status_group and radiod.data_group are required")
	}

	var output bytes.Buffer
	fmt.Fprintln(&output, "# Generated by UberSDR. Driver-specific options are preserved from receiver.options.")
	fmt.Fprintln(&output, "[global]")
	fmt.Fprintf(&output, "hardware = %s\n", receiver.Driver)
	fmt.Fprintf(&output, "status = %s\n", radiodGroupHost(radiod.StatusGroup))
	fmt.Fprintf(&output, "data = %s\n", radiodGroupHost(radiod.DataGroup))
	fmt.Fprintln(&output, "ttl = 1")
	fmt.Fprintln(&output, "mode = usb")
	fmt.Fprintln(&output, "samprate = 12000")
	fmt.Fprintln(&output, "blocktime = 20")
	fmt.Fprintln(&output, "overlap = 5")
	fmt.Fprintln(&output)
	fmt.Fprintf(&output, "[%s]\n", receiver.Driver)
	fmt.Fprintf(&output, "device = %s\n", quoteRadiodValue(receiver.Device, receiver.Driver))
	fmt.Fprintf(&output, "description = %s\n", quoteRadiodValue(receiver.Description, receiver.Driver+" receiver"))
	if receiver.Serial != "" {
		fmt.Fprintf(&output, "serial = %s\n", quoteRadiodValue(receiver.Serial, ""))
	}
	if receiver.SampleRate > 0 {
		fmt.Fprintf(&output, "samprate = %d\n", receiver.SampleRate)
	}
	if receiver.CenterFrequency > 0 {
		fmt.Fprintf(&output, "frequency = %d\n", receiver.CenterFrequency)
	}
	keys := make([]string, 0, len(receiver.Options))
	for key := range receiver.Options {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Fprintf(&output, "%s = %s\n", key, receiver.Options[key])
	}
	return output.String(), nil
}

func quoteRadiodValue(value, fallback string) string {
	if value == "" {
		value = fallback
	}
	return strconv.Quote(value)
}

func radiodGroupHost(group string) string {
	if host, _, err := net.SplitHostPort(group); err == nil {
		return host
	}
	return group
}
