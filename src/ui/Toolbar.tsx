/**
 * Top toolbar: file picker, transport controls, cursor display.
 *
 * The transport buttons drive an AudioRenderer passed in by the App. Until
 * the libvgm WASM build lands the renderer is the stub clock; the UI is
 * identical regardless of backend so this wiring stays put.
 */
import { useRef } from 'react';
import { useEditorStore } from '../state/store.js';
import { VGM_SAMPLE_RATE } from '../wasm/index.js';
import type { AudioRenderer } from '../audio/types.js';

interface ToolbarProps {
  audio: AudioRenderer | null;
}

export function Toolbar({ audio }: ToolbarProps) {
  const fileName = useEditorStore((s) => s.fileName);
  const loadError = useEditorStore((s) => s.loadError);
  const loadFile = useEditorStore((s) => s.loadFile);
  const cursor = useEditorStore((s) => s.cursor);
  const playing = useEditorStore((s) => s.playing);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const totalSamples = useEditorStore((s) => s.totalSamples);

  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const buf = await file.arrayBuffer();
    let bytes: Uint8Array = new Uint8Array(buf);
    // VGZ (gzipped VGM) check — gzip magic 1F 8B.
    if (bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
      bytes = await gunzip(bytes);
    }
    await loadFile(bytes, file.name);
  }

  async function togglePlay() {
    if (!audio) return;
    if (audio.playing) {
      audio.pause();
      setPlaying(false);
    } else {
      await audio.play();
      setPlaying(true);
    }
  }

  return (
    <div className="toolbar">
      <button onClick={() => inputRef.current?.click()}>Open VGM…</button>
      <input
        ref={inputRef}
        type="file"
        accept=".vgm,.vgz,application/octet-stream"
        style={{ display: 'none' }}
        onChange={(e) => handleFiles(e.target.files)}
      />
      {fileName && <span style={{ color: 'var(--text-dim)' }}>{fileName}</span>}
      {loadError && <span style={{ color: '#ff6b6b' }}>error: {loadError}</span>}
      <span className="spacer" />
      <button onClick={togglePlay} disabled={!audio}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button
        disabled={!audio}
        onClick={() => {
          if (!audio) return;
          audio.pause();
          setPlaying(false);
          void audio.seek(0);
        }}
      >
        ⏮
      </button>
      <span className="time">
        {(cursor / VGM_SAMPLE_RATE).toFixed(3)}s / {(totalSamples / VGM_SAMPLE_RATE).toFixed(3)}s
      </span>
    </div>
  );
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
