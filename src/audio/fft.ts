/**
 * In-place radix-2 Cooley-Tukey FFT. Size must be a power of two.
 *
 * Operates on parallel `re` and `im` Float32Arrays (length = N). After the
 * call, `re[k]` and `im[k]` hold the complex DFT bin k. Includes a Hann
 * window helper since real-world spectrogram chunks need to be windowed
 * to avoid spectral leakage. No allocations on the hot path — caller
 * provides scratch arrays.
 */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place complex FFT. Length must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error('fft: re/im length mismatch');
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // Iterative Cooley-Tukey.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const u = i + j, v = u + (len >> 1);
        const tr = wr * re[v] - wi * im[v];
        const ti = wr * im[v] + wi * re[v];
        re[v] = re[u] - tr;
        im[v] = im[u] - ti;
        re[u] += tr;
        im[u] += ti;
        const tmpWr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = tmpWr;
      }
    }
  }
}

/** Apply a Hann window in place. */
export function hannWindow(buf: Float32Array): void {
  const n = buf.length;
  if (n <= 1) return;
  const k = 2 * Math.PI / (n - 1);
  for (let i = 0; i < n; i++) {
    buf[i] *= 0.5 * (1 - Math.cos(k * i));
  }
}
