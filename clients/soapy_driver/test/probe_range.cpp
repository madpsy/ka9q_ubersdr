// Loads the built driver the way a host application does and prints the tuning range it
// advertises, as "<min> <max>" in Hz.
//
// Deliberately goes through SoapySDR::Device::make rather than testing a parser in
// isolation: getFrequencyRange() is the driver's entire contract with GQRX, CubicSDR and
// GNU Radio, and what matters is the number those hosts actually receive after the real
// libcurl fetch has run.
#include <SoapySDR/Device.hpp>
#include <SoapySDR/Logger.hpp>
#include <cstdio>
#include <string>

int main(int argc, char **argv)
{
    if (argc < 2) {
        std::fprintf(stderr, "usage: probe_range <server-url>\n");
        return 2;
    }

    // The driver logs its fallback decisions at INFO/WARNING; keep them off stdout so the
    // range is the only thing there.
    SoapySDR::setLogLevel(SOAPY_SDR_FATAL);

    SoapySDR::Kwargs args;
    args["driver"] = "ubersdr";
    args["server"] = argv[1];

    try {
        SoapySDR::Device *dev = SoapySDR::Device::make(args);
        if (dev == nullptr) {
            std::fprintf(stderr, "device was not created\n");
            return 1;
        }
        SoapySDR::RangeList ranges = dev->getFrequencyRange(SOAPY_SDR_RX, 0);
        if (ranges.size() != 1) {
            std::fprintf(stderr, "expected exactly one range, got %zu\n", ranges.size());
            SoapySDR::Device::unmake(dev);
            return 1;
        }
        std::printf("%.0f %.0f\n", ranges[0].minimum(), ranges[0].maximum());
        SoapySDR::Device::unmake(dev);
        return 0;
    } catch (const std::exception &ex) {
        std::fprintf(stderr, "exception: %s\n", ex.what());
        return 1;
    }
}
