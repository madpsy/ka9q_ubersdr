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
// Returns the log file path where decoder output will be written
func (ds *DecoderSpawner) SpawnDecoder(wavFile string, band *DecoderBand) (string, error) {
	modeInfo := GetModeInfo(band.Config.Mode)

	// Create working directory for this band (isolates decoder temp files)
	workDir := filepath.Join(ds.config.DataDir, fmt.Sprintf("%d", band.Config.Frequency))
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create work directory: %w", err)
	}

	// Create log file path
	logFile := filepath.Join(ds.config.DataDir,
		fmt.Sprintf("%s_%d.log", band.Config.Mode.String(), band.Config.Frequency))

	// Build decoder command
	cmd := ds.buildDecoderCommand(modeInfo, wavFile, band.Config.Frequency, workDir, logFile)

	if DebugMode {
		log.Printf("DEBUG: Spawning decoder: %s %v", cmd.Path, cmd.Args)
		log.Printf("DEBUG: Working directory: %s", workDir)
		log.Printf("DEBUG: Log file: %s", logFile)
	}

	// Start the decoder process
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to start decoder: %w", err)
	}

	// Wait for decoder in a goroutine
	go func() {
		err := cmd.Wait()
		if err != nil {
			log.Printf("Decoder process for %s exited with error: %v", band.Config.Name, err)
		} else if DebugMode {
			log.Printf("DEBUG: Decoder process for %s completed successfully", band.Config.Name)
		}
	}()

	return logFile, nil
}

// buildDecoderCommand builds the command to execute the decoder
func (ds *DecoderSpawner) buildDecoderCommand(modeInfo ModeInfo, wavFile string, frequency uint64, workDir, logFile string) *exec.Cmd {
	// Build arguments by replacing placeholders
	args := make([]string, len(modeInfo.DecoderArgs))
	for i, arg := range modeInfo.DecoderArgs {
		arg = strings.ReplaceAll(arg, "{file}", wavFile)
		arg = strings.ReplaceAll(arg, "{freq}", fmt.Sprintf("%.6f", float64(frequency)/1e6))
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
	} else {
		cmd.Stdout = logF
		cmd.Stderr = logF
	}

	return cmd
}

// ProcessDecoderOutput reads the decoder log file and extracts spots
func (ds *DecoderSpawner) ProcessDecoderOutput(logFile string, band *DecoderBand) ([]*DecodeInfo, error) {
	// Wait a moment for the decoder to finish writing
	time.Sleep(100 * time.Millisecond)

	// Parse the log file
	decodes, err := ParseDecoderLog(logFile, band.Config.Frequency, band.Config.Mode)
	if err != nil {
		return nil, fmt.Errorf("failed to parse decoder log: %w", err)
	}

	if DebugMode {
		log.Printf("DEBUG: Parsed %d decodes from %s", len(decodes), logFile)
	}

	// Deduplicate by callsign (keep strongest SNR)
	decodes = DeduplicateDecodes(decodes)

	if DebugMode {
		log.Printf("DEBUG: After deduplication: %d unique decodes", len(decodes))
	}

	return decodes, nil
}

// CleanupFiles removes temporary files if configured
func (ds *DecoderSpawner) CleanupFiles(wavFile, logFile string) {
	if !ds.config.KeepWav {
		if err := os.Remove(wavFile); err != nil && !os.IsNotExist(err) {
			log.Printf("Warning: failed to remove WAV file %s: %v", wavFile, err)
		} else if DebugMode {
			log.Printf("DEBUG: Removed WAV file: %s", wavFile)
		}
	}

	if !ds.config.KeepLogs {
		if err := os.Remove(logFile); err != nil && !os.IsNotExist(err) {
			log.Printf("Warning: failed to remove log file %s: %v", logFile, err)
		} else if DebugMode {
			log.Printf("DEBUG: Removed log file: %s", logFile)
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
