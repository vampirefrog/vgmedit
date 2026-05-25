/**
 * Main-thread facade for the libvgm-backed renderer. Offloads work to a
 * Web Worker so the WASM render doesn't freeze the UI.
 *
 * Single entry point: `renderVgmToPcm(bytes, sampleRate)` posts the bytes
 * to a long-lived worker, awaits the reply, and resolves with the
 * Float32 PCM the worker rendered. The worker keeps its own libvgm
 * module instance and reuses it across requests, so subsequent renders
 * skip the WASM load cost.
 *
 * Pre-rendering the whole file was chosen for simplicity in this first
 * cut: editor seeks become cheap AudioBufferSource offsets, waveform
 * and spectrogram queries are random-access reads into the typed
 * array, and edits invalidate the PCM cleanly.
 */

export interface RenderedPcm {
  /** Interleaved stereo float samples in [-1, 1]; length = frames * 2. */
  data: Float32Array;
  /** Frame count (one frame = one L+R sample pair). */
  frames: number;
  /** Sample rate the player rendered at. */
  sampleRate: number;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, {
  resolve: (pcm: RenderedPcm) => void;
  reject: (err: Error) => void;
}>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./libvgm.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{
    id: number;
    frames?: number;
    sampleRate?: number;
    pcm?: Float32Array;
    error?: string;
  }>) => {
    const slot = pending.get(e.data.id);
    if (!slot) return;
    pending.delete(e.data.id);
    if (e.data.error) {
      slot.reject(new Error(e.data.error));
    } else if (e.data.pcm && e.data.frames !== undefined && e.data.sampleRate !== undefined) {
      slot.resolve({ data: e.data.pcm, frames: e.data.frames, sampleRate: e.data.sampleRate });
    } else {
      slot.reject(new Error('worker returned malformed response'));
    }
  };
  worker.onerror = (e) => {
    // Surface worker-level errors to any in-flight requests; the next
    // call lazily respawns a fresh worker.
    for (const slot of pending.values()) slot.reject(new Error(e.message || 'worker error'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function renderVgmToPcm(bytes: Uint8Array, sampleRate: number): Promise<RenderedPcm> {
  const id = nextId++;
  const w = getWorker();
  return new Promise<RenderedPcm>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Copy the bytes — the caller may keep the original around and we
    // don't want to risk a detached buffer if we transferred them.
    const owned = new Uint8Array(bytes.length);
    owned.set(bytes);
    w.postMessage({ id, bytes: owned, sampleRate }, [owned.buffer]);
  });
}
