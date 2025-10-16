#!/bin/bash

#  Remove any old Docker versions
sudo apt remove -y docker docker.io containerd runc

#  Update system and install prerequisites
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release

#  Add Docker’s official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

#  Add the official Docker repository for Bookworm
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian \
  bookworm stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

#  Update package index and install Docker Engine + CLI + plugins
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd docker-buildx-plugin docker-compose-plugin

#  Enable Docker service and verify installation
sudo systemctl enable docker
sudo systemctl start docker
docker --version
