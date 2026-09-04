PREFIX=/usr/local

CC = gcc
CFLAGS = -std=gnu11 -Wall -O3 -D_GNU_SOURCE=1

LIBS = -lrt -lm -lpthread -lbsd -lwebsockets -luuid
LDFLAGS =

BINARY = ubersdr-hpsdr-bridge

# Everything built here lands in build/, which is where build.sh puts the
# release binaries and which .gitignore already covers, named after the
# architecture the way build.sh names its two. Writing to the source directory
# instead is how a built object ends up committed beside its source.
#
# From `uname -m` rather than the compiler, because this is a native build:
# build.sh is what cross-builds, in a container with the target's headers and
# libraries, which is not something a Makefile can stand in for.
OUT = build
ARCH = $(shell uname -m | sed -e s/x86_64/amd64/ -e s/aarch64/arm64/)
TARGET = $(OUT)/$(BINARY)_$(ARCH)

DEPENDDIR = .
DEPENDFLAGS = -MM

SRCS = ka9q_hpsdr.c pcm_v4.c hpsdr_p1.c

OBJS = $(SRCS:.c=.o)

CLIENT = ubersdr-hpsdr-client
CLIENT_TARGET = $(OUT)/$(CLIENT)_$(ARCH)

# Both binaries are release artefacts, built and published for every
# architecture, so both are what `all` means. The client links no library the
# bridge does not already need, and no sound library at all — it writes its
# audio to a player process — so it costs the build nothing.
#
# `make client` still builds only the client, which is what you want while
# working on it: the bridge is the slow half.
all: $(TARGET) $(CLIENT_TARGET)

client: $(CLIENT_TARGET)

$(CLIENT_TARGET): hpsdr_client.c
	@mkdir -p $(OUT)
	$(CC) $(CFLAGS) hpsdr_client.c -lm -o $(CLIENT_TARGET)

DEPS = $(patsubst %.o,$(DEPENDDIR)/%.d,$(OBJS))
-include $(DEPS)

$(DEPENDDIR)/%.d: %.c $(DEPENDDIR)
	$(CC) $(CFLAGS) $(DEPENDFLAGS) $< >$@

$(TARGET): $(OBJS)
	@mkdir -p $(OUT)
	$(CC) $(OBJS) $(LDFLAGS) $(LIBS) -o $(TARGET)

install: $(TARGET)
	install -m 755 $(TARGET) $(PREFIX)/bin/$(BINARY)

clean:
	rm -f $(DEPS) $(OBJS) $(TARGET) $(CLIENT_TARGET)

.PHONY: all client clean install
