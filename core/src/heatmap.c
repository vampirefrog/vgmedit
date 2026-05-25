/*
 * Heatmap accumulator.
 *
 * Linear scan over the command list. For each command whose chip passes the
 * filter and whose sample_time falls within the requested range, the matching
 * pixel column is incremented with saturating add. The output buffer is
 * zeroed up-front so the caller can hand it to the GPU/Canvas directly.
 *
 * Complexity: O(N) over the command count. Acceptable for typical VGM sizes
 * (tens of thousands of commands). If we need this faster for very long files
 * we can keep a binary-searchable index of (sample_time → first_command).
 */
#include "vgmcore.h"
#include "vgmcore_internal.h"

#include <string.h>

void vgm_heatmap(const vgm_file_t *file,
                 uint64_t start_sample, uint64_t end_sample,
                 uint32_t pixel_count, vgm_chip_mask_t chip_filter,
                 uint8_t step, uint8_t *intensity_out) {
    if (!intensity_out || pixel_count == 0) return;
    memset(intensity_out, 0, pixel_count);
    if (!file || end_sample <= start_sample) return;

    const uint64_t span = end_sample - start_sample;
    const uint32_t count = file->command_count;
    const vgm_command_entry_t *cmds = file->commands;
    const uint16_t inc = step ? step : 32;

    for (uint32_t i = 0; i < count; i++) {
        const vgm_command_entry_t *e = &cmds[i];
        if (e->sample_time < start_sample) continue;
        if (e->sample_time >= end_sample) break;
        if (!(chip_filter & VGM_CHIP_BIT(e->chip_id))) continue;

        /* Map sample_time into [0, pixel_count) with floor division. */
        uint64_t rel = e->sample_time - start_sample;
        uint64_t pixel = (rel * pixel_count) / span;
        if (pixel >= pixel_count) pixel = pixel_count - 1;

        uint16_t v = (uint16_t)intensity_out[pixel] + inc;
        intensity_out[pixel] = v > 255 ? 255 : (uint8_t)v;
    }
}
