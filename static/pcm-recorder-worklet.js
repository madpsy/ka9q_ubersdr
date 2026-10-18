/**
 * PCM Recorder AudioWorklet Processor
 * Runs on the audio rendering thread — immune to main-thread jank.
 * Collects Float32 PCM samples and posts them to the main thread in batches.
 */
class PcmRecorderProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._recording = false;
        // Opt-in, so v1 is unchanged: write silence when nothing is playing
        // upstream. The input then has no channels at all, and skipping those
        // quanta shortens the file against the wall clock.
        this._fillSilence = !!(options && options.processorOptions
            && options.processorOptions.fillSilence);

        this.port.onmessage = (event) => {
            if (event.data.command === 'start') {
                this._recording = true;
            } else if (event.data.command === 'stop') {
                this._recording = false;
            }
        };
    }

    process(inputs) {
        if (!this._recording) return true;

        const input = inputs[0];
        if (input && input.length > 0) {
            // Clone the channel data (the buffer is recycled after process() returns)
            const channelData = input[0];
            const copy = new Float32Array(channelData.length);
            copy.set(channelData);
            this.port.postMessage({ samples: copy }, [copy.buffer]);
        } else if (this._fillSilence) {
            const silence = new Float32Array(128);
            this.port.postMessage({ samples: silence }, [silence.buffer]);
        }

        return true; // Keep processor alive
    }
}

registerProcessor('pcm-recorder-processor', PcmRecorderProcessor);
