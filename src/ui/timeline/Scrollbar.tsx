/**
 * Horizontal scrollbar that mirrors the timeline view onto the full file.
 *
 * The thumb width = view-span / total-samples (clamped to a usable minimum),
 * thumb position = view-start / total. Dragging the thumb pans the view
 * preserving its span; clicking on the track jumps so the thumb centers on
 * the click.
 *
 * The component is otherwise self-contained: it reads view/total from the
 * store and writes back via setView, so the parent only needs to mount it.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../state/store.js';

const MIN_THUMB_WIDTH = 24;

export function TimelineScrollbar() {
  const view = useEditorStore((s) => s.view);
  const total = useEditorStore((s) => s.totalSamples);
  const setView = useEditorStore((s) => s.setView);

  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(1, Math.floor(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (total <= 0) return null;

  const span = Math.max(1, view.endSample - view.startSample);
  const thumbFrac = Math.min(1, span / total);
  let thumbWidth = thumbFrac * width;
  if (thumbWidth < MIN_THUMB_WIDTH && width > MIN_THUMB_WIDTH) thumbWidth = MIN_THUMB_WIDTH;
  const usableTravel = Math.max(1, width - thumbWidth);
  const startFrac = total > span ? view.startSample / (total - span) : 0;
  const thumbLeft = startFrac * usableTravel;

  const dragRef = useRef<{ startX: number; startStart: number } | null>(null);

  function pxToStart(thumbLeftPx: number): number {
    const frac = Math.max(0, Math.min(1, thumbLeftPx / usableTravel));
    return frac * Math.max(0, total - span);
  }

  function onThumbPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startStart: view.startSample };
  }
  function onThumbPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const startThumbLeft = (dragRef.current.startStart / Math.max(1, total - span)) * usableTravel;
    const newStart = pxToStart(startThumbLeft + dx);
    setView({ startSample: newStart, endSample: newStart + span });
  }
  function onThumbPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    // Center thumb on the click position.
    const targetLeft = Math.max(0, Math.min(usableTravel, px - thumbWidth / 2));
    const newStart = pxToStart(targetLeft);
    setView({ startSample: newStart, endSample: newStart + span });
  }

  return (
    <div
      ref={trackRef}
      onPointerDown={onTrackPointerDown}
      style={{
        position: 'relative',
        height: 12,
        background: 'var(--bg-2)',
        borderTop: '1px solid var(--border)',
        cursor: 'pointer',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      <div
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: thumbLeft,
          width: thumbWidth,
          background: 'var(--bg-3)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          cursor: 'grab',
        }}
      />
    </div>
  );
}
