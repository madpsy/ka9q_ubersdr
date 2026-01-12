
CXX = c++ -O

FLAGS = -std=c++17 -I/opt/local/include -I/usr/local/include
LIBS = -L/opt/local/lib -L/usr/local/lib -lfftw3

# UberSDR support (network-based SDR via WebSocket)
CXX += -DUSE_UBERSDR
MOREC = ubersdr.cc
MOREH = ubersdr.h
LIBS += -lopus -lcurl

SRC = js8.cc common.cc libldpc.cc pack.cc unpack.cc snd.cc fft.cc util.cc $(MOREC)
ENHANCED_SRC = js8_enhanced.cc

js8skim: fate.cc $(SRC) $(MOREH)
	$(CXX) $(FLAGS) fate.cc $(SRC) -o js8skim $(LIBS) -pthread

js8skim-enhanced: fate_enhanced.cc $(SRC) $(ENHANCED_SRC) $(MOREH) js8_enhanced.h
	$(CXX) $(FLAGS) fate_enhanced.cc $(SRC) $(ENHANCED_SRC) -o js8skim-enhanced $(LIBS) -pthread

all: js8skim js8skim-enhanced

clean:
	rm -f js8skim js8skim-enhanced fate

