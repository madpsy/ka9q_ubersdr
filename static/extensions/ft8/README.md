# FT8/FT4 Decoder Extension

Web-based frontend for the FT8/FT4 weak signal digital mode decoder.

## Features

- **Dual Protocol Support**: FT8 (15-second slots) and FT4 (7.5-second slots)
- **Real-time Decoding**: Displays decoded messages as they arrive
- **GPS Time Synchronization**: Automatic slot alignment using GPS timestamps
- **Message Filtering**: Show only CQ messages or all traffic
- **Export Functionality**: Save decoded messages to CSV
- **Quick Tune**: Pre-configured frequency list for common FT8/FT4 frequencies
- **Color-coded SNR**: Visual indication of signal strength
- **Auto-scroll**: Automatically show newest messages

## Usage

1. **Select Frequency**: Use the Quick Tune dropdown to select a common FT8/FT4 frequency
   - Primary FT8: 14.074 MHz USB (20m band)
   - Primary FT4: 14.080 MHz USB (20m band)

2. **Configure Settings**:
   - **Protocol**: Choose FT8 (15s) or FT4 (7.5s)
   - **Min Score**: Minimum sync score (0-100, default 10)
   - **CQ Only**: Filter to show only CQ messages
   - **Auto-Clear**: Automatically remove old messages

3. **Start Decoding**: Click "Start" to begin decoding

4. **View Messages**: Decoded messages appear in the table with:
   - UTC time
   - SNR (Signal-to-Noise Ratio in dB)
   - ΔT (Time offset from slot start)
   - Frequency (audio frequency in Hz)
   - Message text
   - Slot number

5. **Export**: Click "Export" to save all messages to a CSV file

## Message Types Supported

- **CQ Calls**: `CQ DH1NAS JO50`
- **Standard QSOs**: `W1ABC K2DEF RR73`
- **Grid Squares**: 4-character Maidenhead locators
- **Signal Reports**: -30 to +32 dB
- **DXpedition Mode**: Special format for DXpeditions
- **Contesting**: Contest-specific messages
- **Non-standard Callsigns**: Up to 11 characters with /
- **Free Text**: Up to 13 characters

## Common Frequencies

### FT8
- **40m**: 7.074 MHz USB
- **20m**: 14.074 MHz USB (most active)
- **15m**: 21.074 MHz USB
- **10m**: 28.074 MHz USB
- **6m**: 50.313 MHz USB

### FT4
- **40m**: 7.047.5 MHz USB
- **20m**: 14.080 MHz USB
- **15m**: 21.140 MHz USB
- **10m**: 28.180 MHz USB

## Technical Details

- **Sample Rate**: 12 kHz
- **Bandwidth**: 3 kHz (100-3100 Hz)
- **Time Slots**: GPS-synchronized
- **Decoding**: LDPC forward error correction with CRC verification
- **Hash Table**: Automatic callsign storage and resolution

## Tips

- **Best Time**: 20m band (14.074 MHz) is active 24/7
- **Propagation**: Check different bands based on time of day
- **Weak Signals**: FT8 can decode signals as weak as -24 dB SNR
- **CQ Filter**: Enable "CQ Only" to find stations calling CQ
- **Auto-Clear**: Enable to prevent table from growing too large

## Troubleshooting

- **No Decodes**: Check frequency and mode (USB)
- **Wrong Time**: Decoder requires GPS time synchronization
- **Too Many False Decodes**: Increase Min Score setting
- **Missing Messages**: Decrease Min Score setting

## Version

1.0.0 - Initial release with full FT8/FT4 support
