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

      const got = mod._libvgm_render_s16(player, scratchPtr, N);
      const src = new Int16Array(mod.HEAPU8.buffer, scratchPtr, got * 2);
      for (let i = 0; i < got; i++) {
        left[i]  = src[i * 2]     / 32768;
        right[i] = src[i * 2 + 1] / 32768;
      }
      // Zero-pad any trailing samples we couldn't produce so the audio
      // graph doesn't read uninitialised memory.
      for (let i = got; i < N; i++) { left[i] = 0; right[i] = 0; }

      this._currentSample = Number(mod._libvgm_current_sample(player));

      // Selection loop: wrap whenever the playhead crosses the end of
      // the loop region. Done by seeking libvgm back to the loop start —
      // chip state is re-established at that point so the user hears
      // the same transition each cycle (which is the whole reason for
      // this mode).
      if (this._selectionLoop) {
        if (this._currentSample >= this._selectionLoop.end) {
          mod._libvgm_seek_sample(player, BigInt(this._selectionLoop.start));
          this._currentSample = this._selectionLoop.start;
        }
      } else if (got === 0) {
        // Natural end-of-file. Loop back to loop_sample if one is set,
        // otherwise schedule a stop.
        if (this._loopSample !== null && this._loopSample < this._totalSamples) {
          mod._libvgm_seek_sample(player, BigInt(this._loopSample));
          this._currentSample = this._loopSample;
        } else {
          // Defer to a microtask so we don't disconnect from inside the
          // audio callback.
          queueMicrotask(() => this.pause());
        }
      }

      this.emitSample();
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

  private setPlaying(p: boolean): void {
    if (this._playing === p) return;
    this._playing = p;
    for (const l of this.playingListeners) l(p);
  }

  private emitSample(): void {
    for (const l of this.listeners) l(this._currentSample);
  }
}
