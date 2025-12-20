# Multi-stage Dockerfile for ka9q_ubersdr Go Radio Client
# Supports multi-architecture builds (amd64, arm64, arm/v7)

FROM ubuntu:24.04 AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    ca-certificates \
    git \
    golang-1.21 \
    portaudio19-dev \
    libsamplerate0-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Set up Go environment
ENV PATH="/usr/lib/go-1.21/bin:${PATH}"
ENV GOPATH="/go"
ENV GO111MODULE=on

# Set working directory
WORKDIR /build

# Copy go.mod first
COPY go.mod ./

# Copy source code
COPY . .

# Download dependencies and generate go.sum
# This must be done AFTER copying source to ensure all imports are resolved
RUN go mod download && go mod tidy

# Build the application
# CGO is required for PortAudio bindings
RUN CGO_ENABLED=1 go build -v -o radio_client \
    -ldflags="-s -w" \
    -trimpath \
    . 2>&1 || (echo "Build failed. Checking environment:" && \
    go version && \
    go env && \
    pkg-config --cflags --libs portaudio-2.0 && \
    pkg-config --cflags --libs samplerate && \
    exit 1)

# Runtime stage
FROM ubuntu:24.04

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    portaudio19-dev \
    libsamplerate0 \
    alsa-utils \
    libasound2-plugins \
    libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

# Configure ALSA to suppress plugin errors and use hardware directly
RUN mkdir -p /etc/alsa /usr/share/alsa/alsa.conf.d && \
    printf '%s\n' \
    '# Minimal ALSA configuration for Docker' \
    '# Use hardware devices directly, suppress plugin errors' \
    '' \
    'defaults.pcm.card 0' \
    'defaults.ctl.card 0' \
    '' \
    'pcm.!default {' \
    '    type plug' \
    '    slave.pcm "hw:0,0"' \
    '}' \
    '' \
    'ctl.!default {' \
    '    type hw' \
    '    card 0' \
    '}' \
    '' \
    '# Suppress errors for unavailable plugins' \
    'pcm.pulse { type plug slave.pcm "hw:0,0" }' \
    'pcm.jack { type plug slave.pcm "hw:0,0" }' \
    'pcm.oss { type plug slave.pcm "hw:0,0" }' \
    > /etc/alsa/asound.conf

# Set environment to skip PulseAudio and JACK
ENV PULSE_SERVER=none
ENV JACK_NO_START_SERVER=1
ENV ALSA_CARD=0

# Create non-root user (use existing ubuntu user if UID 1000 exists)
RUN if id -u 1000 >/dev/null 2>&1; then \
        usermod -l radio -d /home/radio -m ubuntu && \
        groupmod -n radio ubuntu; \
    else \
        useradd -m -u 1000 -s /bin/bash radio; \
    fi && \
    usermod -aG audio radio && \
    mkdir -p /home/radio/.config/ubersdr && \
    chown -R radio:radio /home/radio

# Copy binary from builder
COPY --from=builder /build/radio_client /usr/local/bin/radio_client
COPY --from=builder /build/frontend /usr/local/share/ubersdr/frontend

# Set working directory
WORKDIR /home/radio

# Switch to non-root user
USER radio

# Declare volume for persistent configuration
VOLUME ["/home/radio/.config/ubersdr"]

# Expose default API port
EXPOSE 8090

# Set default environment variables
ENV API_PORT=8090
ENV CONFIG_FILE=/home/radio/.config/ubersdr/config.json

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${API_PORT}/api/status || exit 1

# Run the application
CMD ["/usr/local/bin/radio_client"]