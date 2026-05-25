/*
 * VGM opcode dispatch table.
 *
 * For each opcode 0x00-0xFF we record:
 *   - the size of arguments following the opcode (fixed) or 0xFFFFFFFF for
 *     variable-length commands which need bespoke handling in the parser,
 *   - the chip attribution used for filtering and the per-chip heatmap,
 *   - a short name for the formatter.
 *
 * The table is built per the VGM 1.71 spec.
 */
#include "vgmcore.h"
#include "vgmcore_internal.h"

#include <stddef.h>

#define VAR 0xFFFFFFFFu

const vgm_opcode_info_t vgm_opcode_table[256] = {
    /* 0x00 - 0x2F: mostly reserved / no-op */
    [0x00] = {0, VGM_CHIP_CONTROL, "NOP"},

    /* 0x30 - 0x3F: 1-byte commands for second-chip and reserved */
    [0x30] = {1, VGM_CHIP_SN76489, "PSG2 write"},
    [0x31] = {1, VGM_CHIP_AY8910,  "AY stereo mask"},
    [0x3F] = {1, VGM_CHIP_SN76489, "GG stereo (2nd)"},

    /* 0x4F - 0x5F: PSG / FM register writes */
    [0x4F] = {1, VGM_CHIP_SN76489, "GG stereo"},
    [0x50] = {1, VGM_CHIP_SN76489, "PSG write"},
    [0x51] = {2, VGM_CHIP_YM2413,  "YM2413"},
    [0x52] = {2, VGM_CHIP_YM2612,  "YM2612 p0"},
    [0x53] = {2, VGM_CHIP_YM2612,  "YM2612 p1"},
    [0x54] = {2, VGM_CHIP_YM2151,  "YM2151"},
    [0x55] = {2, VGM_CHIP_YM2203,  "YM2203"},
    [0x56] = {2, VGM_CHIP_YM2608,  "YM2608 p0"},
    [0x57] = {2, VGM_CHIP_YM2608,  "YM2608 p1"},
    [0x58] = {2, VGM_CHIP_YM2610,  "YM2610 p0"},
    [0x59] = {2, VGM_CHIP_YM2610,  "YM2610 p1"},
    [0x5A] = {2, VGM_CHIP_YM3812,  "YM3812"},
    [0x5B] = {2, VGM_CHIP_YM3526,  "YM3526"},
    [0x5C] = {2, VGM_CHIP_Y8950,   "Y8950"},
    [0x5D] = {2, VGM_CHIP_YMZ280B, "YMZ280B"},
    [0x5E] = {2, VGM_CHIP_YMF262,  "YMF262 p0"},
    [0x5F] = {2, VGM_CHIP_YMF262,  "YMF262 p1"},

    /* 0x60: reserved */
    /* 0x61: wait n samples (2-byte n) */
    [0x61] = {2, VGM_CHIP_CONTROL, "wait n"},
    /* 0x62: wait 735 samples (60Hz frame) */
    [0x62] = {0, VGM_CHIP_CONTROL, "wait 735"},
    /* 0x63: wait 882 samples (50Hz frame) */
    [0x63] = {0, VGM_CHIP_CONTROL, "wait 882"},
    /* 0x66: end of sound data */
    [0x66] = {0, VGM_CHIP_CONTROL, "end"},
    /* 0x67: data block (variable) */
    [0x67] = {VAR, VGM_CHIP_DATA_BLOCK, "data block"},
    /* 0x68: PCM RAM write (fixed 11-byte args) */
    [0x68] = {11, VGM_CHIP_DATA_BLOCK, "PCM RAM write"},

    /* 0xA0 - 0xAF: second-chip writes (2 args) */
    [0xA0] = {2, VGM_CHIP_AY8910,  "AY8910 write"},
    [0xA1] = {2, VGM_CHIP_YM2413,  "YM2413 (2nd)"},
    [0xA2] = {2, VGM_CHIP_YM2612,  "YM2612 p0 (2nd)"},
    [0xA3] = {2, VGM_CHIP_YM2612,  "YM2612 p1 (2nd)"},
    [0xA4] = {2, VGM_CHIP_YM2151,  "YM2151 (2nd)"},
    [0xA5] = {2, VGM_CHIP_YM2203,  "YM2203 (2nd)"},
    [0xA6] = {2, VGM_CHIP_YM2608,  "YM2608 p0 (2nd)"},
    [0xA7] = {2, VGM_CHIP_YM2608,  "YM2608 p1 (2nd)"},
    [0xA8] = {2, VGM_CHIP_YM2610,  "YM2610 p0 (2nd)"},
    [0xA9] = {2, VGM_CHIP_YM2610,  "YM2610 p1 (2nd)"},
    [0xAA] = {2, VGM_CHIP_YM3812,  "YM3812 (2nd)"},
    [0xAB] = {2, VGM_CHIP_YM3526,  "YM3526 (2nd)"},
    [0xAC] = {2, VGM_CHIP_Y8950,   "Y8950 (2nd)"},
    [0xAD] = {2, VGM_CHIP_YMZ280B, "YMZ280B (2nd)"},
    [0xAE] = {2, VGM_CHIP_YMF262,  "YMF262 p0 (2nd)"},
    [0xAF] = {2, VGM_CHIP_YMF262,  "YMF262 p1 (2nd)"},

    /* 0xB0 - 0xBF: 2-arg chip writes */
    [0xB0] = {2, VGM_CHIP_RF5C68,    "RF5C68"},
    [0xB1] = {2, VGM_CHIP_RF5C164,   "RF5C164"},
    [0xB2] = {2, VGM_CHIP_PWM,       "PWM"},
    [0xB3] = {2, VGM_CHIP_GAMEBOY,   "GameBoy DMG"},
    [0xB4] = {2, VGM_CHIP_NESAPU,    "NES APU"},
    [0xB5] = {2, VGM_CHIP_MULTIPCM,  "MultiPCM"},
    [0xB6] = {2, VGM_CHIP_UPD7759,   "uPD7759"},
    [0xB7] = {2, VGM_CHIP_OKIM6258,  "OKIM6258"},
    [0xB8] = {2, VGM_CHIP_OKIM6295,  "OKIM6295"},
    [0xB9] = {2, VGM_CHIP_HUC6280,   "HuC6280"},
    [0xBA] = {2, VGM_CHIP_K053260,   "K053260"},
    [0xBB] = {2, VGM_CHIP_POKEY,     "Pokey"},
    [0xBC] = {2, VGM_CHIP_WONDERSWAN,"WonderSwan"},
    [0xBD] = {2, VGM_CHIP_SAA1099,   "SAA1099"},
    [0xBE] = {2, VGM_CHIP_ES5506,    "ES5506 8-bit"},
    [0xBF] = {2, VGM_CHIP_GA20,      "GA20"},

    /* 0xC0 - 0xCF: 3-arg writes */
    [0xC0] = {3, VGM_CHIP_SEGAPCM,   "SegaPCM mem"},
    [0xC1] = {3, VGM_CHIP_RF5C68,    "RF5C68 mem"},
    [0xC2] = {3, VGM_CHIP_RF5C164,   "RF5C164 mem"},
    [0xC3] = {3, VGM_CHIP_MULTIPCM,  "MultiPCM bank"},
    [0xC4] = {3, VGM_CHIP_QSOUND,    "QSound"},
    [0xC5] = {3, VGM_CHIP_SCSP,      "SCSP mem"},
    [0xC6] = {3, VGM_CHIP_WONDERSWAN,"WonderSwan mem"},
    [0xC7] = {3, VGM_CHIP_VSU,       "VSU"},
    [0xC8] = {3, VGM_CHIP_X1_010,    "X1-010 mem"},

    /* 0xD0 - 0xDF: 4-arg writes */
    [0xD0] = {4, VGM_CHIP_YMF278B, "YMF278B"},
    [0xD1] = {4, VGM_CHIP_YMF271,  "YMF271"},
    [0xD2] = {4, VGM_CHIP_K051649, "SCC1"},
    [0xD3] = {4, VGM_CHIP_K054539, "K054539"},
    [0xD4] = {4, VGM_CHIP_C140,    "C140"},
    [0xD5] = {4, VGM_CHIP_ES5503,  "ES5503"},
    [0xD6] = {4, VGM_CHIP_ES5506,  "ES5506 16-bit"},

    /* 0xE0: seek PCM bank (4 args) */
    [0xE0] = {4, VGM_CHIP_DATA_BLOCK, "PCM seek"},
    [0xE1] = {4, VGM_CHIP_C352,       "C352"},
};

static const char *const chip_long_names[VGM_CHIP_COUNT] = {
    [VGM_CHIP_NONE]       = "—",
    [VGM_CHIP_SN76489]    = "SN76489 PSG",
    [VGM_CHIP_YM2413]     = "YM2413 OPLL",
    [VGM_CHIP_YM2612]     = "YM2612 OPN2",
    [VGM_CHIP_YM2151]     = "YM2151 OPM",
    [VGM_CHIP_SEGAPCM]    = "Sega PCM",
    [VGM_CHIP_RF5C68]     = "RF5C68",
    [VGM_CHIP_YM2203]     = "YM2203 OPN",
    [VGM_CHIP_YM2608]     = "YM2608 OPNA",
    [VGM_CHIP_YM2610]     = "YM2610 OPNB",
    [VGM_CHIP_YM3812]     = "YM3812 OPL2",
    [VGM_CHIP_YM3526]     = "YM3526 OPL",
    [VGM_CHIP_Y8950]      = "Y8950 MSX-AUDIO",
    [VGM_CHIP_YMF262]     = "YMF262 OPL3",
    [VGM_CHIP_YMF278B]    = "YMF278B OPL4",
    [VGM_CHIP_YMF271]     = "YMF271",
    [VGM_CHIP_YMZ280B]    = "YMZ280B",
    [VGM_CHIP_RF5C164]    = "RF5C164",
    [VGM_CHIP_PWM]        = "PWM",
    [VGM_CHIP_AY8910]     = "AY8910",
    [VGM_CHIP_GAMEBOY]    = "GameBoy DMG",
    [VGM_CHIP_NESAPU]     = "NES APU",
    [VGM_CHIP_MULTIPCM]   = "MultiPCM",
    [VGM_CHIP_UPD7759]    = "uPD7759",
    [VGM_CHIP_OKIM6258]   = "OKIM6258",
    [VGM_CHIP_OKIM6295]   = "OKIM6295",
    [VGM_CHIP_K051649]    = "K051649 SCC",
    [VGM_CHIP_K054539]    = "K054539",
    [VGM_CHIP_HUC6280]    = "HuC6280",
    [VGM_CHIP_C140]       = "Namco C140",
    [VGM_CHIP_K053260]    = "K053260",
    [VGM_CHIP_POKEY]      = "Atari POKEY",
    [VGM_CHIP_QSOUND]     = "QSound",
    [VGM_CHIP_SCSP]       = "SCSP",
    [VGM_CHIP_WONDERSWAN] = "WonderSwan",
    [VGM_CHIP_VSU]        = "Virtual Boy VSU",
    [VGM_CHIP_SAA1099]    = "SAA1099",
    [VGM_CHIP_ES5503]     = "ES5503",
    [VGM_CHIP_ES5506]     = "ES5506",
    [VGM_CHIP_X1_010]     = "Seta X1-010",
    [VGM_CHIP_C352]       = "Namco C352",
    [VGM_CHIP_GA20]       = "Irem GA20",
    [VGM_CHIP_DAC_STREAM] = "DAC Stream",
    [VGM_CHIP_DATA_BLOCK] = "Data Block",
    [VGM_CHIP_CONTROL]    = "Control",
};

static const char *const chip_short_names[VGM_CHIP_COUNT] = {
    [VGM_CHIP_NONE]       = "—",
    [VGM_CHIP_SN76489]    = "PSG",
    [VGM_CHIP_YM2413]     = "OPLL",
    [VGM_CHIP_YM2612]     = "OPN2",
    [VGM_CHIP_YM2151]     = "OPM",
    [VGM_CHIP_SEGAPCM]    = "SPCM",
    [VGM_CHIP_RF5C68]     = "5C68",
    [VGM_CHIP_YM2203]     = "OPN",
    [VGM_CHIP_YM2608]     = "OPNA",
    [VGM_CHIP_YM2610]     = "OPNB",
    [VGM_CHIP_YM3812]     = "OPL2",
    [VGM_CHIP_YM3526]     = "OPL",
    [VGM_CHIP_Y8950]      = "Y8950",
    [VGM_CHIP_YMF262]     = "OPL3",
    [VGM_CHIP_YMF278B]    = "OPL4",
    [VGM_CHIP_YMF271]     = "OPX",
    [VGM_CHIP_YMZ280B]    = "YMZ",
    [VGM_CHIP_RF5C164]    = "5C164",
    [VGM_CHIP_PWM]        = "PWM",
    [VGM_CHIP_AY8910]     = "AY",
    [VGM_CHIP_GAMEBOY]    = "GB",
    [VGM_CHIP_NESAPU]     = "NES",
    [VGM_CHIP_MULTIPCM]   = "MPCM",
    [VGM_CHIP_UPD7759]    = "7759",
    [VGM_CHIP_OKIM6258]   = "6258",
    [VGM_CHIP_OKIM6295]   = "6295",
    [VGM_CHIP_K051649]    = "SCC",
    [VGM_CHIP_K054539]    = "K054",
    [VGM_CHIP_HUC6280]    = "HuC",
    [VGM_CHIP_C140]       = "C140",
    [VGM_CHIP_K053260]    = "K053",
    [VGM_CHIP_POKEY]      = "POKEY",
    [VGM_CHIP_QSOUND]     = "QSND",
    [VGM_CHIP_SCSP]       = "SCSP",
    [VGM_CHIP_WONDERSWAN] = "WSW",
    [VGM_CHIP_VSU]        = "VSU",
    [VGM_CHIP_SAA1099]    = "SAA",
    [VGM_CHIP_ES5503]     = "5503",
    [VGM_CHIP_ES5506]     = "5506",
    [VGM_CHIP_X1_010]     = "X1",
    [VGM_CHIP_C352]       = "C352",
    [VGM_CHIP_GA20]       = "GA20",
    [VGM_CHIP_DAC_STREAM] = "DAC",
    [VGM_CHIP_DATA_BLOCK] = "DATA",
    [VGM_CHIP_CONTROL]    = "CTRL",
};

const char *vgm_chip_name(vgm_chip_t chip) {
    if ((unsigned)chip >= VGM_CHIP_COUNT) return "?";
    const char *n = chip_long_names[chip];
    return n ? n : "?";
}

const char *vgm_chip_short_name(vgm_chip_t chip) {
    if ((unsigned)chip >= VGM_CHIP_COUNT) return "?";
    const char *n = chip_short_names[chip];
    return n ? n : "?";
}

/* Classify a command by its opcode using only the static table.
 * Handles ranges (0x70-0x8F, 0x90-0x95, 0xC9-0xCF, 0xD7-0xDF, 0xE2-0xFF)
 * that don't have per-byte entries in the table. */
void vgm_opcode_classify(uint8_t opcode, vgm_opcode_info_t *out) {
    /* Wait n+1 samples shortcut */
    if (opcode >= 0x70 && opcode <= 0x7F) {
        out->arg_size = 0;
        out->chip = VGM_CHIP_CONTROL;
        out->name = "wait n+1";
        return;
    }
    /* YM2612 PCM write + wait */
    if (opcode >= 0x80 && opcode <= 0x8F) {
        out->arg_size = 0;
        out->chip = VGM_CHIP_YM2612;
        out->name = "YM2612 DAC + wait";
        return;
    }
    /* DAC stream commands */
    if (opcode >= 0x90 && opcode <= 0x95) {
        static const uint8_t sizes[6] = {4, 4, 5, 10, 1, 4};
        out->arg_size = sizes[opcode - 0x90];
        out->chip = VGM_CHIP_DAC_STREAM;
        out->name = "DAC stream";
        return;
    }
    /* 3-arg reserved range */
    if (opcode >= 0xC9 && opcode <= 0xCF) {
        out->arg_size = 3;
        out->chip = VGM_CHIP_NONE;
        out->name = "reserved3";
        return;
    }
    /* 4-arg reserved range */
    if ((opcode >= 0xD7 && opcode <= 0xDF) || (opcode >= 0xE2 && opcode <= 0xFF)) {
        out->arg_size = 4;
        out->chip = VGM_CHIP_NONE;
        out->name = "reserved4";
        return;
    }
    /* 1-arg reserved range */
    if (opcode >= 0x32 && opcode <= 0x3E) {
        out->arg_size = 1;
        out->chip = VGM_CHIP_NONE;
        out->name = "reserved1";
        return;
    }
    /* 2-arg reserved ranges */
    if ((opcode >= 0x40 && opcode <= 0x4E) || (opcode == 0x60)) {
        out->arg_size = 2;
        out->chip = VGM_CHIP_NONE;
        out->name = "reserved2";
        return;
    }
    /* Direct table lookup */
    const vgm_opcode_info_t *entry = &vgm_opcode_table[opcode];
    if (entry->name) {
        *out = *entry;
        return;
    }
    /* Unknown — best effort, treat as zero-arg */
    out->arg_size = 0;
    out->chip = VGM_CHIP_NONE;
    out->name = "unknown";
}

/* How many samples this command advances the playhead. Used both during
 * parsing and when recomputing sample_time after an edit. */
uint32_t vgm_command_wait_advance(uint8_t opcode, const uint8_t *args, uint32_t arg_size) {
    switch (opcode) {
        case 0x61:
            if (args && arg_size >= 2) return (uint32_t)(args[0] | (args[1] << 8));
            return 0;
        case 0x62: return 735;
        case 0x63: return 882;
        default: break;
    }
    if (opcode >= 0x70 && opcode <= 0x7F) return (uint32_t)(opcode & 0x0F) + 1u;
    if (opcode >= 0x80 && opcode <= 0x8F) return (uint32_t)(opcode & 0x0F);
    return 0;
}

/* Data-block (0x67) sub-type → chip mapping, per spec §0x67. */
vgm_chip_t vgm_data_block_chip(uint8_t type) {
    /* Uncompressed streams 0x00-0x07 */
    switch (type) {
        case 0x00: return VGM_CHIP_YM2612;
        case 0x01: return VGM_CHIP_RF5C68;
        case 0x02: return VGM_CHIP_RF5C164;
        case 0x03: return VGM_CHIP_PWM;
        case 0x04: return VGM_CHIP_OKIM6258;
        case 0x05: return VGM_CHIP_HUC6280;
        case 0x06: return VGM_CHIP_SCSP;
        case 0x07: return VGM_CHIP_NESAPU;
        default: break;
    }
    /* ROM/RAM dumps 0x80-0x93 */
    switch (type) {
        case 0x80: return VGM_CHIP_SEGAPCM;
        case 0x81: return VGM_CHIP_YM2608;
        case 0x82: return VGM_CHIP_YM2610;
        case 0x83: return VGM_CHIP_YM2610;
        case 0x84: return VGM_CHIP_YMF278B;
        case 0x85: return VGM_CHIP_YMF271;
        case 0x86: return VGM_CHIP_YMZ280B;
        case 0x87: return VGM_CHIP_YMF278B;
        case 0x88: return VGM_CHIP_Y8950;
        case 0x89: return VGM_CHIP_MULTIPCM;
        case 0x8A: return VGM_CHIP_UPD7759;
        case 0x8B: return VGM_CHIP_OKIM6295;
        case 0x8C: return VGM_CHIP_K054539;
        case 0x8D: return VGM_CHIP_C140;
        case 0x8E: return VGM_CHIP_K053260;
        case 0x8F: return VGM_CHIP_QSOUND;
        case 0x90: return VGM_CHIP_ES5506;
        case 0x91: return VGM_CHIP_X1_010;
        case 0x92: return VGM_CHIP_C352;
        case 0x93: return VGM_CHIP_GA20;
        default: break;
    }
    /* Direct RAM writes 0xC0-0xE1 — broad routing by range */
    if (type >= 0xC0 && type <= 0xC1) return VGM_CHIP_RF5C68;
    if (type == 0xC2) return VGM_CHIP_NESAPU;
    if (type == 0xE0) return VGM_CHIP_SCSP;
    if (type == 0xE1) return VGM_CHIP_ES5503;
    return VGM_CHIP_DATA_BLOCK;
}
