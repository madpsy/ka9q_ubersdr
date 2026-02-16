# Multi-Channel Morse Decoder Protocol

## Overview

The multi-channel decoder can track up to 5 simultaneous CW signals. Each message is tagged with a decoder ID (0-4) so the frontend can distinguish between different streams.

## Message Format

All messages include a decoder ID in the second byte:

```
[type:1][decoder_id:1][...message-specific data...]
```

## Message Types

### 0x01 - Text Message
```
[type:1][decoder_id:1][timestamp:8][text_length:4][text:length]
```

**Fields:**
- `type`: 0x01
- `decoder_id`: 0-4 (which decoder produced this text)
- `timestamp`: Unix timestamp (big-endian uint64)
- `text_length`: Length of text in bytes (big-endian uint32)
- `text`: UTF-8 encoded decoded text

**Example:** Decoder 2 decoded "CQ"
```
01 02 00000000 65F3A1C0 00000002 4351
```

### 0x02 - Morse Elements
```
[type:1][decoder_id:1][timestamp:8][morse_length:4][morse:length]
```

**Fields:**
- `type`: 0x02
- `decoder_id`: 0-4 (which decoder produced these elements)
- `timestamp`: Unix timestamp (big-endian uint64)
- `morse_length`: Length of morse string in bytes (big-endian uint32)
- `morse`: Morse elements (`.` `-` ` ` `/`)

**Example:** Decoder 0 received ".-. ..."
```
02 00 00000000 65F3A1C0 00000007 2E2D2E20 2E2E2E
```

### 0x03 - WPM Update
```
[type:1][decoder_id:1][wpm:8]
```

**Fields:**
- `type`: 0x03
- `decoder_id`: 0-4 (which decoder's WPM)
- `wpm`: Words per minute (float64, big-endian)

**Example:** Decoder 1 at 18.5 WPM
```
03 01 4032 8000 0000 0000
```

### 0x04 - Decoder Assignment
```
[type:1][decoder_id:1][frequency:8][active:1]
```

**Fields:**
- `type`: 0x04
- `decoder_id`: 0-4 (which decoder slot)
- `frequency`: Center frequency in Hz (float64, big-endian)
- `active`: 1 = decoder assigned to this frequency, 0 = decoder removed

**Example:** Decoder 3 assigned to 1250 Hz
```
04 03 4093 9000 0000 0000 01
```

**Example:** Decoder 3 removed
```
04 03 4093 9000 0000 0000 00
```

### 0x05 - Status Update
```
[type:1][num_active:1][decoder_data...]
```

**Fields:**
- `type`: 0x05
- `num_active`: Number of active decoders (0-5)
- `decoder_data`: For each active decoder: `[id:1][frequency:8][wpm:8]`

**Example:** 2 active decoders
```
05 02 
  00 4082 0000 0000 0000 4030 0000 0000 0000  // Decoder 0: 600 Hz, 16 WPM
  02 4093 9000 0000 0000 4032 8000 0000 0000  // Decoder 2: 1250 Hz, 18.5 WPM
```

## Frontend Implementation

### JavaScript Example

```javascript
dxWebSocket.onmessage = (event) => {
    if (typeof event.data === 'string') {
        // Text control messages
        const msg = JSON.parse(event.data);
        handleControlMessage(msg);
    } else {
        // Binary decoder output
        const view = new DataView(event.data);
        const type = view.getUint8(0);
        const decoderId = view.getUint8(1);
        
        switch (type) {
            case 0x01: // Text message
                const timestamp = view.getBigUint64(2, false);
                const textLen = view.getUint32(10, false);
                const text = new TextDecoder().decode(
                    new Uint8Array(event.data, 14, textLen)
                );
                displayText(decoderId, text);
                break;
                
            case 0x02: // Morse elements
                const morseLen = view.getUint32(10, false);
                const morse = new TextDecoder().decode(
                    new Uint8Array(event.data, 14, morseLen)
                );
                displayMorse(decoderId, morse);
                break;
                
            case 0x03: // WPM update
                const wpm = view.getFloat64(2, false);
                updateWPM(decoderId, wpm);
                break;
                
            case 0x04: // Decoder assignment
                const freq = view.getFloat64(2, false);
                const active = view.getUint8(10);
                if (active) {
                    createDecoderDisplay(decoderId, freq);
                } else {
                    removeDecoderDisplay(decoderId);
                }
                break;
                
            case 0x05: // Status update
                const numActive = view.getUint8(1);
                let offset = 2;
                for (let i = 0; i < numActive; i++) {
                    const id = view.getUint8(offset);
                    const freq = view.getFloat64(offset + 1, false);
                    const wpm = view.getFloat64(offset + 9, false);
                    updateDecoderStatus(id, freq, wpm);
                    offset += 17;
                }
                break;
        }
    }
};
```

### Display Organization

Recommended frontend layout:

```
┌─────────────────────────────────────────┐
│ Morse Decoder (5 channels)              │
├─────────────────────────────────────────┤
│ Decoder 0 │ 550 Hz │ 20 WPM │ Active   │
│ CQ CQ DE W1ABC W1ABC K                  │
│ -.-. --.- -.-. --.- -.. .               │
├─────────────────────────────────────────┤
│ Decoder 1 │ 750 Hz │ 15 WPM │ Active   │
│ QRZ?                                     │
│ --.- .-. --.. ..--..                    │
├─────────────────────────────────────────┤
│ Decoder 2 │ 1200 Hz │ 25 WPM │ Active  │
│ 73 ES GL                                 │
│ --... ...-- . ... --. .-..              │
├─────────────────────────────────────────┤
│ Decoder 3 │ Idle                        │
├─────────────────────────────────────────┤
│ Decoder 4 │ Idle                        │
└─────────────────────────────────────────┘
```

## Benefits

1. **Clear Stream Identification**: Each message tagged with decoder ID
2. **Independent Tracking**: Frontend can maintain separate buffers per decoder
3. **Frequency Display**: Know which frequency each decoder is monitoring
4. **Dynamic Updates**: Real-time notification when decoders assigned/removed
5. **Status Monitoring**: Periodic status updates show all active decoders
