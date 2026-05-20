cmake_minimum_required(VERSION 3.16)
project(cw-decoder LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(GGMORSE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/ggmorse)

add_library(ggmorse STATIC
    ${GGMORSE_DIR}/src/ggmorse.cpp
    ${GGMORSE_DIR}/src/resampler.cpp
)
target_include_directories(ggmorse PUBLIC
    ${GGMORSE_DIR}/include
    ${GGMORSE_DIR}/src
)
target_compile_options(ggmorse PRIVATE -w)  # suppress ggmorse's own warnings

add_executable(cw-decoder
    main.cpp
    CwDecoder.cpp
)
target_include_directories(cw-decoder PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(cw-decoder PRIVATE ggmorse)

if(UNIX)
    target_link_libraries(cw-decoder PRIVATE pthread)
endif()
