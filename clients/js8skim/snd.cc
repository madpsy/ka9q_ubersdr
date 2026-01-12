#include "snd.h"
#include <stdio.h>
#include <stdlib.h>
#include <assert.h>
#include "ubersdr.h"

//
// generic open - ubersdr only
//
SoundIn *
SoundIn::open(std::string card, std::string chan, int rate)
{
  assert(card.size() > 0);

  if(card == "ubersdr"){
    return new UberSDRSoundIn(chan, rate);
  } else {
    fprintf(stderr, "SoundIn::open(%s, %s): only 'ubersdr' is supported\n", card.c_str(), chan.c_str());
    exit(1);
  }
}

//
// functions for Python to call via ctypes.
//

extern "C" {
  void *ext_snd_in_open(const char *card, const char *chan, int rate);
  int ext_snd_in_read(void *, double *, int, double *);
  int ext_snd_in_freq(void *, int);
}

void *
ext_snd_in_open(const char *card, const char *chan, int rate)
{
  SoundIn *sin = SoundIn::open(card, chan, rate);
  sin->start();
  return (void *) sin;
}

//
// reads up to maxout samples.
// non-blocking.
// *tm will be set to UNIX time of last sample in out[].
// return value is number of samples written to out[].
//
int
ext_snd_in_read(void *thing, double *out, int maxout, double *tm)
{
  SoundIn *sin = (SoundIn *) thing;
  double t0; // time of first sample.

  // the "1" argument to get() means return the latest maxout samples,
  // and discard samples older than that!

  int n;
  if(sin->has_iq()){
    // return I/Q pairs.
    std::vector<std::complex<double>> v = sin->get_iq(maxout / 2, t0, 1);
    assert((int)v.size()*2 <= maxout);
    for(int i = 0; i*2 < maxout && i < (int) v.size(); i++){
      out[i*2+0] = v[i].real();
      out[i*2+1] = v[i].imag();
    }
    *tm = t0 + v.size() * (1.0 / sin->rate()); // time of last sample.
    n = v.size() * 2;
  } else {
    // return ordinary audio samples.
    std::vector<double> v = sin->get(maxout, t0, 1);

    assert((int) v.size() <= maxout);
    for(int i = 0; i < maxout && i < (int) v.size(); i++){
      out[i] = v[i];
    }
    *tm = t0 + v.size() / (double)sin->rate(); // time of last sample.
    n = v.size();
  }

  return n;
}

int
ext_snd_in_freq(void *thing, int hz)
{
  SoundIn *sin = (SoundIn *) thing;
  int x = sin->set_freq(hz);
  return x;
}
