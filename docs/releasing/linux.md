# Linux release

ChemDraft for Linux ships as two packages, built by `.github/workflows/linux-release.yml` on a
GitHub-hosted Ubuntu 22.04 runner from the same tag as the macOS DMG and the Windows installer:

| Package | For | Install |
| --- | --- | --- |
| `ChemDraft_<version>_amd64.deb` | Ubuntu 22.04+, Linux Mint 21+, Debian 12+, Pop!_OS, elementary OS, Zorin | `sudo apt install ./ChemDraft_<version>_amd64.deb` |
| `ChemDraft_<version>_amd64.AppImage` | Other glibc-based distributions (Fedora, openSUSE, Arch, …) | `chmod +x ChemDraft_<version>_amd64.AppImage && ./ChemDraft_<version>_amd64.AppImage` |

`SHA256SUMS-linux.txt` lists both checksums.

## Why Ubuntu 22.04

A Linux binary links against the glibc and WebKitGTK of the machine it is built on and runs only on
systems with the same or newer versions. Building on the oldest supported base (22.04, glibc 2.35,
WebKitGTK 4.1) covers Linux Mint 21 and 22 and every Ubuntu LTS still in support. Move the runner
forward only when 22.04 leaves support.

## Releasing

After creating the draft release (same as for Windows):

```sh
gh workflow run linux-release.yml --ref v<version> -f ref=v<version> -f upload_to_release=v<version>
```

The workflow:

1. Checks that `ref` is a tag (or full SHA) and that `upload_to_release` is `v<app version>`.
2. Builds the OPSIN Java runtime on the runner and smoke-tests it (benzene).
3. Builds a stable `.deb` and AppImage (`CHEMDRAFT_STABLE_BUILD=1`, no worktree label).
4. Checks the bundle identity and that the `.deb` carries `chemdraft`, the 3D sidecar and the
   OPSIN runtime.
5. Installs the `.deb` on the runner and starts it on a virtual display (Xvfb + openbox). It fails
   if a library is missing, if ChemDraft exits or panics during start-up, or if no window appears.
6. Uploads the packages and checksums to the draft release, never to a published one.

The release body gets a `## Linux` section beside `## macOS` and `## Windows`.

## Updates

Linux has no in-app updater yet: the `.deb` and AppImage are updated by downloading the new
release. Options for later, in order of effort: an AppImage `.zsync` update file, a signed APT
repository on GitHub Pages, or a Flathub listing.

## Platform notes

- Webview: WebKitGTK, origin `tauri://localhost` (as on macOS).
- Menus: on the document window, as on Windows (`install_app_menu`). Edit ▸ Cut / Copy / Paste
  are routed commands (`clipboard_edit_menu_item`), not muda's predefined items: on Linux those
  only fake a key press through libxdo, which does nothing on Wayland and was unreliable on X11.
  They carry no accelerator, so Ctrl+X / C / V keep reaching the webview (and focused text fields).
- 3D: the `avogadro3d-sidecar` for Linux is still the placeholder (`binaries/README.md`), so 3D
  reports itself unavailable until a real Linux sidecar is built.
- Clipboard: `linux_clipboard.rs`, GTK's clipboard (X11 and Wayland). Targets are MIME types, so
  the editor's payload types are written unchanged; plain text is also offered as `UTF8_STRING`,
  `STRING` and `TEXT` for older X11 applications.
- Local tools (OCSR engine installer) report themselves unsupported on Linux for now.
- Building locally: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
  libayatana-appindicator3-dev libsoup-3.0-dev libssl-dev libxdo-dev patchelf`, then
  `node scripts/build-opsin-runtime.mjs` and
  `LD_LIBRARY_PATH=$PWD/apps/desktop/src-tauri/resources/opsin/jre/lib/server APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true pnpm --filter @chemdraft/desktop build --bundles deb,appimage`.
  The `LD_LIBRARY_PATH` lets linuxdeploy find `libjvm.so` for the bundled OPSIN runtime.
