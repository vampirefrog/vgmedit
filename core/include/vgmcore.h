/*
 * vgmcore - VGM file parsing, formatting and timeline analysis.
 *
 * Pure C99 with no external dependencies. Suitable for native (Qt, CLI) use or
 * compilation to WebAssembly. Audio rendering lives outside this header — it
 * will be added behind a separate interface backed by libvgm.
 *
 * Conventions:
 *   - All multi-byte VGM fields are little-endian (handled internally).
 *   - Sample rate is always 44100 Hz per the VGM spec.
 *   - All functions returning int return 0 on success, negative on error.
 */
#ifndef VGMCORE_H
#define VGMCORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VGMCORE_SAMPLE_RATE 44100u

typedef enum {
    VGM_OK = 0,
    VGM_ERR_BAD_MAGIC = -1,
    VGM_ERR_TRUNCATED = -2,
    VGM_ERR_OUT_OF_MEMORY = -3,
    VGM_ERR_INVALID_INDEX = -4,
    VGM_ERR_NOT_IMPLEMENTED = -5,
    VGM_ERR_INVALID_ARG = -6,
} vgm_status_t;

/* Stable chip identifiers. Used both for chip enumeration and per-command
 * attribution. CONTROL covers wait/end commands; DATA_BLOCK is used when a
 * 0x67 block target can't be resolved to a specific chip. */
typedef enum {
    VGM_CHIP_NONE = 0,
    VGM_CHIP_SN76489,
    VGM_CHIP_YM2413,
    VGM_CHIP_YM2612,
    VGM_CHIP_YM2151,
    VGM_CHIP_SEGAPCM,
    VGM_CHIP_RF5C68,
    VGM_CHIP_YM2203,
    VGM_CHIP_YM2608,
    VGM_CHIP_YM2610,
    VGM_CHIP_YM3812,
    VGM_CHIP_YM3526,
    VGM_CHIP_Y8950,
    VGM_CHIP_YMF262,
    VGM_CHIP_YMF278B,
    VGM_CHIP_YMF271,
    VGM_CHIP_YMZ280B,
    VGM_CHIP_RF5C164,
    VGM_CHIP_PWM,
    VGM_CHIP_AY8910,
    VGM_CHIP_GAMEBOY,
    VGM_CHIP_NESAPU,
    VGM_CHIP_MULTIPCM,
    VGM_CHIP_UPD7759,
    VGM_CHIP_OKIM6258,
    VGM_CHIP_OKIM6295,
    VGM_CHIP_K051649,
    VGM_CHIP_K054539,
    VGM_CHIP_HUC6280,
    VGM_CHIP_C140,
    VGM_CHIP_K053260,
    VGM_CHIP_POKEY,
    VGM_CHIP_QSOUND,
    VGM_CHIP_SCSP,
    VGM_CHIP_WONDERSWAN,
    VGM_CHIP_VSU,
    VGM_CHIP_SAA1099,
    VGM_CHIP_ES5503,
    VGM_CHIP_ES5506,
    VGM_CHIP_X1_010,
    VGM_CHIP_C352,
    VGM_CHIP_GA20,
    VGM_CHIP_DAC_STREAM,
    VGM_CHIP_DATA_BLOCK,
    VGM_CHIP_CONTROL,
    VGM_CHIP_COUNT,
} vgm_chip_t;

typedef struct {
    uint32_t version;        /* BCD, e.g. 0x171 */
    uint32_t data_offset;    /* absolute offset of first command */
    uint32_t gd3_offset;     /* absolute offset of GD3 tag, 0 if none */
    uint32_t eof_offset;     /* absolute end-of-file offset */
    uint64_t total_samples;  /* sum of all wait commands per header */
    uint32_t loop_offset;    /* absolute offset of loop point, 0 if none */
    uint32_t loop_samples;
    uint32_t rate;           /* 50 / 60 / 0 */
    uint32_t chip_clocks[VGM_CHIP_COUNT];  /* 0 if chip absent */
} vgm_header_t;

/* Per-command flag bits stored in vgm_command_entry_t.flags. */
#define VGM_CMD_FLAG_LOOP 0x0001u   /* this command is the VGM loop point */

/* One parsed command. file_offset == 0xFFFFFFFF for synthesized commands. */
typedef struct {
    uint64_t sample_time;
    uint32_t file_offset;
    uint32_t arg_size;
    uint8_t  opcode;
    uint8_t  chip_id;
    uint16_t flags;          /* VGM_CMD_FLAG_* */
} vgm_command_entry_t;

typedef struct vgm_file_s vgm_file_t;

/* Parse a VGM (or VGZ-decompressed) buffer. Buffer ownership stays with the
 * caller — vgm_file_t holds an internal copy so the caller may free `data`
 * after this call returns. */
vgm_file_t *vgm_open(const uint8_t *data, uint32_t size, vgm_status_t *status_out);
void        vgm_close(vgm_file_t *file);

const vgm_header_t *vgm_header(const vgm_file_t *file);
uint32_t            vgm_command_count(const vgm_file_t *file);

/* O(1) lookup of a parsed command. The entry is copied into *out so callers
 * never need to worry about pointer stability across edits. */
int vgm_get_command(const vgm_file_t *file, uint32_t index, vgm_command_entry_t *out);

/* Return a pointer to the raw argument bytes for a command. Stable until the
 * next edit operation on `file`. */
const uint8_t *vgm_command_args(const vgm_file_t *file, uint32_t index, uint32_t *size_out);

/* Format one command in vgm2txt style into `buf` (NUL-terminated, truncated to
 * buf_size). Returns the number of bytes that would have been written
 * excluding NUL (snprintf-style) so callers can detect truncation. */
int vgm_format_command(const vgm_file_t *file, uint32_t index, char *buf, int buf_size);

/* Heatmap intensity accumulator.
 *
 * For each command whose chip_id is set in chip_filter and whose sample_time
 * is within [start_sample, end_sample), the corresponding pixel's intensity
 * is incremented by `step` and saturated at 255. Caller provides
 * intensity_out, sized at least pixel_count bytes. The buffer is zeroed
 * before accumulation. The chip filter is a bitmask indexed by vgm_chip_t
 * (use VGM_CHIP_FILTER_ALL for the whole-VGM track). */
typedef uint64_t vgm_chip_mask_t;
#define VGM_CHIP_FILTER_ALL ((vgm_chip_mask_t)~0ULL)
#define VGM_CHIP_BIT(c) ((vgm_chip_mask_t)1ULL << (c))

void vgm_heatmap(const vgm_file_t *file,
                 uint64_t start_sample, uint64_t end_sample,
                 uint32_t pixel_count, vgm_chip_mask_t chip_filter,
                 uint8_t step, uint8_t *intensity_out);

/* Return a bitmask of chips actually used by commands in this file. Useful
 * when deciding which per-chip tracks to display — header clocks can be set
 * for chips that don't end up being written. */
vgm_chip_mask_t vgm_used_chip_mask(const vgm_file_t *file);

/* Static metadata helpers. */
const char *vgm_chip_name(vgm_chip_t chip);
const char *vgm_chip_short_name(vgm_chip_t chip);

/* Edit operations. Implementations are stubbed in this initial cut and return
 * VGM_ERR_NOT_IMPLEMENTED — the API is fixed so wiring can land now. The
 * naive plan is: mutate the in-memory command list, recompute sample_time for
 * all later commands, and re-emit raw bytes on demand via vgm_serialize. */
int vgm_insert_command(vgm_file_t *file, uint32_t before_index,
                       uint8_t opcode, const uint8_t *args, uint32_t arg_size);
int vgm_delete_command(vgm_file_t *file, uint32_t index);
int vgm_update_command(vgm_file_t *file, uint32_t index,
                       uint8_t opcode, const uint8_t *args, uint32_t arg_size);

/* Delete every non-wait command whose sample_time falls in [start_sample,
 * end_sample), and trim wait commands whose [t, t+advance) interval overlaps
 * the range by exactly the overlap length. Waits that get trimmed to a
 * non-trivial value are rewritten as a 0x61 (16-bit wait) command; waits
 * fully consumed by the range are dropped. Sample times are recomputed
 * across the whole file afterward. */
int vgm_delete_range(vgm_file_t *file, uint64_t start_sample, uint64_t end_sample);

/* Re-emit the current command list as a VGM byte stream. Returns the byte
 * count required; if `buf` is NULL or `buf_size` is 0, computes the size
 * without writing. */
int vgm_serialize(const vgm_file_t *file, uint8_t *buf, uint32_t buf_size);

/* Loop point operations.
 *
 * The loop point is tracked by setting VGM_CMD_FLAG_LOOP on the target
 * command, not by a file offset — so insert/delete around the loop point
 * keep it pinned to the same command. On parse, the flag is restored by
 * looking up the original loop_offset against parsed command offsets.
 * On serialize, the flagged command's serialized byte offset is written
 * back into the header's loop_offset field (and loop_samples is recomputed
 * from totalSamples and the loop command's sample_time).
 *
 * vgm_get_loop_index returns the command index, or -1 when no loop is set.
 * vgm_set_loop_index sets the loop on `index` (clearing any prior flag),
 * or clears the loop entirely when called with -1.
 */
int vgm_get_loop_index(const vgm_file_t *file);
int vgm_set_loop_index(vgm_file_t *file, int index);

#ifdef __cplusplus
}
#endif

#endif /* VGMCORE_H */
