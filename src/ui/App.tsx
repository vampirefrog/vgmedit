/**
 * Top-level app shell.
 *
 * Layout (vertical):
 *   - Toolbar
 *   - Timeline pane (tracks + ruler + overlay)
 *   - Bottom pane: CommandList (left) + Inspector (right)
 *
 * Owns the AudioRenderer instance — currently a StubAudioRenderer, swapped
 * for a libvgm-backed implementation later. The renderer is rebuilt whenever
 * the loaded file changes.
 */
import { useEffect, useState } from 'react';
import { useEditorStore } from '../state/store.js';
import { Timeline } from './timeline/Timeline.js';
import { CommandList } from './CommandList.js';
import { Inspector } from './Inspector.js';
import { Toolbar } from './Toolbar.js';
import { DropZone } from './DropZone.js';
import { HorizontalSplitter } from './Splitter.js';
import { StubAudioRenderer } from '../audio/stub.js';
import type { AudioRenderer } from '../audio/types.js';

const MIN_BOTTOM_HEIGHT = 120;
const MIN_TIMELINE_HEIGHT = 160;

export function App() {
  const file = useEditorStore((s) => s.file);
  const setCursor = useEditorStore((s) => s.setCursor);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const revision = useEditorStore((s) => s.revision);

  const [audio, setAudio] = useState<AudioRenderer | null>(null);
  const [bottomHeight, setBottomHeight] = useState(320);

  // Any edit invalidates the renderer state so the next playback / seek
  // re-renders from scratch. (Per spec: edits force full re-render until we
  // optimise that.) Skipping revision === 0 avoids a redundant invalidate
  // right after load.
  useEffect(() => {
    if (audio && revision > 0) audio.invalidate(0);
  }, [audio, revision]);

  function onResize(newHeight: number) {
    // Clamp so neither pane disappears. Upper bound depends on viewport.
    const max = Math.max(MIN_BOTTOM_HEIGHT, window.innerHeight - MIN_TIMELINE_HEIGHT);
    setBottomHeight(Math.max(MIN_BOTTOM_HEIGHT, Math.min(max, newHeight)));
  }

  useEffect(() => {
    if (!file) {
      audio?.dispose();
      setAudio(null);
      return;
    }
    const a = new StubAudioRenderer({ file });
    const unsub = a.onSampleAdvance((s) => setCursor(s));
    setAudio(a);
    return () => {
      unsub();
      a.dispose();
      setPlaying(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

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
