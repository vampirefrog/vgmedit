/**
 * Timeline pane: ruler + N track rows + a single overlay layer that draws
 * the cursor and selection across all tracks and captures the pointer for
 * click/drag/wheel.
 *
 * Track list is derived from the loaded file: a whole-VGM heatmap, then
 * waveform + spectrogram slots (placeholders for now), then per used-chip
 * heatmap + waveform + spectrogram. Tracks are recreated whenever the
 * underlying file changes; renderer instances are cached via useMemo so
 * resize-driven redraws don't churn allocations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VGM_SAMPLE_RATE, VgmChip, type VgmChipId, type VgmFile } from '../../wasm/index.js';
import { useEditorStore } from '../../state/store.js';
import {
  HeatmapTrackRenderer,
  SpectrogramTrackRenderer,
  WaveformTrackRenderer,
  makeChipHeatmap,
  type TrackRenderer,
} from './renderers.js';
import { Track } from './Track.js';
import { Ruler } from './Ruler.js';
import { TimelineScrollbar } from './Scrollbar.js';

const LABEL_COL_WIDTH = 140;

interface TrackSection {
  id: string;
  heatmap: TrackRenderer;
  subTracks: TrackRenderer[];
}

/** True for the pseudo-chip IDs we attribute waits, data blocks and stream
 *  control to. They aren't audio sources, so they get a command heatmap
 *  row but no waveform / spectrogram sub-tracks. */
function isAudioChip(chip: VgmChipId): boolean {
  return chip !== VgmChip.CONTROL
      && chip !== VgmChip.DATA_BLOCK
      && chip !== VgmChip.DAC_STREAM
      && chip !== VgmChip.NONE;
}

function buildSections(file: VgmFile, chips: VgmChipId[]): TrackSection[] {
  const sections: TrackSection[] = [];
  sections.push({
    id: 'master',
    heatmap: new HeatmapTrackRenderer({
      id: 'heatmap-all',
      name: 'All commands',
      file,
      cssHeight: 56,
    }),
    subTracks: [
      new WaveformTrackRenderer('wave-master', 'Master waveform'),
      new SpectrogramTrackRenderer('spec-master', 'Master spectrogram'),
    ],
  });
  for (const chip of chips) {
    const short = file.chipName(chip, true);
    const audio = isAudioChip(chip);
    sections.push({
      id: `chip-${chip}`,
      heatmap: makeChipHeatmap(file, chip, short),
      subTracks: audio ? [
        new WaveformTrackRenderer(`wave-${chip}`, `${short} wave`),
        new SpectrogramTrackRenderer(`spec-${chip}`, `${short} spec`),
      ] : [],
    });
  }
  return sections;
}

interface SamplePxConverter {
  pxToSample(px: number): number;
  sampleToPx(sample: number): number;
}

export function Timeline() {
  const file = useEditorStore((s) => s.file);
  const view = useEditorStore((s) => s.view);
  const cursor = useEditorStore((s) => s.cursor);
  const selection = useEditorStore((s) => s.selection);
  const totalSamples = useEditorStore((s) => s.totalSamples);
  const usedChips = useEditorStore((s) => s.usedChips);
  const setCursor = useEditorStore((s) => s.setCursor);
  const setSelection = useEditorStore((s) => s.setSelection);
  const setView = useEditorStore((s) => s.setView);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const panBy = useEditorStore((s) => s.panBy);
  const revision = useEditorStore((s) => s.revision);

  const sections = useMemo(() => {
    if (!file) return [] as TrackSection[];
    return buildSections(file, usedChips);
  }, [file, usedChips]);

  // Per-section expansion state. Sub-tracks (waveform + spectrogram) start
  // hidden and are only mounted when the user clicks the chevron on their
  // parent heatmap row — keeps the default view focused on the command
  // tracks and avoids any audio-render work until requested.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const overlayRef = useRef<HTMLDivElement>(null);
  const [areaWidthCss, setAreaWidthCss] = useState(0);

  // The overlay only mounts once a file is loaded (Timeline early-returns
  // before that), so depend on `file` to re-run this effect when the
  // element actually exists. Without this dep the observer attached during
  // the no-file render saw a null ref, returned early, and was never
  // reattached — leaving areaWidthCss at 0 and making conv.pxToSample
  // overflow into a clamped-to-totalSamples cursor for every click.
  useEffect(() => {
    const wrap = overlayRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setAreaWidthCss(Math.max(1, Math.floor(entry.contentRect.width)));
      }
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [file]);

  const conv: SamplePxConverter = useMemo(() => {
    const span = Math.max(1, view.endSample - view.startSample);
    return {
      pxToSample(px) { return view.startSample + (px / Math.max(1, areaWidthCss)) * span; },
      sampleToPx(s) { return ((s - view.startSample) / span) * areaWidthCss; },
    };
  }, [view.startSample, view.endSample, areaWidthCss]);

  // Drag state. Left button = select/cursor; middle button = pan.
  type LeftDrag = { kind: 'select'; startSample: number; startX: number };
  type MiddleDrag = { kind: 'pan'; startX: number; startStart: number; startEnd: number };
  const dragRef = useRef<LeftDrag | MiddleDrag | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!file) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < 0) return;
    if (e.button === 1) {
      // Middle button — pan. Prevent the OS/browser middle-click auto-scroll.
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: 'pan',
        startX: e.clientX,
        startStart: view.startSample,
        startEnd: view.endSample,
      };
      return;
    }
    if (e.button !== 0) return;
    const sample = conv.pxToSample(px);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'select', startSample: sample, startX: px };
    setCursor(sample);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!file || !dragRef.current) return;
    const drag = dragRef.current;
    if (drag.kind === 'pan') {
      const dxPx = e.clientX - drag.startX;
      const span = drag.startEnd - drag.startStart;
      const dxSamples = -(dxPx / Math.max(1, areaWidthCss)) * span;
      setView({
        startSample: drag.startStart + dxSamples,
        endSample: drag.startEnd + dxSamples,
      });
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const sample = conv.pxToSample(px);
    const dx = Math.abs(px - drag.startX);
    if (dx > 3) {
      setSelection({ start: drag.startSample, end: sample });
      setCursor(sample);
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const drag = dragRef.current;
    if (drag.kind === 'select') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const px = e.clientX - rect.left;
      const dx = Math.abs(px - drag.startX);
      if (dx <= 3) {
        // Click — clear selection
        setSelection(null);
      }
    }
    dragRef.current = null;
  }

  // Plain wheel = zoom at pointer. Shift+wheel = pan horizontally. The
  // listener attaches via useEffect with `{passive:false}` so preventDefault
  // can block both the page scroll and the browser's ctrl+wheel page zoom.
  // We deliberately swallow the wheel regardless of modifier so an
  // accidental ctrl-press doesn't punch through to the browser.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !file) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const px = e.clientX - rect.left;
      // Browsers translate shift+vertical-wheel into deltaX on some
      // platforms; accept whichever axis carries signal.
      const dy = e.deltaY || e.deltaX;
      if (e.shiftKey) {
        const span = view.endSample - view.startSample;
        panBy((dy / 200) * span);
        return;
      }
      const anchor = conv.pxToSample(px);
      zoomBy(dy < 0 ? 1.2 : 1 / 1.2, anchor);
    };
    overlay.addEventListener('wheel', handler, { passive: false });
    return () => overlay.removeEventListener('wheel', handler);
  }, [file, conv, zoomBy, panBy, view.startSample, view.endSample]);

  if (!file) {
    return (
      <div className="timeline-pane" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--text-dim)' }}>load a VGM file to begin</span>
      </div>
    );
  }

  const cursorPx = conv.sampleToPx(cursor);
  const selStartPx = selection ? conv.sampleToPx(selection.start) : 0;
  const selEndPx = selection ? conv.sampleToPx(selection.end) : 0;

  return (
    <div className="timeline-pane" style={{ display: 'flex', flexDirection: 'column' }}>
      <Ruler view={view} />
      {/* The tracks area scrolls vertically; the overlay sits as a SIBLING
       * (not a child) so its coordinate system stays anchored to the
       * viewport rather than the scrolling content. The two share a
       * position:relative wrapper so the overlay's absolute positioning
       * lines up exactly with the canvas column. */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div
          style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden' }}
        >
          {sections.map((section) => {
            const isExpanded = !!expanded[section.id];
            return (
              <div key={section.id}>
                <Track
                  renderer={section.heatmap}
                  view={view}
                  expandable={section.subTracks.length > 0}
                  expanded={isExpanded}
                  onToggleExpanded={() => toggleExpanded(section.id)}
                  revision={revision}
                />
                {isExpanded && section.subTracks.map((t) => (
                  <Track key={t.id} renderer={t} view={view} meta={t.kind} revision={revision} />
                ))}
              </div>
            );
          })}
        </div>
        <div
          ref={overlayRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: LABEL_COL_WIDTH,
            right: 0,
            pointerEvents: 'auto',
            cursor: 'crosshair',
            touchAction: 'none',
          }}
        >
          {/* Selection band */}
          {selection && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: selStartPx,
                width: Math.max(1, selEndPx - selStartPx),
                background: 'var(--selection)',
                borderLeft: '1px solid var(--selection-stroke)',
                borderRight: '1px solid var(--selection-stroke)',
                pointerEvents: 'none',
              }}
            />
          )}
          {/* Cursor line */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: cursorPx,
              width: 1,
              background: 'var(--cursor)',
              pointerEvents: 'none',
              boxShadow: '0 0 6px var(--cursor)',
            }}
          />
          {/* Cursor label */}
          <div
            style={{
              position: 'absolute',
              top: 2,
              left: cursorPx + 4,
              padding: '1px 4px',
              background: '#000',
              color: 'var(--cursor)',
              fontSize: 10,
              fontFamily: 'ui-monospace, Menlo, monospace',
              pointerEvents: 'none',
              borderRadius: 2,
            }}
          >
            {(cursor / VGM_SAMPLE_RATE).toFixed(3)}s · {Math.round(cursor)}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <div style={{ width: LABEL_COL_WIDTH, background: 'var(--bg-2)', borderTop: '1px solid var(--border)', borderRight: '1px solid var(--border)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <TimelineScrollbar />
        </div>
      </div>
      <div style={{ padding: '2px 10px', fontSize: 10, color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>
        view {Math.round(view.startSample)}–{Math.round(view.endSample)} of {totalSamples}
        {' · '}
        wheel: zoom · shift+wheel: pan · drag: select · middle-drag: pan
      </div>
    </div>
  );
}
