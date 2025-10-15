// FT8 Protocol Constants
// Based on WSJT-X FT8 specification

// FT8 LDPC code parameters
const FTX_LDPC_N = 174;  // Codeword length
const FTX_LDPC_M = 83;   // Number of parity checks
const FTX_LDPC_K = 91;   // Information bits (174 - 83)

// FT8 timing constants
const FT8_SYMBOL_PERIOD = 0.16;  // 160 ms per symbol
const FT8_SYMBOL_COUNT = 79;     // 79 symbols total
const FT8_TRANSMISSION_DURATION = 12.64;  // seconds
const FT8_SLOT_DURATION = 15.0;  // 15 second time slots

// FT8 frequency constants
const FT8_TONE_SPACING = 6.25;   // Hz between tones
const FT8_NUM_TONES = 8;         // 8-FSK modulation
const FT8_BANDWIDTH = 50;        // Hz occupied bandwidth

// Costas sync arrays (7 symbols each at start and end)
const FT8_COSTAS_PATTERN = [3, 1, 4, 0, 6, 5, 2];

// LDPC parity check matrix - Nm (check node to variable node connections)
// Each row represents a check equation, listing which variable nodes participate
// Simplified version - in production, use full 83x7 matrix from WSJT-X
const kFTX_LDPC_Num_rows = new Uint8Array([
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7
]);

// LDPC Nm matrix - simplified placeholder
// In production, this would be the full sparse matrix from WSJT-X
// Format: kFTX_LDPC_Nm[check_node][connection_index] = variable_node + 1
const kFTX_LDPC_Nm = [];
for (let i = 0; i < FTX_LDPC_M; i++) {
    kFTX_LDPC_Nm[i] = new Uint8Array(7);
    // Placeholder pattern - would need actual FT8 matrix
    for (let j = 0; j < 7; j++) {
        kFTX_LDPC_Nm[i][j] = ((i * 7 + j) % FTX_LDPC_N) + 1;
    }
}

// LDPC Mn matrix - variable node to check node connections
// Format: kFTX_LDPC_Mn[variable_node][connection_index] = check_node + 1
const kFTX_LDPC_Mn = [];
for (let i = 0; i < FTX_LDPC_N; i++) {
    kFTX_LDPC_Mn[i] = new Uint8Array(3);
    // Placeholder pattern - would need actual FT8 matrix
    for (let j = 0; j < 3; j++) {
        kFTX_LDPC_Mn[i][j] = ((i * 3 + j) % FTX_LDPC_M) + 1;
    }
}

// Export constants to global scope for browser use
window.FTX_LDPC_N = FTX_LDPC_N;
window.FTX_LDPC_M = FTX_LDPC_M;
window.FTX_LDPC_K = FTX_LDPC_K;
window.FT8_SYMBOL_PERIOD = FT8_SYMBOL_PERIOD;
window.FT8_SYMBOL_COUNT = FT8_SYMBOL_COUNT;
window.FT8_TRANSMISSION_DURATION = FT8_TRANSMISSION_DURATION;
window.FT8_SLOT_DURATION = FT8_SLOT_DURATION;
window.FT8_TONE_SPACING = FT8_TONE_SPACING;
window.FT8_NUM_TONES = FT8_NUM_TONES;
window.FT8_BANDWIDTH = FT8_BANDWIDTH;
window.FT8_COSTAS_PATTERN = FT8_COSTAS_PATTERN;
window.kFTX_LDPC_Num_rows = kFTX_LDPC_Num_rows;
window.kFTX_LDPC_Nm = kFTX_LDPC_Nm;
window.kFTX_LDPC_Mn = kFTX_LDPC_Mn;

// Also support module exports for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        FTX_LDPC_N,
        FTX_LDPC_M,
        FTX_LDPC_K,
        FT8_SYMBOL_PERIOD,
        FT8_SYMBOL_COUNT,
        FT8_TRANSMISSION_DURATION,
        FT8_SLOT_DURATION,
        FT8_TONE_SPACING,
        FT8_NUM_TONES,
        FT8_BANDWIDTH,
        FT8_COSTAS_PATTERN,
        kFTX_LDPC_Num_rows,
        kFTX_LDPC_Nm,
        kFTX_LDPC_Mn
    };
}