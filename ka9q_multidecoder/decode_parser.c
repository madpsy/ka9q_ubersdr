// Decoder output parser implementation
#define _GNU_SOURCE 1
#include "decode_parser.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>
#include <time.h>

// Check if string looks like a callsign
bool is_callsign(const char *str) {
    if (!str || !*str)
        return false;
    
    // Skip special words
    if (strcmp(str, "CQ") == 0 || strcmp(str, "RRR") == 0 ||
        strcmp(str, "RR73") == 0 || strcmp(str, "73") == 0 ||
        strcmp(str, "TNX") == 0 || strcmp(str, "TU") == 0 ||
        strcmp(str, "DX") == 0)
        return false;
    
    // Skip hash table entries (unresolved callsigns shown as <...>)
    // These appear in WSPR and should not be reported
    if (str[0] == '<' && str[strlen(str)-1] == '>')
        return false;
    
    // Skip if starts with special characters
    if (str[0] == '<' || str[0] == '+' || str[0] == '-' ||
        str[0] == 'R' && (str[1] == '+' || str[1] == '-'))
        return false;
    
    // Must have at least one letter and one number for most callsigns
    bool has_letter = false;
    bool has_digit = false;
    
    for (const char *p = str; *p; p++) {
        if (isalpha(*p))
            has_letter = true;
        if (isdigit(*p))
            has_digit = true;
    }
    
    return has_letter && (has_digit || strlen(str) <= 3);
}

// Check if string looks like a grid locator
bool is_grid_locator(const char *str) {
    if (!str)
        return false;
    
    size_t len = strlen(str);
    if (len != 4 && len != 6 && len != 8)
        return false;
    
    // Exclude common non-grid patterns
    if (strcmp(str, "RR73") == 0 || strcmp(str, "RRR") == 0 || strcmp(str, "73") == 0)
        return false;
    
    // Format: AA00 or AA00aa or AA00aa00
    if (!isupper(str[0]) || !isupper(str[1]) || !isdigit(str[2]) || !isdigit(str[3]))
        return false;
    
    // First two characters should be A-R (valid Maidenhead)
    if (str[0] < 'A' || str[0] > 'R' || str[1] < 'A' || str[1] > 'R')
        return false;
    
    if (len >= 6 && (!isalpha(str[4]) || !isalpha(str[5])))
        return false;
    
    if (len == 8 && (!isdigit(str[6]) || !isdigit(str[7])))
        return false;
    
    return true;
}

// Extract callsign and locator from FT8/FT4 message
bool extract_callsign_locator(const char *message, char *callsign, char *locator) {
    if (!message || !callsign || !locator)
        return false;
    
    callsign[0] = '\0';
    locator[0] = '\0';
    
    // Parse message into words
    char msg_copy[MAX_MESSAGE_LEN];
    strncpy(msg_copy, message, sizeof(msg_copy) - 1);
    msg_copy[sizeof(msg_copy) - 1] = '\0';
    
    char *words[16];
    int word_count = 0;
    char *token = strtok(msg_copy, " ");
    
    while (token && word_count < 16) {
        words[word_count++] = token;
        token = strtok(NULL, " ");
    }
    
    if (word_count == 0)
        return false;
    
    // Handle CQ messages: CQ [DX] CALL [GRID]
    if (strcmp(words[0], "CQ") == 0) {
        int idx = (word_count > 2 && strcmp(words[1], "DX") == 0) ? 2 : 1;
        if (idx < word_count && is_callsign(words[idx])) {
            strncpy(callsign, words[idx], MAX_CALLSIGN_LEN - 1);
            // Look for grid after callsign
            if (idx + 1 < word_count && is_grid_locator(words[idx + 1])) {
                strncpy(locator, words[idx + 1], MAX_LOCATOR_LEN - 1);
            }
            return true;
        }
    }
    
    // Standard QSO: CALL1 CALL2 [GRID|REPORT|RRR|73]
    // Report the first callsign (the transmitter) - matches Python logic
    if (is_callsign(words[0])) {
        strncpy(callsign, words[0], MAX_CALLSIGN_LEN - 1);
        // Look for grid locator in remaining parts
        for (int i = 1; i < word_count; i++) {
            if (is_grid_locator(words[i])) {
                strncpy(locator, words[i], MAX_LOCATOR_LEN - 1);
                break;
            }
        }
        return true;
    }
    
    return false;
}

// Parse FT8/FT4 decoder output line
bool parse_ft8_line(const char *line, uint64_t dial_freq, struct decode_info *info) {
    if (!line || !info)
        return false;
    
    memset(info, 0, sizeof(*info));
    
    // Skip empty lines and decoder metadata
    if (line[0] == '\n' || strstr(line, "<DecodeFinished>") || strstr(line, "EOF on input"))
        return false;
    
    // Skip lines that start with **** (invalid/noise decodes)
    const char *p = line;
    while (*p && isspace(*p)) p++;
    if (strncmp(p, "****", 4) == 0)
        return false;
    
    // Format for FT8: HHMMSS  SNR  DT  Freq  [~]  Message
    // Format for FT4: HHMMSS  SNR  DT  Freq  [+/-]  Message
    // Example FT8: 203530   2  0.1 2535 ~  EI3CTB RT6C -16
    // Example FT4: 000000  10 -0.1 1498 +  OH3DJP EA3HSD +08
    int time_val, snr, audio_freq;
    float dt;
    char message[MAX_MESSAGE_LEN];
    
    // Try to parse the line
    int n = sscanf(line, "%d %d %f %d", &time_val, &snr, &dt, &audio_freq);
    if (n < 4)
        return false;
    
    // Find the message part (after the frequency and quality indicator)
    // Need to skip 5 fields: time, snr, dt, freq, quality_indicator
    const char *msg_start = line;
    int field_count = 0;
    while (*msg_start && field_count < 5) {
        while (*msg_start && isspace(*msg_start))
            msg_start++;
        while (*msg_start && !isspace(*msg_start))
            msg_start++;
        field_count++;
    }
    
    // Skip any remaining whitespace to get to message
    while (*msg_start && isspace(*msg_start))
        msg_start++;
    
    if (!*msg_start)
        return false;
    
    strncpy(message, msg_start, sizeof(message) - 1);
    message[sizeof(message) - 1] = '\0';
    
    // Remove trailing whitespace
    char *end = message + strlen(message) - 1;
    while (end > message && isspace(*end))
        *end-- = '\0';
    
    // Skip FT4 partial decode lines (contain only $ symbols, no actual message)
    // These indicate signal detected but not decoded: $, $*, $#
    // Check if message is ONLY a $ symbol (possibly with * or #)
    if (message[0] == '$' && (message[1] == '\0' || message[1] == '*' || message[1] == '#')) {
        if (message[1] == '\0' || message[2] == '\0')
            return false;
    }
    
    // Fill in decode_info
    info->snr = snr;
    info->frequency = dial_freq + audio_freq;
    info->timestamp = time(NULL);
    strncpy(info->message, message, sizeof(info->message) - 1);
    
    // Extract callsign and locator
    info->has_callsign = extract_callsign_locator(message, info->callsign, info->locator);
    info->has_locator = (info->locator[0] != '\0');
    info->is_wspr = false;
    
    return info->has_callsign;
}

// Parse WSPR decoder output line
bool parse_wspr_line(const char *line, uint64_t dial_freq, struct decode_info *info) {
    if (!line || !info)
        return false;
    
    memset(info, 0, sizeof(*info));
    
    // Skip empty lines
    if (line[0] == '\n' || strstr(line, "EOF on input"))
        return false;
    
    // WSPR format from wsprd (with -f flag for dial frequency):
    // HHMM  SNR  DT  Freq  Drift  Call  Grid  dBm
    // Example: 1556 -10 -0.1 7.040000 0 DK2DB JN48 37
    // Note: NO date field, just time. DT is float seconds, Drift is integer Hz
    int time_val, snr, drift, dbm;
    float dt, tx_freq_mhz;
    char callsign[MAX_CALLSIGN_LEN];
    char locator[MAX_LOCATOR_LEN];
    
    int n = sscanf(line, "%d %d %f %f %d %15s %7s %d",
                   &time_val, &snr, &dt, &tx_freq_mhz, &drift,
                   callsign, locator, &dbm);
    
    if (n < 8)
        return false;
    
    // Fill in decode_info
    info->snr = snr;
    info->frequency = dial_freq;  // WSPR reports use dial frequency
    info->timestamp = time(NULL);
    info->dt = dt;
    info->drift = drift;
    info->dbm = dbm;
    info->tx_frequency = (uint64_t)(tx_freq_mhz * 1e6);
    
    strncpy(info->callsign, callsign, sizeof(info->callsign) - 1);
    strncpy(info->locator, locator, sizeof(info->locator) - 1);
    strcpy(info->mode, "WSPR");
    
    snprintf(info->message, sizeof(info->message), "%s %s %d", callsign, locator, dbm);
    
    info->has_callsign = true;
    info->has_locator = (locator[0] != '\0' && strcmp(locator, "----") != 0);
    info->is_wspr = true;
    
    return true;
}