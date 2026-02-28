# Multi-stage build for ka9q_ubersdr on Ubuntu 24.04
FROM golang:1.24-bookworm AS builder

# Install build dependencies for Opus
RUN apt-get update && apt-get install -y \
    libopus-dev \
    libopusfile-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /build

# Copy go mod files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy the entire project
COPY . .

# Ensure go.sum is up to date with dependencies
RUN go mod tidy

# Build ka9q_ubersdr
RUN make

# Runtime stage
FROM ubuntu:24.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies including yq for YAML merging, WSJT-X, libopus, and js8 dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    iproute2 \
    libopus0 \
    libopusfile0 \
    libqt5core5a \
    libqt6core6 \
    libqt6network6 \
    libcurl4 \
    libfftw3-single3 \
    libfftw3-bin \
    libgfortran5 \
    && wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq \
    && chmod +x /usr/bin/yq \
    && wget https://github.com/madpsy/ka9q_ubersdr/releases/download/latest/js8 -O /usr/bin/js8 \
    && chmod +x /usr/bin/js8 \
    && wget https://github.com/madpsy/jt9-decode/releases/download/1.0.0/wsjtx_3.1.0_improved_AL_PLUS_260226-OFC_amd64.deb -O /tmp/wsjtx.deb \
    && dpkg-deb -x /tmp/wsjtx.deb /tmp/wsjtx-extract \
    && cp /tmp/wsjtx-extract/usr/bin/jt9 /usr/bin/jt9 \
    && cp /tmp/wsjtx-extract/usr/bin/wsprd /usr/bin/wsprd \
    && chmod +x /usr/bin/jt9 /usr/bin/wsprd \
    && rm -rf /tmp/wsjtx.deb /tmp/wsjtx-extract \
    && wget https://github.com/madpsy/jt9-decode/releases/download/1.0.0/jt9_decode -O /usr/local/bin/jt9_decode \
    && chmod +x /usr/local/bin/jt9_decode \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy pre-built binary from builder
COPY --from=builder /build/ka9q_ubersdr /usr/local/bin/ka9q_ubersdr
RUN chmod +x /usr/local/bin/ka9q_ubersdr

# Copy static files (part of the build, not a volume)
COPY --from=builder /build/static ./static

# Copy kiwi directory for KiwiSDR web interface
COPY --from=builder /build/kiwi ./kiwi

# Copy example configuration files to /etc/ka9q_ubersdr (not affected by volume mounts)
COPY --from=builder /build/config/config.yaml.example /etc/ka9q_ubersdr/config.yaml.example
COPY --from=builder /build/config/bands.yaml.example /etc/ka9q_ubersdr/bands.yaml.example
COPY --from=builder /build/config/bookmarks.yaml.example /etc/ka9q_ubersdr/bookmarks.yaml.example
COPY --from=builder /build/config/extensions.yaml.example /etc/ka9q_ubersdr/extensions.yaml.example
COPY --from=builder /build/config/decoder.yaml.example /etc/ka9q_ubersdr/decoder.yaml.example
COPY --from=builder /build/config/cwskimmer.yaml.example /etc/ka9q_ubersdr/cwskimmer.yaml.example
COPY --from=builder /build/config/rotator_schedule.yaml.example /etc/ka9q_ubersdr/rotator_schedule.yaml.example

# Copy CTY directory with cty.dat file
COPY --from=builder /build/cty /etc/ka9q_ubersdr/cty

# Copy GeoIP database
COPY --from=builder /build/geoip ./geoip

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose default ports
# 8080 - Web interface (as configured in config.yaml)
EXPOSE 8080/tcp

# Environment variables
ENV TZ=UTC

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Use entrypoint script to handle configuration
ENTRYPOINT ["/entrypoint.sh"]

# Default command
CMD ["ka9q_ubersdr"]