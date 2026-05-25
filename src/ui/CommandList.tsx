/**
 * Virtualized list of VGM commands.
 *
 * - Shows the full command stream by default.
 * - When the timeline has a selection range, the list narrows to commands
 *   whose sample_time falls in [start, end). Filter is recomputed via
 *   useMemo over the command list, then handed to react-virtual.
 * - Clicking a row selects it (sets selectedCommandIndex in the store) and
 *   moves the playhead to that command's sample time.
 * - The formatted text is fetched lazily per visible row from the C side
 *   (snprintf into a scratch buffer). For ~30 visible rows this is trivial.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEditorStore } from '../state/store.js';
import { VGM_SAMPLE_RATE, type VgmFile } from '../wasm/index.js';

const ROW_HEIGHT = 22;

interface FilteredView {
  /** Either an array of file-command-indices, or null meaning "use everything". */
  indices: number[] | null;
  total: number;
}

/** First index `i` such that `arr[i] >= target`. Returns arr.length when
 *  target is greater than every element. */
function bsearchLowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildFilter(file: VgmFile, selStart: number | null, selEnd: number | null): FilteredView {
  if (selStart === null || selEnd === null) return { indices: null, total: file.commandCount };
  const indices: number[] = [];
  // Linear scan — commands are sorted by sample_time so we could binary
  // search to bracket the range; defer that optimisation until we hit it.
  // We pull a range of commands at a time to amortise the malloc/free in
  // getCommand. 4096 is a balance between speed and scratch memory.
  const CHUNK = 4096;
  for (let i = 0; i < file.commandCount; i += CHUNK) {
    const chunk = file.getCommandRange(i, Math.min(file.commandCount, i + CHUNK));
    for (const cmd of chunk) {
      if (cmd.sampleTime >= selEnd) return { indices, total: file.commandCount };
      if (cmd.sampleTime >= selStart) indices.push(cmd.index);
    }
  }
  return { indices, total: file.commandCount };
}

export function CommandList() {
  const file = useEditorStore((s) => s.file);
  const selection = useEditorStore((s) => s.selection);
  const selectedCommandIndex = useEditorStore((s) => s.selectedCommandIndex);
  const setSelectedCommand = useEditorStore((s) => s.setSelectedCommand);
  const setCursor = useEditorStore((s) => s.setCursor);
  const cursor = useEditorStore((s) => s.cursor);
  // Watching commandCount + revision guarantees we recompute the filter and
  // re-render rows after every edit. The file object itself is mutated
  // in place so its reference doesn't change.
  const commandCount = useEditorStore((s) => s.commandCount);
  const revision = useEditorStore((s) => s.revision);

  const filter: FilteredView = useMemo(() => {
    if (!file) return { indices: null, total: 0 };
    return buildFilter(file, selection?.start ?? null, selection?.end ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, selection?.start, selection?.end, commandCount, revision]);

  const visibleCount = filter.indices ? filter.indices.length : filter.total;

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Auto-scroll to the command at the cursor's sample position whenever
  // the cursor moves. Binary search in C-space (~log₂N WASM hops) finds
  // the file-side index, then a sorted-array bsearch maps it into the
  // filtered visual index when a selection is active.
  useEffect(() => {
    if (!file || visibleCount === 0) return;
    const fileIdx = file.findCommandIndexAtSample(cursor);
    if (fileIdx < 0) return;
    let visualIdx = fileIdx;
    if (filter.indices) {
      // Map file index to its position in the filtered list; if `fileIdx`
      // sits in a gap (outside the selection), snap to the nearest
      // visible neighbour rather than scrolling out of range.
      visualIdx = bsearchLowerBound(filter.indices, fileIdx);
      if (visualIdx >= filter.indices.length) visualIdx = filter.indices.length - 1;
    }
    if (visualIdx >= 0 && visualIdx < visibleCount) {
      rowVirtualizer.scrollToIndex(visualIdx, { align: 'center' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, file, visibleCount, revision]);

  if (!file) {
    return (
      <div className="command-pane">
        <div className="pane-header">commands</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
          no file loaded
        </div>
      </div>
    );
  }

  function resolveCommand(visualIndex: number) {
    const fileIndex = filter.indices ? filter.indices[visualIndex] : visualIndex;
    if (!file) return null;
    return {
      fileIndex,
      cmd: file.getCommand(fileIndex),
      formatted: file.formatCommand(fileIndex),
    };
  }

  return (
    <div className="command-pane">
      <div className="pane-header">
        <span>commands</span>
        <span style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>
          {visibleCount.toLocaleString()} / {filter.total.toLocaleString()}
          {filter.indices && ' (filtered by selection)'}
        </span>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((item) => {
            const resolved = resolveCommand(item.index);
            if (!resolved) return null;
            const { fileIndex, cmd, formatted } = resolved;
            const isSelected = selectedCommandIndex === fileIndex;
            const secs = cmd.sampleTime / VGM_SAMPLE_RATE;
            const chip = file!.chipName(cmd.chipId, true);
            return (
              <div
                key={item.key}
                className={`command-row${isSelected ? ' selected' : ''}`}
                style={{
                  position: 'absolute',
                  top: item.start,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
                onClick={() => {
                  setSelectedCommand(fileIndex);
                  setCursor(cmd.sampleTime);
                }}
              >
                <span className="idx">{fileIndex}</span>
                <span className="time">{secs.toFixed(3)}s</span>
                <span className="op">{cmd.opcode.toString(16).padStart(2, '0').toUpperCase()}</span>
                <span className="chip">{chip}</span>
                <span className="args">{cmd.argSize}b</span>
                <span className="desc">{formatted}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
