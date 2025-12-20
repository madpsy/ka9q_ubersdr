#!/bin/bash

# Extract version from main.go
VERSION=$(grep -oP 'Version = "\K[^"]+' main.go)
IMAGE=madpsy/wsprnet-mqtt

echo "WSPR MQTT Aggregator Docker Build & Push"
echo "=========================================="
echo ""
echo "Ensure main.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Change to docker directory
cd docker

echo "Building Docker image..."
echo ""

# Build image with version tag
docker build --no-cache --pull -t $IMAGE:$VERSION -f Dockerfile ..

# Check if build succeeded
if [ $? -ne 0 ]; then
    echo ""
    echo "✗ Docker build failed!"
    echo ""
    cd ..
    exit 1
fi

# Tag version as latest
docker tag $IMAGE:$VERSION $IMAGE:latest

echo ""
echo "Pushing to Docker Hub..."
echo ""

# Push both tags
docker push $IMAGE:$VERSION
if [ $? -ne 0 ]; then
    echo ""
    echo "✗ Docker push failed for version tag!"
    echo ""
    cd ..
    exit 1
fi

docker push $IMAGE:latest
if [ $? -ne 0 ]; then
    echo ""
    echo "✗ Docker push failed for latest tag!"
    echo ""
    cd ..
    exit 1
fi

echo ""
echo "✓ Successfully built and pushed:"
echo "  - $IMAGE:$VERSION"
echo "  - $IMAGE:latest"
echo ""

# Return to wsprnet_mqtt directory
cd ..

# Commit and push version changes
echo "Committing version changes..."
git add .
git commit -m "wsprnet-mqtt: $VERSION"
git push -v

echo ""
echo "✓ Done!"