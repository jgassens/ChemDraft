//! The Library window's native side (docs/plans/art-library.md).
//!
//! Phase 0 holds one capability: start an operating-system FILE drag of one SVG from a floating
//! dialog window, so the file can land on a ChemDraft document (through the document window's
//! ordinary file drop, `file_drop.rs`), on Finder or Explorer, or in another app. The drag itself is
//! the `drag` crate (CrabNebula; `NSDraggingSession` on macOS, OLE `DoDragDrop` on Windows). Linux
//! has no drag yet: the command refuses there and the capability is not granted.
//!
//! [`art_library_start_drag`] is fail-closed. A path is accepted only when it
//! - is absolute and written plainly (no `..`, no Windows device, verbatim or drive-relative form,
//!   no alternate data stream, no reserved device name, no trailing dot or space),
//! - names an `.svg` file,
//! - lies inside an allow-listed root, `<app data>/art-library/` or `<resource dir>/art/`, first by
//!   its text (so nothing outside a root, a network share included, is ever touched) and again after
//!   every link is resolved (so a linked folder inside a root cannot lead out of it),
//! - is not itself a symbolic link, and is a regular, non-empty file under [`MAX_DRAG_FILE_BYTES`].
//!
//! The lexical half takes the platform as a parameter so one host tests Windows rules (drive
//! letters, `\` and `/`, UNC shares, case-insensitive names) and Unix rules alike.
//!
//! DEV-ONLY drag harness (remove in phase 3): [`art_library_dev_drag_test_prepare`] writes a fixed
//! SVG for the "Drag test" tile in the Templates dialog of a labelled development build and returns
//! its path; a stable build returns `None` and writes nothing.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, WebviewWindow};

/// Largest SVG a drag will hand out. The biggest BioArt file is about 636 KB.
pub(crate) const MAX_DRAG_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Longest path text accepted before any parsing.
const MAX_PATH_CHARS: usize = 4096;
/// Folder under the app data directory that holds user art (and, for now, the drag spike file).
pub(crate) const APP_DATA_ART_FOLDER: &str = "art-library";
/// Folder under the resource directory that holds bundled art.
pub(crate) const RESOURCE_ART_FOLDER: &str = "art";
/// Windows whose webviews may start a drag. The capability grants the command to the same windows;
/// this second check keeps the command closed even if a capability is widened by mistake.
const DRAG_SOURCE_WINDOW_PREFIXES: &[&str] = &["dialog-main-structureTemplates-"];
/// Side of the square the drag preview is fitted into, in pixels.
const PREVIEW_SIZE: u32 = 96;

/// Path rules to apply. Passed in so tests on one host exercise both sets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathPlatform {
    /// Drive letters or UNC shares, `\` or `/` separators, case-insensitive names.
    Windows,
    /// One root, `/` separators, names compared exactly (fail-closed on case-insensitive volumes:
    /// a differently-cased path is refused, never accepted).
    Unix,
}

impl PathPlatform {
    pub(crate) fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// Why a drag was refused. Each names the path and the reason (AGENTS.md section 13).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DragSourceError {
    EmptyPath,
    PathTooLong,
    NulInPath,
    NotAbsolute(String),
    DevicePath(String),
    ParentComponent(String),
    BadComponent {
        path: String,
        component: String,
    },
    NotSvg(String),
    NoRoots,
    OutsideRoots(String),
    ResolvesOutsideRoots(String),
    NotFound(String),
    Unreadable {
        path: String,
        reason: String,
    },
    SymbolicLink(String),
    NotRegularFile(String),
    EmptyFile(String),
    TooLarge {
        path: String,
        bytes: u64,
    },
    WrongWindow(String),
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    Unsupported,
}

impl std::fmt::Display for DragSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        const P: &str = "Art drag refused";
        match self {
            Self::EmptyPath => write!(f, "{P}: no file path was given."),
            Self::PathTooLong => write!(f, "{P}: the path is longer than {MAX_PATH_CHARS} characters."),
            Self::NulInPath => write!(f, "{P}: the path contains a NUL character."),
            Self::NotAbsolute(path) => write!(f, "{P}: \"{path}\" is not an absolute path."),
            Self::DevicePath(path) => {
                write!(f, "{P}: \"{path}\" is a device or verbatim path, which is never dragged.")
            }
            Self::ParentComponent(path) => {
                write!(f, "{P}: \"{path}\" contains a \"..\" component.")
            }
            Self::BadComponent { path, component } => write!(
                f,
                "{P}: \"{path}\" has a name the file system would alter or treat as a device (\"{component}\")."
            ),
            Self::NotSvg(path) => write!(f, "{P}: \"{path}\" is not an .svg file."),
            Self::NoRoots => write!(
                f,
                "{P}: neither the app-data art folder nor the bundled art folder exists."
            ),
            Self::OutsideRoots(path) => write!(
                f,
                "{P}: \"{path}\" is outside the art library folders (app data \"{APP_DATA_ART_FOLDER}\" and bundled \"{RESOURCE_ART_FOLDER}\")."
            ),
            Self::ResolvesOutsideRoots(path) => write!(
                f,
                "{P}: \"{path}\" leads outside the art library folders through a link."
            ),
            Self::NotFound(path) => write!(f, "{P}: \"{path}\" does not exist."),
            Self::Unreadable { path, reason } => {
                write!(f, "{P}: \"{path}\" could not be inspected: {reason}.")
            }
            Self::SymbolicLink(path) => write!(f, "{P}: \"{path}\" is a symbolic link."),
            Self::NotRegularFile(path) => write!(f, "{P}: \"{path}\" is not a regular file."),
            Self::EmptyFile(path) => write!(f, "{P}: \"{path}\" is empty."),
            Self::TooLarge { path, bytes } => write!(
                f,
                "{P}: \"{path}\" is {bytes} bytes; the limit is {MAX_DRAG_FILE_BYTES} bytes."
            ),
            Self::WrongWindow(label) => {
                write!(f, "{P}: window \"{label}\" may not start an art drag.")
            }
            Self::Unsupported => write!(f, "{P}: dragging art out is not available on this platform yet."),
        }
    }
}

/// A path split into a comparable root (`/`, `c:`, `\\server\share`) and its components.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LexicalPath {
    prefix: String,
    components: Vec<String>,
    platform: PathPlatform,
}

impl LexicalPath {
    /// Whether `self` is strictly inside `root` (the root itself is not a file to drag).
    pub(crate) fn is_strictly_inside(&self, root: &LexicalPath) -> bool {
        if self.platform != root.platform || self.components.len() <= root.components.len() {
            return false;
        }
        let same = |a: &str, b: &str| match self.platform {
            PathPlatform::Windows => a.to_lowercase() == b.to_lowercase(),
            PathPlatform::Unix => a == b,
        };
        same(&self.prefix, &root.prefix)
            && root
                .components
                .iter()
                .zip(&self.components)
                .all(|(r, c)| same(r, c))
    }

    fn file_name(&self) -> Option<&str> {
        self.components.last().map(String::as_str)
    }
}

/// Windows device names, reserved with any extension (`con.svg` opens the console).
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "conin$", "conout$", "com1", "com2", "com3", "com4", "com5",
    "com6", "com7", "com8", "com9", "com¹", "com²", "com³", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5",
    "lpt6", "lpt7", "lpt8", "lpt9", "lpt¹", "lpt²", "lpt³",
];

fn check_component(
    path: &str,
    component: &str,
    platform: PathPlatform,
) -> Result<(), DragSourceError> {
    if component == ".." {
        return Err(DragSourceError::ParentComponent(path.to_string()));
    }
    let bad = || DragSourceError::BadComponent {
        path: path.to_string(),
        component: component.to_string(),
    };
    if component.chars().any(char::is_control) {
        return Err(bad());
    }
    if platform == PathPlatform::Windows {
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(bad());
        }
        if component
            .chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        {
            return Err(bad());
        }
        let stem = component
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end()
            .to_lowercase();
        if WINDOWS_RESERVED_NAMES.contains(&stem.as_str()) {
            return Err(bad());
        }
    }
    Ok(())
}

/// Parses `raw` by `platform`'s rules without touching the file system.
///
/// `verbatim_ok` is for paths this process produced itself (a canonicalized root or file, which on
/// Windows comes back as `\\?\C:\…` or `\\?\UNC\server\share\…`); input from a webview passes
/// `false`, so those forms, and `\\.\` device paths, are refused.
pub(crate) fn parse_lexical(
    raw: &str,
    platform: PathPlatform,
    verbatim_ok: bool,
) -> Result<LexicalPath, DragSourceError> {
    if raw.is_empty() {
        return Err(DragSourceError::EmptyPath);
    }
    if raw.chars().count() > MAX_PATH_CHARS {
        return Err(DragSourceError::PathTooLong);
    }
    if raw.contains('\0') {
        return Err(DragSourceError::NulInPath);
    }
    let owned = raw.to_string();
    let (prefix, rest) = match platform {
        PathPlatform::Unix => {
            let Some(rest) = raw.strip_prefix('/') else {
                return Err(DragSourceError::NotAbsolute(owned));
            };
            ("/".to_string(), rest.to_string())
        }
        PathPlatform::Windows => {
            let text = raw.replace('/', "\\");
            let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
                if !verbatim_ok {
                    return Err(DragSourceError::DevicePath(owned));
                }
                format!(r"\\{rest}")
            } else if let Some(rest) = text.strip_prefix(r"\\?\") {
                if !verbatim_ok {
                    return Err(DragSourceError::DevicePath(owned));
                }
                rest.to_string()
            } else {
                text
            };
            if text.starts_with(r"\\.\") || text.starts_with(r"\??\") || text.starts_with(r"\\?\") {
                return Err(DragSourceError::DevicePath(owned));
            }
            if let Some(share) = text.strip_prefix(r"\\") {
                let mut parts = share.splitn(3, '\\');
                let server = parts.next().unwrap_or("");
                let share_name = parts.next().unwrap_or("");
                if server.is_empty() || share_name.is_empty() {
                    return Err(DragSourceError::NotAbsolute(owned));
                }
                for part in [server, share_name] {
                    check_component(raw, part, platform)?;
                }
                (
                    format!(r"\\{server}\{share_name}"),
                    parts.next().unwrap_or("").to_string(),
                )
            } else {
                let bytes = text.as_bytes();
                let drive = bytes.len() >= 3
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && bytes[2] == b'\\';
                if !drive {
                    return Err(DragSourceError::NotAbsolute(owned));
                }
                (text[..2].to_string(), text[3..].to_string())
            }
        }
    };
    let separators: &[char] = match platform {
        PathPlatform::Windows => &['\\'],
        PathPlatform::Unix => &['/'],
    };
    let mut components = Vec::new();
    for component in rest.split(separators) {
        if component.is_empty() || component == "." {
            continue;
        }
        check_component(raw, component, platform)?;
        components.push(component.to_string());
    }
    Ok(LexicalPath {
        prefix,
        components,
        platform,
    })
}

fn has_svg_extension(path: &LexicalPath) -> bool {
    path.file_name()
        .and_then(|name| name.rsplit_once('.'))
        .is_some_and(|(stem, extension)| !stem.is_empty() && extension.eq_ignore_ascii_case("svg"))
}

/// The text-only half of the guard: syntax, extension, and containment in a root by text. Nothing
/// on disk is read, so a path outside every root (a network share, say) is refused untouched.
pub(crate) fn check_lexical(
    raw: &str,
    roots: &[PathBuf],
    platform: PathPlatform,
) -> Result<LexicalPath, DragSourceError> {
    let candidate = parse_lexical(raw, platform, false)?;
    if !has_svg_extension(&candidate) {
        return Err(DragSourceError::NotSvg(raw.to_string()));
    }
    let inside = roots.iter().any(|root| {
        parse_lexical(&root.to_string_lossy(), platform, true)
            .is_ok_and(|root| candidate.is_strictly_inside(&root))
    });
    if inside {
        Ok(candidate)
    } else {
        Err(DragSourceError::OutsideRoots(raw.to_string()))
    }
}

/// The whole guard. `roots` are the allow-listed folders as the app resolves them; a root missing on
/// disk is skipped. Returns the canonical path to hand to the operating system.
pub(crate) fn resolve_drag_source(
    raw: &str,
    roots: &[PathBuf],
    platform: PathPlatform,
) -> Result<PathBuf, DragSourceError> {
    check_lexical(raw, roots, platform)?;
    let path = Path::new(raw);
    let unreadable = |error: std::io::Error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DragSourceError::NotFound(raw.to_string())
        } else {
            DragSourceError::Unreadable {
                path: raw.to_string(),
                reason: error.to_string(),
            }
        }
    };
    let link = std::fs::symlink_metadata(path).map_err(unreadable)?;
    if link.file_type().is_symlink() {
        return Err(DragSourceError::SymbolicLink(raw.to_string()));
    }
    let canonical = std::fs::canonicalize(path).map_err(unreadable)?;
    let canonical_roots: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();
    if canonical_roots.is_empty() {
        return Err(DragSourceError::NoRoots);
    }
    let resolved = parse_lexical(&canonical.to_string_lossy(), platform, true)
        .map_err(|_| DragSourceError::ResolvesOutsideRoots(raw.to_string()))?;
    let contained = canonical_roots.iter().any(|root| {
        parse_lexical(&root.to_string_lossy(), platform, true)
            .is_ok_and(|root| resolved.is_strictly_inside(&root))
    });
    if !contained || !has_svg_extension(&resolved) {
        return Err(DragSourceError::ResolvesOutsideRoots(raw.to_string()));
    }
    let metadata = std::fs::metadata(&canonical).map_err(unreadable)?;
    if !metadata.is_file() {
        return Err(DragSourceError::NotRegularFile(raw.to_string()));
    }
    if metadata.len() == 0 {
        return Err(DragSourceError::EmptyFile(raw.to_string()));
    }
    if metadata.len() > MAX_DRAG_FILE_BYTES {
        return Err(DragSourceError::TooLarge {
            path: raw.to_string(),
            bytes: metadata.len(),
        });
    }
    Ok(canonical)
}

/// The allow-listed roots for this app: `<app data>/art-library` and `<resource dir>/art`.
fn allowed_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let paths = app.path();
    [
        paths
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(APP_DATA_ART_FOLDER)),
        paths
            .resource_dir()
            .ok()
            .map(|dir| dir.join(RESOURCE_ART_FOLDER)),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub(crate) fn may_start_drag(window_label: &str) -> bool {
    DRAG_SOURCE_WINDOW_PREFIXES
        .iter()
        .any(|prefix| window_label.starts_with(prefix) && window_label.len() > prefix.len())
}

/// A small PNG of the SVG for the drag image, or a plain tile when it cannot be drawn. Always a
/// valid PNG: the macOS drag aborts the process on image bytes it cannot read.
pub(crate) fn drag_preview_png(svg: &[u8]) -> Vec<u8> {
    render_preview(svg).unwrap_or_else(placeholder_preview)
}

fn render_preview(svg: &[u8]) -> Option<Vec<u8>> {
    use resvg::{tiny_skia, usvg};
    // Never resolve a file path or URL from the SVG; text draws only if a font is embedded.
    let options = usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    };
    let tree = usvg::Tree::from_data(svg, &options).ok()?;
    let size = tree.size();
    let scale = (PREVIEW_SIZE as f32 / size.width().max(size.height())).min(8.0);
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let width = ((size.width() * scale).ceil() as u32).clamp(1, PREVIEW_SIZE);
    let height = ((size.height() * scale).ceil() as u32).clamp(1, PREVIEW_SIZE);
    let mut pixmap = tiny_skia::Pixmap::new(width, height)?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let rgba: Vec<u8> = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let c = pixel.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect();
    encode_png(width, height, rgba)
}

fn placeholder_preview() -> Vec<u8> {
    let side = PREVIEW_SIZE / 2;
    let rgba = [0xd0, 0xd4, 0xda, 0xff].repeat((side * side) as usize);
    encode_png(side, side, rgba).expect("a fixed RGBA tile always encodes")
}

fn encode_png(width: u32, height: u32, rgba: Vec<u8>) -> Option<Vec<u8>> {
    let image = image::RgbaImage::from_raw(width, height, rgba)?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .ok()?;
    Some(bytes.into_inner())
}

/// How a drag ended, sent to the source window once.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DragEnded {
    /// `"dropped"` when a target accepted the file, `"cancelled"` otherwise.
    pub outcome: &'static str,
    /// Screen position where the drag ended, as the drag library reports it (points from the top
    /// of the main display on macOS; physical pixels on Windows).
    pub x: i32,
    pub y: i32,
}

/// Starts an operating-system file drag of one SVG from the calling window.
///
/// Resolves once the drag has started (macOS) or finished (Windows, where `DoDragDrop` runs its
/// own loop until the drop); `on_end` receives how it ended either way.
#[tauri::command]
pub(crate) async fn art_library_start_drag<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    path: String,
    on_end: Channel<DragEnded>,
) -> Result<(), String> {
    if !may_start_drag(window.label()) {
        return Err(DragSourceError::WrongWindow(window.label().to_string()).to_string());
    }
    let file = resolve_drag_source(&path, &allowed_roots(&app), PathPlatform::current())
        .map_err(|error| error.to_string())?;
    let svg = std::fs::read(&file).map_err(|error| {
        DragSourceError::Unreadable {
            path: path.clone(),
            reason: error.to_string(),
        }
        .to_string()
    })?;
    let preview = drag_preview_png(&svg);
    start_native_drag(&app, window, file, preview, on_end).await
}

#[cfg(any(target_os = "macos", windows))]
async fn start_native_drag<R: Runtime>(
    app: &AppHandle<R>,
    window: WebviewWindow<R>,
    file: PathBuf,
    preview: Vec<u8>,
    on_end: Channel<DragEnded>,
) -> Result<(), String> {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    // AppKit requires the main thread; on Windows DoDragDrop needs the window's (OLE STA) thread.
    app.run_on_main_thread(move || {
        let started = drag::start_drag(
            &window,
            drag::DragItem::Files(vec![file]),
            drag::Image::Raw(preview),
            move |result, cursor| {
                let outcome = match result {
                    drag::DragResult::Dropped => "dropped",
                    drag::DragResult::Cancel => "cancelled",
                };
                log::info!("art drag ended: {outcome} at ({}, {})", cursor.x, cursor.y);
                let _ = on_end.send(DragEnded {
                    outcome,
                    x: cursor.x,
                    y: cursor.y,
                });
            },
            drag::Options::default(),
        );
        let _ =
            started_tx.send(started.map_err(|error| format!("Art drag could not start: {error}.")));
    })
    .map_err(|error| format!("Art drag could not start: {error}."))?;
    started_rx
        .await
        .map_err(|_| "Art drag could not start: the main thread did not answer.".to_string())?
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn start_native_drag<R: Runtime>(
    _app: &AppHandle<R>,
    _window: WebviewWindow<R>,
    _file: PathBuf,
    _preview: Vec<u8>,
    _on_end: Channel<DragEnded>,
) -> Result<(), String> {
    Err(DragSourceError::Unsupported.to_string())
}

// ---------------------------------------------------------------------------------------------
// DEV-ONLY drag harness. Remove in phase 3 of docs/plans/art-library.md, together with the
// "Drag test" tile in apps/desktop/src/artLibrary/DragTestTile.tsx and its capability entry.
// ---------------------------------------------------------------------------------------------

/// The identifier every development launch uses (`run-app`, `run-app --dev`, `pnpm dev`, branch
/// builds); the stable app is `org.chemdraft.desktop`.
const DEV_APP_IDENTIFIER: &str = "org.chemdraft.desktop.dev";

/// The harness exists only in a development build that also carries a worktree label. The
/// identifier keeps it out of a stable build even if a stale label leaks in (an unsigned local
/// stable build is labelled "UNSIGNED"); the label keeps it out of an unlabelled package.
pub(crate) fn dev_harness_enabled(identifier: &str, worktree_label: Option<&str>) -> bool {
    identifier == DEV_APP_IDENTIFIER && worktree_label.is_some_and(|label| !label.trim().is_empty())
}

/// A fixed, plain SVG: a flask outline with a label-free badge. Written by Rust, never from input.
pub(crate) const DRAG_TEST_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect x="4" y="4" width="88" height="88" rx="14" fill="#eef4fb" stroke="#2f6db5" stroke-width="4"/>
  <path d="M38 20h20M42 20v20L26 72a6 6 0 0 0 5 8h34a6 6 0 0 0 5-8L54 40V20" fill="#cfe2f7" stroke="#2f6db5" stroke-width="4" stroke-linejoin="round"/>
  <circle cx="48" cy="64" r="6" fill="#2f6db5"/>
</svg>
"##;

pub(crate) const DRAG_TEST_FOLDER: &str = "spike";
pub(crate) const DRAG_TEST_FILE: &str = "drag-test.svg";

/// Writes the fixed SVG to `<art root>/spike/drag-test.svg` and returns its path. A link left at
/// either place is removed first, so the write can never follow it out of the folder.
pub(crate) fn write_drag_test_file(art_root: &Path) -> std::io::Result<PathBuf> {
    let folder = art_root.join(DRAG_TEST_FOLDER);
    for path in [art_root, folder.as_path()] {
        if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(std::io::Error::other(format!(
                "\"{}\" is a symbolic link",
                path.display()
            )));
        }
    }
    std::fs::create_dir_all(&folder)?;
    let file = folder.join(DRAG_TEST_FILE);
    if std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.file_type().is_symlink()) {
        std::fs::remove_file(&file)?;
    }
    std::fs::write(&file, DRAG_TEST_SVG)?;
    Ok(file)
}

/// DEV-ONLY. `None` in a stable build (nothing is written); otherwise the drag-test file's path.
#[tauri::command]
pub(crate) async fn art_library_dev_drag_test_prepare<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    if !dev_harness_enabled(
        &app.config().identifier,
        option_env!("CHEMDRAFT_WORKTREE_LABEL"),
    ) {
        return Ok(None);
    }
    if !may_start_drag(window.label()) {
        return Err(DragSourceError::WrongWindow(window.label().to_string()).to_string());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Drag test file not written: no app data folder ({error})."))?
        .join(APP_DATA_ART_FOLDER);
    let file = write_drag_test_file(&root)
        .map_err(|error| format!("Drag test file not written: {error}."))?;
    Ok(Some(file.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use PathPlatform::{Unix, Windows};

    fn roots(platform: PathPlatform) -> Vec<PathBuf> {
        match platform {
            Windows => vec![
                PathBuf::from(
                    r"C:\Users\Ada\AppData\Roaming\org.chemdraft.desktop.dev\art-library",
                ),
                PathBuf::from(r"C:\Program Files\ChemDraft\art"),
            ],
            Unix => vec![
                PathBuf::from(
                    "/Users/ada/Library/Application Support/org.chemdraft.desktop.dev/art-library",
                ),
                PathBuf::from("/Applications/ChemDraft.app/Contents/Resources/art"),
            ],
        }
    }

    fn lexical(raw: &str, platform: PathPlatform) -> Result<LexicalPath, DragSourceError> {
        check_lexical(raw, &roots(platform), platform)
    }

    #[test]
    fn unix_accepts_svg_inside_either_root() {
        for raw in [
            "/Users/ada/Library/Application Support/org.chemdraft.desktop.dev/art-library/spike/drag-test.svg",
            "/Applications/ChemDraft.app/Contents/Resources/art/bioart/antibody--flat.SVG",
            "/Applications/ChemDraft.app/Contents/Resources/art/./x.svg",
        ] {
            assert!(lexical(raw, Unix).is_ok(), "{raw}");
        }
    }

    #[test]
    fn unix_refuses_outside_traversal_relative_and_non_svg() {
        let cases = [
            (
                "/etc/passwd.svg",
                DragSourceError::OutsideRoots("/etc/passwd.svg".into()),
            ),
            (
                "/Applications/ChemDraft.app/Contents/Resources/art/../Info.svg",
                DragSourceError::ParentComponent(
                    "/Applications/ChemDraft.app/Contents/Resources/art/../Info.svg".into(),
                ),
            ),
            (
                "art/x.svg",
                DragSourceError::NotAbsolute("art/x.svg".into()),
            ),
            (
                "/Applications/ChemDraft.app/Contents/Resources/art/x.png",
                DragSourceError::NotSvg(
                    "/Applications/ChemDraft.app/Contents/Resources/art/x.png".into(),
                ),
            ),
            (
                "/Applications/ChemDraft.app/Contents/Resources/art/.svg",
                DragSourceError::NotSvg(
                    "/Applications/ChemDraft.app/Contents/Resources/art/.svg".into(),
                ),
            ),
            ("", DragSourceError::EmptyPath),
            ("/a\0.svg", DragSourceError::NulInPath),
        ];
        for (raw, expected) in cases {
            assert_eq!(lexical(raw, Unix).unwrap_err(), expected, "{raw}");
        }
        // The root itself, and a sibling sharing its text prefix, are not inside it.
        assert!(lexical(
            "/Applications/ChemDraft.app/Contents/Resources/art.svg",
            Unix
        )
        .is_err());
        assert!(lexical(
            "/Applications/ChemDraft.app/Contents/Resources/artwork/x.svg",
            Unix
        )
        .is_err());
        // Unix compares exactly: a differently-cased root is refused, never accepted.
        assert!(lexical(
            "/applications/ChemDraft.app/Contents/Resources/art/x.svg",
            Unix
        )
        .is_err());
        // Backslashes are ordinary characters on Unix, not separators.
        assert!(lexical(
            r"/Applications/ChemDraft.app/Contents/Resources/art\..\x.svg",
            Unix
        )
        .is_err());
        assert_eq!(
            lexical(&format!("/{}.svg", "a".repeat(MAX_PATH_CHARS)), Unix).unwrap_err(),
            DragSourceError::PathTooLong
        );
    }

    #[test]
    fn windows_accepts_either_separator_and_any_case() {
        for raw in [
            r"C:\Users\Ada\AppData\Roaming\org.chemdraft.desktop.dev\art-library\spike\drag-test.svg",
            r"c:\users\ada\appdata\roaming\ORG.CHEMDRAFT.DESKTOP.DEV\ART-LIBRARY\x.svg",
            "C:/Program Files/ChemDraft/art/bioart/antibody--flat.svg",
            r"C:\Program Files\ChemDraft/art\\x.Svg",
        ] {
            assert!(lexical(raw, Windows).is_ok(), "{raw}");
        }
    }

    #[test]
    fn windows_refuses_unc_device_verbatim_and_relative_forms() {
        for raw in [
            r"\\attacker\share\art-library\x.svg",
            r"//attacker/share/x.svg",
            r"\\?\C:\Program Files\ChemDraft\art\x.svg",
            r"\\?\UNC\attacker\share\x.svg",
            r"\\.\C:\Program Files\ChemDraft\art\x.svg",
            r"\??\C:\Program Files\ChemDraft\art\x.svg",
            r"C:Program Files\ChemDraft\art\x.svg",
            r"\Program Files\ChemDraft\art\x.svg",
            r"D:\Program Files\ChemDraft\art\x.svg",
            r"C:\Program Files\ChemDraft\art\..\..\x.svg",
            r"C:\Program Files\ChemDraft\art\x.svg:hidden",
            r"C:\Program Files\ChemDraft\art\x.svg::$DATA",
            r"C:\Program Files\ChemDraft\art\x.svg.",
            r"C:\Program Files\ChemDraft\art\x.svg ",
            r"C:\Program Files\ChemDraft\art\con.svg",
            r"C:\Program Files\ChemDraft\art\LPT1.svg",
            r"C:\Program Files\ChemDraft\art\x?.svg",
            r"C:\Program Files\ChemDraft\artwork\x.svg",
            r"C:\Program Files\ChemDraft\art.svg",
        ] {
            assert!(lexical(raw, Windows).is_err(), "{raw}");
        }
        assert!(matches!(
            lexical(r"\\attacker\share\x.svg", Windows),
            Err(DragSourceError::OutsideRoots(_))
        ));
        assert!(matches!(
            lexical(r"\\?\C:\Program Files\ChemDraft\art\x.svg", Windows),
            Err(DragSourceError::DevicePath(_))
        ));
        assert!(matches!(
            lexical(r"C:Program Files\ChemDraft\art\x.svg", Windows),
            Err(DragSourceError::NotAbsolute(_))
        ));
    }

    #[test]
    fn windows_roots_and_canonical_paths_may_be_verbatim_or_on_a_share() {
        // std::fs::canonicalize on Windows returns verbatim paths; containment sees through them.
        let root = parse_lexical(r"\\?\C:\Program Files\ChemDraft\art", Windows, true).unwrap();
        let file =
            parse_lexical(r"\\?\c:\program files\chemdraft\ART\x.svg", Windows, true).unwrap();
        assert!(file.is_strictly_inside(&root));
        // A redirected AppData folder on a share works when the root itself is on that share.
        let share_root =
            parse_lexical(r"\\?\UNC\Corp\Home$\ada\art-library", Windows, true).unwrap();
        let share_file =
            parse_lexical(r"\\corp\home$\Ada\art-library\x.svg", Windows, false).unwrap();
        assert!(share_file.is_strictly_inside(&share_root));
        let other_share =
            parse_lexical(r"\\corp\other\ada\art-library\x.svg", Windows, false).unwrap();
        assert!(!other_share.is_strictly_inside(&share_root));
        assert!(check_lexical(
            r"\\corp\home$\ada\art-library\x.svg",
            &[PathBuf::from(r"\\?\UNC\corp\home$\ada\art-library")],
            Windows
        )
        .is_ok());
        // Rules never mix: a Unix path is not inside a Windows root.
        let unix = parse_lexical("/c/x.svg", Unix, false).unwrap();
        assert!(!unix.is_strictly_inside(&root));
    }

    #[test]
    fn errors_name_the_path_and_the_reason() {
        let message = lexical("/etc/passwd.svg", Unix).unwrap_err().to_string();
        assert!(message.contains("/etc/passwd.svg") && message.contains("outside the art library"));
        let message = DragSourceError::TooLarge {
            path: "/a.svg".into(),
            bytes: 5,
        }
        .to_string();
        assert!(message.contains("5 bytes") && message.contains(&MAX_DRAG_FILE_BYTES.to_string()));
    }

    /// A unique scratch folder, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "chemdraft-art-drag-{name}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(std::fs::canonicalize(&dir).unwrap())
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn host_path(path: &Path) -> String {
        // The webview never sends a verbatim path; hand the guard what it would receive.
        let text = path.to_string_lossy().into_owned();
        text.strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or(text)
    }

    #[test]
    fn real_files_pass_only_when_regular_bounded_svgs_inside_a_root() {
        let scratch = Scratch::new("files");
        let root = scratch.0.join("art-library");
        let file = write_drag_test_file(&root).unwrap();
        let roots = vec![
            root.clone(),
            scratch.0.join("missing-resources").join("art"),
        ];
        let platform = PathPlatform::current();
        let resolved = resolve_drag_source(&host_path(&file), &roots, platform).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&file).unwrap());

        let missing = root.join("spike").join("missing.svg");
        assert!(matches!(
            resolve_drag_source(&host_path(&missing), &roots, platform),
            Err(DragSourceError::NotFound(_))
        ));
        let folder = root.join("folder.svg");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(matches!(
            resolve_drag_source(&host_path(&folder), &roots, platform),
            Err(DragSourceError::NotRegularFile(_))
        ));
        let empty = root.join("empty.svg");
        std::fs::write(&empty, b"").unwrap();
        assert!(matches!(
            resolve_drag_source(&host_path(&empty), &roots, platform),
            Err(DragSourceError::EmptyFile(_))
        ));
        let large = root.join("large.svg");
        let handle = std::fs::File::create(&large).unwrap();
        handle.set_len(MAX_DRAG_FILE_BYTES + 1).unwrap();
        assert!(matches!(
            resolve_drag_source(&host_path(&large), &roots, platform),
            Err(DragSourceError::TooLarge { .. })
        ));
        let outside = scratch.0.join("outside.svg");
        std::fs::write(&outside, DRAG_TEST_SVG).unwrap();
        assert!(matches!(
            resolve_drag_source(&host_path(&outside), &roots, platform),
            Err(DragSourceError::OutsideRoots(_))
        ));
        // With no root on disk at all, nothing passes.
        let gone = vec![scratch.0.join("nope").join("art-library")];
        let ghost = scratch.0.join("nope").join("art-library").join("x.svg");
        assert!(matches!(
            resolve_drag_source(&host_path(&ghost), &gone, platform),
            Err(DragSourceError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn links_cannot_escape_a_root() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("links");
        let root = scratch.0.join("art-library");
        std::fs::create_dir_all(&root).unwrap();
        let secret_dir = scratch.0.join("secret");
        std::fs::create_dir_all(&secret_dir).unwrap();
        let secret = secret_dir.join("x.svg");
        std::fs::write(&secret, DRAG_TEST_SVG).unwrap();
        let roots = vec![root.clone()];

        // A link as the file itself, even one pointing inside, is refused.
        symlink(&secret, root.join("leaf.svg")).unwrap();
        assert!(matches!(
            resolve_drag_source(&host_path(&root.join("leaf.svg")), &roots, Unix),
            Err(DragSourceError::SymbolicLink(_))
        ));
        // A linked folder inside the root leads out of it.
        symlink(&secret_dir, root.join("linked")).unwrap();
        assert!(matches!(
            resolve_drag_source(&host_path(&root.join("linked").join("x.svg")), &roots, Unix),
            Err(DragSourceError::ResolvesOutsideRoots(_))
        ));
        // The harness writer never follows a link left at the file's place.
        let spike = root.join(DRAG_TEST_FOLDER);
        std::fs::create_dir_all(&spike).unwrap();
        let victim = scratch.0.join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        symlink(&victim, spike.join(DRAG_TEST_FILE)).unwrap();
        write_drag_test_file(&root).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert_eq!(
            std::fs::read_to_string(spike.join(DRAG_TEST_FILE)).unwrap(),
            DRAG_TEST_SVG
        );
        // Nor writes through a linked spike folder.
        let elsewhere = scratch.0.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let root2 = scratch.0.join("art-library-2");
        std::fs::create_dir_all(&root2).unwrap();
        symlink(&elsewhere, root2.join(DRAG_TEST_FOLDER)).unwrap();
        assert!(write_drag_test_file(&root2).is_err());
        assert!(!elsewhere.join(DRAG_TEST_FILE).exists());
    }

    #[cfg(windows)]
    #[test]
    fn links_cannot_escape_a_root() {
        use std::os::windows::fs::symlink_file;
        let scratch = Scratch::new("links");
        let root = scratch.0.join("art-library");
        std::fs::create_dir_all(&root).unwrap();
        let secret = scratch.0.join("x.svg");
        std::fs::write(&secret, DRAG_TEST_SVG).unwrap();
        // Creating a symbolic link needs Developer Mode or elevation; without it there is nothing
        // to test, and the lexical and canonical checks above still apply.
        if symlink_file(&secret, root.join("leaf.svg")).is_err() {
            return;
        }
        assert!(matches!(
            resolve_drag_source(&host_path(&root.join("leaf.svg")), &[root], Windows),
            Err(DragSourceError::SymbolicLink(_))
        ));
    }

    #[test]
    fn only_dialog_windows_that_host_art_tiles_may_start_a_drag() {
        assert!(may_start_drag("dialog-main-structureTemplates-3"));
        for label in [
            "main",
            "dialog-main-structureTemplates-",
            "dialog-main-export-1",
            "plugin-panel-x",
            "toolset-core-main",
            "preferences",
        ] {
            assert!(!may_start_drag(label), "{label}");
        }
    }

    #[test]
    fn the_shipped_acl_grants_the_commands_only_to_the_templates_dialog() {
        use crate::plugin_panel_acl_tests::assert_shipped_access;
        let commands = [
            "art_library_start_drag",
            "art_library_dev_drag_test_prepare",
        ];
        // The capability is macOS and Windows only; Linux resolves it away.
        let expected = cfg!(any(target_os = "macos", windows));
        assert_shipped_access("dialog-main-structureTemplates-1", &commands, expected);
        for label in [
            "main",
            "dialog-main-export-1",
            "dialog-main-pageSize-1",
            "plugin-panel-x",
            "preferences",
            "toolset-core-main",
            "toolset-popover-core-art",
            "spin3d-debugger",
        ] {
            assert_shipped_access(label, &commands, false);
        }
    }

    #[test]
    fn the_drag_preview_is_always_a_png() {
        let preview = drag_preview_png(DRAG_TEST_SVG.as_bytes());
        assert!(preview.starts_with(b"\x89PNG\r\n\x1a\n"));
        let image = image::load_from_memory(&preview).unwrap();
        assert_eq!(
            (image.width(), image.height()),
            (PREVIEW_SIZE, PREVIEW_SIZE)
        );
        for broken in [
            &b"not svg"[..],
            b"",
            b"<svg xmlns='http://www.w3.org/2000/svg' width='0' height='0'/>",
        ] {
            let fallback = drag_preview_png(broken);
            assert!(image::load_from_memory(&fallback).is_ok());
        }
        // A file reference in the SVG is never followed.
        let linked = br#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image width="10" height="10" xlink:href="/etc/hosts"/></svg>"#;
        assert!(image::load_from_memory(&drag_preview_png(linked)).is_ok());
    }

    #[test]
    fn the_harness_exists_only_in_labelled_development_builds() {
        assert!(dev_harness_enabled(DEV_APP_IDENTIFIER, Some("wt [branch]")));
        assert!(!dev_harness_enabled(DEV_APP_IDENTIFIER, None));
        assert!(!dev_harness_enabled(DEV_APP_IDENTIFIER, Some("  ")));
        assert!(!dev_harness_enabled(
            "org.chemdraft.desktop",
            Some("wt [branch]")
        ));
        assert!(!dev_harness_enabled(
            "org.chemdraft.desktop",
            Some("UNSIGNED")
        ));
        assert!(!dev_harness_enabled("org.chemdraft.desktop", None));
        assert!(!dev_harness_enabled(
            "org.chemdraft.desktop.dev.other",
            Some("wt")
        ));
    }

    #[test]
    fn the_shipped_config_is_the_stable_identity() {
        // The harness keys on the dev identifier; the checked-in config must stay the stable one,
        // so a build that is not explicitly a development launch never shows it.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "org.chemdraft.desktop");
        assert_ne!(config["identifier"], DEV_APP_IDENTIFIER);
    }
}
