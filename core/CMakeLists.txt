# vgmcore — VGM parsing, formatting and timeline analysis.
#
# Pure C99 static library. The same sources are compiled to WebAssembly via
# core/wasm/build.sh for the React frontend; this CMake target is the same
# library for native use (CLI tools, Qt, anything that wants the parser
# without the editor UI).
#
# Usage:
#   add_subdirectory(third_party/vgmedit/core)
#   target_link_libraries(your_target PRIVATE vgmcore)

cmake_minimum_required(VERSION 3.16)
project(vgmcore C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_library(vgmcore STATIC
    src/parser.c
    src/commands.c
    src/heatmap.c
    src/format.c
    src/edit.c
)

target_include_directories(vgmcore
    PUBLIC  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
)

if(MSVC)
    target_compile_options(vgmcore PRIVATE /W4)
else()
    target_compile_options(vgmcore PRIVATE -Wall -Wextra -Wpedantic)
endif()

# Optional: a tiny CLI that opens a file and dumps its commands, useful for
# smoke-testing the library outside the web stack.
option(VGMCORE_BUILD_TOOLS "Build vgmcore CLI tools" OFF)
if(VGMCORE_BUILD_TOOLS)
    add_executable(vgmdump tools/vgmdump.c)
    target_link_libraries(vgmdump PRIVATE vgmcore)
endif()
