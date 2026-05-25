/*
 * Edit operations: insert, update, delete, serialize.
 *
 * Storage model
 *   - Original parsed commands keep file_offset pointing into vgm_file_t.data
 *     and use the original bytes for their args.
 *   - Synthesized commands (inserts or post-update entries) have
 *     file_offset == VGM_SYNTH_OFFSET and own a separate args buffer at
 *     vgm_file_t.synth_args[index].
 *   - The synth_args array is kept in lockstep with commands by
 *     ensure_capacity (parser.c) so edits can index both freely.
 *
 * Timing
 *   - When a wait command is inserted, deleted or has its wait amount
 *     changed, every later command's sample_time shifts. After any edit we
 *     re-walk from the affected index forward and recompute. The header's
 *     total_samples is updated to the new tail time.
 *
 * Optimisations are deliberately *not* applied here. The user spec says we
 * re-render audio from scratch after any edit until we have a reason to do
 * better — keeping the edit code straight-line means the eventual
 * incremental-rerender hook has a single audit surface.
 */
#include "vgmcore.h"
#include "vgmcore_internal.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static vgm_chip_t resolve_chip(uint8_t opcode, const uint8_t *args, uint32_t arg_size) {
    vgm_opcode_info_t info;
    vgm_opcode_classify(opcode, &info);
    vgm_chip_t chip = info.chip;
    /* 0x67 and 0x68 share a leading 0x66 marker byte; the chip/type
     * selector that follows it lives at args[1] in both cases. */
    if ((opcode == 0x67 || opcode == 0x68) && args && arg_size >= 2) {
        chip = vgm_data_block_chip(args[1]);
    }
    return chip;
}

static void recompute_used_chips(vgm_file_t *file) {
    vgm_chip_mask_t used = 0;
    for (uint32_t i = 0; i < file->command_count; i++) {
        used |= VGM_CHIP_BIT(file->commands[i].chip_id);
    }
    file->used_chips = used;
}

static void recompute_sample_times_from(vgm_file_t *file, uint32_t from_index) {
    uint64_t t;
    if (from_index == 0) {
        t = 0;
    } else {
        const vgm_command_entry_t *prev = &file->commands[from_index - 1];
        uint32_t prev_size = 0;
        const uint8_t *prev_args = vgm_command_args(file, from_index - 1, &prev_size);
        t = prev->sample_time + vgm_command_wait_advance(prev->opcode, prev_args, prev_size);
    }
    for (uint32_t i = from_index; i < file->command_count; i++) {
        file->commands[i].sample_time = t;
        uint32_t size = 0;
        const uint8_t *args = vgm_command_args(file, i, &size);
        t += vgm_command_wait_advance(file->commands[i].opcode, args, size);
    }
    file->header.total_samples = t;

    /* Keep header.loop_samples consistent with the post-edit sample times.
     * total_samples just changed, and the loop command's sample_time may
     * have shifted too (insert/delete before it). */
    int loop_idx = vgm_get_loop_index(file);
    if (loop_idx >= 0) {
        file->header.loop_samples =
            (uint32_t)(t - file->commands[loop_idx].sample_time);
    } else {
        file->header.loop_samples = 0;
    }
}

/* Copy or zero `arg_size` bytes into a fresh malloc. Returns NULL when
 * arg_size == 0 (which is fine — entries with no args have NULL synth_args).
 */
static uint8_t *clone_args(const uint8_t *args, uint32_t arg_size) {
    if (arg_size == 0) return NULL;
    uint8_t *buf = (uint8_t *)malloc(arg_size);
    if (!buf) return NULL;
    if (args) memcpy(buf, args, arg_size);
    else      memset(buf, 0, arg_size);
    return buf;
}

/* Locally re-declared to avoid pulling ensure_capacity out of parser.c. */
static int grow_for_one_more(vgm_file_t *file) {
    if (file->command_count + 1 <= file->command_capacity) return VGM_OK;
    uint32_t new_cap = file->command_capacity ? file->command_capacity * 2 : 4096;
    vgm_command_entry_t *next = (vgm_command_entry_t *)realloc(
        file->commands, (size_t)new_cap * sizeof(vgm_command_entry_t));
    if (!next) return VGM_ERR_OUT_OF_MEMORY;
    file->commands = next;
    uint8_t **next_args = (uint8_t **)realloc(
        file->synth_args, (size_t)new_cap * sizeof(uint8_t *));
    if (!next_args) return VGM_ERR_OUT_OF_MEMORY;
    file->synth_args = next_args;
    memset(file->synth_args + file->command_capacity, 0,
           ((size_t)new_cap - file->command_capacity) * sizeof(uint8_t *));
    file->command_capacity = new_cap;
    return VGM_OK;
}

int vgm_insert_command(vgm_file_t *file, uint32_t before_index,
                       uint8_t opcode, const uint8_t *args, uint32_t arg_size) {
    if (!file) return VGM_ERR_INVALID_ARG;
    if (before_index > file->command_count) return VGM_ERR_INVALID_INDEX;

    int rc = grow_for_one_more(file);
    if (rc != VGM_OK) return rc;

    uint8_t *owned = clone_args(args, arg_size);
    if (arg_size > 0 && !owned) return VGM_ERR_OUT_OF_MEMORY;

    /* Shift the tail right by one to make room. */
    if (before_index < file->command_count) {
        memmove(&file->commands[before_index + 1], &file->commands[before_index],
                (file->command_count - before_index) * sizeof(vgm_command_entry_t));
        memmove(&file->synth_args[before_index + 1], &file->synth_args[before_index],
                (file->command_count - before_index) * sizeof(uint8_t *));
    }

    vgm_chip_t chip = resolve_chip(opcode, owned, arg_size);
    file->commands[before_index].sample_time = 0;  /* recomputed below */
    file->commands[before_index].file_offset = VGM_SYNTH_OFFSET;
    file->commands[before_index].arg_size = arg_size;
    file->commands[before_index].opcode = opcode;
    file->commands[before_index].chip_id = (uint8_t)chip;
    file->commands[before_index].flags = 0;
    file->synth_args[before_index] = owned;
    file->command_count++;

    recompute_sample_times_from(file, before_index);
    recompute_used_chips(file);
    return VGM_OK;
}

int vgm_delete_command(vgm_file_t *file, uint32_t index) {
    if (!file) return VGM_ERR_INVALID_ARG;
    if (index >= file->command_count) return VGM_ERR_INVALID_INDEX;

    free(file->synth_args[index]);
    file->synth_args[index] = NULL;

    if (index + 1 < file->command_count) {
        memmove(&file->commands[index], &file->commands[index + 1],
                (file->command_count - index - 1) * sizeof(vgm_command_entry_t));
        memmove(&file->synth_args[index], &file->synth_args[index + 1],
                (file->command_count - index - 1) * sizeof(uint8_t *));
    }
    file->command_count--;
    file->synth_args[file->command_count] = NULL;  /* clear orphan slot */

    recompute_sample_times_from(file, index);
    recompute_used_chips(file);
    return VGM_OK;
}

int vgm_update_command(vgm_file_t *file, uint32_t index,
                       uint8_t opcode, const uint8_t *args, uint32_t arg_size) {
    if (!file) return VGM_ERR_INVALID_ARG;
    if (index >= file->command_count) return VGM_ERR_INVALID_INDEX;

    uint8_t *owned = clone_args(args, arg_size);
    if (arg_size > 0 && !owned) return VGM_ERR_OUT_OF_MEMORY;

    free(file->synth_args[index]);
    file->synth_args[index] = owned;

    vgm_chip_t chip = resolve_chip(opcode, owned, arg_size);
    file->commands[index].file_offset = VGM_SYNTH_OFFSET;
    file->commands[index].arg_size = arg_size;
    file->commands[index].opcode = opcode;
    file->commands[index].chip_id = (uint8_t)chip;

    recompute_sample_times_from(file, index);
    recompute_used_chips(file);
    return VGM_OK;
}

static void write_u32le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

int vgm_serialize(const vgm_file_t *file, uint8_t *buf, uint32_t buf_size) {
    if (!file) return VGM_ERR_INVALID_ARG;

    uint32_t cmds_size = 0;
    /* Track the loop command's serialized byte offset (absolute), if any. */
    uint32_t loop_serialized_offset = 0;
    int loop_idx = -1;
    for (uint32_t i = 0; i < file->command_count; i++) {
        if (file->commands[i].flags & VGM_CMD_FLAG_LOOP) {
            loop_serialized_offset = file->header.data_offset + cmds_size;
            loop_idx = (int)i;
        }
        cmds_size += 1u + file->commands[i].arg_size;
    }
    uint32_t total = file->header.data_offset + cmds_size;

    if (!buf || buf_size == 0) return (int)total;
    if (buf_size < total) return VGM_ERR_INVALID_ARG;

    /* Copy the original header verbatim, then fix up the fields that move
     * after edits. GD3 isn't preserved across edits yet — zero it out. */
    memcpy(buf, file->data, file->header.data_offset);
    write_u32le(buf + 0x04, total - 0x04);                /* eof_offset (rel) */
    write_u32le(buf + 0x14, 0);                            /* gd3_offset */
    write_u32le(buf + 0x18, (uint32_t)file->header.total_samples);
    if (loop_idx >= 0) {
        /* loop_offset is relative to its own field position (0x1C). */
        write_u32le(buf + 0x1C, loop_serialized_offset - 0x1Cu);
        uint64_t loop_samples = file->header.total_samples - file->commands[loop_idx].sample_time;
        write_u32le(buf + 0x20, (uint32_t)loop_samples);
    } else {
        write_u32le(buf + 0x1C, 0);                        /* loop_offset */
        write_u32le(buf + 0x20, 0);                        /* loop_samples */
    }

    uint8_t *out = buf + file->header.data_offset;
    for (uint32_t i = 0; i < file->command_count; i++) {
        const vgm_command_entry_t *e = &file->commands[i];
        *out++ = e->opcode;
        if (e->arg_size > 0) {
            uint32_t sz = 0;
            const uint8_t *args = vgm_command_args(file, i, &sz);
            if (args) memcpy(out, args, e->arg_size);
            else      memset(out, 0, e->arg_size);
            out += e->arg_size;
        }
    }
    return (int)total;
}

int vgm_delete_range(vgm_file_t *file, uint64_t start_sample, uint64_t end_sample) {
    if (!file) return VGM_ERR_INVALID_ARG;
    if (file->command_count == 0) return VGM_OK;
    if (end_sample > file->header.total_samples) end_sample = file->header.total_samples;
    if (start_sample >= end_sample) return VGM_OK;

    /* Walk the command list, compacting kept commands into the front. Each
     * iteration either keeps the entry (possibly rewriting a partially-
     * overlapped wait into a fresh 0x61 with the trimmed amount) or drops
     * it. The synth_args pointers are moved in lockstep; freed slots are
     * NULLed out at the end so the eventual close doesn't double-free. */
    uint32_t write = 0;
    for (uint32_t read = 0; read < file->command_count; read++) {
        vgm_command_entry_t entry = file->commands[read];
        uint8_t *old_owned = file->synth_args[read];

        const uint8_t *args = (entry.file_offset == VGM_SYNTH_OFFSET)
                                  ? old_owned
                                  : (file->data + entry.file_offset + 1);
        uint32_t advance = vgm_command_wait_advance(entry.opcode, args, entry.arg_size);
        uint64_t t = entry.sample_time;

        bool keep = true;
        bool rewrite_as_61 = false;
        uint32_t new_advance = advance;

        if (advance == 0) {
            /* Non-wait — delete iff sample_time falls inside [start, end). */
            if (t >= start_sample && t < end_sample) keep = false;
        } else {
            /* Wait — overlap is the intersection of [t, t+advance) with
             * [start, end). The new advance is the old minus that overlap. */
            uint64_t cmd_end = t + advance;
            uint64_t ov_lo = t > start_sample ? t : start_sample;
            uint64_t ov_hi = cmd_end < end_sample ? cmd_end : end_sample;
            if (ov_hi > ov_lo) {
                uint64_t overlap = ov_hi - ov_lo;
                if (overlap >= advance) {
                    keep = false;
                } else {
                    new_advance = (uint32_t)(advance - overlap);
                    /* Even when the original wait was a one-byte form
                     * (0x62 / 0x63 / 0x70-0x7F / 0x80-0x8F), rewrite as a
                     * canonical 0x61 since that's the only form that can
                     * carry an arbitrary 0-65535 sample count. We lose any
                     * 0x80-0x8F DAC write that sat in the selection, which
                     * is fine — that DAC byte was inside the deleted range. */
                    rewrite_as_61 = true;
                }
            }
        }

        if (!keep) {
            free(old_owned);
            continue;
        }

        if (rewrite_as_61) {
            free(old_owned);
            uint8_t *new_args = (uint8_t *)malloc(2);
            if (!new_args) return VGM_ERR_OUT_OF_MEMORY;
            new_args[0] = (uint8_t)(new_advance & 0xFF);
            new_args[1] = (uint8_t)((new_advance >> 8) & 0xFF);
            entry.opcode = 0x61;
            entry.arg_size = 2;
            entry.file_offset = VGM_SYNTH_OFFSET;
            entry.chip_id = (uint8_t)VGM_CHIP_CONTROL;
            file->synth_args[write] = new_args;
        } else {
            /* Move the existing args pointer along — when read == write
             * this is a self-assignment, otherwise it transfers ownership.
             * The trailing synth_args slot will be NULLed below. */
            file->synth_args[write] = old_owned;
        }

        file->commands[write] = entry;
        write++;
    }

    /* Null out any slots above the new tail so they don't carry dangling
     * pointers into the next close/edit. */
    for (uint32_t i = write; i < file->command_capacity; i++) {
        file->synth_args[i] = NULL;
    }
    file->command_count = write;

    recompute_sample_times_from(file, 0);
    /* Rebuild used_chips after deletion. */
    vgm_chip_mask_t used = 0;
    for (uint32_t i = 0; i < file->command_count; i++) {
        used |= VGM_CHIP_BIT(file->commands[i].chip_id);
    }
    file->used_chips = used;
    return VGM_OK;
}

int vgm_get_loop_index(const vgm_file_t *file) {
    if (!file) return -1;
    for (uint32_t i = 0; i < file->command_count; i++) {
        if (file->commands[i].flags & VGM_CMD_FLAG_LOOP) return (int)i;
    }
    return -1;
}

int vgm_set_loop_index(vgm_file_t *file, int index) {
    if (!file) return VGM_ERR_INVALID_ARG;
    if (index < -1 || (index >= 0 && (uint32_t)index >= file->command_count)) {
        return VGM_ERR_INVALID_INDEX;
    }
    /* Clear any existing loop flag — there can only ever be one. */
    for (uint32_t i = 0; i < file->command_count; i++) {
        file->commands[i].flags &= (uint16_t)~VGM_CMD_FLAG_LOOP;
    }
    if (index >= 0) {
        file->commands[index].flags |= VGM_CMD_FLAG_LOOP;
        /* Keep the header's exposed loop_samples in sync with the new
         * loop point so JS readers don't see a stale value. */
        file->header.loop_samples = (uint32_t)(file->header.total_samples -
                                               file->commands[index].sample_time);
    } else {
        file->header.loop_offset = 0;
        file->header.loop_samples = 0;
    }
    return VGM_OK;
}
