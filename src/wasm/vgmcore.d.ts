/**
 * Type stub for the Emscripten-generated vgmcore.js module.
 *
 * The .js file is produced by `core/wasm/build.sh` and is not type-checked
 * itself. This declaration mirrors the EXPORTED_FUNCTIONS list in that
 * script.
 */

export interface VgmCoreModule {
  /** WASM heap views — populated by Emscripten on init. */
  HEAP8: Int8Array;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAPU16: Uint16Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;

  _malloc(size: number): number;
  _free(ptr: number): void;

  UTF8ToString(ptr: number, maxBytes?: number): string;

  _vgm_open(dataPtr: number, size: number, statusPtr: number): number;
  _vgm_close(handle: number): void;
  _vgm_header(handle: number): number;
  _vgm_command_count(handle: number): number;
  _vgm_get_command(handle: number, index: number, outPtr: number): number;
  _vgm_command_args(handle: number, index: number, sizeOutPtr: number): number;
  _vgm_format_command(handle: number, index: number, buf: number, bufSize: number): number;
  _vgm_heatmap(
    handle: number,
    startSample: bigint,
    endSample: bigint,
    pixelCount: number,
    chipFilter: bigint,
    step: number,
    intensityOut: number,
  ): void;
  _vgm_used_chip_mask(handle: number): bigint;
  _vgm_chip_name(chip: number): number;
  _vgm_chip_short_name(chip: number): number;

  _vgm_insert_command(
    handle: number, beforeIndex: number,
    opcode: number, argsPtr: number, argSize: number,
  ): number;
  _vgm_delete_command(handle: number, index: number): number;
  _vgm_update_command(
    handle: number, index: number,
    opcode: number, argsPtr: number, argSize: number,
  ): number;
  _vgm_serialize(handle: number, buf: number, bufSize: number): number;
  _vgm_get_loop_index(handle: number): number;
  _vgm_set_loop_index(handle: number, index: number): number;

  _vgm_sizeof_command_entry(): number;
  _vgm_sizeof_header(): number;
  _vgm_chip_count(): number;
  _vgm_offsetof_header_chip_clocks(): number;
}

export default function createVgmCore(opts?: Partial<VgmCoreModule>): Promise<VgmCoreModule>;
