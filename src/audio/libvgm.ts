/**
 * libvgm-backed AudioRenderer.
 *
 * Plays a pre-rendered RenderedPcm buffer through Web Audio. Seeking is
 * implemented by stopping the current AudioBufferSourceNode and starting
 * a fresh one at the requested offset — exactly what the "rewind from 0
 * for backward seeks, forward from cursor for forward seeks" spec needs,
 * since the underlying buffer is already fully rendered.
 *
 * The renderer doesn't own the cursor — it just reports its current
 * playback position via onSampleAdvance. The store keeps the canonical
 * cursor and replays it back to the renderer via seek().
 *
 * Edits invalidate the PCM upstream; the App creates a brand-new
 * LibVgmAudioRenderer with the freshly-rendered PCM, so `invalidate`
 * here just marks the in-memory transport as needing a stop on the
 * next play/seek (defensive — App should usually replace the instance).
 */
import { VGM_SAMPLE_RATE } from '../wasm/index.js';
import type { RenderedPcm } from '../wasm/libvgm.js';
import type { AudioRenderer, PlayingChangeListener, SampleAdvanceListener } from './types.js';

export interface LibVgmAudioOptions {
  pcm: RenderedPcm;
  initialSample?: number;
  /** When set, playback loops from `totalSamples` back to this sample
   *  position. null disables looping (default). */
  loopSample?: number | null;
}

export class LibVgmAudioRenderer implements AudioRenderer {
  readonly sampleRate: number;
  readonly totalSamples: number;
  readonly pcm: RenderedPcm;

  private _ctx: AudioContext | null = null;
  private _buffer: AudioBuffer | null = null;
  private _source: AudioBufferSourceNode | null = null;
  private _playing = false;
  private _currentSample: number;
  private _ctxStartTime = 0;       // ctx.currentTime at most recent play()
  private _ctxStartSample = 0;     // _currentSample at most recent play()
  /** When non-null, playback wraps from totalSamples back to this sample. */
  private _loopSample: number | null = null;
  private rafId: number | null = null;
  private listeners = new Set<SampleAdvanceListener>();
  private playingListeners = new Set<PlayingChangeListener>();

  private setPlaying(p: boolean): void {
    if (this._playing === p) return;
    this._playing = p;
    for (const l of this.playingListeners) l(p);
  }

  constructor(opts: LibVgmAudioOptions) {
    this.pcm = opts.pcm;
    this.sampleRate = opts.pcm.sampleRate;
    this.totalSamples = opts.pcm.frames;
    this._currentSample = opts.initialSample ?? 0;
    this._loopSample = opts.loopSample ?? null;
  }

  get currentSample(): number { return this._currentSample; }
  get playing(): boolean { return this._playing; }

  private ensureContext(): AudioContext {
    if (!this._ctx) {
      this._ctx = new AudioContext({ sampleRate: this.sampleRate });
      const buf = this._ctx.createBuffer(2, this.pcm.frames, this.sampleRate);
      const l = buf.getChannelData(0);
      const r = buf.getChannelData(1);
      const d = this.pcm.data;
      for (let i = 0; i < this.pcm.frames; i++) {
        l[i] = d[i * 2];
        r[i] = d[i * 2 + 1];
      }
      this._buffer = buf;
    }
    return this._ctx;
  }

  async play(): Promise<void> {
    if (this._playing) return;
    if (this._currentSample >= this.totalSamples) this._currentSample = 0;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const src = ctx.createBufferSource();
    src.buffer = this._buffer!;
    src.connect(ctx.destination);
    // Configure looping if a loop point is set. The browser handles the
    // wrap-around inside AudioBuffer playback seamlessly; we mirror the
    // same wrap-around in the play-cursor math below.
    if (this._loopSample !== null && this._loopSample < this.totalSamples) {
      src.loop = true;
      src.loopStart = this._loopSample / this.sampleRate;
      src.loopEnd = this.totalSamples / this.sampleRate;
    }
    src.onended = () => {
      // Loop mode: this only fires on user stop or seek-induced disconnect,
      // never naturally.
      // No-loop mode: also fires at end-of-file; clamp cursor and stop.
      if (this._source === src) {
        if (this._currentSample < this.totalSamples) { this.setPlaying(false); return; }
        this._currentSample = this.totalSamples;
        this.setPlaying(false);
        this.emit();
      }
    };
    const offsetSec = this._currentSample / this.sampleRate;
    src.start(0, offsetSec);
    this._source = src;
    this._ctxStartTime = ctx.currentTime;
    this._ctxStartSample = this._currentSample;
    this.setPlaying(true);

    const tick = () => {
      if (!this._playing) return;
      const now = ctx.currentTime;
      const elapsed = (now - this._ctxStartTime) * this.sampleRate;
      this._currentSample = this.elapsedToSample(elapsed);
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Map "elapsed samples since play()" to a current sample position,
   *  handling loop wrap-around. The first pass runs from _ctxStartSample
   *  to totalSamples; if the loop is set, subsequent cycles run from
   *  _loopSample to totalSamples and repeat. */
  private elapsedToSample(elapsed: number): number {
    const start = this._ctxStartSample;
    if (this._loopSample === null) {
      return Math.min(this.totalSamples, start + elapsed);
    }
    const firstPass = Math.max(0, this.totalSamples - start);
    if (elapsed < firstPass) {
      return start + elapsed;
    }
    const loopLen = this.totalSamples - this._loopSample;
    if (loopLen <= 0) return this.totalSamples;
    const past = elapsed - firstPass;
    const within = past - Math.floor(past / loopLen) * loopLen;
    return this._loopSample + within;
  }

  setLoop(sample: number | null): void {
    this._loopSample = sample;
    // Propagate to the running source so the change takes effect at the
    // next loop boundary without needing to restart playback.
    if (this._source) {
      if (sample !== null && sample < this.totalSamples) {
        this._source.loop = true;
        this._source.loopStart = sample / this.sampleRate;
        this._source.loopEnd = this.totalSamples / this.sampleRate;
      } else {
        this._source.loop = false;
      }
    }
  }

  pause(): void {
    if (!this._playing) return;
    this.setPlaying(false);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this._source) {
      try { this._source.stop(); } catch {}
      this._source.disconnect();
      this._source = null;
    }
  }

  async seek(targetSample: number): Promise<void> {
    const clamped = Math.max(0, Math.min(this.totalSamples, Math.floor(targetSample)));
    const wasPlaying = this._playing;
    this.pause();
    this._currentSample = clamped;
    this.emit();
    if (wasPlaying) await this.play();
  }

  invalidate(_fromSample = 0): void {
    // PCM lifecycle is owned by whatever created this renderer. We just
    // stop playback so any in-flight schedule doesn't outlive the new PCM.
    this.pause();
  }

  onSampleAdvance(listener: SampleAdvanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPlayingChange(listener: PlayingChangeListener): () => void {
    this.playingListeners.add(listener);
    return () => this.playingListeners.delete(listener);
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
    this.playingListeners.clear();
    if (this._ctx) {
      void this._ctx.close();
      this._ctx = null;
      this._buffer = null;
    }
  }

  private emit(): void {
    for (const l of this.listeners) l(this._currentSample);
  }
}

export { VGM_SAMPLE_RATE };
