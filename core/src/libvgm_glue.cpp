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

/* vgm_chip_t -> libvgm DEV_ID. Hardcoded mapping; matches the chip enum
 * in core/include/vgmcore.h (VGM_CHIP_*) but only for chip types that
 * libvgm actually emulates. RF5C68 and RF5C164 share DEVID_RF5C68 in
 * libvgm — we accept the limitation that muting one mutes both. */
uint8_t libvgm_chip_devid(uint8_t chip) {
    switch (chip) {
        case 1:  return 0x00;  // SN76489    -> DEVID_SN76496
        case 2:  return 0x01;  // YM2413
        case 3:  return 0x02;  // YM2612
        case 4:  return 0x03;  // YM2151
        case 5:  return 0x04;  // SegaPCM
        case 6:  return 0x05;  // RF5C68
        case 7:  return 0x06;  // YM2203
        case 8:  return 0x07;  // YM2608
        case 9:  return 0x08;  // YM2610
        case 10: return 0x09;  // YM3812
        case 11: return 0x0A;  // YM3526
        case 12: return 0x0B;  // Y8950
        case 13: return 0x0C;  // YMF262
        case 14: return 0x0D;  // YMF278B
        case 15: return 0x0E;  // YMF271
        case 16: return 0x0F;  // YMZ280B
        case 17: return 0x05;  // RF5C164 (shares DEVID with RF5C68)
        case 18: return 0x11;  // PWM
        case 19: return 0x12;  // AY8910
        case 20: return 0x13;  // GameBoy DMG
        case 21: return 0x14;  // NES APU
        case 22: return 0x15;  // MultiPCM (DEVID_YMW258)
        case 23: return 0x16;  // uPD7759
        case 24: return 0x17;  // OKIM6258 (DEVID_MSM6258)
        case 25: return 0x18;  // OKIM6295 (DEVID_MSM6295)
        case 26: return 0x19;  // K051649
        case 27: return 0x1A;  // K054539
        case 28: return 0x1B;  // HuC6280 (DEVID_C6280)
        case 29: return 0x1C;  // C140
        case 30: return 0x1D;  // K053260
        case 31: return 0x1E;  // POKEY
        case 32: return 0x1F;  // QSound
        case 33: return 0x20;  // SCSP
        case 34: return 0x21;  // WonderSwan (DEVID_WSWAN)
        case 35: return 0x22;  // VSU
        case 36: return 0x23;  // SAA1099
        case 37: return 0x24;  // ES5503
        case 38: return 0x25;  // ES5506
        case 39: return 0x26;  // X1-010
        case 40: return 0x27;  // C352
        case 41: return 0x28;  // GA20
        default: return 0xFF;  // unmapped (pseudo chip, or unknown)
    }
}

/* libvgm's actual mute is the per-channel bitmask, not the `disable`
 * field (which is for suspending emulation entirely and isn't acted on
 * by VGMPlayer::RefreshMuting). Setting chnMute = 0xFFFFFFFF masks all
 * 32 possible channels of the chip; 0 = unmuted. We mirror the same
 * mask to chnMute[1] so linked devices (the AY half of YM2608 etc.)
 * follow along. */
static void fill_mute_opts(PLR_MUTE_OPTS &opts, bool muted) {
    opts.disable = 0x00;
    opts.chnMute[0] = muted ? 0xFFFFFFFFu : 0u;
    opts.chnMute[1] = muted ? 0xFFFFFFFFu : 0u;
}

/* Build a libvgm-style device ID directly rather than enumerating
 * GetSongDeviceInfo (which was returning 0xFF in our setup despite
 * the player being healthy). Matches the PLR_DEV_ID macro definition
 * in player/playerbase.hpp:
 *   PLR_DEV_ID(chip, instance) = 0x80000000 | (instance << 16) | chip
 * SetDeviceMuting returns 0x80 for unknown IDs, which is harmless —
 * we can call it speculatively for both instance 0 and 1 to cover
 * dual-chip files without first knowing which is present. */
static inline uint32_t make_dev_id(uint8_t chip, uint16_t instance) {
    return 0x80000000u | ((uint32_t)instance << 16) | (uint32_t)chip;
}

static int apply_mute_for_type(libvgm_player_t *p, uint8_t wantedType, bool muted) {
    PlayerBase *engine = p->player.GetPlayer();
    if (!engine) return 1;

    PLR_MUTE_OPTS opts;
    fill_mute_opts(opts, muted);

    int hit = 0;
    for (uint16_t inst = 0; inst < 2; ++inst) {
        UINT8 rc = engine->SetDeviceMuting(make_dev_id(wantedType, inst), opts);
        if (rc == 0x00) ++hit;
    }
    return hit > 0 ? 0 : 2;
}

int libvgm_set_chip_muted(libvgm_player_t *p, uint8_t our_chip_id, int muted) {
    if (!p) return -1;
    uint8_t devid = libvgm_chip_devid(our_chip_id);
    if (devid == 0xFF) return -2;  // no libvgm equivalent
    return apply_mute_for_type(p, devid, muted != 0);
}

int libvgm_set_all_chips_muted(libvgm_player_t *p, int muted) {
    if (!p) return -1;
    PlayerBase *engine = p->player.GetPlayer();
    if (!engine) return -1;

    PLR_MUTE_OPTS opts;
    fill_mute_opts(opts, muted != 0);

    // Sweep every chip type defined in our vgm_chip_t enum (1..41), both
    // instances. Unknown IDs return 0x80 which we ignore — only the ones
    // present in the file actually take effect.
    for (uint8_t chip = 1; chip <= 41; ++chip) {
        uint8_t devid = libvgm_chip_devid(chip);
        if (devid == 0xFF) continue;
        for (uint16_t inst = 0; inst < 2; ++inst) {
            engine->SetDeviceMuting(make_dev_id(devid, inst), opts);
        }
    }
    return 0;
}
