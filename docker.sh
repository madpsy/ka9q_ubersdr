#!/bin/bash

docker build -t madpsy/ka9q_ubersdr:0.8.1 -f docker/Dockerfile .
docker push madpsy/ka9q_ubersdr:0.8.1
