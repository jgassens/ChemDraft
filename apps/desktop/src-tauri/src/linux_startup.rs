use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[cfg(target_os = "linux")]
pub(super) struct Startup {
    pub(super) documents: Vec<PathBuf>,
    pub(super) appimage: Option<AppImageDirectories>,
}

pub(super) struct AppImageDirectories {
    launch: PathBuf,
    pub(super) dialogs: PathBuf,
}

impl AppImageDirectories {
    /// `browsable` decides whether a file dialog can list the launch folder. A folder that exists
    /// but cannot be read or searched falls back to home rather than opening a dialog on it.
    fn new(
        owd: Option<&Path>,
        home: Option<PathBuf>,
        root: &Path,
        is_dir: impl Fn(&Path) -> bool,
        browsable: impl Fn(&Path) -> bool,
    ) -> Self {
        let home = child_directory(home, root, &is_dir);
        Self {
            launch: launch_directory(owd, &home).to_owned(),
            dialogs: launch_directory(
                owd.filter(|path| path.is_absolute() && is_dir(path) && browsable(path)),
                &home,
            )
            .to_owned(),
        }
    }
}

/// Whether a directory can be listed (read) and entered (search). `read_dir` needs read access;
/// `stat` of `<dir>/.` needs search access.
fn is_browsable_dir(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok()
        && std::fs::metadata(path.join(".")).is_ok_and(|metadata| metadata.is_dir())
}

#[cfg(target_os = "linux")]
pub(super) fn configure() -> Startup {
    use std::env;

    configure_webkit_renderer();
    let cwd = env::current_dir().ok();
    let appimage = appimage_root(
        env::var_os("APPIMAGE").as_deref(),
        env::var_os("APPDIR").as_deref(),
        cwd.as_deref(),
    )
    .map(|appdir| {
        let appdir = appdir.canonicalize().unwrap_or(appdir);
        env::set_var("APPDIR", &appdir);
        let variable = "WEBKIT_INJECTED_BUNDLE_PATH";
        if let Some(path) = appimage_path_override(&appdir, env::var_os(variable).as_deref()) {
            env::set_var(variable, path);
        }
        AppImageDirectories::new(
            env::var_os("OWD").as_deref().map(Path::new),
            dirs::home_dir(),
            Path::new("/"),
            Path::is_dir,
            is_browsable_dir,
        )
    });

    // AppRun's working folder stays in the image for WebKitGTK's relative helper paths.
    let document_base = appimage
        .as_ref()
        .map(|dirs| dirs.launch.as_path())
        .or(cwd.as_deref());
    let documents = env::args_os()
        .skip(1)
        .filter_map(|arg| document_argument(&arg, document_base))
        .collect();

    Startup {
        documents,
        appimage,
    }
}

#[cfg(target_os = "linux")]
fn is_appimage() -> bool {
    present(std::env::var_os("APPIMAGE").as_deref())
        && present(std::env::var_os("APPDIR").as_deref())
}

#[cfg(target_os = "linux")]
pub(super) fn set_child_directory(command: &mut std::process::Command) {
    if is_appimage() {
        command.current_dir(child_directory(
            dirs::home_dir(),
            Path::new("/"),
            Path::is_dir,
        ));
    }
}

/// Resolve an explicitly supplied path before launching a process with its own working folder.
#[cfg(target_os = "linux")]
pub(super) fn user_path(path: &Path) -> std::borrow::Cow<'_, Path> {
    if is_appimage() && !path.is_absolute() {
        let home = child_directory(dirs::home_dir(), Path::new("/"), Path::is_dir);
        let owd = std::env::var_os("OWD");
        let base = launch_directory(owd.as_deref().map(Path::new), &home);
        return std::borrow::Cow::Owned(base.join(path));
    }
    std::borrow::Cow::Borrowed(path)
}

#[cfg(target_os = "linux")]
fn configure_webkit_renderer() {
    const VARIABLE: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if should_disable_dmabuf(std::env::var_os(VARIABLE).as_deref()) {
        // Set the default before Tauri starts GTK, WebKitGTK, or any app threads.
        std::env::set_var(VARIABLE, "1");
    }

    let display = std::env::var_os("DISPLAY");
    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    match backend_default(
        display.as_deref(),
        wayland_display.as_deref(),
        std::env::var_os("GDK_BACKEND").as_deref(),
        std::env::var_os("CHEMDRAFT_NATIVE_WAYLAND").as_deref(),
    ) {
        BackendDefault::X11 => {
            // Native Wayland leaves floating palette and dialog placement to the compositor.
            std::env::set_var("GDK_BACKEND", "x11");
            eprintln!("ChemDraft GTK backend default: GDK_BACKEND=x11");
        }
        BackendDefault::WaylandWithoutX11 => {
            eprintln!(
                "ChemDraft GTK backend: keeping native Wayland because DISPLAY is unavailable"
            );
        }
        BackendDefault::Unchanged => {}
    }

    let gdk_backend = std::env::var_os("GDK_BACKEND");
    if let Some(platform) = appimage_egl_platform(
        std::env::var_os("APPIMAGE").is_some(),
        std::env::var_os("EGL_PLATFORM").as_deref(),
        gdk_backend.as_deref(),
        present(wayland_display.as_deref()),
    ) {
        // Bundled WebKitGTK asks the host EGL for a default display without a platform.
        std::env::set_var("EGL_PLATFORM", platform);
        eprintln!(
            "ChemDraft AppImage EGL default: EGL_PLATFORM={platform} GDK_BACKEND={gdk_backend:?}"
        );
    }
}

fn should_disable_dmabuf(user_value: Option<&OsStr>) -> bool {
    user_value.is_none()
}

#[derive(Debug, PartialEq, Eq)]
enum BackendDefault {
    X11,
    WaylandWithoutX11,
    Unchanged,
}

fn present(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

fn backend_default(
    display: Option<&OsStr>,
    wayland_display: Option<&OsStr>,
    gdk_backend: Option<&OsStr>,
    native_wayland: Option<&OsStr>,
) -> BackendDefault {
    if gdk_backend.is_some() || !present(wayland_display) {
        BackendDefault::Unchanged
    } else if !present(display) {
        BackendDefault::WaylandWithoutX11
    } else if native_wayland == Some(OsStr::new("1")) {
        BackendDefault::Unchanged
    } else {
        BackendDefault::X11
    }
}

fn absolute_path(path: &Path, base: Option<&Path>) -> Option<PathBuf> {
    if path.is_absolute() {
        Some(path.to_owned())
    } else {
        base.map(|base| base.join(path))
            .filter(|path| path.is_absolute())
    }
}

fn appimage_root(
    image: Option<&OsStr>,
    root: Option<&OsStr>,
    cwd: Option<&Path>,
) -> Option<PathBuf> {
    if !present(image) {
        return None;
    }
    let root = root.filter(|root| !root.is_empty())?;
    absolute_path(Path::new(root), cwd)
}

fn child_directory(home: Option<PathBuf>, root: &Path, is_dir: impl Fn(&Path) -> bool) -> PathBuf {
    home.filter(|path| path.is_absolute() && is_dir(path))
        .unwrap_or_else(|| root.to_owned())
}

fn launch_directory<'a>(owd: Option<&'a Path>, home: &'a Path) -> &'a Path {
    owd.filter(|path| path.is_absolute()).unwrap_or(home)
}

fn document_argument(arg: &OsStr, cwd: Option<&Path>) -> Option<PathBuf> {
    if arg.is_empty() || arg.as_encoded_bytes().starts_with(b"-") {
        return None;
    }
    absolute_path(Path::new(arg), cwd)
}

/// Split documents into the paths the stock single-instance handoff carries as UTF-8 strings and
/// the paths it cannot. ChemDraft could not save back to a non-UTF-8 path in either instance
/// (`open_document_path_text`), so the secondary refuses those by name instead of forwarding them
/// to a primary that would refuse them out of the user's sight.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(super) fn forwardable_documents(documents: &[PathBuf]) -> (Vec<&str>, Vec<&Path>) {
    let mut forwarded = Vec::new();
    let mut refused = Vec::new();
    for path in documents {
        match path.to_str() {
            Some(text) => forwarded.push(text),
            None => refused.push(path.as_path()),
        }
    }
    (forwarded, refused)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(super) fn refused_documents_message(refused: &[&Path]) -> String {
    refused
        .iter()
        .map(|path| super::unsavable_document_path_message(path))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn file_dialog_default_path(default: Option<&Path>, directory: &Path) -> PathBuf {
    match default.filter(|path| !path.as_os_str().is_empty()) {
        Some(path) => directory.join(path),
        None => directory.to_owned(),
    }
}

fn appimage_path_override(root: &Path, value: Option<&OsStr>) -> Option<PathBuf> {
    let path = Path::new(value.filter(|value| !value.is_empty())?);
    absolute_path(path, Some(root))
}

fn appimage_egl_platform(
    appimage_set: bool,
    egl_platform: Option<&OsStr>,
    gdk_backend: Option<&OsStr>,
    wayland_display_set: bool,
) -> Option<&'static str> {
    if !appimage_set || egl_platform.is_some() {
        return None;
    }

    let backend = gdk_backend.map(OsStr::as_encoded_bytes).unwrap_or_default();
    Some(if backend.starts_with(b"x11") {
        "x11"
    } else if backend.starts_with(b"wayland") || wayland_display_set {
        "wayland"
    } else {
        "x11"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dmabuf_default_respects_every_explicit_value() {
        assert!(should_disable_dmabuf(None));
        for value in ["0", "1", ""] {
            assert!(!should_disable_dmabuf(Some(OsStr::new(value))));
        }
    }

    #[test]
    fn xwayland_default_requires_both_displays_and_respects_opt_out() {
        for (native_wayland, expected_on_wayland) in [
            (None, BackendDefault::X11),
            (Some("0"), BackendDefault::X11),
            (Some(""), BackendDefault::X11),
            (Some("1"), BackendDefault::Unchanged),
        ] {
            let native_wayland = native_wayland.map(OsStr::new);
            let display = Some(OsStr::new(":0"));
            let wayland = Some(OsStr::new("wayland-0"));
            assert_eq!(
                backend_default(display, None, None, native_wayland),
                BackendDefault::Unchanged
            );
            assert_eq!(
                backend_default(display, Some(OsStr::new("")), None, native_wayland),
                BackendDefault::Unchanged
            );
            assert_eq!(
                backend_default(display, wayland, None, native_wayland),
                expected_on_wayland
            );
            for unavailable in [None, Some(OsStr::new(""))] {
                assert_eq!(
                    backend_default(unavailable, wayland, None, native_wayland),
                    BackendDefault::WaylandWithoutX11
                );
            }
        }
    }

    #[test]
    fn xwayland_default_respects_every_explicit_backend() {
        for backend in ["x11", "wayland", "x11,wayland", "other", ""] {
            for display in [None, Some(OsStr::new(":0"))] {
                assert_eq!(
                    backend_default(
                        display,
                        Some(OsStr::new("wayland-0")),
                        Some(OsStr::new(backend)),
                        None
                    ),
                    BackendDefault::Unchanged
                );
            }
        }
    }

    fn test_root() -> &'static Path {
        Path::new(if cfg!(windows) { "C:\\" } else { "/" })
    }

    #[test]
    fn appimage_requires_both_variables_and_anchors_a_relative_mount() {
        let cwd = test_root().join("extracted");
        let image = Some(OsStr::new("ChemDraft.AppImage"));
        let root = Some(OsStr::new("AppDir"));
        assert_eq!(appimage_root(None, root, Some(&cwd)), None);
        assert_eq!(appimage_root(image, None, Some(&cwd)), None);
        assert_eq!(appimage_root(image, Some(OsStr::new("")), Some(&cwd)), None);
        assert_eq!(appimage_root(image, root, None), None);
        assert_eq!(
            appimage_root(image, root, Some(&cwd)),
            Some(cwd.join("AppDir"))
        );
    }

    #[test]
    fn relative_document_arguments_use_the_original_folder_or_home() {
        let owd = test_root().join("original");
        let home = test_root().join("home");
        let name = OsStr::new("drawing.cdxml");
        for (original, expected) in [(Some(owd.as_path()), &owd), (None, &home)] {
            let folder = launch_directory(original, &home);
            assert_eq!(
                document_argument(name, Some(folder)),
                Some(expected.join(name))
            );
        }
        assert_eq!(launch_directory(Some(Path::new("relative")), &home), home);
        let absolute = owd.join("absolute.cdx");
        assert_eq!(
            document_argument(absolute.as_os_str(), Some(&home)),
            Some(absolute)
        );
        assert_eq!(
            document_argument(OsStr::new("--chemdraft-agent-bridge"), Some(&home)),
            None
        );
        assert_eq!(document_argument(name, None), None);
    }

    #[test]
    fn bundled_webkit_overrides_use_appdir_and_keep_absolute_paths() {
        let appdir = test_root().join("AppDir");
        let relative = Path::new("usr").join("lib").join("webkit2gtk-4.1");
        assert_eq!(
            appimage_path_override(&appdir, Some(relative.as_os_str())),
            Some(appdir.join(relative))
        );
        let absolute = test_root().join("system-webkit");
        assert_eq!(
            appimage_path_override(&appdir, Some(absolute.as_os_str())),
            Some(absolute)
        );
        assert_eq!(appimage_path_override(&appdir, None), None);
    }

    #[test]
    fn dialogs_prefer_a_live_launch_folder_and_children_prefer_home() {
        let owd = test_root().join("original");
        let home = test_root().join("home");
        let is_dir = |path: &Path| path == owd || path == home;
        let directories =
            AppImageDirectories::new(Some(&owd), Some(home.clone()), test_root(), is_dir, |_| {
                true
            });
        assert_eq!(directories.launch, owd);
        assert_eq!(directories.dialogs, owd);
        // An existing launch folder that cannot be listed or entered sends dialogs home.
        let directories = AppImageDirectories::new(
            Some(&owd),
            Some(home.clone()),
            test_root(),
            is_dir,
            |path| path != owd,
        );
        assert_eq!(directories.launch, owd);
        assert_eq!(directories.dialogs, home);
        assert_eq!(
            child_directory(Some(home.clone()), test_root(), is_dir),
            home
        );
        let directories = AppImageDirectories::new(
            Some(&owd),
            Some(home.clone()),
            test_root(),
            |path| path == home,
            |_| true,
        );
        assert_eq!(directories.launch, owd);
        assert_eq!(directories.dialogs, home);
        assert_eq!(
            child_directory(Some(home), test_root(), |_| false),
            test_root()
        );
        assert_eq!(
            child_directory(Some(PathBuf::from("relative")), test_root(), |_| true),
            test_root()
        );
    }

    #[cfg(unix)]
    fn non_utf8_path() -> PathBuf {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(OsStr::from_bytes(b"/home/caf\xe9.chemdraft"))
    }

    #[cfg(windows)]
    fn non_utf8_path() -> PathBuf {
        use std::os::windows::ffi::OsStringExt;
        // An unpaired surrogate has no UTF-8 form.
        let mut wide: Vec<u16> = "C:\\caf".encode_utf16().collect();
        wide.push(0xD800);
        wide.extend(".chemdraft".encode_utf16());
        PathBuf::from(std::ffi::OsString::from_wide(&wide))
    }

    #[test]
    fn handoff_forwards_utf8_documents_and_refuses_the_rest_by_name() {
        let utf8 = test_root().join("caf\u{e9}.chemdraft");
        let other = test_root().join("second.cdxml");
        let invalid = non_utf8_path();
        let documents = vec![utf8.clone(), invalid.clone(), other.clone()];
        let (forwarded, refused) = forwardable_documents(&documents);
        assert_eq!(
            forwarded,
            [utf8.to_str().unwrap(), other.to_str().unwrap()],
            "UTF-8 paths keep their order"
        );
        assert_eq!(refused, [invalid.as_path()]);
        let message = refused_documents_message(&refused);
        assert!(message.contains("not valid UTF-8"), "{message}");
        assert!(message.contains("caf"), "{message}");
        assert_eq!(forwardable_documents(&[]), (vec![], vec![]));
    }

    #[test]
    fn browsable_directories_must_exist_and_be_listable() {
        let root = std::env::temp_dir().join(format!(
            "chemdraft-browsable-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&root).expect("create test folder");
        assert!(is_browsable_dir(&root));
        assert!(!is_browsable_dir(&root.join("missing")));
        let file = root.join("file.txt");
        std::fs::write(&file, b"").expect("create test file");
        assert!(!is_browsable_dir(&file));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = root.join("locked");
            std::fs::create_dir(&locked).expect("create locked folder");
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))
                .expect("lock folder");
            // A privileged test runner bypasses permission bits, so only check as a normal user.
            // SAFETY: geteuid has no preconditions and cannot fail.
            if unsafe { libc::geteuid() } != 0 {
                assert!(locked.is_dir());
                assert!(!is_browsable_dir(&locked));
            }
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700))
                .expect("unlock folder");
        }
        std::fs::remove_dir_all(&root).expect("remove test folder");
    }

    #[test]
    fn dialog_default_paths_use_the_launch_folder_and_keep_explicit_absolute_paths() {
        let directory = test_root().join("original folder");
        let remembered = test_root().join("last location");
        assert_eq!(file_dialog_default_path(None, &directory), directory);
        assert_eq!(
            file_dialog_default_path(Some(Path::new("")), &directory),
            directory
        );
        let filename = Path::new("Untitled.chemdraft");
        assert_eq!(
            file_dialog_default_path(Some(filename), &directory),
            directory.join(filename)
        );
        let remembered_file = remembered.join(filename);
        for path in [remembered, remembered_file] {
            assert_eq!(file_dialog_default_path(Some(&path), &directory), path);
        }
    }

    #[test]
    fn egl_platform_default_only_applies_to_appimages() {
        assert_eq!(appimage_egl_platform(false, None, None, false), None);
        assert_eq!(appimage_egl_platform(false, None, None, true), None);
    }

    #[test]
    fn egl_platform_default_respects_every_explicit_value() {
        for value in ["x11", "wayland", "surfaceless", ""] {
            for backend in [None, Some("x11"), Some("wayland")] {
                assert_eq!(
                    appimage_egl_platform(
                        true,
                        Some(OsStr::new(value)),
                        backend.map(OsStr::new),
                        true,
                    ),
                    None
                );
            }
        }
    }

    #[test]
    fn egl_platform_default_matches_the_gdk_backend() {
        for (backend, wayland_display_set, expected) in [
            (Some("x11"), false, "x11"),
            (Some("x11"), true, "x11"),
            (Some("x11,wayland"), true, "x11"),
            (Some("wayland"), false, "wayland"),
            (Some("wayland"), true, "wayland"),
            (Some("wayland,x11"), false, "wayland"),
            (Some("other,wayland"), false, "x11"),
            (Some("other,x11"), true, "wayland"),
            (None, false, "x11"),
            (None, true, "wayland"),
        ] {
            assert_eq!(
                appimage_egl_platform(true, None, backend.map(OsStr::new), wayland_display_set),
                Some(expected)
            );
        }
    }
}
