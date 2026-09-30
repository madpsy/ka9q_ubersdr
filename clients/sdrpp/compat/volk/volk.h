// Stand-in for VOLK's generated header.
//
// SDR++'s dsp::stream allocates its buffers through the three functions below,
// inline, so any module that owns a stream calls them. The real header is
// generated when VOLK is built and pulls in the whole kernel list, none of which
// this module uses. Declaring the three is enough: at run time they resolve to
// the VOLK that sdrpp_core was built against and has already loaded.
//
// The linkage differs by platform, and has to match what the library exports:
// VOLK's own header gives them C linkage, but the volk.dll that ships with SDR++
// for Windows was compiled as C++ and exports them mangled
// (?volk_malloc@@YAPEAX_K0@Z), so there they are declared as C++.
#pragma once
#include <stddef.h>

#if defined(_WIN32)
#define UBERSDR_VOLK_API __declspec(dllimport)
#else
#define UBERSDR_VOLK_API
#endif

#if defined(__cplusplus) && !defined(_WIN32)
extern "C" {
#endif

UBERSDR_VOLK_API size_t volk_get_alignment(void);
UBERSDR_VOLK_API void* volk_malloc(size_t size, size_t alignment);
UBERSDR_VOLK_API void volk_free(void* aptr);

#if defined(__cplusplus) && !defined(_WIN32)
}
#endif
