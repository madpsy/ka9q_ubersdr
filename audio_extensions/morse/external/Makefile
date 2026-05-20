.PHONY: all install clean

# Map uname -m → Go-style arch name
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_M),x86_64)
    ARCH := amd64
else ifeq ($(UNAME_M),aarch64)
    ARCH := arm64
else ifeq ($(UNAME_M),armv7l)
    ARCH := arm
else
    ARCH := $(UNAME_M)
endif

BINARY      := cw-decoder_$(ARCH)
BUILD_DIR   := build
CMAKE_BIN   := $(BUILD_DIR)/cw-decoder
INSTALL_DIR := /usr/local/bin

all: $(BINARY)

$(BINARY): $(CMAKE_BIN)
	cp $(CMAKE_BIN) $(BINARY)

$(CMAKE_BIN):
	cmake -B $(BUILD_DIR) -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
	cmake --build $(BUILD_DIR) -j$(nproc)

install: $(BINARY)
	install -m 755 $(BINARY) $(INSTALL_DIR)/cw-decoder

clean:
	rm -rf $(BUILD_DIR) cw-decoder_*
