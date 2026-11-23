// Sources are repository-relative; targets are relative to Tauri's resource directory.
// Keep release checks and fixtures driven by this list when adding bundled licences.
export const requiredLicenseFiles = [
  { source: "NOTICE", target: "licenses/NOTICE" },
  { source: "LICENSE", target: "licenses/LICENSE" },
  { source: "packages/export-engine/src/fonts/LICENSE_NOTO.txt", target: "licenses/LICENSE_NOTO.txt" },
  { source: "packages/export-engine/src/fonts/LICENSE_DEJAVU.txt", target: "licenses/LICENSE_DEJAVU.txt" },
  { source: "packages/export-engine/src/fonts/LICENSE_PATRICK_HAND.txt", target: "licenses/LICENSE_PATRICK_HAND.txt" },
  // Statically linked into the avogadro3d-sidecar shipped on macOS and Windows (NOTICE); bundled on every platform.
  { source: "native/avogadro3d-sidecar/licenses/avogadrolibs-LICENSE.txt", target: "licenses/avogadrolibs-LICENSE.txt" },
  { source: "native/avogadro3d-sidecar/licenses/Eigen-COPYING.MPL2.txt", target: "licenses/Eigen-COPYING.MPL2.txt" },
  { source: "native/avogadro3d-sidecar/licenses/cppoptlib-LICENSE.txt", target: "licenses/cppoptlib-LICENSE.txt" }
];
