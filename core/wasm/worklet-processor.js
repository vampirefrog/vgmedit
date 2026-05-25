/*
 * AudioWorklet processor that runs libvgm directly on the audio thread.
 *
 * This file is *appended* to a classic-script build of vgmcore by
 * core/wasm/build.sh, producing public/vgm-realtime-worklet.js. The
 * appended-to file defines `createVgmCoreWorklet` (the Emscripten module
 * factory). Together they form a single self-contained AudioWorklet
 * module — no imports, no fetch, no message-passing required for audio
 * data. addModule() loads it; the main-thread renderer just configures
 * via this.port.
 *
 * Protocol (incoming on this.port):
 *   { type: 'load',           bytes, sampleRate, startSample, loopSample }
 *   { type: 'seek',           sample }
 *   { type: 'setLoop',        sample }
 *   { type: 'setSelectionLoop', range | null }
 *   { type: 'close' }
 *
 * Outgoing:
 *   { type: 'ready' }                         — WASM finished loading
 *   { type: 'loaded',  totalSamples }         — after a 'load' command
 *   { type: 'cursor',  sample }               — throttled (~5 ms)
 *   { type: 'ended' }                          — no-loop EOF reached
 */
class VgmRealtimeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mod = null;
    this.player = 0;
    this.scratchPtr = 0;
    this.scratchFrames = 0;
    this.totalSamples = 0;
    this.loopSample = null;
    this.selectionLoop = null;
    /** Pending commands that arrive before WASM is ready. */
    this.pendingMessages = [];
    /** Frames since last cursor message (throttling). */
    this.framesSinceCursor = 0;
    this.ended = false;
    /** When true, process() outputs silence and skips render + cursor
     *  emission. Toggled by the main-thread renderer on play/pause so
     *  we don't keep rendering after disconnect (Firefox quirk). */
    this.paused = true;

    this.port.onmessage = (e) => this.onMessage(e.data);

    // createVgmCoreWorklet is defined by the Emscripten output that
    // precedes this file in the concatenated worklet bundle. Returns a
    // Promise even though SINGLE_FILE keeps it synchronous-feeling.
    createVgmCoreWorklet().then((mod) => {
      this.mod = mod;
      // Drain any messages that arrived before the WASM was ready.
      while (this.pendingMessages.length) this.handle(this.pendingMessages.shift());
      this.port.postMessage({ type: 'ready' });
    });
  }

  onMessage(m) {
    if (!this.mod) { this.pendingMessages.push(m); return; }
    this.handle(m);
  }

  handle(m) {
    const mod = this.mod;
    if (m.type === 'load') {
      if (this.player) mod._libvgm_close(this.player);
      const ptr = mod._malloc(m.bytes.length);
      mod.HEAPU8.set(m.bytes, ptr);
      this.player = mod._libvgm_open(ptr, m.bytes.length, m.sampleRate);
      mod._free(ptr);
      if (!this.player) { this.port.postMessage({ type: 'error', message: 'libvgm_open failed' }); return; }
      this.totalSamples = Number(mod._libvgm_total_samples(this.player));
      this.loopSample = m.loopSample ?? null;
      this.selectionLoop = null;
      this.ended = false;
      if (m.startSample && m.startSample > 0) {
        mod._libvgm_seek_sample(this.player, BigInt(Math.floor(m.startSample)));
      }
      // 128 is the smallest typical AudioWorklet block, but we may get
      // larger if the implementation changes; size the scratch on first
      // process() instead. Reset here so it grows again.
      if (this.scratchPtr) { mod._free(this.scratchPtr); this.scratchPtr = 0; this.scratchFrames = 0; }
      this.port.postMessage({ type: 'loaded', totalSamples: this.totalSamples });
    } else if (m.type === 'seek') {
      if (this.player) mod._libvgm_seek_sample(this.player, BigInt(Math.max(0, Math.floor(m.sample))));
      this.ended = false;
    } else if (m.type === 'setLoop') {
      this.loopSample = m.sample;
    } else if (m.type === 'setSelectionLoop') {
      this.selectionLoop = m.range ?? null;
    } else if (m.type === 'pause') {
      this.paused = true;
    } else if (m.type === 'resume') {
      this.paused = false;
      this.framesSinceCursor = 0;
    } else if (m.type === 'close') {
      if (this.player) { mod._libvgm_close(this.player); this.player = 0; }
      if (this.scratchPtr) { mod._free(this.scratchPtr); this.scratchPtr = 0; this.scratchFrames = 0; }
    }
  }

  /** Wrap libvgm's monotonic cumulative sample count back into the
   *  file's [0, totalSamples] range. */
  wrapDisplay(cumulative) {
    if (cumulative <= this.totalSamples) return cumulative;
    if (this.loopSample === null || this.loopSample >= this.totalSamples) return this.totalSamples;
    const len = this.totalSamples - this.loopSample;
    return this.loopSample + ((cumulative - this.totalSamples) % len);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1];
    const N = left.length;

    // Output silence whenever we have no player (WASM still loading,
    // file not yet loaded, or we've signalled end), or whenever the
    // main-thread renderer has told us to pause. Returning true keeps
    // the processor alive for the next resume.
    if (!this.mod || !this.player || this.ended || this.paused) {
      for (let i = 0; i < N; i++) { left[i] = 0; right[i] = 0; }
      return true;
    }

    if (this.scratchFrames < N) {
      if (this.scratchPtr) this.mod._free(this.scratchPtr);
      this.scratchPtr = this.mod._malloc(N * 4);  // s16 stereo = 4 bytes/frame
      this.scratchFrames = N;
    }

    // Selection loop: seek back before rendering when we'd cross the end.
    if (this.selectionLoop) {
      const cur = this.wrapDisplay(Number(this.mod._libvgm_current_sample(this.player)));
      if (cur >= this.selectionLoop.end) {
        this.mod._libvgm_seek_sample(this.player, BigInt(this.selectionLoop.start));
      }
    }

    const got = this.mod._libvgm_render_s16(this.player, this.scratchPtr, N);
    const src = new Int16Array(this.mod.HEAPU8.buffer, this.scratchPtr, got * 2);
    for (let i = 0; i < got; i++) {
      left[i]  = src[i * 2]     / 32768;
      right[i] = src[i * 2 + 1] / 32768;
    }
    for (let i = got; i < N; i++) { left[i] = 0; right[i] = 0; }

    // EOF for non-looping files: libvgm's cumulative sample passes
    // totalSamples and no loop point is set.
    const cumulative = Number(this.mod._libvgm_current_sample(this.player));
    if (!this.selectionLoop && this.loopSample === null && cumulative >= this.totalSamples) {
      this.ended = true;
      this.port.postMessage({ type: 'ended' });
    }

    // Throttled cursor update (~once per 5 ms at 44.1 kHz with N=128).
    this.framesSinceCursor += N;
    if (this.framesSinceCursor >= 256) {
      this.framesSinceCursor = 0;
      this.port.postMessage({ type: 'cursor', sample: this.wrapDisplay(cumulative) });
    }

    return true;
  }
}

registerProcessor('vgm-realtime', VgmRealtimeProcessor);
