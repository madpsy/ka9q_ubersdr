# TDOA Processor for UberSDR

A Python application for processing synchronized IQ recordings from multiple UberSDR instances to perform TDOA (Time Difference of Arrival) analysis for radio transmitter geolocation.

## ⚠️ CRITICAL REQUIREMENT

**TDOA requires a common signal present in all recordings!**

For TDOA to work, you must have:
1. **Synchronized recordings** from multiple receivers at the same time
2. **A common transmitter signal** that is received by ALL receivers
3. The signal must be **strong enough** to correlate across receivers

### What Signals Work?

For HF (like 14.074 MHz):
- **FT8/FT4 transmissions** - Narrowband digital modes (use `--offset` to target specific signal)
- **CW (Morse code)** - Continuous wave transmissions
- **AM/SSB voice** - Voice transmissions (wideband)
- **Beacons** - Continuous transmitters
- **Any strong signal** that appears in all recordings simultaneously

### What Won't Work?

- **Noise only** - Random noise doesn't correlate
- **Different signals** - Each receiver hearing different stations
- **Weak signals** - Signal below noise floor in some receivers
- **Unsynchronized recordings** - Recordings from different times

### Example: Locating an FT8 Station

1. Record from multiple receivers at 14.074 MHz simultaneously
2. Identify a strong FT8 signal in the waterfall (e.g., at +1500 Hz)
3. Process with: `--offset 1500 --bandwidth 2500`
4. The processor will correlate that specific FT8 transmission across all receivers

## How It Works (Technical Details)

### What the Processor Does with IQ Data

**No demodulation is performed!** The processor works directly with the raw IQ (complex baseband) samples:

1. **Load IQ Data**: Reads 16-bit stereo WAV files where:
   - Left channel = I (In-phase)
   - Right channel = Q (Quadrature)
   - Combined as complex numbers: `IQ = I + jQ`

2. **Optional Bandpass Filtering**: If you specify `--offset` and `--bandwidth`:
   - Applies a Butterworth bandpass filter to isolate a specific frequency range
   - Example: `--offset 1500 --bandwidth 2500` filters 250 Hz to 2750 Hz
   - This isolates a specific signal (like one FT8 transmission) from the full spectrum

3. **Cross-Correlation**: Compares the complex IQ waveforms directly:
   ```
   correlation(lag) = Σ signal1[n] × conj(signal2[n + lag])
   ```
   - Finds the time shift (lag) where the two signals align best
   - Uses FFT for fast computation
   - Works on the **waveform shape**, not the demodulated data

4. **TDOA Calculation**: The lag with maximum correlation is the time difference of arrival
   - Lag in samples ÷ sample rate = TDOA in seconds
   - TDOA × speed of light = distance difference

### What Defines a "Signal"?

A "signal" is **any RF energy pattern that repeats across receivers**:

- **Modulated carrier**: The RF waveform itself (AM, FM, SSB, digital modes)
- **Envelope patterns**: The amplitude/phase variations over time
- **Bandwidth**: Can be narrowband (CW, FT8) or wideband (SSB voice)

**The key**: The IQ waveform pattern must be **similar** at all receivers. This happens when:
- Same transmitter is heard by all receivers
- Signal is strong enough (above noise floor)
- Propagation doesn't completely distort the waveform

**What doesn't work**:
- **Pure noise**: Random, uncorrelated between receivers
- **Different transmitters**: Each receiver hearing different stations
- **Severely faded signals**: Multipath destroys waveform coherence

### Why Filtering Helps

For weak signals buried in noise:
- **Wideband (no filter)**: Correlates noise + signal → poor correlation
- **Narrowband (with filter)**: Isolates just the signal → better correlation

Example: FT8 signal at +1500 Hz with 50 Hz bandwidth
- Without filter: Correlating 48 kHz of mostly noise
- With `--offset 1500 --bandwidth 2500`: Correlating just the FT8 signal region

## Features

- **Web-based interface** - Modern, responsive web UI for session selection and result visualization
- **Automatic session discovery** - Scans directory and groups recordings by timestamp
- **Interactive session selection** - Choose which recording session to analyze
- **Automatic metadata parsing** - Reads receiver locations from JSON metadata files
- **Wideband or narrowband processing** - Process full 48 kHz bandwidth or filter to specific signals
- **Cross-correlation analysis** - FFT-based correlation for efficient TDOA calculation
- **Position estimation** - Multilateration using least-squares optimization
- **Confidence metrics** - Correlation peak strength and confidence scores
- **Multiple receiver support** - Works with 2 or more receivers
- **Real-time results** - View TDOA measurements and estimated position in browser

## Requirements

- Python 3.8 or higher
- NumPy
- SciPy
- Flask

## Installation

```bash
cd clients/tdoa-processor
pip install -r requirements.txt
chmod +x web_app.py tdoa_processor.py
```

## Usage

### Web Interface (Recommended)

Start the web server and open your browser:

```bash
./web_app.py --dir /path/to/recordings
```

Then open your browser to: **http://localhost:5000**

The web interface provides:
- **Session browser** - View all available recording sessions grouped by timestamp
- **Interactive selection** - Click to select which session to analyze
- **Parameter controls** - Adjust frequency offset and bandwidth
- **Real-time processing** - Process TDOA with visual feedback
- **Results visualization** - View TDOA measurements, confidence scores, and estimated position
- **Map links** - Direct links to Google Maps for estimated positions

#### Web Server Options

```bash
./web_app.py --dir /path/to/recordings --host 0.0.0.0 --port 8080
```

- `--dir` - Directory containing recordings (default: current directory)
- `--host` - Host to bind to (default: 127.0.0.1)
- `--port` - Port to bind to (default: 5000)
- `--debug` - Enable debug mode

### Command Line Interface

For automated processing or scripting:

#### Interactive Mode

```bash
./tdoa_processor.py /path/to/recordings
```

Select from available sessions interactively.

#### Auto-Select Most Recent

```bash
./tdoa_processor.py /path/to/recordings --auto
```

#### Narrowband Processing

```bash
./tdoa_processor.py /path/to/recordings --offset 3000 --bandwidth 2500
```

#### Process Specific Files

```bash
./tdoa_processor.py --files rx1.wav rx2.wav rx3.wav
```

#### Command Line Options

- `directory` - Directory to scan for recordings (default: current directory)
- `--files WAV [WAV ...]` - Process specific WAV files (skips directory scan)
- `--offset FREQ` - Frequency offset from center in Hz (default: 0)
- `--bandwidth BW` - Filter bandwidth in Hz (default: 24000 = full bandwidth)
- `--no-position` - Skip position estimation, only calculate TDOAs
- `--auto` - Automatically select most recent session

## Input Files

The processor expects pairs of files for each recording:

1. **WAV file** - IQ recording from iq-recorder
   - Format: 16-bit stereo PCM, 48 kHz
   - Filename: `{hostname}_{frequency}_{timestamp}.wav`

2. **JSON file** - Metadata with receiver location
   - Filename: `{hostname}_{frequency}_{timestamp}.json`
   - Must contain receiver GPS coordinates

Example files:
```
m9psy.tunnel.ubersdr.org_14074000_2026-01-21T15:47:37.908Z.wav
m9psy.tunnel.ubersdr.org_14074000_2026-01-21T15:47:37.908Z.json
g4zfq.tunnel.ubersdr.org_14074000_2026-01-21T15:47:37.908Z.wav
g4zfq.tunnel.ubersdr.org_14074000_2026-01-21T15:47:37.908Z.json
```

## Output

The processor provides detailed output including:

### 1. Loading Information
```
Loading m9psy.tunnel.ubersdr.org_14074000_2026-01-21T15:47:37.908Z.wav...
  Loaded 480000 samples from M9PSY (Dalgety Bay, Scotland, UK)
  Position: 56.0403°N, -3.3554°E, 30m ASL
```

### 2. TDOA Calculations
```
Cross-correlating M9PSY <-> G4ZFQ...
  TDOA: +127.3 μs (+6 samples)
  Correlation peak: 1.23e+05, Confidence: 0.9234
  Distance difference: +38.2 km
```

### 3. Position Estimation
```
Reference receiver: M9PSY at 56.0403°N, -3.3554°E
Initial guess: 55.5201°N, -2.1777°E

Estimated position: 55.4567°N, -2.3456°E
Position uncertainty: ±2.3 km

Distances from receivers:
  M9PSY: 78.4 km
  G4ZFQ: 116.6 km
  W1AW: 5234.2 km
```

## How It Works

### 1. Signal Processing

The processor can operate in two modes:

**Wideband Mode** (default):
- Processes the full 48 kHz bandwidth
- Best for strong, wideband signals
- Faster processing

**Narrowband Mode** (with `--offset` and `--bandwidth`):
- Applies bandpass filter around target signal
- Better SNR for weak signals
- Required for narrowband modes (CW, FT8, etc.)

### 2. Cross-Correlation

For each pair of receivers:
1. Load IQ data from WAV files
2. Apply bandpass filter (if specified)
3. Compute cross-correlation using FFT
4. Find correlation peak within search range
5. Calculate TDOA from peak position

The correlation peak indicates signal strength, and confidence is calculated as the normalized correlation value.

### 3. Position Estimation

Uses multilateration with least-squares optimization:
1. Calculate distance differences from TDOAs
2. Set up system of hyperbolic equations
3. Solve using Levenberg-Marquardt algorithm
4. Weight measurements by confidence scores

## Accuracy

TDOA accuracy depends on several factors:

### Sample-Level Precision
- Sample period: 20.833 μs (1/48000)
- Distance resolution: ~6.2 km per sample
- Sub-sample interpolation can improve this

### Factors Affecting Accuracy
- **Signal bandwidth**: Wider bandwidth = better time resolution
- **SNR**: Higher SNR = more accurate correlation peak
- **Receiver geometry**: Better GDOP with widely spaced receivers
- **Multipath**: Can cause false peaks or reduced accuracy

### Typical Performance
- **Strong wideband signals**: 0.5-2 km accuracy
- **Narrowband signals (FT8)**: 2-10 km accuracy
- **Weak signals**: 10-50 km accuracy

## Examples

### Example 1: FT8 Signal Geolocation

**Step 1**: Record from 3 receivers simultaneously (same timestamp):
```bash
cd clients/iq-recorder

# Record from receiver 1
./build/iq-recorder -host rx1.example.com -port 443 -ssl \
  -frequency 14074000 -duration 30 -output rx1.wav &

# Record from receiver 2
./build/iq-recorder -host rx2.example.com -port 443 -ssl \
  -frequency 14074000 -duration 30 -output rx2.wav &

# Record from receiver 3
./build/iq-recorder -host rx3.example.com -port 443 -ssl \
  -frequency 14074000 -duration 30 -output rx3.wav &

wait
```

**Step 2**: Listen to recordings or view waterfall to identify a strong signal
- For example, you see a strong FT8 signal at +1500 Hz in all recordings

**Step 3**: Process targeting that specific signal:
```bash
cd clients/tdoa-processor
python tdoa_processor.py --offset 1500 --bandwidth 2500 --auto
```

**Note**: If you see "TDOA exceeds maximum possible" warnings, it means no common signal was found. Try:
- Different offset values to target other signals
- Wider bandwidth: `--bandwidth 5000`
- Full bandwidth (no filtering): `--bandwidth 24000 --offset 0`

### Example 2: Wideband Signal

Record and process without filtering:
```bash
# Record
cd clients/iq-recorder
./build/iq-recorder -host rx1.com -host rx2.com -ssl -frequency 7074000 -duration 10

# Process
cd clients/tdoa-processor
python tdoa_processor.py *.wav
```

### Example 3: TDOA Only (No Position Estimation)

Calculate TDOAs without attempting geolocation:
```bash
python tdoa_processor.py --no-position rx1.wav rx2.wav
```

## Troubleshooting

### "TDOA exceeds maximum possible" Warnings

This means the calculated time delay is physically impossible (exceeds light travel time between receivers). This indicates:

**Most Common Cause**: No common signal in the recordings
- The recordings contain only noise or different signals
- Cross-correlation is finding false peaks in random noise
- **Solution**: Ensure a strong common signal is present, use `--offset` to target it

**Other Causes**:
- Recordings are not synchronized (different timestamps)
- Wrong frequency or filter settings
- Signal too weak to correlate properly

### Low Confidence Scores

If correlation confidence is low (<0.1):
- **No common signal present** - This is the most likely cause
- Check that recordings are truly synchronized (same timestamp)
- Verify the same signal is present in all recordings
- Try narrowband filtering around a specific signal with `--offset`
- Increase recording duration for better SNR

### Position Converges to Receiver Location (0 km distance)

This means the optimizer couldn't find a valid solution and defaulted to a receiver location:
- **No valid TDOA measurements** - All TDOAs are physically impossible
- **No common signal** - Recordings don't contain the same transmitter
- **Solution**: Record when a strong signal is present in all receivers

### Position Estimation Fails

If multilateration doesn't converge:
- Need at least 3 receivers for 2D position
- Check receiver positions are accurate in JSON metadata
- Verify TDOAs are reasonable (not exceeding physical limits)
- Poor receiver geometry (all in a line) causes issues
- **Most importantly**: Ensure a common signal is present

### Missing Metadata Files

Ensure JSON files exist alongside WAV files:
```bash
ls -la *.wav *.json
```

If missing, the iq-recorder may have failed to fetch metadata. Check network connectivity and `/api/description` endpoint.

## Technical Details

### Cross-Correlation Method

The processor uses FFT-based cross-correlation:
```python
correlation = scipy.signal.correlate(signal1, signal2, mode='same', method='fft')
```

This is much faster than time-domain correlation for long signals.

### Multilateration Algorithm

Position estimation uses scipy's `least_squares` with Levenberg-Marquardt:
- Minimizes sum of squared errors between measured and expected TDOAs
- Weights measurements by confidence scores
- Handles overdetermined systems (more measurements than unknowns)

### Coordinate System

- Uses WGS84 geodetic coordinates (latitude, longitude)
- Haversine formula for great-circle distances
- Assumes Earth is a sphere (good enough for HF distances)

## Future Enhancements

Potential improvements:
- Web interface for interactive analysis
- Visualization of correlation functions
- Map display of hyperbolas and estimated position
- Support for more than 3 receivers
- Iterative refinement with signal detection
- Export results to KML/GeoJSON

## License

See the main repository LICENSE file.
