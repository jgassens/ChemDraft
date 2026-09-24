use image::GenericImageView;
use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CaptureOutcome {
    Captured,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CapturePermission {
    Granted,
    Denied,
    NotDetermined,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    NotRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CaptureError {
    PermissionDenied,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    // Only non-macOS implementations construct this extension-point variant.
    Unsupported,
    Failed(String),
}

/// Platform-neutral interactive region capture boundary. A new OS implementation plugs in here;
/// neither the Tauri command nor the TypeScript provider needs to change.
pub(crate) trait RegionCapture: Send + Sync {
    fn is_available(&self) -> bool;
    fn permission_status(&self) -> Result<CapturePermission, CaptureError>;
    fn request_permission(&self) -> Result<CapturePermission, CaptureError>;
    fn open_permission_settings(&self) -> Result<(), CaptureError>;
    fn capture_interactive(&self, out: &Path) -> Result<CaptureOutcome, CaptureError>;
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum ScreenCaptureResponse {
    Captured {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
    },
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub(crate) enum ScreenCaptureCommandError {
    PermissionDenied,
    Unsupported,
    Failed(String),
}

type CapturePermissionCommandResult = Result<CapturePermission, ScreenCaptureCommandError>;

impl From<CaptureError> for ScreenCaptureCommandError {
    fn from(error: CaptureError) -> Self {
        match error {
            CaptureError::PermissionDenied => Self::PermissionDenied,
            CaptureError::Unsupported => Self::Unsupported,
            CaptureError::Failed(message) => Self::Failed(message),
        }
    }
}

static NEXT_CAPTURE_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub(crate) fn screen_capture_available() -> bool {
    platform_region_capture().is_available()
}

#[tauri::command]
pub(crate) fn screen_capture_permission_status() -> CapturePermissionCommandResult {
    platform_region_capture()
        .permission_status()
        .map_err(ScreenCaptureCommandError::from)
}

#[tauri::command]
pub(crate) fn request_screen_capture_permission() -> CapturePermissionCommandResult {
    platform_region_capture()
        .request_permission()
        .map_err(ScreenCaptureCommandError::from)
}

#[tauri::command]
pub(crate) fn open_screen_capture_settings() -> Result<(), ScreenCaptureCommandError> {
    platform_region_capture()
        .open_permission_settings()
        .map_err(ScreenCaptureCommandError::from)
}

#[tauri::command]
pub(crate) fn relaunch_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub(crate) async fn capture_screen_region(
    app: AppHandle,
) -> Result<ScreenCaptureResponse, ScreenCaptureCommandError> {
    let path = capture_temp_path(&app)?;
    let temp = CaptureTempFile(path.clone());
    // Only windows that are currently visible and not already minimized are changed. Restoring the
    // same set in Drop makes every success/error/cancellation path put ChemDraft back as it was.
    let hidden_windows = HiddenChemDraftWindows::hide(&app);
    let capture = platform_region_capture();
    let response =
        tauri::async_runtime::spawn_blocking(move || capture_to_response(capture.as_ref(), &path))
            .await
            .map_err(|error| {
                ScreenCaptureCommandError::Failed(format!("Screen capture task failed: {error}"))
            })?;
    drop(hidden_windows);
    drop(temp);
    response
}

fn capture_temp_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, ScreenCaptureCommandError> {
    let directory = app.path().temp_dir().map_err(|error| {
        ScreenCaptureCommandError::Failed(format!(
            "Could not resolve the app temporary directory: {error}"
        ))
    })?;
    Ok(directory.join(format!(
        "chemdraft-screen-region-{}-{}.png",
        std::process::id(),
        NEXT_CAPTURE_ID.fetch_add(1, Ordering::Relaxed)
    )))
}

fn capture_to_response(
    capture: &dyn RegionCapture,
    out: &Path,
) -> Result<ScreenCaptureResponse, ScreenCaptureCommandError> {
    match capture
        .capture_interactive(out)
        .map_err(ScreenCaptureCommandError::from)?
    {
        CaptureOutcome::Cancelled => Ok(ScreenCaptureResponse::Cancelled),
        CaptureOutcome::Captured => {
            let bytes = std::fs::read(out).map_err(|error| {
                ScreenCaptureCommandError::Failed(format!("Could not read captured image: {error}"))
            })?;
            if bytes.is_empty() {
                return Err(ScreenCaptureCommandError::Failed(
                    "Screen capture returned an empty image.".into(),
                ));
            }
            if image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png) {
                return Err(ScreenCaptureCommandError::Failed(
                    "Screen capture did not return a PNG image.".into(),
                ));
            }
            let decoded = image::load_from_memory(&bytes).map_err(|error| {
                ScreenCaptureCommandError::Failed(format!("Could not decode captured PNG: {error}"))
            })?;
            let (width, height) = decoded.dimensions();
            Ok(ScreenCaptureResponse::Captured {
                bytes,
                width,
                height,
            })
        }
    }
}

struct CaptureTempFile(PathBuf);

impl Drop for CaptureTempFile {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "Could not remove screen-capture temporary file {}: {error}",
                self.0.display()
            ),
        }
    }
}

struct HiddenChemDraftWindows<R: Runtime> {
    windows: Vec<tauri::WebviewWindow<R>>,
}

impl<R: Runtime> HiddenChemDraftWindows<R> {
    fn hide(app: &AppHandle<R>) -> Self {
        let mut windows = Vec::new();
        for window in app.webview_windows().into_values() {
            let visible = window.is_visible().unwrap_or(false);
            let minimized = window.is_minimized().unwrap_or(false);
            if visible && !minimized && window.hide().is_ok() {
                windows.push(window);
            }
        }
        Self { windows }
    }
}

impl<R: Runtime> Drop for HiddenChemDraftWindows<R> {
    fn drop(&mut self) {
        for window in &self.windows {
            if let Err(error) = window.show() {
                eprintln!(
                    "Could not restore ChemDraft window {} after screen capture: {error}",
                    window.label()
                );
            }
        }
    }
}

#[cfg(target_os = "macos")]
struct MacOsRegionCapture;

#[cfg(target_os = "macos")]
static SCREEN_CAPTURE_PERMISSION_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn macos_permission_status(preflight_granted: bool, request_attempted: bool) -> CapturePermission {
    if preflight_granted {
        CapturePermission::Granted
    } else if request_attempted {
        CapturePermission::Denied
    } else {
        // CoreGraphics exposes granted/not-granted but does not distinguish a prior denial from an
        // unasked app. Treat the first check in this process as not determined so the user gesture
        // can call CGRequestScreenCaptureAccess; a false request result is then definitively denied.
        CapturePermission::NotDetermined
    }
}

#[cfg(target_os = "macos")]
impl RegionCapture for MacOsRegionCapture {
    fn is_available(&self) -> bool {
        Path::new("/usr/sbin/screencapture").is_file()
    }

    fn permission_status(&self) -> Result<CapturePermission, CaptureError> {
        Ok(macos_permission_status(
            unsafe { CGPreflightScreenCaptureAccess() },
            SCREEN_CAPTURE_PERMISSION_REQUESTED.load(Ordering::SeqCst),
        ))
    }

    fn request_permission(&self) -> Result<CapturePermission, CaptureError> {
        let granted = unsafe { CGRequestScreenCaptureAccess() };
        SCREEN_CAPTURE_PERMISSION_REQUESTED.store(true, Ordering::SeqCst);
        Ok(macos_permission_status(granted, true))
    }

    fn open_permission_settings(&self) -> Result<(), CaptureError> {
        const SCREEN_RECORDING_SETTINGS: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
        let status = std::process::Command::new("/usr/bin/open")
            .arg(SCREEN_RECORDING_SETTINGS)
            .status()
            .map_err(|error| {
                CaptureError::Failed(format!("Could not open Screen Recording settings: {error}"))
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(CaptureError::Failed(format!(
                "Opening Screen Recording settings exited with status {status}."
            )))
        }
    }

    fn capture_interactive(&self, out: &Path) -> Result<CaptureOutcome, CaptureError> {
        // CoreGraphics is already a system framework; direct FFI avoids adding a second wrapper
        // dependency. Preflight is the authoritative check for the blank/no-file behavior produced
        // when Screen Recording permission is denied.
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(CaptureError::PermissionDenied);
        }
        let output = std::process::Command::new("/usr/sbin/screencapture")
            .args(["-i", "-x", "-t", "png"])
            .arg(out)
            .output()
            .map_err(|error| {
                CaptureError::Failed(format!("Could not launch screencapture: {error}"))
            })?;

        let has_capture = std::fs::metadata(out)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
        if has_capture && output.status.success() {
            return Ok(CaptureOutcome::Captured);
        }
        if !has_capture {
            // Escape exits without a file. Re-check permission to distinguish a permission change
            // while the marquee was open from ordinary user cancellation.
            if !unsafe { CGPreflightScreenCaptureAccess() } {
                return Err(CaptureError::PermissionDenied);
            }
            return Ok(CaptureOutcome::Cancelled);
        }
        Err(CaptureError::Failed(format!(
            "screencapture exited with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

/// Windows extension point: implement with Windows.Graphics.Capture, or invoke the Snipping Tool via
/// `ms-screenclip:` and retrieve the user-confirmed bitmap from the clipboard.
#[cfg(target_os = "windows")]
struct WindowsRegionCapture;

#[cfg(target_os = "windows")]
impl RegionCapture for WindowsRegionCapture {
    fn is_available(&self) -> bool {
        false
    }

    fn permission_status(&self) -> Result<CapturePermission, CaptureError> {
        Ok(CapturePermission::NotRequired)
    }

    fn request_permission(&self) -> Result<CapturePermission, CaptureError> {
        Ok(CapturePermission::NotRequired)
    }

    /// Windows has no Screen Recording privacy pane equivalent. A future Windows capture provider
    /// should open only settings that are actually relevant to its chosen capture API.
    fn open_permission_settings(&self) -> Result<(), CaptureError> {
        Err(CaptureError::Unsupported)
    }

    fn capture_interactive(&self, _out: &Path) -> Result<CaptureOutcome, CaptureError> {
        Err(CaptureError::Unsupported)
    }
}

/// Linux extension point: select a portal-native region picker (for example xdg-desktop-portal) and
/// write the confirmed image to `out`; do not expose compositor-specific details to TypeScript.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct LinuxRegionCapture;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl RegionCapture for LinuxRegionCapture {
    fn is_available(&self) -> bool {
        false
    }

    fn permission_status(&self) -> Result<CapturePermission, CaptureError> {
        Ok(CapturePermission::NotRequired)
    }

    fn request_permission(&self) -> Result<CapturePermission, CaptureError> {
        Ok(CapturePermission::NotRequired)
    }

    /// Portal implementations broker consent per request and have no shared settings pane to open.
    fn open_permission_settings(&self) -> Result<(), CaptureError> {
        Err(CaptureError::Unsupported)
    }

    fn capture_interactive(&self, _out: &Path) -> Result<CaptureOutcome, CaptureError> {
        Err(CaptureError::Unsupported)
    }
}

fn platform_region_capture() -> Box<dyn RegionCapture> {
    #[cfg(target_os = "macos")]
    return Box::new(MacOsRegionCapture);
    #[cfg(target_os = "windows")]
    return Box::new(WindowsRegionCapture);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Box::new(LinuxRegionCapture);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeCapture(Result<CaptureOutcome, CaptureError>);

    impl RegionCapture for FakeCapture {
        fn is_available(&self) -> bool {
            true
        }

        fn permission_status(&self) -> Result<CapturePermission, CaptureError> {
            Ok(CapturePermission::Granted)
        }

        fn request_permission(&self) -> Result<CapturePermission, CaptureError> {
            Ok(CapturePermission::Granted)
        }

        fn open_permission_settings(&self) -> Result<(), CaptureError> {
            Ok(())
        }

        fn capture_interactive(&self, out: &Path) -> Result<CaptureOutcome, CaptureError> {
            if self.0 == Ok(CaptureOutcome::Captured) {
                image::DynamicImage::new_rgba8(3, 2)
                    .save_with_format(out, image::ImageFormat::Png)
                    .expect("write fixture PNG");
            }
            self.0.clone()
        }
    }

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "chemdraft-screen-capture-test-{label}-{}-{}.png",
            std::process::id(),
            NEXT_CAPTURE_ID.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn maps_captured_and_cancelled_outcomes() {
        let captured_path = test_path("captured");
        let response =
            capture_to_response(&FakeCapture(Ok(CaptureOutcome::Captured)), &captured_path)
                .expect("captured response");
        match response {
            ScreenCaptureResponse::Captured {
                width,
                height,
                bytes,
            } => {
                assert_eq!((width, height), (3, 2));
                assert!(!bytes.is_empty());
            }
            ScreenCaptureResponse::Cancelled => panic!("expected captured"),
        }
        let _ = std::fs::remove_file(captured_path);

        let cancelled = capture_to_response(
            &FakeCapture(Ok(CaptureOutcome::Cancelled)),
            &test_path("cancelled"),
        )
        .expect("cancelled response");
        assert!(matches!(cancelled, ScreenCaptureResponse::Cancelled));
    }

    #[test]
    fn maps_permission_unsupported_and_failed_errors() {
        for (capture_error, expected) in [
            (
                CaptureError::PermissionDenied,
                ScreenCaptureCommandError::PermissionDenied,
            ),
            (
                CaptureError::Unsupported,
                ScreenCaptureCommandError::Unsupported,
            ),
            (
                CaptureError::Failed("boom".into()),
                ScreenCaptureCommandError::Failed("boom".into()),
            ),
        ] {
            let error = capture_to_response(&FakeCapture(Err(capture_error)), &test_path("error"))
                .expect_err("capture should fail");
            assert_eq!(error, expected);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_macos_preflight_and_request_state_to_permission_status() {
        assert_eq!(
            macos_permission_status(true, false),
            CapturePermission::Granted
        );
        assert_eq!(
            macos_permission_status(true, true),
            CapturePermission::Granted
        );
        assert_eq!(
            macos_permission_status(false, false),
            CapturePermission::NotDetermined
        );
        assert_eq!(
            macos_permission_status(false, true),
            CapturePermission::Denied
        );
    }
}
