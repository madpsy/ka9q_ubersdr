import Foundation
import UIKit

/// Turning the device, without a hand to turn it with.
///
/// Store screenshots need both orientations of every screen, and a simulator
/// cannot be rotated from a script: `simctl` has no rotate command, and driving
/// the Simulator's own menu with AppleScript fails over SSH — macOS refuses
/// keystroke injection to a process that has not been granted Accessibility,
/// which a non-interactive ssh session has not and should not be.
///
/// So the app turns itself, on request, from the launch environment:
///
///     SIMCTL_CHILD_UBERSDR_ORIENTATION=landscape \
///       xcrun simctl launch booted org.ubersdr.mobile
///
/// This is the same shape as the `UBERSDR_OPEN` hook next to it in
/// UberSdrPlugin: DEBUG only, driven by the environment, and using the ordinary
/// path rather than a private one — `requestGeometryUpdate` is what any app does
/// to ask for an orientation, and what comes out is a real landscape layout
/// rather than a rotated picture of a portrait one. A release build cannot be
/// told to do this at all.
enum DebugOrientation {

    /// The orientation asked for, or nil when nothing was.
    ///
    /// Read by the view controllers' `supportedInterfaceOrientations`, which is
    /// the half that makes this work at all: `requestGeometryUpdate` is a
    /// *request*, and the system refuses one for an orientation the current
    /// view controller does not support — silently, through an error handler
    /// nobody reads. Narrowing what is supported turns the request into the
    /// only answer available, and the system then rotates on its own.
    static var wanted: UIInterfaceOrientationMask? {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["UBERSDR_ORIENTATION"]?.lowercased() {
        case "landscape": return .landscapeRight
        case "portrait":  return .portrait
        default:          return nil
        }
        #else
        return nil
        #endif
    }

    static func apply() {
        #if DEBUG
        guard let mask = wanted else { return }
        // requestGeometryUpdate is iOS 16+. Below that a screenshot run simply
        // gets the orientation the simulator was already in, which is honest
        // and is not worth a second code path — the screenshots are taken on
        // current devices.
        guard #available(iOS 16.0, *) else { return }

        // Asked for more than once. The first call can land before the scene is
        // foreground-active — which is exactly when a freshly installed app
        // shows its first screen — and a request made then is dropped. The
        // repeats cost nothing once it has taken.
        for delay in [0.0, 0.5, 1.5, 3.0, 6.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                for scene in UIApplication.shared.connectedScenes {
                    guard let windowScene = scene as? UIWindowScene else { continue }
                    windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
                    windowScene.keyWindow?.rootViewController?
                        .setNeedsUpdateOfSupportedInterfaceOrientations()
                }
            }
        }
        #endif
    }
}
