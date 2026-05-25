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
import type { RenderedPcm } from '../../wasm/libvgm.js';
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
  /** vgm_chip_t for chip sections; null for the master section. Drives
   *  the mute button + per-chip PCM lookup. */
  chip: VgmChipId | null;
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

function buildSections(
  file: VgmFile, chips: VgmChipId[],
  pcm: RenderedPcm | null,
  perChipPcm: Map<VgmChipId, RenderedPcm>,
): TrackSection[] {
  const sections: TrackSection[] = [];
  sections.push({
    id: 'master',
    chip: null,
    heatmap: new HeatmapTrackRenderer({
      id: 'heatmap-all',
      name: 'All commands',
      file,
      cssHeight: 56,
    }),
    subTracks: [
      new WaveformTrackRenderer('wave-master', 'Master waveform', pcm),
      new SpectrogramTrackRenderer('spec-master', 'Master spectrogram', pcm),
    ],
  });
  for (const chip of chips) {
    const short = file.chipName(chip, true);
    const audio = isAudioChip(chip);
    const chipPcm = perChipPcm.get(chip) ?? null;
    sections.push({
      id: `chip-${chip}`,
      chip,
      heatmap: makeChipHeatmap(file, chip, short),
      // Per-chip waveform/spectrogram use the dedicated single-chip PCM
      // when the worker has produced it; otherwise show the rendering
      // placeholder.
      subTracks: audio ? [
        new WaveformTrackRenderer(`wave-${chip}`, `${short} wave`, chipPcm),
        new SpectrogramTrackRenderer(`spec-${chip}`, `${short} spec`, chipPcm),
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
  const loopSample = useEditorStore((s) => s.loopSample);
  const pcm = useEditorStore((s) => s.pcm);
  const perChipPcm = useEditorStore((s) => s.perChipPcm);
  const mutedChips = useEditorStore((s) => s.mutedChips);
  const requestChipPcm = useEditorStore((s) => s.requestChipPcm);
  const toggleChipMute = useEditorStore((s) => s.toggleChipMute);
  const playCursor = useEditorStore((s) => s.playCursor);
  const playing = useEditorStore((s) => s.playing);

  const sections = useMemo(() => {
    if (!file) return [] as TrackSection[];
    return buildSections(file, usedChips, pcm, perChipPcm);
  }, [file, usedChips, pcm, perChipPcm]);

  // Page-by-page auto-scroll: when the play cursor crosses the right
  // edge of the view (which happens continuously during playback), jump
  // the view forward by one span so the playhead reappears near the
  // left edge. Driven by playCursor not cursor so editing clicks don't
  // jump the camera around.
  useEffect(() => {
    if (!playing) return;
    const span = view.endSample - view.startSample;
    if (span <= 0) return;
    if (playCursor >= view.endSample) {
      setView({ startSample: playCursor, endSample: playCursor + span });
    } else if (playCursor < view.startSample) {
      const start = Math.max(0, playCursor - span * 0.1);
      setView({ startSample: start, endSample: start + span });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playCursor, playing]);

  // When playback stops, snap the view back to where the edit cursor is —
  // the auto-scroll above pages the view forward to follow audio, and
  // without this the view would stay parked at the last play-cursor
  // position, leaving the user looking at audio they're no longer at.
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (wasPlayingRef.current && !playing) {
      const span = view.endSample - view.startSample;
      if (span > 0 && (cursor < view.startSample || cursor >= view.endSample)) {
        // Centre on edit cursor.
        const start = Math.max(0, cursor - Math.floor(span / 2));
        setView({ startSample: start, endSample: start + span });
      }
    }
    wasPlayingRef.current = playing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Per-section expansion state. Sub-tracks (waveform + spectrogram) start
  // hidden and are only mounted when the user clicks the chevron on their
  // parent heatmap row — keeps the default view focused on the command
  // tracks and avoids any audio-render work until requested.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = useCallback((id: string, chip: VgmChipId | null) => {
    setExpanded((prev) => {
      const nowOpen = !prev[id];
      // First time a chip section opens, kick off the per-chip PCM
      // render so its waveform / spectrogram have data to draw.
      if (nowOpen && chip !== null) requestChipPcm(chip);
      return { ...prev, [id]: nowOpen };
    });
  }, [requestChipPcm]);

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

  /** Convert a viewport-x to an overlay-relative pixel, clamped so the
   *  caller never gets a value outside the visible canvas column. */
  function clientXToOverlayPx(clientX: number, rect: DOMRect): number {
    return Math.max(0, Math.min(rect.width, clientX - rect.left));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!file) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
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
    const px = clientXToOverlayPx(e.clientX, rect);
    const sample = conv.pxToSample(px);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'select', startSample: sample, startX: px };
    setCursor(sample);
    // Pressing the button moves the cursor; that immediately invalidates
    // any prior selection so the user gets a clean state to either click
    // (cursor only) or drag (new selection).
    setSelection(null);
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
    const px = clientXToOverlayPx(e.clientX, rect);
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

  // Clip the cursor and selection band to the overlay's visible column so
  // they can never paint over the track labels on the left. When the
  // selection extends beyond the current view, only its visible slice is
  // drawn — and clientWidth comes from the live areaWidthCss so the math
  // matches whatever the layout currently is.
  const cursorPx = Math.max(0, Math.min(areaWidthCss, conv.sampleToPx(cursor)));
  const playCursorPx = playing
    ? Math.max(0, Math.min(areaWidthCss, conv.sampleToPx(playCursor)))
    : null;
  const playCursorInView = playCursorPx !== null
    && playCursor >= view.startSample
    && playCursor <= view.endSample;
  let selStartPx = 0, selWidth = 0;
  if (selection) {
    const l = Math.max(0, Math.min(areaWidthCss, conv.sampleToPx(selection.start)));
    const r = Math.max(0, Math.min(areaWidthCss, conv.sampleToPx(selection.end)));
    selStartPx = l;
    selWidth = Math.max(0, r - l);
  }
  // Loop marker — only visible when the loop sample is in the current view.
  const loopPx = loopSample !== null ? conv.sampleToPx(loopSample) : null;
  const loopVisible = loopPx !== null && loopPx >= 0 && loopPx <= areaWidthCss;

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
                  onToggleExpanded={() => toggleExpanded(section.id, section.chip)}
                  muteable={section.chip !== null}
                  muted={section.chip !== null && mutedChips.has(section.chip)}
                  onToggleMute={section.chip !== null ? () => toggleChipMute(section.chip!) : undefined}
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
          {/* Selection band — only render when at least one pixel is
              visible inside the overlay column. */}
          {selection && selWidth > 0 && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: selStartPx,
                width: selWidth,
                background: 'var(--selection)',
                borderLeft: '1px solid var(--selection-stroke)',
                borderRight: '1px solid var(--selection-stroke)',
                pointerEvents: 'none',
              }}
            />
          )}
          {/* Edit cursor — always visible, marks the user's position. */}
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
          {/* Play cursor — only while playing, snaps back to edit cursor
              on stop so it disappears overlap-style. */}
          {playCursorInView && playCursorPx !== null && (
            <div
              style={{
                position: 'absolute',
                top: 0, bottom: 0,
                left: playCursorPx, width: 2,
                background: 'rgba(120, 220, 255, 0.85)',
                pointerEvents: 'none',
                boxShadow: '0 0 8px rgba(120, 220, 255, 0.7)',
              }}
            />
          )}
          {/* Loop marker: dashed vertical line + small badge */}
          {loopVisible && loopPx !== null && (
            <>
              <div
                style={{
                  position: 'absolute',
                  top: 0, bottom: 0,
                  left: loopPx, width: 0,
                  borderLeft: '1px dashed var(--loop)',
                  pointerEvents: 'none',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: 2,
                  left: loopPx + 4,
                  padding: '1px 4px',
                  background: '#000',
                  color: 'var(--loop)',
                  fontSize: 10,
                  fontFamily: 'ui-monospace, Menlo, monospace',
                  pointerEvents: 'none',
                  borderRadius: 2,
                }}
              >
                loop
              </div>
            </>
          )}
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
        wheel: zoom · shift+wheel: pan · drag: select · middle-drag: pan · Del: delete · Space: play · Shift+Space: loop selection
      </div>
    </div>
  );
}
