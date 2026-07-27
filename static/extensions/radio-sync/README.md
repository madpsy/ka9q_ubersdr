# Radio Sync Extension

Synchronize frequency and mode between UberSDR and external radios via Chrome's Web Serial API,
backed by [Hamlib](https://hamlib.github.io/) compiled to WebAssembly.

## Features

- **LED-Style Frequency Display**: 7-segment LED display showing current frequency
- **Mode Indicator**: Visual display of current operating mode (USB, LSB, CW, etc.)
- **TX/RX State**: LED indicators showing transmit/receive state
- **Bidirectional Sync**: Sync from SDR to radio, radio to SDR, or both ways
- **Every serial-capable Hamlib rig**: the radio dropdown is generated at runtime from the
  Hamlib WASM bundle's own capability list - whatever Hamlib supports over a serial port,
  this extension supports, with no per-radio code in this repo.

## How it works

This extension does not implement any radio protocol itself. It loads `hamlib.wasm` /
`hamlib.js` (from `/hamlib/` on this instance - see the `wasm/` directory of the
[Hamlib repo](https://github.com/madpsy/ubersdr-hamlib) for how that bundle is built) and calls
into Hamlib's own `rig_open`/`rig_get_freq`/`rig_set_freq`/`rig_get_mode`/`rig_set_mode`/
`rig_get_ptt` through a small exported API (`main.js`'s `ensureHamlibLoaded()`). Hamlib's port
I/O is redirected to the Web Serial API instead of a real OS serial device, so no server-side
component or native install is needed - it's just a browser and a USB cable.

The 14MB wasm module is only fetched when you actually open this extension (from
`onEnable()`), never on page load or for other extensions.

## Requirements

- **Chrome or Edge Browser**: Web Serial API is required
- **Serial Connection**: USB cable or serial adapter to connect radio to computer
- **Radio CAT Interface**: Radio must have CAT/CI-V control enabled

## Usage

1. **Select Radio**: Choose your radio make/model from the dropdown (populated dynamically -
   grouped by manufacturer, sourced from the Hamlib bundle's capability list)
2. **Choose Sync Direction**:
   - **SDR → Radio**: SDR controls the radio
   - **Radio → SDR**: Radio controls the SDR
   - **Both Ways**: Bidirectional synchronization
3. **Connect**: Click "Connect to Radio" and select the serial port
4. **Monitor**: Watch the LED displays update with frequency, mode, and TX/RX state

## Browser Compatibility

This extension requires the Web Serial API, which is available in:
- Chrome 89+
- Edge 89+
- Opera 75+

**Not supported in:**
- Firefox (no Web Serial API support)
- Safari (no Web Serial API support)

## Security Note

The Web Serial API requires user permission to access serial ports. The browser will prompt for
permission when you click "Connect to Radio". This is a security feature to prevent unauthorized
access to hardware.

## Troubleshooting

### "Web Serial API Not Available"
- Use Chrome or Edge browser
- Ensure you're not using Firefox or Safari
- Check that your browser is up to date

### "Hamlib module failed to load"
- Confirm `/hamlib/hamlib.js` and `/hamlib/hamlib.wasm` are actually deployed on this instance
- Check the browser console/network tab for the underlying fetch error

### "Connection failed"
- Verify the radio is powered on and CAT/CI-V is enabled in its menu
- Check USB cable connection
- Ensure the baud rate matches your radio's setting (auto-filled from the dropdown, but
  confirm against your radio's own CAT settings)
- Check that no other software is using the serial port
- The message log (below the LED display) shows Hamlib's own debug trace on failure

## License

Part of the UberSDR project.
