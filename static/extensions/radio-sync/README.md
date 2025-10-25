# Radio Sync Extension

Synchronize frequency and mode between UberSDR and external radios via Chrome's Web Serial API.

## Features

- **LED-Style Frequency Display**: 7-segment LED display showing current frequency
- **Mode Indicator**: Visual display of current operating mode (USB, LSB, CW, etc.)
- **TX/RX State**: LED indicators showing transmit/receive state
- **Bidirectional Sync**: Sync from SDR to radio, radio to SDR, or both ways
- **Multiple Radio Support**: Pre-configured for popular amateur radio transceivers

## Supported Radios

### Icom (CI-V Protocol)
- IC-7300 (19200 baud, CI-V address 0x94)
- IC-7610 (19200 baud, CI-V address 0x98)
- IC-9700 (19200 baud, CI-V address 0xA2)
- IC-705 (19200 baud, CI-V address 0xA4)

### Yaesu (CAT Protocol)
- FT-991A (38400 baud)
- FT-710 (38400 baud)
- FTDX10 (38400 baud)
- FTDX101D (38400 baud) ✅ **Fully Implemented**
- FT-818 (38400 baud)

### Kenwood (CAT Protocol)
- TS-590SG (115200 baud)
- TS-890S (115200 baud)
- TS-480 (57600 baud)

### Elecraft
- K3 (38400 baud)
- K4 (38400 baud)
- KX3 (38400 baud)
- KX2 (38400 baud)

### Other
- Xiegu G90 (19200 baud, CI-V compatible)
- Xiegu X6100 (19200 baud, CI-V compatible)

## Requirements

- **Chrome or Edge Browser**: Web Serial API is required
- **Serial Connection**: USB cable or serial adapter to connect radio to computer
- **Radio CAT Interface**: Radio must have CAT/CI-V control enabled

## Usage

1. **Select Radio**: Choose your radio make/model from the dropdown
2. **Choose Sync Direction**:
   - **SDR → Radio**: SDR controls the radio
   - **Radio → SDR**: Radio controls the SDR
   - **Both Ways**: Bidirectional synchronization
3. **Connect**: Click "Connect to Radio" and select the serial port
4. **Monitor**: Watch the LED displays update with frequency, mode, and TX/RX state

## Current Implementation Status

### ✅ Implemented
- LED-style frequency display
- Mode display
- TX/RX state indicators
- Radio model selection
- Sync direction selection
- Serial port connection/disconnection
- SDR state monitoring (frequency and mode changes)
- Error handling for missing Web Serial API
- **Yaesu CAT Protocol (FTDX101D and compatible radios)**:
  - Set/Get frequency (FA command)
  - Set/Get mode (MD command)
  - Get full status (IF command)
  - Bidirectional sync (SDR ↔ Radio)
  - TX/RX state detection
  - Protocol handler architecture for easy extension

### 🚧 To Be Implemented
- Additional protocol implementations:
  - Icom CI-V protocol encoding/decoding
  - Kenwood CAT command formatting
  - Elecraft protocol support
- Automatic reconnection on disconnect
- Serial port settings persistence
- Polling interval configuration
- Command queue management for high-speed operation

## Development Notes

The extension now has full Yaesu CAT protocol support for radios like the FTDX101D. It can:
- Send frequency and mode changes from SDR to radio
- Receive frequency and mode changes from radio to SDR
- Display TX/RX state from the radio
- Provide bidirectional synchronization

The protocol handler architecture makes it easy to add support for other radio protocols.

### Adding Protocol Support

To add support for additional radio protocols, create a new protocol handler in the `protocols/` directory following the pattern of [`protocols/yaesu-cat.js`](protocols/yaesu-cat.js):

1. Create a protocol class (e.g., `IcomCIVProtocol`)
2. Implement these methods:
   - `buildSetFrequencyCommand(hz)` - Build command to set frequency
   - `buildGetFrequencyCommand()` - Build command to get frequency
   - `buildSetModeCommand(mode)` - Build command to set mode
   - `buildGetModeCommand()` - Build command to get mode
   - `parseResponse(data)` - Parse incoming serial data
3. Add the protocol file to `manifest.json` scripts array
4. Update `main.js` to instantiate your protocol handler

Example protocol files to add:
- `protocols/icom-civ.js` - Icom CI-V protocol (binary protocol)
- `protocols/kenwood-cat.js` - Kenwood CAT protocol (similar to Yaesu)
- `protocols/elecraft.js` - Elecraft protocol

## Browser Compatibility

This extension requires the Web Serial API, which is available in:
- Chrome 89+
- Edge 89+
- Opera 75+

**Not supported in:**
- Firefox (no Web Serial API support)
- Safari (no Web Serial API support)

## Security Note

The Web Serial API requires user permission to access serial ports. The browser will prompt for permission when you click "Connect to Radio". This is a security feature to prevent unauthorized access to hardware.

## Troubleshooting

### "Web Serial API Not Available"
- Use Chrome or Edge browser
- Ensure you're not using Firefox or Safari
- Check that your browser is up to date

### "Connection Failed"
- Verify the radio is powered on
- Check USB cable connection
- Ensure correct baud rate for your radio model
- Check that no other software is using the serial port

### "No Response from Radio"
- Verify CAT/CI-V is enabled in radio settings
- Check CI-V address matches radio configuration (for Icom radios)
- Verify baud rate matches radio settings
- Try disconnecting and reconnecting

## License

Part of the UberSDR project.