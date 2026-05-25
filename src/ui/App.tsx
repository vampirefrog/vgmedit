/**
 * Top-level app shell.
 *
 * Layout (vertical):
 *   - Toolbar
 *   - Timeline pane (tracks + ruler + overlay)
 *   - Bottom pane: CommandList (left) + Inspector (right)
 *
 * Owns the AudioRenderer instance. The renderer is (re-)created whenever
 * the store's pre-rendered PCM updates: initial file load, after an edit,
 * and after undo/redo. Cursor position carries across instances so
 * playback resumes at the playhead.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../state/store.js';
import { Timeline } from './timeline/Timeline.js';
import { CommandList } from './CommandList.js';
import { Inspector } from './Inspector.js';
import { Toolbar } from './Toolbar.js';
import { DropZone } from './DropZone.js';
import { HorizontalSplitter } from './Splitter.js';
import { WorkletVgmAudioRenderer } from '../audio/worklet-renderer.js';
import type { AudioRenderer } from '../audio/types.js';

const MIN_BOTTOM_HEIGHT = 120;
const MIN_TIMELINE_HEIGHT = 160;

export function App() {
  const file = useEditorStore((s) => s.file);
  const setPlayCursor = useEditorStore((s) => s.setPlayCursor);
  const cursor = useEditorStore((s) => s.cursor);
  const playing = useEditorStore((s) => s.playing);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const loopSample = useEditorStore((s) => s.loopSample);
  const revision = useEditorStore((s) => s.revision);
  const mutedChips = useEditorStore((s) => s.mutedChips);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const [audio, setAudio] = useState<AudioRenderer | null>(null);
  const [bottomHeight, setBottomHeight] = useState(320);
  /** Lazily-created AudioContext shared across renderer instances.
   *  Created on the user's first play gesture (browsers disallow audio
   *  contexts that haven't been resumed by a gesture). Reused across
   *  edits so we don't churn through OS audio sessions. */
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Rebuild the audio renderer whenever the file or revision changes.
  // Each renderer owns its own libvgm instance inside the AudioWorklet;
  // on edits we dispose the old one and open a new one with the
  // freshly-serialized bytes so playback reflects the current file.
  // Cursor + playing state carry across so playback resumes seamlessly.
  useEffect(() => {
    if (!file) {
      audio?.dispose();
      setAudio(null);
      setPlaying(false);
      return;
    }
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({ sampleRate: 44100 });
    }
    const wasPlaying = audio?.playing ?? false;
    const initial = audio?.currentSample ?? cursor;
    audio?.dispose();
    const next = new WorkletVgmAudioRenderer({
      ctx: audioCtxRef.current,
      bytes: file.serialize(),
      sampleRate: 44100,
      initialSample: initial,
      loopSample: useEditorStore.getState().loopSample,
    });
    const unsubA = next.onSampleAdvance((s) => setPlayCursor(s));
    const unsubP = next.onPlayingChange((p) => {
      setPlaying(p);
      // Reaper-style: when playback ends (manual pause, natural EOF,
      // seek-induced stop), snap the play cursor back to the edit cursor.
      if (!p) setPlayCursor(useEditorStore.getState().cursor);
    });
    setAudio(next);
    if (wasPlaying) void next.play();
    return () => { unsubA(); unsubP(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, revision]);

  // Keep the audio playhead aligned with the edit cursor whenever it
  // moves — applies both when stopped (so the next play() resumes from
  // the clicked position) and during playback (clicks immediately seek
  // the live audio to the new position).
  useEffect(() => {
    if (!audio) return;
    if (Math.abs(audio.currentSample - cursor) > 1) {
      void audio.seek(cursor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio, cursor]);

  // Push loop-point changes to the running renderer so the next loop
  // iteration honors the new wrap-back sample.
  useEffect(() => {
    audio?.setLoop(loopSample);
  }, [audio, loopSample]);

  // Apply every chip's mute state when the renderer (re)builds or the
  // mute set changes. libvgm's mute is sticky across the player's
  // lifetime, so a fresh renderer needs to be told about every mute;
  // the chips not in the set get an explicit "unmute" so they don't
  // inherit stale state from a previous renderer.
  useEffect(() => {
    const file = useEditorStore.getState().file;
    if (!audio || !file) return;
    for (const chip of file.usedChips()) {
      audio.setChipMuted(chip, mutedChips.has(chip));
    }
  }, [audio, mutedChips]);

  // Window-level keyboard handler:
  //   - Space              → play / pause
  //   - Delete / Backspace → delete the current selection (waits trimmed)
  //   - Ctrl/Cmd+Z         → undo
  //   - Ctrl/Cmd+Y or
  //     Ctrl/Cmd+Shift+Z   → redo
  // Editable elements (inspector text inputs) get a free pass so the
  // shortcuts don't fight with built-in text editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editable = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (editable) return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!audio) return;
        if (audio.playing) {
          audio.pause();
          setPlaying(false);
          return;
        }
        const state = useEditorStore.getState();
        if (e.shiftKey && state.selection) {
          // Shift+Space: loop the selected sample range. The renderer
          // seeks back to selection.start on every cross of selection.end
          // so the user can audition the loop transition exactly as
          // libvgm would play it.
          const sel = state.selection;
          (audio as WorkletVgmAudioRenderer).setSelectionLoop?.({ start: sel.start, end: sel.end });
          void (async () => {
            await audio.seek(sel.start);
            await audio.play();
            setPlaying(true);
          })();
        } else {
          // Normal Space: play from the edit cursor. Clear any
          // selection-loop mode so playback uses the file's loop point
          // (or runs to EOF and stops).
          (audio as WorkletVgmAudioRenderer).setSelectionLoop?.(null);
          const startSample = state.cursor;
          void (async () => {
            await audio.seek(startSample);
            await audio.play();
            setPlaying(true);
          })();
        }
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
        return;
      }
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        void redo();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const rc = deleteSelection();
        if (rc === 0) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelection, undo, redo, audio, setPlaying]);

  // Keep the toolbar's play/pause icon mirrored to audio.playing — the
  // `playing` selector subscription forces a re-render when it changes.
  void playing;

  function onResize(newHeight: number) {
    const max = Math.max(MIN_BOTTOM_HEIGHT, window.innerHeight - MIN_TIMELINE_HEIGHT);
    setBottomHeight(Math.max(MIN_BOTTOM_HEIGHT, Math.min(max, newHeight)));
  }

  return (
    <div className="app">
      <Toolbar audio={audio} />
      <div className="main">
        <div style={{ flex: 1, minHeight: MIN_TIMELINE_HEIGHT, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Timeline />
        </div>
        <HorizontalSplitter onResize={onResize} paneHeight={bottomHeight} />
        <div className="bottom-pane" style={{ flex: `0 0 ${bottomHeight}px`, height: bottomHeight }}>
          <CommandList />
          <Inspector />
        </div>
      </div>
      <DropZone />
    </div>
  );
}
