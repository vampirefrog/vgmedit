/*
 * Internal declarations shared between vgmcore translation units.
 * Not part of the public API — do not include from outside core/src.
 */
#ifndef VGMCORE_INTERNAL_H
#define VGMCORE_INTERNAL_H

#include "vgmcore.h"
#include <stdint.h>

typedef struct {
    uint32_t   arg_size;    /* fixed arg byte count, 0xFFFFFFFF for variable */
    vgm_chip_t chip;
    const char *name;
} vgm_opcode_info_t;

/* 256-entry table indexed by opcode. Some slots are zeroed (unknown / range);
 * use vgm_opcode_classify to resolve any opcode safely. */
extern const vgm_opcode_info_t vgm_opcode_table[256];

void       vgm_opcode_classify(uint8_t opcode, vgm_opcode_info_t *out);
vgm_chip_t vgm_data_block_chip(uint8_t type);

/* How many samples this command tells the player to wait before the next
 * command runs. 0 for non-wait commands. Reads up to two bytes of args
 * for the 0x61 case, so callers must pass at least that much when arg_size
 * permits. */
uint32_t vgm_command_wait_advance(uint8_t opcode, const uint8_t *args, uint32_t arg_size);

/* Sentinel `file_offset` value for synthesized (post-parse-edit) commands.
 * When a command's offset equals this, its args live in synth_args[index]
 * rather than in the original file buffer. */
#define VGM_SYNTH_OFFSET 0xFFFFFFFFu

struct vgm_file_s {
    uint8_t *data;        /* owned copy of original file bytes */
    uint32_t data_size;

    vgm_header_t header;

    vgm_command_entry_t *commands;
    /* Parallel to commands[], same capacity. NULL for entries whose args
     * still live in `data`; malloc'd buffer of `arg_size` bytes for
     * synthesized entries (inserts/edits). */
    uint8_t            **synth_args;
    uint32_t             command_count;
    uint32_t             command_capacity;

    vgm_chip_mask_t      used_chips;
};

#endif /* VGMCORE_INTERNAL_H */
