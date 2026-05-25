/*
 * vgm2txt-style per-command text formatter.
 *
 * One line per command, fixed-ish columns so the command list reads as a
 * dump: short opcode mnemonic, hex args, then a chip-specific decoded form
 * where one is helpful (register/value, wait amount, data block type/size).
 *
 * snprintf accumulates into `buf`; we return the number of bytes that would
 * have been written (excluding NUL) so the caller can detect truncation.
 */
#include "vgmcore.h"
#include "vgmcore_internal.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint16_t read_u16le(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}
static uint32_t read_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* Hex-print up to `max` arg bytes into buf, return characters written
 * (excluding NUL). If args is longer than `max`, append "…". Always
 * NUL-terminates if buf_size > 0. */
static int hex_args(const uint8_t *args, uint32_t arg_size, uint32_t max,
                    char *buf, int buf_size) {
    int written = 0;
    uint32_t shown = arg_size < max ? arg_size : max;
    for (uint32_t i = 0; i < shown; i++) {
        int n = snprintf(buf + written, buf_size > written ? buf_size - written : 0,
                         i ? " %02X" : "%02X", args[i]);
        if (n < 0) return written;
        written += n;
    }
    if (arg_size > max) {
        int n = snprintf(buf + written, buf_size > written ? buf_size - written : 0, " …");
        if (n > 0) written += n;
    }
    return written;
}

int vgm_format_command(const vgm_file_t *file, uint32_t index, char *buf, int buf_size) {
    if (!file || index >= file->command_count) {
        if (buf && buf_size > 0) buf[0] = '\0';
        return 0;
    }
    if (!buf || buf_size <= 0) {
        buf = NULL;
        buf_size = 0;
    } else {
        buf[0] = '\0';
    }

    const vgm_command_entry_t *e = &file->commands[index];
    const uint8_t *args = (e->file_offset == 0xFFFFFFFFu)
                              ? NULL
                              : file->data + e->file_offset + 1;
    uint8_t op = e->opcode;

    vgm_opcode_info_t info;
    vgm_opcode_classify(op, &info);

    int w = 0;
    #define APPEND(...) do { \
        int _n = snprintf(buf + w, buf_size > w ? buf_size - w : 0, __VA_ARGS__); \
        if (_n > 0) w += _n; \
    } while (0)

    /* Always lead with the opcode byte and short mnemonic. */
    APPEND("%02X  %-9s", op, info.name ? info.name : "?");

    /* Decoded form per chip family, where it helps. */
    if (op == 0x61 && args && e->arg_size >= 2) {
        APPEND("  %u samples", read_u16le(args));
    } else if (op == 0x62) {
        APPEND("  735 samples");
    } else if (op == 0x63) {
        APPEND("  882 samples");
    } else if (op >= 0x70 && op <= 0x7F) {
        APPEND("  %u samples", (op & 0x0F) + 1);
    } else if (op >= 0x80 && op <= 0x8F) {
        APPEND("  DAC, wait %u", op & 0x0F);
    } else if (op == 0x66) {
        APPEND("  ");
    } else if (op == 0x67 && args && e->arg_size >= 6) {
        uint8_t type = args[1];
        uint32_t sz = read_u32le(args + 2);
        APPEND("  type=%02X size=%u", type, sz);
    } else if (op == 0x68 && args && e->arg_size >= 11) {
        /* Layout: 66 chip:1 src:3 dst:3 size:3 */
        uint32_t src = args[2] | (args[3] << 8) | (args[4] << 16);
        uint32_t dst = args[5] | (args[6] << 8) | (args[7] << 16);
        uint32_t sz = args[8] | (args[9] << 8) | (args[10] << 16);
        if (sz == 0) sz = 0x01000000u;
        APPEND("  chip=%02X src=%06X dst=%06X size=%u", args[1], src, dst, sz);
    } else if (op == 0x4F && args && e->arg_size >= 1) {
        APPEND("  stereo=%02X", args[0]);
    } else if (op == 0x50 && args && e->arg_size >= 1) {
        APPEND("  %02X", args[0]);
    } else if (op >= 0x51 && op <= 0x5F && args && e->arg_size >= 2) {
        APPEND("  reg=%02X data=%02X", args[0], args[1]);
    } else if (op >= 0xA1 && op <= 0xAF && args && e->arg_size >= 2) {
        APPEND("  reg=%02X data=%02X", args[0], args[1]);
    } else if (op >= 0xB0 && op <= 0xBF && args && e->arg_size >= 2) {
        APPEND("  reg=%02X data=%02X", args[0], args[1]);
    } else if (op >= 0xC0 && op <= 0xCF && args && e->arg_size >= 3) {
        uint16_t addr = read_u16le(args);
        APPEND("  addr=%04X data=%02X", addr, args[2]);
    } else if (op >= 0xD0 && op <= 0xDF && args && e->arg_size >= 4) {
        APPEND("  port=%02X reg=%02X data=%02X", args[0], args[1], args[2]);
    } else if (op == 0xE0 && args && e->arg_size >= 4) {
        APPEND("  offset=%08X", read_u32le(args));
    } else if (e->arg_size > 0 && args) {
        APPEND("  ");
        char tmp[64];
        int n = hex_args(args, e->arg_size, 8, tmp, (int)sizeof(tmp));
        (void)n;
        APPEND("%s", tmp);
    }

    /* Chip tag at end. */
    APPEND("   [%s]", vgm_chip_short_name((vgm_chip_t)e->chip_id));

    return w;
    #undef APPEND
}
