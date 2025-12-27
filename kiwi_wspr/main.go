package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/pflag"
)

const Version = "v1.0.0"

func main() {
	// Command line options
	var (
		// Standalone recording mode options
		serverHost  = pflag.StringP("server", "s", "", "KiwiSDR server host (standalone mode)")
		serverPort  = pflag.IntP("port", "p", 8073, "KiwiSDR server port")
		frequency   = pflag.Float64P("freq", "f", 14097.0, "Frequency to tune to in kHz")
		modulation  = pflag.StringP("mode", "m", "usb", "Modulation mode (am, lsb, usb, cw, iq)")
		user        = pflag.StringP("user", "u", "kiwi_wspr_go", "User name for connection")
		password    = pflag.StringP("password", "w", "", "Password (if required)")
		duration    = pflag.IntP("duration", "d", 120, "Recording duration in seconds (0 = unlimited)")
		outputDir   = pflag.String("dir", ".", "Output directory for recordings")
		filename    = pflag.String("filename", "", "Fixed filename (default: auto-generated)")
		lpCut       = pflag.Float64P("lp-cut", "L", 300, "Low-pass cutoff frequency in Hz")
		hpCut       = pflag.Float64P("hp-cut", "H", 2700, "High-pass cutoff frequency in Hz")
		agcGain     = pflag.Float64P("agc-gain", "g", -1, "AGC gain (if set, AGC is off)")
		compression = pflag.Bool("compression", false, "Enable audio compression (disabled by default)")
		quiet       = pflag.BoolP("quiet", "q", false, "Quiet mode - minimal output")

		// WSPR decoder mode options
		configFile = pflag.String("config", "config.yaml", "Configuration file for WSPR decoder mode")
		webPort    = pflag.Int("web-port", 8080, "Web interface port")
		webOnly    = pflag.Bool("web-only", false, "Run web interface only (no decoding)")

		version = pflag.BoolP("version", "v", false, "Print version and exit")
	)

	pflag.Parse()

	if *version {
		fmt.Printf("kiwi_wspr %s\n", Version)
		os.Exit(0)
	}

	// Setup logging
	if *quiet {
		log.SetOutput(os.Stderr)
	}

	log.Printf("kiwi_wspr %s - KiwiSDR Recorder in Go", Version)

	// Check if running in standalone mode or WSPR decoder mode
	if *serverHost != "" {
		// Standalone recording mode
		runStandaloneMode(*serverHost, *serverPort, *frequency, *modulation, *user, *password,
			*duration, *outputDir, *filename, *lpCut, *hpCut, *agcGain, *compression, *quiet)
	} else {
		// WSPR decoder mode with config file
		runWSPRDecoderMode(*configFile, *webPort, *webOnly)
	}
}

// runStandaloneMode runs a single recording session
func runStandaloneMode(serverHost string, serverPort int, frequency float64, modulation, user, password string,
	duration int, outputDir, filename string, lpCut, hpCut, agcGain float64, compression, quiet bool) {

	log.Printf("Standalone mode: Connecting to %s:%d", serverHost, serverPort)

	// Create configuration
	config := &Config{
		ServerHost:  serverHost,
		ServerPort:  serverPort,
		Frequency:   frequency,
		Modulation:  modulation,
		User:        user,
		Password:    password,
		Duration:    time.Duration(duration) * time.Second,
		OutputDir:   outputDir,
		Filename:    filename,
		LowCut:      lpCut,
		HighCut:     hpCut,
		AGCGain:     agcGain,
		Compression: compression,
		Quiet:       quiet,
	}

	// Create and connect client
	client, err := NewKiwiClient(config)
	if err != nil {
		log.Fatalf("Failed to create client: %v", err)
	}

	// Setup signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start recording in a goroutine
	errChan := make(chan error, 1)
	go func() {
		errChan <- client.Run()
	}()

	// Wait for completion or interrupt
	select {
	case err := <-errChan:
		if err != nil {
			log.Fatalf("Recording error: %v", err)
		}
		log.Println("Recording completed successfully")
	case sig := <-sigChan:
		log.Printf("Received signal %v, shutting down...", sig)
		client.Close()
		time.Sleep(100 * time.Millisecond)
	}
}

// runWSPRDecoderMode runs the WSPR decoder with config file
func runWSPRDecoderMode(configFile string, webPort int, webOnly bool) {
	log.Printf("WSPR Decoder mode: Loading config from %s", configFile)

	// Load configuration
	appConfig, err := LoadConfig(configFile)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	log.Printf("Loaded configuration: %d instances, %d bands",
		len(appConfig.KiwiInstances), len(appConfig.GetEnabledBands()))

	// Load CTY database
	log.Println("Loading CTY database...")
	if err := InitCTYDatabase("cty/cty.dat"); err != nil {
		log.Fatalf("Failed to load CTY database: %v", err)
	}

	// Start web server
	webServer := NewWebServer(appConfig, configFile, webPort)
	go func() {
		if err := webServer.Start(); err != nil {
			log.Fatalf("Web server error: %v", err)
		}
	}()

	if webOnly {
		log.Println("Running in web-only mode (no decoding)")
		select {} // Block forever
	}

	// Initialize MQTT publisher
	var mqttPublisher *MQTTPublisher
	if appConfig.MQTT.Enabled {
		mqttPublisher, err = NewMQTTPublisher(&appConfig.MQTT)
		if err != nil {
			log.Fatalf("Failed to initialize MQTT: %v", err)
		}
		defer mqttPublisher.Disconnect()
	}

	// Start WSPR coordinators for each enabled band
	enabledBands := appConfig.GetEnabledBands()
	if len(enabledBands) == 0 {
		log.Println("No enabled bands configured")
		select {} // Block forever
	}

	log.Printf("Starting WSPR coordinators for %d bands...", len(enabledBands))

	coordinators := make([]*WSPRCoordinator, 0, len(enabledBands))
	for _, band := range enabledBands {
		instance := appConfig.GetInstance(band.Instance)
		if instance == nil {
			log.Printf("Warning: Band %s references unknown instance %s, skipping", band.Name, band.Instance)
			continue
		}

		// Create config for this band
		bandConfig := &Config{
			ServerHost:  instance.Host,
			ServerPort:  instance.Port,
			Frequency:   band.Frequency,
			Modulation:  "usb",
			User:        instance.User,
			Password:    instance.Password,
			Duration:    120 * time.Second,
			OutputDir:   appConfig.Decoder.WorkDir,
			LowCut:      300,
			HighCut:     2700,
			AGCGain:     -1,
			Compression: appConfig.Decoder.Compression,
			Quiet:       appConfig.Logging.Quiet,
		}

		// Create coordinator
		coordinator := NewWSPRCoordinator(
			bandConfig,
			appConfig.Decoder.WSPRDPath,
			appConfig.Receiver.Locator,
			appConfig.Receiver.Callsign,
			appConfig.Decoder.WorkDir,
			band.Name,
			mqttPublisher,
		)

		if err := coordinator.Start(); err != nil {
			log.Printf("Failed to start coordinator for %s: %v", band.Name, err)
			continue
		}

		coordinators = append(coordinators, coordinator)
		log.Printf("Started WSPR coordinator for %s (%.3f MHz on %s)", band.Name, band.Frequency, instance.Name)
	}

	if len(coordinators) == 0 {
		log.Fatal("No coordinators started")
	}

	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Wait for signal
	sig := <-sigChan
	log.Printf("Received signal %v, shutting down...", sig)

	// Stop all coordinators
	for _, coord := range coordinators {
		coord.Stop()
	}

	log.Println("Shutdown complete")
}
