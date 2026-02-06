// @ts-nocheck



function asMs(samples) {
  return (samples * 1000 / sampleRate).toFixed(1);
}

function asSamples(ms) {
  return Math.round(ms * sampleRate / 1000);
}

class MoshiProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    console.log("Moshi processor lives", currentFrame, sampleRate);
    console.log(currentTime);
	console.log("=== MOSHI WORKLET CUSTOM BUILD v3 ===");

    // ===== WAN-SAFE BUFFER DEFAULTS (smooth > latency) =====
    // These values target ~250–400ms RTT with jitter.
    this.initialBufferSamples = asSamples(450);  // wait 450ms before first playback
    this.partialBufferSamples = asSamples(120);  // wait 120ms before resume after start

    // maxBufferSamples is EXTRA headroom beyond (initial + partial) before dropping
    this.maxBufferSamples = asSamples(1500);     // 1.5s headroom (rarely drop)

    // Adaptive growth
    this.partialBufferIncrement = asSamples(40);    // +40ms on underrun
    this.maxPartialWithIncrements = asSamples(500); // cap partial at 500ms

    this.maxBufferSamplesIncrement = asSamples(150);  // +150ms on overflow/drop
    this.maxMaxBufferWithIncrements = asSamples(2500); // cap maxBuffer at 2.5s

    // State and metrics
    this.initState();

    this.port.onmessage = (event) => {
      if (event.data?.type === "reset") {
        console.log("Reset audio processor state.");
        this.initState();
        return;
      }

      const frame = event.data.frame;
      if (!frame || !frame.length) return;

      this.frames.push(frame);

      if (this.currentSamples() >= this.initialBufferSamples && !this.started) {
        this.start();
      }

      if (this.pidx < 30) {
        console.log(
          this.timestamp(),
          "Got packet",
          this.pidx++,
          asMs(this.currentSamples()),
          asMs(frame.length)
        );
      }

      // Only drop when buffer is VERY large (avoid drop-induced artifacts)
      if (this.currentSamples() >= this.totalMaxBufferSamples()) {
        console.log(
          this.timestamp(),
          "Dropping packets",
          asMs(this.currentSamples()),
          asMs(this.totalMaxBufferSamples())
        );

        const target = this.initialBufferSamples + this.partialBufferSamples;

        while (this.currentSamples() > target && this.frames.length) {
          const first = this.frames[0];
          let to_remove = this.currentSamples() - target;
          to_remove = Math.min(first.length - this.offsetInFirstBuffer, to_remove);

          this.offsetInFirstBuffer += to_remove;
          this.timeInStream += to_remove / sampleRate;

          if (this.offsetInFirstBuffer === first.length) {
            this.frames.shift();
            this.offsetInFirstBuffer = 0;
          }
        }

        console.log(this.timestamp(), "After drop buffer=", asMs(this.currentSamples()));

        // Increase drop threshold slowly to adapt
        this.maxBufferSamples += this.maxBufferSamplesIncrement;
        this.maxBufferSamples = Math.min(this.maxMaxBufferWithIncrements, this.maxBufferSamples);
        console.log("Increased maxBuffer to", asMs(this.maxBufferSamples));
      }

      // stats
      this.port.postMessage({
        totalAudioPlayed: this.totalAudioPlayed,
        actualAudioPlayed: this.actualAudioPlayed,
        delay: (event.data.micDuration ?? 0) - this.timeInStream,
        minDelay: this.minDelay,
        maxDelay: this.maxDelay,
      });
    };
  }

  initState() {
    this.frames = [];
    this.offsetInFirstBuffer = 0;
    this.firstOut = false;
    this.remainingPartialBufferSamples = 0;
    this.timeInStream = 0.0;
    this.resetStart();

    // Metrics
    this.totalAudioPlayed = 0.0;
    this.actualAudioPlayed = 0.0;
    this.maxDelay = 0.0;
    this.minDelay = 2000.0;

    // Debug
    this.pidx = 0;

    // Never shrink these (prevents oscillation / gating)
    this.partialBufferSamples = Math.max(this.partialBufferSamples, asSamples(120));
    this.maxBufferSamples = Math.max(this.maxBufferSamples, asSamples(1500));
  }

  totalMaxBufferSamples() {
    return this.maxBufferSamples + this.partialBufferSamples + this.initialBufferSamples;
  }

  timestamp() {
    return Date.now() % 1000;
  }

  currentSamples() {
    let samples = 0;
    for (let k = 0; k < this.frames.length; k++) {
      samples += this.frames[k].length;
    }
    samples -= this.offsetInFirstBuffer;
    return samples;
  }

  resetStart() {
    this.started = false;
  }

  start() {
    this.started = true;
    this.remainingPartialBufferSamples = this.partialBufferSamples;
    this.firstOut = true;
  }

  canPlay() {
    return this.started && this.frames.length > 0 && this.remainingPartialBufferSamples <= 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0];

    const delay = this.currentSamples() / sampleRate;
    if (this.canPlay()) {
      this.maxDelay = Math.max(this.maxDelay, delay);
      this.minDelay = Math.min(this.minDelay, delay);
    }

    // If not ready, output silence but DO NOT hard-reset constantly
    if (!this.canPlay()) {
      output.fill(0);
      if (this.actualAudioPlayed > 0) {
        this.totalAudioPlayed += output.length / sampleRate;
      }
      this.remainingPartialBufferSamples -= output.length;
      return true;
    }

    if (this.firstOut) {
      console.log(this.timestamp(), "Audio resumed", asMs(this.currentSamples()), this.remainingPartialBufferSamples);
    }

    let out_idx = 0;

    // Fill output from queued frames
    while (out_idx < output.length && this.frames.length) {
      const first = this.frames[0];
      const to_copy = Math.min(first.length - this.offsetInFirstBuffer, output.length - out_idx);
      output.set(first.subarray(this.offsetInFirstBuffer, this.offsetInFirstBuffer + to_copy), out_idx);

      this.offsetInFirstBuffer += to_copy;
      out_idx += to_copy;

      if (this.offsetInFirstBuffer === first.length) {
        this.offsetInFirstBuffer = 0;
        this.frames.shift();
      }
    }

    // Fade-in on resume to avoid clicks
    if (this.firstOut) {
      this.firstOut = false;
      for (let i = 0; i < out_idx; i++) {
        output[i] *= i / Math.max(1, out_idx);
      }
    }

    // ===== KEY CHANGE FOR SMOOTHNESS =====
    // If we underrun, DO NOT call resetStart() (that causes gated/stuttery audio).
    // Instead, pad the rest of the buffer with silence and keep streaming.
    if (out_idx < output.length) {
      console.log(this.timestamp(), "Underrun padded", output.length - out_idx);

      // Grow partial buffer so future playback has more headroom
      this.partialBufferSamples += this.partialBufferIncrement;
      this.partialBufferSamples = Math.min(this.partialBufferSamples, this.maxPartialWithIncrements);
      console.log("Increased partial buffer to", asMs(this.partialBufferSamples));

      // short fade-out on the last ~5ms to avoid clicks
      const fade = Math.min(out_idx, 128);
      for (let i = 0; i < fade; i++) {
        const idx = out_idx - fade + i;
        output[idx] *= (fade - i) / fade;
      }

      // pad remainder with silence
      output.fill(0, out_idx);
    }

    this.totalAudioPlayed += output.length / sampleRate;
    this.actualAudioPlayed += out_idx / sampleRate;
    this.timeInStream += out_idx / sampleRate;

    return true;
  }
}

registerProcessor("moshi-processor", MoshiProcessor);
