#!/usr/bin/env bash
#
# Build the WASM module:
#   1. Build the libvgm static libs (utils + emu + player) for emscripten,
#      caching the build in core/vendor/libvgm-build so subsequent runs
#      skip straight to step 3.
#   2. Compile our own vgmcore + glue sources.
#   3. Link everything into a single ES module at src/wasm/vgmcore.js,
#      with the .wasm binary base64-embedded (SINGLE_FILE=1) so Vite
#      doesn't need any extra asset wiring.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
CORE_DIR="$ROOT/core"
OUT_DIR="$ROOT/src/wasm"
mkdir -p "$OUT_DIR"

if ! command -v emcc >/dev/null 2>&1; then
  if [[ -f "$HOME/emsdk/emsdk_env.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/emsdk/emsdk_env.sh" >/dev/null
  else
    echo "emcc not found; please activate emsdk" >&2
    exit 1
  fi
fi

EMSDK_ROOT="${EMSDK:-$HOME/emsdk}"
ZLIB_INC="$EMSDK_ROOT/upstream/emscripten/cache/sysroot/include"
ZLIB_LIB="$EMSDK_ROOT/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libz.a"

# Pre-build the emscripten zlib port so libvgm's find_package(ZLIB) succeeds.
if [[ ! -f "$ZLIB_LIB" ]]; then
  echo "[build] embuilder zlib"
  embuilder build zlib >/dev/null
fi

# ---- 1. libvgm submodule + static build ----------------------------------
LIBVGM_SRC="$CORE_DIR/vendor/libvgm"
if [[ ! -d "$LIBVGM_SRC/.git" && ! -d "$LIBVGM_SRC/utils" ]]; then
  echo "[build] cloning libvgm"
  mkdir -p "$CORE_DIR/vendor"
  git clone --depth 1 https://github.com/ValleyBell/libvgm.git "$LIBVGM_SRC"
fi

LIBVGM_BUILD="$CORE_DIR/vendor/libvgm-build"
if [[ ! -f "$LIBVGM_BUILD/bin/libvgm-player.a" ]]; then
  echo "[build] configuring + compiling libvgm (slow first run)"
  mkdir -p "$LIBVGM_BUILD"
  ( cd "$LIBVGM_BUILD" && emcmake cmake "$LIBVGM_SRC" \
      -DBUILD_LIBAUDIO=OFF -DBUILD_TESTS=OFF \
      -DBUILD_PLAYER=OFF -DBUILD_VGM2WAV=OFF \
      -DUTIL_THREADING=OFF -DUTIL_CHARSET_CONV=OFF \
      -DLIBRARY_TYPE=STATIC -DUSE_SANITIZERS=OFF \
      -DZLIB_INCLUDE_DIR="$ZLIB_INC" -DZLIB_LIBRARY="$ZLIB_LIB" \
      > /dev/null )
  ( cd "$LIBVGM_BUILD" && emmake make -j"$(nproc)" > /dev/null )
fi

# ---- 2 + 3. our sources + glue + link ------------------------------------
C_SRCS=(
  "$CORE_DIR/src/parser.c"
  "$CORE_DIR/src/commands.c"
  "$CORE_DIR/src/heatmap.c"
  "$CORE_DIR/src/format.c"
  "$CORE_DIR/src/edit.c"
  "$CORE_DIR/src/libvgm_stubs.c"
  "$CORE_DIR/wasm/bindings.c"
)
CXX_SRCS=(
  "$CORE_DIR/src/libvgm_glue.cpp"
)

OBJ_DIR="$ROOT/core/vendor/vgmcore-build"
mkdir -p "$OBJ_DIR"

INC=( -I "$CORE_DIR/include" -I "$CORE_DIR/src" -I "$LIBVGM_SRC" )
COMMON_FLAGS=( -O2 -Wall -Wextra -sUSE_ZLIB=1 )

OBJS=()
for src in "${C_SRCS[@]}"; do
  obj="$OBJ_DIR/$(basename "${src%.*}").o"
  emcc -std=c99 "${COMMON_FLAGS[@]}" "${INC[@]}" -c "$src" -o "$obj"
  OBJS+=("$obj")
done
for src in "${CXX_SRCS[@]}"; do
  obj="$OBJ_DIR/$(basename "${src%.*}").o"
  em++ -std=c++14 "${COMMON_FLAGS[@]}" "${INC[@]}" -c "$src" -o "$obj"
  OBJS+=("$obj")
done

EXPORTS=(
  _malloc _free
  _vgm_open _vgm_close
  _vgm_header _vgm_command_count
  _vgm_get_command _vgm_command_args
  _vgm_format_command _vgm_heatmap
  _vgm_used_chip_mask
  _vgm_chip_name _vgm_chip_short_name
  _vgm_insert_command _vgm_delete_command _vgm_update_command
  _vgm_serialize
  _vgm_get_loop_index _vgm_set_loop_index
  _vgm_delete_range
  _vgm_sizeof_command_entry _vgm_sizeof_header _vgm_chip_count
  _vgm_offsetof_header_chip_clocks
  _libvgm_open _libvgm_close _libvgm_render_s16
  _libvgm_seek_sample _libvgm_current_sample _libvgm_total_samples
)
EXPORT_LIST=$(IFS=,; echo "${EXPORTS[*]}")

em++ "${OBJS[@]}" \
  "$LIBVGM_BUILD/bin/libvgm-player.a" \
  "$LIBVGM_BUILD/bin/libvgm-emu.a" \
  "$LIBVGM_BUILD/bin/libvgm-utils.a" \
  -O2 \
  -sUSE_ZLIB=1 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker,node \
  -sWASM_BIGINT=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSINGLE_FILE=1 \
  -sEXPORT_NAME=createVgmCore \
  -sEXPORTED_FUNCTIONS="$EXPORT_LIST" \
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString \
  -o "$OUT_DIR/vgmcore.js"

echo "[build] $OUT_DIR/vgmcore.js"

# ---- 4. AudioWorklet bundle ----------------------------------------------
# AudioWorkletGlobalScope only loads classic scripts (no ES module imports,
# no fetch). Build a second target with EXPORT_ES6 off and the WASM
# embedded via SINGLE_FILE, then concatenate the processor wrapper so the
# whole audio runtime ships as one self-contained file that addModule()
# can load.
PUBLIC_DIR="$ROOT/public"
mkdir -p "$PUBLIC_DIR"
WORKLET_TMP="$OBJ_DIR/vgmcore-worklet-libvgm.js"

em++ "${OBJS[@]}" \
  "$LIBVGM_BUILD/bin/libvgm-player.a" \
  "$LIBVGM_BUILD/bin/libvgm-emu.a" \
  "$LIBVGM_BUILD/bin/libvgm-utils.a" \
  -O2 \
  -sUSE_ZLIB=1 \
  -sMODULARIZE=1 \
  -sENVIRONMENT=worker \
  -sWASM_BIGINT=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSINGLE_FILE=1 \
  -sEXPORT_NAME=createVgmCoreWorklet \
  -sEXPORTED_FUNCTIONS="$EXPORT_LIST" \
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString \
  -o "$WORKLET_TMP"

# AudioWorkletGlobalScope doesn't define `self` (Emscripten's `worker`
# environment assumes it does) and doesn't have `setTimeout` /
# `queueMicrotask` everywhere. Prepend a tiny shim before the Emscripten
# output so the runtime initialises cleanly.
{
  cat <<'SHIM'
// --- AudioWorkletGlobalScope polyfill (prepended by build.sh) ---
var self = globalThis;
var location = location || { href: '' };
if (typeof setTimeout === 'undefined') {
  // AudioWorklet doesn't expose timers. Emscripten's runtime mostly
  // uses them for async startup paths we don't hit; an immediate
  // execution is fine as a stand-in for the few cases that fire.
  var setTimeout = function (fn) { try { fn(); } catch (_) {} return 0; };
  var clearTimeout = function () {};
}
SHIM
  cat "$WORKLET_TMP"
  cat "$CORE_DIR/wasm/worklet-processor.js"
} > "$PUBLIC_DIR/vgm-realtime-worklet.js"
rm "$WORKLET_TMP"
echo "[build] $PUBLIC_DIR/vgm-realtime-worklet.js"
