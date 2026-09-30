// omnirig_core.h — everything the OmniRig helper does that is not COM.
//
// The helper is a small Windows program the desktop client runs as a child
// process: OmniRig is a COM automation server, not a socket, so neither the page
// nor Node can reach it, and a separate process keeps COM out of Electron
// entirely. It speaks JSON lines on stdout and takes one-line commands on stdin;
// see ../omnirig.js for the other end.
//
// Split from omnirig_helper.cpp so that the part with decisions in it — which
// frequency property to read and write, what counts as a change, what a command
// means — builds and is tested natively on Linux against a fake rig
// (test/core_test.cpp). What is left in the Windows file is the IDispatch
// plumbing and the process loop.
#pragma once

#include <string>

namespace omnirig {

// RigParamX and RigStatusX, as OmniRig's own type library defines them
// (OmniRig_TLB.pas, LIBID {4FE359C5-A58F-459D-BE95-CA559FB4F270}). Fixed numbers
// rather than read from the type library at run time, because the mingw build
// has no #import; they have not changed since OmniRig 1.0.
enum : long {
    PM_UNKNOWN = 0x00000001,
    PM_FREQ = 0x00000002,
    PM_FREQA = 0x00000004,
    PM_FREQB = 0x00000008,
    PM_VFOAA = 0x00000080,
    PM_VFOAB = 0x00000100,
    PM_VFOBA = 0x00000200,
    PM_VFOBB = 0x00000400,
    PM_VFOA = 0x00000800,
    PM_VFOB = 0x00001000,
    PM_RX = 0x00200000,
    PM_TX = 0x00400000,
    PM_CW_U = 0x00800000,
    PM_CW_L = 0x01000000,
    PM_SSB_U = 0x02000000,
    PM_SSB_L = 0x04000000,
    PM_DIG_U = 0x08000000,
    PM_DIG_L = 0x10000000,
    PM_AM = 0x20000000,
    PM_FM = 0x40000000,
};
enum : long {
    ST_NOTCONFIGURED = 0,
    ST_DISABLED = 1,
    ST_PORTBUSY = 2,
    ST_NOTRESPONDING = 3,
    ST_ONLINE = 4,
};

// Every mode bit, for telling a mode command from a stray number.
constexpr long MODE_MASK = PM_CW_U | PM_CW_L | PM_SSB_U | PM_SSB_L | PM_DIG_U | PM_DIG_L | PM_AM | PM_FM;

// One of OmniRig's two rigs (IRigX), reached by property name. The Windows build
// implements it over IDispatch; the tests over a map. Every call returns false
// when the call itself failed — which, OmniRig being out of process, means the
// server has gone — never for a value the rig does not have: OmniRig answers
// those with 0.
class Rig {
public:
    virtual ~Rig() = default;
    virtual bool get(const char *name, long &out) = 0;
    virtual bool getText(const char *name, std::string &out) = 0;
    virtual bool put(const char *name, long value) = 0;
};

// Which VFO to follow. Current is whichever one the rig is receiving on, and
// is the only choice that keeps up with somebody pressing A/B on the front panel.
enum class Vfo { A, B, Current };
Vfo parseVfo(const std::string &s);

struct Snapshot {
    long status = -1;
    std::string statusText;
    long freq = 0;
    long mode = 0;
    long tx = 0;
    long vfo = 0;
    long readable = 0;
    long writeable = 0;
    bool operator==(const Snapshot &o) const;
    bool operator!=(const Snapshot &o) const { return !(*this == o); }
};

class Session {
public:
    Session(Rig &rig, Vfo vfo) : rig_(rig), vfo_(vfo) {}

    // Reads the rig. False if a read failed outright (the server is gone);
    // otherwise `line` is a state line when anything differs from the last one
    // reported, and empty when nothing does.
    bool poll(std::string &line);

    // One line from stdin. Returns a line to report, usually empty. `quit` is
    // set for a quit command; a failed write is reported, not fatal, because
    // the next poll finds out whether the server is really gone.
    std::string command(const std::string &line, bool &quit);

    // Which property a frequency is read from or written to, given what the rig
    // can do (ReadableParams or WriteableParams) and which VFO it is on. Null
    // when it has none. Public for the tests.
    const char *frequencyProperty(long params, long vfo) const;

private:
    Rig &rig_;
    Vfo vfo_;
    Snapshot last_;
    bool reported_ = false;
};

std::string stateLine(const Snapshot &s);
std::string readyLine(long interfaceVersion, long softwareVersion, int rigNumber);
// `code` is what the desktop client words its message from (see omnirig.js);
// `message` is the detail, for anything it has no wording for.
std::string errorLine(const std::string &code, const std::string &message);
std::string warnLine(const std::string &message);
std::string jsonString(const std::string &s);

}  // namespace omnirig
