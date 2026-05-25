/*
 * VGM file parser.
 *
 * Two passes:
 *   1. parse_header  — verify magic, decode the relevant header fields, derive
 *                       the absolute data offset based on the file's version.
 *   2. parse_commands — walk the command stream, recording each command's
 *                       byte offset, opcode, argument span, attributed chip,
 *                       and the running sample time. Stops at 0x66 (end) or
 *                       when the data offset reaches eof_offset.
 *
 * Capacity grows geometrically. The whole-file byte buffer is copied so the
 * caller is free to release theirs immediately after vgm_open returns.
 */
#include "vgmcore.h"
#include "vgmcore_internal.h"

#include <stdlib.h>
#include <string.h>

static uint32_t read_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* Read a clock field, masking off the dual-chip and variant bits. */
static uint32_t read_clock(const uint8_t *data, uint32_t size, uint32_t offset) {
    if (offset + 4 > size) return 0;
    return read_u32le(data + offset) & 0x3FFFFFFFu;
}

/* (header_offset, chip_id, min_version) table for chip clocks. We only read a
 * field if both the file's version and physical size cover it. */
typedef struct {
    uint16_t   offset;
    uint16_t   min_version;
    vgm_chip_t chip;
} chip_field_t;

static const chip_field_t chip_fields[] = {
    {0x0C, 0x100, VGM_CHIP_SN76489},
    {0x10, 0x100, VGM_CHIP_YM2413},
    {0x2C, 0x110, VGM_CHIP_YM2612},
    {0x30, 0x110, VGM_CHIP_YM2151},
    {0x38, 0x151, VGM_CHIP_SEGAPCM},
    {0x40, 0x151, VGM_CHIP_RF5C68},
    {0x44, 0x151, VGM_CHIP_YM2203},
    {0x48, 0x151, VGM_CHIP_YM2608},
    {0x4C, 0x151, VGM_CHIP_YM2610},
    {0x50, 0x151, VGM_CHIP_YM3812},
    {0x54, 0x151, VGM_CHIP_YM3526},
    {0x58, 0x151, VGM_CHIP_Y8950},
    {0x5C, 0x151, VGM_CHIP_YMF262},
    {0x60, 0x151, VGM_CHIP_YMF278B},
    {0x64, 0x151, VGM_CHIP_YMF271},
    {0x68, 0x151, VGM_CHIP_YMZ280B},
    {0x6C, 0x151, VGM_CHIP_RF5C164},
    {0x70, 0x151, VGM_CHIP_PWM},
    {0x74, 0x151, VGM_CHIP_AY8910},
    {0x80, 0x161, VGM_CHIP_GAMEBOY},
    {0x84, 0x161, VGM_CHIP_NESAPU},
    {0x88, 0x161, VGM_CHIP_MULTIPCM},
    {0x8C, 0x161, VGM_CHIP_UPD7759},
    {0x90, 0x161, VGM_CHIP_OKIM6258},
    {0x98, 0x161, VGM_CHIP_OKIM6295},
    {0x9C, 0x161, VGM_CHIP_K051649},
    {0xA0, 0x161, VGM_CHIP_K054539},
    {0xA4, 0x161, VGM_CHIP_HUC6280},
    {0xA8, 0x161, VGM_CHIP_C140},
    {0xAC, 0x161, VGM_CHIP_K053260},
    {0xB0, 0x161, VGM_CHIP_POKEY},
    {0xB4, 0x161, VGM_CHIP_QSOUND},
    {0xB8, 0x171, VGM_CHIP_SCSP},
    {0xC0, 0x171, VGM_CHIP_WONDERSWAN},
    {0xC4, 0x171, VGM_CHIP_VSU},
    {0xC8, 0x171, VGM_CHIP_SAA1099},
    {0xCC, 0x171, VGM_CHIP_ES5503},
    {0xD0, 0x171, VGM_CHIP_ES5506},
    {0xD8, 0x171, VGM_CHIP_X1_010},
    {0xDC, 0x171, VGM_CHIP_C352},
    {0xE0, 0x171, VGM_CHIP_GA20},
};

static int parse_header(vgm_file_t *file) {
    const uint8_t *d = file->data;
    uint32_t       size = file->data_size;

    if (size < 0x40) return VGM_ERR_TRUNCATED;
    if (d[0] != 'V' || d[1] != 'g' || d[2] != 'm' || d[3] != ' ') {
        return VGM_ERR_BAD_MAGIC;
    }

    vgm_header_t *h = &file->header;
    memset(h, 0, sizeof(*h));

    /* EOF offset (relative to 0x04) */
    uint32_t eof_rel = read_u32le(d + 0x04);
    h->eof_offset = (eof_rel != 0 && eof_rel < UINT32_MAX - 4) ? eof_rel + 0x04 : size;
    if (h->eof_offset > size) h->eof_offset = size;

    h->version = read_u32le(d + 0x08);

    /* GD3 offset (relative to 0x14) */
    uint32_t gd3_rel = read_u32le(d + 0x14);
    h->gd3_offset = gd3_rel ? gd3_rel + 0x14 : 0;

    h->total_samples = read_u32le(d + 0x18);

    /* Loop offset (relative to 0x1C) */
    uint32_t loop_rel = read_u32le(d + 0x1C);
    h->loop_offset = loop_rel ? loop_rel + 0x1C : 0;
    h->loop_samples = read_u32le(d + 0x20);

    if (size >= 0x28) h->rate = read_u32le(d + 0x24);

    /* Data offset is only present in v1.50+; otherwise data starts at 0x40. */
    uint32_t data_off = 0x40;
    if (h->version >= 0x150 && size >= 0x38) {
        uint32_t data_rel = read_u32le(d + 0x34);
        if (data_rel) data_off = data_rel + 0x34;
    }
    if (data_off < 0x40) data_off = 0x40;
    if (data_off > size) return VGM_ERR_TRUNCATED;
    h->data_offset = data_off;

    /* Chip clocks — only read fields whose offset fits within the header
     * (data_offset is the end of the header) and whose chip was defined at or
     * before this file's version. */
    for (size_t i = 0; i < sizeof(chip_fields) / sizeof(chip_fields[0]); i++) {
        const chip_field_t *f = &chip_fields[i];
        if (h->version < f->min_version) continue;
        if ((uint32_t)f->offset + 4 > data_off) continue;
        uint32_t clock = read_clock(d, size, f->offset);
        if (clock) h->chip_clocks[f->chip] = clock;
    }

    return VGM_OK;
}

static int ensure_capacity(vgm_file_t *file, uint32_t needed) {
    if (needed <= file->command_capacity) return VGM_OK;
    uint32_t new_cap = file->command_capacity ? file->command_capacity * 2 : 4096;
    while (new_cap < needed) new_cap *= 2;
    vgm_command_entry_t *next = (vgm_command_entry_t *)realloc(
        file->commands, (size_t)new_cap * sizeof(vgm_command_entry_t));
    if (!next) return VGM_ERR_OUT_OF_MEMORY;
    file->commands = next;
    /* Keep synth_args sized in lockstep with commands so edit operations
     * can index both arrays interchangeably. */
    uint8_t **next_args = (uint8_t **)realloc(
        file->synth_args, (size_t)new_cap * sizeof(uint8_t *));
    if (!next_args) return VGM_ERR_OUT_OF_MEMORY;
    file->synth_args = next_args;
    memset(file->synth_args + file->command_capacity, 0,
           ((size_t)new_cap - file->command_capacity) * sizeof(uint8_t *));
    file->command_capacity = new_cap;
    return VGM_OK;
}

/* Variable-length opcode handler. Returns the total arg byte count via
 * *arg_size_out and the chip attribution via *chip_out. Reads at most
 * `available` bytes after the opcode. */
static int parse_variable(uint8_t opcode, const uint8_t *args, uint32_t available,
                          uint32_t *arg_size_out, vgm_chip_t *chip_out) {
    if (opcode == 0x67) {
        /* 0x67 0x66 type:1 size:4 data:size */
        if (available < 6) return VGM_ERR_TRUNCATED;
        uint8_t  type = args[1];
        uint32_t size = read_u32le(args + 2);
        if ((uint64_t)6 + size > available) return VGM_ERR_TRUNCATED;
        *arg_size_out = 6 + size;
        *chip_out = vgm_data_block_chip(type);
        return VGM_OK;
    }
    return VGM_ERR_INVALID_ARG;
}

static int parse_commands(vgm_file_t *file) {
    const uint8_t *d = file->data;
    uint32_t       size = file->data_size;
    uint32_t       end = file->header.eof_offset;
    if (end > size) end = size;

    uint64_t sample_time = 0;
    uint32_t cursor = file->header.data_offset;

    while (cursor < end) {
        uint8_t opcode = d[cursor];
        vgm_opcode_info_t info;
        vgm_opcode_classify(opcode, &info);

        uint32_t arg_size;
        vgm_chip_t chip;
        if (info.arg_size == 0xFFFFFFFFu) {
            uint32_t avail = end - cursor - 1;
            int rc = parse_variable(opcode, d + cursor + 1, avail, &arg_size, &chip);
            if (rc != VGM_OK) return rc;
            /* 0x68 has a fixed 11-byte payload but its first arg byte selects
             * the target chip; resolve that here. */
        } else {
            arg_size = info.arg_size;
            chip = info.chip;
            if (cursor + 1 + arg_size > end) return VGM_ERR_TRUNCATED;
            /* 0x68 PCM RAM write — payload is `66 chip:1 src:3 dst:3 size:3`,
             * so the chip-selector byte sits at args[1] (args[0] is the
             * 0x66 marker shared with 0x67). */
            if (opcode == 0x68 && arg_size >= 2) {
                chip = vgm_data_block_chip(d[cursor + 2]);
            }
        }

        int rc = ensure_capacity(file, file->command_count + 1);
        if (rc != VGM_OK) return rc;

        vgm_command_entry_t *e = &file->commands[file->command_count++];
        e->sample_time = sample_time;
        e->file_offset = cursor;
        e->arg_size = arg_size;
        e->opcode = opcode;
        e->chip_id = (uint8_t)chip;
        e->flags = 0;

        if ((unsigned)chip < VGM_CHIP_COUNT) {
            file->used_chips |= VGM_CHIP_BIT(chip);
        }

        /* Advance sample time for wait commands using the shared helper so
         * the parser and post-edit recomputation stay in sync. */
        sample_time += vgm_command_wait_advance(opcode, d + cursor + 1, arg_size);

        cursor += 1 + arg_size;

        if (opcode == 0x66) break;
    }

    /* If the header didn't quote total_samples (older v1.00 files), trust the
     * value we just accumulated. */
    if (file->header.total_samples == 0) {
        file->header.total_samples = sample_time;
    }

    /* Restore the loop flag on whichever parsed command originally lived at
     * header.loop_offset. The header's loop_offset was already resolved to
     * an absolute file offset by parse_header. */
    if (file->header.loop_offset != 0) {
        for (uint32_t i = 0; i < file->command_count; i++) {
            if (file->commands[i].file_offset == file->header.loop_offset) {
                file->commands[i].flags |= VGM_CMD_FLAG_LOOP;
                break;
            }
        }
    }
    return VGM_OK;
}

vgm_file_t *vgm_open(const uint8_t *data, uint32_t size, vgm_status_t *status_out) {
    vgm_status_t status = VGM_OK;
    vgm_file_t  *file = NULL;

    if (!data || size < 0x40) {
        status = VGM_ERR_TRUNCATED;
        goto fail;
    }

    file = (vgm_file_t *)calloc(1, sizeof(*file));
    if (!file) {
        status = VGM_ERR_OUT_OF_MEMORY;
        goto fail;
    }
    file->data = (uint8_t *)malloc(size);
    if (!file->data) {
        status = VGM_ERR_OUT_OF_MEMORY;
        goto fail;
    }
    memcpy(file->data, data, size);
    file->data_size = size;

    int rc = parse_header(file);
    if (rc != VGM_OK) {
        status = (vgm_status_t)rc;
        goto fail;
    }
    rc = parse_commands(file);
    if (rc != VGM_OK) {
        status = (vgm_status_t)rc;
        goto fail;
    }

    if (status_out) *status_out = VGM_OK;
    return file;

fail:
    if (file) {
        free(file->data);
        free(file->commands);
        free(file->synth_args);
        free(file);
    }
    if (status_out) *status_out = status;
    return NULL;
}

void vgm_close(vgm_file_t *file) {
    if (!file) return;
    if (file->synth_args) {
        for (uint32_t i = 0; i < file->command_count; i++) {
            free(file->synth_args[i]);
        }
        free(file->synth_args);
    }
    free(file->data);
    free(file->commands);
    free(file);
}

const vgm_header_t *vgm_header(const vgm_file_t *file) {
    return file ? &file->header : NULL;
}

uint32_t vgm_command_count(const vgm_file_t *file) {
    return file ? file->command_count : 0;
}

int vgm_get_command(const vgm_file_t *file, uint32_t index, vgm_command_entry_t *out) {
    if (!file || !out) return VGM_ERR_INVALID_ARG;
    if (index >= file->command_count) return VGM_ERR_INVALID_INDEX;
    *out = file->commands[index];
    return VGM_OK;
}

const uint8_t *vgm_command_args(const vgm_file_t *file, uint32_t index, uint32_t *size_out) {
    if (!file || index >= file->command_count) {
        if (size_out) *size_out = 0;
        return NULL;
    }
    const vgm_command_entry_t *e = &file->commands[index];
    if (size_out) *size_out = e->arg_size;
    if (e->file_offset == VGM_SYNTH_OFFSET) {
        return file->synth_args ? file->synth_args[index] : NULL;
    }
    return file->data + e->file_offset + 1;
}

vgm_chip_mask_t vgm_used_chip_mask(const vgm_file_t *file) {
    return file ? file->used_chips : 0;
}
