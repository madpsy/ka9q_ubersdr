# Builds the Linux module on Ubuntu 20.04 Focal (glibc 2.31, GCC 9), the oldest
# base SDR++ still publishes packages for, alongside Debian Bullseye (also glibc
# 2.31): a module linked here loads on both and on every newer distribution,
# where one linked on a newer system would not. Built for amd64 and, under
# emulation, arm64.
#
# Focal rather than Bullseye because Bullseye's security suite is part way
# through its move to archive.debian.org, and its image no longer installs.
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ninja-build curl ca-certificates bzip2 python3 binutils \
    && rm -rf /var/lib/apt/lists/*

# Focal's CMake (3.16) predates what the build uses; Kitware's portable one.
ARG CMAKE_VERSION=3.30.5
RUN arch=$(uname -m) \
    && curl -fsSL https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-${arch}.tar.gz \
       | tar xz -C /opt \
    && ln -s /opt/cmake-${CMAKE_VERSION}-linux-${arch}/bin/* /usr/local/bin/
