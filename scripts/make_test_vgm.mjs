// Synthesize a small but visually-interesting VGM file at scripts/sample.vgm.
//
// Drops a few hundred YM2612 + PSG writes spaced with waits so the heatmap
// and per-chip tracks have something to render. Useful for poking at the
// editor before you have a real .vgm at hand.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HEADER_SIZE = 0xC0;

function build() {
  const cmds = [];
  // Pretend we're playing a simple arpeggio on YM2612 channel 0, with PSG
  // noise on every 4th beat.
  const beats = 64;
  const beatSamples = 2205; // ~50 ms @ 44.1 kHz
  for (let b = 0; b < beats; b++) {
    // YM2612 reg writes (vary parameters every beat)
    cmds.push(0x52, 0x22, 0x00);
    cmds.push(0x52, 0xA4, 0x20 + (b & 0x0F));
    cmds.push(0x52, 0xA0, 0x40 + ((b * 7) & 0xFF));
    cmds.push(0x52, 0x28, 0xF0);          // key on
    // PSG every 4th beat
    if (b % 4 === 0) {
      cmds.push(0x50, 0x90 | ((b >> 2) & 0x0F));
    }
    // wait
    cmds.push(0x61, beatSamples & 0xFF, (beatSamples >> 8) & 0xFF);
    cmds.push(0x52, 0x28, 0x00);          // key off
    // burst of writes mid-beat
    for (let j = 0; j < 3; j++) {
      cmds.push(0x52, 0x80 + j, (b + j) & 0xFF);
    }
    cmds.push(0x62);                       // wait 735 samples
  }
  cmds.push(0x66);

  const data = new Uint8Array(cmds);
  const total = HEADER_SIZE + data.length;
  const file = new Uint8Array(total);
  const view = new DataView(file.buffer);
  // Magic
  file[0] = 0x56; file[1] = 0x67; file[2] = 0x6D; file[3] = 0x20;
  view.setUint32(0x04, total - 0x04, true);                  // EOF offset
  view.setUint32(0x08, 0x00000171, true);                    // Version 1.71
  view.setUint32(0x0C, 3579545, true);                       // SN76489 clock
  view.setUint32(0x2C, 7670454, true);                       // YM2612 clock
  view.setUint32(0x34, HEADER_SIZE - 0x34, true);            // data offset
  const totalSamples = beats * (beatSamples + 735);
  view.setUint32(0x18, totalSamples, true);                  // total samples
  file.set(data, HEADER_SIZE);
  return file;
}

const out = resolve(__dirname, 'sample.vgm');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, build());
console.log(`wrote ${out} (${build().length} bytes)`);
