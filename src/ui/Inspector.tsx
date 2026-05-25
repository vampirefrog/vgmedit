/**
 * Inspector for the currently selected command + edit controls.
 *
 * Edit operations call into the C library through VgmFile; in this initial
 * cut the C side returns NOT_IMPLEMENTED, so the buttons surface that
 * directly. The UI shape is final — once the C edit ops land they slot in
 * without changing this file.
 */
import { useEffect, useState } from 'react';
import { useEditorStore } from '../state/store.js';
import { VGM_SAMPLE_RATE, type VgmCommand } from '../wasm/index.js';

function hex(byte: number, pad = 2): string {
  return byte.toString(16).padStart(pad, '0').toUpperCase();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function Inspector() {
  const file = useEditorStore((s) => s.file);
  const totalSamples = useEditorStore((s) => s.totalSamples);
  const commandCount = useEditorStore((s) => s.commandCount);
  const selectedCommandIndex = useEditorStore((s) => s.selectedCommandIndex);
  const usedChips = useEditorStore((s) => s.usedChips);
  const view = useEditorStore((s) => s.view);
  const selection = useEditorStore((s) => s.selection);
  const cursor = useEditorStore((s) => s.cursor);
  const revision = useEditorStore((s) => s.revision);
  const loopIndex = useEditorStore((s) => s.loopIndex);
  const loopSample = useEditorStore((s) => s.loopSample);
  const insertCommand = useEditorStore((s) => s.insertCommand);
  const updateCommand = useEditorStore((s) => s.updateCommand);
  const deleteCommand = useEditorStore((s) => s.deleteCommand);
  const setLoopIndex = useEditorStore((s) => s.setLoopIndex);
  const setLoopAtCursor = useEditorStore((s) => s.setLoopAtCursor);

  const [cmd, setCmd] = useState<VgmCommand | null>(null);
  const [formatted, setFormatted] = useState<string>('');
  const [argsHex, setArgsHex] = useState<string>('');
  const [opHex, setOpHex] = useState<string>('');
  const [editStatus, setEditStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!file || selectedCommandIndex === null || selectedCommandIndex >= commandCount) {
      setCmd(null);
      setFormatted('');
      setArgsHex('');
      setOpHex('');
      return;
    }
    const c = file.getCommand(selectedCommandIndex);
    setCmd(c);
    setFormatted(file.formatCommand(selectedCommandIndex));
    setOpHex(hex(c.opcode));
    setArgsHex(bytesToHex(file.commandArgs(selectedCommandIndex)));
    // `revision` is in the dep list so the form reflects the file after
    // edits (chip attribution, args length, etc.).
  }, [file, selectedCommandIndex, commandCount, revision]);

  function parseHexBytes(str: string): Uint8Array | null {
    const cleaned = str.replace(/[\s,]+/g, '');
    if (cleaned.length === 0) return new Uint8Array(0);
    if (cleaned.length % 2 !== 0) return null;
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = parseInt(cleaned.substr(i * 2, 2), 16);
      if (Number.isNaN(byte)) return null;
      out[i] = byte;
    }
    return out;
  }

  function describeRc(label: string, rc: number): string {
    switch (rc) {
      case 0:  return `${label}: ok`;
      case -2: return `${label}: truncated args`;
      case -3: return `${label}: out of memory`;
      case -4: return `${label}: invalid index`;
      case -5: return `${label}: not implemented`;
      case -6: return `${label}: invalid arg`;
      default: return `${label}: rc=${rc}`;
    }
  }

  function readForm(label: string): { opcode: number; args: Uint8Array } | null {
    const opByte = parseInt(opHex, 16);
    if (Number.isNaN(opByte) || opByte < 0 || opByte > 255) {
      setEditStatus(`${label}: invalid opcode`);
      return null;
    }
    const args = parseHexBytes(argsHex);
    if (!args) {
      setEditStatus(`${label}: invalid args hex`);
      return null;
    }
    return { opcode: opByte, args };
  }

  function onDelete() {
    if (!file || selectedCommandIndex === null) return;
    setEditStatus(describeRc('delete', deleteCommand(selectedCommandIndex)));
  }

  function onUpdate() {
    if (!file || selectedCommandIndex === null) return;
    const form = readForm('update');
    if (!form) return;
    setEditStatus(describeRc('update', updateCommand(selectedCommandIndex, form.opcode, form.args)));
  }

  function onInsertBefore() {
    if (!file || selectedCommandIndex === null) return;
    const form = readForm('insert');
    if (!form) return;
    setEditStatus(describeRc('insert', insertCommand(selectedCommandIndex, form.opcode, form.args)));
  }

  if (!file) {
    return (
      <div className="inspector-pane inspector">
        <h3>inspector</h3>
        <p style={{ color: 'var(--text-dim)' }}>load a file to begin.</p>
      </div>
    );
  }

  return (
    <div className="inspector-pane inspector">
      <h3>file</h3>
      <div className="field">
        <label>VGM version</label>
        <div className="mono">v{(file.header.version >> 8).toString(16)}.{(file.header.version & 0xff).toString(16).padStart(2, '0')}</div>
      </div>
      <div className="field">
        <label>total samples</label>
        <div className="mono">{totalSamples.toLocaleString()} ({(totalSamples / VGM_SAMPLE_RATE).toFixed(2)} s)</div>
      </div>
      <div className="field">
        <label>commands</label>
        <div className="mono">{file.commandCount.toLocaleString()}</div>
      </div>
      <div className="field">
        <label>chips ({usedChips.length})</label>
        <div className="mono" style={{ fontSize: 11 }}>
          {usedChips.map((c) => file.chipName(c, true)).join(' · ') || '—'}
        </div>
      </div>
      <div className="field">
        <label>cursor / selection</label>
        <div className="mono" style={{ fontSize: 11 }}>
          cursor: {Math.round(cursor)}<br />
          view: {Math.round(view.startSample)}–{Math.round(view.endSample)}<br />
          selection: {selection ? `${selection.start}–${selection.end}` : '—'}
        </div>
      </div>

      <h3 style={{ marginTop: 18 }}>loop</h3>
      <div className="field">
        <label>loop point</label>
        <div className="mono" style={{ fontSize: 11 }}>
          {loopIndex !== null && loopSample !== null ? (
            <>
              command #{loopIndex} @ {loopSample.toLocaleString()} samples<br />
              ({(loopSample / VGM_SAMPLE_RATE).toFixed(3)}s · loop length {(
                (totalSamples - loopSample) / VGM_SAMPLE_RATE
              ).toFixed(3)}s)
            </>
          ) : '— no loop —'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={() => setEditStatus(describeRc('loop @ cursor', setLoopAtCursor()))}
          title="Set loop point to the command at the current cursor position"
        >set @ cursor</button>
        <button
          disabled={selectedCommandIndex === null}
          onClick={() => {
            if (selectedCommandIndex === null) return;
            setEditStatus(describeRc('loop @ selected', setLoopIndex(selectedCommandIndex)));
          }}
          title="Set loop point to the selected command in the list"
        >set @ selected</button>
        <button
          disabled={loopIndex === null}
          onClick={() => setEditStatus(describeRc('clear loop', setLoopIndex(null)))}
        >clear loop</button>
      </div>

      <h3 style={{ marginTop: 18 }}>command</h3>
      {cmd ? (
        <>
          <div className="field">
            <label>index / @sample</label>
            <div className="mono">#{cmd.index} @ {cmd.sampleTime}</div>
          </div>
          <div className="field">
            <label>decoded</label>
            <div className="mono" style={{ fontSize: 11 }}>{formatted}</div>
          </div>
          <div className="field">
            <label>opcode (hex)</label>
            <input value={opHex} onChange={(e) => setOpHex(e.target.value)} maxLength={2} />
          </div>
          <div className="field">
            <label>args (hex, space-separated)</label>
            <input value={argsHex} onChange={(e) => setArgsHex(e.target.value)} placeholder="e.g. 28 F0" />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={onUpdate}>update</button>
            <button onClick={onInsertBefore}>insert before</button>
            <button onClick={onDelete}>delete</button>
          </div>
          {editStatus && (
            <div className="mono" style={{ marginTop: 8, color: 'var(--accent-2)', fontSize: 11 }}>{editStatus}</div>
          )}
        </>
      ) : (
        <p style={{ color: 'var(--text-dim)' }}>click a row in the command list.</p>
      )}
    </div>
  );
}
