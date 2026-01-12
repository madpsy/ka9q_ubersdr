#ifndef snd_h
#define snd_h 1

#include <cassert>
#include <complex>
#include <string>
#include <vector>

#ifdef USE_UBERSDR
// Forward declaration to avoid circular dependency
class UberSDRSoundIn;
#endif

class SoundIn {
public:
  virtual void start() = 0;
  virtual int rate() = 0;
  virtual std::vector<double> get(int n, double &t0, int latest) = 0;
  virtual bool has_iq() { return false; } // default
  virtual std::vector<std::complex<double>> get_iq(int n, double &t0, int latest) {
    assert(0);
    return std::vector<std::complex<double>>();
  }
  virtual int set_freq(int) { return -1; }
  static SoundIn *open(std::string card, std::string chan, int rate);
  virtual bool is_file() { return false; }
};

#endif
