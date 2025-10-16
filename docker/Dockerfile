# Multi-stage build for ka9q_ubersdr on Ubuntu 24.04
FROM golang:1.24-bookworm AS builder

# Set working directory
WORKDIR /build

# Copy go mod files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy the entire project
COPY . .

# Build ka9q_ubersdr
RUN make

# Runtime stage
FROM ubuntu:24.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy pre-built binary from builder
COPY --from=builder /build/ka9q_ubersdr /usr/local/bin/ka9q_ubersdr
RUN chmod +x /usr/local/bin/ka9q_ubersdr

# Copy static files
COPY --from=builder /build/static ./static

# Copy example configuration files to /etc/ka9q_ubersdr (not affected by volume mounts)
COPY --from=builder /build/config.yaml.example /etc/ka9q_ubersdr/config.yaml.example
COPY --from=builder /build/bands.yaml.example /etc/ka9q_ubersdr/bands.yaml.example
COPY --from=builder /build/bookmarks.yaml.example /etc/ka9q_ubersdr/bookmarks.yaml.example
COPY --from=builder /build/extensions.yaml.example /etc/ka9q_ubersdr/extensions.yaml.example

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