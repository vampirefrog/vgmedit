/**
 * Web Worker: renders a VGM byte stream to Float32 stereo PCM via libvgm.
 *
 * Vite bundles this as a separate module (instantiated from libvgm.ts via
 * `new Worker(new URL('./libvgm.worker.ts', import.meta.url), { type: 'module' })`).
 * Running here keeps the WASM render — which can spend hundreds of
 * milliseconds emulating chips even at the ~25× real-time we've measured
 * for QSound — off the main thread, so the UI doesn't freeze while a
 * file (or an edit re-render) is being rendered.
 *
 * Protocol: main thread posts `{ id, bytes, sampleRate }`. Worker replies
 * with `{ id, frames, sampleRate, pcm }` on success or `{ id, error }` on
 * failure. The PCM buffer is transferred (zero-copy) back across the
 * worker boundary.
 */
import createVgmCore from './vgmcore.js';

interface RenderRequest {
  id: number;
  bytes: Uint8Array;
  sampleRate: number;
  /** Optional vgm_chip_t to isolate: every other chip is muted before
   *  rendering so the resulting PCM contains only this chip's audio.
   *  Used by the per-chip waveform / spectrogram visualisations. */
  isolateChip?: number;
}

const CHUNK_FRAMES = 4096;
let modPromise: ReturnType<typeof createVgmCore> | null = null;

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  const { id, bytes, sampleRate, isolateChip } = e.data;
  try {
    if (!modPromise) modPromise = createVgmCore();
    const mod = await modPromise;

    const dataPtr = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, dataPtr);
    const player = mod._libvgm_open(dataPtr, bytes.length, sampleRate);
    mod._free(dataPtr);
    if (!player) throw new Error('libvgm_open failed');

    try {
      if (isolateChip !== undefined) {
        // Mute everything, then un-mute the target chip — gives us its
        // contribution only.
        mod._libvgm_set_all_chips_muted(player, 1);
        mod._libvgm_set_chip_muted(player, isolateChip, 0);
      }

      const total = Number(mod._libvgm_total_samples(player));
      if (total <= 0) throw new Error('libvgm reports zero total samples');

      const pcm = new Float32Array(total * 2);
      const scratchPtr = mod._malloc(CHUNK_FRAMES * 4);
      let outFrames = 0;
      while (outFrames < total) {
        const want = Math.min(CHUNK_FRAMES, total - outFrames);
        const got = mod._libvgm_render_s16(player, scratchPtr, want);
        if (got === 0) break;
        const src = new Int16Array(mod.HEAPU8.buffer, scratchPtr, got * 2);
        for (let i = 0; i < src.length; i++) {
          pcm[outFrames * 2 + i] = src[i] / 32768;
        }
        outFrames += got;
      }
      mod._free(scratchPtr);

      // Transfer the buffer back zero-copy.
      (self as unknown as Worker).postMessage(
        { id, frames: outFrames, sampleRate, pcm },
        [pcm.buffer],
      );
    } finally {
      mod._libvgm_close(player);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
