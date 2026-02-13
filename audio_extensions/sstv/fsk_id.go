package sstv

import (
	"log"
	"math"
	"time"
)

/*
 * FSK ID Decoder
 * Ported from slowrx by Oona Räisänen (OH2EIQ)
 *
 * FSK ID Format:
 * - 6-bit bytes, LSB first
 * - 45.45 baud (22 ms/bit)
 * - 1900 Hz = 1, 2100 Hz = 0
 * - Text starts with 0x20 0x2A and ends with 0x01
 * - Add 0x20 to get ASCII
 */

// Bit-reversal lookup table for 6-bit values
var bitRev = []uint8{
	0x00, 0x20, 0x10, 0x30, 0x08, 0x28, 0x18, 0x38,
	0x04, 0x24, 0x14, 0x34, 0x0c, 0x2c, 0x1c, 0x3c,
	0x02, 0x22, 0x12, 0x32, 0x0a, 0x2a, 0x1a, 0x3a,
	0x06, 0x26, 0x16, 0x36, 0x0e, 0x2e, 0x1e, 0x3e,
	0x01, 0x21, 0x11, 0x31, 0x09, 0x29, 0x19, 0x39,
	0x05, 0x25, 0x15, 0x35, 0x0d, 0x2d, 0x1d, 0x3d,
	0x03, 0x23, 0x13, 0x33, 0x0b, 0x2b, 0x1b, 0x3b,
	0x07, 0x27, 0x17, 0x37, 0x0f, 0x2f, 0x1f, 0x3f,
}

// FSKDecoder decodes FSK callsign transmissions
type FSKDecoder struct {
	sampleRate  float64
	headerShift int
	fftSize     int
}

// NewFSKDecoder creates a new FSK ID decoder
func NewFSKDecoder(sampleRate float64, headerShift int) *FSKDecoder {
	return &FSKDecoder{
		sampleRate:  sampleRate,
		headerShift: headerShift,
		fftSize:     2048,
	}
}

// DecodeFSKID attempts to decode an FSK callsign transmission
// Returns the decoded callsign string
func (f *FSKDecoder) DecodeFSKID(pcmBuffer *SlidingPCMBuffer) string {
	// Bit duration: 22ms (45.45 baud) - slowrx fsk.c:40-41
	// At 44.1kHz: 970 samples, at 12kHz: ~264 samples
	samps22ms := int(f.sampleRate * 22e-3)
	samps11ms := samps22ms / 2 // Half for initial sync search (485 samples at 44.1kHz)

	// Create 22ms Hann window (slowrx fsk.c:41)
	hannWindow := make([]float64, samps22ms)
	for i := 0; i < samps22ms; i++ {
		hannWindow[i] = 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(samps22ms-1)))
	}

	// FFT buffers
	fftInput := make([]float64, f.fftSize)
	fftOutput := make([]complex128, f.fftSize)

	// State
	inSync := false
	testBits := make([]uint8, 24)
	testPtr := 0
	asciiByte := uint8(0)
	bitPtr := 0
	bytePtr := 0
	fskID := make([]byte, 10)

	// Bin indices for FSK detection (slowrx fsk.c:61-63)
	loBin := f.getBin(1900.0 + float64(f.headerShift) - 1)
	midBin := f.getBin(2000.0 + float64(f.headerShift))
	hiBin := f.getBin(2100.0 + float64(f.headerShift) + 1)

	log.Printf("[SSTV FSK] Starting FSK ID detection")

	for {
		// Determine how many samples to advance (slowrx fsk.c:46, 56)
		samplesNeeded := samps22ms
		if !inSync {
			samplesNeeded = samps11ms
		}

		// Wait for enough samples with timeout (slowrx blocks on readPcm)
		// We need to wait since audio is still streaming in the main loop
		maxWaits := 50 // 50 * 100ms = 5 seconds max wait
		for i := 0; i < maxWaits && pcmBuffer.Available() < samps22ms; i++ {
			time.Sleep(100 * time.Millisecond)
		}

		if pcmBuffer.Available() < samps22ms {
			log.Printf("[SSTV FSK] Timeout waiting for samples (available: %d, needed: %d)",
				pcmBuffer.Available(), samps22ms)
			break
		}

		// Get window for FFT centered at WindowPtr
		// slowrx fsk.c:54: pcm.Buffer[pcm.WindowPtr+i-485]
		// This means window goes from [WindowPtr-485] to [WindowPtr-485+970]
		// Which is centered at WindowPtr-485+485 = WindowPtr
		samples, err := pcmBuffer.GetWindow(-samps11ms, samps22ms)
		if err != nil {
			log.Printf("[SSTV FSK] Error getting window: %v", err)
			break
		}

		// Apply Hann window
		for i := 0; i < f.fftSize; i++ {
			fftInput[i] = 0
		}

		for i := 0; i < samps22ms && i < len(fftInput); i++ {
			fftInput[i] = float64(samples[i]) / 32768.0 * hannWindow[i]
		}

		// Perform FFT
		fft(fftInput, fftOutput)

		// Calculate power in low and high FSK bands
		loPow := 0.0
		hiPow := 0.0

		for i := loBin; i <= hiBin && i < len(fftOutput); i++ {
			power := real(fftOutput[i])*real(fftOutput[i]) + imag(fftOutput[i])*imag(fftOutput[i])
			if i < midBin {
				loPow += power
			} else {
				hiPow += power
			}
		}

		// Decode bit: 1900 Hz = 1, 2100 Hz = 0 (slowrx fsk.c:73)
		var bit uint8
		if loPow > hiPow {
			bit = 1
		} else {
			bit = 0
		}

		// Advance window (slowrx fsk.c:56: pcm.WindowPtr += (InSync ? 970 : 485))
		pcmBuffer.AdvanceWindow(samplesNeeded)

		if !inSync {
			// Wait for sync pattern: 0x20 0x2A (slowrx fsk.c:77-89)
			testBits[testPtr%24] = bit

			// Check for sync pattern (slowrx fsk.c:81-82)
			testNum := 0
			for i := 0; i < 12; i++ {
				tp := (testPtr - (23 - i*2)) % 24
				if tp < 0 {
					tp += 24
				}
				if tp >= 0 && tp < 24 {
					testNum |= int(testBits[tp]) << (11 - i)
				}
			}

			// Check if we have the sync pattern (slowrx fsk.c:84)
			byte1 := bitRev[(testNum>>6)&0x3f]
			byte2 := bitRev[testNum&0x3f]

			if byte1 == 0x20 && byte2 == 0x2a {
				log.Printf("[SSTV FSK] Sync pattern detected")
				inSync = true
				asciiByte = 0
				bitPtr = 0
				bytePtr = 0
			}

			testPtr++
			// slowrx fsk.c:91 - timeout after 200 iterations (~2.2 seconds)
			// Increase slightly to account for slower sample arrival in streaming mode
			if testPtr > 300 {
				log.Printf("[SSTV FSK] Timeout searching for sync pattern")
				break
			}
		} else {
			// Decode data bits (slowrx fsk.c:95-103)
			asciiByte |= bit << bitPtr
			bitPtr++

			if bitPtr == 6 {
				// Complete byte received (slowrx fsk.c:98-102)
				if asciiByte < 0x0d || bytePtr > 9 {
					break
				}

				fskID[bytePtr] = asciiByte + 0x20
				bytePtr++
				bitPtr = 0
				asciiByte = 0
			}
		}
	}

	// Null-terminate and convert to string
	result := string(fskID[:bytePtr])

	if result != "" {
		log.Printf("[SSTV FSK] Decoded callsign: %s", result)
	} else {
		log.Printf("[SSTV FSK] No FSK ID detected")
	}

	return result
}

// getBin converts a frequency to an FFT bin index
func (f *FSKDecoder) getBin(freq float64) int {
	return int(freq / f.sampleRate * float64(f.fftSize))
}
