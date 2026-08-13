import Foundation
import Security

/// The per-receiver bypass password, in the Keychain.
///
/// The iOS half of `Secrets.java`, and the same arrangement rather than a
/// looser one: the JavaScript half of this app has no call that returns a
/// password. It can set one, clear one, and ask whether one is set. The
/// receiver's WebView reads it directly when it opens a page, so a value the
/// chooser must not hold never travels through it.
///
/// Android seals the string with a key in the platform keystore; here the
/// Keychain *is* that, so there is no sealing to do — the item is stored with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, which means it survives a
/// reboot into a background launch but is never carried to another device by a
/// backup or by iCloud Keychain. A receiver password restored onto somebody
/// else's phone is not a feature.
enum Secrets {

    private static let service = "org.ubersdr.mobile.secrets"

    private static func query(_ id: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id
        ]
    }

    static func has(_ id: String) -> Bool {
        var q = query(id)
        q[kSecReturnData as String] = false
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
    }

    /// Deliberately not reachable from JavaScript. `ReceiverWebView` calls it
    /// directly to seed the page's sessionStorage — see the plugin's method
    /// list, which has no `secretGet`.
    static func get(_ id: String) -> String? {
        var q = query(id)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func set(_ id: String, _ value: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        // Delete-then-add rather than SecItemUpdate: the update path needs a
        // different query shape and this one cannot half-succeed.
        SecItemDelete(query(id) as CFDictionary)

        var q = query(id)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    static func clear(_ id: String) -> Bool {
        let status = SecItemDelete(query(id) as CFDictionary)
        // Nothing there is the outcome that was asked for.
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
