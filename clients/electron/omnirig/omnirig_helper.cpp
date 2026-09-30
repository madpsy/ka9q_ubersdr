// omnirig_helper.cpp — OmniRig for the desktop client, as a child process.
//
//   omnirig-helper.exe <rig> [vfo]
//
//   rig   1 or 2, OmniRig's Rig1 or Rig2
//   vfo   A, B, or - (the default) for whichever one the rig is receiving on
//
// Writes JSON lines to stdout (see omnirig_core.cpp for their shapes) and reads
// commands from stdin, one per line: `freq <hz>`, `mode <RigParamX>`, `quit`.
// End of input is a quit too, so a helper whose parent has gone away does not
// outlive it.
//
// OmniRig is reached through IDispatch alone, by property name, rather than
// through its IRigX vtable. mingw has no #import to generate that interface
// from the type library, and late binding has a second advantage: IDispatch's
// proxy is built into Windows for both bitnesses, so this 64-bit process can
// talk to the 32-bit OmniRig.exe whether or not OmniRig registered its type
// library for 64-bit clients. WSJT-X reaches it the same way, through ActiveQt.
//
// Polled, not event-driven. OmniRig polls the rig itself and a property read
// returns its cached value, so reading every 100 ms costs a cross-process call
// and nothing on the serial line. The events (OnParamsChange) would save those
// calls at the price of a hand-written connection-point sink.
//
// Exit codes: 0 asked to quit, 1 bad arguments, 2 OmniRig could not be reached,
// 3 it went away.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>

#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <string>

#include "omnirig_core.h"

using namespace omnirig;

namespace {

const DWORD POLL_MS = 100;

void emit(const std::string &line) {
    if (line.empty()) return;
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

std::string hresultText(HRESULT hr) {
    char buf[16];
    std::snprintf(buf, sizeof buf, "0x%08lX", static_cast<unsigned long>(hr));
    return buf;
}

std::string narrow(const wchar_t *w, int len = -1) {
    if (!w) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, len, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return "";
    std::string out(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, len, &out[0], n, nullptr, nullptr);
    if (len == -1 && !out.empty()) out.pop_back();  // the terminator
    return out;
}

// One IDispatch, with its DISPIDs looked up once. OmniRig is out of process, so
// every GetIDsOfNames is a round trip, and the same eight names are asked for
// ten times a second.
class Dispatch {
public:
    explicit Dispatch(IDispatch *d) : d_(d) {}
    ~Dispatch() {
        if (d_) d_->Release();
    }
    Dispatch(const Dispatch &) = delete;
    Dispatch &operator=(const Dispatch &) = delete;

    HRESULT get(const char *name, VARIANT &out) {
        VariantInit(&out);
        DISPPARAMS none = {nullptr, nullptr, 0, 0};
        return invoke(name, DISPATCH_PROPERTYGET, none, &out);
    }

    HRESULT put(const char *name, long value) {
        VARIANT arg;
        VariantInit(&arg);
        arg.vt = VT_I4;
        arg.lVal = value;
        // A property put names its one argument DISPID_PROPERTYPUT. Leaving it
        // unnamed is the classic mistake, and servers answer it with
        // DISP_E_PARAMNOTFOUND rather than doing anything.
        DISPID named = DISPID_PROPERTYPUT;
        DISPPARAMS params = {&arg, &named, 1, 1};
        return invoke(name, DISPATCH_PROPERTYPUT, params, nullptr);
    }

    HRESULT getLong(const char *name, long &out) {
        VARIANT v;
        HRESULT hr = get(name, v);
        if (FAILED(hr)) return hr;
        hr = VariantChangeType(&v, &v, 0, VT_I4);
        out = SUCCEEDED(hr) ? v.lVal : 0;
        VariantClear(&v);
        return hr;
    }

    HRESULT getText(const char *name, std::string &out) {
        VARIANT v;
        HRESULT hr = get(name, v);
        if (FAILED(hr)) return hr;
        hr = VariantChangeType(&v, &v, 0, VT_BSTR);
        out = SUCCEEDED(hr) ? narrow(v.bstrVal, static_cast<int>(SysStringLen(v.bstrVal))) : "";
        VariantClear(&v);
        return hr;
    }

    // The property as an IDispatch of its own — Rig1 and Rig2.
    HRESULT getObject(const char *name, IDispatch *&out) {
        out = nullptr;
        VARIANT v;
        HRESULT hr = get(name, v);
        if (FAILED(hr)) return hr;
        if (v.vt == VT_DISPATCH && v.pdispVal) {
            out = v.pdispVal;
            out->AddRef();
        } else if (v.vt == VT_UNKNOWN && v.punkVal) {
            hr = v.punkVal->QueryInterface(IID_IDispatch, reinterpret_cast<void **>(&out));
        } else {
            hr = E_NOINTERFACE;
        }
        VariantClear(&v);
        return hr;
    }

private:
    HRESULT invoke(const char *name, WORD flags, DISPPARAMS &params, VARIANT *result) {
        DISPID id;
        HRESULT hr = lookup(name, id);
        if (FAILED(hr)) return hr;
        EXCEPINFO excep;
        std::memset(&excep, 0, sizeof excep);
        UINT argErr = 0;
        hr = d_->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, flags, &params, result, &excep, &argErr);
        if (hr == DISP_E_EXCEPTION) {
            SysFreeString(excep.bstrSource);
            SysFreeString(excep.bstrDescription);
            SysFreeString(excep.bstrHelpFile);
        }
        return hr;
    }

    HRESULT lookup(const char *name, DISPID &id) {
        auto it = ids_.find(name);
        if (it != ids_.end()) {
            id = it->second;
            return S_OK;
        }
        wchar_t wide[64];
        MultiByteToWideChar(CP_UTF8, 0, name, -1, wide, 64);
        LPOLESTR names[] = {wide};
        HRESULT hr = d_->GetIDsOfNames(IID_NULL, names, 1, LOCALE_USER_DEFAULT, &id);
        if (SUCCEEDED(hr)) ids_[name] = id;
        return hr;
    }

    IDispatch *d_;
    std::map<std::string, DISPID> ids_;
};

// omnirig::Rig over one IRigX.
class DispatchRig : public Rig {
public:
    explicit DispatchRig(IDispatch *d) : d_(d) {}
    bool get(const char *name, long &out) override { return SUCCEEDED(d_.getLong(name, out)); }
    bool getText(const char *name, std::string &out) override { return SUCCEEDED(d_.getText(name, out)); }
    bool put(const char *name, long value) override { return SUCCEEDED(d_.put(name, value)); }

private:
    Dispatch d_;
};

// stdin, read on a thread of its own so a blocking read never stalls the
// polling, and handed to the COM thread through a queue. The COM objects stay on
// the thread that created them, which is what an apartment-threaded client owes
// them.
struct Input {
    CRITICAL_SECTION lock;
    HANDLE ready = nullptr;
    std::deque<std::string> lines;
    bool eof = false;
};

// ReadFile on the handle rather than fgets on stdin: the CRT locks a stream for
// the length of a read, and exit() takes every stream's lock to flush it, so a
// process leaving while this thread sat in fgets could hang on its way out.
DWORD WINAPI readInput(void *arg) {
    Input *in = static_cast<Input *>(arg);
    HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
    std::string pending;
    char buf[512];
    DWORD got = 0;
    while (ReadFile(h, buf, sizeof buf, &got, nullptr) && got > 0) {
        pending.append(buf, got);
        size_t at;
        bool any = false;
        EnterCriticalSection(&in->lock);
        while ((at = pending.find('\n')) != std::string::npos) {
            in->lines.push_back(pending.substr(0, at));
            pending.erase(0, at + 1);
            any = true;
        }
        LeaveCriticalSection(&in->lock);
        if (any) SetEvent(in->ready);
    }
    EnterCriticalSection(&in->lock);
    in->eof = true;
    LeaveCriticalSection(&in->lock);
    SetEvent(in->ready);
    return 0;
}

int fail(int exitCode, const std::string &code, const std::string &message) {
    emit(errorLine(code, message));
    return exitCode;
}

// A failed CoCreateInstance, as a code the client has words for.
int startFailure(HRESULT hr) {
    if (hr == REGDB_E_CLASSNOTREG || hr == CO_E_CLASSSTRING)
        return fail(2, "not-installed", "OmniRig.OmniRigX is not registered");
    if (hr == CO_E_SERVER_EXEC_FAILURE) return fail(2, "no-start", "OmniRig would not start");
    // OmniRig running elevated and this not, or the other way round: COM will
    // not connect across integrity levels.
    if (hr == E_ACCESSDENIED) return fail(2, "access-denied", "access denied");
    return fail(2, "start-failed", "CoCreateInstance " + hresultText(hr));
}

int run(int rigNumber, Vfo vfo) {
    CLSID clsid;
    HRESULT hr = CLSIDFromProgID(L"OmniRig.OmniRigX", &clsid);
    if (FAILED(hr)) return startFailure(hr);

    // CLSCTX_LOCAL_SERVER is how OmniRig is registered; INPROC as well so the
    // wine test's stand-in DLL can take its place. A real install has no
    // in-process server to find.
    IDispatch *omniDisp = nullptr;
    hr = CoCreateInstance(clsid, nullptr, CLSCTX_LOCAL_SERVER | CLSCTX_INPROC_SERVER, IID_IDispatch,
                          reinterpret_cast<void **>(&omniDisp));
    if (FAILED(hr)) return startFailure(hr);
    Dispatch omni(omniDisp);

    long iface = 0, software = 0;
    omni.getLong("InterfaceVersion", iface);
    omni.getLong("SoftwareVersion", software);

    IDispatch *rigDisp = nullptr;
    hr = omni.getObject(rigNumber == 2 ? "Rig2" : "Rig1", rigDisp);
    if (FAILED(hr)) return fail(2, "no-rig", "Rig" + std::to_string(rigNumber) + " " + hresultText(hr));
    DispatchRig rig(rigDisp);
    Session session(rig, vfo);

    emit(readyLine(iface, software, rigNumber));

    Input in;
    InitializeCriticalSection(&in.lock);
    in.ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HANDLE reader = CreateThread(nullptr, 0, readInput, &in, 0, nullptr);
    if (!reader) return fail(2, "internal", "could not start the input thread");
    CloseHandle(reader);

    int code = 0;
    for (;;) {
        std::deque<std::string> lines;
        bool eof;
        EnterCriticalSection(&in.lock);
        lines.swap(in.lines);
        eof = in.eof;
        LeaveCriticalSection(&in.lock);

        bool quit = false;
        for (const auto &line : lines) {
            emit(session.command(line, quit));
            if (quit) break;
        }
        if (quit || eof) break;

        std::string state;
        if (!session.poll(state)) {
            code = fail(3, "gone", "OmniRig stopped answering");
            break;
        }
        emit(state);

        // Wakes for a command or for the next poll, and pumps whatever COM has
        // posted to this apartment meanwhile.
        MsgWaitForMultipleObjects(1, &in.ready, FALSE, POLL_MS, QS_ALLINPUT);
        MSG msg;
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    // The reader thread is left blocked in ReadFile; the process exiting ends it.
    return code;
}

}  // namespace

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3 || (std::strcmp(argv[1], "1") != 0 && std::strcmp(argv[1], "2") != 0)) {
        emit(errorLine("usage", "usage: omnirig-helper <1|2> [A|B|-]"));
        return 1;
    }
    int rigNumber = argv[1][0] - '0';
    Vfo vfo = parseVfo(argc == 3 ? argv[2] : "-");

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) return fail(2, "internal", "CoInitializeEx " + hresultText(hr));
    int code = run(rigNumber, vfo);
    CoUninitialize();
    return code;
}
