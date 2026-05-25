/*
 * libvgm_glue — C ABI on top of libvgm::PlayerA + VGMPlayer.
 *
 * The implementation is a small wrapper: it owns one PlayerA, the bytes
 * copied from the caller, and a MemoryLoader that wraps those bytes. The
 * VGMPlayer engine is registered once so PlayerA can autoload .vgm/.vgz
 * inputs (gzip decode happens inside libvgm via MemoryLoader's zlib path).
 */
#include "libvgm_glue.h"

#include <cstdlib>
#include <cstring>
#include <new>

#include "player/playera.hpp"
#include "player/vgmplayer.hpp"
#include "player/playerbase.hpp"
#include "utils/DataLoader.h"
#include "utils/MemoryLoader.h"

struct libvgm_player_s {
    PlayerA         player;
    DATA_LOADER    *loader = nullptr;
    uint8_t        *owned_bytes = nullptr;
    uint32_t        sample_rate = 44100;
};

libvgm_player_t *libvgm_open(const uint8_t *data, uint32_t size, uint32_t sample_rate) {
    if (!data || size < 0x40) return nullptr;

    auto *p = new (std::nothrow) libvgm_player_s();
    if (!p) return nullptr;
    p->sample_rate = sample_rate ? sample_rate : 44100;

    p->owned_bytes = static_cast<uint8_t *>(std::malloc(size));
    if (!p->owned_bytes) { delete p; return nullptr; }
    std::memcpy(p->owned_bytes, data, size);

    p->loader = MemoryLoader_Init(p->owned_bytes, size);
    if (!p->loader) {
        std::free(p->owned_bytes);
        delete p;
        return nullptr;
    }
    if (DataLoader_Load(p->loader) != 0x00) {
        DataLoader_Deinit(p->loader);
        std::free(p->owned_bytes);
        delete p;
        return nullptr;
    }

    p->player.RegisterPlayerEngine(new VGMPlayer());

    // 2 channels, 16-bit, internal scratch buffer of 1024 frames. The
    // renderer pulls at most this many frames per Render() call from
    // libvgm's perspective; callers can ask for more and we'll loop.
    if (p->player.SetOutputSettings(p->sample_rate, 2, 16, 1024) != 0x00) {
        DataLoader_Deinit(p->loader);
        std::free(p->owned_bytes);
        delete p;
        return nullptr;
    }

    {
        PlayerA::Config cfg = p->player.GetConfiguration();
        cfg.masterVol = 0x10000;      // 1.0
        // Large loop count so libvgm handles file-loop wrap-around
        // internally — chip state persists across the boundary, which
        // is what we want to be audible in the editor. The renderer
        // detects "no loop" files separately via current_sample >=
        // total_samples and stops then. ~24 days of loops for a 60 s
        // looping file should suffice for any editor session.
        cfg.loopCount = 1000000;
        cfg.fadeSmpls = 0;             // no fade — the editor decides looping
        cfg.endSilenceSmpls = 0;
        cfg.pbSpeed = 1.0;
        p->player.SetConfiguration(cfg);
    }

    if (p->player.LoadFile(p->loader) != 0x00) {
        DataLoader_Deinit(p->loader);
        std::free(p->owned_bytes);
        delete p;
        return nullptr;
    }

    p->player.Start();
    return p;
}

void libvgm_close(libvgm_player_t *p) {
    if (!p) return;
    p->player.Stop();
    p->player.UnloadFile();
    if (p->loader) DataLoader_Deinit(p->loader);
    std::free(p->owned_bytes);
    delete p;
}

uint32_t libvgm_render_s16(libvgm_player_t *p, int16_t *buf, uint32_t frame_count) {
    if (!p || !buf || frame_count == 0) return 0;
    // PlayerA::Render takes bufSize in bytes (interleaved stereo, 16-bit
    // here = 4 bytes/frame). Loop because the player may produce fewer
    // than requested when nearing EOF.
    const uint32_t bytes_per_frame = 4;
    uint32_t produced = 0;
    while (produced < frame_count) {
        uint32_t want = frame_count - produced;
        uint32_t got = p->player.Render(want * bytes_per_frame,
                                        buf + produced * 2) / bytes_per_frame;
        if (got == 0) break;
        produced += got;
    }
    return produced;
}

int libvgm_seek_sample(libvgm_player_t *p, uint64_t sample_pos) {
    if (!p) return -1;
    // Seek with the rendering-sample-rate unit (PLAYPOS_SAMPLE = 0x02).
    return p->player.Seek(0x02, (uint32_t)sample_pos);
}

uint64_t libvgm_current_sample(const libvgm_player_t *p) {
    if (!p) return 0;
    return const_cast<PlayerA &>(p->player).GetCurPos(0x02);
}

uint64_t libvgm_total_samples(const libvgm_player_t *p) {
    if (!p) return 0;
    PlayerBase *engine = const_cast<PlayerA &>(p->player).GetPlayer();
    if (!engine) return 0;
    return engine->Tick2Sample(engine->GetTotalPlayTicks(1));
}
