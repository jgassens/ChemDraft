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
    let temp = capture_temp_file(&app)?;
    let path = temp.path.clone();
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

fn capture_temp_file<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<CaptureTempFile, ScreenCaptureCommandError> {
    let directory = app.path().temp_dir().map_err(|error| {
        ScreenCaptureCommandError::Failed(format!(
            "Could not resolve the app temporary directory: {error}"
        ))
    })?;
    CaptureTempFile::create(&directory).map_err(|error| {
        ScreenCaptureCommandError::Failed(format!(
            "Could not create a private file for the screen capture: {error}"
        ))
    })
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

/// Where a capture lands: `region.png` inside a directory created for this capture alone.
///
/// A shared temporary directory (`/tmp` on Linux, sometimes on macOS) lets another local user
/// pre-create or link a predictable name, or read the captured screen. So the directory gets an
/// unguessable name and is created exclusively (it must not already exist) with 0700 permissions,
/// and the file inside is created exclusively with 0600. The directory is what keeps the capture
/// private even if `screencapture` replaces the file rather than writing into it. Dropping this
/// removes both, on every success, error and cancellation path.
struct CaptureTempFile {
    directory: PathBuf,
    path: PathBuf,
}

impl CaptureTempFile {
    fn create(base: &Path) -> std::io::Result<Self> {
        let mut last_error = None;
        for _ in 0..32 {
            let directory = base.join(format!("chemdraft-screen-region-{}", unguessable_token()));
            match create_private_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    last_error = Some(error);
                    continue;
                }
                Err(error) => return Err(error),
            }
            // From here the directory is ours; a failure below must not leave it behind.
            let temp = Self {
                path: directory.join("region.png"),
                directory,
            };
            create_private_file(&temp.path)?;
            return Ok(temp);
        }
        Err(last_error.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "no unused screen-capture directory name",
            )
        }))
    }
}

impl Drop for CaptureTempFile {
    fn drop(&mut self) {
        match std::fs::remove_dir_all(&self.directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "Could not remove screen-capture temporary directory {}: {error}",
                self.directory.display()
            ),
        }
    }
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path)
}

// Windows: a directory under the per-user %TEMP% inherits that user's ACL.
#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::DirBuilder::new().create(path)
}

fn create_private_file(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map(drop)
}

/// 128 bits from two independently keyed SipHash instances (`RandomState` draws its keys from the
/// OS random source), mixed with the process id, a counter and the clock. The name only has to be
/// unguessable; the exclusive create is what makes it safe.
fn unguessable_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nonce = NEXT_CAPTURE_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let word = || {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(nonce);
        hasher.write_u32(std::process::id());
        hasher.write_u128(nanos);
        hasher.finish()
    };
    format!("{:016x}{:016x}", word(), word())
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
    fn capture_file_is_private_unpredictable_and_always_removed() {
        let base = test_path("private-base");
        std::fs::create_dir_all(&base).expect("base");
        let first = CaptureTempFile::create(&base).expect("first capture file");
        let second = CaptureTempFile::create(&base).expect("second capture file");
        assert_ne!(first.directory, second.directory);
        let name = first
            .directory
            .file_name()
            .and_then(|name| name.to_str())
            .expect("name");
        let token = name
            .strip_prefix("chemdraft-screen-region-")
            .expect("prefix");
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(first.path.is_file());
        assert_eq!(std::fs::metadata(&first.path).expect("file").len(), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| {
                std::fs::metadata(path)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777
            };
            assert_eq!(mode(&first.directory), 0o700);
            assert_eq!(mode(&first.path), 0o600);
        }

        // Exclusive creation: an existing file at the capture path is never reused.
        assert_eq!(
            create_private_file(&first.path)
                .expect_err("existing file")
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );

        // Removed on drop, including after a capture wrote into it.
        std::fs::write(&first.path, b"captured").expect("capture");
        let (directory, other) = (first.directory.clone(), second.directory.clone());
        drop(first);
        drop(second);
        assert!(!directory.exists());
        assert!(!other.exists());
        let _ = std::fs::remove_dir_all(base);
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
