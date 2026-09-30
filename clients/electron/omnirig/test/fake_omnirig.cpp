// fake_omnirig.cpp — a stand-in for OmniRig, for wine_test.sh.
//
// An in-process COM server that wine_test.sh registers under OmniRig's own
// ProgID (OmniRig.OmniRigX) in a throwaway wine prefix, so the real helper,
// unchanged, finds it where it would find OmniRig. It answers through IDispatch
// only — the one interface the helper uses — with the same property names and
// RigParamX values, and it is strict where OmniRig is: a property put must name
// its argument DISPID_PROPERTYPUT, and a write the rig cannot take is refused.
//
// Rig1 is on line on 14.074 MHz USB, VFO A; Rig2 is not configured. Writes stick,
// so the test sees its own commands come back in the next poll.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>

#include <cwchar>

#include "../omnirig_core.h"

using namespace omnirig;

namespace {

// Not OmniRig's CLSID: the ProgID is what the helper looks up, and pointing it
// here in a throwaway prefix is enough. {6A1C2E3D-8F0B-4C57-9E21-3B7D5A40F1C8}
const CLSID CLSID_FakeOmniRig = {0x6a1c2e3d, 0x8f0b, 0x4c57, {0x9e, 0x21, 0x3b, 0x7d, 0x5a, 0x40, 0xf1, 0xc8}};

LONG g_objects = 0;

// IDispatch over a fixed table of names. Every object here is static and the DLL
// never unloads, so the reference counts are nominal.
class Dispatchable : public IDispatch {
public:
    virtual ~Dispatchable() = default;

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
        if (riid == IID_IUnknown || riid == IID_IDispatch) {
            *out = static_cast<IDispatch *>(this);
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&g_objects); }
    ULONG STDMETHODCALLTYPE Release() override { return InterlockedDecrement(&g_objects); }
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT *n) override {
        *n = 0;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT, LCID, ITypeInfo **) override { return E_NOTIMPL; }

    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID, LPOLESTR *names, UINT count, LCID, DISPID *ids) override {
        HRESULT hr = S_OK;
        for (UINT i = 0; i < count; i++) {
            ids[i] = DISPID_UNKNOWN;
            if (i == 0) {
                for (int k = 0; names_()[k]; k++) {
                    if (_wcsicmp(names[0], names_()[k]) == 0) ids[0] = k + 1;
                }
            }
            if (ids[i] == DISPID_UNKNOWN) hr = DISP_E_UNKNOWNNAME;
        }
        return hr;
    }

    HRESULT STDMETHODCALLTYPE Invoke(DISPID id, REFIID, LCID, WORD flags, DISPPARAMS *params, VARIANT *result,
                                     EXCEPINFO *, UINT *) override {
        if (id < 1) return DISP_E_MEMBERNOTFOUND;
        const wchar_t *name = names_()[id - 1];
        if (flags & DISPATCH_PROPERTYPUT) {
            if (!params || params->cArgs != 1 || params->cNamedArgs != 1 ||
                params->rgdispidNamedArgs[0] != DISPID_PROPERTYPUT) {
                return DISP_E_PARAMNOTFOUND;
            }
            VARIANT v;
            VariantInit(&v);
            HRESULT hr = VariantChangeType(&v, &params->rgvarg[0], 0, VT_I4);
            if (FAILED(hr)) return DISP_E_TYPEMISMATCH;
            return put(name, v.lVal);
        }
        if (!(flags & DISPATCH_PROPERTYGET) || !result) return DISP_E_MEMBERNOTFOUND;
        VariantInit(result);
        return get(name, *result);
    }

protected:
    virtual const wchar_t *const *names_() const = 0;
    virtual HRESULT get(const wchar_t *name, VARIANT &out) = 0;
    virtual HRESULT put(const wchar_t *name, long value) = 0;

    static HRESULT longValue(VARIANT &out, long v) {
        out.vt = VT_I4;
        out.lVal = v;
        return S_OK;
    }
};

class FakeRigX : public Dispatchable {
public:
    long status, readable, writeable, vfo = PM_VFOAA, freqA = 14074000, freqB = 7074000, mode = PM_SSB_U,
                                      tx = PM_RX;
    const wchar_t *statusText;

    FakeRigX(long st, const wchar_t *text) : status(st), statusText(text) {
        readable = PM_FREQ | PM_FREQA | PM_FREQB | PM_VFOAA | PM_VFOBB | PM_RX | PM_TX | MODE_MASK;
        // No AM or FM to write, so the test can see a refusal.
        writeable = PM_FREQ | PM_FREQA | PM_FREQB | (MODE_MASK & ~(PM_AM | PM_FM));
    }

protected:
    const wchar_t *const *names_() const override {
        static const wchar_t *const n[] = {L"Status", L"StatusStr", L"ReadableParams", L"WriteableParams",
                                           L"Vfo",    L"Freq",      L"FreqA",          L"FreqB",
                                           L"Mode",   L"Tx",        nullptr};
        return n;
    }

    bool onB() const { return vfo == PM_VFOB || vfo == PM_VFOBA || vfo == PM_VFOBB; }

    HRESULT get(const wchar_t *n, VARIANT &out) override {
        if (!wcscmp(n, L"StatusStr")) {
            out.vt = VT_BSTR;
            out.bstrVal = SysAllocString(statusText);
            return S_OK;
        }
        if (!wcscmp(n, L"Status")) return longValue(out, status);
        if (!wcscmp(n, L"ReadableParams")) return longValue(out, readable);
        if (!wcscmp(n, L"WriteableParams")) return longValue(out, writeable);
        if (!wcscmp(n, L"Vfo")) return longValue(out, vfo);
        if (!wcscmp(n, L"Freq")) return longValue(out, onB() ? freqB : freqA);
        if (!wcscmp(n, L"FreqA")) return longValue(out, freqA);
        if (!wcscmp(n, L"FreqB")) return longValue(out, freqB);
        if (!wcscmp(n, L"Mode")) return longValue(out, mode);
        if (!wcscmp(n, L"Tx")) return longValue(out, tx);
        return DISP_E_MEMBERNOTFOUND;
    }

    HRESULT put(const wchar_t *n, long v) override {
        if (!wcscmp(n, L"Freq") && (writeable & PM_FREQ)) {
            (onB() ? freqB : freqA) = v;
            return S_OK;
        }
        if (!wcscmp(n, L"FreqA") && (writeable & PM_FREQA)) {
            freqA = v;
            return S_OK;
        }
        if (!wcscmp(n, L"FreqB") && (writeable & PM_FREQB)) {
            freqB = v;
            return S_OK;
        }
        if (!wcscmp(n, L"Mode") && (writeable & v)) {
            mode = v;
            return S_OK;
        }
        return DISP_E_EXCEPTION;
    }
};

class FakeOmniRigX : public Dispatchable {
public:
    FakeRigX rig1{ST_ONLINE, L"On-line"};
    FakeRigX rig2{ST_NOTCONFIGURED, L"Rig is not configured"};

protected:
    const wchar_t *const *names_() const override {
        static const wchar_t *const n[] = {L"InterfaceVersion", L"SoftwareVersion", L"Rig1", L"Rig2", nullptr};
        return n;
    }
    HRESULT get(const wchar_t *n, VARIANT &out) override {
        if (!wcscmp(n, L"InterfaceVersion")) return longValue(out, 0x101);
        if (!wcscmp(n, L"SoftwareVersion")) return longValue(out, 0x10014);
        if (!wcscmp(n, L"Rig1") || !wcscmp(n, L"Rig2")) {
            IDispatch *d = !wcscmp(n, L"Rig1") ? static_cast<IDispatch *>(&rig1) : &rig2;
            d->AddRef();
            out.vt = VT_DISPATCH;
            out.pdispVal = d;
            return S_OK;
        }
        return DISP_E_MEMBERNOTFOUND;
    }
    HRESULT put(const wchar_t *, long) override { return DISP_E_MEMBERNOTFOUND; }
};

FakeOmniRigX g_omnirig;

class Factory : public IClassFactory {
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *out = static_cast<IClassFactory *>(this);
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&g_objects); }
    ULONG STDMETHODCALLTYPE Release() override { return InterlockedDecrement(&g_objects); }
    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown *outer, REFIID riid, void **out) override {
        if (outer) return CLASS_E_NOAGGREGATION;
        return g_omnirig.QueryInterface(riid, out);
    }
    HRESULT STDMETHODCALLTYPE LockServer(BOOL) override { return S_OK; }
};

Factory g_factory;

}  // namespace

extern "C" __declspec(dllexport) HRESULT STDAPICALLTYPE DllGetClassObject(REFCLSID clsid, REFIID riid, void **out) {
    if (clsid != CLSID_FakeOmniRig) return CLASS_E_CLASSNOTAVAILABLE;
    return g_factory.QueryInterface(riid, out);
}

extern "C" __declspec(dllexport) HRESULT STDAPICALLTYPE DllCanUnloadNow() { return S_FALSE; }
