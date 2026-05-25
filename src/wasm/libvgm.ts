/**
 * TypeScript facade for the libvgm-backed renderer.
 *
 * Single entry point: `renderVgmToPcm(bytes, sampleRate)` opens the file
 * in libvgm, renders the whole song to interleaved Float32 stereo PCM in
 * one pass, and returns the buffer along with the source's reported total
 * sample count. The PCM array is what the waveform / spectrogram
 * renderers and the Web Audio playback path all consume.
 *
 * "Whole-file pre-render" was chosen for simplicity in this first cut —
 * editor seeks are cheap (just move the AudioBufferSource read head),
 * waveform/spectrogram queries are random-access reads against a plain
 * typed array, and edits invalidate the PCM cleanly. Long files can take
 * a few hundred ms to render; that's hidden behind a Promise so the UI
 * stays responsive.
 */
import createVgmCore, { type VgmCoreModule } from './vgmcore.js';

let modPromise: Promise<VgmCoreModule> | null = null;
function load(): Promise<VgmCoreModule> {
  if (!modPromise) modPromise = createVgmCore();
  return modPromise;
}

export interface RenderedPcm {
  /** Interleaved stereo float samples in [-1, 1]; length = frames * 2. */
  data: Float32Array;
  /** Frame count (one frame = one L+R sample pair). */
  frames: number;
  /** Sample rate the player rendered at. */
  sampleRate: number;
}

const CHUNK_FRAMES = 4096;

export async function renderVgmToPcm(
  bytes: Uint8Array,
  sampleRate: number,
): Promise<RenderedPcm> {
  const mod = await load();

  const dataPtr = mod._malloc(bytes.length);
  mod.HEAPU8.set(bytes, dataPtr);
  const player = mod._libvgm_open(dataPtr, bytes.length, sampleRate);
  mod._free(dataPtr);
  if (!player) throw new Error('libvgm_open failed');

  try {
    // libvgm reports the file's natural length here (including its loop
    // iteration count). With loopCount=1 in the player config, this is
    // intro + one loop pass = exactly what we want to bake into the
    // PCM buffer. libvgm's Render() keeps producing samples past the
    // end (it'd loop forever if asked), so the cap below is what stops
    // us — not a 0-return.
    const total = Number(mod._libvgm_total_samples(player));
    if (total <= 0) throw new Error('libvgm reports zero total samples');

    const out = new Float32Array(total * 2);
    const scratchPtr = mod._malloc(CHUNK_FRAMES * 4);   // s16 stereo = 4 bytes/frame
    let outFrames = 0;

    while (outFrames < total) {
      const want = Math.min(CHUNK_FRAMES, total - outFrames);
      const got = mod._libvgm_render_s16(player, scratchPtr, want);
      if (got === 0) break;
      const src = new Int16Array(mod.HEAPU8.buffer, scratchPtr, got * 2);
      for (let i = 0; i < src.length; i++) {
        out[outFrames * 2 + i] = src[i] / 32768;
      }
      outFrames += got;
    }
    mod._free(scratchPtr);

    return { data: out.subarray(0, outFrames * 2), frames: outFrames, sampleRate };
  } finally {
    mod._libvgm_close(player);
  }
}
