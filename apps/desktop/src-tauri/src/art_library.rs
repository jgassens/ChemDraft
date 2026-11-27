//! The Library window's native side (docs/plans/art-library.md).
//!
//! Phase 0 holds one capability: start an operating-system FILE drag of one SVG from a floating
//! dialog window, so the file can land on a ChemDraft document (through the document window's
//! ordinary file drop, `file_drop.rs`), on Finder or Explorer, or in another app. The drag itself is
//! the `drag` crate (CrabNebula; `NSDraggingSession` on macOS, OLE `DoDragDrop` on Windows). Linux
//! has no drag yet: the command refuses there and the capability is not granted.
//!
//! [`art_library_start_drag`] is fail-closed. A path is accepted only when it
//! - is absolute and written plainly (no `..`, no Windows device, verbatim, drive-relative or UNC
//!   form, no alternate data stream, no reserved device name, no trailing dot or space),
//! - names an `.svg` file,
//! - lies inside an allow-listed root, `<app data>/art-library/` or `<resource dir>/art/`, by its
//!   text before anything on disk is touched,
//! - opens, ONCE and without following a link as the final component, to a regular, non-empty file
//!   under [`MAX_DRAG_FILE_BYTES`] whose own path (asked of the open handle, so it carries the true
//!   case and every link resolved) lies inside the canonical form of a root, compared exactly,
//! - and is not on a network location (a UNC share, a mapped network drive, a non-local volume).
//!
//! The bytes are then read from that same handle, bounded, and written to a fresh copy in an
//! app-owned local staging folder ([`DRAG_STAGING_FOLDER`] under the app's LOCAL data folder,
//! one `drag-<16 hex>` folder per drag, the original file name kept). The drag library only ever
//! receives that copy, never the original path, so nothing swapped in after the checks can be
//! dragged out, and the library is never handed a network path (its Windows code panics on one).
//! A copy is removed when its drag is cancelled or fails, [`DROPPED_COPY_GRACE`] after it is
//! dropped (the receiving app, our own document window included, reads it after the drag ends; the
//! sweep before each drag also measures a dropped copy's grace from its drop, not from staging), and
//! at startup once it is older than that same grace period (so a drag started while the startup
//! sweep runs keeps its copy). A drag whose Windows end cannot be told from a failed start (the
//! library may fail after the drop) keeps its copy for the grace period too. Removal is never
//! recursive: it unlinks the one staged file inside a `drag-<16 hex>` folder and then removes that
//! folder if it is empty, working relative to the staging folder opened at that moment as a real
//! folder (a link in its place is refused), and it never follows a link. The staging folder's
//! identity (device and inode on Unix, volume serial and file index on Windows) is recorded when a
//! copy is staged into it; cleanup reopens it by path and removes nothing when the folder found there
//! is a different one (an ancestor folder replaced or linked elsewhere). An identity is only ever
//! established (by staging or by the first cleanup in a process, the startup sweep included) when
//! the opened folder's own path, as the operating system reports it for the handle with every link
//! resolved, IS the staging path, name for name; a folder reached through a link anywhere on the
//! way (an ancestor replaced with a link before launch, say) is never adopted, and cleanup by path
//! then removes nothing and logs why.
//!
//! Threat model. The path guard defends against untrusted input from the webview naming arbitrary
//! paths. A local process running as the same user that renames or replaces folders inside app data
//! (an allow-listed root swapped after it was canonicalized, an ancestor of the harness's art root
//! replaced while it writes) is out of scope: it already has the user's privileges. The one
//! exception: our own cleanup must never delete anything outside the staging folder, whatever such
//! a process does, which is why removal is non-recursive and handle-relative.
//!
//! The lexical half takes the platform as a parameter so one host tests Windows rules (drive
//! letters, `\` and `/`, UNC shares, case-insensitive names) and Unix rules alike.
//!
//! DEV-ONLY drag harness (remove in phase 3): [`art_library_dev_drag_test_prepare`] writes a fixed
//! SVG for the "Drag test" tile in the Templates dialog of a labelled development build and returns
//! its path; a stable build returns `None` and writes nothing.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
/// Folder under the app's LOCAL data directory holding the per-drag copies the drag library is
/// given: `~/Library/Application Support/<identifier>/art-drag-staging` on macOS,
/// `%LOCALAPPDATA%\<identifier>\art-drag-staging` on Windows (local even when the roaming
/// profile is redirected to a share).
pub(crate) const DRAG_STAGING_FOLDER: &str = "art-drag-staging";
/// Prefix of each per-drag folder in the staging folder; the rest is 16 lowercase hex digits.
const STAGED_ENTRY_PREFIX: &str = "drag-";
/// How long a dropped copy stays, so the receiving app can finish reading it (Finder and Explorer
/// may copy in the background, and our document window reads a dropped file asynchronously).
pub(crate) const DROPPED_COPY_GRACE: Duration = Duration::from_secs(120);
/// Whether this build can start an operating-system file drag at all.
const DRAG_SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

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
    BadComponent { path: String, component: String },
    NotSvg(String),
    NoRoots,
    OutsideRoots(String),
    ResolvesOutsideRoots(String),
    NotFound(String),
    Unreadable { path: String, reason: String },
    SymbolicLink(String),
    NotRegularFile(String),
    EmptyFile(String),
    TooLarge { path: String, bytes: u64 },
    WrongWindow(String),
    NetworkLocation(String),
    Staging(String),
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
            Self::NetworkLocation(path) => write!(
                f,
                "{P}: \"{path}\" is on a network location (a UNC share or a mapped network drive); art is dragged only from and through local folders."
            ),
            Self::Staging(reason) => write!(
                f,
                "Art drag could not prepare its local copy of the file: {reason}."
            ),
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

/// How two path names are compared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NameMatch {
    /// Byte for byte. The only rule for CANONICAL paths: the operating system returns those with
    /// each name's true case, so a different case is a different directory entry. On a
    /// case-sensitive Windows directory, `art-library` and `ART-LIBRARY` are two siblings, and only
    /// an exact comparison tells them apart.
    Exact,
    /// Windows names ignoring case; Unix names exactly. Used ONLY by the text pre-check, whose
    /// input comes from the webview and may differ in case from the root as the app composes it
    /// (`AppData\Roaming` against `appdata\roaming`, say). That check only decides whether the
    /// disk is touched at all; the exact canonical check after opening decides whether the file is
    /// dragged.
    PlatformDefault,
}

impl LexicalPath {
    /// Whether `self` is strictly inside `root` (the root itself is not a file to drag), comparing
    /// names by `rule`.
    pub(crate) fn is_strictly_inside(&self, root: &LexicalPath, rule: NameMatch) -> bool {
        if self.platform != root.platform || self.components.len() <= root.components.len() {
            return false;
        }
        let same = |a: &str, b: &str| match (rule, self.platform) {
            (NameMatch::PlatformDefault, PathPlatform::Windows) => {
                a.to_lowercase() == b.to_lowercase()
            }
            _ => a == b,
        };
        same(&self.prefix, &root.prefix)
            && root
                .components
                .iter()
                .zip(&self.components)
                .all(|(r, c)| same(r, c))
    }

    /// Whether this is a network path by its text alone: a UNC share on Windows. A mapped network
    /// drive is a drive letter, so `drive_is_remote` is asked about drive prefixes (`"Z:"`).
    /// Unix paths carry no such mark; the volume is asked instead ([`os::is_network`]).
    pub(crate) fn is_network(&self, drive_is_remote: impl Fn(&str) -> bool) -> bool {
        match self.platform {
            PathPlatform::Windows => {
                self.prefix.starts_with(r"\\") || drive_is_remote(&self.prefix)
            }
            PathPlatform::Unix => false,
        }
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
/// on disk is read, so a path outside every root is refused untouched, and a UNC share is refused
/// before any network access (a mapped network drive is caught on the open handle).
pub(crate) fn check_lexical(
    raw: &str,
    roots: &[PathBuf],
    platform: PathPlatform,
) -> Result<LexicalPath, DragSourceError> {
    let candidate = parse_lexical(raw, platform, false)?;
    if candidate.is_network(|_| false) {
        return Err(DragSourceError::NetworkLocation(raw.to_string()));
    }
    if !has_svg_extension(&candidate) {
        return Err(DragSourceError::NotSvg(raw.to_string()));
    }
    let inside = roots.iter().any(|root| {
        parse_lexical(&root.to_string_lossy(), platform, true)
            .is_ok_and(|root| candidate.is_strictly_inside(&root, NameMatch::PlatformDefault))
    });
    if inside {
        Ok(candidate)
    } else {
        Err(DragSourceError::OutsideRoots(raw.to_string()))
    }
}

/// Whether `canonical`, a path the operating system returned for an open file, lies strictly
/// inside one of `canonical_roots` (also as the operating system returns them), comparing names
/// exactly, and still names an `.svg` file.
pub(crate) fn canonical_inside(
    canonical: &str,
    canonical_roots: &[PathBuf],
    platform: PathPlatform,
) -> bool {
    let Ok(resolved) = parse_lexical(canonical, platform, true) else {
        return false;
    };
    has_svg_extension(&resolved)
        && canonical_roots.iter().any(|root| {
            parse_lexical(&root.to_string_lossy(), platform, true)
                .is_ok_and(|root| resolved.is_strictly_inside(&root, NameMatch::Exact))
        })
}

/// An art file read for a drag: its name on disk and its bytes, taken from one open handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DragSource {
    /// The file's own name as the file system records it, which the receiving app will see.
    pub name: String,
    pub bytes: Vec<u8>,
}

/// The whole guard. `roots` are the allow-listed folders as the app resolves them; a root missing on
/// disk is skipped. The file is opened once, without following a link as its final component; the
/// open handle is validated (type, size, its own canonical path inside a canonical root, local
/// volume) and the bytes are read from it, at most [`MAX_DRAG_FILE_BYTES`] of them. The path is
/// never opened again, so swapping a link in after the checks changes nothing.
pub(crate) fn read_drag_source(
    raw: &str,
    roots: &[PathBuf],
    platform: PathPlatform,
) -> Result<DragSource, DragSourceError> {
    check_lexical(raw, roots, platform)?;
    let unreadable = |error: std::io::Error| DragSourceError::Unreadable {
        path: raw.to_string(),
        reason: error.to_string(),
    };
    let file = os::open_file_no_follow(Path::new(raw)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DragSourceError::NotFound(raw.to_string())
        } else if os::is_link_refusal(&error) {
            DragSourceError::SymbolicLink(raw.to_string())
        } else {
            unreadable(error)
        }
    })?;
    let metadata = file.metadata().map_err(unreadable)?;
    if metadata.file_type().is_symlink() {
        return Err(DragSourceError::SymbolicLink(raw.to_string()));
    }
    if !metadata.is_file() {
        return Err(DragSourceError::NotRegularFile(raw.to_string()));
    }
    let canonical_roots: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();
    if canonical_roots.is_empty() {
        return Err(DragSourceError::NoRoots);
    }
    let canonical = os::handle_path(&file).map_err(unreadable)?;
    let canonical_text = canonical.to_string_lossy();
    if !canonical_inside(&canonical_text, &canonical_roots, platform) {
        return Err(DragSourceError::ResolvesOutsideRoots(raw.to_string()));
    }
    let resolved = parse_lexical(&canonical_text, platform, true)
        .map_err(|_| DragSourceError::ResolvesOutsideRoots(raw.to_string()))?;
    if os::is_network(&file, &resolved).map_err(unreadable)? {
        return Err(DragSourceError::NetworkLocation(raw.to_string()));
    }
    let too_large = |bytes: u64| DragSourceError::TooLarge {
        path: raw.to_string(),
        bytes,
    };
    if metadata.len() == 0 {
        return Err(DragSourceError::EmptyFile(raw.to_string()));
    }
    if metadata.len() > MAX_DRAG_FILE_BYTES {
        return Err(too_large(metadata.len()));
    }
    // The file may have grown or shrunk since the handle was inspected; the read is bounded and
    // its result checked again.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&file)
        .take(MAX_DRAG_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    if bytes.is_empty() {
        return Err(DragSourceError::EmptyFile(raw.to_string()));
    }
    if bytes.len() as u64 > MAX_DRAG_FILE_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    let name = resolved
        .file_name()
        .ok_or_else(|| DragSourceError::ResolvesOutsideRoots(raw.to_string()))?
        .to_string();
    Ok(DragSource { name, bytes })
}

/// Which folder an open handle is, independent of its path: device and inode on Unix, volume
/// serial number and file index on Windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct FolderId {
    volume: u64,
    index: u64,
}

/// The staging folder last staged into (or first opened) at each staging path, by that path, so
/// cleanup can tell when the path has come to lead to a different folder.
fn known_staging_folders() -> &'static Mutex<HashMap<PathBuf, FolderId>> {
    static KNOWN: OnceLock<Mutex<HashMap<PathBuf, FolderId>>> = OnceLock::new();
    KNOWN.get_or_init(Default::default)
}

/// When each dropped copy (by its `drag-<16 hex>` folder name) was dropped, so the sweep measures
/// its grace period from the drop, not from when it was staged.
fn dropped_copies() -> &'static Mutex<HashMap<String, Instant>> {
    static DROPPED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    DROPPED.get_or_init(Default::default)
}

/// Whether the copy in folder `entry` was dropped less than `age` ago.
fn dropped_within(entry: &str, age: Duration) -> bool {
    dropped_copies()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(entry)
        .is_some_and(|dropped| dropped.elapsed() < age)
}

/// Whether `real`, the path the operating system reports for an open folder (every link
/// resolved), is the very location `expected` names: the same root and the same names, compared
/// exactly (only a Windows drive letter or share name ignores case). A path that is not valid text,
/// not absolute or not plainly written never matches, so an unverifiable folder is never adopted.
fn is_same_location(real: &Path, expected: &Path, platform: PathPlatform) -> bool {
    let parse = |path: &Path| {
        path.to_str()
            .and_then(|text| parse_lexical(text, platform, true).ok())
    };
    let (Some(real), Some(expected)) = (parse(real), parse(expected)) else {
        return false;
    };
    let same_prefix = match platform {
        PathPlatform::Windows => real.prefix.eq_ignore_ascii_case(&expected.prefix),
        PathPlatform::Unix => real.prefix == expected.prefix,
    };
    same_prefix && real.components == expected.components
}

/// Opens the staging folder at `path` for cleanup: a real folder (a link in its place is refused)
/// that is the very folder `expected` names, or, without `expected`, the folder last staged into
/// at `path`. When this process knows no folder for `path` yet (the startup sweep, say), the one
/// found is adopted only if its own path, asked of the open handle, is `path` itself, so a folder
/// reached through a link anywhere on the way is refused rather than trusted. A different or
/// unverifiable folder is refused, so nothing is removed from it.
fn open_staging_root_for_cleanup(
    path: &Path,
    expected: Option<FolderId>,
) -> std::io::Result<(File, PathBuf)> {
    let root = os::open_dir_no_follow(path)?;
    let found = os::folder_id(&root)?;
    let root_path = os::handle_path(&root)?;
    let known = match expected {
        Some(expected) => expected,
        None => {
            let mut known = known_staging_folders()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match known.get(path) {
                Some(known) => *known,
                None if is_same_location(&root_path, path, PathPlatform::current()) => {
                    known.insert(path.to_path_buf(), found);
                    found
                }
                None => {
                    return Err(std::io::Error::other(format!(
                        "\"{}\" leads to \"{}\", not to a staging folder at that path itself (a link on the way?); nothing was removed",
                        path.display(),
                        root_path.display()
                    )));
                }
            }
        }
    };
    if found != known {
        return Err(std::io::Error::other(format!(
            "\"{}\" is no longer the staging folder copies were staged into; nothing was removed",
            path.display()
        )));
    }
    Ok((root, root_path))
}

/// A staged copy: `<staging root>/<entry>/<file name>`, a fresh file made for one drag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StagedCopy {
    /// The staging root, as the operating system reports it for the open folder.
    pub root: PathBuf,
    /// The staging root's identity when the copy was staged; removal refuses any other folder.
    pub root_id: FolderId,
    /// This drag's own folder name in the root (`drag-<16 hex>`).
    pub entry: String,
    /// The file the drag library is given.
    pub file: PathBuf,
}

impl StagedCopy {
    /// Removes this copy and its folder now, only from the folder it was staged into. Errors are
    /// logged, never raised.
    pub(crate) fn remove(&self) {
        let file_name = self.file.file_name().and_then(|name| name.to_str());
        let removed = remove_staged_entry(&self.root, Some(self.root_id), &self.entry, file_name);
        dropped_copies()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.entry);
        if let Err(error) = removed {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "art drag: could not remove staged copy {}: {error}",
                    self.file.display()
                );
            }
        }
    }

    /// Records that a target accepted this copy now; its grace period runs from here. The record
    /// lives only in this process, so the copy's folder is also given the drop as its modification
    /// time: a later run's startup sweep then measures its age from the drop, not from staging.
    fn mark_dropped(&self) {
        dropped_copies()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(self.entry.clone(), Instant::now());
        if let Err(error) = self.set_folder_modified(std::time::SystemTime::now()) {
            log::warn!(
                "art drag: could not record the drop time of {}: {error}",
                self.file.display()
            );
        }
    }

    /// Sets this copy's per-drag folder's modification time, only in the folder it was staged
    /// into, through a handle opened relative to that folder (a link in its place is not followed).
    fn set_folder_modified(&self, time: std::time::SystemTime) -> std::io::Result<()> {
        let (root, root_path) = open_staging_root_for_cleanup(&self.root, Some(self.root_id))?;
        os::set_dir_modified_in(&root, &root_path, &self.entry, time)
    }

    /// Removes this copy after `grace`, on a background thread.
    pub(crate) fn remove_after(self, grace: Duration) {
        let spawned = std::thread::Builder::new()
            .name("art-drag-staging".into())
            .spawn(move || {
                std::thread::sleep(grace);
                self.remove();
            });
        if let Err(error) = spawned {
            log::warn!("art drag: could not schedule staged copy removal: {error}");
        }
    }
}

fn staged_entry_name() -> std::io::Result<String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(format!(
        "{STAGED_ENTRY_PREFIX}{:016x}",
        u64::from_le_bytes(random)
    ))
}

/// Whether `name` is a per-drag folder this module made; nothing else in the staging folder is
/// ever removed.
pub(crate) fn is_staged_entry_name(name: &str) -> bool {
    name.strip_prefix(STAGED_ENTRY_PREFIX).is_some_and(|hex| {
        hex.len() == 16
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Writes `bytes` to a new file `name` inside the open folder `dir` (whose path is `dir_path`):
/// created atomically (it must not exist; a link at its place is not followed), written through
/// that one handle, and verified to have landed in `dir`.
///
/// Deliberately NOT made read-only: Finder and Explorer keep that permission on the copy they make
/// at the drop target, which would leave the user's dropped file locked. The copy is private to
/// this drag (a fresh, randomly named folder) and nothing writes to it after this.
fn write_new_file_in(
    dir: &File,
    dir_path: &Path,
    name: &str,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    write_new_file_with(dir, dir_path, name, |file| {
        file.write_all(bytes)?;
        file.flush()
    })
}

/// [`write_new_file_in`] with the writing passed in. Once the file is created, a failure to write
/// it removes the partial file (relative to `dir`) before the error is returned.
fn write_new_file_with(
    dir: &File,
    dir_path: &Path,
    name: &str,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> std::io::Result<PathBuf> {
    let mut file = os::create_file_in(dir, dir_path, name)?;
    if let Err(error) = write(&mut file) {
        drop(file);
        let _ = os::remove_file_in(dir, dir_path, name);
        return Err(error);
    }
    Ok(dir_path.join(name))
}

/// Copies `source` into a new `drag-<16 hex>` folder of `staging_root` (created if missing) and
/// returns where. The root must be a real, local folder: a link, a UNC share or a mapped network
/// drive is refused.
pub(crate) fn stage_copy(
    staging_root: &Path,
    source: &DragSource,
    platform: PathPlatform,
) -> Result<StagedCopy, DragSourceError> {
    let fail = |error: std::io::Error| DragSourceError::Staging(error.to_string());
    std::fs::create_dir_all(staging_root).map_err(fail)?;
    let root = os::open_dir_no_follow(staging_root).map_err(fail)?;
    let root_id = os::folder_id(&root).map_err(fail)?;
    let root_path = os::handle_path(&root).map_err(fail)?;
    let root_lexical = parse_lexical(&root_path.to_string_lossy(), platform, true)
        .map_err(|error| DragSourceError::Staging(error.to_string()))?;
    if os::is_network(&root, &root_lexical).map_err(fail)? {
        return Err(DragSourceError::NetworkLocation(
            staging_root.to_string_lossy().into_owned(),
        ));
    }
    // This is now the staging folder at this path; cleanup by path refuses any other. A folder
    // reached through a link on the way is not adopted: this copy is still removed by its own
    // identity, but cleanup by path removes nothing there.
    if is_same_location(&root_path, staging_root, platform) {
        known_staging_folders()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(staging_root.to_path_buf(), root_id);
    }
    for _ in 0..8 {
        let entry = staged_entry_name().map_err(fail)?;
        match os::create_dir_in(&root, &root_path, &entry) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(fail(error)),
        }
        let entry_path = root_path.join(&entry);
        let written = os::open_dir_in(&root, &root_path, &entry)
            .and_then(|dir| write_new_file_in(&dir, &entry_path, &source.name, &source.bytes));
        return match written {
            Ok(file) => Ok(StagedCopy {
                root: root_path,
                root_id,
                entry,
                file,
            }),
            Err(error) => {
                let _ = remove_entry_in(&root, &root_path, &entry, Some(&source.name));
                Err(fail(error))
            }
        };
    }
    Err(DragSourceError::Staging(
        "no unused staging folder name was found".into(),
    ))
}

/// Removes `<staging_root>/<entry>` without following any link and without recursing. Refuses
/// names this module did not make, a staging root that is not a real folder at this moment (a link
/// in its place included), and a staging root that is not the folder copies were staged into
/// (`expected`, or the one recorded for `staging_root`), so nothing outside a per-drag folder of
/// the staging folder is ever deleted. `staged_file` is the copy's file name when known; otherwise
/// the folder may hold at most one entry.
pub(crate) fn remove_staged_entry(
    staging_root: &Path,
    expected: Option<FolderId>,
    entry: &str,
    staged_file: Option<&str>,
) -> std::io::Result<()> {
    if !is_staged_entry_name(entry) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("\"{entry}\" is not a staging folder"),
        ));
    }
    let (root, root_path) = open_staging_root_for_cleanup(staging_root, expected)?;
    remove_entry_in(&root, &root_path, entry, staged_file)
}

/// Removes the per-drag entry `entry` of the open staging folder `root`: a link or file in its
/// place is unlinked as itself; a real folder has its one staged file unlinked and is then removed
/// only if empty. Nothing is ever removed recursively.
fn remove_entry_in(
    root: &File,
    root_path: &Path,
    entry: &str,
    staged_file: Option<&str>,
) -> std::io::Result<()> {
    if !is_staged_entry_name(entry) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("\"{entry}\" is not a staging folder"),
        ));
    }
    let dir = match os::open_dir_in(root, root_path, entry) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(error),
        // A link or a file where the folder was: remove that entry itself, never its target.
        Err(_) => return os::remove_file_in(root, root_path, entry),
    };
    let dir_path = root_path.join(entry);
    let names: Vec<String> = match staged_file {
        Some(name) => vec![name.to_string()],
        None => {
            let mut names = Vec::new();
            for child in std::fs::read_dir(os::handle_path(&dir)?)? {
                let child = child?.file_name();
                let Some(child) = child.to_str() else {
                    return Err(std::io::Error::other(format!(
                        "\"{entry}\" holds a file whose name is not valid text"
                    )));
                };
                names.push(child.to_string());
            }
            if names.len() > 1 {
                return Err(std::io::Error::other(format!(
                    "\"{entry}\" holds more than the one staged file"
                )));
            }
            names
        }
    };
    for name in &names {
        match os::remove_file_in(&dir, &dir_path, name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    drop(dir);
    os::remove_dir_in(root, root_path, entry)
}

/// Removes every per-drag folder in `staging_root` (only those older than `older_than`, when
/// given, a dropped copy's age counting from its drop). The root itself must be a real folder, not
/// a link, and the folder last staged into at that path; it is opened once and every removal works
/// relative to that handle. Returns how many were removed.
pub(crate) fn sweep_staging(staging_root: &Path, older_than: Option<Duration>) -> usize {
    let (root, root_path) = match open_staging_root_for_cleanup(staging_root, None) {
        Ok(opened) => opened,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("art drag: staging folder not swept: {error}");
            }
            return 0;
        }
    };
    let Ok(entries) = std::fs::read_dir(&root_path) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| is_staged_entry_name(name)) else {
            continue;
        };
        if let Some(age) = older_than {
            if dropped_within(name, age) {
                continue;
            }
            let old_enough = std::fs::symlink_metadata(root_path.join(name))
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|elapsed| elapsed >= age);
            if !old_enough {
                continue;
            }
        }
        match remove_entry_in(&root, &root_path, name, None) {
            Ok(()) => removed += 1,
            Err(error) => log::warn!("art drag: could not remove staged folder {name}: {error}"),
        }
    }
    removed
}

/// The startup sweep: copies a previous run left behind, but only those older than
/// [`DROPPED_COPY_GRACE`]. It runs on a background thread, uncoordinated with drags, so a copy this
/// process stages meanwhile (always younger than that) is never touched; a younger leftover from an
/// earlier run goes at the next drag's sweep instead.
pub(crate) fn sweep_staging_at_startup(staging_root: &Path) -> usize {
    sweep_staging(staging_root, Some(DROPPED_COPY_GRACE))
}

fn drag_staging_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, DragSourceError> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(DRAG_STAGING_FOLDER))
        .map_err(|error| DragSourceError::Staging(format!("no local app data folder ({error})")))
}

/// Removes the staged copies a previous run left behind ([`sweep_staging_at_startup`]). Runs on a
/// background thread.
pub(crate) fn clean_drag_staging_at_startup<R: Runtime>(app: &AppHandle<R>) {
    let Ok(root) = drag_staging_root(app) else {
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("art-drag-staging-cleanup".into())
        .spawn(move || {
            let removed = sweep_staging_at_startup(&root);
            if removed > 0 {
                log::info!("art drag: removed {removed} staged copies left by an earlier run");
            }
        });
    if let Err(error) = spawned {
        log::warn!("art drag: could not start staging cleanup: {error}");
    }
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

/// The gzip magic. usvg inflates gzip input without a size limit, so it is refused unparsed.
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

fn render_preview(svg: &[u8]) -> Option<Vec<u8>> {
    use resvg::{tiny_skia, usvg};
    if svg.starts_with(&GZIP_MAGIC) {
        return None;
    }
    // Never resolve a file path or URL from the SVG; text draws only if a font is embedded. A
    // gzip-compressed `data:` image (an embedded SVGZ, at any depth) is not drawn either.
    let default_data = usvg::ImageHrefResolver::default_data_resolver();
    let options = usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(
                move |mime: &str, data: std::sync::Arc<Vec<u8>>, options: &usvg::Options| {
                    if data.starts_with(&GZIP_MAGIC) {
                        return None;
                    }
                    default_data(mime, data, options)
                },
            ),
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
/// The drag carries a fresh local copy of the file (see the module notes), never the original.
/// Resolves once the drag has started (macOS) or finished (Windows, where `DoDragDrop` runs its
/// own loop until the drop); `on_end` receives how it ended either way. A drag that cannot start,
/// the drag library panicking included, rejects with a message and removes its copy.
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
    if !DRAG_SUPPORTED {
        return Err(DragSourceError::Unsupported.to_string());
    }
    let platform = PathPlatform::current();
    let source = read_drag_source(&path, &allowed_roots(&app), platform)
        .map_err(|error| error.to_string())?;
    let staging_root = drag_staging_root(&app).map_err(|error| error.to_string())?;
    // Copies whose removal never ran (a crash, a lost end callback) go before a new one is made.
    sweep_staging(&staging_root, Some(DROPPED_COPY_GRACE));
    let staged = stage_copy(&staging_root, &source, platform).map_err(|error| error.to_string())?;
    let preview = drag_preview_png(&source.bytes);
    start_native_drag(&app, window, staged, preview, on_end).await
}

/// Runs `start`, turning a panic into an error, so a failure inside the drag library rejects the
/// drag instead of unwinding into the event loop (which aborts the process). The panic hook still
/// runs and records the panic.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn guard_drag_panic(start: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(start)) {
        Ok(result) => result,
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "no message".into());
            log::error!("art drag: the drag library panicked: {message}");
            Err(format!(
                "Art drag could not start: the system drag failed ({message})."
            ))
        }
    }
}

/// What happens to a staged copy when its drag ends: removed at once when nothing took it, kept
/// for [`DROPPED_COPY_GRACE`] when a target accepted it.
fn finish_staged_copy(staged: StagedCopy, dropped: bool) {
    if dropped {
        staged.mark_dropped();
        staged.remove_after(DROPPED_COPY_GRACE);
    } else {
        staged.remove();
    }
}

/// Whether `error` from `drag::start_drag` may have been raised after a target accepted the file.
/// On Windows the library runs `DoDragDrop` to its end and then asks for the cursor position,
/// returning that call's error without reporting the drop; only its errors raised before
/// `DoDragDrop` (resolving the file, an unsupported window) are a certain failed start. On macOS
/// the call returns as soon as the drag session begins, so every error is a failed start.
#[cfg(any(target_os = "macos", windows))]
fn drag_error_may_follow_a_drop(error: &drag::Error) -> bool {
    if cfg!(windows) {
        !matches!(
            error,
            drag::Error::Io(_) | drag::Error::UnsupportedWindowHandle
        )
    } else {
        false
    }
}

#[cfg(any(target_os = "macos", windows))]
async fn start_native_drag<R: Runtime>(
    app: &AppHandle<R>,
    window: WebviewWindow<R>,
    staged: StagedCopy,
    preview: Vec<u8>,
    on_end: Channel<DragEnded>,
) -> Result<(), String> {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let file = staged.file.clone();
    let on_failure = staged.clone();
    let on_ended = staged.clone();
    // AppKit requires the main thread; on Windows DoDragDrop needs the window's (OLE STA) thread.
    let dispatched = app.run_on_main_thread(move || {
        let mut may_have_dropped = false;
        let started = guard_drag_panic(|| {
            drag::start_drag(
                &window,
                drag::DragItem::Files(vec![file]),
                drag::Image::Raw(preview),
                move |result, cursor| {
                    // Called from AppKit or OLE: a panic here would abort, so none may escape.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let dropped = matches!(result, drag::DragResult::Dropped);
                        let outcome = if dropped { "dropped" } else { "cancelled" };
                        log::info!("art drag ended: {outcome} at ({}, {})", cursor.x, cursor.y);
                        let _ = on_end.send(DragEnded {
                            outcome,
                            x: cursor.x,
                            y: cursor.y,
                        });
                        finish_staged_copy(on_ended.clone(), dropped);
                    }));
                },
                drag::Options::default(),
            )
            .map_err(|error| {
                may_have_dropped = drag_error_may_follow_a_drop(&error);
                format!("Art drag could not start: {error}.")
            })
        });
        if started.is_err() {
            // An error that may have come after a target accepted the file keeps the copy for the
            // grace period, as a drop does; a failed start removes it at once.
            finish_staged_copy(on_failure, may_have_dropped);
        }
        let _ = started_tx.send(started);
    });
    if let Err(error) = dispatched {
        staged.remove();
        return Err(format!("Art drag could not start: {error}."));
    }
    match started_rx.await {
        Ok(result) => result,
        Err(_) => {
            staged.remove();
            Err("Art drag could not start: the main thread did not answer.".to_string())
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn start_native_drag<R: Runtime>(
    _app: &AppHandle<R>,
    _window: WebviewWindow<R>,
    staged: StagedCopy,
    _preview: Vec<u8>,
    _on_end: Channel<DragEnded>,
) -> Result<(), String> {
    finish_staged_copy(staged, false);
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

/// Writes the fixed SVG to `<art root>/spike/drag-test.svg` and returns its path. Neither folder
/// may be a link. The SVG goes to a new, uniquely named file in the open spike folder (created
/// atomically, never through a link) and is then renamed over `drag-test.svg`, which replaces
/// whatever entry was there (a link or a hard link included) instead of writing through it.
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
    let dir = os::open_dir_no_follow(&folder)?;
    let temporary = format!(".{DRAG_TEST_FILE}.{}.tmp", staged_entry_name()?);
    write_new_file_in(&dir, &folder, &temporary, DRAG_TEST_SVG.as_bytes())?;
    if let Err(error) = os::rename_in(&dir, &folder, &temporary, DRAG_TEST_FILE) {
        let _ = os::remove_file_in(&dir, &folder, &temporary);
        return Err(error);
    }
    Ok(folder.join(DRAG_TEST_FILE))
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

/// File-system primitives that must not follow links, one side per platform.
///
/// Unix works relative to open folder descriptors (`openat`, `mkdirat`, `renameat`, `unlinkat`), so a folder
/// swapped for a link after it was opened is never written through. Windows has no such calls in
/// the standard library; it holds each folder open WITHOUT delete sharing, which stops the folder
/// being renamed, removed or replaced while held, opens with `FILE_FLAG_OPEN_REPARSE_POINT` (a link
/// is opened as itself, never followed), and checks each created file's final path afterwards.
#[cfg(unix)]
mod os {
    use std::ffi::CString;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    use super::{FolderId, LexicalPath};

    fn c_name(name: &str) -> io::Result<CString> {
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("\"{name}\" is not a single file name"),
            ));
        }
        CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in name"))
    }

    fn from_fd(fd: libc::c_int) -> io::Result<File> {
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: `fd` was just returned open by the kernel and is owned by nothing else.
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    /// Opens a file to read. A link as the final component fails (`ELOOP`); a FIFO does not block.
    pub(super) fn open_file_no_follow(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
    }

    pub(super) fn is_link_refusal(error: &io::Error) -> bool {
        error.raw_os_error() == Some(libc::ELOOP)
    }

    /// Opens a folder; a link as the final component fails.
    pub(super) fn open_dir_no_follow(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(path)
    }

    /// The open folder's device and inode.
    pub(super) fn folder_id(dir: &File) -> io::Result<FolderId> {
        use std::os::unix::fs::MetadataExt;
        let metadata = dir.metadata()?;
        Ok(FolderId {
            volume: metadata.dev(),
            index: metadata.ino(),
        })
    }

    pub(super) fn open_dir_in(parent: &File, _parent_path: &Path, name: &str) -> io::Result<File> {
        let name = c_name(name)?;
        // SAFETY: a valid descriptor and NUL-terminated name.
        from_fd(unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })
    }

    pub(super) fn create_dir_in(parent: &File, _parent_path: &Path, name: &str) -> io::Result<()> {
        let name = c_name(name)?;
        // SAFETY: a valid descriptor and NUL-terminated name.
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Sets the modification time of the folder `name` in the open folder `parent`, through a
    /// descriptor opened relative to it (a link in its place is refused).
    pub(super) fn set_dir_modified_in(
        parent: &File,
        parent_path: &Path,
        name: &str,
        time: SystemTime,
    ) -> io::Result<()> {
        open_dir_in(parent, parent_path, name)?.set_modified(time)
    }

    /// Creates `name` in `parent`; fails if anything, a link included, is already there.
    pub(super) fn create_file_in(
        parent: &File,
        _parent_path: &Path,
        name: &str,
    ) -> io::Result<File> {
        let name = c_name(name)?;
        let mode: libc::c_uint = 0o644;
        // SAFETY: a valid descriptor and NUL-terminated name; `mode` is the variadic argument.
        from_fd(unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode,
            )
        })
    }

    pub(super) fn rename_in(dir: &File, _dir_path: &Path, from: &str, to: &str) -> io::Result<()> {
        let (from, to) = (c_name(from)?, c_name(to)?);
        let fd = dir.as_raw_fd();
        // SAFETY: a valid descriptor and NUL-terminated names.
        if unsafe { libc::renameat(fd, from.as_ptr(), fd, to.as_ptr()) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Unlinks `name` in `dir`: a file, or a link as itself. A folder is refused (never recursed).
    pub(super) fn remove_file_in(dir: &File, _dir_path: &Path, name: &str) -> io::Result<()> {
        let name = c_name(name)?;
        // SAFETY: a valid descriptor and NUL-terminated name.
        if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Removes the EMPTY folder `name` in `dir`; a link in its place is refused, not followed.
    pub(super) fn remove_dir_in(dir: &File, _dir_path: &Path, name: &str) -> io::Result<()> {
        let name = c_name(name)?;
        // SAFETY: a valid descriptor and NUL-terminated name.
        if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// The open file's own path, with every link resolved and each name's true case.
    #[cfg(target_os = "macos")]
    pub(super) fn handle_path(file: &File) -> io::Result<PathBuf> {
        use std::os::unix::ffi::OsStrExt;
        let mut buffer = vec![0u8; libc::PATH_MAX as usize + 1];
        // SAFETY: F_GETPATH writes at most PATH_MAX bytes, NUL-terminated, into `buffer`.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
            return Err(io::Error::last_os_error());
        }
        let length = buffer.iter().position(|&byte| byte == 0).unwrap_or(0);
        if length == 0 {
            return Err(io::Error::other("the system returned no path for the file"));
        }
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(
            &buffer[..length],
        )))
    }

    #[cfg(not(target_os = "macos"))]
    pub(super) fn handle_path(file: &File) -> io::Result<PathBuf> {
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
    }

    /// Whether the open file or folder is on a volume that is not local.
    #[cfg(target_os = "macos")]
    pub(super) fn is_network(file: &File, _path: &LexicalPath) -> io::Result<bool> {
        // SAFETY: `statfs` is plain data; fstatfs fills it for a valid descriptor.
        let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(file.as_raw_fd(), &mut stats) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(stats.f_flags & libc::MNT_LOCAL as u32 == 0)
    }

    /// Linux has no drag (refused before anything is read); nothing to classify.
    #[cfg(not(target_os = "macos"))]
    pub(super) fn is_network(_file: &File, _path: &LexicalPath) -> io::Result<bool> {
        Ok(false)
    }
}

#[cfg(windows)]
mod os {
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetFileInformationByHandle, GetFinalPathNameByHandleW,
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
        VOLUME_NAME_DOS,
    };

    use super::{FolderId, LexicalPath};

    /// `DRIVE_REMOTE` from `GetDriveTypeW` (WindowsProgramming, a feature not otherwise needed).
    const DRIVE_REMOTE: u32 = 4;

    fn checked_name(name: &str) -> io::Result<&str> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['\\', '/', ':']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("\"{name}\" is not a single file name"),
            ));
        }
        Ok(name)
    }

    /// Opens a file to read, as itself if it is a link (the caller refuses that), sharing it only
    /// with readers so it cannot change while it is read.
    pub(super) fn open_file_no_follow(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
    }

    /// Windows opens a link as itself; the caller sees it in the handle's metadata.
    pub(super) fn is_link_refusal(_error: &io::Error) -> bool {
        false
    }

    /// Opens a real folder (not a link or junction) and holds it without delete sharing. Only
    /// attribute access is asked for, which takes no part in sharing checks, so creating and
    /// renaming files inside it still works while it is held.
    pub(super) fn open_dir_no_follow(path: &Path) -> io::Result<File> {
        let dir = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        let metadata = dir.metadata()?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(io::Error::other(format!(
                "\"{}\" is not a plain folder",
                path.display()
            )));
        }
        Ok(dir)
    }

    /// The open folder's volume serial number and file index.
    pub(super) fn folder_id(dir: &File) -> io::Result<FolderId> {
        // SAFETY: plain data, filled in by the call below for an open handle.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `dir` is open (with attribute access) and `info` is a valid out pointer.
        if unsafe { GetFileInformationByHandle(dir.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(FolderId {
            volume: u64::from(info.dwVolumeSerialNumber),
            index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        })
    }

    /// Fails unless `child` (opened by path) is `name` directly inside the open folder `parent`.
    fn verify_child(parent: &File, child: &File, name: &str) -> io::Result<()> {
        if handle_path(child)? == handle_path(parent)?.join(name) {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "\"{name}\" did not land in the folder it was created in"
            )))
        }
    }

    pub(super) fn open_dir_in(parent: &File, parent_path: &Path, name: &str) -> io::Result<File> {
        let dir = open_dir_no_follow(&parent_path.join(checked_name(name)?))?;
        verify_child(parent, &dir, name)?;
        Ok(dir)
    }

    pub(super) fn create_dir_in(_parent: &File, parent_path: &Path, name: &str) -> io::Result<()> {
        std::fs::create_dir(parent_path.join(checked_name(name)?))
    }

    /// Sets the modification time of the real folder `name` in the open folder `parent` (a link or
    /// junction in its place is refused, never followed). Opened as [`open_dir_in`] does, plus the
    /// attribute-writing access setting a time needs.
    pub(super) fn set_dir_modified_in(
        parent: &File,
        parent_path: &Path,
        name: &str,
        time: SystemTime,
    ) -> io::Result<()> {
        let path = parent_path.join(checked_name(name)?);
        let dir = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(&path)?;
        let metadata = dir.metadata()?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(io::Error::other(format!(
                "\"{}\" is not a plain folder",
                path.display()
            )));
        }
        verify_child(parent, &dir, name)?;
        dir.set_modified(time)
    }

    /// Creates `name` in `parent` (`CREATE_NEW`: fails if anything, a link included, is there).
    pub(super) fn create_file_in(
        parent: &File,
        parent_path: &Path,
        name: &str,
    ) -> io::Result<File> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(parent_path.join(checked_name(name)?))?;
        verify_child(parent, &file, name)?;
        Ok(file)
    }

    pub(super) fn rename_in(_dir: &File, dir_path: &Path, from: &str, to: &str) -> io::Result<()> {
        // The folder is held without delete sharing, so these names stay inside it.
        std::fs::rename(
            dir_path.join(checked_name(from)?),
            dir_path.join(checked_name(to)?),
        )
    }

    /// Removes `name` in the open folder `dir`: a file, or a link or junction as itself (neither call
    /// follows one). A real folder is refused (never recursed). The folder is held without delete
    /// sharing, so the name stays inside it.
    pub(super) fn remove_file_in(_dir: &File, dir_path: &Path, name: &str) -> io::Result<()> {
        let path = dir_path.join(checked_name(name)?);
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            return Err(io::Error::other(format!("\"{name}\" is a folder")));
        }
        if metadata.file_type().is_symlink() {
            std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path))
        } else {
            std::fs::remove_file(&path)
        }
    }

    /// Removes the EMPTY folder `name` in the open folder `dir` (`RemoveDirectoryW`, which removes
    /// a link or junction as itself and never empties a folder). The folder is held without delete
    /// sharing, so the name stays inside it.
    pub(super) fn remove_dir_in(_dir: &File, dir_path: &Path, name: &str) -> io::Result<()> {
        std::fs::remove_dir(dir_path.join(checked_name(name)?))
    }

    /// The open file's own path (`\\?\C:\…` or `\\?\UNC\…`), as `std::fs::canonicalize` returns it.
    pub(super) fn handle_path(file: &File) -> io::Result<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        let handle = file.as_raw_handle();
        let mut buffer = vec![0u16; 512];
        loop {
            // SAFETY: `handle` is open; the call writes at most `buffer.len()` wide characters.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    VOLUME_NAME_DOS,
                )
            } as usize;
            if length == 0 {
                return Err(io::Error::last_os_error());
            }
            if length < buffer.len() {
                return Ok(PathBuf::from(std::ffi::OsString::from_wide(
                    &buffer[..length],
                )));
            }
            buffer.resize(length + 1, 0);
        }
    }

    /// A UNC path, or a drive the system reports as a network drive.
    pub(super) fn is_network(_file: &File, path: &LexicalPath) -> io::Result<bool> {
        Ok(path.is_network(|drive| {
            let root: Vec<u16> = std::ffi::OsStr::new(&format!("{drive}\\"))
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            // SAFETY: a NUL-terminated wide string.
            unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
        }))
    }
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
        // A UNC share is refused as a network location before anything else is checked.
        for raw in [
            r"\\attacker\share\x.svg",
            r"//attacker/share/art-library/x.svg",
        ] {
            assert_eq!(
                lexical(raw, Windows).unwrap_err(),
                DragSourceError::NetworkLocation(raw.into()),
                "{raw}"
            );
        }
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
    fn windows_canonical_paths_may_be_verbatim_and_compare_exactly() {
        // std::fs::canonicalize on Windows returns verbatim paths; containment sees through them.
        let root = r"\\?\C:\Program Files\ChemDraft\art";
        let roots = [PathBuf::from(root)];
        assert!(canonical_inside(
            r"\\?\C:\Program Files\ChemDraft\art\bioart\x.svg",
            &roots,
            Windows
        ));
        // Canonical paths carry each name's true case, so a different case is a different entry.
        assert!(!canonical_inside(
            r"\\?\c:\program files\chemdraft\ART\x.svg",
            &roots,
            Windows
        ));
        assert!(!canonical_inside(
            r"\\?\C:\Program Files\ChemDraft\art\x.png",
            &roots,
            Windows
        ));
        assert!(!canonical_inside(
            r"\\?\C:\Program Files\ChemDraft\art",
            &roots,
            Windows
        ));
        // Rules never mix: a Unix path is not inside a Windows root.
        let unix = parse_lexical("/c/x.svg", Unix, false).unwrap();
        let windows_root = parse_lexical(root, Windows, true).unwrap();
        assert!(!unix.is_strictly_inside(&windows_root, NameMatch::Exact));
        assert!(!unix.is_strictly_inside(&windows_root, NameMatch::PlatformDefault));
    }

    #[test]
    fn windows_case_sensitive_sibling_of_a_root_is_outside_it() {
        // A Windows directory with case sensitivity on (fsutil file setCaseSensitiveInfo) may hold
        // both `art-library` and `ART-LIBRARY`. Their canonical paths differ only by case, and the
        // second is NOT inside the first.
        let base = r"\\?\C:\Users\Ada\AppData\Roaming\org.chemdraft.desktop.dev";
        let roots = [PathBuf::from(format!(r"{base}\art-library"))];
        assert!(canonical_inside(
            &format!(r"{base}\art-library\spike\drag-test.svg"),
            &roots,
            Windows
        ));
        for sibling in [
            format!(r"{base}\ART-LIBRARY\spike\drag-test.svg"),
            format!(r"{base}\Art-Library\x.svg"),
            format!(r"{base}\art-library\..\ART-LIBRARY\x.svg"),
        ] {
            assert!(!canonical_inside(&sibling, &roots, Windows), "{sibling}");
        }
        // Same rule for the drive letter and the share name of the root.
        assert!(!canonical_inside(
            r"\\?\c:\Users\Ada\AppData\Roaming\org.chemdraft.desktop.dev\art-library\x.svg",
            &roots,
            Windows
        ));
        // The text pre-check alone still ignores case on Windows (webview text may differ in case
        // from the root as composed); it only decides whether the disk is touched.
        let sibling = parse_lexical(
            r"C:\Users\Ada\AppData\Roaming\org.chemdraft.desktop.dev\ART-LIBRARY\x.svg",
            Windows,
            false,
        )
        .unwrap();
        let root = parse_lexical(&roots[0].to_string_lossy(), Windows, true).unwrap();
        assert!(sibling.is_strictly_inside(&root, NameMatch::PlatformDefault));
        assert!(!sibling.is_strictly_inside(&root, NameMatch::Exact));
    }

    #[test]
    fn unix_canonical_containment_is_exact() {
        let roots = [PathBuf::from(
            "/Users/ada/Library/Application Support/x/art-library",
        )];
        assert!(canonical_inside(
            "/Users/ada/Library/Application Support/x/art-library/a.svg",
            &roots,
            Unix
        ));
        assert!(!canonical_inside(
            "/Users/ada/Library/Application Support/x/ART-LIBRARY/a.svg",
            &roots,
            Unix
        ));
    }

    #[test]
    fn network_locations_are_recognised_by_platform() {
        let never = |_: &str| false;
        for (raw, verbatim) in [
            (r"\\?\UNC\corp\home$\ada\art-library\x.svg", true),
            (r"\\corp\home$\ada\x.svg", false),
        ] {
            let path = parse_lexical(raw, Windows, verbatim).unwrap();
            assert!(path.is_network(never), "{raw}");
        }
        // A mapped network drive is a drive letter; the system is asked about it.
        let mapped = parse_lexical(r"\\?\Z:\art-library\x.svg", Windows, true).unwrap();
        assert!(mapped.is_network(|drive| drive.eq_ignore_ascii_case("Z:")));
        assert!(!mapped.is_network(never));
        let local = parse_lexical(r"\\?\C:\art\x.svg", Windows, true).unwrap();
        assert!(!local.is_network(|drive| drive.eq_ignore_ascii_case("Z:")));
        // Unix text carries no network mark; the volume is asked instead.
        let unix = parse_lexical("/Volumes/share/x.svg", Unix, false).unwrap();
        assert!(!unix.is_network(|_| true));
        // UNC roots no longer make a UNC file acceptable: the share itself is refused.
        assert!(matches!(
            check_lexical(
                r"\\corp\home$\ada\art-library\x.svg",
                &[PathBuf::from(r"\\?\UNC\corp\home$\ada\art-library")],
                Windows
            ),
            Err(DragSourceError::NetworkLocation(_))
        ));
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn a_panic_in_the_drag_library_rejects_instead_of_unwinding() {
        let error = guard_drag_panic(|| panic!("get_file_data_object returned None")).unwrap_err();
        assert!(error.contains("could not start"), "{error}");
        assert!(error.contains("get_file_data_object"), "{error}");
        let owned = guard_drag_panic(|| std::panic::panic_any(String::from("owned"))).unwrap_err();
        assert!(owned.contains("owned"), "{owned}");
        assert_eq!(guard_drag_panic(|| Ok(())), Ok(()));
        assert_eq!(
            guard_drag_panic(|| Err("plain".into())),
            Err("plain".to_string())
        );
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
        let source = read_drag_source(&host_path(&file), &roots, platform).unwrap();
        assert_eq!(source.name, DRAG_TEST_FILE);
        assert_eq!(source.bytes, DRAG_TEST_SVG.as_bytes());

        let missing = root.join("spike").join("missing.svg");
        assert!(matches!(
            read_drag_source(&host_path(&missing), &roots, platform),
            Err(DragSourceError::NotFound(_))
        ));
        let folder = root.join("folder.svg");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(matches!(
            read_drag_source(&host_path(&folder), &roots, platform),
            Err(DragSourceError::NotRegularFile(_))
        ));
        let empty = root.join("empty.svg");
        std::fs::write(&empty, b"").unwrap();
        assert!(matches!(
            read_drag_source(&host_path(&empty), &roots, platform),
            Err(DragSourceError::EmptyFile(_))
        ));
        let large = root.join("large.svg");
        let handle = std::fs::File::create(&large).unwrap();
        handle.set_len(MAX_DRAG_FILE_BYTES + 1).unwrap();
        // Closed before the guard opens it: on Windows the guard shares the file only with readers,
        // which an open writer would refuse (an `Unreadable` error instead of `TooLarge`).
        drop(handle);
        assert!(matches!(
            read_drag_source(&host_path(&large), &roots, platform),
            Err(DragSourceError::TooLarge { .. })
        ));
        let outside = scratch.0.join("outside.svg");
        std::fs::write(&outside, DRAG_TEST_SVG).unwrap();
        assert!(matches!(
            read_drag_source(&host_path(&outside), &roots, platform),
            Err(DragSourceError::OutsideRoots(_))
        ));
        // With no root on disk at all, nothing passes.
        let gone = vec![scratch.0.join("nope").join("art-library")];
        let ghost = scratch.0.join("nope").join("art-library").join("x.svg");
        assert!(matches!(
            read_drag_source(&host_path(&ghost), &gone, platform),
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
            read_drag_source(&host_path(&root.join("leaf.svg")), &roots, Unix),
            Err(DragSourceError::SymbolicLink(_))
        ));
        // A linked folder inside the root leads out of it.
        symlink(&secret_dir, root.join("linked")).unwrap();
        assert!(matches!(
            read_drag_source(&host_path(&root.join("linked").join("x.svg")), &roots, Unix),
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
            read_drag_source(&host_path(&root.join("leaf.svg")), &[root], Windows),
            Err(DragSourceError::SymbolicLink(_))
        ));
    }

    #[test]
    fn the_drag_is_given_a_fresh_local_copy_never_the_original() {
        let scratch = Scratch::new("staging");
        let root = scratch.0.join("art-library");
        let original = write_drag_test_file(&root).unwrap();
        let platform = PathPlatform::current();
        let source =
            read_drag_source(&host_path(&original), std::slice::from_ref(&root), platform).unwrap();
        let staging = scratch.0.join("local").join(DRAG_STAGING_FOLDER);
        let first = stage_copy(&staging, &source, platform).unwrap();
        let second = stage_copy(&staging, &source, platform).unwrap();

        // A unique folder per drag, inside the staging folder, keeping the original file name.
        let canonical_staging = std::fs::canonicalize(&staging).unwrap();
        assert_ne!(first.entry, second.entry);
        for staged in [&first, &second] {
            assert!(is_staged_entry_name(&staged.entry), "{}", staged.entry);
            assert_eq!(
                std::fs::canonicalize(&staged.file).unwrap(),
                canonical_staging.join(&staged.entry).join(DRAG_TEST_FILE)
            );
            assert_ne!(
                std::fs::canonicalize(&staged.file).unwrap(),
                std::fs::canonicalize(&original).unwrap()
            );
            assert_eq!(
                std::fs::read(&staged.file).unwrap(),
                DRAG_TEST_SVG.as_bytes()
            );
            // Not read-only: the drop target's copy would inherit that and be locked.
            assert!(!std::fs::metadata(&staged.file)
                .unwrap()
                .permissions()
                .readonly());
        }
        // The copy is the bytes read once: replacing the original afterwards changes nothing.
        std::fs::remove_file(&original).unwrap();
        std::fs::write(&original, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        assert_eq!(
            std::fs::read(&first.file).unwrap(),
            DRAG_TEST_SVG.as_bytes()
        );

        // Removal deletes exactly that copy's folder.
        first.remove();
        assert!(!canonical_staging.join(&first.entry).exists());
        assert!(second.file.exists());
        assert!(original.exists());
    }

    #[test]
    fn staging_cleanup_removes_only_its_own_folders() {
        let scratch = Scratch::new("sweep");
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let platform = PathPlatform::current();
        let staged = stage_copy(&staging, &source, platform).unwrap();
        // Things that are not staging folders stay, whatever they are called.
        let keep_file = staging.join("notes.txt");
        std::fs::write(&keep_file, b"keep").unwrap();
        let keep_dir = staging.join("drag-NOTHEX0000000000");
        std::fs::create_dir_all(&keep_dir).unwrap();
        // Recent copies survive a sweep with a grace period; a full sweep removes them.
        assert_eq!(sweep_staging(&staging, Some(Duration::from_secs(3600))), 0);
        assert!(staged.file.exists());
        assert_eq!(sweep_staging(&staging, None), 1);
        assert!(!staged.file.exists());
        assert!(keep_file.exists() && keep_dir.exists());
        // Names this module did not make are refused outright.
        for name in [
            "..",
            "notes.txt",
            "drag-",
            "drag-0123456789ABCDEF",
            "drag-0123/../x",
        ] {
            assert!(
                remove_staged_entry(&staging, None, name, None).is_err(),
                "{name}"
            );
        }
        assert!(is_staged_entry_name("drag-0123456789abcdef"));
        // A missing staging folder is simply nothing to do.
        assert_eq!(sweep_staging(&scratch.0.join("missing"), None), 0);
    }

    #[cfg(unix)]
    #[test]
    fn staging_never_follows_links() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("staging-links");
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        // A staging folder that is a link is refused, and nothing is written at its target.
        let elsewhere = scratch.0.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let linked = scratch.0.join("linked-staging");
        symlink(&elsewhere, &linked).unwrap();
        assert!(matches!(
            stage_copy(&linked, &source, Unix),
            Err(DragSourceError::Staging(_))
        ));
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
        // Cleanup removes a link in a staging folder's place, never what it points to.
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        std::fs::create_dir_all(&staging).unwrap();
        let victim = elsewhere.join("victim.svg");
        std::fs::write(&victim, b"keep").unwrap();
        symlink(&elsewhere, staging.join("drag-0123456789abcdef")).unwrap();
        assert_eq!(sweep_staging(&staging, None), 1);
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        // A staging root that is itself a link is never swept.
        symlink(&elsewhere, scratch.0.join("drag-root-link")).unwrap();
        std::fs::create_dir_all(elsewhere.join("drag-fedcba9876543210")).unwrap();
        assert_eq!(sweep_staging(&scratch.0.join("drag-root-link"), None), 0);
        assert!(elsewhere.join("drag-fedcba9876543210").exists());
    }

    #[test]
    fn the_startup_sweep_keeps_copies_younger_than_the_grace_period() {
        let scratch = Scratch::new("startup-sweep");
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        // A drag staged while the startup sweep runs keeps its copy.
        let fresh = stage_copy(&staging, &source, PathPlatform::current()).unwrap();
        assert_eq!(sweep_staging_at_startup(&staging), 0);
        assert!(fresh.file.exists());
        // A leftover older than the grace period goes.
        let old = stage_copy(&staging, &source, PathPlatform::current()).unwrap();
        let aged = std::time::SystemTime::now() - DROPPED_COPY_GRACE - Duration::from_secs(60);
        set_modified_dir(&old.root.join(&old.entry), aged);
        assert_eq!(sweep_staging_at_startup(&staging), 1);
        assert!(!old.root.join(&old.entry).exists());
        assert!(fresh.file.exists());
    }

    fn set_modified_dir(dir: &Path, time: std::time::SystemTime) {
        #[cfg(windows)]
        let handle = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
                .open(dir)
                .unwrap()
        };
        #[cfg(not(windows))]
        let handle = File::open(dir).unwrap();
        handle.set_modified(time).unwrap();
    }

    #[test]
    fn staging_removal_never_recurses() {
        let scratch = Scratch::new("no-recurse");
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let staged = stage_copy(&staging, &source, PathPlatform::current()).unwrap();
        // Something other than the one staged file inside a drag folder is never removed.
        let nested = staged.root.join(&staged.entry).join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("keep.txt"), b"keep").unwrap();
        staged.remove();
        assert!(!staged.file.exists());
        assert_eq!(std::fs::read(nested.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(sweep_staging(&staging, None), 0);
        assert_eq!(std::fs::read(nested.join("keep.txt")).unwrap(), b"keep");
        // A folder with more than one entry is refused by the sweep, which knows no file name.
        let crowded = staging.join("drag-00000000000000aa");
        std::fs::create_dir_all(&crowded).unwrap();
        std::fs::write(crowded.join("one.svg"), b"1").unwrap();
        std::fs::write(crowded.join("two.svg"), b"2").unwrap();
        assert_eq!(sweep_staging(&staging, None), 0);
        assert!(crowded.join("one.svg").exists() && crowded.join("two.svg").exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_leaves_a_replaced_staging_root_untouched() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("replaced-root");
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let staged = stage_copy(&staging, &source, Unix).unwrap();
        // The staging root is moved away and a link to another folder put in its place, holding a
        // folder of the same per-drag name with the same file in it.
        std::fs::rename(&staging, scratch.0.join("moved")).unwrap();
        let elsewhere = scratch.0.join("elsewhere");
        let target = elsewhere.join(&staged.entry);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("a.svg"), b"keep").unwrap();
        symlink(&elsewhere, &staging).unwrap();

        staged.remove();
        assert_eq!(sweep_staging(&staging, None), 0);
        assert_eq!(sweep_staging_at_startup(&staging), 0);
        assert!(remove_staged_entry(&staging, None, &staged.entry, Some("a.svg")).is_err());
        assert!(remove_staged_entry(&staging, None, &staged.entry, None).is_err());
        assert_eq!(std::fs::read(target.join("a.svg")).unwrap(), b"keep");
        assert!(std::fs::symlink_metadata(&staging)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn a_dropped_copy_keeps_its_grace_period_from_the_drop_not_from_staging() {
        let scratch = Scratch::new("drop-grace");
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let platform = PathPlatform::current();
        let aged = std::time::SystemTime::now() - DROPPED_COPY_GRACE - Duration::from_secs(60);
        // A drag held longer than the grace period, then dropped: its folder already looks old.
        let held = stage_copy(&staging, &source, platform).unwrap();
        set_modified_dir(&held.root.join(&held.entry), aged);
        finish_staged_copy(held.clone(), true);
        // An abandoned copy of the same age (its end never reported) is still swept.
        let abandoned = stage_copy(&staging, &source, platform).unwrap();
        set_modified_dir(&abandoned.root.join(&abandoned.entry), aged);
        // The next drag's sweep, within the grace period after the drop, keeps the dropped copy.
        assert_eq!(sweep_staging(&staging, Some(DROPPED_COPY_GRACE)), 1);
        assert!(held.file.exists());
        assert!(!abandoned.root.join(&abandoned.entry).exists());
        // Once the period since the drop has passed, the copy is old enough to go.
        assert_eq!(sweep_staging(&staging, Some(Duration::ZERO)), 1);
        assert!(!held.root.join(&held.entry).exists());
        held.remove();
        assert!(!dropped_within(&held.entry, DROPPED_COPY_GRACE));
    }

    #[test]
    fn a_recent_drop_survives_a_restart_and_an_old_abandoned_copy_does_not() {
        let scratch = Scratch::new("drop-restart");
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let platform = PathPlatform::current();
        let aged = std::time::SystemTime::now() - DROPPED_COPY_GRACE - Duration::from_secs(60);
        // A drag held longer than the grace period, dropped just before the app quit.
        let held = stage_copy(&staging, &source, platform).unwrap();
        set_modified_dir(&held.root.join(&held.entry), aged);
        finish_staged_copy(held.clone(), true);
        // An abandoned copy of the same age.
        let abandoned = stage_copy(&staging, &source, platform).unwrap();
        set_modified_dir(&abandoned.root.join(&abandoned.entry), aged);
        // A restart forgets this process's drop records; the next run's startup sweep keeps the
        // recent drop and removes the old abandoned copy.
        dropped_copies()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&held.entry);
        assert_eq!(sweep_staging_at_startup(&staging), 1);
        assert!(held.file.exists());
        assert!(!abandoned.root.join(&abandoned.entry).exists());
        held.remove();
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn a_drag_error_that_may_follow_a_drop_keeps_the_copy() {
        // Errors raised before the system drag runs are certain failed starts.
        let io = drag::Error::Io(std::io::Error::other("no such file"));
        assert!(!drag_error_may_follow_a_drop(&io));
        assert!(!drag_error_may_follow_a_drop(
            &drag::Error::UnsupportedWindowHandle
        ));
        // On Windows, drag 2.1.1 runs `GetCursorPos(&mut pt)?` after `DoDragDrop`, before the drop
        // callback: a `windows::core::Error` (windows-core 0.52) turned by drag's `#[from]`
        // conversion into `Error::WindowsError`. That crate is not a dependency here, so the inner
        // error is made through one of its own conversions; the variant is what the classifier sees.
        #[cfg(windows)]
        let after_do_drag_drop =
            drag::Error::WindowsError(u8::try_from(256u32).unwrap_err().into());
        // On macOS the call returns once the drag session begins, so any error is a failed start.
        #[cfg(not(windows))]
        let after_do_drag_drop = drag::Error::FailedToStartDrag;
        let may_have_dropped = drag_error_may_follow_a_drop(&after_do_drag_drop);
        assert_eq!(may_have_dropped, cfg!(windows));
        let scratch = Scratch::new("ambiguous-end");
        let staging = scratch.0.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let platform = PathPlatform::current();
        // The classifier's answer decides retention, as in `start_native_drag`.
        let ambiguous = stage_copy(&staging, &source, platform).unwrap();
        finish_staged_copy(ambiguous.clone(), may_have_dropped);
        assert_eq!(ambiguous.file.exists(), cfg!(windows));
        assert_eq!(
            dropped_within(&ambiguous.entry, DROPPED_COPY_GRACE),
            cfg!(windows)
        );
        let failed = stage_copy(&staging, &source, platform).unwrap();
        finish_staged_copy(failed.clone(), drag_error_may_follow_a_drop(&io));
        assert!(!failed.root.join(&failed.entry).exists());
        ambiguous.remove();
    }

    #[test]
    fn cleanup_refuses_a_staging_folder_whose_ancestor_was_replaced() {
        let scratch = Scratch::new("replaced-ancestor");
        let ancestor = scratch.0.join("local");
        let staging = ancestor.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let staged = stage_copy(&staging, &source, PathPlatform::current()).unwrap();
        // The ancestor is moved away and another real folder put at its path, holding a staging
        // folder with a per-drag folder of the same name and the same file in it.
        std::fs::rename(&ancestor, scratch.0.join("moved")).unwrap();
        let target = staging.join(&staged.entry);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("a.svg"), b"keep").unwrap();
        let unrelated = staging.join("drag-00000000000000bb");
        std::fs::create_dir_all(&unrelated).unwrap();

        staged.remove();
        assert_eq!(sweep_staging(&staging, None), 0);
        assert_eq!(sweep_staging_at_startup(&staging), 0);
        assert!(remove_staged_entry(&staging, None, &staged.entry, Some("a.svg")).is_err());
        assert!(remove_staged_entry(
            &staging,
            Some(staged.root_id),
            "drag-00000000000000bb",
            None
        )
        .is_err());
        assert_eq!(std::fs::read(target.join("a.svg")).unwrap(), b"keep");
        assert!(unrelated.exists());
        // The moved, original staging folder still holds the copy.
        assert!(scratch
            .0
            .join("moved")
            .join(DRAG_STAGING_FOLDER)
            .join(&staged.entry)
            .join("a.svg")
            .exists());
        // A new drag staging into the folder now at the path makes it the staging folder.
        let next = stage_copy(&staging, &source, PathPlatform::current()).unwrap();
        next.remove();
        assert!(!next.root.join(&next.entry).exists());
        assert_eq!(std::fs::read(target.join("a.svg")).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_refuses_a_staging_folder_reached_through_a_linked_ancestor() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("linked-ancestor");
        let ancestor = scratch.0.join("local");
        let staging = ancestor.join(DRAG_STAGING_FOLDER);
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let staged = stage_copy(&staging, &source, Unix).unwrap();
        std::fs::rename(&ancestor, scratch.0.join("moved")).unwrap();
        let elsewhere = scratch.0.join("elsewhere");
        let target = elsewhere.join(DRAG_STAGING_FOLDER).join(&staged.entry);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("a.svg"), b"keep").unwrap();
        symlink(&elsewhere, &ancestor).unwrap();

        staged.remove();
        assert_eq!(sweep_staging(&staging, None), 0);
        assert!(remove_staged_entry(&staging, None, &staged.entry, Some("a.svg")).is_err());
        assert_eq!(std::fs::read(target.join("a.svg")).unwrap(), b"keep");
    }

    /// Makes `link` a link to the folder `target`: a symbolic link on Unix, a junction on Windows
    /// (which needs no privilege; a symbolic link is tried after it). False when the system refuses.
    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            let junction = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(host_path(link))
                .arg(host_path(target))
                .output()
                .is_ok_and(|output| output.status.success());
            junction || std::os::windows::fs::symlink_dir(target, link).is_ok()
        }
    }

    #[test]
    fn a_fresh_process_never_cleans_a_staging_folder_reached_through_a_linked_ancestor() {
        let scratch = Scratch::new("fresh-linked-ancestor");
        let source = DragSource {
            name: "a.svg".into(),
            bytes: DRAG_TEST_SVG.as_bytes().to_vec(),
        };
        let aged = std::time::SystemTime::now() - DROPPED_COPY_GRACE - Duration::from_secs(60);
        let entry = "drag-0123456789abcdef";
        // Before this process ever looked at the staging path, an ancestor of it was replaced with
        // a link to another folder, which holds an old per-drag folder with a file in it.
        let elsewhere = scratch.0.join("elsewhere");
        let target = elsewhere.join(DRAG_STAGING_FOLDER).join(entry);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("a.svg"), b"keep").unwrap();
        set_modified_dir(&target, aged);
        let ancestor = scratch.0.join("local");
        if !link_dir(&elsewhere, &ancestor) {
            return;
        }
        let staging = ancestor.join(DRAG_STAGING_FOLDER);

        // The first cleanup at that path, whichever it is, removes nothing.
        assert_eq!(sweep_staging_at_startup(&staging), 0);
        assert_eq!(sweep_staging(&staging, None), 0);
        assert!(remove_staged_entry(&staging, None, entry, Some("a.svg")).is_err());
        assert!(remove_staged_entry(&staging, None, entry, None).is_err());
        assert_eq!(std::fs::read(target.join("a.svg")).unwrap(), b"keep");
        // Nor does a drag staging through the link make that folder the staging folder: its own
        // copy goes by identity, but cleanup by path still removes nothing there.
        let staged = stage_copy(&staging, &source, PathPlatform::current()).unwrap();
        assert_eq!(sweep_staging(&staging, None), 0);
        assert_eq!(std::fs::read(target.join("a.svg")).unwrap(), b"keep");
        staged.remove();
        assert!(!staged.root.join(&staged.entry).exists());
        assert_eq!(std::fs::read(target.join("a.svg")).unwrap(), b"keep");

        // The same leftover at a staging path reached without a link is swept on first sight.
        let plain = scratch.0.join("plain").join(DRAG_STAGING_FOLDER);
        let leftover = plain.join(entry);
        std::fs::create_dir_all(&leftover).unwrap();
        std::fs::write(leftover.join("a.svg"), b"old").unwrap();
        set_modified_dir(&leftover, aged);
        assert_eq!(sweep_staging_at_startup(&plain), 1);
        assert!(!leftover.exists());
    }

    #[test]
    fn staging_locations_compare_by_root_and_exact_names() {
        let same = |real: &str, expected: &str, platform| {
            is_same_location(Path::new(real), Path::new(expected), platform)
        };
        let staging = "/Users/a/Library/Application Support/x/art-drag-staging";
        assert!(same(staging, staging, Unix));
        assert!(same(staging, &format!("{staging}/"), Unix));
        assert!(!same(
            "/private/Users/a/Library/Application Support/x/art-drag-staging",
            staging,
            Unix
        ));
        assert!(!same(&staging.replace("Users", "users"), staging, Unix));
        assert!(!same(staging, "Users/a/x/art-drag-staging", Unix));
        assert!(!same(
            staging,
            "/Users/a/../a/Library/Application Support/x/art-drag-staging",
            Unix
        ));
        let local = r"C:\Users\a\AppData\Local\x\art-drag-staging";
        assert!(same(&format!(r"\\?\{local}"), local, Windows));
        assert!(same(
            &format!(r"\\?\{local}"),
            &local.replace("C:", "c:"),
            Windows
        ));
        assert!(!same(
            &format!(r"\\?\{local}"),
            &local.replace("Local", "local"),
            Windows
        ));
        assert!(!same(
            r"\\?\C:\Users\a\AppData\Elsewhere\x\art-drag-staging",
            local,
            Windows
        ));
        assert!(!same(
            &format!(r"\\?\{local}"),
            r"D:\Users\a\AppData\Local\x\art-drag-staging",
            Windows
        ));
    }

    #[test]
    fn the_harness_writer_leaves_no_temporary_file_behind_on_failure() {
        let scratch = Scratch::new("harness-temp");
        let folder = scratch.0.join("spike");
        std::fs::create_dir_all(&folder).unwrap();
        let dir = os::open_dir_no_follow(&folder).unwrap();
        // A write that fails part way removes the file it created.
        let error = write_new_file_with(&dir, &folder, ".partial.tmp", |file| {
            file.write_all(b"<svg")?;
            Err(std::io::Error::other("disk full"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "disk full");
        assert!(!folder.join(".partial.tmp").exists());
        drop(dir);
        // A rename that fails (a folder where the file goes) removes the temporary file too.
        let root = scratch.0.join("art-library");
        let spike = root.join(DRAG_TEST_FOLDER);
        std::fs::create_dir_all(spike.join(DRAG_TEST_FILE)).unwrap();
        std::fs::write(spike.join(DRAG_TEST_FILE).join("keep.txt"), b"keep").unwrap();
        assert!(write_drag_test_file(&root).is_err());
        let names: Vec<String> = std::fs::read_dir(&spike)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![DRAG_TEST_FILE.to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_in_a_root_is_refused_without_blocking() {
        let scratch = Scratch::new("fifo");
        let root = scratch.0.join("art-library");
        std::fs::create_dir_all(&root).unwrap();
        let fifo = root.join("pipe.svg");
        let name = std::ffi::CString::new(fifo.to_string_lossy().into_owned()).unwrap();
        // SAFETY: a NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(matches!(
            read_drag_source(&host_path(&fifo), &[root], Unix),
            Err(DragSourceError::NotRegularFile(_))
        ));
    }

    #[test]
    fn the_harness_writer_replaces_a_hard_link_instead_of_writing_through_it() {
        let scratch = Scratch::new("hardlink");
        let root = scratch.0.join("art-library");
        let spike = root.join(DRAG_TEST_FOLDER);
        std::fs::create_dir_all(&spike).unwrap();
        let victim = scratch.0.join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        std::fs::hard_link(&victim, spike.join(DRAG_TEST_FILE)).unwrap();
        let file = write_drag_test_file(&root).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), DRAG_TEST_SVG);
        // Writing again replaces the file; no temporary file is left behind.
        write_drag_test_file(&root).unwrap();
        let names: Vec<String> = std::fs::read_dir(&spike)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![DRAG_TEST_FILE.to_string()]);
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
    fn gzip_svgs_are_never_inflated_for_the_preview() {
        use flate2::{write::GzEncoder, Compression};
        let gzip = |bytes: &[u8]| {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        };
        // A gzip-compressed file draws the plain tile, never the decompressed drawing.
        let compressed = gzip(DRAG_TEST_SVG.as_bytes());
        assert_eq!(render_preview(&compressed), None);
        let tile = image::load_from_memory(&drag_preview_png(&compressed)).unwrap();
        assert_eq!(
            (tile.width(), tile.height()),
            (PREVIEW_SIZE / 2, PREVIEW_SIZE / 2)
        );
        // Nor is a gzip-compressed SVG embedded as a data: image; the same image uncompressed is.
        let red = br##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>"##;
        let embedding = |payload: &[u8]| {
            let encoded: String = payload.iter().map(|byte| format!("%{byte:02X}")).collect();
            format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image width="10" height="10" xlink:href="data:image/svg+xml,{encoded}"/></svg>"#
            )
        };
        let centre_alpha = |svg: String| {
            let png = render_preview(svg.as_bytes()).unwrap();
            let image = image::load_from_memory(&png).unwrap().to_rgba8();
            image.get_pixel(image.width() / 2, image.height() / 2).0
        };
        assert_eq!(centre_alpha(embedding(red)), [0xff, 0, 0, 0xff]);
        assert_eq!(centre_alpha(embedding(&gzip(red)))[3], 0);
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
