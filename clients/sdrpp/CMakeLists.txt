# UberSDR source module for SDR++, built out of tree.
#
# The module is compiled against SDR++'s headers only. It never links a copy of
# sdrpp_core: the core, and the VOLK it was built with, are already loaded by the
# SDR++ process that opens the module, and the module's undefined symbols resolve
# against them there. That is what lets one build serve an SDR++ install nobody
# here compiled, and it is why the headers are pinned: every struct the module
# shares with the core has to have the layout the core was built with. See
# src/sdrpp_compat.h for the one place upstream and Community Edition differ.
#
# Windows is the exception to "never links": a DLL's imports have to name the
# DLL they come from, so the link wants import libraries for sdrpp_core.dll and
# volk.dll. build.sh generates them from the DLLs in an SDR++ release and passes
# their directory as SDRPP_WINDOWS_IMPORT_DIR.
#
# TLS is mbedTLS, fetched at a pinned release and linked statically, so wss://
# works on every platform with no dependency for the user to install.

cmake_minimum_required(VERSION 3.24)
project(ubersdr_source C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if (NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif ()

include(FetchContent)
# FetchContent_Populate is used on purpose: the SDR++ tree is only headers to
# this build, and must not be added as a subproject.
if (POLICY CMP0169)
    cmake_policy(SET CMP0169 OLD)
endif ()

# --- SDR++ headers ------------------------------------------------------------
#
# Point SDRPP_SOURCE_DIR at a checkout to build against it instead. The module
# works in upstream SDR++ and in SDR++ Community Edition, whose module-facing
# headers match this commit apart from SourceHandler (handled at run time).
set(SDRPP_SOURCE_DIR "" CACHE PATH "SDR++ source tree to take headers from (default: fetch the pinned commit)")
if (NOT SDRPP_SOURCE_DIR)
    FetchContent_Declare(sdrpp_headers
        URL https://github.com/AlexandreRouma/SDRPlusPlus/archive/8c9f5ee8fe405775bfcd62c8c8f8c0fc928a64af.tar.gz
        URL_HASH SHA256=c3d884bb146957792823068cea62c78d11f33eda3d537f12b0c31484bde1eb67
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_GetProperties(sdrpp_headers)
    if (NOT sdrpp_headers_POPULATED)
        FetchContent_Populate(sdrpp_headers)
    endif ()
    set(SDRPP_SOURCE_DIR ${sdrpp_headers_SOURCE_DIR})
endif ()
if (NOT EXISTS "${SDRPP_SOURCE_DIR}/core/src/module.h")
    message(FATAL_ERROR "SDRPP_SOURCE_DIR (${SDRPP_SOURCE_DIR}) is not an SDR++ source tree")
endif ()

# --- mbedTLS --------------------------------------------------------------------
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
set(USE_STATIC_MBEDTLS_LIBRARY ON CACHE BOOL "" FORCE)
set(USE_SHARED_MBEDTLS_LIBRARY OFF CACHE BOOL "" FORCE)
set(DISABLE_PACKAGE_CONFIG_AND_INSTALL ON CACHE BOOL "" FORCE)
set(GEN_FILES OFF CACHE BOOL "" FORCE)
FetchContent_Declare(mbedtls
    URL https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2
    URL_HASH SHA256=a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_GetProperties(mbedtls)
if (NOT mbedtls_POPULATED)
    FetchContent_Populate(mbedtls)
    add_subdirectory(${mbedtls_SOURCE_DIR} ${mbedtls_BINARY_DIR} EXCLUDE_FROM_ALL)
endif ()

# --- the module -----------------------------------------------------------------
add_library(ubersdr_source SHARED
    src/main.cpp
    src/sdrpp_compat.cpp
    src/tls_conn.cpp
    src/trust.cpp
    src/http.cpp
    src/websocket.cpp
    src/server_api.cpp
    src/mdns.cpp
    src/iq_session.cpp)

set_target_properties(ubersdr_source PROPERTIES PREFIX "")
if (APPLE)
    # SDR++ loads modules by the extension it was built with.
    set_target_properties(ubersdr_source PROPERTIES SUFFIX ".dylib")
endif ()

target_include_directories(ubersdr_source PRIVATE
    src
    compat                                  # volk/volk.h stand-in
    ${CMAKE_CURRENT_SOURCE_DIR}/../soapy_driver   # pcm_v4.hpp, the shared v4 decoder
    ${SDRPP_SOURCE_DIR}/core/src
    ${SDRPP_SOURCE_DIR}/core/src/imgui)

target_link_libraries(ubersdr_source PRIVATE mbedtls mbedx509 mbedcrypto)

if (WIN32)
    set(SDRPP_WINDOWS_IMPORT_DIR "" CACHE PATH "Directory holding sdrpp_core.lib and volk.lib import libraries")
    if (NOT SDRPP_WINDOWS_IMPORT_DIR)
        message(FATAL_ERROR "Windows builds need SDRPP_WINDOWS_IMPORT_DIR (see build.sh)")
    endif ()
    target_compile_definitions(ubersdr_source PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
    target_compile_options(ubersdr_source PRIVATE /EHsc /utf-8)
    target_link_libraries(ubersdr_source PRIVATE
        ${SDRPP_WINDOWS_IMPORT_DIR}/sdrpp_core.lib
        ${SDRPP_WINDOWS_IMPORT_DIR}/volk.lib
        ws2_32 crypt32 bcrypt iphlpapi)
elseif (APPLE)
    target_link_options(ubersdr_source PRIVATE -undefined dynamic_lookup)
    target_link_libraries(ubersdr_source PRIVATE "-framework Security" "-framework CoreFoundation")
else ()
    # Undefined symbols are left for the SDR++ process to satisfy, but only
    # those: -z defs would reject them, so instead the check lives in build.sh,
    # which compares the module's imports against a real libsdrpp_core.so.
    target_link_libraries(ubersdr_source PRIVATE pthread)
    target_link_options(ubersdr_source PRIVATE -Wl,--exclude-libs,ALL)
endif ()

install(TARGETS ubersdr_source
    LIBRARY DESTINATION lib/sdrpp/plugins
    RUNTIME DESTINATION lib/sdrpp/plugins)

# --- tests ----------------------------------------------------------------------
#
# live_test drives the network and decoding code against a live receiver;
# host_test loads the built module into a real SDR++ core and streams through
# its signal path. Both link a real core:
#   -DUBERSDR_TEST_CORE_LIB=/path/to/libsdrpp_core.so   (or sdrpp_core.lib on Windows)
set(UBERSDR_TEST_CORE_LIB "" CACHE FILEPATH "SDR++ core library (or import library) to link the tests against")
set(UBERSDR_TEST_VOLK "" CACHE FILEPATH "VOLK library the core uses (found automatically on Linux)")
set(UBERSDR_TEST_EXTRA_INCLUDE "" CACHE PATH "Extra include dir for host_test (VOLK and FFTW headers)")
if (UBERSDR_TEST_CORE_LIB)
    if (NOT UBERSDR_TEST_VOLK)
        # A separate variable: find_library skips a cache entry that already
        # exists, even an empty one.
        find_library(UBERSDR_FOUND_VOLK volk)
        set(UBERSDR_TEST_VOLK ${UBERSDR_FOUND_VOLK})
    endif ()
    if (WIN32)
        set(_test_sys ws2_32 crypt32 bcrypt iphlpapi)
    elseif (APPLE)
        set(_test_sys pthread "-framework Security" "-framework CoreFoundation")
    else ()
        set(_test_sys pthread dl)
    endif ()

    add_executable(live_test test/live_test.cpp
        src/tls_conn.cpp src/trust.cpp src/http.cpp src/websocket.cpp
        src/server_api.cpp src/mdns.cpp src/iq_session.cpp)
    target_include_directories(live_test PRIVATE src compat
        ${CMAKE_CURRENT_SOURCE_DIR}/../soapy_driver
        ${SDRPP_SOURCE_DIR}/core/src ${SDRPP_SOURCE_DIR}/core/src/imgui)
    target_link_libraries(live_test PRIVATE mbedtls mbedx509 mbedcrypto ${UBERSDR_TEST_CORE_LIB} ${UBERSDR_TEST_VOLK} ${_test_sys})

    add_executable(host_test test/host_test.cpp)
    target_include_directories(host_test PRIVATE ${SDRPP_SOURCE_DIR}/core/src ${SDRPP_SOURCE_DIR}/core/src/imgui ${UBERSDR_TEST_EXTRA_INCLUDE})
    target_link_libraries(host_test PRIVATE ${UBERSDR_TEST_CORE_LIB} ${UBERSDR_TEST_VOLK} ${_test_sys})
    if (WIN32)
        target_compile_definitions(live_test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
        target_compile_definitions(host_test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
        target_compile_options(live_test PRIVATE /EHsc /utf-8)
        target_compile_options(host_test PRIVATE /EHsc /utf-8)
    endif ()
endif ()
