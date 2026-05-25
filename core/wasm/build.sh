#!/usr/bin/env bash
#
# Build vgmcore as a single-file ES module for the web frontend.
#
# Outputs:
#   src/wasm/vgmcore.js  — ESM that default-exports an async module factory
#
# The WASM binary is base64-embedded (SINGLE_FILE=1) so Vite can bundle it
# without extra plugins or .wasm asset wiring. If/when this gets large we
# can switch to a separate .wasm file.
set -euo pipefail

cd "$(dirname "$0")/../.."
CORE_DIR="$(pwd)/core"
OUT_DIR="$(pwd)/src/wasm"
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

SRCS=(
  "$CORE_DIR/src/parser.c"
  "$CORE_DIR/src/commands.c"
  "$CORE_DIR/src/heatmap.c"
  "$CORE_DIR/src/format.c"
  "$CORE_DIR/src/edit.c"
  "$CORE_DIR/wasm/bindings.c"
)

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
)

EXPORT_LIST=$(IFS=,; echo "${EXPORTS[*]}")

emcc "${SRCS[@]}" \
  -I "$CORE_DIR/include" \
  -I "$CORE_DIR/src" \
  -O2 \
  -std=c99 \
  -Wall -Wextra \
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

echo "built $OUT_DIR/vgmcore.js"
