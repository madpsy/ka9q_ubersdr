#!/bin/bash

# Extract version from version.go
VERSION=$(grep -oP 'const Version = "\K[^"]+' version.go)
IMAGE=madpsy/ka9q_ubersdr
FLUENT_BIT_IMAGE=madpsy/fluent-bit-ubersdr

# Parse command line flags
TAG_LATEST=true
NO_CACHE=""
BUILD_FLUENT_BIT=false

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
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--no-latest] [--no-cache] [--fluent-bit]"
            exit 1
            ;;
    esac
done

echo "Ensure version.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Auto-fetch GeoIP City database
GEOIP_DIR="geoip"
GEOIP_FILE="$GEOIP_DIR/GeoLite2-Country.mmdb"  # Keep filename for compatibility
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

    # Check if database file exists
    if [ ! -f "$GEOIP_FILE" ]; then
        echo "ERROR: $GEOIP_FILE not found and cannot auto-download without license key!"
        exit 1
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
        echo "Downloading latest GeoLite2-City database..."
        mkdir -p "$GEOIP_DIR"

        # Download and extract City database (saved as Country.mmdb for compatibility)
        if ! wget -q -O /tmp/GeoLite2-City.tar.gz \
            "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${GEOIP_LICENSE_KEY}&suffix=tar.gz"; then
            echo "WARNING: Failed to download GeoIP database. Check your license key in $GEOIP_LICENSE_FILE"

            if [ ! -f "$GEOIP_FILE" ]; then
                echo "ERROR: $GEOIP_FILE not found and download failed!"
                exit 1
            fi

            echo "Using existing GeoIP database: $GEOIP_FILE"
        else
            tar -xzf /tmp/GeoLite2-City.tar.gz -C /tmp/
            find /tmp/GeoLite2-City_* -name "*.mmdb" -exec cp {} "$GEOIP_FILE" \;
            rm -rf /tmp/GeoLite2-City* /tmp/GeoLite2-City.tar.gz

            echo "GeoIP City database downloaded successfully to $GEOIP_FILE"
        fi
    fi
fi

# Build UberSDR image with version tag
echo "Building UberSDR Docker image..."
if ! docker build $NO_CACHE -t $IMAGE:$VERSION -f docker/Dockerfile .; then
    echo "ERROR: UberSDR Docker build failed!"
    exit 1
fi

echo "UberSDR build successful!"

# Build Fluent Bit image with version tag (only if --fluent-bit flag is set)
if [ "$BUILD_FLUENT_BIT" = true ]; then
    echo "Building Fluent Bit Docker image..."
    if ! docker build $NO_CACHE -t $FLUENT_BIT_IMAGE:$VERSION -f docker/Dockerfile.fluent-bit docker/; then
        echo "ERROR: Fluent Bit Docker build failed!"
        exit 1
    fi
    echo "Fluent Bit build successful!"
else
    echo "Skipping Fluent Bit build (use --fluent-bit flag to build)"
fi

# Tag version as latest (unless --no-latest flag is set)
if [ "$TAG_LATEST" = true ]; then
    echo "Tagging as latest..."
    docker tag $IMAGE:$VERSION $IMAGE:latest
    if [ "$BUILD_FLUENT_BIT" = true ]; then
        docker tag $FLUENT_BIT_IMAGE:$VERSION $FLUENT_BIT_IMAGE:latest
    fi
else
    echo "Skipping 'latest' tag (--no-latest flag set)"
fi

# Push tags
echo "Pushing UberSDR to Docker Hub..."
docker push $IMAGE:$VERSION

if [ "$TAG_LATEST" = true ]; then
    docker push $IMAGE:latest
fi

if [ "$BUILD_FLUENT_BIT" = true ]; then
    echo "Pushing Fluent Bit to Docker Hub..."
    docker push $FLUENT_BIT_IMAGE:$VERSION

    if [ "$TAG_LATEST" = true ]; then
        docker push $FLUENT_BIT_IMAGE:latest
    fi
else
    echo "Skipping Fluent Bit push (not built)"
fi

# Commit and push version changes (unless --no-latest flag is set)
if [ "$TAG_LATEST" = true ]; then
    echo "Committing and pushing to git..."
    git add .
    git commit -m "$VERSION"
    git push -v
else
    echo "Skipping git commit and push (--no-latest flag set)"
fi
