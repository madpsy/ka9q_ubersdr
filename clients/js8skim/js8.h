#ifndef ft8_h
#define ft8_h

#include <vector>
#include <complex>
#include "fft.h"

typedef int (*cb_t)(int *a91, double hz0, double hz1, double off,
                    const char *, double snr, int pass,
                    int correct_bits, int i3);

class Strength {
public:
  double hz_;
  int off_;
  double strength_; // higher is better
};

class FT8 {
public:
  std::thread *th_;

  double min_hz_;
  double max_hz_;
  std::vector<double> samples_;  // input to each pass
  std::vector<double> nsamples_; // subtract from here

  int start_; // sample number of 0.5 seconds into samples[]
  int rate_;  // samples/second
  double deadline_; // start time + budget
  double final_deadline_; // keep going this long if no decodes
  std::vector<int> hints1_;
  std::vector<int> hints2_;
  int pass_;
  double down_hz_;

  static std::mutex cb_mu_;
  cb_t cb_; // call-back into Python with successful decode

  std::mutex hack_mu_;
  int hack_size_;
  int hack_off_;
  int hack_len_;
  double hack_0_;
  double hack_1_;
  const double *hack_data_;
  std::vector<std::complex<double>> hack_bins_;

  Plan *plan32_;

  FT8(const std::vector<double> &samples,
      double min_hz,
      double max_hz,
      int start, int rate,
      int hints1[], int hints2[], double deadline,
      double final_deadline,
      cb_t cb);

  ~FT8() { }
  
  double one_coarse_strength(const ffts_t &bins, int bi0, int si0);
  std::vector<Strength> coarse(const ffts_t &bins, int si0, int si1);
  std::vector<double> reduce_rate(const std::vector<double> &a, double hz0, double hz1,
                                  int arate, int brate,
                                  double &delta_hz);
 void go();
 double one_strength(const std::vector<double> &samples200, double hz, int off);
 double one_strength_known(const std::vector<double> &samples,
                           int rate,
                           const std::vector<int> &syms,
                           double hz, int off);
 int search_time_fine(const std::vector<double> &samples200,
                      int off0, int offN,
                      double hz,
                      int gran,
                      double &str);
 int search_time_fine_known(const std::vector<std::complex<double>> &bins,
                            int rate,
                            const std::vector<int> &syms,
                            int off0, int offN,
                            double hz,
                            int gran,
                            double &str);
 std::vector<Strength> search_both(const std::vector<double> &samples200,
                                   double hz0, int hz_n, double hz_win,
                                   int off0, int off_n, int off_win);
 void search_both_known(const std::vector<double> &samples,
                        int rate,
                        const std::vector<int> &syms,
                        double hz0,
                        double off_secs0, // seconds
                        double &hz_out, double &off_out);
 std::vector<double> fft_shift(const std::vector<double> &samples, int off, int len,
                               int rate, double hz);
 std::vector<double> fft_shift_f(const std::vector<std::complex<double>> &bins, int rate, double hz);
 std::vector<double> shift200(const std::vector<double> &samples200, int off, int len, double hz);
 ffts_t extract(const std::vector<double> &samples200, double hz, int off);
 int one(const std::vector<std::complex<double>> &bins, int len, double hz, int off);
 int one_iter(const std::vector<double> &samples200, int best_off, double hz_for_cb);
 int one_iter1(const std::vector<double> &samples200x,
               int best_off, double best_hz,
               double hz0_for_cb, double hz1_for_cb);
 void subtract(const std::vector<int> re79,
               double hz0,
               double hz1,
               double off_sec);
 int try_decode(const std::vector<double> &samples200,
                double ll174[174],
                double best_hz, int best_off_samples, double hz0_for_cb, double hz1_for_cb,
                int use_osd, const char *comment1,
                const ffts_t &m79);
};

void soft_decode(const ffts_t &c79, double ll174[]);
void c_soft_decode_first(const ffts_t &c79x,
                         std::vector<std::vector<double>> &psig79,
                         std::vector<std::vector<double>> &pnoise79);
void c_soft_decode_second(const std::vector<std::vector<double>> &psig79,
                          const std::vector<std::vector<double>> &pnoise79,
                          double ll174[]);
int check_crc(const int a91[91]);
std::vector< std::vector<std::complex<double>> > c_convert_to_snr(const std::vector< std::vector<std::complex<double>> > &m79);
double ll2p(double ll);
double p2ll(double p);
   
double set(std::string param, std::string val);

void entry(double xsamples[], int nsamples, int start, int rate,
           double min_hz,
           double max_hz,
           int hints1[],
           int hints2[],
           cb_t cb);

#endif
