# The browser's Whisper: whisper_wasm.cpp, the shared session and core, and
# whisper.cpp, as one Emscripten module (whisper-stt.js + whisper-stt.wasm).
# Built by ../build.sh --only=wasm in the pinned emscripten/emsdk image
# (build-wasm.sh); see the top of whisper_wasm.cpp for what it is for.
cmake_minimum_required(VERSION 3.14)
project(whisper_wasm CXX C)

set(WHISPER_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../build/whisper.cpp" CACHE PATH "whisper.cpp source tree")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Emscripten's toolchain calls the processor "x86", which ggml takes for an
# architecture it does not know, and builds its generic C — without the
# WebAssembly SIMD kernels in ggml-cpu/arch/wasm that it has for exactly this.
# Measured: tiny 11.9 s a 5 s chunk generic, 6.9 s with them. Saying "wasm32"
# here, before whisper.cpp is added, reaches its wasm branch without editing
# the pinned tree.
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)
set(GGML_CCACHE OFF CACHE BOOL "" FORCE)

add_subdirectory("${WHISPER_CPP_DIR}" whisper.cpp EXCLUDE_FROM_ALL)

# whisper.cpp's CMakeLists adds -pthread to every Emscripten build, for its
# own examples. Threads would need the page cross-origin isolated (see
# whisper_wasm.cpp); this module is linked without them, and ggml, asked for one
# thread, never starts one.
add_executable(whisper-stt whisper_wasm.cpp ../whisper_session.cpp ../whisper_core.cpp)
target_include_directories(whisper-stt PRIVATE ..)
target_link_libraries(whisper-stt PRIVATE whisper)
target_compile_options(whisper-stt PRIVATE -msimd128)
set_target_properties(whisper-stt PROPERTIES SUFFIX ".js")
target_link_options(whisper-stt PRIVATE
  -O3
  -msimd128
  -sMODULARIZE=1
  -sEXPORT_NAME=WhisperStt
  -sENVIRONMENT=worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB
  -sMAXIMUM_MEMORY=2GB
  -sSTACK_SIZE=5MB
  -sEXPORTED_FUNCTIONS=_malloc,_free,_stt_init,_stt_load_model,_stt_load_vad,_stt_multilingual,_stt_languages,_stt_start,_stt_audio,_stt_reset,_stt_stop,_stt_interim,_stt_version
  -sEXPORTED_RUNTIME_METHODS=ccall,UTF8ToString,HEAPU8,HEAPF32
)
