# Cross-compiles the module for 64-bit Windows from Linux: clang-cl and lld-link
# against Microsoft's C++ runtime and Windows SDK, which xwin fetches from
# Microsoft's servers. Building this image accepts Microsoft's license terms for
# those files (xwin --accept-license).
#
# SDR++ for Windows is built with MSVC and the module shares C++ objects with it
# (std::string, std::map, nlohmann::json), so the module has to use the same
# ABI and STL: MinGW would compile, then crash on the first call into the core.
#
# The CRT is pinned older than any SDR++ build bundles (upstream ships the 14.51
# runtime, Community Edition 14.44): code built with an older toolset runs on a
# newer runtime, never the other way round.
FROM debian:bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        clang-16 lld-16 llvm-16 cmake ninja-build curl ca-certificates python3 unzip \
    && rm -rf /var/lib/apt/lists/*

ARG XWIN_VERSION=0.10.0
ARG XWIN_SHA256=d870eb4b2f390878af6da1ccd3cf321d22fcb72720984853b4be732ae597fc88
RUN curl -sSL -o /tmp/xwin.tgz https://github.com/Jake-Shadle/xwin/releases/download/${XWIN_VERSION}/xwin-${XWIN_VERSION}-x86_64-unknown-linux-musl.tar.gz \
    && echo "${XWIN_SHA256}  /tmp/xwin.tgz" | sha256sum -c - \
    && tar xzf /tmp/xwin.tgz -C /tmp \
    && mv /tmp/xwin-${XWIN_VERSION}-x86_64-unknown-linux-musl/xwin /usr/local/bin/xwin \
    && rm -rf /tmp/xwin*

ARG CRT_VERSION=14.38.17.8
RUN xwin --accept-license --arch x86_64 --crt-version ${CRT_VERSION} --cache-dir /tmp/xwin-cache \
        splat --output /xwin \
    && rm -rf /tmp/xwin-cache

RUN ln -s /usr/bin/clang-16 /usr/local/bin/clang-cl \
    && ln -s /usr/bin/lld-link-16 /usr/local/bin/lld-link \
    && ln -s /usr/bin/llvm-lib-16 /usr/local/bin/llvm-lib \
    && ln -s /usr/bin/llvm-dlltool-16 /usr/local/bin/llvm-dlltool \
    && ln -s /usr/bin/llvm-rc-16 /usr/local/bin/llvm-rc \
    && ln -s /usr/bin/llvm-mt-16 /usr/local/bin/llvm-mt
