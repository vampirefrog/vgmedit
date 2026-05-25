/**
 * AudioRenderer that runs libvgm inside an AudioWorklet processor.
 *
 * The processor (built into public/vgm-realtime-worklet.js by
 * core/wasm/build.sh) carries its own libvgm WASM. From the main thread
 * we just configure it via this.port — load bytes, seek, set loop, etc.
 * Audio rendering happens on the audio thread with no IPC per block, so
 * latency is one AudioContext block (~3 ms at 44.1 kHz / 128 frames)
 * and the main thread is never blocked by render work.
 *
 * The cost of this simpler model is that the libvgm WASM ships twice in
 * the bundle (once in vgmcore.js for parsing / editing / pre-render
 * visualisation, once in the worklet for playback). That's acceptable
 * for an editor app and keeps the runtime model trivial.
 */
import type { AudioRenderer, PlayingChangeListener, SampleAdvanceListener } from './types.js';

export interface WorkletAudioOptions {
  ctx: AudioContext;
  bytes: Uint8Array;
  sampleRate: number;
  initialSample?: number;
  loopSample?: number | null;
}

const moduleReadyByCtx = new WeakMap<AudioContext, Promise<void>>();
function ensureWorklet(ctx: AudioContext): Promise<void> {
  let p = moduleReadyByCtx.get(ctx);
  if (!p) {
    const base = (typeof import.meta.env !== 'undefined' && import.meta.env.BASE_URL) || '/';
    const url = new URL(base + 'vgm-realtime-worklet.js', window.location.href).href;
    p = ctx.audioWorklet.addModule(url);
    moduleReadyByCtx.set(ctx, p);
  }
  return p;
}

export class WorkletVgmAudioRenderer implements AudioRenderer {
  readonly sampleRate: number;
  totalSamples: number = 0;

  private ctx: AudioContext;
  private bytes: Uint8Array;
  private _loopSample: number | null;
  private _currentSample: number;
  private _playing = false;

  private node: AudioWorkletNode | null = null;
  /** Resolves once the worklet processor has signalled 'ready' AND we
   *  have sent it the 'load' command and received its 'loaded' reply. */
  private ready: Promise<void>;
  private disposed = false;

  private listeners = new Set<SampleAdvanceListener>();
  private playingListeners = new Set<PlayingChangeListener>();

  constructor(opts: WorkletAudioOptions) {
    this.ctx = opts.ctx;
    this.bytes = opts.bytes;
    this.sampleRate = opts.sampleRate;
    this._loopSample = opts.loopSample ?? null;
    this._currentSample = opts.initialSample ?? 0;
    this.ready = this.init(opts.initialSample ?? 0);
  }

  private async init(startSample: number): Promise<void> {
    await ensureWorklet(this.ctx);
    if (this.disposed) return;

    const node = new AudioWorkletNode(this.ctx, 'vgm-realtime', { outputChannelCount: [2] });
    this.node = node;

    // Two-stage handshake:
    //   1. processor sends 'ready' once WASM is instantiated
    //   2. we reply with 'load'; processor opens a player and sends 'loaded'
    // The ready promise resolves on step 2.
    await new Promise<void>((resolve) => {
      const onLoadedOrReady = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'ready') {
          node.port.postMessage({
            type: 'load',
            bytes: this.bytes,
            sampleRate: this.sampleRate,
            startSample,
            loopSample: this._loopSample,
          });
        } else if (m.type === 'loaded') {
          this.totalSamples = m.totalSamples;
          // Swap to the steady-state handler.
          node.port.onmessage = (ev) => this.onProcessorMessage(ev);
          resolve();
        }
      };
      node.port.onmessage = onLoadedOrReady;
    });
  }

  private onProcessorMessage(e: MessageEvent): void {
    const m = e.data;
    if (m.type === 'cursor') {
      // Defensive: at least in Firefox the worklet keeps emitting cursor
      // messages for a moment after disconnect() (or the queued ones
      // drain into here late). If we forwarded those, the CommandList /
      // play-cursor display would keep marching forward despite paused.
      if (!this._playing) return;
      this._currentSample = m.sample;
      for (const l of this.listeners) l(m.sample);
    } else if (m.type === 'ended') {
      this.setPlaying(false);
    }
  }

  get currentSample(): number { return this._currentSample; }
  get playing(): boolean { return this._playing; }

  async play(): Promise<void> {
    if (this._playing || this.disposed) return;
    await this.ready;
    if (this.disposed) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // Tell the worklet to resume *before* connecting so the first
    // process() call after connect produces audio rather than silence.
    this.node?.port.postMessage({ type: 'resume' });
    this.node?.connect(this.ctx.destination);
    this.setPlaying(true);
  }

  pause(): void {
    if (!this._playing) return;
    // Tell the worklet to stop rendering / cursor-reporting first; the
    // disconnect alone isn't always enough (Firefox in particular keeps
    // pumping process() briefly after a disconnect).
    this.node?.port.postMessage({ type: 'pause' });
    if (this.node) {
      try { this.node.disconnect(); } catch { /* no-op */ }
    }
    this.setPlaying(false);
  }

  async seek(target: number): Promise<void> {
    const clamped = Math.max(0, Math.floor(target));
    this._currentSample = clamped;
    for (const l of this.listeners) l(clamped);
    this.node?.port.postMessage({ type: 'seek', sample: clamped });
  }

  setLoop(sample: number | null): void {
    this._loopSample = sample;
    this.node?.port.postMessage({ type: 'setLoop', sample });
  }

  setSelectionLoop(range: { start: number; end: number } | null): void {
    this.node?.port.postMessage({ type: 'setSelectionLoop', range });
  }

  invalidate(_fromSample = 0): void { this.pause(); }

  onSampleAdvance(listener: SampleAdvanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPlayingChange(listener: PlayingChangeListener): () => void {
    this.playingListeners.add(listener);
    return () => this.playingListeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    this.node?.port.postMessage({ type: 'close' });
    this.listeners.clear();
    this.playingListeners.clear();
    this.node = null;
  }

  private setPlaying(p: boolean): void {
    if (this._playing === p) return;
    this._playing = p;
    for (const l of this.playingListeners) l(p);
  }
}
