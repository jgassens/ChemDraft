# Image acquisition architecture

Plugin image access is host-owned and command-scoped. API 0.1.5 exposes
`context.images.requestImage`; `plugin-host` requires `image.read`, verifies the owning command's
invocation token, validates the strict request/result schemas, and enforces 25 MB and 8192-pixel-per-side
limits. `Uint8Array` is the plugin and worker wire representation. The native Tauri command internally
serializes Rust `Vec<u8>` as a number array; the screen provider immediately converts that one IPC value
back to `Uint8Array` before it crosses the plugin boundary.

## Provider registry

`apps/desktop/src/plugins/ImageSourceProvider.ts` defines:

```ts
interface ImageSourceProvider {
  id: "file" | "screenRegion";
  label: string;
  isAvailable(): Promise<boolean>;
  acquire(signal: AbortSignal): Promise<ProvidedImage | "cancelled">;
}
```

`ImageSourceRegistry` is the only source list. The host-owned dialog receives the available registry
entries and maps them to buttons; it has no source-specific branch. The file provider uses Tauri's
cross-platform open dialog and filesystem read APIs for PNG/JPEG/TIFF/WebP. The screen provider calls
the two narrow native commands. Adding a future clipboard provider means implementing the interface,
registering it, and extending the public source enum when that API is intentionally released—not
editing the dialog.

## Native region capture and adding a platform

`apps/desktop/src-tauri/src/screen_capture.rs` owns the `RegionCapture` trait. The Tauri commands and
temporary-file cleanup call only that trait. The macOS implementation invokes the system
`/usr/sbin/screencapture -i -x -t png` marquee and uses
`CGPreflightScreenCaptureAccess` to distinguish Screen Recording denial from Escape cancellation.
ChemDraft's visible, non-minimized webview windows are hidden for the interactive capture and restored
on every outcome. Temporary PNGs live in the app-resolved temp directory and are deleted by a drop
guard.

To add Windows support, implement `WindowsRegionCapture` with `Windows.Graphics.Capture`, or launch the
Snipping Tool through `ms-screenclip:` and retrieve the confirmed clipboard image. Return
`CaptureOutcome::Cancelled` for user cancellation and map access denial distinctly; never move native
capture or clipboard authority into plugin code. Linux follows the same trait, preferably through
`xdg-desktop-portal`. Set `is_available()` true only once the implementation is usable. The provider,
dialog, plugin API, and worker transport require no platform-specific change.

The `screen-capture.json` Tauri capability grants these commands to the `main` window only. Do not add
them to the broad main/toolset capability.
