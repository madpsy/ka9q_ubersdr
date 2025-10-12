# Makefile for ka9q-multidecoder
# Multi-band digital mode decoder for ka9q-radio

CC = gcc
CFLAGS = -g -O3 -Wall -Wextra -std=gnu11 -D_GNU_SOURCE
LDFLAGS = -lm -lpthread -lbsd

# Path to ka9q-radio source (adjust if needed)
KA9Q_SRC = ../ka9q-radio/src

# Include directories
INCLUDES = -I$(KA9Q_SRC)

# ka9q-radio object files we need to link against
KA9Q_OBJS = $(KA9Q_SRC)/multicast.o \
            $(KA9Q_SRC)/misc.o \
            $(KA9Q_SRC)/attr.o \
            $(KA9Q_SRC)/rtp.o \
            $(KA9Q_SRC)/status.o

TARGET = ka9q-multidecoder

# Local object files
OBJS = ka9q-multidecoder.o decode_parser.o pskreporter.o wsprnet.o

.PHONY: all clean install

all: $(TARGET)

$(TARGET): $(OBJS) $(KA9Q_OBJS)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

ka9q-multidecoder.o: ka9q-multidecoder.c decode_parser.h pskreporter.h wsprnet.h
	$(CC) $(CFLAGS) $(INCLUDES) -c ka9q-multidecoder.c

decode_parser.o: decode_parser.c decode_parser.h
	$(CC) $(CFLAGS) $(INCLUDES) -c decode_parser.c

pskreporter.o: pskreporter.c pskreporter.h decode_parser.h
	$(CC) $(CFLAGS) $(INCLUDES) -c pskreporter.c

wsprnet.o: wsprnet.c wsprnet.h decode_parser.h
	$(CC) $(CFLAGS) $(INCLUDES) -c wsprnet.c

# Build ka9q-radio dependencies if needed
$(KA9Q_SRC)/%.o: $(KA9Q_SRC)/%.c
	$(MAKE) -C $(KA9Q_SRC) $*.o

clean:
	rm -f $(TARGET) *.o

install: $(TARGET)
	install -D $(TARGET) $(DESTDIR)/usr/local/bin/$(TARGET)
	install -D -m 644 multidecoder.conf.example $(DESTDIR)/usr/local/share/ka9q-radio/multidecoder.conf.example

# Help target
help:
	@echo "Available targets:"
	@echo "  all      - Build ka9q-multidecoder (default)"
	@echo "  clean    - Remove built files"
	@echo "  install  - Install to /usr/local/bin"
	@echo "  help     - Show this help message"