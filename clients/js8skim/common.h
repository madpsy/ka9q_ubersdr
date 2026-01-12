
extern std::mutex dups_mu;
extern std::map<std::string, bool> dups;
extern int verbose;
 
void rx_loop(SoundIn *sin, cb_t cb);

int benchmark();
void optimize();

void call_entry(std::vector<double> samples, int nominal_start, int rate, cb_t cb);
