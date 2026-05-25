// End-to-end smoke test for the vgmcore WASM build.
//
// Synthesizes a minimal v1.71 VGM file in memory, opens it via vgmcore,
// then prints the parsed header, the command list, sample times, the
// formatter output, and a heatmap row. Run with: `node core/wasm/smoke_test.mjs`.

import createVgmCore from '../../src/wasm/vgmcore.js';

const DATA_OFFSET = 0xC0;        // chosen so v1.71 chip-clock fields fit before it
const HEADER_SIZE = DATA_OFFSET;

// Build a minimal VGM file:
//   - magic "Vgm "
//   - version 1.71
//   - YM2612 clock = 7670454 Hz (Genesis NTSC)
//   - data: YM2612 reg writes + waits + end
function buildSampleVgm() {
  const commands = new Uint8Array([
    0x52, 0x22, 0x00,    // YM2612 port 0: reg 0x22 = 0x00
    0x52, 0x28, 0xF0,    // YM2612 port 0: reg 0x28 = 0xF0 (key on)
    0x61, 0xE8, 0x03,    // wait 1000 samples
    0x53, 0x40, 0x7F,    // YM2612 port 1: reg 0x40 = 0x7F
    0x62,                 // wait 735 (60Hz frame)
    0x50, 0x80,           // PSG write 0x80
    0x70,                 // wait 1 sample
    0x66,                 // end
  ]);
  const file = new Uint8Array(HEADER_SIZE + commands.length);
  const view = new DataView(file.buffer);
  // Magic 'Vgm '
  file[0] = 0x56; file[1] = 0x67; file[2] = 0x6D; file[3] = 0x20;
  // EOF offset (relative to 0x04)
  view.setUint32(0x04, file.length - 0x04, true);
  // Version 1.71
  view.setUint32(0x08, 0x00000171, true);
  // YM2612 clock at 0x2C
  view.setUint32(0x2C, 7670454, true);
  // Data offset at 0x34 (relative)
  view.setUint32(0x34, DATA_OFFSET - 0x34, true);
  // Total samples (we'll let the parser recompute from the wait commands)
  view.setUint32(0x18, 1000 + 735 + 1, true);
  // copy commands at DATA_OFFSET
  file.set(commands, DATA_OFFSET);
  return file;
}

const vgm = buildSampleVgm();
const mod = await createVgmCore();

const dataPtr = mod._malloc(vgm.length);
mod.HEAPU8.set(vgm, dataPtr);
const statusPtr = mod._malloc(4);
const handle = mod._vgm_open(dataPtr, vgm.length, statusPtr);
const status = mod.HEAP32[statusPtr >>> 2];
mod._free(dataPtr);
mod._free(statusPtr);

if (!handle) {
  console.error('vgm_open failed:', status);
  process.exit(1);
}

const count = mod._vgm_command_count(handle);
console.log(`parsed ${count} commands`);

const sizeofEntry = mod._vgm_sizeof_command_entry();
const entryBuf = mod._malloc(sizeofEntry);
const fmtBuf = mod._malloc(256);

function chipName(id) {
  return mod.UTF8ToString(mod._vgm_chip_short_name(id));
}

let pass = true;
const expected = [
  { op: 0x52, chip: 3 /* YM2612 */, t: 0 },
  { op: 0x52, chip: 3, t: 0 },
  { op: 0x61, chip: 44 /* CONTROL */, t: 0 },
  { op: 0x53, chip: 3, t: 1000 },
  { op: 0x62, chip: 44, t: 1000 },
  { op: 0x50, chip: 1 /* PSG */, t: 1735 },
  { op: 0x70, chip: 44, t: 1735 },
  { op: 0x66, chip: 44, t: 1736 },
];

for (let i = 0; i < count; i++) {
  mod._vgm_get_command(handle, i, entryBuf);
  const sampleLo = mod.HEAPU32[entryBuf >>> 2];
  const sampleHi = mod.HEAPU32[(entryBuf + 4) >>> 2];
  const sample = sampleHi * 0x1_0000_0000 + sampleLo;
  const fileOffset = mod.HEAPU32[(entryBuf + 8) >>> 2];
  const argSize = mod.HEAPU32[(entryBuf + 12) >>> 2];
  const opcode = mod.HEAPU8[entryBuf + 16];
  const chip = mod.HEAPU8[entryBuf + 17];

  mod._vgm_format_command(handle, i, fmtBuf, 256);
  const text = mod.UTF8ToString(fmtBuf);

  const exp = expected[i];
  const ok = exp && exp.op === opcode && exp.chip === chip && exp.t === sample;
  if (!ok) pass = false;

  console.log(
    `  [${i}] @${sample.toString().padStart(5)} off=${fileOffset.toString().padStart(4)} ` +
    `op=${opcode.toString(16).padStart(2, '0')} args=${argSize} ` +
    `chip=${chipName(chip).padEnd(5)} | ${text} ${ok ? '' : 'EXPECTED ' + JSON.stringify(exp)}`,
  );
}

console.log();
console.log('total samples:', expected[expected.length - 1].t);
console.log('used chips bitmask:', mod._vgm_used_chip_mask(handle).toString(2));

// Heatmap: 32 pixels across the full sample range, all chips
const totalSamples = 1736;
const pixels = 32;
const heatPtr = mod._malloc(pixels);
mod._vgm_heatmap(handle, 0n, BigInt(totalSamples + 1), pixels, 0xFFFFFFFFFFFFFFFFn, 64, heatPtr);
const heat = new Uint8Array(mod.HEAPU8.buffer, heatPtr, pixels);
const ascii = Array.from(heat, (v) => ' .:-=+*#%@'[Math.min(9, Math.floor(v / 26))]).join('');
console.log(`heatmap (${pixels}px): [${ascii}]`);
mod._free(heatPtr);

/* --- Edit op exercises ------------------------------------------------- */
function readSampleTime(idx) {
  mod._vgm_get_command(handle, idx, entryBuf);
  const lo = mod.HEAPU32[entryBuf >>> 2];
  const hi = mod.HEAPU32[(entryBuf + 4) >>> 2];
  return hi * 0x1_0000_0000 + lo;
}
function readEntry(idx) {
  mod._vgm_get_command(handle, idx, entryBuf);
  return {
    sample: readSampleTime(idx),
    opcode: mod.HEAPU8[entryBuf + 16],
    chip: mod.HEAPU8[entryBuf + 17],
    argSize: mod.HEAPU32[(entryBuf + 12) >>> 2],
  };
}

// Insert a 500-sample wait at index 0. Every later sample_time should shift +500.
console.log();
console.log('--- insert 500-sample wait at index 0 ---');
const before = [];
for (let i = 0; i < mod._vgm_command_count(handle); i++) before.push(readSampleTime(i));

const waitArgs = mod._malloc(2);
mod.HEAPU8[waitArgs] = 0xF4;       // 500 = 0x01F4 LE
mod.HEAPU8[waitArgs + 1] = 0x01;
let rc = mod._vgm_insert_command(handle, 0, 0x61, waitArgs, 2);
mod._free(waitArgs);
console.log('insert rc:', rc);

const afterCount = mod._vgm_command_count(handle);
console.log(`count now ${afterCount} (was ${before.length}+1=${before.length + 1})`);
let allShifted = true;
for (let i = 1; i < afterCount; i++) {
  const expected = before[i - 1] + 500;
  const got = readSampleTime(i);
  if (got !== expected) {
    console.log(`  MISMATCH at i=${i}: expected ${expected}, got ${got}`);
    allShifted = false;
  }
}
if (!allShifted) pass = false;
else console.log('  all later sample_times shifted by +500');

// Verify the inserted command itself
const inserted = readEntry(0);
console.log(`inserted [0]: op=${inserted.opcode.toString(16)} args=${inserted.argSize} chip=${chipName(inserted.chip)} sample=${inserted.sample}`);
if (inserted.opcode !== 0x61 || inserted.argSize !== 2 || inserted.sample !== 0) {
  console.log('  insert entry mismatch'); pass = false;
}

// Delete the inserted command — everything should revert (timings + count).
console.log();
console.log('--- delete index 0 (the wait we just inserted) ---');
rc = mod._vgm_delete_command(handle, 0);
console.log('delete rc:', rc);
const afterDeleteCount = mod._vgm_command_count(handle);
console.log(`count now ${afterDeleteCount} (expected ${before.length})`);
let reverted = afterDeleteCount === before.length;
for (let i = 0; i < afterDeleteCount; i++) {
  if (readSampleTime(i) !== before[i]) { reverted = false; break; }
}
if (!reverted) { console.log('  sample_times did not revert'); pass = false; }
else console.log('  sample_times reverted cleanly');

// Update the YM2612 reg 28 = F0 write (index 1 in the original) to PSG instead.
// Pick a non-wait command so timings stay put. Verify chip attribution updates.
console.log();
console.log('--- update index 1 (op 0x52 → op 0x50, args=42) ---');
const updArgs = mod._malloc(1);
mod.HEAPU8[updArgs] = 0x42;
rc = mod._vgm_update_command(handle, 1, 0x50, updArgs, 1);
mod._free(updArgs);
console.log('update rc:', rc);
const updated = readEntry(1);
console.log(`updated [1]: op=${updated.opcode.toString(16)} chip=${chipName(updated.chip)} args=${updated.argSize}`);
if (updated.opcode !== 0x50 || updated.chip !== 1 /* PSG */ || updated.argSize !== 1) {
  console.log('  update mismatch'); pass = false;
}

// Serialize the (now-edited) file back to bytes and re-parse to sanity-check
// the round-trip.
console.log();
console.log('--- serialize + re-parse ---');
const needed = mod._vgm_serialize(handle, 0, 0);
console.log('serialize size:', needed);
const outPtr = mod._malloc(needed);
const written = mod._vgm_serialize(handle, outPtr, needed);
console.log('written:', written);
const out = new Uint8Array(mod.HEAPU8.buffer, outPtr, needed).slice();
mod._free(outPtr);

// Reopen the serialized file
const reopen = mod._malloc(out.length);
mod.HEAPU8.set(out, reopen);
const stP = mod._malloc(4);
const h2 = mod._vgm_open(reopen, out.length, stP);
mod._free(reopen);
const st = mod.HEAP32[stP >>> 2];
mod._free(stP);
console.log('reparse status:', st, 'handle:', h2);
if (h2 === 0) { console.log('  reparse failed'); pass = false; }
else {
  const reCount = mod._vgm_command_count(h2);
  console.log(`  reparsed command count: ${reCount} (expected ${afterDeleteCount})`);
  if (reCount !== afterDeleteCount) pass = false;
  mod._vgm_close(h2);
}

// --- Loop point round-trip --------------------------------------------- //
console.log();
console.log('--- set loop on command #3, serialize, reparse, verify ---');
let rc2 = mod._vgm_set_loop_index(handle, 3);
console.log('set_loop rc:', rc2);
const loopIdx1 = mod._vgm_get_loop_index(handle);
console.log('get_loop after set:', loopIdx1);

const needed2 = mod._vgm_serialize(handle, 0, 0);
const outPtr2 = mod._malloc(needed2);
mod._vgm_serialize(handle, outPtr2, needed2);
const out2 = new Uint8Array(mod.HEAPU8.buffer, outPtr2, needed2).slice();
mod._free(outPtr2);

const reopen2 = mod._malloc(out2.length);
mod.HEAPU8.set(out2, reopen2);
const stP2 = mod._malloc(4);
const h3 = mod._vgm_open(reopen2, out2.length, stP2);
mod._free(reopen2);
mod._free(stP2);
const reparseLoop = h3 ? mod._vgm_get_loop_index(h3) : -1;
console.log('loop index in serialized+reparsed file:', reparseLoop);
if (reparseLoop !== 3) { console.log('  ROUND-TRIP MISMATCH'); pass = false; }
else { console.log('  loop survives serialize+reparse'); }
if (h3) mod._vgm_close(h3);

// Clear loop and verify
mod._vgm_set_loop_index(handle, -1);
if (mod._vgm_get_loop_index(handle) !== -1) { console.log('clear loop failed'); pass = false; }
else console.log('clear loop works');

// --- vgm_delete_range coverage --------------------------------------- //
console.log();
console.log('--- delete_range covering both boundary waits ---');
// Build a fresh tiny file:
//   YM2612 reg write @0, wait 100, reg write @100, wait 200, reg write @300, end
function buildBoundaryVgm() {
  const cmds = new Uint8Array([
    0x52, 0x22, 0x00,            // @ 0 (non-wait)
    0x61, 0x64, 0x00,            // wait 100
    0x52, 0x28, 0x10,            // @ 100 (non-wait, would be deleted)
    0x61, 0xC8, 0x00,            // wait 200 (spans [100, 300))
    0x52, 0x28, 0x20,            // @ 300 (kept)
    0x66,                         // end @ 300
  ]);
  const file = new Uint8Array(0xC0 + cmds.length);
  const dv = new DataView(file.buffer);
  file[0] = 0x56; file[1] = 0x67; file[2] = 0x6D; file[3] = 0x20;
  dv.setUint32(0x04, file.length - 0x04, true);
  dv.setUint32(0x08, 0x171, true);
  dv.setUint32(0x2C, 7670454, true);
  dv.setUint32(0x34, 0xC0 - 0x34, true);
  dv.setUint32(0x18, 300, true);
  file.set(cmds, 0xC0);
  return file;
}
const tiny = buildBoundaryVgm();
const tPtr = mod._malloc(tiny.length);
mod.HEAPU8.set(tiny, tPtr);
const tStat = mod._malloc(4);
const ht = mod._vgm_open(tPtr, tiny.length, tStat);
mod._free(tPtr); mod._free(tStat);

// Delete samples [50, 250). Expected after delete:
//   total_samples 100, six commands -> five (one non-wait inside deleted)
//   - reg @0 (kept)
//   - wait 50 (was 100, trimmed by overlap 50)
//   - wait 50 (was 200, trimmed by overlap 150)
//   - reg @100 (was @300)
//   - end
const dRc = mod._vgm_delete_range(ht, 50n, 250n);
console.log('delete_range rc:', dRc);
const dCount = mod._vgm_command_count(ht);
console.log(`command count after delete: ${dCount} (expected 5)`);
const hdrPtr = mod._vgm_header(ht);
const newTotal = mod.HEAPU32[(hdrPtr + 16) >>> 2];
console.log(`new total_samples: ${newTotal} (expected 100)`);
const eBuf = mod._malloc(mod._vgm_sizeof_command_entry());
const expectedEntries = [
  { op: 0x52, t: 0 },     // reg @ 0
  { op: 0x61, t: 0 },     // trimmed wait
  { op: 0x61, t: 50 },    // trimmed wait
  { op: 0x52, t: 100 },   // reg, shifted from 300 to 100
  { op: 0x66, t: 100 },   // end
];
for (let i = 0; i < dCount; i++) {
  mod._vgm_get_command(ht, i, eBuf);
  const sampleLo = mod.HEAPU32[eBuf >>> 2];
  const opcode = mod.HEAPU8[eBuf + 16];
  const exp = expectedEntries[i];
  const ok = exp && exp.op === opcode && exp.t === sampleLo;
  console.log(`  [${i}] op=${opcode.toString(16)} t=${sampleLo}` + (ok ? '' : ` ≠ ${JSON.stringify(exp)}`));
  if (!ok) pass = false;
}
if (dCount !== expectedEntries.length || newTotal !== 100) pass = false;
mod._free(eBuf);
mod._vgm_close(ht);

mod._free(entryBuf);
mod._free(fmtBuf);
mod._vgm_close(handle);

console.log();
console.log(pass ? 'OK' : 'FAIL');
process.exit(pass ? 0 : 1);
