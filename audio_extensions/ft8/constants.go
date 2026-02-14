package ft8

/*
 * FT8/FT4 Constants
 * Based on ft8_lib by Karlis Goba (YL3JG)
 */

// FT8 symbol structure: S D1 S D2 S
// S  - sync block (7 symbols of Costas pattern)
// D1 - first data block (29 symbols each encoding 3 bits)
// D2 - second data block (29 symbols each encoding 3 bits)
const (
	FT8_ND          = 58 // Data symbols
	FT8_NN          = 79 // Total channel symbols
	FT8_LENGTH_SYNC = 7  // Length of each sync group
	FT8_NUM_SYNC    = 3  // Number of sync groups
	FT8_SYNC_OFFSET = 36 // Offset between sync groups
)

// FT4 symbol structure: R Sa D1 Sb D2 Sc D3 Sd R
// R  - ramping symbol (no payload information)
// Sx - one of four different sync blocks (4 symbols of Costas pattern)
// Dy - data block (29 symbols each encoding 2 bits)
const (
	FT4_ND          = 87  // Data symbols
	FT4_NR          = 2   // Ramp symbols (beginning + end)
	FT4_NN          = 105 // Total channel symbols
	FT4_LENGTH_SYNC = 4   // Length of each sync group
	FT4_NUM_SYNC    = 4   // Number of sync groups
	FT4_SYNC_OFFSET = 33  // Offset between sync groups
)

// LDPC parameters
const (
	FTX_LDPC_N       = 174                  // Number of bits in encoded message
	FTX_LDPC_K       = 91                   // Number of payload bits (including CRC)
	FTX_LDPC_M       = 83                   // Number of LDPC checksum bits
	FTX_LDPC_N_BYTES = (FTX_LDPC_N + 7) / 8 // Bytes needed for 174 bits
	FTX_LDPC_K_BYTES = (FTX_LDPC_K + 7) / 8 // Bytes needed for 91 bits
)

// CRC parameters
const (
	FT8_CRC_POLYNOMIAL = 0x2757 // CRC-14 polynomial without leading 1
	FT8_CRC_WIDTH      = 14
)

// Costas 7x7 tone pattern for FT8 synchronization
var FT8_Costas_pattern = [7]uint8{3, 1, 4, 0, 6, 5, 2}

// Costas 4x4 tone patterns for FT4 synchronization (4 different patterns)
var FT4_Costas_pattern = [4][4]uint8{
	{0, 1, 3, 2},
	{1, 0, 2, 3},
	{2, 3, 1, 0},
	{3, 2, 0, 1},
}

// Gray code map to encode 8 symbols (tones) for FT8
var FT8_Gray_map = [8]uint8{0, 1, 3, 2, 5, 6, 4, 7}

// Gray code map to encode 4 symbols (tones) for FT4
var FT4_Gray_map = [4]uint8{0, 1, 3, 2}

// FT4 XOR sequence for data scrambling
var FT4_XOR_sequence = [10]uint8{0, 0, 0, 1, 1, 0, 0, 1, 0, 1}
