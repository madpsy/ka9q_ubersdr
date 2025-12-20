// Kenwood CAT Protocol Implementation
// Supports TS-480, TS-590SG, TS-890S, and other Kenwood radios using CAT commands
// Based on Hamlib Kenwood backend implementation

class KenwoodCATProtocol {
    constructor() {
        this.name = 'Kenwood CAT';
        this.commandTerminator = ';';
        this.responseBuffer = '';
        
        // Mode mappings (Kenwood CAT to standard mode names)
        this.modeMap = {
            '1': 'LSB',
            '2': 'USB',
            '3': 'CW',
            '4': 'FM',
            '5': 'AM',
            '6': 'RTTY',    // FSK
            '7': 'CWR',
            '9': 'RTTYR'    // FSK-R
        };
        
        // Reverse mode map (standard to Kenwood CAT)
        this.reverseModeMap = {};
        for (const [key, value] of Object.entries(this.modeMap)) {
            this.reverseModeMap[value] = key;
        }
        
        // Add common aliases
        this.reverseModeMap['CWU'] = '3';  // CW-USB
        this.reverseModeMap['CWL'] = '7';  // CW-LSB
        this.reverseModeMap['NFM'] = '4';  // Use FM for NFM
    }
    
    /**
     * Format frequency for Kenwood CAT command
     * @param {number} hz - Frequency in Hz
     * @returns {string} - Formatted frequency string (11 digits, padded with zeros)
     */
    formatFrequency(hz) {
        // Kenwood uses 11-digit frequency in Hz, zero-padded
        // Example: 14074000 Hz -> "00014074000"
        return hz.toString().padStart(11, '0');
    }
    
    /**
     * Parse frequency from Kenwood CAT response
     * @param {string} freqStr - 11-digit frequency string
     * @returns {number} - Frequency in Hz
     */
    parseFrequency(freqStr) {
        return parseInt(freqStr, 10);
    }
    
    /**
     * Format mode for Kenwood CAT command
     * @param {string} mode - Mode string (USB, LSB, CW, etc.)
     * @returns {string} - Single character mode code
     */
    formatMode(mode) {
        const modeUpper = mode.toUpperCase();
        const modeCode = this.reverseModeMap[modeUpper];
        return modeCode || '2'; // Default to USB
    }
    
    /**
     * Parse mode from Kenwood CAT response
     * @param {string} modeChar - Single character mode code
     * @returns {string} - Mode string
     */
    parseMode(modeChar) {
        return this.modeMap[modeChar] || 'USB';
    }
    
    /**
     * Build command to set VFO-A frequency
     * @param {number} hz - Frequency in Hz
     * @returns {string} - CAT command
     */
    buildSetFrequencyCommand(hz) {
        return `FA${this.formatFrequency(hz)}${this.commandTerminator}`;
    }
    
    /**
     * Build command to get VFO-A frequency
     * @returns {string} - CAT command
     */
    buildGetFrequencyCommand() {
        return `FA${this.commandTerminator}`;
    }
    
    /**
     * Build command to set mode
     * @param {string} mode - Mode string
     * @returns {string} - CAT command
     */
    buildSetModeCommand(mode) {
        const modeChar = this.formatMode(mode);
        return `MD${modeChar}${this.commandTerminator}`;
    }
    
    /**
     * Build command to get mode
     * @returns {string} - CAT command
     */
    buildGetModeCommand() {
        return `MD${this.commandTerminator}`;
    }
    
    /**
     * Build command to get transceiver status (IF command)
     * Returns comprehensive status including freq, mode, TX/RX state
     * @returns {string} - CAT command
     */
    buildGetStatusCommand() {
        return `IF${this.commandTerminator}`;
    }
    
    /**
     * Build command to get TX status
     * For Kenwood, we use the IF command and parse the TX bit
     * @returns {string} - CAT command
     */
    buildGetTXStatusCommand() {
        return `IF${this.commandTerminator}`;
    }
    
    /**
     * Parse response data
     * @param {Uint8Array} data - Raw response data
     * @returns {Array|null} - Array of parsed responses or null
     */
    parseResponse(data) {
        // Convert Uint8Array to string
        const text = new TextDecoder().decode(data);
        this.responseBuffer += text;

        // Look for complete responses (terminated with semicolon)
        const responses = [];
        let semicolonIndex;

        while ((semicolonIndex = this.responseBuffer.indexOf(this.commandTerminator)) !== -1) {
            const response = this.responseBuffer.substring(0, semicolonIndex);
            this.responseBuffer = this.responseBuffer.substring(semicolonIndex + 1);

            if (response.length > 0) {
                const parsed = this.parseCommand(response);
                if (parsed) {
                    responses.push(parsed);
                }
            }
        }

        return responses.length > 0 ? responses : null;
    }
    
    /**
     * Parse individual command response
     * @param {string} response - Response string without terminator
     * @returns {Object|null} - Parsed command data
     */
    parseCommand(response) {
        const command = response.substring(0, 2);
        const data = response.substring(2);
        
        switch (command) {
            case 'FA': // VFO-A frequency
            case 'FB': // VFO-B frequency
                if (data.length >= 11) {
                    return {
                        type: 'frequency',
                        vfo: command === 'FA' ? 'A' : 'B',
                        frequency: this.parseFrequency(data.substring(0, 11))
                    };
                }
                break;
                
            case 'MD': // Mode
                if (data.length >= 1) {
                    return {
                        type: 'mode',
                        vfo: 'A',
                        mode: this.parseMode(data[0])
                    };
                }
                break;
                
            case 'IF': // Transceiver status
                return this.parseIFResponse(data);
                
            case 'PS': // Power status
                // PS0 = off, PS1 = on
                return {
                    type: 'power',
                    on: data === '1'
                };
                
            default:
                // Unknown command, return null
                return null;
        }
        
        return null;
    }
    
    /**
     * Parse IF (transceiver status) response
     * IF response format (38 characters):
     * IFaaaaaaaaaa±rrrrrsxcccmftttvvvvvvvvvvvvvvvvvvvv;
     * a: VFO-A frequency (11 digits)
     * ±: Sign of RIT/XIT offset
     * r: RIT/XIT offset (4 digits)
     * s: RIT on/off (0/1)
     * x: XIT on/off (0/1)
     * c: Memory channel (3 digits)
     * m: TX/RX (0=RX, 1=TX)
     * f: Mode (1 digit)
     * t: Function (VFO/Memory/etc)
     * v: Various other parameters
     */
    parseIFResponse(data) {
        if (data.length < 27) {
            return {
                type: 'error',
                message: `IF response too short (got ${data.length} chars, need 27+)`
            };
        }
        
        try {
            const frequency = this.parseFrequency(data.substring(0, 11));
            const ritSign = data[11];
            const ritOffset = parseInt(data.substring(12, 16), 10) * (ritSign === '-' ? -1 : 1);
            const ritOn = data[16] === '1';
            const xitOn = data[17] === '1';
            const memoryChannel = parseInt(data.substring(18, 21), 10);
            const transmitting = data[21] === '1';
            const modeChar = data[22];
            const mode = this.parseMode(modeChar);
            
            return {
                type: 'status',
                frequency: frequency,
                ritOffset: ritOffset,
                ritOn: ritOn,
                xitOn: xitOn,
                memoryChannel: memoryChannel,
                transmitting: transmitting,
                mode: mode
            };
        } catch (error) {
            return {
                type: 'error',
                message: `Failed to parse IF response: ${error.message}`
            };
        }
    }
    
    /**
     * Clear response buffer
     */
    clearBuffer() {
        this.responseBuffer = '';
    }
}

// Export for use in main.js
if (typeof window !== 'undefined') {
    window.KenwoodCATProtocol = KenwoodCATProtocol;
}