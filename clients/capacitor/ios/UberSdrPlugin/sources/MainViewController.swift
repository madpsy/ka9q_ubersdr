import Foundation
import Capacitor

/// The chooser's screen, and the one place this client's plugin is registered.
///
/// Capacitor 7 does not find plugins by scanning the runtime. `registerPlugins`
/// reads a `packageClassList` out of the bundled capacitor.config.json, and the
/// CLI builds that list from *npm packages* that declare a plugin — which this
/// one deliberately is not. A plugin that is the app's own native half, living
/// in a local pod, is therefore invisible to it: the bridge comes up, the page
/// loads, and every call answers "plugin is not implemented on ios".
///
/// `capacitorDidLoad` is the documented hook for exactly this case. Registering
/// here rather than adding the class name to the generated config also survives
/// `cap sync`, which rewrites that file from the installed packages every time.
///
/// This lives in the pod rather than in the App target for the same reason the
/// rest of the Swift does: a file in the target means editing project.pbxproj
/// by hand, and the point of the pod is that this client can be written on a
/// machine with no Xcode. Main.storyboard names the class and the module, which
/// is a two-attribute edit to XML rather than three sections of pbxproj.
public class MainViewController: CAPBridgeViewController {

    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        DebugOrientation.apply()
    }

    /// Narrowed only during a screenshot pass — see DebugOrientation. Normally
    /// this is whatever Capacitor's own controller allows, which is everything.
    public override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        DebugOrientation.wanted ?? super.supportedInterfaceOrientations
    }

    public override func capacitorDidLoad() {
        // registerPluginInstance, not registerPluginType. The type-taking call
        // begins `if autoRegisterPlugins { return }` — so with auto-registration
        // on, which is the default and what registers Preferences, it does
        // nothing at all and does not say so. The plugin then appears to load
        // and every call answers "not implemented on ios".
        //
        // Turning auto-registration off to make it work would mean registering
        // every npm plugin here by hand as well. The instance call has no such
        // guard and composes with the generated list instead of replacing it.
        bridge?.registerPluginInstance(UberSdrPlugin())
    }
}
