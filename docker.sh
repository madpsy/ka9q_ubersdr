#!/bin/bash

# Extract version from version.go
VERSION=$(grep -oP 'const Version = "\K[^"]+' version.go)
IMAGE=madpsy/ka9q_ubersdr

# Check for --no-latest flag
TAG_LATEST=true
if [[ "$1" == "--no-latest" ]]; then
    TAG_LATEST=false
    echo "Running in --no-latest mode (will not tag as latest)"
fi

echo "Ensure version.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Build image with version tag
echo "Building Docker image..."
if ! docker build -t $IMAGE:$VERSION -f docker/Dockerfile .; then
    echo "ERROR: Docker build failed!"
    exit 1
fi

echo "Build successful!"

# Tag version as latest (unless --no-latest flag is set)
if [ "$TAG_LATEST" = true ]; then
    echo "Tagging as latest..."
    docker tag $IMAGE:$VERSION $IMAGE:latest
else
    echo "Skipping 'latest' tag (--no-latest flag set)"
fi

# Push tags
echo "Pushing to Docker Hub..."
docker push $IMAGE:$VERSION

if [ "$TAG_LATEST" = true ]; then
    docker push $IMAGE:latest
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
