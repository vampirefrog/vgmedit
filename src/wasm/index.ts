/**
 * High-level TypeScript wrapper around the vgmcore WASM module.
 *
 * - Loads the module lazily on first use; subsequent calls reuse the instance.
 * - Wraps a parsed file as an opaque VgmFile class with a JS-friendly API.
 * - Surfaces commands and headers as plain JS objects; internally everything
 *   stays in WASM memory until requested, so opening large files is cheap.
 *
 * Sample times are exposed as JS Numbers. JS Number is safe to 2^53; a VGM
 * lasting many years at 44.1 kHz still fits, so the loss of u64 range is
 * not a practical concern.
 */

import createVgmCore, { type VgmCoreModule } from './vgmcore.js';

export const VgmChip = {
  NONE: 0,
  SN76489: 1,
  YM2413: 2,
  YM2612: 3,
  YM2151: 4,
  SEGAPCM: 5,
  RF5C68: 6,
  YM2203: 7,
  YM2608: 8,
  YM2610: 9,
  YM3812: 10,
  YM3526: 11,
  Y8950: 12,
  YMF262: 13,
  YMF278B: 14,
  YMF271: 15,
  YMZ280B: 16,
  RF5C164: 17,
  PWM: 18,
  AY8910: 19,
  GAMEBOY: 20,
  NESAPU: 21,
  MULTIPCM: 22,
  UPD7759: 23,
  OKIM6258: 24,
  OKIM6295: 25,
  K051649: 26,
  K054539: 27,
  HUC6280: 28,
  C140: 29,
  K053260: 30,
  POKEY: 31,
  QSOUND: 32,
  SCSP: 33,
  WONDERSWAN: 34,
  VSU: 35,
  SAA1099: 36,
  ES5503: 37,
  ES5506: 38,
  X1_010: 39,
  C352: 40,
  GA20: 41,
  DAC_STREAM: 42,
  DATA_BLOCK: 43,
  CONTROL: 44,
} as const;

export type VgmChipId = (typeof VgmChip)[keyof typeof VgmChip];

export const VGM_SAMPLE_RATE = 44100;
export const VGM_CHIP_FILTER_ALL = 0xFFFFFFFFFFFFFFFFn;
export const chipBit = (chip: VgmChipId): bigint => 1n << BigInt(chip);

export interface VgmHeader {
  version: number;
  dataOffset: number;
  gd3Offset: number;
  eofOffset: number;
  totalSamples: number;
  /** Absolute byte offset of the loop command in the *original* file; not
   *  kept in sync after edits — use `VgmFile.getLoopIndex()` instead. */
  loopOffset: number;
  /** Number of samples in one loop cycle (totalSamples - loop_start_sample).
   *  Kept up-to-date by the C edit ops. */
  loopSamples: number;
  rate: number;
  chipClocks: Record<number, number>;  // chip id → Hz, only entries with clock > 0
}

export interface VgmCommand {
  index: number;
  sampleTime: number;
  fileOffset: number;
  opcode: number;
  chipId: VgmChipId;
  argSize: number;
}

export interface HeatmapOptions {
  startSample: number;
  endSample: number;
  pixelCount: number;
  chipFilter?: bigint;   // default: all chips
  step?: number;         // 0-255 per-hit increment, default 32
}

let moduleSingleton: Promise<VgmCoreModule> | null = null;
let cachedModule: VgmCoreModule | null = null;
let sizeofCommandEntry = 0;
let chipCount = 0;
let chipClocksOffset = 0;

async function loadModule(): Promise<VgmCoreModule> {
  if (!moduleSingleton) {
    moduleSingleton = createVgmCore().then((mod) => {
      sizeofCommandEntry = mod._vgm_sizeof_command_entry();
      chipCount = mod._vgm_chip_count();
      chipClocksOffset = mod._vgm_offsetof_header_chip_clocks();
      cachedModule = mod;
      return mod;
    });
  }
  return moduleSingleton;
}

/** Synchronous access to the loaded module — only valid after a successful
 *  `VgmFile.open` or explicit `initVgmCore()` call. Used by code paths
 *  that need to call WASM in callbacks where awaiting would be wrong
 *  (e.g. audio-thread scheduling). */
export function getCachedModule(): VgmCoreModule | null {
  return cachedModule;
}

/** Read a possibly-padded uint64 from WASM heap as a JS Number. */
function readU64(mod: VgmCoreModule, byteOffset: number): number {
  const lo = mod.HEAPU32[byteOffset >>> 2];
  const hi = mod.HEAPU32[(byteOffset + 4) >>> 2];
  // hi * 2^32 + lo — exact up to 2^53
  return hi * 0x1_0000_0000 + lo;
}

function readHeader(mod: VgmCoreModule, ptr: number): VgmHeader {
  const u32 = (off: number) => mod.HEAPU32[(ptr + off) >>> 2];
  const header: VgmHeader = {
    version: u32(0),
    dataOffset: u32(4),
    gd3Offset: u32(8),
    eofOffset: u32(12),
    totalSamples: readU64(mod, ptr + 16),
    loopOffset: u32(24),
    loopSamples: u32(28),
    rate: u32(32),
    chipClocks: {},
  };
  for (let i = 0; i < chipCount; i++) {
    const clock = mod.HEAPU32[(ptr + chipClocksOffset + i * 4) >>> 2];
    if (clock) header.chipClocks[i] = clock;
  }
  return header;
}

function readCommandEntry(mod: VgmCoreModule, ptr: number, index: number): VgmCommand {
  return {
    index,
    sampleTime: readU64(mod, ptr),
    fileOffset: mod.HEAPU32[(ptr + 8) >>> 2],
    argSize: mod.HEAPU32[(ptr + 12) >>> 2],
    opcode: mod.HEAPU8[ptr + 16],
    chipId: mod.HEAPU8[ptr + 17] as VgmChipId,
  };
}

export class VgmFile {
  private constructor(
    private readonly mod: VgmCoreModule,
    private handle: number,
    public readonly header: VgmHeader,
    public commandCount: number,
  ) {}

  static async open(data: Uint8Array): Promise<VgmFile> {
    const mod = await loadModule();
    const ptr = mod._malloc(data.length);
    mod.HEAPU8.set(data, ptr);
    const statusPtr = mod._malloc(4);
    const handle = mod._vgm_open(ptr, data.length, statusPtr);
    const status = mod.HEAP32[statusPtr >>> 2];
    mod._free(ptr);
    mod._free(statusPtr);
    if (handle === 0) {
      throw new Error(`vgm_open failed with status ${status}`);
    }
    const headerPtr = mod._vgm_header(handle);
    const header = readHeader(mod, headerPtr);
    const count = mod._vgm_command_count(handle);
    return new VgmFile(mod, handle, header, count);
  }

  close(): void {
    if (this.handle !== 0) {
      this.mod._vgm_close(this.handle);
      this.handle = 0;
    }
  }

  getCommand(index: number): VgmCommand {
    if (index < 0 || index >= this.commandCount) {
      throw new RangeError(`command index ${index} out of range (0..${this.commandCount})`);
    }
    const buf = this.mod._malloc(sizeofCommandEntry);
    const rc = this.mod._vgm_get_command(this.handle, index, buf);
    if (rc !== 0) {
      this.mod._free(buf);
      throw new Error(`vgm_get_command(${index}) -> ${rc}`);
    }
    const entry = readCommandEntry(this.mod, buf, index);
    this.mod._free(buf);
    return entry;
  }

  /**
   * Read a contiguous range of commands in one go — much faster than calling
   * getCommand in a loop because each entry skips the malloc/free round trip.
   * The end index is exclusive and clamped to commandCount.
   */
  getCommandRange(startIndex: number, endIndex: number): VgmCommand[] {
    const lo = Math.max(0, startIndex | 0);
    const hi = Math.min(this.commandCount, endIndex | 0);
    if (hi <= lo) return [];
    const buf = this.mod._malloc(sizeofCommandEntry);
    const out: VgmCommand[] = new Array(hi - lo);
    for (let i = lo; i < hi; i++) {
      this.mod._vgm_get_command(this.handle, i, buf);
      out[i - lo] = readCommandEntry(this.mod, buf, i);
    }
    this.mod._free(buf);
    return out;
  }

  formatCommand(index: number, bufSize = 192): string {
    const buf = this.mod._malloc(bufSize);
    this.mod._vgm_format_command(this.handle, index, buf, bufSize);
    const text = this.mod.UTF8ToString(buf);
    this.mod._free(buf);
    return text;
  }

  /** Copy of the command's raw argument bytes. */
  commandArgs(index: number): Uint8Array {
    if (index < 0 || index >= this.commandCount) {
      throw new RangeError(`command index ${index} out of range`);
    }
    const sizePtr = this.mod._malloc(4);
    const argsPtr = this.mod._vgm_command_args(this.handle, index, sizePtr);
    const size = this.mod.HEAPU32[sizePtr >>> 2];
    this.mod._free(sizePtr);
    if (!argsPtr || size === 0) return new Uint8Array(0);
    return new Uint8Array(this.mod.HEAPU8.buffer, argsPtr, size).slice();
  }

  /* --- Mutations -------------------------------------------------------- */

  /** Insert a command at the given index. All later commands shift right.
   *  Returns 0 on success; negative status code on failure. After any
   *  successful edit, header/commandCount are refreshed from the C side. */
  insertCommand(beforeIndex: number, opcode: number, args: Uint8Array): number {
    const ptr = args.length > 0 ? this.mod._malloc(args.length) : 0;
    if (ptr) this.mod.HEAPU8.set(args, ptr);
    const rc = this.mod._vgm_insert_command(this.handle, beforeIndex, opcode, ptr, args.length);
    if (ptr) this.mod._free(ptr);
    if (rc === 0) this.refresh();
    return rc;
  }

  deleteCommand(index: number): number {
    const rc = this.mod._vgm_delete_command(this.handle, index);
    if (rc === 0) this.refresh();
    return rc;
  }

  updateCommand(index: number, opcode: number, args: Uint8Array): number {
    const ptr = args.length > 0 ? this.mod._malloc(args.length) : 0;
    if (ptr) this.mod.HEAPU8.set(args, ptr);
    const rc = this.mod._vgm_update_command(this.handle, index, opcode, ptr, args.length);
    if (ptr) this.mod._free(ptr);
    if (rc === 0) this.refresh();
    return rc;
  }

  /** Returns the index of the command flagged as the loop point, or null
   *  if no loop is set. */
  getLoopIndex(): number | null {
    const idx = this.mod._vgm_get_loop_index(this.handle);
    return idx < 0 ? null : idx;
  }

  /** Sets (or clears with null) the loop point. The loop is tracked by a
   *  per-command flag, not a file offset, so it stays pinned to the same
   *  command across inserts/deletes around it. */
  setLoopIndex(index: number | null): number {
    const rc = this.mod._vgm_set_loop_index(this.handle, index === null ? -1 : index);
    if (rc === 0) this.refresh();
    return rc;
  }

  /** Delete commands in the sample range [start, end). Waits crossing the
   *  boundary are trimmed by their overlap with the range, non-wait
   *  commands inside the range are dropped. */
  deleteRange(startSample: number, endSample: number): number {
    const rc = this.mod._vgm_delete_range(
      this.handle,
      BigInt(Math.max(0, Math.floor(startSample))),
      BigInt(Math.max(0, Math.floor(endSample))),
    );
    if (rc === 0) this.refresh();
    return rc;
  }

  /** Re-emit the current command list as a VGM byte stream. */
  serialize(): Uint8Array {
    const needed = this.mod._vgm_serialize(this.handle, 0, 0);
    if (needed <= 0) return new Uint8Array(0);
    const buf = this.mod._malloc(needed);
    const written = this.mod._vgm_serialize(this.handle, buf, needed);
    const out = new Uint8Array(this.mod.HEAPU8.buffer, buf, written).slice();
    this.mod._free(buf);
    return out;
  }

  /** Re-read commandCount and the header fields that the C edit ops mutate
   *  in place (totalSamples, loopOffset, loopSamples). */
  private refresh(): void {
    this.commandCount = this.mod._vgm_command_count(this.handle);
    const headerPtr = this.mod._vgm_header(this.handle);
    this.header.totalSamples = readU64(this.mod, headerPtr + 16);
    this.header.loopOffset = this.mod.HEAPU32[(headerPtr + 24) >>> 2];
    this.header.loopSamples = this.mod.HEAPU32[(headerPtr + 28) >>> 2];
  }

  /**
   * Compute a heatmap into a fresh Uint8Array of length pixelCount. The
   * underlying WASM scratch buffer is allocated and freed each call; for a
   * tight redraw loop, the caller can either accept that overhead (it's
   * one malloc per redraw) or keep a persistent ScratchBuffer (future work).
   */
  computeHeatmap(opts: HeatmapOptions): Uint8Array {
    const buf = this.mod._malloc(opts.pixelCount);
    this.mod._vgm_heatmap(
      this.handle,
      BigInt(Math.max(0, Math.floor(opts.startSample))),
      BigInt(Math.max(0, Math.floor(opts.endSample))),
      opts.pixelCount,
      opts.chipFilter ?? VGM_CHIP_FILTER_ALL,
      opts.step ?? 32,
      buf,
    );
    const view = new Uint8Array(this.mod.HEAPU8.buffer, buf, opts.pixelCount);
    const out = new Uint8Array(view);  // copy out before freeing
    this.mod._free(buf);
    return out;
  }

  usedChipMask(): bigint {
    return this.mod._vgm_used_chip_mask(this.handle);
  }

  /** Index of the command with the largest sample_time ≤ `sample`. Returns
   *  -1 when `sample` is before any command, or commandCount-1 when it's
   *  past the last. Binary search — ~log₂N WASM round-trips per call. */
  findCommandIndexAtSample(sample: number): number {
    if (this.commandCount === 0) return -1;
    let lo = 0;
    let hi = this.commandCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmd = this.getCommand(mid);
      if (cmd.sampleTime > sample) hi = mid;
      else lo = mid + 1;
    }
    return lo - 1;
  }

  chipName(chip: VgmChipId, short = false): string {
    return getChipNameSync(this.mod, chip, short);
  }

  /** Returns chip IDs that have at least one command in this file. */
  usedChips(): VgmChipId[] {
    const mask = this.usedChipMask();
    const out: VgmChipId[] = [];
    for (let i = 0; i < chipCount; i++) {
      if ((mask & (1n << BigInt(i))) !== 0n) out.push(i as VgmChipId);
    }
    return out;
  }
}

/**
 * Look up a chip name without needing an open file. Loads the module on
 * first call.
 */
export async function getChipName(chip: VgmChipId, short = false): Promise<string> {
  const mod = await loadModule();
  const fn = short ? mod._vgm_chip_short_name : mod._vgm_chip_name;
  return mod.UTF8ToString(fn(chip));
}

/** Synchronous chip name lookup — only safe after the module has loaded. */
export function getChipNameSync(mod: VgmCoreModule, chip: VgmChipId, short = false): string {
  const fn = short ? mod._vgm_chip_short_name : mod._vgm_chip_name;
  return mod.UTF8ToString(fn(chip));
}

/** Eager initialization — call once at app startup if you want to surface
 *  load errors early. Subsequent VgmFile.open calls become synchronous-ish. */
export async function initVgmCore(): Promise<void> {
  await loadModule();
}
