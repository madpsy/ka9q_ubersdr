# The toolchains build.sh builds the Whisper helper with, for every platform
# but macOS: native gcc for linux-x64, the aarch64 cross gcc for linux-arm64 and
# mingw-w64 for win-x64, all from one Debian release so the three builds of the
# same source differ only where the platforms do.
#
# trixie rather than bookworm for its mingw-w64: ggml-cpu.c asks Windows not to
# throttle its threads (THREAD_POWER_THROTTLING_STATE), which bookworm's mingw
# headers do not declare. The Linux builds link glibc statically, so the newer
# glibc costs no compatibility.
#
# The mingw compiler is the -posix flavour: whisper.cpp uses std::thread, which
# the default win32 threading model of Debian's mingw does not provide.
FROM debian:trixie
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      cmake make gcc g++ file git ca-certificates \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross \
      gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64 \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'
