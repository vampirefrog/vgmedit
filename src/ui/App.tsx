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
import { useEffect, useState } from 'react';
import { useEditorStore } from '../state/store.js';
import { Timeline } from './timeline/Timeline.js';
import { CommandList } from './CommandList.js';
import { Inspector } from './Inspector.js';
import { Toolbar } from './Toolbar.js';
import { DropZone } from './DropZone.js';
import { HorizontalSplitter } from './Splitter.js';
import { LibVgmAudioRenderer } from '../audio/libvgm.js';
import type { AudioRenderer } from '../audio/types.js';

const MIN_BOTTOM_HEIGHT = 120;
const MIN_TIMELINE_HEIGHT = 160;

export function App() {
  const file = useEditorStore((s) => s.file);
  const setPlayCursor = useEditorStore((s) => s.setPlayCursor);
  const cursor = useEditorStore((s) => s.cursor);
  const playing = useEditorStore((s) => s.playing);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const pcm = useEditorStore((s) => s.pcm);
  const loopSample = useEditorStore((s) => s.loopSample);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const [audio, setAudio] = useState<AudioRenderer | null>(null);
  const [bottomHeight, setBottomHeight] = useState(320);

  // Rebuild the audio renderer whenever the PCM is (re-)rendered. Edits
  // trigger a fresh render upstream; we follow by disposing the previous
  // renderer and instantiating a new one over the new buffer. The cursor
  // sample and playing state carry across so playback resumes seamlessly.
  useEffect(() => {
    if (!file || !pcm) {
      audio?.dispose();
      setAudio(null);
      setPlaying(false);
      return;
    }
    const wasPlaying = audio?.playing ?? false;
    const initial = audio?.currentSample ?? cursor;
    audio?.dispose();
    const next = new LibVgmAudioRenderer({
      pcm,
      initialSample: initial,
      loopSample: useEditorStore.getState().loopSample,
    });
    // Live audio sample-advance drives the play cursor only — the edit
    // cursor stays put so the user's seek/click position is preserved
    // across playback.
    const unsubA = next.onSampleAdvance((s) => setPlayCursor(s));
    const unsubP = next.onPlayingChange((p) => {
      setPlaying(p);
      // Reaper-style "stop returns to start": when playback ends (manual
      // pause, natural EOF, or seek-induced stop), snap the play cursor
      // back to wherever the edit cursor was.
      if (!p) setPlayCursor(useEditorStore.getState().cursor);
    });
    setAudio(next);
    if (wasPlaying) void next.play();
    return () => { unsubA(); unsubP(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, pcm]);

  // While stopped, keep the audio playhead aligned with the edit cursor
  // so the next play() resumes from where the user clicked. During
  // playback the edit cursor is independent of the running audio (clicks
  // move the edit cursor without seeking).
  useEffect(() => {
    if (!audio || audio.playing) return;
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
        } else {
          // Start from the current edit cursor — playback follows from
          // wherever the user last clicked.
          const startSample = useEditorStore.getState().cursor;
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
