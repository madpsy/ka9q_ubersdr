#
# This client's platform half on iOS, as a local pod.
#
# A pod rather than files in the App target, for one reason that matters when
# the app is developed on a machine with no Xcode: adding a .swift to a target
# means editing project.pbxproj by hand, inventing 24-hex object IDs and getting
# three cross-referenced sections right. A pod globs its sources instead — a new
# file here needs `pod install` and nothing else — so every Swift file in this
# client can be written on Linux and compiled on the Mac without either of them
# opening Xcode. See build-mac.sh.
#
# It is not published and never will be: this is the app's own native half, not
# a library. The Android side makes the same choice for the same reason — see
# android/app/src/main/java/org/ubersdr/mobile/, registered by MainActivity
# rather than installed as a package.
#
Pod::Spec.new do |s|
  s.name             = 'UberSdrPlugin'
  s.version          = '0.2.0'
  s.summary          = "UberSDR's native half on iOS"
  s.license          = { :type => 'See LICENSE.TXT' }
  s.homepage         = 'https://ubersdr.org'
  s.authors          = { 'MadPsy' => 'https://ubersdr.org' }
  s.source           = { :path => '.' }
  s.source_files     = 'sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version    = '5.0'
end
