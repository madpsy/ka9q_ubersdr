// Yaesu CAT Protocol Implementation
// Supports FT-991A, FT-710, FTDX10, FTDX101D, FT-818, and other Yaesu radios using CAT commands

class YaesuCATProtocol {
    constructor() {
        this.name = 'Yaesu CAT';
        this.commandTerminator = ';';
        this.responseBuffer = '';
        
        // Mode mappings (Yaesu CAT to Hamlib)
        // Map radio responses to SDR mode names
        this.modeMap = {
            '1': 'LSB',
            '2': 'USB',
            '3': 'CWU',     // CW-USB (changed from 'CW' to 'CWU')
            '4': 'FM',
            '5': 'AM',
            '6': 'RTTY',
            '7': 'CWL',     // CW-LSB (changed from 'CWR' to 'CWL')
            '8': 'PKTLSB',
            '9': 'RTTYR',
            'A': 'PKTFM',
            'B': 'FMN',
            'C': 'PKTUSB',
            'D': 'AMN'
        };
        
        // Reverse mode map (Hamlib to Yaesu CAT)
        this.reverseModeMap = {};
        for (const [key, value] of Object.entries(this.modeMap)) {
            this.reverseModeMap[value] = key;
        }

        // Add aliases for legacy mode names
        this.reverseModeMap['CW'] = '3';   // CW is an alias for CWU
        this.reverseModeMap['CWR'] = '7';  // CWR is an alias for CWL

        // Add alias for NFM to use FM
        this.reverseModeMap['NFM'] = '4';  // NFM uses FM mode
    }
    
    /**
     * Format frequency for Yaesu CAT command
     * @param {number} hz - Frequency in Hz
     * @returns {string} - Formatted frequency string (9 digits, padded with zeros)
     */
    formatFrequency(hz) {
        // Yaesu uses 9-digit frequency in Hz, zero-padded
        // Example: 14074000 Hz -> "014074000"
        return hz.toString().padStart(9, '0');
    }
    
    /**
     * Parse frequency from Yaesu CAT response
     * @param {string} freqStr - 9-digit frequency string
     * @returns {number} - Frequency in Hz
     */
    parseFrequency(freqStr) {
        return parseInt(freqStr, 10);
    }
    
    /**
     * Format mode for Yaesu CAT command
     * @param {string} mode - Mode string (USB, LSB, CW, etc.)
     * @returns {string} - Single character mode code
     */
    formatMode(mode) {
        const modeUpper = mode.toUpperCase();
        const modeCode = this.reverseModeMap[modeUpper];
        return modeCode || '2'; // Default to USB
    }
    
    /**
     * Parse mode from Yaesu CAT response
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
        return `MD0${modeChar}${this.commandTerminator}`;
    }
    
    /**
     * Build command to get mode
     * @returns {string} - CAT command
     */
    buildGetModeCommand() {
        return `MD0${this.commandTerminator}`;
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
     * @returns {string} - CAT command
     */
    buildGetTXStatusCommand() {
        return `TX${this.commandTerminator}`;
    }
    
    /**
     * Parse response data
     * @param {Uint8Array} data - Raw response data
     * @returns {Object|null} - Parsed response or null
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
                responses.push(this.parseCommand(response));
            }
        }

        return responses.length > 0 ? responses : null;
    }
    
    /**
     * Parse individual command response
     * @param {string} response - Response string without terminator
     * @returns {Object} - Parsed command data
     */
    parseCommand(response) {
        const command = response.substring(0, 2);
        const data = response.substring(2);
        
        switch (command) {
            case 'FA': // VFO-A frequency
            case 'FB': // VFO-B frequency
                return {
                    type: 'frequency',
                    vfo: command === 'FA' ? 'A' : 'B',
                    frequency: this.parseFrequency(data)
                };
                
            case 'MD': // Mode
                // MD0x format where x is mode character
                if (data.length >= 2) {
                    const vfo = data[0]; // 0 = VFO-A, 1 = VFO-B
                    const modeChar = data[1];
                    return {
                        type: 'mode',
                        vfo: vfo === '0' ? 'A' : 'B',
                        mode: this.parseMode(modeChar)
                    };
                }
                break;
                
            case 'IF': // Transceiver status
                return this.parseIFResponse(data);
                
            case 'TX': // TX status
                // TX0 = RX, TX1 = TX, TX2 = TX (tune)
                return {
                    type: 'tx_status',
                    transmitting: data === '1' || data === '2'
                };
                
            case 'PS': // Power status
                // PS0 = off, PS1 = on
                return {
                    type: 'power',
                    on: data === '1'
                };
                
            default:
                return {
                    type: 'unknown',
                    command: command,
                    data: data
                };
        }
        
        return null;
    }
    
    /**
     * Parse IF (transceiver status) response
     * IF response format (27-28 bytes):
     * IFaaaaaaaaaa±bbbbbrxcdefghijklmn;
     * a: VFO-A frequency (11 digits)
     * b: Clarifier offset (5 digits with sign)
     * r: RIT on/off (0/1)
     * x: XIT on/off (0/1)
     * c: Memory channel (3 digits)
     * d: TX/RX (0=RX, 1=TX)
     * e: Mode (1 digit)
     * f: VFO/Memory (0=VFO, 1=Memory, 2=Memory Tune, 3=Quick Memory Bank)
     * g: Scan status (0=off, 1=on)
     * h: Split (0=off, 1=on)
     * i: Tone (0=off, 1=on)
     * j: Tone number (2 digits)
     * k: Shift (0=simplex, 1=+, 2=-)
     * l,m,n: Additional parameters
     */
    parseIFResponse(data) {
        if (data.length < 27) {
            return { type: 'error', message: `IF response too short (got ${data.length} chars, need 27+)` };
        }
        
        try {
            const frequency = this.parseFrequency(data.substring(0, 11));
            const clarifierOffset = parseInt(data.substring(11, 16), 10);
            const ritOn = data[16] === '1';
            const xitOn = data[17] === '1';
            const memoryChannel = parseInt(data.substring(18, 21), 10);
            const transmitting = data[21] === '1';
            const modeChar = data[22];
            const mode = this.parseMode(modeChar);
            const vfoMemory = data[23];
            const scanning = data[24] === '1';
            const split = data[25] === '1';
            
            return {
                type: 'status',
                frequency: frequency,
                clarifierOffset: clarifierOffset,
                ritOn: ritOn,
                xitOn: xitOn,
                memoryChannel: memoryChannel,
                transmitting: transmitting,
                mode: mode,
                vfoMemory: vfoMemory,
                scanning: scanning,
                split: split
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
    window.YaesuCATProtocol = YaesuCATProtocol;
}