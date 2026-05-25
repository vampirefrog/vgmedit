/**
 * Page-wide drag overlay. Captures dragenter/dragover so the browser doesn't
 * open the file when it lands; loads the first dropped VGM/VGZ via the store.
 *
 * Renders only when a drag is in progress, or when no file is loaded yet
 * (the latter provides an empty-state with a click-to-open button).
 */
import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../state/store.js';

async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

export function DropZone() {
  const fileName = useEditorStore((s) => s.fileName);
  const loadFile = useEditorStore((s) => s.loadFile);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes('Files')) setDragging(true);
    };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDragLeave = (e: DragEvent) => {
      if ((e.target as Node) === document.body) setDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const raw = new Uint8Array(await file.arrayBuffer());
      const bytes = await gunzipIfNeeded(raw);
      await loadFile(bytes, file.name);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [loadFile]);

  async function pickFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const raw = new Uint8Array(await file.arrayBuffer());
    const bytes = await gunzipIfNeeded(raw);
    await loadFile(bytes, file.name);
  }

  if (!dragging && fileName) return null;

  return (
    <div className={`drop-overlay${dragging ? ' dragging' : ''}`}>
      <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        {dragging ? (
          <strong>release to load .vgm or .vgz</strong>
        ) : (
          <>
            <div>drop a <strong>.vgm</strong> or <strong>.vgz</strong> file here</div>
            <div style={{ color: 'var(--text-dim)' }}>or</div>
            <button onClick={() => inputRef.current?.click()}>Choose file…</button>
            <input
              ref={inputRef}
              type="file"
              accept=".vgm,.vgz,application/octet-stream"
              style={{ display: 'none' }}
              onChange={(e) => pickFile(e.target.files)}
            />
          </>
        )}
      </div>
    </div>
  );
}
