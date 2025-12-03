#!/bin/bash

VERSION=0.8.1
IMAGE=madpsy/ka9q_ubersdr

# Build image with version tag
docker build -t $IMAGE:$VERSION -f docker/Dockerfile .

# Tag version as latest
docker tag $IMAGE:$VERSION $IMAGE:latest

# Push both tags
docker push $IMAGE:$VERSION
docker push $IMAGE:latest
