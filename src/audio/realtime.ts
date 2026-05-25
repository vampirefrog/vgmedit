/**
 * Realtime libvgm-backed AudioRenderer.
 *
 * Instead of pre-rendering the whole file to PCM and playing it back as
 * an AudioBuffer, this renderer drives libvgm directly from the audio
 * thread: a ScriptProcessorNode fires `onaudioprocess` for each ~93 ms
 * block, we call `libvgm_render_s16` for exactly that many frames, copy
 * the resulting interleaved s16 into the node's Float32 outputs, and
 * advance the cursor by what libvgm tells us.
 *
 * Why realtime: a pre-rendered loop just replays the same buffer, so
 * any glitch caused by the chip-state mismatch at a loop boundary isn't
 * audible — the chips never actually go through that transition. With
 * realtime rendering the chips DO play through the loop transition, so
 * the user can hear loop-point bugs and edit them out. Same principle
 * for the shift+space "play selection looped" mode.
 *
 * ScriptProcessorNode is deprecated in favour of AudioWorklet but it is
 * still supported in every current browser and is the only place we can
 * call into a Float32-producing WASM module that lives on the main
 * thread without setting up a separate worklet build pipeline.
 * Per-block render cost is ~3 ms for chiptune-typical files; the 4096-
 * sample buffer gives the main thread ~90 ms of slop before audio
 * glitches.
 */
import type { VgmCoreModule } from '../wasm/vgmcore.js';
import type { AudioRenderer, PlayingChangeListener, SampleAdvanceListener } from './types.js';

export interface RealtimeOptions {
  mod: VgmCoreModule;
  /** A serialized VGM byte stream. The renderer takes a copy. */
  bytes: Uint8Array;
  sampleRate: number;
  initialSample?: number;
  /** When set, wrap from EOF back to this sample. Pass null to stop at EOF. */
  loopSample?: number | null;
}

const BLOCK_FRAMES = 4096;

export class RealtimeVgmAudioRenderer implements AudioRenderer {
  readonly sampleRate: number;

  private mod: VgmCoreModule;
  private _player: number;
  private _scratchPtr: number;
  private _totalSamples: number;

  private _ctx: AudioContext | null = null;
  private _node: ScriptProcessorNode | null = null;
  private _playing = false;
  private _currentSample: number;
  private _loopSample: number | null;
  private _selectionLoop: { start: number; end: number } | null = null;

  private listeners = new Set<SampleAdvanceListener>();
  private playingListeners = new Set<PlayingChangeListener>();

  constructor(opts: RealtimeOptions) {
    this.mod = opts.mod;
    this.sampleRate = opts.sampleRate;
    this._loopSample = opts.loopSample ?? null;
    this._currentSample = opts.initialSample ?? 0;

    const dataPtr = this.mod._malloc(opts.bytes.length);
    this.mod.HEAPU8.set(opts.bytes, dataPtr);
    this._player = this.mod._libvgm_open(dataPtr, opts.bytes.length, opts.sampleRate);
    this.mod._free(dataPtr);
    if (!this._player) throw new Error('libvgm_open failed');

    this._totalSamples = Number(this.mod._libvgm_total_samples(this._player));
    this._scratchPtr = this.mod._malloc(BLOCK_FRAMES * 4);  // s16 stereo = 4 bytes/frame

    if (this._currentSample > 0) {
      this.mod._libvgm_seek_sample(this._player, BigInt(Math.floor(this._currentSample)));
    }
  }

  get currentSample(): number { return this._currentSample; }
  get totalSamples(): number { return this._totalSamples; }
  get playing(): boolean { return this._playing; }

  async play(): Promise<void> {
    if (this._playing) return;
    if (!this._ctx) {
      this._ctx = new AudioContext({ sampleRate: this.sampleRate });
    }
    if (this._ctx.state === 'suspended') await this._ctx.resume();

    // Re-seek in case currentSample drifted while paused (cursor moves,
    // edits, etc.). libvgm's seek rewinds-and-fast-forwards internally.
    this.mod._libvgm_seek_sample(this._player, BigInt(Math.floor(this._currentSample)));

    const node = this._ctx.createScriptProcessor(BLOCK_FRAMES, 0, 2);
    const mod = this.mod;
    const player = this._player;
    const scratchPtr = this._scratchPtr;

    node.onaudioprocess = (e) => {
      const left = e.outputBuffer.getChannelData(0);
      const right = e.outputBuffer.getChannelData(1);
      const N = left.length;

      let produced = 0;
      let shouldStop = false;

      while (produced < N) {
        // Selection loop: cap render at the loop-end and seek back to
        // the loop-start when we hit it. libvgm doesn't know about the
        // selection, so this is done by hand.
        if (this._selectionLoop) {
          const room = this._selectionLoop.end - this.wrapToDisplay(
            Number(mod._libvgm_current_sample(player))
          );
          if (room <= 0) {
            mod._libvgm_seek_sample(player, BigInt(this._selectionLoop.start));
            continue;
          }
          const want = Math.min(N - produced, Math.floor(room));
          const got = mod._libvgm_render_s16(player, scratchPtr, want);
          if (got === 0) { shouldStop = true; break; }
          copyRange(scratchPtr, left, right, produced, got, mod);
          produced += got;
          continue;
        }

        // No selection loop. With libvgm's huge internal loopCount, a
        // file with a loop point will produce samples indefinitely and
        // never report EOF here — we just keep rendering. A non-looping
        // file will eventually have current_sample >= total; we stop
        // then. got=0 is a safety net for unexpected libvgm behaviour.
        const got = mod._libvgm_render_s16(player, scratchPtr, N - produced);
        if (got === 0) { shouldStop = true; break; }
        copyRange(scratchPtr, left, right, produced, got, mod);
        produced += got;

        const cumulative = Number(mod._libvgm_current_sample(player));
        // No file-loop and we've consumed the file once — stop cleanly.
        if (this._loopSample === null && cumulative >= this._totalSamples) {
          shouldStop = true;
          break;
        }
      }

      // Zero-pad any trailing samples we couldn't fill.
      for (let i = produced; i < N; i++) { left[i] = 0; right[i] = 0; }

      // Update display cursor (wrapped into [0, totalSamples]).
      this._currentSample = this.wrapToDisplay(Number(mod._libvgm_current_sample(player)));
      this.emitSample();

      if (shouldStop) {
        // Defer the disconnect — disconnecting inside the audio callback
        // is undefined behaviour.
        queueMicrotask(() => this.pause());
      }
    };

    node.connect(this._ctx.destination);
    this._node = node;
    this.setPlaying(true);
  }

  pause(): void {
    if (!this._playing) return;
    if (this._node) {
      this._node.disconnect();
      this._node.onaudioprocess = null;
      this._node = null;
    }
    this.setPlaying(false);
  }

  async seek(target: number): Promise<void> {
    const clamped = Math.max(0, Math.min(this._totalSamples, Math.floor(target)));
    if (this._player) {
      this.mod._libvgm_seek_sample(this._player, BigInt(clamped));
    }
    this._currentSample = clamped;
    this.emitSample();
  }

  setLoop(sample: number | null): void {
    this._loopSample = sample;
  }

  /** Engage / disengage the selection-loop mode. While set, the renderer
   *  seeks back to `range.start` whenever the playhead crosses
   *  `range.end`. Pass null to revert to normal (file-loop or stop). */
  setSelectionLoop(range: { start: number; end: number } | null): void {
    this._selectionLoop = range;
    if (range && this._player) {
      if (this._currentSample < range.start || this._currentSample >= range.end) {
        this.mod._libvgm_seek_sample(this._player, BigInt(range.start));
        this._currentSample = range.start;
        this.emitSample();
      }
    }
  }

  invalidate(_fromSample = 0): void {
    // Edits invalidate the underlying byte stream; the App owns the
    // dispose+recreate so we don't try to swap libvgm state mid-flight.
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
    if (this._scratchPtr) {
      this.mod._free(this._scratchPtr);
      this._scratchPtr = 0;
    }
    if (this._player) {
      this.mod._libvgm_close(this._player);
      this._player = 0;
    }
    if (this._ctx) {
      void this._ctx.close();
      this._ctx = null;
    }
  }

  /** Map libvgm's cumulative sample count (which grows monotonically and
   *  is many times larger than totalSamples once the song has looped
   *  internally) back into the visible [0, totalSamples] range. */
  private wrapToDisplay(cumulative: number): number {
    if (cumulative <= this._totalSamples) return cumulative;
    if (this._loopSample === null || this._loopSample >= this._totalSamples) {
      return this._totalSamples;
    }
    const loopLen = this._totalSamples - this._loopSample;
    return this._loopSample + ((cumulative - this._totalSamples) % loopLen);
  }

  private setPlaying(p: boolean): void {
    if (this._playing === p) return;
    this._playing = p;
    for (const l of this.playingListeners) l(p);
  }

  private emitSample(): void {
    for (const l of this.listeners) l(this._currentSample);
  }
}

function copyRange(
  scratchPtr: number,
  left: Float32Array, right: Float32Array,
  offset: number, frames: number,
  mod: VgmCoreModule,
): void {
  const src = new Int16Array(mod.HEAPU8.buffer, scratchPtr, frames * 2);
  for (let i = 0; i < frames; i++) {
    left[offset + i]  = src[i * 2]     / 32768;
    right[offset + i] = src[i * 2 + 1] / 32768;
  }
}
