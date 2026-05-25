/*
 * vgmdump — load a VGM file and dump its parsed command stream.
 *
 * Mostly a smoke test for vgmcore when used as a native static library.
 * Build with -DVGMCORE_BUILD_TOOLS=ON when invoking cmake.
 */
#include "vgmcore.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int read_file(const char *path, uint8_t **out, uint32_t *size) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) { fclose(f); return -1; }
    uint8_t *buf = (uint8_t *)malloc((size_t)sz);
    if (!buf) { fclose(f); return -1; }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        free(buf); fclose(f); return -1;
    }
    fclose(f);
    *out = buf;
    *size = (uint32_t)sz;
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s file.vgm [max_cmds]\n", argv[0]);
        return 2;
    }
    uint8_t *data = NULL;
    uint32_t size = 0;
    if (read_file(argv[1], &data, &size) != 0) {
        fprintf(stderr, "failed to read %s\n", argv[1]);
        return 1;
    }

    vgm_status_t status = VGM_OK;
    vgm_file_t *file = vgm_open(data, size, &status);
    free(data);
    if (!file) {
        fprintf(stderr, "vgm_open: status %d\n", status);
        return 1;
    }

    const vgm_header_t *h = vgm_header(file);
    printf("version=0x%X total_samples=%llu commands=%u chips=",
           h->version, (unsigned long long)h->total_samples, vgm_command_count(file));
    vgm_chip_mask_t used = vgm_used_chip_mask(file);
    for (int i = 0; i < VGM_CHIP_COUNT; i++) {
        if (used & ((vgm_chip_mask_t)1 << i)) printf("%s ", vgm_chip_short_name((vgm_chip_t)i));
    }
    printf("\n");

    uint32_t n = vgm_command_count(file);
    uint32_t limit = (argc > 2) ? (uint32_t)atoi(argv[2]) : n;
    if (limit > n) limit = n;

    char buf[256];
    vgm_command_entry_t entry;
    for (uint32_t i = 0; i < limit; i++) {
        if (vgm_get_command(file, i, &entry) != VGM_OK) break;
        vgm_format_command(file, i, buf, (int)sizeof(buf));
        printf("[%6u] @%-8llu %s\n", i, (unsigned long long)entry.sample_time, buf);
    }

    vgm_close(file);
    return 0;
}
