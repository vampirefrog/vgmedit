# vgmedit

A web-based, visual editor for **VGM** (Video Game Music) files — the
register-log format used to capture chiptune from emulated sound chips.

**▶ [Live demo](https://vampirefrog.github.io/vgmedit/)**

> Proof of concept. Load a `.vgm` / `.vgz`, scrub the timeline, audition with
> real chip emulation, edit the command stream, and download the result.

## Features

- **Timeline heatmap** — the whole file (and one lane per chip) drawn as a
  fire-palette intensity map, so dense bursts of register writes stand out at a
  glance.
- **Per-chip waveform + spectrogram** — expandable sub-tracks rendered from
  libvgm output, with a per-chip mute toggle.
- **Real chip emulation** — playback runs [libvgm](https://github.com/ValleyBell/libvgm)
  compiled to WebAssembly inside an `AudioWorklet`, so loop transitions and
  edits are *heard* exactly as the hardware would play them.
- **Command list** — a vgm2txt-style, virtualized view of every command with
  add / edit / delete.
- **Editing** — delete a selected range (boundary waits trimmed), set the loop
  point, and undo / redo (Ctrl+Z / Ctrl+Y).
- **Transport** — Space to play/pause from the edit cursor, Shift+Space to loop
  the current selection; Reaper-style separate edit and play cursors.

## Architecture

The VGM parsing, command formatting, heatmap intensity, and editing all live in
a small **C99 core** (`core/`) so the same sources can back a native or Qt port
later. It is compiled to WebAssembly with Emscripten; the React + TypeScript
frontend (`src/`) only paints pixels and wires up interaction.

```
core/      C99 VGM parser, editor, heatmap, + libvgm glue (→ WASM)
src/       Vite + React + TypeScript + Zustand UI, Canvas 2D rendering
```

## Development

```bash
npm install
npm run build:wasm   # builds the C core + libvgm to WASM (needs Emscripten)
npm run dev          # Vite dev server
```

`npm run build:wasm` clones libvgm into `core/vendor/` on first run and requires
the Emscripten SDK (`emcc`) on your `PATH`. The generated WASM is never
committed — CI rebuilds it on every deploy.

## License & links

Built by [vampi.tech](https://vampi.tech). Source on
[GitHub](https://github.com/vampirefrog/vgmedit).
