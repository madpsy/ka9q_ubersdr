# The Whisper helper: whisper_helper.cpp over whisper.cpp, one static executable.
#
# build.sh fetches whisper.cpp at a pinned commit into build/whisper.cpp and
# points WHISPER_CPP_DIR at it; the tree is not vendored here. The CPU features
# ggml compiles for are chosen by build.sh per variant (see the dispatch notes in
# whisper_helper.cpp) and passed straight through as GGML_* options.
cmake_minimum_required(VERSION 3.14)
project(whisper_helper CXX C)

set(WHISPER_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/build/whisper.cpp" CACHE PATH "whisper.cpp source tree")
set(WHISPER_CPP_COMMIT "unknown" CACHE STRING "the whisper.cpp commit being built, for --version")
set(WHISPER_HELPER_VARIANT "default" CACHE STRING "baseline, avx2, ... for --version")
option(WHISPER_HELPER_DISPATCH "hand over to whisper-helper-avx2 when the CPU can run it" OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Static libraries and nothing else of whisper.cpp's: no examples, no server,
# no tests, no OpenMP (its runtime would be one more thing to link statically
# on three toolchains; ggml's own thread pool is what it falls back to).
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)
set(GGML_METAL OFF CACHE BOOL "" FORCE)
set(GGML_BLAS OFF CACHE BOOL "" FORCE)
set(GGML_CCACHE OFF CACHE BOOL "" FORCE)

add_subdirectory("${WHISPER_CPP_DIR}" whisper.cpp EXCLUDE_FROM_ALL)

add_executable(whisper-helper whisper_helper.cpp whisper_session.cpp whisper_core.cpp)
target_link_libraries(whisper-helper PRIVATE whisper)
target_compile_definitions(whisper-helper PRIVATE
  WHISPER_CPP_COMMIT="${WHISPER_CPP_COMMIT}"
  WHISPER_HELPER_VARIANT="${WHISPER_HELPER_VARIANT}")
if (WHISPER_HELPER_DISPATCH)
  target_compile_definitions(whisper-helper PRIVATE WHISPER_HELPER_DISPATCH)
endif()

if (WIN32)
  # Nothing to ship beside the exe: libstdc++, libgcc and winpthread linked in.
  target_link_options(whisper-helper PRIVATE -static -static-libgcc -static-libstdc++)
  target_link_libraries(whisper-helper PRIVATE shell32)
elseif (APPLE)
  # macOS has no static libc; libSystem is always there, and that is all this
  # links against.
else()
  # Fully static on Linux: no glibc version to match against the oldest
  # distribution the AppImage reaches. Nothing here needs what static glibc
  # cannot do (NSS, dlopen).
  target_link_options(whisper-helper PRIVATE -static)
endif()
