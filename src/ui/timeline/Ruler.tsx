/**
 * Time ruler drawn into a single-row canvas above the tracks.
 *
 * Picks a "nice" tick interval (1, 2, 5, 10, 20, 50, 100, 200, 500 ms × 10ⁿ)
 * based on the current zoom, then draws tick marks and labels. Time is shown
 * as seconds since the start of the file.
 */
import { useEffect, useRef, useState } from 'react';
import { VGM_SAMPLE_RATE } from '../../wasm/index.js';
import type { TimelineView } from '../../state/store.js';

function pickInterval(secondsPerPixel: number): number {
  const targetPx = 80;
  const target = targetPx * secondsPerPixel;
  const niceSteps = [
    1e-3, 2e-3, 5e-3,
    0.01, 0.02, 0.05,
    0.1, 0.2, 0.5,
    1, 2, 5,
    10, 20, 30, 60,
  ];
  for (const s of niceSteps) if (s >= target) return s;
  return niceSteps[niceSteps.length - 1];
}

function formatTime(sec: number): string {
  if (sec < 1) return `${(sec * 1000).toFixed(0)} ms`;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function Ruler({ view }: { view: TimelineView }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [widthCss, setWidthCss] = useState(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidthCss(Math.max(1, Math.floor(entry.contentRect.width)));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || widthCss <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const heightCss = 22;
    canvas.width = Math.floor(widthCss * dpr);
    canvas.height = Math.floor(heightCss * dpr);
    canvas.style.width = `${widthCss}px`;
    canvas.style.height = `${heightCss}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#16161c';
    ctx.fillRect(0, 0, widthCss, heightCss);

    const startSec = view.startSample / VGM_SAMPLE_RATE;
    const endSec = view.endSample / VGM_SAMPLE_RATE;
    const span = endSec - startSec;
    if (span <= 0) return;
    const secPerPx = span / widthCss;
    const tick = pickInterval(secPerPx);

    const firstTick = Math.ceil(startSec / tick) * tick;
    ctx.fillStyle = '#888899';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let t = firstTick; t <= endSec; t += tick) {
      const x = ((t - startSec) / span) * widthCss;
      ctx.fillStyle = '#3a3a48';
      ctx.fillRect(Math.round(x), heightCss - 7, 1, 7);
      ctx.fillStyle = '#888899';
      ctx.fillText(formatTime(t), Math.round(x) + 3, heightCss / 2);
    }
  }, [view.startSample, view.endSample, widthCss]);

  return (
    <div className="ruler">
      <div style={{ flex: 1, minWidth: 0 }} ref={wrapRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
