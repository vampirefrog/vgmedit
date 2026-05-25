/**
 * Horizontal splitter — a thin bar the user drags vertically to resize the
 * pane below it. The pane size is owned by the parent (controlled component);
 * this just emits delta updates while the pointer is captured.
 */
import { useRef } from 'react';

interface HorizontalSplitterProps {
  /** Called with the proposed new pane height in pixels. Parent clamps. */
  onResize: (newHeight: number) => void;
  /** Current pane height — used to compute the delta during drag. */
  paneHeight: number;
}

export function HorizontalSplitter({ onResize, paneHeight }: HorizontalSplitterProps) {
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startHeight: paneHeight };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    // Bar lives above the resizable pane; dragging up grows the pane.
    const delta = dragRef.current.startY - e.clientY;
    onResize(dragRef.current.startHeight + delta);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        height: 6,
        flexShrink: 0,
        background: 'var(--border)',
        cursor: 'ns-resize',
        position: 'relative',
        userSelect: 'none',
      }}
    >
      {/* Visual grip — three faint dots in the middle */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          color: 'var(--text-dim)',
          fontSize: 8,
          letterSpacing: 2,
          pointerEvents: 'none',
        }}
      >
        ⋯
      </div>
    </div>
  );
}
