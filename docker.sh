#!/bin/bash

# Extract version from version.go
VERSION=$(grep -oP 'const Version = "\K[^"]+' version.go)
IMAGE=madpsy/ka9q_ubersdr
FLUENT_BIT_IMAGE=madpsy/fluent-bit-ubersdr

# Parse command line flags
TAG_LATEST=true
NO_CACHE=""
BUILD_FLUENT_BIT=false
SKIP_GEOIP=false
NO_GIT=false

for arg in "$@"; do
    case $arg in
        --no-latest)
            TAG_LATEST=false
            echo "Running in --no-latest mode (will not tag as latest)"
            ;;
        --no-cache)
            NO_CACHE="--no-cache"
            echo "Running in --no-cache mode (will rebuild all layers)"
            ;;
        --fluent-bit)
            BUILD_FLUENT_BIT=true
            echo "Will build Fluent Bit image"
            ;;
        --no-geoip)
            SKIP_GEOIP=true
            echo "Running in --no-geoip mode (will skip GeoIP database download)"
            ;;
        --no-git)
            NO_GIT=true
            echo "Running in --no-git mode (will skip git commit and push)"
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--no-latest] [--no-cache] [--fluent-bit] [--no-geoip] [--no-git]"
            exit 1
            ;;
    esac
done

echo "Ensure version.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Auto-fetch GeoIP City and ASN databases (unless --no-geoip flag is set)
if [ "$SKIP_GEOIP" = true ]; then
    echo "Skipping GeoIP database download (--no-geoip flag set)"
else
    GEOIP_DIR="geoip"
    GEOIP_FILE="$GEOIP_DIR/GeoLite2-Country.mmdb"  # Keep filename for compatibility
    GEOIP_ASN_FILE="$GEOIP_DIR/GeoLite2-ASN.mmdb"
    GEOIP_LICENSE_FILE="$GEOIP_DIR/licence.txt"

    # Check if license file exists
    if [ ! -f "$GEOIP_LICENSE_FILE" ]; then
        echo "WARNING: $GEOIP_LICENSE_FILE not found - skipping GeoIP database download"
        echo ""
        echo "To enable automatic GeoIP database downloads:"
        echo "  1. Sign up for a free account at https://www.maxmind.com/en/geolite2/signup"
        echo "  2. Generate a license key in your account settings"
        echo "  3. Save the license key to $GEOIP_LICENSE_FILE"
        echo ""

        # Check if database files exist
        if [ ! -f "$GEOIP_FILE" ]; then
            echo "ERROR: $GEOIP_FILE not found and cannot auto-download without license key!"
            exit 1
        fi

        if [ ! -f "$GEOIP_ASN_FILE" ]; then
            echo "WARNING: $GEOIP_ASN_FILE not found and cannot auto-download without license key"
        fi

        echo "Using existing GeoIP database: $GEOIP_FILE"
    else
        # Read license key from file
        GEOIP_LICENSE_KEY=$(cat "$GEOIP_LICENSE_FILE" | tr -d '[:space:]')

        if [ -z "$GEOIP_LICENSE_KEY" ]; then
            echo "WARNING: License key in $GEOIP_LICENSE_FILE is empty - skipping download"

            if [ ! -f "$GEOIP_FILE" ]; then
                echo "ERROR: $GEOIP_FILE not found and cannot auto-download with empty license key!"
                exit 1
            fi

            echo "Using existing GeoIP database: $GEOIP_FILE"
        else
            mkdir -p "$GEOIP_DIR"

            # Download and extract City database (saved as Country.mmdb for compatibility)
            echo "Downloading latest GeoLite2-City database..."
            if ! wget -q -O /tmp/GeoLite2-City.tar.gz \
                "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${GEOIP_LICENSE_KEY}&suffix=tar.gz"; then
                echo "WARNING: Failed to download GeoIP City database. Check your license key in $GEOIP_LICENSE_FILE"

                if [ ! -f "$GEOIP_FILE" ]; then
                    echo "ERROR: $GEOIP_FILE not found and download failed!"
                    exit 1
                fi

                echo "Using existing GeoIP database: $GEOIP_FILE"
            else
                tar -xzf /tmp/GeoLite2-City.tar.gz -C /tmp/
                find /tmp/GeoLite2-City_* -name "*.mmdb" -exec cp {} "$GEOIP_FILE" \;
                rm -rf /tmp/GeoLite2-City_* /tmp/GeoLite2-City.tar.gz

                echo "GeoIP City database downloaded successfully to $GEOIP_FILE"
            fi

            # Download and extract ASN database
            echo "Downloading latest GeoLite2-ASN database..."
            if ! wget -q -O /tmp/GeoLite2-ASN.tar.gz \
                "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=${GEOIP_LICENSE_KEY}&suffix=tar.gz"; then
                echo "WARNING: Failed to download GeoIP ASN database. Check your license key in $GEOIP_LICENSE_FILE"

                if [ ! -f "$GEOIP_ASN_FILE" ]; then
                    echo "WARNING: $GEOIP_ASN_FILE not found and download failed - ASN lookups will be unavailable"
                else
                    echo "Using existing GeoIP ASN database: $GEOIP_ASN_FILE"
                fi
            else
                tar -xzf /tmp/GeoLite2-ASN.tar.gz -C /tmp/
                find /tmp/GeoLite2-ASN_* -name "*.mmdb" -exec cp {} "$GEOIP_ASN_FILE" \;
                rm -rf /tmp/GeoLite2-ASN_* /tmp/GeoLite2-ASN.tar.gz

                echo "GeoIP ASN database downloaded successfully to $GEOIP_ASN_FILE"
            fi
        fi
    fi
fi

# Ensure a buildx builder with multi-arch support exists
BUILDER_NAME="multiarch-builder"
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
    echo "Creating multi-arch buildx builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
else
    docker buildx use "$BUILDER_NAME"
fi
docker buildx inspect --bootstrap

# Determine tags for UberSDR image
UBERSDR_TAGS="-t $IMAGE:$VERSION"
if [ "$TAG_LATEST" = true ]; then
    UBERSDR_TAGS="$UBERSDR_TAGS -t $IMAGE:latest"
fi

# Build and push UberSDR multi-arch image
echo "Building and pushing UberSDR Docker image (linux/amd64 + linux/arm64)..."
if ! docker buildx build $NO_CACHE \
    --platform linux/amd64,linux/arm64 \
    $UBERSDR_TAGS \
    --push \
    -f docker/Dockerfile .; then
    echo "ERROR: UberSDR Docker build failed!"
    exit 1
fi

echo "UberSDR build and push successful!"

# Build Fluent Bit image with version tag (only if --fluent-bit flag is set)
if [ "$BUILD_FLUENT_BIT" = true ]; then
    FLUENT_TAGS="-t $FLUENT_BIT_IMAGE:$VERSION"
    if [ "$TAG_LATEST" = true ]; then
        FLUENT_TAGS="$FLUENT_TAGS -t $FLUENT_BIT_IMAGE:latest"
    fi

    echo "Building and pushing Fluent Bit Docker image (linux/amd64 + linux/arm64)..."
    if ! docker buildx build $NO_CACHE \
        --platform linux/amd64,linux/arm64 \
        $FLUENT_TAGS \
        --push \
        -f docker/Dockerfile.fluent-bit docker/; then
        echo "ERROR: Fluent Bit Docker build failed!"
        exit 1
    fi
    echo "Fluent Bit build and push successful!"
else
    echo "Skipping Fluent Bit build (use --fluent-bit flag to build)"
fi

# Commit and push version changes (unless --no-latest or --no-git flag is set)
if [ "$TAG_LATEST" = true ] && [ "$NO_GIT" = false ]; then
    echo "Committing and pushing to git..."
    git add .
    git commit -m "$VERSION"
    git push -v
else
    echo "Skipping git commit and push (--no-latest or --no-git flag set)"
fi
