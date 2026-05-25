/**
 * Audio rendering abstraction.
 *
 * Defines the surface the editor uses to render and play back a VGM file.
 * Concrete implementations:
 *   - StubAudioRenderer (now): no audio, just a clock; lets us wire UI today.
 *   - LibVgmAudioRenderer (later): libvgm via WASM feeding Web Audio API.
 *
 * Seeking strategy is fixed by the editor spec:
 *   - Seek forward: render from currentSample → target.
 *   - Seek backward: render from 0 → target.
 *   - After any edit: invalidate(fromSample = 0) and the next seek re-renders.
 *
 * Concrete implementations should honor these semantics; the AudioRenderer
 * interface itself is intentionally narrow so optimisations (incremental
 * re-render from the earliest edited command) can be layered in later
 * without changing callers.
 */
import type { VgmFile } from '../wasm/index.js';

export type SampleAdvanceListener = (sample: number) => void;
export type PlayingChangeListener = (playing: boolean) => void;

export interface AudioRenderer {
  readonly currentSample: number;
  readonly totalSamples: number;
  readonly playing: boolean;
  readonly sampleRate: number;

  /** Begin playback from currentSample. Resolves immediately; the renderer
   *  emits sample-advance events as samples are produced. */
  play(): Promise<void>;

  /** Stop playback (keeps currentSample where it is). */
  pause(): void;

  /** Move the playhead. Internally chooses forward-from-cursor vs
   *  rewind-and-render based on direction, per the spec. */
  seek(targetSample: number): Promise<void>;

  /** Discard rendered state from `fromSample` (default 0) onward. Called by
   *  the editor after any command edit. The next seek/play will re-render
   *  starting from that point. */
  invalidate(fromSample?: number): void;

  /** Configure looping. When `sample` is non-null, on reaching the end of
   *  the file playback wraps back to that sample and continues. Pass null
   *  to disable looping. Takes effect at the next loop iteration if
   *  playback is in flight. */
  setLoop(sample: number | null): void;

  /** Mute / unmute a chip (by vgm_chip_t id) on the live player. Takes
   *  effect immediately. */
  setChipMuted(chipId: number, muted: boolean): void;

  /** Subscribe to playhead movement. Returns an unsubscribe fn. */
  onSampleAdvance(listener: SampleAdvanceListener): () => void;

  /** Subscribe to play/pause transitions (including the natural
   *  end-of-file transition). Returns an unsubscribe fn. */
  onPlayingChange(listener: PlayingChangeListener): () => void;

  /** Release any platform resources. */
  dispose(): void;
}

export interface AudioRendererOptions {
  file: VgmFile;
  sampleRate?: number;     // default VGM_SAMPLE_RATE
}
