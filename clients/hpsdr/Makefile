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

SRCS = ka9q_hpsdr.c pcm_v4.c

OBJS = $(SRCS:.c=.o)

all: $(TARGET)

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
	rm -f $(DEPS) $(OBJS) $(TARGET)

.PHONY: all clean install
