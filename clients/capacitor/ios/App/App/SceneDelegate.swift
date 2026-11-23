import UIKit
import Capacitor

// The app's one window, owned by a scene rather than by the app delegate.
//
// Apps built with the iOS 27 SDK must adopt the UIScene life cycle: without a
// UIApplicationSceneManifest, UIKit traps on launch on iOS 27
// (_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). App Review
// rejected 0.7.40 for exactly that — the first build made with Xcode 27.
//
// The window itself still comes from Main.storyboard: Info.plist names it as
// the scene's UISceneStoryboardFile, so UIKit builds the window and the
// CAPBridgeViewController and hands them over before willConnectTo is called.
//
// What this class has to carry is the links. Under scenes UIKit no longer calls
// application(_:open:options:) or application(_:continue:restorationHandler:)
// on the app delegate, so ubersdr://connect links would arrive nowhere. They
// are forwarded to Capacitor's ApplicationDelegateProxy, which turns them into
// the .capacitorOpenURL notification UberSdrPlugin observes — the same path
// AppDelegate used to take.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        // A link that *launched* the app arrives here rather than through
        // openURLContexts. UberSdrPlugin only starts observing once the bridge
        // has loaded its plugins, which happens when the bridge view loads —
        // so load it first, or the notification is posted to nobody.
        guard !connectionOptions.urlContexts.isEmpty
                || !connectionOptions.userActivities.isEmpty else { return }
        window?.rootViewController?.loadViewIfNeeded()
        connectionOptions.urlContexts.forEach(open)
        connectionOptions.userActivities.forEach(continueActivity)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach(open)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    private func open(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [
            .openInPlace: context.options.openInPlace
        ]
        if let source = context.options.sourceApplication {
            options[.sourceApplication] = source
        }
        if let annotation = context.options.annotation {
            options[.annotation] = annotation
        }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared, open: context.url, options: options)
    }

    private func continueActivity(_ activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
}
