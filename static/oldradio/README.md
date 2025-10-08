# Old Radio - Vintage AM Receiver Interface

A simple, vintage-style radio interface for the ka9q_ubersdr web SDR receiver.

## Features

- **Vintage Design**: Classic wood-grain radio appearance with authentic controls
- **AM Mode Only**: Fixed to AM (Amplitude Modulation) for simplicity
- **Frequency Range**: 600 kHz to 2000 kHz (AM broadcast band)
- **Interactive Tuning Dial**: Drag the tuning dial to change frequency
- **Volume Control**: Rotary knob for volume adjustment
- **VU Meter**: Real-time audio level visualization
- **Frequency Display**: Analog-style frequency scale with needle indicator

## Usage

1. Start the ka9q_ubersdr server:
   ```bash
   cd ka9q_ubersdr
   ./ka9q_ubersdr -config config.yaml
   ```

2. Open your web browser and navigate to:
   ```
   http://localhost:8080/oldradio/
   ```

3. Click the "Turn On Radio" button to start

4. **Tune the Radio**:
   - Click and drag the large TUNING dial to change frequency
   - The frequency display shows the current station in kHz
   - The red needle moves along the scale as you tune

5. **Adjust Volume**:
   - Click and drag the VOLUME knob to adjust audio level
   - Rotate clockwise to increase, counter-clockwise to decrease

## Technical Details

### Frequency Range
- **Minimum**: 600 kHz (0.6 MHz)
- **Maximum**: 2000 kHz (2.0 MHz)
- **Default**: 1000 kHz (1.0 MHz)

### Mode
- **Fixed Mode**: AM (Amplitude Modulation)
- No mode switching available (by design for simplicity)

### Audio
- **Sample Rate**: 12 kHz (typical for AM)
- **Channels**: Mono
- **Format**: PCM 16-bit

### Browser Compatibility
- Modern browsers with Web Audio API support
- Chrome, Firefox, Safari, Edge (latest versions)

## Differences from Main Interface

The old radio interface is intentionally simplified compared to the main ubersdr interface:

**Removed Features**:
- Waterfall display
- Spectrum analyzer
- Audio visualizations (oscilloscope, spectrum)
- Filter controls (bandpass, notch)
- Equalizer
- Compressor/AGC controls
- CW decoder
- Mode selection
- Band presets

**Retained Features**:
- Basic tuning
- Volume control
- VU meter
- WebSocket audio streaming
- Real-time frequency display

## Design Philosophy

This interface recreates the experience of using a vintage AM radio from the 1950s-1960s era:
- Simple, intuitive controls
- Warm, nostalgic aesthetic
- Focus on the listening experience
- No complex DSP controls

Perfect for casual listening to AM broadcast stations or for users who prefer a simpler, more traditional radio experience.

## Files

- `index.html` - Main HTML structure
- `style.css` - Vintage radio styling
- `radio.js` - JavaScript for dial interaction and WebSocket communication

## Notes

- The interface connects to the same WebSocket backend as the main interface
- All audio processing is handled by the ka9q-radio radiod backend
- The vintage appearance is purely cosmetic - the underlying SDR technology is modern