// Decoder output parser for ka9q-multidecoder
// Parses jt9 and wsprd output to extract decode information
#ifndef _DECODE_PARSER_H
#define _DECODE_PARSER_H 1

#include <stdint.h>
#include <stdbool.h>
#include <time.h>

// Maximum lengths
#define MAX_CALLSIGN_LEN 16
#define MAX_LOCATOR_LEN 8
#define MAX_MESSAGE_LEN 64

// Decoded signal information
struct decode_info {
    // Common fields
    char callsign[MAX_CALLSIGN_LEN];
    char locator[MAX_LOCATOR_LEN];
    int snr;                    // dB
    uint64_t frequency;         // Hz (actual RF frequency)
    time_t timestamp;           // Unix timestamp
    char mode[8];               // FT8, FT4, WSPR
    char message[MAX_MESSAGE_LEN];
    
    // WSPR-specific fields
    float dt;                   // Time drift (seconds)
    int drift;                  // Frequency drift (Hz)
    int dbm;                    // Transmitter power (dBm)
    uint64_t tx_frequency;      // Transmitter frequency (Hz)
    
    // Validity flags
    bool has_callsign;
    bool has_locator;
    bool is_wspr;
};

// Parse FT8/FT4 decoder output line
// Format: HHMMSS  SNR  DT  Freq  [~]  Message
// Example: 203530   2  0.1 2535 ~  EI3CTB RT6C -16
bool parse_ft8_line(const char *line, uint64_t dial_freq, struct decode_info *info);

// Parse WSPR decoder output line  
// Format varies by wsprd version, typically:
// YYMMDD HHMM  SNR  DT  Freq  Drift  Call  Grid  dBm
bool parse_wspr_line(const char *line, uint64_t dial_freq, struct decode_info *info);

// Extract callsign and locator from FT8/FT4 message
// Returns true if callsign found
bool extract_callsign_locator(const char *message, char *callsign, char *locator);

// Check if string looks like a callsign
bool is_callsign(const char *str);

// Check if string looks like a grid locator
bool is_grid_locator(const char *str);

#endif // _DECODE_PARSER_H