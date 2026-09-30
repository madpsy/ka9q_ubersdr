// Which certificates to trust, per platform.
//
// Windows and macOS keep their trust stores behind an API rather than in files,
// and both can have roots that only the API knows about: Windows fetches roots
// on demand the first time a chain needs one, and a Mac user can mark a
// certificate trusted in Keychain Access. So on those two the chain the server
// sent is handed to the OS, which says yes or no for this host name exactly as
// it would for a browser.
//
// Linux has no such API, only a CA bundle whose path varies by distribution, so
// mbedTLS verifies against whichever bundle is found.
#include "tls_conn.h"

#include <mbedtls/x509_crt.h>

#include <cstdlib>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#include <wincrypt.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#else
#include <sys/stat.h>
#endif

namespace ubersdr {
#if defined(_WIN32)

    bool systemTrustIsNative() { return true; }
    int loadSystemCAs(void*) { return 0; }

    std::string verifyWithSystemTrust(const std::string& host, const DerCert* chain, size_t count) {
        HCERTSTORE store = CertOpenStore(CERT_STORE_PROV_MEMORY, 0, 0, CERT_STORE_CREATE_NEW_FLAG, NULL);
        if (!store) { return "cannot open a certificate store"; }

        PCCERT_CONTEXT leaf = NULL;
        for (size_t i = 0; i < count; i++) {
            PCCERT_CONTEXT ctx = NULL;
            if (!CertAddEncodedCertificateToStore(store, X509_ASN_ENCODING, chain[i].data, (DWORD)chain[i].len,
                                                  CERT_STORE_ADD_ALWAYS, i == 0 ? &leaf : NULL)) {
                if (i == 0) {
                    CertCloseStore(store, 0);
                    return "server certificate could not be parsed";
                }
            }
            (void)ctx;
        }

        LPSTR usage[] = { (LPSTR)szOID_PKIX_KP_SERVER_AUTH };
        CERT_CHAIN_PARA para = {};
        para.cbSize = sizeof(para);
        para.RequestedUsage.dwType = USAGE_MATCH_TYPE_AND;
        para.RequestedUsage.Usage.cUsageIdentifier = 1;
        para.RequestedUsage.Usage.rgpszUsageIdentifier = usage;

        PCCERT_CHAIN_CONTEXT chainCtx = NULL;
        std::string why;
        if (!CertGetCertificateChain(NULL, leaf, NULL, store, &para, 0, NULL, &chainCtx)) {
            why = "the certificate chain could not be built";
        }
        else {
            std::wstring whost(host.begin(), host.end());
            SSL_EXTRA_CERT_CHAIN_POLICY_PARA ssl = {};
            ssl.cbSize = sizeof(ssl);
            ssl.dwAuthType = AUTHTYPE_SERVER;
            ssl.pwszServerName = (wchar_t*)whost.c_str();
            CERT_CHAIN_POLICY_PARA policy = {};
            policy.cbSize = sizeof(policy);
            policy.pvExtraPolicyPara = &ssl;
            CERT_CHAIN_POLICY_STATUS status = {};
            status.cbSize = sizeof(status);
            if (!CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_SSL, chainCtx, &policy, &status)) {
                why = "the certificate policy check could not run";
            }
            else if (status.dwError != 0) {
                switch ((HRESULT)status.dwError) {
                case CERT_E_CN_NO_MATCH: why = "issued for a different host name"; break;
                case CERT_E_EXPIRED: why = "expired or not yet valid"; break;
                case CERT_E_UNTRUSTEDROOT: why = "issued by an untrusted root"; break;
                case CERT_E_CHAINING: why = "the chain does not reach a trusted root"; break;
                case CRYPT_E_REVOKED: why = "revoked"; break;
                default: {
                    char buf[32];
                    snprintf(buf, sizeof(buf), "Windows error 0x%08lX", (unsigned long)status.dwError);
                    why = buf;
                }
                }
            }
            CertFreeCertificateChain(chainCtx);
        }
        if (leaf) { CertFreeCertificateContext(leaf); }
        CertCloseStore(store, 0);
        return why;
    }

#elif defined(__APPLE__)

    bool systemTrustIsNative() { return true; }
    int loadSystemCAs(void*) { return 0; }

    std::string verifyWithSystemTrust(const std::string& host, const DerCert* chain, size_t count) {
        CFMutableArrayRef certs = CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
        for (size_t i = 0; i < count; i++) {
            CFDataRef der = CFDataCreate(NULL, chain[i].data, (CFIndex)chain[i].len);
            SecCertificateRef cert = der ? SecCertificateCreateWithData(NULL, der) : NULL;
            if (der) { CFRelease(der); }
            if (cert) {
                CFArrayAppendValue(certs, cert);
                CFRelease(cert);
            }
            else if (i == 0) {
                CFRelease(certs);
                return "server certificate could not be parsed";
            }
        }

        CFStringRef name = CFStringCreateWithCString(NULL, host.c_str(), kCFStringEncodingUTF8);
        SecPolicyRef policy = SecPolicyCreateSSL(true, name);
        SecTrustRef trust = NULL;
        std::string why;
        if (SecTrustCreateWithCertificates(certs, policy, &trust) != errSecSuccess || !trust) {
            why = "the certificate chain could not be evaluated";
        }
        else {
            CFErrorRef err = NULL;
            if (!SecTrustEvaluateWithError(trust, &err)) {
                why = "rejected by the system trust store";
                if (err) {
                    CFStringRef desc = CFErrorCopyDescription(err);
                    char buf[512];
                    if (desc && CFStringGetCString(desc, buf, sizeof(buf), kCFStringEncodingUTF8)) { why = buf; }
                    if (desc) { CFRelease(desc); }
                    CFRelease(err);
                }
            }
            CFRelease(trust);
        }
        if (policy) { CFRelease(policy); }
        if (name) { CFRelease(name); }
        CFRelease(certs);
        return why;
    }

#else

    bool systemTrustIsNative() { return false; }

    std::string verifyWithSystemTrust(const std::string&, const DerCert*, size_t) {
        return "no system trust API on this platform";
    }

    static bool isFile(const char* p) {
        struct stat st;
        return p && *p && stat(p, &st) == 0 && S_ISREG(st.st_mode);
    }
    static bool isDir(const char* p) {
        struct stat st;
        return p && *p && stat(p, &st) == 0 && S_ISDIR(st.st_mode);
    }

    int loadSystemCAs(void* chainPtr) {
        mbedtls_x509_crt* chain = (mbedtls_x509_crt*)chainPtr;
        auto count = [&]() {
            int n = 0;
            for (const mbedtls_x509_crt* c = chain; c && c->raw.p; c = c->next) { n++; }
            return n;
        };

        // OpenSSL's variables, honoured the way OpenSSL-based tools honour them.
        const char* envFile = getenv("SSL_CERT_FILE");
        if (isFile(envFile)) { mbedtls_x509_crt_parse_file(chain, envFile); }
        const char* envDir = getenv("SSL_CERT_DIR");
        if (isDir(envDir)) { mbedtls_x509_crt_parse_path(chain, envDir); }
        if (count() > 0) { return count(); }

        static const char* bundles[] = {
            "/etc/ssl/certs/ca-certificates.crt",                // Debian, Ubuntu, Arch, Gentoo
            "/etc/pki/tls/certs/ca-bundle.crt",                  // Fedora, RHEL
            "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // Fedora, RHEL
            "/etc/ssl/ca-bundle.pem",                            // openSUSE
            "/etc/ssl/cert.pem",                                 // Alpine, BSDs
            "/usr/local/share/certs/ca-root-nss.crt",            // FreeBSD
        };
        for (const char* b : bundles) {
            if (isFile(b) && mbedtls_x509_crt_parse_file(chain, b) >= 0 && count() > 0) { return count(); }
        }

        // Android, and anything that only ships a hashed directory.
        static const char* dirs[] = {
            "/apex/com.android.conscrypt/cacerts",
            "/system/etc/security/cacerts",
            "/etc/ssl/certs",
        };
        for (const char* d : dirs) {
            if (isDir(d)) { mbedtls_x509_crt_parse_path(chain, d); }
            if (count() > 0) { return count(); }
        }
        return count();
    }

#endif
}
