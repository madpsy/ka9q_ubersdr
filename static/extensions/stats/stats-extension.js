// Stats Extension - Shows current radio state information
// Demonstrates the decoder extension API

class StatsExtension extends DecoderExtension {
    constructor() {
        super('stats', {
            displayName: 'Stats Monitor',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });
        
        this.updateInterval = null;
        this.updateRate = 1000; // Update every 1 second
    }
    
    onInitialize() {
        this.radio.log('Stats Extension initialized');
        this.addCharacter('=== Radio State Monitor ===\n\n');
    }
    
    onEnable() {
        // Start periodic updates
        this.updateInterval = setInterval(() => {
            this.updateStats();
        }, this.updateRate);
        
        // Initial update
        this.updateStats();
    }
    
    onDisable() {
        // Stop periodic updates
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
    
    onProcessAudio(dataArray) {
        // This extension doesn't process audio, just displays stats
        // But we can show audio level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const db = 20 * Math.log10(rms);
        
        // Store for display
        this.currentAudioLevel = db;
    }
    
    updateStats() {
        // Clear previous text
        this.decodedText = '';
        
        // Header
        this.addCharacter('=== Radio State Monitor ===\n');
        this.addCharacter(`Updated: ${new Date().toLocaleTimeString()}\n\n`);
        
        // Frequency Information
        const freq = this.radio.getFrequency();
        const band = this.radio.getFrequencyBand(freq);
        this.addCharacter('--- FREQUENCY ---\n');
        this.addCharacter(`Dial: ${this.radio.formatFrequency(freq)}\n`);
        if (band) {
            this.addCharacter(`Band: ${band}\n`);
        }
        this.addCharacter('\n');
        
        // Mode Information
        const mode = this.radio.getMode();
        this.addCharacter('--- MODE ---\n');
        this.addCharacter(`Current: ${mode.toUpperCase()}\n`);
        this.addCharacter('\n');
        
        // Bandwidth Information
        const bw = this.radio.getBandwidth();
        this.addCharacter('--- BANDWIDTH ---\n');
        this.addCharacter(`Low: ${bw.low} Hz\n`);
        this.addCharacter(`High: ${bw.high} Hz\n`);
        this.addCharacter(`Center: ${Math.round(bw.center)} Hz\n`);
        this.addCharacter(`Width: ${Math.round(bw.width)} Hz\n`);
        this.addCharacter('\n');
        
        // Audio Information
        const audioCtx = this.radio.getAudioContext();
        if (audioCtx) {
            this.addCharacter('--- AUDIO ---\n');
            this.addCharacter(`Sample Rate: ${audioCtx.sampleRate} Hz\n`);
            this.addCharacter(`State: ${audioCtx.state}\n`);
            if (this.currentAudioLevel !== undefined) {
                const levelStr = isFinite(this.currentAudioLevel) ? 
                    this.currentAudioLevel.toFixed(1) + ' dB' : '-∞ dB';
                this.addCharacter(`Level: ${levelStr}\n`);
            }
            this.addCharacter('\n');
        }
        
        // Connection Information
        this.addCharacter('--- CONNECTION ---\n');
        this.addCharacter(`Status: ${this.radio.isConnected() ? 'Connected' : 'Disconnected'}\n`);
        this.addCharacter(`Session: ${this.radio.getSessionId()}\n`);
        this.addCharacter('\n');
        
        // Spectrum Information
        const spectrumData = this.radio.getSpectrumData();
        if (spectrumData) {
            this.addCharacter('--- SPECTRUM ---\n');
            this.addCharacter(`Center: ${this.radio.formatFrequency(spectrumData.centerFreq)}\n`);
            this.addCharacter(`Bin BW: ${spectrumData.binBandwidth.toFixed(1)} Hz\n`);
            this.addCharacter(`Bins: ${spectrumData.binCount}\n`);
            this.addCharacter(`Zoom: ${Math.round(spectrumData.zoomLevel)}×\n`);
            this.addCharacter('\n');
        }
        
        // Bands Information
        const bands = this.radio.getBands();
        if (bands && bands.length > 0) {
            this.addCharacter('--- AMATEUR BANDS ---\n');
            this.addCharacter(`Loaded: ${bands.length} bands\n`);
            // Show first few bands as example
            const displayBands = bands.slice(0, 3);
            displayBands.forEach(band => {
                const start = this.radio.formatFrequency(band.start);
                const end = this.radio.formatFrequency(band.end);
                this.addCharacter(`  ${band.name || band.label}: ${start} - ${end}\n`);
            });
            if (bands.length > 3) {
                this.addCharacter(`  ... and ${bands.length - 3} more\n`);
            }
            this.addCharacter('\n');
        }
        
        // Bookmarks Information
        const bookmarks = this.radio.getBookmarks();
        if (bookmarks && bookmarks.length > 0) {
            this.addCharacter('--- BOOKMARKS ---\n');
            this.addCharacter(`Total: ${bookmarks.length} bookmarks\n`);
            // Show first few bookmarks
            const displayBookmarks = bookmarks.slice(0, 5);
            displayBookmarks.forEach(bookmark => {
                const freqStr = this.radio.formatFrequency(bookmark.frequency);
                this.addCharacter(`  ${bookmark.name}: ${freqStr} (${bookmark.mode.toUpperCase()})\n`);
            });
            if (bookmarks.length > 5) {
                this.addCharacter(`  ... and ${bookmarks.length - 5} more\n`);
            }
        }
    }
    
    onFrequencyChanged(frequency) {
        // Update immediately when frequency changes
        this.updateStats();
    }
    
    onModeChanged(mode) {
        // Update immediately when mode changes
        this.updateStats();
    }
    
    onBandwidthChanged(low, high) {
        // Update immediately when bandwidth changes
        this.updateStats();
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new StatsExtension());
    console.log('✅ Stats Extension registered');
}