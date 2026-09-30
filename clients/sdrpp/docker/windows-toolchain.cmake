# clang-cl targeting x86_64 MSVC, with the CRT and SDK that xwin splatted to
# /xwin (see windows.Dockerfile).
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_VERSION 10.0)
set(CMAKE_SYSTEM_PROCESSOR AMD64)

set(CMAKE_C_COMPILER clang-cl)
set(CMAKE_CXX_COMPILER clang-cl)
set(CMAKE_LINKER lld-link)
set(CMAKE_AR llvm-lib)
set(CMAKE_RC_COMPILER llvm-rc)
set(CMAKE_MT llvm-mt)

set(XWIN /xwin)
set(_msvc_flags "--target=x86_64-pc-windows-msvc -fms-compatibility-version=19.38 /imsvc ${XWIN}/crt/include /imsvc ${XWIN}/sdk/include/ucrt /imsvc ${XWIN}/sdk/include/um /imsvc ${XWIN}/sdk/include/shared")
set(CMAKE_C_FLAGS_INIT "${_msvc_flags}")
set(CMAKE_CXX_FLAGS_INIT "${_msvc_flags}")

set(_link_flags "/libpath:${XWIN}/crt/lib/x86_64 /libpath:${XWIN}/sdk/lib/um/x86_64 /libpath:${XWIN}/sdk/lib/ucrt/x86_64")
set(CMAKE_EXE_LINKER_FLAGS_INIT "${_link_flags}")
set(CMAKE_SHARED_LINKER_FLAGS_INIT "${_link_flags}")
set(CMAKE_MODULE_LINKER_FLAGS_INIT "${_link_flags}")

# /MD, as SDR++ itself is built: one CRT heap on both sides of the DLL boundary.
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
