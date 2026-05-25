/**
 * TrackRenderer interface and built-in renderers.
 *
 * A track is a horizontal strip drawn into its own <canvas>. The Timeline
 * component creates one canvas per track and calls `draw(ctx, view)` whenever
 * the view changes. Renderers are stateless modulo their construction args
 * (file, chip filter, etc.) — internal caches can be added later without
 * changing the interface.
 *
 * Concrete renderers in this file:
 *   - HeatmapTrackRenderer: heatmap of VGM commands, full-VGM or per-chip.
 *   - WaveformTrackRenderer: placeholder waiting for libvgm audio render.
 *   - SpectrogramTrackRenderer: placeholder waiting for an FFT pipeline.
 */
import { VGM_CHIP_FILTER_ALL, chipBit, type VgmChipId, type VgmFile } from '../../wasm/index.js';
import type { RenderedPcm } from '../../wasm/libvgm.js';
import { fft, hannWindow } from '../../audio/fft.js';
import { FIRE_PALETTE } from './palette.js';

export interface TrackView {
  /** Internal pixel width (canvas width, devicePixelRatio applied). */
  widthPx: number;
  heightPx: number;
  startSample: number;
  endSample: number;
}

export interface TrackRenderer {
  readonly id: string;
  readonly name: string;
  readonly kind: 'heatmap' | 'waveform' | 'spectrogram';
  /** Logical CSS height of the track row. */
  readonly cssHeight: number;
  draw(ctx: CanvasRenderingContext2D, view: TrackView): void;
}

export interface HeatmapTrackOptions {
  id: string;
  name: string;
  file: VgmFile;
  chipFilter?: bigint;       // default: all chips
  cssHeight?: number;
  step?: number;
}

export class HeatmapTrackRenderer implements TrackRenderer {
  readonly id: string;
  readonly name: string;
  readonly kind = 'heatmap' as const;
  readonly cssHeight: number;
  private file: VgmFile;
  private chipFilter: bigint;
  private step: number;

  constructor(opts: HeatmapTrackOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.cssHeight = opts.cssHeight ?? 48;
    this.file = opts.file;
    this.chipFilter = opts.chipFilter ?? VGM_CHIP_FILTER_ALL;
    this.step = opts.step ?? 32;
  }

  draw(ctx: CanvasRenderingContext2D, view: TrackView): void {
    const { widthPx, heightPx, startSample, endSample } = view;
    if (widthPx <= 0 || heightPx <= 0) return;

    // Background — a flat dark fill so transparent palette entries blend in.
    ctx.fillStyle = '#08080c';
    ctx.fillRect(0, 0, widthPx, heightPx);

    const intensity = this.file.computeHeatmap({
      startSample,
      endSample,
      pixelCount: widthPx,
      chipFilter: this.chipFilter,
      step: this.step,
    });

    const img = ctx.createImageData(widthPx, heightPx);
    const data = img.data;
    for (let x = 0; x < widthPx; x++) {
      const v = intensity[x];
      const o = v * 4;
      const r = FIRE_PALETTE[o];
      const g = FIRE_PALETTE[o + 1];
      const b = FIRE_PALETTE[o + 2];
      const a = FIRE_PALETTE[o + 3];
      if (a === 0) continue;
      // Fill column top-to-bottom in one tight loop.
      for (let y = 0; y < heightPx; y++) {
        const di = (y * widthPx + x) * 4;
        data[di] = r;
        data[di + 1] = g;
        data[di + 2] = b;
        data[di + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** Factory helper for a per-chip heatmap row. */
export function makeChipHeatmap(file: VgmFile, chip: VgmChipId, name: string): HeatmapTrackRenderer {
  return new HeatmapTrackRenderer({
    id: `heatmap-chip-${chip}`,
    name,
    file,
    chipFilter: chipBit(chip),
    cssHeight: 36,
  });
}

/* --- Waveform + spectrogram renderers (PCM-backed) ---------------------- */

function drawPlaceholderStrip(
  ctx: CanvasRenderingContext2D,
  view: TrackView,
  label: string,
): void {
  ctx.fillStyle = '#0c0c10';
  ctx.fillRect(0, 0, view.widthPx, view.heightPx);
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  for (let x = 0; x < view.widthPx; x += 14) ctx.fillRect(x, 0, 7, view.heightPx);
  ctx.fillStyle = '#444455';
  ctx.font = `${Math.floor(view.heightPx * 0.28)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 8, view.heightPx / 2);
}

export class WaveformTrackRenderer implements TrackRenderer {
  readonly kind = 'waveform' as const;
  readonly cssHeight = 64;
  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly pcm: RenderedPcm | null,
  ) {}

  draw(ctx: CanvasRenderingContext2D, view: TrackView): void {
    if (!this.pcm) { drawPlaceholderStrip(ctx, view, 'waveform — rendering audio…'); return; }
    const { data, frames } = this.pcm;
    ctx.fillStyle = '#06060a';
    ctx.fillRect(0, 0, view.widthPx, view.heightPx);

    // Zero baseline.
    ctx.fillStyle = '#222230';
    ctx.fillRect(0, Math.floor(view.heightPx / 2), view.widthPx, 1);

    const startSample = Math.max(0, Math.floor(view.startSample));
    const endSample = Math.min(frames, Math.ceil(view.endSample));
    const span = Math.max(1, endSample - startSample);
    const mid = view.heightPx / 2;
    const halfH = view.heightPx / 2;

    ctx.strokeStyle = '#66bbff';
    ctx.lineWidth = 1;
    ctx.beginPath();

    // For each pixel column, find min/max in its sample window and draw a
    // vertical strip from min to max — the standard audio waveform view.
    for (let px = 0; px < view.widthPx; px++) {
      const s0 = startSample + Math.floor((px      / view.widthPx) * span);
      const s1 = startSample + Math.floor(((px + 1) / view.widthPx) * span);
      const hi = Math.min(frames, Math.max(s0 + 1, s1));
      let mn = Infinity, mx = -Infinity;
      // Step through one channel (L) when zoomed in finely, otherwise mix
      // L and R to a mono peak — close enough for visual amplitude.
      for (let s = s0; s < hi; s++) {
        const l = data[s * 2];
        const r = data[s * 2 + 1];
        const v = (l + r) * 0.5;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!isFinite(mn)) continue;
      const y0 = mid - mx * halfH;
      const y1 = mid - mn * halfH;
      ctx.moveTo(px + 0.5, y0);
      ctx.lineTo(px + 0.5, y1 + 0.0001);
    }
    ctx.stroke();
  }
}

const FFT_SIZE = 1024;
const SPEC_RE = new Float32Array(FFT_SIZE);
const SPEC_IM = new Float32Array(FFT_SIZE);

export class SpectrogramTrackRenderer implements TrackRenderer {
  readonly kind = 'spectrogram' as const;
  readonly cssHeight = 96;
  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly pcm: RenderedPcm | null,
  ) {}

  draw(ctx: CanvasRenderingContext2D, view: TrackView): void {
    if (!this.pcm) { drawPlaceholderStrip(ctx, view, 'spectrogram — rendering audio…'); return; }
    const { data, frames, sampleRate } = this.pcm;
    if (view.widthPx <= 0 || view.heightPx <= 0) return;

    // Background.
    ctx.fillStyle = '#06060a';
    ctx.fillRect(0, 0, view.widthPx, view.heightPx);

    const startSample = Math.max(0, Math.floor(view.startSample));
    const endSample = Math.min(frames, Math.ceil(view.endSample));
    const span = Math.max(1, endSample - startSample);
    const halfFft = FFT_SIZE >> 1;

    // Pre-build an image so we do one putImageData rather than per-pixel
    // fill calls. RGBA = widthPx * heightPx * 4.
    const img = ctx.createImageData(view.widthPx, view.heightPx);
    const out = img.data;

    // Map FFT bin -> y pixel using a logarithmic frequency scale. Bin k
    // is at frequency k * sampleRate / FFT_SIZE. We span ~30 Hz to
    // Nyquist for a typical chiptune-friendly view.
    const minHz = 30;
    const maxHz = sampleRate / 2;
    const logMin = Math.log(minHz);
    const logMax = Math.log(maxHz);
    // Precompute y -> bin lookup once per draw.
    const yToBin = new Int32Array(view.heightPx);
    for (let y = 0; y < view.heightPx; y++) {
      // y = 0 is top = high freq, y = h-1 is bottom = low freq.
      const t = 1 - y / Math.max(1, view.heightPx - 1);
      const hz = Math.exp(logMin + (logMax - logMin) * t);
      const bin = Math.round(hz / sampleRate * FFT_SIZE);
      yToBin[y] = Math.max(1, Math.min(halfFft - 1, bin));
    }

    const re = SPEC_RE, im = SPEC_IM;

    for (let px = 0; px < view.widthPx; px++) {
      // Centre an FFT window on the sample that this column represents.
      const centre = startSample + Math.floor((px + 0.5) / view.widthPx * span);
      const s0 = Math.max(0, centre - halfFft);
      const s1 = Math.min(frames, s0 + FFT_SIZE);
      // Fill window (mono mix), zero-padding if near edges.
      for (let i = 0; i < FFT_SIZE; i++) im[i] = 0;
      const have = s1 - s0;
      for (let i = 0; i < have; i++) {
        const l = data[(s0 + i) * 2];
        const r = data[(s0 + i) * 2 + 1];
        re[i] = (l + r) * 0.5;
      }
      for (let i = have; i < FFT_SIZE; i++) re[i] = 0;
      hannWindow(re);
      fft(re, im);

      // Normalise FFT magnitude. The Hann window has a coherent gain of
      // ~0.5 (sum/N), so a full-scale sine yields a peak bin around N/4.
      // Dividing by that gives a normalised value where 1.0 ≈ full-scale,
      // and chiptune bins land in the 0.001..0.3 range that the dB
      // window below resolves into visible colors.
      const norm = 1 / (FFT_SIZE * 0.25);
      // dB window: anything quieter than -70 dB → black, anything louder
      // than -10 dB → top of palette. Chosen by eye against real VGM
      // material — the old [-80, 0] range washed everything to white.
      const DB_LO = -70, DB_HI = -10;
      const DB_RANGE = DB_HI - DB_LO;
      for (let y = 0; y < view.heightPx; y++) {
        const bin = yToBin[y];
        const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) * norm;
        const db = 20 * Math.log10(mag + 1e-9);
        const t = Math.max(0, Math.min(1, (db - DB_LO) / DB_RANGE));
        const o = t * 255 | 0;
        const lutOff = o * 4;
        const di = (y * view.widthPx + px) * 4;
        out[di]     = FIRE_PALETTE[lutOff];
        out[di + 1] = FIRE_PALETTE[lutOff + 1];
        out[di + 2] = FIRE_PALETTE[lutOff + 2];
        out[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}
