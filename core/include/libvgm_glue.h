/*
 * libvgm_glue — minimal C facade around libvgm's PlayerA + VGMPlayer.
 *
 * The full libvgm API is C++ and pulls in <vector>, exceptions, etc.;
 * the editor frontend only needs a handful of operations:
 *
 *   - open a VGM byte buffer
 *   - set sample rate
 *   - render N PCM frames into a caller-provided buffer (interleaved s16 stereo)
 *   - seek to a sample position
 *   - query total samples / current sample
 *   - close
 *
 * Wrapping it in plain C makes the JS bindings layer trivial and keeps the
 * C-side ABI stable when libvgm internals change.
 */
#ifndef LIBVGM_GLUE_H
#define LIBVGM_GLUE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct libvgm_player_s libvgm_player_t;

/* Open a VGM file from a memory buffer. Takes a copy of the bytes so the
 * caller may free them after this call returns. Returns NULL on failure
 * (bad magic, unsupported format, OOM, …). The chosen sample rate fixes
 * the output rate for the lifetime of the player. */
libvgm_player_t *libvgm_open(const uint8_t *data, uint32_t size, uint32_t sample_rate);

void libvgm_close(libvgm_player_t *p);

/* Render up to `frame_count` interleaved stereo s16 frames into `buf`
 * (which must be at least frame_count * 2 * sizeof(int16_t) bytes).
 * Returns the number of frames actually produced; 0 at end-of-file. */
uint32_t libvgm_render_s16(libvgm_player_t *p, int16_t *buf, uint32_t frame_count);

/* Seek to `sample_pos`. Internally libvgm rewinds to the start and
 * fast-forwards when necessary, matching the editor's "forward from cursor,
 * backward from zero" spec. Returns 0 on success. */
int libvgm_seek_sample(libvgm_player_t *p, uint64_t sample_pos);

/* Current and total sample positions in the player's output sample rate. */
uint64_t libvgm_current_sample(const libvgm_player_t *p);
uint64_t libvgm_total_samples(const libvgm_player_t *p);

#ifdef __cplusplus
}
#endif

#endif /* LIBVGM_GLUE_H */
