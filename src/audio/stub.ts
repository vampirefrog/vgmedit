/**
 * Stub audio renderer.
 *
 * No actual audio — just a clock that advances `currentSample` at real time
 * when `play()` is called, so the cursor UI is testable. The interface
 * contract (seek-forward-from-cursor / seek-backward-from-zero / invalidate)
 * is mirrored so the editor can run identically once a real backend lands.
 */
import { VGM_SAMPLE_RATE } from '../wasm/index.js';
import type {
  AudioRenderer,
  AudioRendererOptions,
  PlayingChangeListener,
  SampleAdvanceListener,
} from './types.js';

export class StubAudioRenderer implements AudioRenderer {
  readonly sampleRate: number;
  readonly totalSamples: number;

  private _currentSample = 0;
  private _playing = false;
  private listeners = new Set<SampleAdvanceListener>();
  private rafId: number | null = null;
  private lastTick = 0;
  // earliest sample below which our (imaginary) render state is valid
  private validFrom = 0;

  constructor(opts: AudioRendererOptions) {
    this.sampleRate = opts.sampleRate ?? VGM_SAMPLE_RATE;
    this.totalSamples = opts.file.header.totalSamples || 0;
  }

  get currentSample(): number { return this._currentSample; }
  get playing(): boolean { return this._playing; }

  async play(): Promise<void> {
    if (this._playing) return;
    this._playing = true;
    this.lastTick = performance.now();
    const loop = (now: number) => {
      if (!this._playing) return;
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      this._currentSample = Math.min(this.totalSamples, this._currentSample + dt * this.sampleRate);
      this.emit();
      if (this._currentSample >= this.totalSamples) {
        this.pause();
        return;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  pause(): void {
    this._playing = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  async seek(target: number): Promise<void> {
    const clamped = Math.max(0, Math.min(this.totalSamples, target));
    if (clamped < this._currentSample || clamped < this.validFrom) {
      // Spec: backward seek re-renders from zero. For the stub this is a
      // no-op beyond resetting the position.
      this._currentSample = 0;
      this.validFrom = 0;
    }
    // Forward "render" — instantaneous in the stub.
    this._currentSample = clamped;
    this.emit();
  }

  invalidate(fromSample = 0): void {
    this.validFrom = Math.max(0, fromSample);
    // No buffered audio in the stub, nothing else to discard.
  }

  setLoop(_sample: number | null): void {
    // Stub doesn't model loop wrap-around — fine since this renderer
    // exists only to drive the cursor before libvgm is wired up.
  }

  setChipMuted(_chipId: number, _muted: boolean): void {
    // Stub renderer has no chips to mute.
  }

  onSampleAdvance(listener: SampleAdvanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPlayingChange(_listener: PlayingChangeListener): () => void {
    return () => undefined;
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }

  private emit(): void {
    for (const l of this.listeners) l(this._currentSample);
  }
}
