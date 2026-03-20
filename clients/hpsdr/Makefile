PREFIX=/usr/local

CC = gcc
CFLAGS = -std=gnu11 -Wall -O3 -D_GNU_SOURCE=1

LIBS = -lrt -lm -lpthread -lbsd -lwebsockets -lzstd -luuid
LDFLAGS =

TARGET = ubersdr-hpsdr-bridge

DEPENDDIR = .
DEPENDFLAGS = -MM

SRCS = ka9q_hpsdr.c

OBJS = $(SRCS:.c=.o)

all: $(TARGET)

DEPS = $(patsubst %.o,$(DEPENDDIR)/%.d,$(OBJS))
-include $(DEPS)

$(DEPENDDIR)/%.d: %.c $(DEPENDDIR)
	$(CC) $(CFLAGS) $(DEPENDFLAGS) $< >$@

$(TARGET): $(OBJS)
	$(CC) $(OBJS) $(LDFLAGS) $(LIBS) -o $(TARGET)

install: $(TARGET)
	install -m 755 $(TARGET) $(PREFIX)/bin/

clean:
	rm -f $(DEPS) $(OBJS) $(TARGET)

.PHONY: all clean install
