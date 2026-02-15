package ft8

/*
 * FT8 Configuration
 * Protocol definitions and decoder configuration
 */

// Protocol represents FT8 or FT4
type Protocol int

const (
	ProtocolFT8 Protocol = iota
	ProtocolFT4
)

// FT8Config contains decoder configuration
type FT8Config struct {
	Protocol       Protocol // FT8 or FT4
	MinScore       int      // Minimum sync score threshold for candidates (0 = accept all)
	MaxCandidates  int      // Maximum number of candidates to decode per slot
	LDPCIterations int      // Number of LDPC decoder iterations
}

// DefaultFT8Config returns default configuration
func DefaultFT8Config() FT8Config {
	return FT8Config{
		Protocol:       ProtocolFT8,
		MinScore:       0,   // Minimum sync score (0 = accept all, reference uses 0)
		MaxCandidates:  140, // Max candidates per slot (reference uses 140)
		LDPCIterations: 25,  // LDPC iterations
	}
}

// Protocol constants
const (
	// FT8 timing
	FT8SlotTime    = 15.0  // seconds
	FT8SymbolTime  = 0.160 // seconds per symbol
	FT8SymbolCount = 79    // symbols per transmission

	// FT4 timing
	FT4SlotTime    = 7.5   // seconds
	FT4SymbolTime  = 0.048 // seconds per symbol
	FT4SymbolCount = 105   // symbols per transmission

	// Common parameters
	CostasLength = 7    // Costas array length
	FreqMin      = 100  // Hz - minimum frequency
	FreqMax      = 3100 // Hz - maximum frequency

	// Oversampling
	FreqOSR = 2 // Frequency oversampling rate
	TimeOSR = 2 // Time oversampling rate
)

// GetSlotTime returns the slot time for the protocol
func (p Protocol) GetSlotTime() float64 {
	if p == ProtocolFT4 {
		return FT4SlotTime
	}
	return FT8SlotTime
}

// GetSymbolTime returns the symbol time for the protocol
func (p Protocol) GetSymbolTime() float64 {
	if p == ProtocolFT4 {
		return FT4SymbolTime
	}
	return FT8SymbolTime
}

// GetSymbolCount returns the number of symbols for the protocol
func (p Protocol) GetSymbolCount() int {
	if p == ProtocolFT4 {
		return FT4SymbolCount
	}
	return FT8SymbolCount
}

// String returns the protocol name
func (p Protocol) String() string {
	if p == ProtocolFT4 {
		return "FT4"
	}
	return "FT8"
}
