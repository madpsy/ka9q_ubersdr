// core_test.cpp — the helper's decisions, against a fake rig, natively.
//
//   g++ -std=c++17 -I.. core_test.cpp ../omnirig_core.cpp -o core_test && ./core_test
//
// run.sh beside this does exactly that. What it cannot reach is the IDispatch
// layer in omnirig_helper.cpp; wine_test.sh covers that half.
#include "omnirig_core.h"

#include <cstdio>
#include <map>
#include <string>
#include <vector>

using namespace omnirig;

namespace {

int failures = 0;
int passes = 0;

#define CHECK(cond)                                                                   \
    do {                                                                              \
        if (!(cond)) {                                                                \
            std::printf("      %s:%d: %s\n", __FILE__, __LINE__, #cond);              \
            ok = false;                                                               \
        }                                                                             \
    } while (0)

struct Test {
    const char *name;
    bool (*fn)();
};
std::vector<Test> &tests() {
    static std::vector<Test> t;
    return t;
}
struct Register {
    Register(const char *name, bool (*fn)()) { tests().push_back({name, fn}); }
};
#define TEST(name)                                  \
    static bool name();                             \
    static Register reg_##name(#name, name);        \
    static bool name()

// An IRigX as a map of properties. `dead` makes every call fail, as an
// out-of-process server that has exited does.
class FakeRig : public Rig {
public:
    std::map<std::string, long> props;
    std::string statusText = "On-line";
    std::vector<std::pair<std::string, long>> writes;
    bool dead = false;
    int reads = 0;

    FakeRig() {
        props["Status"] = ST_ONLINE;
        props["ReadableParams"] = PM_FREQ | PM_FREQA | PM_FREQB | PM_RX | PM_TX | MODE_MASK;
        props["WriteableParams"] = PM_FREQ | PM_FREQA | PM_FREQB | MODE_MASK;
        props["Vfo"] = PM_VFOAA;
        props["Freq"] = 14074000;
        props["FreqA"] = 14074000;
        props["FreqB"] = 7074000;
        props["Mode"] = PM_SSB_U;
        props["Tx"] = PM_RX;
    }
    bool get(const char *name, long &out) override {
        if (dead) return false;
        reads++;
        auto it = props.find(name);
        out = it == props.end() ? 0 : it->second;
        return true;
    }
    bool getText(const char *, std::string &out) override {
        if (dead) return false;
        out = statusText;
        return true;
    }
    bool put(const char *name, long value) override {
        if (dead) return false;
        writes.emplace_back(name, value);
        props[name] = value;
        return true;
    }
};

bool contains(const std::string &s, const std::string &part) { return s.find(part) != std::string::npos; }

}  // namespace

// --- reading -----------------------------------------------------------------

TEST(first_poll_reports_the_whole_state) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    std::string line;
    CHECK(s.poll(line));
    CHECK(line == "{\"type\":\"state\",\"status\":4,\"statusText\":\"On-line\",\"freq\":14074000,"
                  "\"mode\":33554432,\"tx\":2097152,\"vfo\":128,\"readable\":2145386510,\"writeable\":2139095054}");
    return ok;
}

TEST(an_unchanged_rig_reports_nothing) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    std::string line;
    s.poll(line);
    CHECK(s.poll(line));
    CHECK(line.empty());
    return ok;
}

TEST(any_change_is_reported) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    std::string line;
    s.poll(line);
    rig.props["Freq"] = 14075000;
    s.poll(line);
    CHECK(contains(line, "\"freq\":14075000"));
    rig.props["Tx"] = PM_TX;
    s.poll(line);
    CHECK(contains(line, "\"tx\":4194304"));
    rig.props["Mode"] = PM_CW_U;
    s.poll(line);
    CHECK(contains(line, "\"mode\":8388608"));
    return ok;
}

TEST(offline_reports_status_but_not_stale_values) {
    bool ok = true;
    FakeRig rig;
    rig.props["Status"] = ST_NOTRESPONDING;
    rig.statusText = "Rig is not responding";
    Session s(rig, Vfo::Current);
    std::string line;
    CHECK(s.poll(line));
    CHECK(contains(line, "\"status\":3"));
    CHECK(contains(line, "\"statusText\":\"Rig is not responding\""));
    CHECK(contains(line, "\"freq\":0"));
    CHECK(contains(line, "\"mode\":0"));
    // Status alone of the numeric properties; StatusStr is text.
    CHECK(rig.reads == 1);
    return ok;
}

TEST(coming_online_is_a_change) {
    bool ok = true;
    FakeRig rig;
    rig.props["Status"] = ST_PORTBUSY;
    Session s(rig, Vfo::Current);
    std::string line;
    s.poll(line);
    rig.props["Status"] = ST_ONLINE;
    s.poll(line);
    CHECK(contains(line, "\"status\":4"));
    CHECK(contains(line, "\"freq\":14074000"));
    return ok;
}

TEST(a_dead_server_fails_the_poll) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    std::string line;
    s.poll(line);
    rig.dead = true;
    CHECK(!s.poll(line));
    return ok;
}

// --- which frequency ---------------------------------------------------------

TEST(vfo_a_reads_freqa) {
    bool ok = true;
    FakeRig rig;
    rig.props["Freq"] = 1;
    Session s(rig, Vfo::A);
    std::string line;
    s.poll(line);
    CHECK(contains(line, "\"freq\":14074000"));
    return ok;
}

TEST(vfo_b_reads_freqb_even_while_receiving_on_a) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::B);
    std::string line;
    s.poll(line);
    CHECK(contains(line, "\"freq\":7074000"));
    return ok;
}

TEST(named_vfo_falls_back_to_freq) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::B);
    CHECK(std::string(s.frequencyProperty(PM_FREQ | PM_FREQA, PM_VFOA)) == "Freq");
    CHECK(s.frequencyProperty(PM_FREQA, PM_VFOA) == nullptr);
    return ok;
}

TEST(current_prefers_freq) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    CHECK(std::string(s.frequencyProperty(PM_FREQ | PM_FREQA | PM_FREQB, PM_VFOBB)) == "Freq");
    return ok;
}

TEST(current_without_freq_follows_the_receive_vfo) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    long both = PM_FREQA | PM_FREQB;
    CHECK(std::string(s.frequencyProperty(both, PM_VFOA)) == "FreqA");
    CHECK(std::string(s.frequencyProperty(both, PM_VFOAB)) == "FreqA");
    CHECK(std::string(s.frequencyProperty(both, PM_VFOB)) == "FreqB");
    CHECK(std::string(s.frequencyProperty(both, PM_VFOBA)) == "FreqB");
    CHECK(std::string(s.frequencyProperty(both, PM_VFOBB)) == "FreqB");
    // A rig that does not report its VFO is taken to be on A.
    CHECK(std::string(s.frequencyProperty(both, 0)) == "FreqA");
    return ok;
}

TEST(a_rig_with_no_readable_frequency_reports_zero) {
    bool ok = true;
    FakeRig rig;
    rig.props["ReadableParams"] = PM_RX | PM_TX | MODE_MASK;
    Session s(rig, Vfo::Current);
    std::string line;
    CHECK(s.poll(line));
    CHECK(contains(line, "\"freq\":0"));
    return ok;
}

TEST(parse_vfo) {
    bool ok = true;
    CHECK(parseVfo("A") == Vfo::A);
    CHECK(parseVfo("b") == Vfo::B);
    CHECK(parseVfo("") == Vfo::Current);
    CHECK(parseVfo("-") == Vfo::Current);
    return ok;
}

// --- commands ----------------------------------------------------------------

TEST(freq_writes_the_chosen_vfo) {
    bool ok = true;
    FakeRig rig;
    Session a(rig, Vfo::A);
    bool quit = false;
    CHECK(a.command("freq 7100000", quit).empty());
    Session b(rig, Vfo::B);
    CHECK(b.command("freq 3573000\r\n", quit).empty());
    Session cur(rig, Vfo::Current);
    CHECK(cur.command("freq 21074000", quit).empty());
    CHECK(rig.writes.size() == 3);
    CHECK(rig.writes[0] == std::make_pair(std::string("FreqA"), 7100000L));
    CHECK(rig.writes[1] == std::make_pair(std::string("FreqB"), 3573000L));
    CHECK(rig.writes[2] == std::make_pair(std::string("Freq"), 21074000L));
    CHECK(!quit);
    return ok;
}

TEST(freq_on_a_rig_that_cannot_set_it_is_refused) {
    bool ok = true;
    FakeRig rig;
    rig.props["WriteableParams"] = MODE_MASK;
    Session s(rig, Vfo::Current);
    bool quit = false;
    std::string r = s.command("freq 7100000", quit);
    CHECK(contains(r, "\"type\":\"warn\""));
    CHECK(rig.writes.empty());
    return ok;
}

TEST(bad_frequencies_are_refused) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    bool quit = false;
    for (const char *bad : {"freq", "freq ", "freq abc", "freq 7100000x", "freq -5", "freq 0",
                            "freq 99999999999", "freq 7.1e6"}) {
        std::string r = s.command(bad, quit);
        if (!contains(r, "\"type\":\"warn\"")) {
            std::printf("      accepted: %s\n", bad);
            ok = false;
        }
    }
    CHECK(rig.writes.empty());
    return ok;
}

TEST(mode_writes_one_mode_bit) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    bool quit = false;
    CHECK(s.command("mode 16777216", quit).empty());  // PM_CW_L
    CHECK(rig.writes.size() == 1);
    CHECK(rig.writes[0] == std::make_pair(std::string("Mode"), static_cast<long>(PM_CW_L)));
    return ok;
}

TEST(mode_refuses_what_is_not_a_mode) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    bool quit = false;
    // Two modes at once, a non-mode parameter (PM_TX), nothing, and junk.
    for (long bad : {static_cast<long>(PM_SSB_U | PM_SSB_L), static_cast<long>(PM_TX), 0L}) {
        std::string r = s.command("mode " + std::to_string(bad), quit);
        CHECK(contains(r, "\"type\":\"warn\""));
    }
    CHECK(contains(s.command("mode usb", quit), "\"type\":\"warn\""));
    CHECK(rig.writes.empty());
    return ok;
}

TEST(mode_the_rig_cannot_set_is_left_alone) {
    bool ok = true;
    FakeRig rig;
    rig.props["WriteableParams"] = PM_FREQ | PM_SSB_U | PM_SSB_L;
    Session s(rig, Vfo::Current);
    bool quit = false;
    CHECK(contains(s.command("mode " + std::to_string(PM_AM), quit), "\"type\":\"warn\""));
    CHECK(s.command("mode " + std::to_string(PM_SSB_L), quit).empty());
    CHECK(rig.writes.size() == 1);
    return ok;
}

TEST(quit_and_unknown_and_blank) {
    bool ok = true;
    FakeRig rig;
    Session s(rig, Vfo::Current);
    bool quit = false;
    CHECK(s.command("", quit).empty());
    CHECK(s.command("\r\n", quit).empty());
    CHECK(!quit);
    CHECK(contains(s.command("ptt 1", quit), "unknown command"));
    CHECK(s.command("quit\r\n", quit).empty());
    CHECK(quit);
    return ok;
}

TEST(a_write_to_a_dead_server_is_a_warning) {
    bool ok = true;
    FakeRig rig;
    rig.dead = true;
    Session s(rig, Vfo::Current);
    bool quit = false;
    CHECK(contains(s.command("freq 7100000", quit), "\"type\":\"warn\""));
    CHECK(contains(s.command("mode 33554432", quit), "\"type\":\"warn\""));
    return ok;
}

// --- the wire ----------------------------------------------------------------

TEST(json_strings_are_escaped) {
    bool ok = true;
    CHECK(jsonString("a\"b\\c\nd\x01") == "\"a\\\"b\\\\c\\nd\\u0001\"");
    CHECK(errorLine("gone", "x\"y") == "{\"type\":\"error\",\"code\":\"gone\",\"message\":\"x\\\"y\"}");
    // UTF-8 passes through as it is.
    CHECK(jsonString("\xc3\xa9") == "\"\xc3\xa9\"");
    return ok;
}

TEST(ready_line) {
    bool ok = true;
    CHECK(readyLine(0x101, 0x10014, 2) ==
          "{\"type\":\"ready\",\"rig\":2,\"interfaceVersion\":257,\"softwareVersion\":65556}");
    return ok;
}

int main() {
    for (auto &t : tests()) {
        if (t.fn()) {
            std::printf("ok    %s\n", t.name);
            passes++;
        } else {
            std::printf("FAIL  %s\n", t.name);
            failures++;
        }
    }
    std::printf("%d passed, %d failed\n", passes, failures);
    return failures ? 1 : 0;
}
