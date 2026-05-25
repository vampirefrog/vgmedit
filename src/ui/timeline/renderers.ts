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

/* --- Placeholder renderers for waveform & spectrogram ------------------- */

abstract class PlaceholderRenderer implements TrackRenderer {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly kind: 'waveform' | 'spectrogram';
  readonly cssHeight = 64;
  protected label = 'pending audio renderer';
  draw(ctx: CanvasRenderingContext2D, view: TrackView): void {
    ctx.fillStyle = '#0c0c10';
    ctx.fillRect(0, 0, view.widthPx, view.heightPx);

    // Subtle stripe pattern so the slot is visibly reserved.
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let x = 0; x < view.widthPx; x += 14) ctx.fillRect(x, 0, 7, view.heightPx);

    ctx.fillStyle = '#444455';
    ctx.font = `${Math.floor(view.heightPx * 0.28)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label, 8, view.heightPx / 2);
  }
}

export class WaveformTrackRenderer extends PlaceholderRenderer {
  readonly id: string;
  readonly name: string;
  readonly kind = 'waveform' as const;
  constructor(id: string, name: string) {
    super();
    this.id = id;
    this.name = name;
    this.label = 'waveform — pending libvgm';
  }
}

export class SpectrogramTrackRenderer extends PlaceholderRenderer {
  readonly id: string;
  readonly name: string;
  readonly kind = 'spectrogram' as const;
  constructor(id: string, name: string) {
    super();
    this.id = id;
    this.name = name;
    this.label = 'spectrogram — pending audio render';
  }
}
