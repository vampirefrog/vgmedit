/**
 * Fire/heat palette LUT.
 *
 * 256 entries × RGBA. Intensity 0 maps to fully transparent so the background
 * (dark canvas) shows through; the higher the intensity the hotter the color:
 * black → deep red → orange → yellow → white.
 *
 * Why this shape: it matches what users expect from a heatmap, and the
 * monotonic luminance ramp means stacking commands always reads as "more"
 * rather than crossing perceptual boundaries.
 */

export const FIRE_PALETTE: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r = 0, g = 0, b = 0;
    if (t < 1 / 3) {
      r = t * 3 * 255;
    } else if (t < 2 / 3) {
      r = 255;
      g = (t - 1 / 3) * 3 * 255;
    } else {
      r = 255;
      g = 255;
      b = (t - 2 / 3) * 3 * 255;
    }
    const o = i * 4;
    lut[o] = r;
    lut[o + 1] = g;
    lut[o + 2] = b;
    // Alpha ramp so very faint hits are barely visible; intensity 0 fully
    // transparent so the dark background shows through.
    lut[o + 3] = i === 0 ? 0 : Math.min(255, 60 + Math.round(t * 195));
  }
  return lut;
})();
