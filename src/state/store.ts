/**
 * Global editor state. One Zustand store keeps things simple; we can split
 * into slices if it grows.
 *
 * Timeline coordinates are in samples (44100 Hz). The visible view is a
 * (startSample, endSample) range, with the cursor and selection also in
 * samples. The command list filter is derived from the selection.
 */
import { create } from 'zustand';
import { VgmFile, VGM_SAMPLE_RATE, type VgmChipId } from '../wasm/index.js';
import { renderVgmToPcm, type RenderedPcm } from '../wasm/libvgm.js';

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

  /** Rendered audio for the current file. null while a render is in
   *  flight (or before the first one finishes). */
  pcm: RenderedPcm | null;
  /** True while the libvgm-backed pre-render is running. */
  pcmRendering: boolean;
  /** Bumped whenever the loaded file mutates. Components that read derived
   *  data (heatmap, formatted commands, args) subscribe to this to know
   *  when to re-read from the C side. */
  revision: number;

  // Timeline
  view: TimelineView;
  /** Edit cursor — where the user last clicked or seeked. Stays put
   *  during playback; used by anything that means "the user's position"
   *  (Inspector "command at cursor", `set loop @ cursor`, etc.). */
  cursor: number;
  /** Playback cursor — live audio position. Driven by the audio renderer
   *  while playing; on pause / stop / end-of-file it snaps back to
   *  `cursor`. Equals `cursor` whenever no audio is playing. */
  playCursor: number;
  selection: SampleRange | null;

  // Playback (stub until audio renderer is wired)
  playing: boolean;

  // Selected command in the list (for the inspector)
  selectedCommandIndex: number | null;

  // Mutations
  loadFile: (data: Uint8Array, name: string) => Promise<void>;
  setView: (v: TimelineView) => void;
  setCursor: (sample: number) => void;
  /** Move the playback cursor without touching the edit cursor.
   *  Called by the audio renderer's sample-advance callback. */
  setPlayCursor: (sample: number) => void;
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

  /** "Trim to selection and set loop point": deletes everything past the
   *  selection's end (boundary wait trimmed), then sets the loop point
   *  to the command at the selection's start. Useful for converting a
   *  user-found loop into a real VGM loop. Single undo step. */
  trimAndSetLoop: () => number;

  /** Returns a fresh VGM byte stream of the current edited file. */
  serializeFile: () => Uint8Array | null;

  // Undo / redo. Pure serialize-and-reopen — every successful edit
  // pushes a snapshot of the pre-edit file onto undoStack; undo pops
  // it, snapshots the current state onto redoStack, and re-opens the
  // popped bytes. History clears on file load. Resolves true if a
  // step happened, false if there was nothing to do.
  canUndo: boolean;
  canRedo: boolean;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
}

// Undo/redo storage. Snapshots are full serialized VGM byte streams; the
// undo machinery re-opens them through VgmFile to restore. Living outside
// the Zustand state keeps the (potentially large) snapshot arrays out of
// React's render path — only the can-undo/can-redo booleans go through
// the store and trigger UI updates.
const MAX_HISTORY = 50;
const undoStack: Uint8Array[] = [];
const redoStack: Uint8Array[] = [];

// Render-token / race guard: each kickoff bumps this so a stale render
// completing after a newer one (or a load) is silently ignored.
let pcmRenderToken = 0;

async function kickOffPcmRender(
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState,
  bytes: Uint8Array,
): Promise<void> {
  const token = ++pcmRenderToken;
  set({ pcm: null, pcmRendering: true });
  try {
    const pcm = await renderVgmToPcm(bytes, VGM_SAMPLE_RATE);
    if (token !== pcmRenderToken) return;  // stale — newer render in flight
    set({ pcm, pcmRendering: false });
  } catch (err) {
    if (token !== pcmRenderToken) return;
    set({ pcmRendering: false, loadError: 'audio render failed: ' + (err as Error).message });
  }
  void get;  // suppress unused
}

function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
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
  pcm: null,
  pcmRendering: false,
  revision: 0,
  canUndo: false,
  canRedo: false,

  view: { startSample: 0, endSample: 1 },
  cursor: 0,
  playCursor: 0,
  selection: null,
  playing: false,
  selectedCommandIndex: null,

  loadFile: async (data, name) => {
    const prev = get().file;
    if (prev) prev.close();
    clearHistory();
    set({ file: null, fileName: name, loadError: null, selectedCommandIndex: null, canUndo: false, canRedo: false });
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
        playCursor: 0,
        selection: null,
      });
      // Pre-render audio in the background so the AudioRenderer +
      // waveform/spectrogram can come online.
      void kickOffPcmRender(set, get, data);
    } catch (err) {
      set({ loadError: (err as Error).message ?? String(err) });
    }
  },

  setView: (v) => set((s) => ({ view: clampView(v, s.totalSamples) })),

  setCursor: (sample) => set((s) => {
    const clamped = Math.max(0, Math.min(s.totalSamples, Math.floor(sample)));
    // When not playing, the play cursor follows the edit cursor so the
    // next play() starts there. While playing, only the edit cursor
    // moves; the audio keeps going from wherever it was.
    return s.playing
      ? { cursor: clamped }
      : { cursor: clamped, playCursor: clamped };
  }),

  setPlayCursor: (sample) => set((s) => ({
    playCursor: Math.max(0, Math.min(s.totalSamples, Math.floor(sample))),
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
    const snap = file.serialize();
    const rc = file.insertCommand(beforeIndex, opcode, args);
    if (rc === 0) {
      undoStack.push(snap);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      afterEdit(set, file);
    }
    return rc;
  },
  updateCommand: (index, opcode, args) => {
    const file = get().file;
    if (!file) return -1;
    const snap = file.serialize();
    const rc = file.updateCommand(index, opcode, args);
    if (rc === 0) {
      undoStack.push(snap);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      afterEdit(set, file);
    }
    return rc;
  },
  deleteCommand: (index) => {
    const file = get().file;
    if (!file) return -1;
    const snap = file.serialize();
    const rc = file.deleteCommand(index);
    if (rc === 0) {
      undoStack.push(snap);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      afterEdit(set, file);
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
    const snap = file.serialize();
    const rc = file.setLoopIndex(index);
    if (rc === 0) {
      undoStack.push(snap);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      afterEdit(set, file);
    }
    return rc;
  },

  setLoopAtCursor: () => {
    const file = get().file;
    if (!file) return -1;
    const idx = file.findCommandIndexAtSample(get().cursor);
    if (idx < 0) return -4;
    const snap = file.serialize();
    const rc = file.setLoopIndex(idx);
    if (rc === 0) {
      undoStack.push(snap);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      afterEdit(set, file);
    }
    return rc;
  },

  deleteSelection: () => {
    const { file, selection } = get();
    if (!file || !selection) return -4;
    const snap = file.serialize();
    const rc = file.deleteRange(selection.start, selection.end);
    if (rc === 0) {
      undoStack.push(snap);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      afterEdit(set, file);
      set({
        cursor: selection.start,
        playCursor: selection.start,
        selection: null,
        selectedCommandIndex: null,
      });
    }
    return rc;
  },

  trimAndSetLoop: () => {
    const { file, selection } = get();
    if (!file || !selection) return -4;
    const snap = file.serialize();
    // 1. Trim everything past selection.end. The boundary wait gets
    //    proportionally shortened by vgm_delete_range.
    let rc = file.deleteRange(selection.end, file.header.totalSamples);
    if (rc !== 0) return rc;
    // 2. Find the command at selection.start (post-delete sample numbers
    //    haven't shifted because we only cut from the end) and mark it
    //    as the loop point.
    const loopIdx = file.findCommandIndexAtSample(selection.start);
    if (loopIdx >= 0) {
      rc = file.setLoopIndex(loopIdx);
      if (rc !== 0) return rc;
    }
    // Single combined undo step.
    undoStack.push(snap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    afterEdit(set, file);
    set({
      cursor: selection.start,
      playCursor: selection.start,
      selection: null,
      selectedCommandIndex: null,
    });
    return 0;
  },

  serializeFile: () => {
    const f = get().file;
    return f ? f.serialize() : null;
  },

  undo: async () => {
    const file = get().file;
    if (!file || undoStack.length === 0) return false;
    const current = file.serialize();
    const target = undoStack.pop()!;
    redoStack.push(current);
    if (redoStack.length > MAX_HISTORY) redoStack.shift();
    await restoreFromBytes(set, get, target);
    return true;
  },

  redo: async () => {
    const file = get().file;
    if (!file || redoStack.length === 0) return false;
    const current = file.serialize();
    const target = redoStack.pop()!;
    undoStack.push(current);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    await restoreFromBytes(set, get, target);
    return true;
  },
}));

/** Refresh store state derived from the (just-mutated) VgmFile. Also
 *  refreshes canUndo/canRedo since this is called after every edit, and
 *  re-renders the audio PCM since the command stream just changed. */
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
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });
  // Trigger a fresh PCM render from the post-edit byte stream.
  const bytes = file.serialize();
  void kickOffPcmRender(set, useEditorStore.getState, bytes);
}

/** Replace the loaded file with one parsed from `bytes`. Used by undo/redo
 *  to restore prior snapshots. Closes the previous VgmFile to release its
 *  WASM allocation, then re-derives all file-dependent store state. */
async function restoreFromBytes(
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState,
  bytes: Uint8Array,
): Promise<void> {
  const old = get().file;
  if (old) old.close();
  const file = await VgmFile.open(bytes);
  const total = file.header.totalSamples || 1;
  const loopIdx = file.getLoopIndex();
  const loopSample = loopIdx === null ? null : file.getCommand(loopIdx).sampleTime;
  const view = get().view;
  // Keep the view's span where possible; just clamp into the new file's
  // bounds so undo/redo doesn't yank the camera around.
  const span = Math.max(1, Math.floor(view.endSample - view.startSample));
  let newView: TimelineView;
  if (span >= total) {
    newView = { startSample: 0, endSample: total };
  } else {
    const start = Math.max(0, Math.min(total - span, Math.floor(view.startSample)));
    newView = { startSample: start, endSample: start + span };
  }
  set({
    file,
    totalSamples: total,
    commandCount: file.commandCount,
    usedChips: file.usedChips(),
    loopIndex: loopIdx,
    loopSample,
    revision: get().revision + 1,
    cursor: Math.max(0, Math.min(total, get().cursor)),
    playCursor: Math.max(0, Math.min(total, get().cursor)),
    selection: null,
    selectedCommandIndex: null,
    view: newView,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });
  // Undo/redo restored the byte stream — re-render its audio too.
  void kickOffPcmRender(set, get, bytes);
}
