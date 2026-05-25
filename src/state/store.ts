/**
 * Global editor state. One Zustand store keeps things simple; we can split
 * into slices if it grows.
 *
 * Timeline coordinates are in samples (44100 Hz). The visible view is a
 * (startSample, endSample) range, with the cursor and selection also in
 * samples. The command list filter is derived from the selection.
 */
import { create } from 'zustand';
import { VgmFile, type VgmChipId } from '../wasm/index.js';

export interface TimelineView {
  startSample: number;
  endSample: number;
}

export interface SampleRange {
  start: number;
  end: number;
}

export interface EditorState {
  // File
  file: VgmFile | null;
  fileName: string | null;
  loadError: string | null;
  totalSamples: number;
  commandCount: number;
  usedChips: VgmChipId[];
  /** Sample time of the loop-start command, or null when no loop is set. */
  loopSample: number | null;
  /** Command index of the loop-start command, or null when no loop is set. */
  loopIndex: number | null;
  /** Bumped whenever the loaded file mutates. Components that read derived
   *  data (heatmap, formatted commands, args) subscribe to this to know
   *  when to re-read from the C side. */
  revision: number;

  // Timeline
  view: TimelineView;
  cursor: number;            // sample position
  selection: SampleRange | null;

  // Playback (stub until audio renderer is wired)
  playing: boolean;

  // Selected command in the list (for the inspector)
  selectedCommandIndex: number | null;

  // Mutations
  loadFile: (data: Uint8Array, name: string) => Promise<void>;
  setView: (v: TimelineView) => void;
  setCursor: (sample: number) => void;
  setSelection: (s: SampleRange | null) => void;
  setSelectedCommand: (index: number | null) => void;
  setPlaying: (p: boolean) => void;
  zoomBy: (factor: number, anchorSample: number) => void;
  panBy: (deltaSamples: number) => void;

  // Edit ops — return 0 on success, negative on failure. All run through
  // VgmFile which refreshes commandCount/header in-place; we then bump
  // revision and re-derive store state that depends on the file.
  insertCommand: (beforeIndex: number, opcode: number, args: Uint8Array) => number;
  updateCommand: (index: number, opcode: number, args: Uint8Array) => number;
  deleteCommand: (index: number) => number;

  /** Set the loop point to the command at the given index, or clear it
   *  by passing null. Pins to the command, not the file offset, so it
   *  survives nearby inserts/deletes. */
  setLoopIndex: (index: number | null) => number;
  /** Convenience: find the command at the current cursor sample and set
   *  the loop there. */
  setLoopAtCursor: () => number;

  /** Delete the current selection. Trims boundary-crossing waits. Cursor
   *  snaps to the (now-shortened) selection start; selection clears. */
  deleteSelection: () => number;
}

function clampView(view: TimelineView, total: number): TimelineView {
  const min = 1;
  const requestedSpan = Math.max(min, Math.floor(view.endSample - view.startSample));
  // If the requested span is bigger than the file, show the whole thing.
  if (total > 0 && requestedSpan >= total) {
    return { startSample: 0, endSample: Math.max(min, total) };
  }
  // Otherwise preserve the span — shift `start` so the view sits flush
  // against whichever edge it was pushed against, rather than shrinking
  // (which would read as an accidental zoom-in).
  const maxStart = Math.max(0, total - requestedSpan);
  const start = Math.max(0, Math.min(maxStart, Math.floor(view.startSample)));
  return { startSample: start, endSample: start + requestedSpan };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  file: null,
  fileName: null,
  loadError: null,
  totalSamples: 0,
  commandCount: 0,
  usedChips: [],
  loopSample: null,
  loopIndex: null,
  revision: 0,

  view: { startSample: 0, endSample: 1 },
  cursor: 0,
  selection: null,
  playing: false,
  selectedCommandIndex: null,

  loadFile: async (data, name) => {
    const prev = get().file;
    if (prev) prev.close();
    set({ file: null, fileName: name, loadError: null, selectedCommandIndex: null });
    try {
      const file = await VgmFile.open(data);
      const total = file.header.totalSamples || 1;
      const loopIdx = file.getLoopIndex();
      const loopSample = loopIdx === null ? null : file.getCommand(loopIdx).sampleTime;
      set({
        file,
        fileName: name,
        loadError: null,
        totalSamples: total,
        commandCount: file.commandCount,
        usedChips: file.usedChips(),
        loopIndex: loopIdx,
        loopSample,
        revision: 0,
        view: { startSample: 0, endSample: total },
        cursor: 0,
        selection: null,
      });
    } catch (err) {
      set({ loadError: (err as Error).message ?? String(err) });
    }
  },

  setView: (v) => set((s) => ({ view: clampView(v, s.totalSamples) })),

  setCursor: (sample) => set((s) => ({
    cursor: Math.max(0, Math.min(s.totalSamples, Math.floor(sample))),
  })),

  setSelection: (sel) => set((s) => {
    if (!sel) return { selection: null };
    const total = s.totalSamples;
    // Clamp both endpoints into the valid sample range so a drag that
    // wandered past either end of the file (or out of the overlay box)
    // can't produce a selection that extends beyond what actually exists.
    const a = Math.max(0, Math.min(total, sel.start));
    const b = Math.max(0, Math.min(total, sel.end));
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start < 1) return { selection: null };
    return { selection: { start: Math.floor(start), end: Math.floor(end) } };
  }),

  setSelectedCommand: (index) => set({ selectedCommandIndex: index }),

  setPlaying: (p) => set({ playing: p }),

  zoomBy: (factor, anchorSample) =>
    set((s) => {
      const v = s.view;
      const span = v.endSample - v.startSample;
      const newSpan = Math.max(64, Math.min(s.totalSamples, span / factor));
      // Keep `anchorSample` at the same screen offset
      const anchorFrac = (anchorSample - v.startSample) / span;
      const start = anchorSample - anchorFrac * newSpan;
      const end = start + newSpan;
      return { view: clampView({ startSample: start, endSample: end }, s.totalSamples) };
    }),

  panBy: (deltaSamples) =>
    set((s) => {
      const v = s.view;
      return {
        view: clampView(
          { startSample: v.startSample + deltaSamples, endSample: v.endSample + deltaSamples },
          s.totalSamples,
        ),
      };
    }),

  insertCommand: (beforeIndex, opcode, args) => {
    const file = get().file;
    if (!file) return -1;
    const rc = file.insertCommand(beforeIndex, opcode, args);
    if (rc === 0) afterEdit(set, file);
    return rc;
  },
  updateCommand: (index, opcode, args) => {
    const file = get().file;
    if (!file) return -1;
    const rc = file.updateCommand(index, opcode, args);
    if (rc === 0) afterEdit(set, file);
    return rc;
  },
  deleteCommand: (index) => {
    const file = get().file;
    if (!file) return -1;
    const rc = file.deleteCommand(index);
    if (rc === 0) {
      afterEdit(set, file);
      // Keep selectedCommandIndex valid — drop or shift it.
      const sel = get().selectedCommandIndex;
      if (sel !== null) {
        if (sel === index) set({ selectedCommandIndex: null });
        else if (sel > index) set({ selectedCommandIndex: sel - 1 });
      }
    }
    return rc;
  },

  setLoopIndex: (index) => {
    const file = get().file;
    if (!file) return -1;
    const rc = file.setLoopIndex(index);
    if (rc === 0) afterEdit(set, file);
    return rc;
  },

  setLoopAtCursor: () => {
    const file = get().file;
    if (!file) return -1;
    const idx = file.findCommandIndexAtSample(get().cursor);
    if (idx < 0) return -4;
    const rc = file.setLoopIndex(idx);
    if (rc === 0) afterEdit(set, file);
    return rc;
  },

  deleteSelection: () => {
    const { file, selection } = get();
    if (!file || !selection) return -4;
    const rc = file.deleteRange(selection.start, selection.end);
    if (rc === 0) {
      afterEdit(set, file);
      // Snap cursor to where the cut joined and clear the (now-stale)
      // selection. Selected command may have moved/gone — drop it too.
      set({
        cursor: selection.start,
        selection: null,
        selectedCommandIndex: null,
      });
    }
    return rc;
  },
}));

/** Refresh store state derived from the (just-mutated) VgmFile. */
function afterEdit(set: (partial: Partial<EditorState>) => void, file: VgmFile): void {
  const loopIdx = file.getLoopIndex();
  const loopSample = loopIdx === null ? null : file.getCommand(loopIdx).sampleTime;
  set({
    commandCount: file.commandCount,
    totalSamples: file.header.totalSamples || 1,
    usedChips: file.usedChips(),
    loopIndex: loopIdx,
    loopSample,
    revision: useEditorStore.getState().revision + 1,
  });
}
