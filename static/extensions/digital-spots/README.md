# Digital Spots Extension

Display real-time FT8, FT4, and WSPR spots from the multi-decoder.

## Features

- Real-time display of decoded digital mode spots
- Filter by mode (FT8, FT4, WSPR)
- Filter by age (5/10/15/30/60 minutes or no limit)
- Filter by band (160m-10m)
- Filter by callsign/grid/message
- Click to tune to any spot
- Click callsign to open QRZ.com
- Color-coded modes and SNR values
- Real-time age tracking

## Usage

1. Enable the extension in `extensions.yaml`
2. Ensure the multi-decoder is configured and running
3. The extension will automatically display spots as they are decoded

## Configuration

No additional configuration required. The extension uses the existing DX cluster websocket connection to receive digital spots.

## Notes

- This extension does not add markers to the spectrum display (unlike the DX cluster extension)
- Spots are received via the `/ws/dxcluster` websocket endpoint
- The multi-decoder must be enabled and configured in `decoder.yaml`