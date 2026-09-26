// Audio thread: input 0 = microphone, input 1 = system audio. Each is mixed to
// mono and interleaved as 16-bit stereo (L = mic, R = system), then posted to
// the page in half-second chunks. Peak levels are posted every ~50 ms for the
// live meters. In monitor mode (microphone test) only levels are posted.
class PcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.emitChunks = opts.emitChunks !== false;
    this.frames = Math.round(sampleRate / 2);
    this.buf = new Int16Array(this.frames * 2);
    this.n = 0;
    this.micPeak = 0;
    this.sysPeak = 0;
    this.levelEvery = Math.round(sampleRate / 20);
    this.levelFrames = 0;
    this.levelMic = 0;
    this.levelSys = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  static mono(channels, i) {
    if (!channels.length) return 0;
    let sum = 0;
    for (let c = 0; c < channels.length; c++) sum += channels[c][i];
    return sum / channels.length;
  }

  process(inputs) {
    const mic = inputs[0] || [];
    const sys = inputs[1] || [];
    const len = (mic[0] && mic[0].length) || (sys[0] && sys[0].length) || 128;
    for (let i = 0; i < len; i++) {
      const l = Math.max(-1, Math.min(1, PcmRecorder.mono(mic, i)));
      const r = Math.max(-1, Math.min(1, PcmRecorder.mono(sys, i)));
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > this.levelMic) this.levelMic = al;
      if (ar > this.levelSys) this.levelSys = ar;
      if (this.emitChunks) {
        if (al > this.micPeak) this.micPeak = al;
        if (ar > this.sysPeak) this.sysPeak = ar;
        this.buf[this.n * 2] = l * 32767;
        this.buf[this.n * 2 + 1] = r * 32767;
        if (++this.n === this.frames) this.flush();
      }
    }
    this.levelFrames += len;
    if (this.levelFrames >= this.levelEvery) {
      this.port.postMessage({ type: 'level', mic: this.levelMic, sys: this.levelSys });
      this.levelFrames = 0;
      this.levelMic = 0;
      this.levelSys = 0;
    }
    return true;
  }

  flush() {
    if (!this.n) return;
    const pcm = this.buf.slice(0, this.n * 2);
    this.port.postMessage({ type: 'chunk', pcm, micPeak: this.micPeak, sysPeak: this.sysPeak }, [pcm.buffer]);
    this.n = 0;
    this.micPeak = 0;
    this.sysPeak = 0;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
