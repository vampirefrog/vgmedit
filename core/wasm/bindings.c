/*
 * WebAssembly-specific helpers.
 *
 * These exist so JS can:
 *   - learn sizeof for structs without hard-coding (struct layout is
 *     C-toolchain-dependent),
 *   - read enum constants symbolically.
 *
 * They are not part of the public C API used by native frontends.
 */
#include "vgmcore.h"
#include "vgmcore_internal.h"

#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE uint32_t vgm_sizeof_command_entry(void) { return (uint32_t)sizeof(vgm_command_entry_t); }
EMSCRIPTEN_KEEPALIVE uint32_t vgm_sizeof_header(void) { return (uint32_t)sizeof(vgm_header_t); }
EMSCRIPTEN_KEEPALIVE uint32_t vgm_chip_count(void) { return (uint32_t)VGM_CHIP_COUNT; }

/* Offset accessors so the JS struct readers don't need to assume packing. */
EMSCRIPTEN_KEEPALIVE uint32_t vgm_offsetof_header_chip_clocks(void) {
    return (uint32_t)offsetof(vgm_header_t, chip_clocks);
}
