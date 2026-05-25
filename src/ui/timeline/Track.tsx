/**
 * One timeline row: a label column on the left and a canvas on the right.
 *
 * The canvas is repainted on every relevant change: file, renderer, view
 * range, container width, devicePixelRatio. Width comes from a ResizeObserver
 * on the wrap div so the canvas tracks the pane size without us re-running
 * any layout logic in React.
 *
 * A track may declare itself the "header" of a group of sub-tracks via
 * `expandable`. When `expandable` is set, a chevron is shown to the left of
 * the name; clicking it calls `onToggleExpanded`. The Track itself never
 * collapses — Timeline decides whether to render the associated sub-tracks.
 */
import { useEffect, useRef, useState } from 'react';
import type { TimelineView } from '../../state/store.js';
import type { TrackRenderer } from './renderers.js';

export interface TrackProps {
  renderer: TrackRenderer;
  view: TimelineView;
  meta?: string;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Bumped by the store on every edit; pass through so canvases redraw
   *  even when the renderer instance is stable. */
  revision?: number;
}

export function Track({ renderer, view, meta, expandable, expanded, onToggleExpanded, revision }: TrackProps) {
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
    const widthPx = Math.floor(widthCss * dpr);
    const heightPx = Math.floor(renderer.cssHeight * dpr);
    if (canvas.width !== widthPx) canvas.width = widthPx;
    if (canvas.height !== heightPx) canvas.height = heightPx;
    canvas.style.width = `${widthCss}px`;
    canvas.style.height = `${renderer.cssHeight}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderer.draw(ctx, {
      widthPx,
      heightPx,
      startSample: view.startSample,
      endSample: view.endSample,
    });
  }, [renderer, view.startSample, view.endSample, widthCss, revision]);

  return (
    <div className="track-row" style={{ height: renderer.cssHeight }}>
      <div className="track-label">
        <span className="name">
          {expandable && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleExpanded?.(); }}
              title={expanded ? 'hide waveform / spectrogram' : 'show waveform / spectrogram'}
              style={{
                background: 'transparent',
                border: 0,
                padding: 0,
                marginRight: 6,
                cursor: 'pointer',
                color: 'var(--text-dim)',
                fontSize: 10,
                width: 10,
                display: 'inline-block',
                textAlign: 'center',
              }}
            >
              {expanded ? '▾' : '▸'}
            </button>
          )}
          {renderer.name}
        </span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      <div className="track-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="track-canvas" />
      </div>
    </div>
  );
}
