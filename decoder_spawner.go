package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DecoderSpawner handles spawning external decoder processes
type DecoderSpawner struct {
	config *DecoderConfig
}

// NewDecoderSpawner creates a new decoder spawner
func NewDecoderSpawner(config *DecoderConfig) *DecoderSpawner {
	return &DecoderSpawner{
		config: config,
	}
}

// SpawnDecoder spawns a decoder process for the given WAV file
// Returns the output file path where decoder results will be written, the log file path, and the execution duration
func (ds *DecoderSpawner) SpawnDecoder(wavFile string, band *DecoderBand) (string, string, time.Duration, error) {
	modeInfo := GetModeInfo(band.Config.Mode)

	// Create working directory for this band (isolates decoder temp files)
	workDir := filepath.Join(ds.config.DataDir, fmt.Sprintf("%d", band.Config.Frequency))
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return "", "", 0, fmt.Errorf("failed to create work directory: %w", err)
	}

	// Extract timestamp from WAV filename to make log file unique per cycle
	// WAV filename format: YYMMDD_HHMMSS.wav or YYMMDD_HHMM.wav
	wavBasename := filepath.Base(wavFile)
	wavTimestamp := strings.TrimSuffix(wavBasename, ".wav")

	// Create unique log file path for this decode cycle
	logFile := filepath.Join(ds.config.DataDir,
		fmt.Sprintf("%s_%d_%s.log", band.Config.Mode.String(), band.Config.Frequency, wavTimestamp))

	// Determine output file path based on mode
	var outputFile string
	if band.Config.Mode == ModeWSPR {
		// wsprd writes to wspr_spots.txt in working directory
		outputFile = filepath.Join(workDir, "wspr_spots.txt")
	} else {
		// jt9 writes to stdout (captured in log file)
		outputFile = logFile
	}

	// Get decode depth from band config (defaults to 3)
	depth := band.Config.GetDepth()

	// Build decoder command and get log file handle
	cmd, logFileHandle := ds.buildDecoderCommand(modeInfo, wavFile, band.Config.Frequency, workDir, logFile, depth)

	// Ensure log file is closed after decoder completes
	defer func() {
		if logFileHandle != nil {
			logFileHandle.Close()
		}
	}()

	// Record decoder invocation
	RecordDecoderInvoke(band.Config.Name)

	// Start the decoder process and track execution time
	startTime := time.Now()
	if err := cmd.Start(); err != nil {
		return "", "", 0, fmt.Errorf("failed to start decoder: %w", err)
	}

	// Wait for decoder to complete
	err := cmd.Wait()
	executionTime := time.Since(startTime)

	if err != nil {
		log.Printf("Decoder process for %s exited with error: %v", band.Config.Name, err)
		return "", "", executionTime, fmt.Errorf("decoder process failed: %w", err)
	}

	// Give the decoder a moment to fully release file handles
	// This is especially important for jt9 which may buffer writes
	time.Sleep(200 * time.Millisecond)

	return outputFile, logFile, executionTime, nil
}

// buildDecoderCommand builds the command to execute the decoder
func (ds *DecoderSpawner) buildDecoderCommand(modeInfo ModeInfo, wavFile string, frequency uint64, workDir, logFile string, depth int) (*exec.Cmd, *os.File) {
	// Build arguments by replacing placeholders
	args := make([]string, len(modeInfo.DecoderArgs))
	for i, arg := range modeInfo.DecoderArgs {
		arg = strings.ReplaceAll(arg, "{file}", wavFile)
		arg = strings.ReplaceAll(arg, "{freq}", fmt.Sprintf("%.6f", float64(frequency)/1e6))
		arg = strings.ReplaceAll(arg, "{depth}", fmt.Sprintf("%d", depth))
		args[i] = arg
	}

	// Get the binary path from config
	var binaryPath string
	switch modeInfo.DecoderCommand {
	case "jt9":
		binaryPath = ds.config.JT9Path
	case "wsprd":
		binaryPath = ds.config.WSPRDPath
	default:
		binaryPath = modeInfo.DecoderCommand // Fallback to command name
	}

	// Create command
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = workDir

	// Redirect stdout to log file
	logF, err := os.Create(logFile)
	if err != nil {
		log.Printf("Warning: failed to create log file %s: %v", logFile, err)
		return cmd, nil
	}

	cmd.Stdout = logF
	cmd.Stderr = logF

	return cmd, logF
}

// ProcessDecoderOutput reads the decoder output file and extracts spots
// For WSPR, this reads wspr_spots.txt; for FT8/FT4, this reads the log file
func (ds *DecoderSpawner) ProcessDecoderOutput(outputFile string, band *DecoderBand, receiverLocator string) ([]*DecodeInfo, error) {
	// Wait a moment for the decoder to finish writing
	time.Sleep(100 * time.Millisecond)

	// Parse the output file
	decodes, err := ParseDecoderLog(outputFile, band.Config.Frequency, band.Config.Mode, band.Config.Name, receiverLocator)
	if err != nil {
		return nil, fmt.Errorf("failed to parse decoder output: %w", err)
	}

	// Deduplicate by callsign (keep strongest SNR)
	decodes = DeduplicateDecodes(decodes)

	return decodes, nil
}

// CleanupFiles removes temporary files if configured
// For WSPR, outputFile is wspr_spots.txt which should NOT be removed (wsprd overwrites it)
// For FT8/FT4, outputFile is the log file which should be removed if keep_logs is false
func (ds *DecoderSpawner) CleanupFiles(wavFile, outputFile string, mode DecoderMode) {
	if !ds.config.KeepWav {
		if err := os.Remove(wavFile); err != nil && !os.IsNotExist(err) {
			log.Printf("Warning: failed to remove WAV file %s: %v", wavFile, err)
		}
	}

	// Only remove output file for non-WSPR modes (FT8/FT4 log files)
	// WSPR's wspr_spots.txt should not be removed as wsprd overwrites it
	if !ds.config.KeepLogs && mode != ModeWSPR {
		if err := os.Remove(outputFile); err != nil && !os.IsNotExist(err) {
			log.Printf("Warning: failed to remove output file %s: %v", outputFile, err)
		}
	}
}

// CheckDecoderAvailability checks if the required decoder binaries are available
func CheckDecoderAvailability(config *DecoderConfig, modes []DecoderMode) error {
	checkedPaths := make(map[string]bool)

	for _, mode := range modes {
		var binaryPath string
		var binaryName string

		switch mode {
		case ModeFT8, ModeFT4:
			binaryPath = config.JT9Path
			binaryName = "jt9"
		case ModeWSPR:
			binaryPath = config.WSPRDPath
			binaryName = "wsprd"
		default:
			continue
		}

		// Skip if already checked
		if checkedPaths[binaryPath] {
			continue
		}

		// Check if binary exists and is executable
		info, err := os.Stat(binaryPath)
		if err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("decoder binary '%s' not found at path: %s (required for %s)", binaryName, binaryPath, mode.String())
			}
			return fmt.Errorf("error checking decoder binary '%s': %w", binaryPath, err)
		}

		// Check if it's executable
		if info.Mode()&0111 == 0 {
			return fmt.Errorf("decoder binary '%s' is not executable: %s", binaryName, binaryPath)
		}

		checkedPaths[binaryPath] = true
		log.Printf("Found decoder: %s at %s (for %s)", binaryName, binaryPath, mode.String())
	}

	return nil
}
