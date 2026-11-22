use serde::Serialize;
use std::{
    borrow::Cow,
    fs,
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

const STABLE_IDENTIFIER: &str = "org.chemdraft.desktop";
const STABLE_MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/office-manifest.xml"));
const STABLE_ID: &str = "c2b05f5c-0724-4438-bff6-229da8041c57";
const DEV_ID: &str = "62b8cf76-1e9e-4826-a1b1-1ed9cbea128f";

/// The Help rows for these commands, as the webview syncs them (`officeAddin.ts`). lib.rs builds
/// them, enabled, into the first native menu so they exist before the webview's first sync. Both
/// stay enabled: nothing reads Office's folders until the user chooses one and confirms, because
/// reading them can raise macOS's "access data from other apps" prompt.
pub(crate) const HELP_MENU_ROWS: [(&str, &str); 2] = [
    ("office.installAddin", "Install Office Add-in…"),
    ("office.removeAddin", "Remove Office Add-in…"),
];

struct Addin {
    filename: &'static str,
    id: &'static str,
    manifest: Cow<'static, str>,
    /// This build's bundle identifier, the one macOS records its app-data decision under.
    bundle_identifier: String,
}

impl Addin {
    fn for_build(identifier: &str, debug: bool, worktree_label: Option<&str>) -> Self {
        let branch_build =
            matches!(worktree_label, Some(label) if !label.is_empty() && label != "UNSIGNED");
        if identifier == STABLE_IDENTIFIER && !debug && !branch_build {
            Self {
                filename: "chemdraft-office-addin.xml",
                id: STABLE_ID,
                manifest: STABLE_MANIFEST.into(),
                bundle_identifier: identifier.to_owned(),
            }
        } else {
            Self {
                filename: "chemdraft-office-addin-dev.xml",
                id: DEV_ID,
                manifest: STABLE_MANIFEST
                    .replace(STABLE_ID, DEV_ID)
                    .replace(
                        "<DisplayName DefaultValue=\"Edit Structure\"",
                        "<DisplayName DefaultValue=\"ChemDraft (dev)\"",
                    )
                    .into(),
                bundle_identifier: identifier.to_owned(),
            }
        }
    }

    fn is_current(&self, installed: &str) -> bool {
        let version = env!("CARGO_PKG_VERSION").split(['-', '+']).next().unwrap();
        let source = concat!(
            "https://chemdraft.ai/office/",
            env!("CARGO_PKG_VERSION"),
            "/taskpane"
        );
        // The source URL also distinguishes prereleases with the same numeric Office version.
        installed.contains(&format!("<Id>{}</Id>", self.id))
            && installed.contains(&format!("<Version>{version}.0</Version>"))
            && installed.contains(&format!("<SourceLocation DefaultValue=\"{source}\""))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum OfficeApp {
    Word,
    PowerPoint,
}

impl OfficeApp {
    fn container(self) -> &'static str {
        match self {
            Self::Word => "com.microsoft.Word",
            Self::PowerPoint => "com.microsoft.Powerpoint",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Word => "Word",
            Self::PowerPoint => "PowerPoint",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    NotInstalled,
    InstalledSameVersion,
    InstalledOtherVersion,
    /// A file sits at ChemDraft's filename but is not a manifest ChemDraft can identify as its own.
    /// It is never overwritten or deleted; the result names its path so the user can deal with it.
    Unrecognized,
    AppNotFound,
    Unavailable,
}

/// Why an app could not be checked or changed. `PermissionDenied` is what macOS returns (`EPERM`, or
/// `EACCES`) once the user chooses Don't Allow at "'ChemDraft' would like to access data from other
/// apps" (TCC service `SystemPolicyAppData`), so the webview can explain how to allow it: try again
/// and click Allow, or reset the decision with `tccutil reset SystemPolicyAppData <bundle id>`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum FailureKind {
    PermissionDenied,
    Other,
}

#[derive(Debug)]
struct Failure {
    kind: FailureKind,
    message: String,
}

impl Failure {
    fn other(message: String) -> Self {
        Self {
            kind: FailureKind::Other,
            message,
        }
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        // EPERM is 1 and EACCES is 13 on macOS; std maps both to `PermissionDenied` as well.
        let denied = error.kind() == ErrorKind::PermissionDenied
            || matches!(error.raw_os_error(), Some(1 | 13));
        Self {
            kind: if denied {
                FailureKind::PermissionDenied
            } else {
                FailureKind::Other
            },
            message: error.to_string(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficeAddinResult {
    app: OfficeApp,
    status: Status,
    changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_kind: Option<FailureKind>,
    /// The manifest path, reported only for `Unrecognized` so the message can name the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// This app was changed and then restored because the other app's change failed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    rolled_back: bool,
    /// Set with a `PermissionDenied` error: this build's bundle identifier, which macOS keys its
    /// decision on, so the message can give the exact `tccutil reset` command for this build.
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle_identifier: Option<String>,
}

impl OfficeAddinResult {
    fn status(home: &Path, app: OfficeApp, addin: &Addin, status: Status) -> Self {
        Self {
            app,
            status,
            changed: false,
            error: None,
            error_kind: None,
            path: (status == Status::Unrecognized)
                .then(|| manifest_path(home, app, addin).display().to_string()),
            rolled_back: false,
            bundle_identifier: None,
        }
    }

    fn failure(app: OfficeApp, failure: &Failure) -> Self {
        Self {
            app,
            status: Status::Unavailable,
            changed: false,
            error: Some(failure.message.clone()),
            error_kind: Some(failure.kind),
            path: None,
            rolled_back: false,
            bundle_identifier: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Action {
    /// Tests only: read both apps' state and write nothing. The app has no status check: it reads
    /// Office's folders only inside an Install or Remove the user chose and confirmed.
    #[cfg(test)]
    Status,
    Install,
    Remove,
}

/// The kinds of file-system call the add-in makes, named so a test gate can refuse one.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Inspect,
    Read,
    CreateDir,
    Write,
    Rename,
    Remove,
}

type Gate<'a> = &'a dyn Fn(Op, &Path) -> io::Result<()>;

fn allow_all(_: Op, _: &Path) -> io::Result<()> {
    Ok(())
}

/// Every file-system call goes through `gate` first, so tests can inject the permission denial
/// macOS returns after Don't Allow at any step. The real gate allows everything.
struct Fs<'a> {
    gate: Gate<'a>,
}

impl Fs<'_> {
    fn real() -> Fs<'static> {
        Fs { gate: &allow_all }
    }

    fn lstat(&self, path: &Path) -> io::Result<fs::Metadata> {
        (self.gate)(Op::Inspect, path)?;
        fs::symlink_metadata(path)
    }

    /// Read the manifest without following a link: the file opened must be the regular file `lstat`
    /// saw, so a symlink swapped in between the two calls is refused rather than read.
    fn read_regular_file(&self, path: &Path, expected: &fs::Metadata) -> Result<Vec<u8>, Failure> {
        use std::{io::Read, os::unix::fs::MetadataExt};

        (self.gate)(Op::Read, path)?;
        let mut file = fs::File::open(path)?;
        let opened = file.metadata()?;
        if !opened.is_file() || opened.dev() != expected.dev() || opened.ino() != expected.ino() {
            return Err(Failure::other(format!(
                "{} must be a regular file.",
                path.display()
            )));
        }
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;
        Ok(contents)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        (self.gate)(Op::CreateDir, path)?;
        fs::create_dir(path)
    }

    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        (self.gate)(Op::Remove, path)?;
        fs::remove_dir(path)
    }

    /// Write `contents` to a new private file beside `path`, removing it again on every failure,
    /// so a denial partway through never leaves a stray file in Office's folder.
    fn stage(&self, path: &Path, contents: &[u8]) -> io::Result<PathBuf> {
        (self.gate)(Op::Write, path)?;
        let tmp = scratch_path(path);
        let mut file = fs::File::create_new(&tmp)?;
        let written = file.write_all(contents);
        drop(file);
        if let Err(error) = written.and_then(|()| (self.gate)(Op::Rename, path)) {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
        Ok(tmp)
    }

    /// Change `path` from exactly `expected` (`None`: no file) to `contents` (`None`: no file),
    /// never replacing or deleting a file another process put there meanwhile. `ACTION_LOCK`
    /// serializes only this process, so the file found is first moved to a private name and
    /// compared before it is deleted, and a new file goes in with a rename that fails if anything
    /// is at the path.
    fn commit(
        &self,
        path: &Path,
        expected: Option<&[u8]>,
        contents: Option<&[u8]>,
    ) -> Result<Committed, Failure> {
        let staged = match contents {
            Some(contents) => Some(self.stage(path, contents)?),
            None => {
                (self.gate)(Op::Remove, path)?;
                None
            }
        };
        let result = swap_in(path, expected, staged.as_deref());
        if let Some(staged) = &staged {
            // Already gone if it was renamed into place.
            let _ = fs::remove_file(staged);
        }
        result
    }
}

/// What `Fs::commit` found in place of the file it expected.
enum Committed {
    Done,
    /// A Remove found nothing at the path.
    Gone,
    /// Another file is at the path now and was left there: its bytes, or `None` if it is not a
    /// regular file ChemDraft could read.
    Conflict(Option<Vec<u8>>),
}

/// A new private name beside `path`, for a file being staged or set aside.
fn scratch_path(path: &Path) -> PathBuf {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), sequence));
    PathBuf::from(tmp)
}

/// Rename `from` to `to` only if nothing is at `to`. `renamex_np` with `RENAME_EXCL` checks and
/// renames in one step, so a file another process puts at `to` is never replaced. A volume
/// without that flag falls back to a check followed by a plain rename.
fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(from.as_os_str().as_bytes())?;
    let target = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both arguments are NUL-terminated paths that outlive the call.
    if unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if !matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::EINVAL)) {
        return Err(error);
    }
    match fs::symlink_metadata(to) {
        Ok(_) => Err(io::Error::from(ErrorKind::AlreadyExists)),
        Err(error) if error.kind() == ErrorKind::NotFound => fs::rename(from, to),
        Err(error) => Err(error),
    }
}

/// The bytes of the regular file at `path`, without following a link.
fn read_regular(path: &Path) -> Option<Vec<u8>> {
    fs::symlink_metadata(path)
        .ok()
        .filter(fs::Metadata::is_file)
        .and_then(|_| fs::read(path).ok())
}

/// `Fs::commit` after its gate checks: set aside and compare what is at `path`, then rename the
/// staged file (if any) into place without replacing anything.
fn swap_in(
    path: &Path,
    expected: Option<&[u8]>,
    staged: Option<&Path>,
) -> Result<Committed, Failure> {
    let mut aside = None;
    if let Some(expected) = expected {
        let moved = scratch_path(path);
        match rename_excl(path, &moved) {
            Ok(()) => {
                let found = read_regular(&moved);
                if found.as_deref() != Some(expected) {
                    // Another process replaced the file: put theirs back, never over a newer one.
                    return match rename_excl(&moved, path) {
                        Ok(()) => Ok(Committed::Conflict(found)),
                        Err(error) => Err(Failure::other(format!(
                            "{} changed while ChemDraft was working, and ChemDraft could not put the new file back ({error}); it is at {}.",
                            path.display(),
                            moved.display()
                        ))),
                    };
                }
                aside = Some(moved);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if staged.is_none() {
                    return Ok(Committed::Gone);
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    if let Some(staged) = staged {
        if let Err(error) = rename_excl(staged, path) {
            let taken = error.kind() == ErrorKind::AlreadyExists;
            if let Some(moved) = &aside {
                // Put the expected file back. If another process wrote the path meanwhile, keep
                // theirs and drop ours, which this change was replacing anyway.
                let put_back = if taken {
                    Err(io::Error::from(ErrorKind::AlreadyExists))
                } else {
                    rename_excl(moved, path)
                };
                if put_back.is_err_and(|error| error.kind() == ErrorKind::AlreadyExists) {
                    let _ = fs::remove_file(moved);
                }
            }
            return if taken {
                Ok(Committed::Conflict(read_regular(path)))
            } else {
                Err(error.into())
            };
        }
    }
    if let Some(moved) = aside {
        if let Err(error) = fs::remove_file(&moved) {
            if staged.is_none() {
                // A Remove that cannot delete the file puts it back rather than hide it.
                let _ = rename_excl(&moved, path);
                return Err(error.into());
            }
        }
    }
    Ok(Committed::Done)
}

fn directory_exists(fs: &Fs, path: &Path) -> Result<bool, Failure> {
    match fs.lstat(path) {
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(Failure::other(format!(
            "{} must be a directory.",
            path.display()
        ))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn container_path(home: &Path, app: OfficeApp) -> PathBuf {
    home.join("Library")
        .join("Containers")
        .join(app.container())
}

const PROVIDER_NAME: &str = "ChemDraft";

/// The end of the tag that starts `rest` (which begins with `<`): the first `>` outside a quoted
/// attribute value.
fn tag_end(rest: &str) -> Option<usize> {
    let mut quote = None;
    for (index, ch) in rest.char_indices().skip(1) {
        match (quote, ch) {
            (None, '"' | '\'') => quote = Some(ch),
            (Some(open), _) if ch == open => quote = None,
            (None, '<') => return None,
            (None, '>') => return Some(index),
            _ => {}
        }
    }
    None
}

fn local_name(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// The raw text of the root `OfficeApp` element's direct `Id` and `ProviderName` children.
///
/// A deliberately small well-formedness check rather than a general parser: it accepts the XML
/// declaration, comments, processing instructions and CDATA, and rejects a DOCTYPE, mismatched
/// or unclosed tags, stray text outside the root, a root other than `OfficeApp`, and a duplicated
/// `Id` or `ProviderName`. Anything it cannot read is simply not identified, which leaves the file
/// alone; that is the safe failure.
fn manifest_identity(xml: &str) -> Option<(String, String)> {
    let mut rest = xml.strip_prefix('\u{feff}').unwrap_or(xml);
    let mut stack: Vec<&str> = Vec::new();
    let mut saw_root = false;
    let mut text = String::new();
    let mut id = None;
    let mut provider = None;
    loop {
        let Some(start) = rest.find('<') else {
            if !rest.trim().is_empty() || !stack.is_empty() || !saw_root {
                return None;
            }
            break;
        };
        let characters = &rest[..start];
        if stack.is_empty() && !characters.trim().is_empty() {
            return None;
        }
        if stack.len() == 2 {
            text.push_str(characters);
        }
        rest = &rest[start..];
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = &after[after.find("-->")? + 3..];
            continue;
        }
        if let Some(after) = rest.strip_prefix("<![CDATA[") {
            let end = after.find("]]>")?;
            if stack.is_empty() {
                return None;
            }
            if stack.len() == 2 {
                text.push_str(&after[..end]);
            }
            rest = &after[end + 3..];
            continue;
        }
        if rest.starts_with("<!") {
            return None;
        }
        if let Some(after) = rest.strip_prefix("<?") {
            rest = &after[after.find("?>")? + 2..];
            continue;
        }
        let end = tag_end(rest)?;
        let tag = &rest[1..end];
        rest = &rest[end + 1..];
        if let Some(name) = tag.strip_prefix('/') {
            if stack.pop()? != name.trim_end() {
                return None;
            }
            if stack.len() == 1 {
                let value = std::mem::take(&mut text).trim().to_owned();
                let slot = match local_name(name.trim_end()) {
                    "Id" => &mut id,
                    "ProviderName" => &mut provider,
                    _ => continue,
                };
                if slot.replace(value).is_some() {
                    return None;
                }
            }
            continue;
        }
        let (body, self_closing) = match tag.strip_suffix('/') {
            Some(body) => (body, true),
            None => (tag, false),
        };
        let name = body
            .split(|ch: char| ch.is_ascii_whitespace())
            .next()
            .unwrap_or_default();
        if name.is_empty() {
            return None;
        }
        if stack.is_empty() {
            if saw_root || local_name(name) != "OfficeApp" {
                return None;
            }
            saw_root = true;
        }
        if !self_closing {
            stack.push(name);
        } else if stack.len() == 1 && matches!(local_name(name), "Id" | "ProviderName") {
            // An empty `<Id/>` cannot be ChemDraft's.
            return None;
        }
    }
    Some((id?, provider?))
}

impl Addin {
    /// Whether `installed` is this flavor's ChemDraft manifest, of any version.
    fn identifies(&self, installed: &str) -> bool {
        manifest_identity(installed).is_some_and(|(id, provider)| {
            id.eq_ignore_ascii_case(self.id) && provider == PROVIDER_NAME
        })
    }
}

/// The bytes of the regular file at `path`, or `None` if nothing is there.
fn read_manifest(fs: &Fs, path: &Path) -> Result<Option<Vec<u8>>, Failure> {
    match fs.lstat(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(fs.read_regular_file(path, &metadata)?)),
        Ok(_) => Err(Failure::other(format!(
            "{} must be a regular file.",
            path.display()
        ))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// The manifest's status, plus its bytes when it is one of ChemDraft's, so a rollback can put the
/// exact file back.
fn manifest_status(
    fs: &Fs,
    path: &Path,
    addin: &Addin,
) -> Result<(Status, Option<Vec<u8>>), Failure> {
    let Some(installed) = read_manifest(fs, path)? else {
        return Ok((Status::NotInstalled, None));
    };
    let status = match std::str::from_utf8(&installed) {
        Ok(xml) if addin.identifies(xml) && addin.is_current(xml) => Status::InstalledSameVersion,
        Ok(xml) if addin.identifies(xml) => Status::InstalledOtherVersion,
        _ => return Ok((Status::Unrecognized, None)),
    };
    Ok((status, Some(installed)))
}

fn manifest_path(home: &Path, app: OfficeApp, addin: &Addin) -> PathBuf {
    container_path(home, app)
        .join("Data")
        .join("Documents")
        .join("wef")
        .join(addin.filename)
}

/// One app's state, read before anything is written.
struct Plan {
    app: OfficeApp,
    path: PathBuf,
    /// The container folders Install must create, outermost first.
    missing: Vec<PathBuf>,
    status: Status,
}

impl Plan {
    fn needs_change(&self, action: Action) -> bool {
        matches!(
            (action, self.status),
            (
                Action::Install,
                Status::NotInstalled | Status::InstalledOtherVersion
            ) | (
                Action::Remove,
                Status::InstalledSameVersion | Status::InstalledOtherVersion
            )
        )
    }
}

/// Read one app's state without writing. `None` means Office's container for it is absent.
fn inspect(fs: &Fs, home: &Path, app: OfficeApp, addin: &Addin) -> Result<Option<Plan>, Failure> {
    let library = home.join("Library");
    let containers = library.join("Containers");
    let mut dir = container_path(home, app);
    if !directory_exists(fs, &library)?
        || !directory_exists(fs, &containers)?
        || !directory_exists(fs, &dir)?
    {
        return Ok(None);
    }
    let mut missing = Vec::new();
    for component in ["Data", "Documents", "wef"] {
        dir.push(component);
        if !missing.is_empty() || !directory_exists(fs, &dir)? {
            missing.push(dir.clone());
        }
    }
    let path = dir.join(addin.filename);
    let status = if missing.is_empty() {
        manifest_status(fs, &path, addin)?.0
    } else {
        Status::NotInstalled
    };
    Ok(Some(Plan {
        app,
        path,
        missing,
        status,
    }))
}

/// Remove folders this change created, innermost first. Best effort: a folder something else has
/// since put a file into is left alone.
fn remove_created(fs: &Fs, created: &[PathBuf]) {
    for dir in created.iter().rev() {
        let _ = fs.remove_dir(dir);
    }
}

/// One app's change, as `undo` needs it.
struct Change {
    /// The folders it created, removed again by an undo.
    created: Vec<PathBuf>,
    /// What the file was just before the change: its status and, for a ChemDraft manifest, its
    /// exact bytes.
    status: Status,
    previous: Option<Vec<u8>>,
}

enum Performed {
    Changed(Change),
    /// Remove found the file already gone.
    Gone,
    /// The file at the path is no longer one ChemDraft can identify as its own (replaced since
    /// `inspect`), so it was left alone.
    Unrecognized,
}

/// Make one app's change. On failure nothing of it is left behind.
///
/// The file is read again right before it is replaced or removed: `inspect` ran earlier, possibly
/// before the other app's inspection waited on macOS's permission prompt, and the file may have
/// been replaced since. Only a regular file that is still a ChemDraft manifest (or no file, for an
/// Install) is changed.
fn perform(fs: &Fs, plan: &Plan, addin: &Addin, action: Action) -> Result<Performed, Failure> {
    match action {
        Action::Install => {
            let mut created = Vec::new();
            for dir in &plan.missing {
                if let Err(error) = fs.create_dir(dir) {
                    remove_created(fs, &created);
                    return Err(error.into());
                }
                created.push(dir.clone());
            }
            let (status, previous) = match manifest_status(fs, &plan.path, addin) {
                Ok((Status::Unrecognized, _)) => {
                    remove_created(fs, &created);
                    return Ok(Performed::Unrecognized);
                }
                Ok(found) => found,
                Err(failure) => {
                    remove_created(fs, &created);
                    return Err(failure);
                }
            };
            match fs.commit(
                &plan.path,
                previous.as_deref(),
                Some(addin.manifest.as_bytes()),
            ) {
                Ok(Committed::Done | Committed::Gone) => Ok(Performed::Changed(Change {
                    created,
                    status,
                    previous,
                })),
                Ok(Committed::Conflict(found)) => {
                    remove_created(fs, &created);
                    conflict(&plan.path, found, addin)
                }
                Err(failure) => {
                    remove_created(fs, &created);
                    Err(failure)
                }
            }
        }
        Action::Remove => {
            let (status, previous) = match manifest_status(fs, &plan.path, addin)? {
                (Status::Unrecognized, _) => return Ok(Performed::Unrecognized),
                (Status::NotInstalled, _) => return Ok(Performed::Gone),
                found => found,
            };
            match fs.commit(&plan.path, previous.as_deref(), None)? {
                Committed::Done => Ok(Performed::Changed(Change {
                    created: Vec::new(),
                    status,
                    previous,
                })),
                Committed::Gone => Ok(Performed::Gone),
                Committed::Conflict(found) => conflict(&plan.path, found, addin),
            }
        }
        #[cfg(test)]
        Action::Status => Ok(Performed::Gone),
    }
}

/// A file another process put at `path` after the re-read, which `commit` left in place. One that
/// is not a ChemDraft manifest skips its app, as when the re-read finds it; any other change stops
/// the action, so the other app's change is undone.
fn conflict(path: &Path, found: Option<Vec<u8>>, addin: &Addin) -> Result<Performed, Failure> {
    match found.as_deref().map(std::str::from_utf8) {
        Some(Ok(xml)) if addin.identifies(xml) => Err(Failure::other(format!(
            "{} changed while ChemDraft was working, so ChemDraft left it in place.",
            path.display()
        ))),
        Some(_) => Ok(Performed::Unrecognized),
        None => Err(Failure::other(format!(
            "{} must be a regular file.",
            path.display()
        ))),
    }
}

/// Why an undo left `path` alone: something replaced what ChemDraft wrote or removed there.
fn replaced_since(path: &Path, current: Option<&[u8]>, addin: &Addin) -> Failure {
    let ours = current
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .is_some_and(|xml| addin.identifies(xml));
    Failure::other(if ours {
        format!(
            "{} changed while ChemDraft was working, so ChemDraft did not replace it.",
            path.display()
        )
    } else {
        format!(
            "{} is not a ChemDraft add-in manifest, so ChemDraft did not replace it.",
            path.display()
        )
    })
}

/// Put one app back as it was just before `perform` changed it. The file is read again first: it
/// must still be exactly what the change left (the manifest Install wrote, or nothing after a
/// Remove), so an undo never overwrites or deletes a file something else put there.
fn undo(
    fs: &Fs,
    path: &Path,
    change: &Change,
    addin: &Addin,
    action: Action,
) -> Result<(), Failure> {
    let current = read_manifest(fs, path)?;
    let expected = (action == Action::Install).then_some(addin.manifest.as_bytes());
    if current.as_deref() != expected {
        return Err(replaced_since(path, current.as_deref(), addin));
    }
    // `commit` keeps a file another process puts there after this read, too.
    if let Committed::Conflict(found) = fs.commit(path, expected, change.previous.as_deref())? {
        return Err(replaced_since(path, found.as_deref(), addin));
    }
    remove_created(fs, &change.created);
    Ok(())
}

/// Check, install or remove the add-in in Word and PowerPoint as one change.
///
/// Both apps are inspected before anything is written, and nothing is written if either cannot be
/// read. If the second app's write fails (most often macOS's permission denial), the first app's
/// change is undone, so Office is never left with the add-in in only one app. An unrecognized file
/// or a missing app is not a failure: that app is skipped and reported, and the other proceeds.
fn apply_with(fs: &Fs, home: &Path, addin: &Addin, action: Action) -> [OfficeAddinResult; 2] {
    let mut results = change_both(fs, home, addin, action);
    for result in &mut results {
        if result.error_kind == Some(FailureKind::PermissionDenied) {
            result.bundle_identifier = Some(addin.bundle_identifier.clone());
        }
    }
    results
}

fn change_both(fs: &Fs, home: &Path, addin: &Addin, action: Action) -> [OfficeAddinResult; 2] {
    let apps = [OfficeApp::Word, OfficeApp::PowerPoint];
    let inspected = apps.map(|app| inspect(fs, home, app, addin));
    let mut results: [OfficeAddinResult; 2] = std::array::from_fn(|index| {
        let app = apps[index];
        match &inspected[index] {
            Ok(None) => OfficeAddinResult::status(home, app, addin, Status::AppNotFound),
            Ok(Some(plan)) => OfficeAddinResult::status(home, app, addin, plan.status),
            Err(failure) => OfficeAddinResult::failure(app, failure),
        }
    });
    // Nothing is written if either app could not be read. (The tests' status check writes nothing
    // either way: no plan needs a change for it.)
    if inspected.iter().any(Result::is_err) {
        return results;
    }

    let mut done: Vec<(usize, Change)> = Vec::new();
    for (index, inspection) in inspected.iter().enumerate() {
        let Ok(Some(plan)) = inspection else {
            continue;
        };
        if !plan.needs_change(action) {
            continue;
        }
        match perform(fs, plan, addin, action) {
            Ok(Performed::Changed(change)) => {
                done.push((index, change));
                results[index].changed = true;
                results[index].status = if action == Action::Install {
                    Status::InstalledSameVersion
                } else {
                    Status::NotInstalled
                };
            }
            Ok(Performed::Gone) => results[index].status = Status::NotInstalled,
            Ok(Performed::Unrecognized) => {
                results[index] =
                    OfficeAddinResult::status(home, plan.app, addin, Status::Unrecognized);
            }
            Err(failure) => {
                results[index] = OfficeAddinResult::failure(plan.app, &failure);
                for (undone, change) in done.into_iter().rev() {
                    let Ok(Some(earlier)) = &inspected[undone] else {
                        continue;
                    };
                    let result = &mut results[undone];
                    match undo(fs, &earlier.path, &change, addin, action) {
                        Ok(()) => {
                            result.status = change.status;
                            result.changed = false;
                            result.rolled_back = true;
                        }
                        Err(failure) => {
                            result.error = Some(format!(
                                "ChemDraft could not undo this change after {} failed: {}",
                                plan.app.name(),
                                failure.message
                            ));
                            result.error_kind = Some(failure.kind);
                        }
                    }
                }
                return results;
            }
        }
    }
    results
}

fn apply(home: &Path, addin: &Addin, action: Action) -> [OfficeAddinResult; 2] {
    apply_with(&Fs::real(), home, addin, action)
}

/// One add-in action at a time, so an undo never races another action's write.
static ACTION_LOCK: Mutex<()> = Mutex::new(());

/// Runs the file work on Tauri's blocking pool, never the main thread. Opening Office's folders can
/// block for as long as macOS's "access data from other apps" prompt stays up; on the main thread
/// that froze menus and IPC. (Tauri 2 runs a non-`async` command on the main thread.)
async fn run(
    window: tauri::WebviewWindow,
    action: Action,
) -> Result<[OfficeAddinResult; 2], String> {
    if window.label() != super::MAIN_WINDOW_LABEL {
        return Err("Manage the Office add-in from the main document window.".to_owned());
    }
    let home = window
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?;
    let addin = Addin::for_build(
        &window.config().identifier,
        cfg!(debug_assertions),
        option_env!("CHEMDRAFT_WORKTREE_LABEL"),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let _serialized = ACTION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        apply(&home, &addin, action)
    })
    .await
    .map_err(|error| format!("The Office add-in task could not run: {error}"))
}

#[tauri::command]
pub(crate) async fn office_addin_install(
    window: tauri::WebviewWindow,
) -> Result<[OfficeAddinResult; 2], String> {
    run(window, Action::Install).await
}

#[tauri::command]
pub(crate) async fn office_addin_remove(
    window: tauri::WebviewWindow,
) -> Result<[OfficeAddinResult; 2], String> {
    run(window, Action::Remove).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHome(PathBuf);

    impl TempHome {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "chemdraft-office-home-{}",
                crate::external_tools::nonce()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn command_permissions_are_only_granted_to_the_macos_document_window() {
        let office: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/office-addin.json")).unwrap();
        assert_eq!(office["platforms"], serde_json::json!(["macOS"]));
        assert_eq!(office["windows"], serde_json::json!(["main"]));
        assert_eq!(
            office["permissions"],
            serde_json::json!(["allow-office-addin-install", "allow-office-addin-remove"])
        );
        // Only Install and Remove exist: there is no status check that could read Office's
        // folders before the user chooses one of them.
        let registered: Vec<&str> =
            crate::handler_list::registered_commands(include_str!("lib.rs"))
                .into_iter()
                .filter(|command| command.contains("office_addin"))
                .collect();
        assert_eq!(
            registered,
            [
                "office_addin::office_addin_install",
                "office_addin::office_addin_remove"
            ]
        );
        let lib = include_str!("lib.rs");
        for command in &registered {
            let line = format!("\n            {command},\n");
            let at = lib.find(&line).unwrap();
            assert!(
                lib[..at].ends_with("#[cfg(target_os = \"macos\")]"),
                "{command} must be registered on macOS only"
            );
        }
        let build = include_str!("../build.rs");
        let permissions = Path::new(env!("CARGO_MANIFEST_DIR")).join("permissions/autogenerated");
        for command in ["office_addin_install", "office_addin_remove"] {
            assert!(build.contains(&format!("\"{command}\",")));
            let permission =
                fs::read_to_string(permissions.join(format!("{command}.toml"))).unwrap();
            assert!(permission.contains(&format!("commands.allow = [\"{command}\"]")));
        }
        assert!(!build.contains("office_addin_status"));
        assert!(!permissions.join("office_addin_status.toml").exists());
        let capabilities = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        for entry in fs::read_dir(capabilities).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() != "office-addin.json" {
                assert!(!fs::read_to_string(entry.path())
                    .unwrap()
                    .contains("allow-office-addin-"));
            }
        }
    }

    #[test]
    fn stable_and_dev_use_separate_filenames_and_office_identities() {
        let stable = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let dev = Addin::for_build("org.chemdraft.desktop.dev", false, None);
        assert_eq!(stable.filename, "chemdraft-office-addin.xml");
        assert_eq!(dev.filename, "chemdraft-office-addin-dev.xml");
        assert!(stable.manifest.contains(STABLE_ID));
        assert!(dev.manifest.contains(DEV_ID));
        assert!(!dev.manifest.contains(STABLE_ID));
        assert!(dev
            .manifest
            .contains("<DisplayName DefaultValue=\"ChemDraft (dev)\""));
        assert!(dev
            .manifest
            .contains("<bt:String id=\"ChemDraft.Label\" DefaultValue=\"Edit Structure\""));
        assert_eq!(
            Addin::for_build(STABLE_IDENTIFIER, true, None).filename,
            dev.filename
        );
        assert_eq!(
            Addin::for_build(STABLE_IDENTIFIER, false, Some("worktree [branch]")).filename,
            dev.filename
        );
        assert_eq!(
            Addin::for_build(STABLE_IDENTIFIER, false, Some("UNSIGNED")).filename,
            stable.filename
        );
    }

    #[test]
    fn plans_both_office_container_paths_under_the_given_home() {
        let home = TempHome::new();
        for (app, container) in [
            (OfficeApp::Word, "com.microsoft.Word"),
            (OfficeApp::PowerPoint, "com.microsoft.Powerpoint"),
        ] {
            assert_eq!(
                container_path(&home.0, app),
                home.0.join("Library").join("Containers").join(container)
            );
        }
    }

    #[test]
    fn installs_and_removes_only_the_current_flavors_file() {
        let home = TempHome::new();
        let word = container_path(&home.0, OfficeApp::Word);
        let powerpoint = container_path(&home.0, OfficeApp::PowerPoint);
        let wef = word.join("Data").join("Documents").join("wef");
        fs::create_dir_all(wef.parent().unwrap()).unwrap();
        let stable = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let dev = Addin::for_build("org.chemdraft.desktop.dev", false, None);
        let statuses = |addin: &Addin, action| {
            apply(&home.0, addin, action).map(|entry| (entry.status, entry.changed))
        };
        let missing = (Status::AppNotFound, false);

        assert_eq!(
            statuses(&stable, Action::Status),
            [(Status::NotInstalled, false), missing]
        );
        assert_eq!(
            statuses(&stable, Action::Install),
            [(Status::InstalledSameVersion, true), missing]
        );
        assert_eq!(
            statuses(&stable, Action::Install),
            [(Status::InstalledSameVersion, false), missing]
        );
        assert!(!powerpoint.exists());
        fs::create_dir_all(&powerpoint).unwrap();
        let third_party = wef.join("another-addin.xml");
        fs::write(&third_party, "another add-in").unwrap();
        fs::write(
            wef.join(stable.filename),
            stable.manifest.replace("<Version>", "<Version>9"),
        )
        .unwrap();
        assert_eq!(
            statuses(&stable, Action::Status),
            [
                (Status::InstalledOtherVersion, false),
                (Status::NotInstalled, false)
            ]
        );
        assert_eq!(
            statuses(&stable, Action::Install),
            [(Status::InstalledSameVersion, true); 2]
        );
        assert_eq!(
            statuses(&dev, Action::Install),
            [(Status::InstalledSameVersion, true); 2]
        );
        assert_eq!(
            statuses(&dev, Action::Remove),
            [(Status::NotInstalled, true); 2]
        );
        assert_eq!(
            statuses(&stable, Action::Status),
            [(Status::InstalledSameVersion, false); 2]
        );
        assert_eq!(
            statuses(&stable, Action::Remove),
            [(Status::NotInstalled, true); 2]
        );
        assert_eq!(
            statuses(&stable, Action::Remove),
            [(Status::NotInstalled, false); 2]
        );
        assert_eq!(fs::read_to_string(&third_party).unwrap(), "another add-in");
        assert_eq!(fs::read_dir(wef).unwrap().count(), 1);
    }

    #[test]
    fn identifies_chemdraft_manifests_of_any_version_by_id_and_provider() {
        let stable = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let dev = Addin::for_build("org.chemdraft.desktop.dev", false, None);
        assert!(stable.identifies(&stable.manifest));
        assert!(dev.identifies(&dev.manifest));
        // Each flavor's file is identified by its own add-in Id.
        assert!(!stable.identifies(&dev.manifest));
        assert!(!dev.identifies(&stable.manifest));

        let older = stable
            .manifest
            .replace("<Version>", "<Version>9")
            .replace(env!("CARGO_PKG_VERSION"), "0.0.1");
        assert!(stable.identifies(&older));
        assert!(!stable.is_current(&older));
        let minimal = format!(
            "<?xml version=\"1.0\"?>\n<!-- user note -->\n<OfficeApp xmlns=\"x\">\n  \
             <Id> {} </Id>\n  <ProviderName><![CDATA[ChemDraft]]></ProviderName>\n</OfficeApp>\n",
            STABLE_ID.to_uppercase()
        );
        assert!(stable.identifies(&minimal));
    }

    #[test]
    fn does_not_identify_foreign_or_malformed_files_at_chemdrafts_filename() {
        let stable = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let manifest = stable.manifest.as_ref();
        let foreign_provider = manifest.replace(
            "<ProviderName>ChemDraft</ProviderName>",
            "<ProviderName>Someone Else</ProviderName>",
        );
        let foreign_id = manifest.replace(STABLE_ID, "00000000-0000-0000-0000-000000000000");
        let no_provider = manifest.replace("<ProviderName>ChemDraft</ProviderName>", "");
        let duplicated_id = manifest.replace(
            "<ProviderName>",
            &format!("<Id>{STABLE_ID}</Id><ProviderName>"),
        );
        let nested_id = format!(
            "<OfficeApp><Hosts><Id>{STABLE_ID}</Id></Hosts><ProviderName>ChemDraft</ProviderName></OfficeApp>"
        );
        let other_root =
            format!("<Notes><Id>{STABLE_ID}</Id><ProviderName>ChemDraft</ProviderName></Notes>");
        let doctype = format!("<!DOCTYPE OfficeApp>{manifest}");
        let truncated = &manifest[..manifest.len() / 2];
        let mismatched = manifest.replace("</DefaultLocale>", "</Locale>");
        let trailing = format!("{manifest}<OfficeApp/>");
        let mentions_only =
            format!("my notes: <Id>{STABLE_ID}</Id> <ProviderName>ChemDraft</ProviderName>");
        for xml in [
            foreign_provider.as_str(),
            &foreign_id,
            &no_provider,
            &duplicated_id,
            &nested_id,
            &other_root,
            &doctype,
            truncated,
            &mismatched,
            &trailing,
            &mentions_only,
            "",
            "not xml at all",
            "<OfficeApp><Id>",
        ] {
            assert!(!stable.identifies(xml), "identified {xml:?}");
        }
    }

    #[test]
    fn leaves_an_unidentified_file_untouched_and_names_its_path() {
        let home = TempHome::new();
        let wef = container_path(&home.0, OfficeApp::Word)
            .join("Data")
            .join("Documents")
            .join("wef");
        fs::create_dir_all(&wef).unwrap();
        fs::create_dir_all(container_path(&home.0, OfficeApp::PowerPoint)).unwrap();
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let target = wef.join(addin.filename);
        let foreign = addin.manifest.replace(
            "<ProviderName>ChemDraft</ProviderName>",
            "<ProviderName>Someone Else</ProviderName>",
        );
        for contents in [
            foreign.as_bytes(),
            b"<OfficeApp><Id>broken".as_slice(),
            &[0xff, 0xfe, 0x00],
        ] {
            fs::write(&target, contents).unwrap();
            for action in [Action::Status, Action::Install, Action::Remove] {
                let [word, powerpoint] = apply(&home.0, &addin, action);
                assert_eq!((word.status, word.changed), (Status::Unrecognized, false));
                assert_eq!(word.path.as_deref(), Some(target.to_str().unwrap()));
                assert_eq!(word.error, None);
                assert_eq!(powerpoint.path, None);
                assert_eq!(fs::read(&target).unwrap(), contents);
            }
            let json = serde_json::to_value(&apply(&home.0, &addin, Action::Remove)[0]).unwrap();
            assert_eq!(json["status"], "unrecognized");
            assert_eq!(json["path"], target.to_str().unwrap());
        }
        assert_eq!(fs::read_dir(&wef).unwrap().count(), 1);
    }

    #[test]
    fn a_symlinked_manifest_is_never_read_replaced_or_removed() {
        use std::os::unix::fs::symlink;

        let home = TempHome::new();
        let wef = container_path(&home.0, OfficeApp::Word)
            .join("Data")
            .join("Documents")
            .join("wef");
        fs::create_dir_all(&wef).unwrap();
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let outside = home.0.join("elsewhere.xml");
        // Even a link to a genuine, current ChemDraft manifest is refused.
        fs::write(&outside, addin.manifest.as_bytes()).unwrap();
        let link = wef.join(addin.filename);
        symlink(&outside, &link).unwrap();
        for action in [Action::Status, Action::Install, Action::Remove] {
            let word = &apply(&home.0, &addin, action)[0];
            assert_eq!((word.status, word.changed), (Status::Unavailable, false));
            assert!(word
                .error
                .as_deref()
                .unwrap()
                .contains("must be a regular file"));
        }
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&outside).unwrap(), addin.manifest);

        // A regular file swapped for a link after `lstat` is refused when opened.
        fs::remove_file(&link).unwrap();
        fs::write(&link, "placeholder").unwrap();
        let seen = fs::symlink_metadata(&link).unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&outside, &link).unwrap();
        assert!(Fs::real().read_regular_file(&link, &seen).is_err());
    }

    #[test]
    fn rejects_symlinks_and_leaves_the_other_app_unchanged() {
        use std::os::unix::fs::symlink;

        let home = TempHome::new();
        let word = container_path(&home.0, OfficeApp::Word);
        let powerpoint = container_path(&home.0, OfficeApp::PowerPoint);
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let outside = home.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let untouched = outside.join(addin.filename);
        fs::write(&untouched, "outside").unwrap();
        let word_documents = word.join("Data").join("Documents");
        fs::create_dir_all(&word_documents).unwrap();
        fs::create_dir_all(&powerpoint).unwrap();
        let wef = word_documents.join("wef");
        symlink(&outside, &wef).unwrap();
        let results = apply(&home.0, &addin, Action::Install);
        assert_eq!(results[0].status, Status::Unavailable);
        assert_eq!(results[0].error_kind, Some(FailureKind::Other));
        // Word could not be read, so nothing is written: PowerPoint is reported, not changed.
        assert_eq!(
            (results[1].status, results[1].changed),
            (Status::NotInstalled, false)
        );
        assert_eq!(fs::read_dir(&powerpoint).unwrap().count(), 0);
        fs::remove_file(&wef).unwrap();
        fs::create_dir(&wef).unwrap();
        symlink(&untouched, wef.join(addin.filename)).unwrap();
        for action in [Action::Status, Action::Install, Action::Remove] {
            assert_eq!(
                apply(&home.0, &addin, action)[0].status,
                Status::Unavailable
            );
        }
        assert_eq!(fs::read_to_string(untouched).unwrap(), "outside");
    }

    /// A home with both Office containers. Word has no `wef` folder yet; PowerPoint has one.
    fn office_home() -> (TempHome, PathBuf, PathBuf) {
        let home = TempHome::new();
        let word = container_path(&home.0, OfficeApp::Word);
        let powerpoint = container_path(&home.0, OfficeApp::PowerPoint);
        fs::create_dir_all(&word).unwrap();
        fs::create_dir_all(powerpoint.join("Data").join("Documents").join("wef")).unwrap();
        (home, word, powerpoint)
    }

    /// macOS's answer after Don't Allow: `EPERM`, for the chosen operations under `root`.
    fn deny_under<'a>(
        root: &'a Path,
        ops: &'static [Op],
    ) -> impl Fn(Op, &Path) -> io::Result<()> + 'a {
        move |op, path| {
            if ops.contains(&op) && path.starts_with(root) {
                Err(io::Error::from_raw_os_error(1))
            } else {
                Ok(())
            }
        }
    }

    /// Every path under `dir`, so a test can prove nothing was left behind.
    fn tree(dir: &Path) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(next) = pending.pop() {
            for entry in fs::read_dir(&next).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path.clone());
                }
                paths.push(path);
            }
        }
        paths.sort();
        paths
    }

    #[test]
    fn eperm_and_eacces_are_permission_denials() {
        for code in [1, 13] {
            assert_eq!(
                Failure::from(io::Error::from_raw_os_error(code)).kind,
                FailureKind::PermissionDenied
            );
        }
        assert_eq!(
            Failure::from(io::Error::from_raw_os_error(28)).kind,
            FailureKind::Other
        );
        let json = serde_json::to_value(OfficeAddinResult::failure(
            OfficeApp::Word,
            &Failure::from(io::Error::from_raw_os_error(1)),
        ))
        .unwrap();
        assert_eq!(json["status"], "unavailable");
        assert_eq!(json["errorKind"], "permissionDenied");
        assert!(json.get("rolledBack").is_none());
    }

    #[test]
    fn a_denial_names_this_builds_bundle_identifier_for_the_reset_command() {
        for (identifier, debug) in [
            (STABLE_IDENTIFIER, false),
            ("org.chemdraft.desktop.dev", true),
        ] {
            let addin = Addin::for_build(identifier, debug, Some(""));
            for action in [Action::Install, Action::Remove] {
                let (home, _word, powerpoint) = office_home();
                if action == Action::Remove {
                    let [word, powerpoint] = apply(&home.0, &addin, Action::Install);
                    assert!(word.changed && powerpoint.changed);
                }
                let gate = deny_under(&powerpoint, &[Op::Write, Op::Remove]);
                let [word, powerpoint] = apply_with(&Fs { gate: &gate }, &home.0, &addin, action);
                assert_eq!(powerpoint.error_kind, Some(FailureKind::PermissionDenied));
                let json = serde_json::to_value(&powerpoint).unwrap();
                assert_eq!(json["bundleIdentifier"], identifier, "{action:?}");
                // Only a denial carries it.
                assert_eq!(word.error, None);
                assert!(serde_json::to_value(&word)
                    .unwrap()
                    .get("bundleIdentifier")
                    .is_none());
            }
        }
        let home = TempHome::new();
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let gate = deny_under(&home.0, &[Op::Inspect]);
        for result in apply_with(&Fs { gate: &gate }, &home.0, &addin, Action::Install) {
            assert_eq!(result.error_kind, Some(FailureKind::PermissionDenied));
            assert_eq!(result.bundle_identifier.as_deref(), Some(STABLE_IDENTIFIER));
        }
    }

    #[test]
    fn a_denied_second_install_rolls_back_the_first_and_leaves_nothing_behind() {
        // Denied at the write, and denied at the rename after the temporary file exists.
        for ops in [&[Op::Write][..], &[Op::Rename], &[Op::Write, Op::Rename]] {
            let (home, word, powerpoint) = office_home();
            let before = (tree(&word), tree(&powerpoint));
            let gate = deny_under(&powerpoint, ops);
            let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
            let [word_result, powerpoint_result] =
                apply_with(&Fs { gate: &gate }, &home.0, &addin, Action::Install);
            assert_eq!(
                (
                    word_result.status,
                    word_result.changed,
                    word_result.rolled_back
                ),
                (Status::NotInstalled, false, true)
            );
            assert_eq!(word_result.error, None);
            assert_eq!(powerpoint_result.status, Status::Unavailable);
            assert_eq!(
                powerpoint_result.error_kind,
                Some(FailureKind::PermissionDenied)
            );
            assert!(powerpoint_result.error.unwrap().contains("not permitted"));
            // Word's manifest and the folders created for it are gone; no temporary file remains.
            assert_eq!((tree(&word), tree(&powerpoint)), before, "{ops:?}");
            // Allowing access afterwards installs both on the next try.
            assert_eq!(
                apply(&home.0, &addin, Action::Install)
                    .map(|result| (result.status, result.changed)),
                [(Status::InstalledSameVersion, true); 2]
            );
        }
    }

    #[test]
    fn a_denied_second_upgrade_restores_the_first_apps_previous_manifest_exactly() {
        let (home, word, powerpoint) = office_home();
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let word_wef = word.join("Data").join("Documents").join("wef");
        fs::create_dir_all(&word_wef).unwrap();
        let older = addin.manifest.replace("<Version>", "<Version>9");
        fs::write(word_wef.join(addin.filename), &older).unwrap();
        let gate = deny_under(&powerpoint, &[Op::Write]);
        let [word_result, _] = apply_with(&Fs { gate: &gate }, &home.0, &addin, Action::Install);
        assert_eq!(
            (
                word_result.status,
                word_result.changed,
                word_result.rolled_back
            ),
            (Status::InstalledOtherVersion, false, true)
        );
        assert_eq!(
            fs::read_to_string(word_wef.join(addin.filename)).unwrap(),
            older
        );
        assert_eq!(fs::read_dir(&word_wef).unwrap().count(), 1);
    }

    #[test]
    fn a_denied_second_remove_puts_the_first_apps_manifest_back() {
        let (home, word, powerpoint) = office_home();
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        apply(&home.0, &addin, Action::Install);
        let installed = (tree(&word), tree(&powerpoint));
        let word_manifest = manifest_path(&home.0, OfficeApp::Word, &addin);
        let gate = deny_under(&powerpoint, &[Op::Remove]);
        let [word_result, powerpoint_result] =
            apply_with(&Fs { gate: &gate }, &home.0, &addin, Action::Remove);
        assert_eq!(
            (
                word_result.status,
                word_result.changed,
                word_result.rolled_back
            ),
            (Status::InstalledSameVersion, false, true)
        );
        assert_eq!(
            powerpoint_result.error_kind,
            Some(FailureKind::PermissionDenied)
        );
        assert_eq!((tree(&word), tree(&powerpoint)), installed);
        assert_eq!(fs::read_to_string(word_manifest).unwrap(), addin.manifest);
    }

    /// A file swapped in after `inspect`, here while PowerPoint is being inspected (where macOS's
    /// permission prompt can wait), is read again before it is replaced or removed.
    #[test]
    fn a_manifest_replaced_between_inspect_and_change_is_left_alone() {
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let foreign = addin.manifest.replace(
            "<ProviderName>ChemDraft</ProviderName>",
            "<ProviderName>Someone Else</ProviderName>",
        );
        let older = addin.manifest.replace("<Version>", "<Version>9");
        for action in [Action::Install, Action::Remove] {
            let (home, word, powerpoint) = office_home();
            let word_wef = word.join("Data").join("Documents").join("wef");
            fs::create_dir_all(&word_wef).unwrap();
            let word_manifest = word_wef.join(addin.filename);
            let installed = if action == Action::Install {
                older.as_str()
            } else {
                apply(&home.0, &addin, Action::Install);
                addin.manifest.as_ref()
            };
            fs::write(&word_manifest, installed).unwrap();
            let swapped = std::cell::Cell::new(false);
            let swap = |op, path: &Path| {
                if op == Op::Inspect && path.starts_with(&powerpoint) && !swapped.replace(true) {
                    fs::write(&word_manifest, &foreign).unwrap();
                }
                Ok(())
            };
            let [word_result, powerpoint_result] =
                apply_with(&Fs { gate: &swap }, &home.0, &addin, action);
            assert!(swapped.get());
            assert_eq!(
                (word_result.status, word_result.changed, word_result.error),
                (Status::Unrecognized, false, None),
                "{action:?}"
            );
            assert_eq!(
                word_result.path.as_deref(),
                Some(word_manifest.to_str().unwrap())
            );
            assert_eq!(fs::read_to_string(&word_manifest).unwrap(), foreign);
            assert_eq!(fs::read_dir(&word_wef).unwrap().count(), 1);
            // An unrecognized file skips its app, as at inspect time; the other app proceeds.
            assert!(powerpoint_result.changed, "{action:?}");
            assert_eq!(
                manifest_path(&home.0, OfficeApp::PowerPoint, &addin).exists(),
                action == Action::Install
            );
        }
    }

    /// An undo reads the file again and puts the old one back only over exactly what the change
    /// left: the manifest it wrote, or nothing after a Remove.
    #[test]
    fn an_undo_never_replaces_a_file_swapped_in_after_the_change() {
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let foreign = addin.manifest.replace(
            "<ProviderName>ChemDraft</ProviderName>",
            "<ProviderName>Someone Else</ProviderName>",
        );
        let older = addin.manifest.replace("<Version>", "<Version>9");
        for (action, swapped_in, says) in [
            (
                Action::Install,
                foreign.as_str(),
                "is not a ChemDraft add-in manifest, so ChemDraft did not replace it.",
            ),
            (
                Action::Install,
                older.as_str(),
                "changed while ChemDraft was working, so ChemDraft did not replace it.",
            ),
            (
                Action::Remove,
                foreign.as_str(),
                "is not a ChemDraft add-in manifest, so ChemDraft did not replace it.",
            ),
        ] {
            let (home, _word, powerpoint) = office_home();
            if action == Action::Remove {
                apply(&home.0, &addin, Action::Install);
            }
            let word_manifest = manifest_path(&home.0, OfficeApp::Word, &addin);
            // PowerPoint's change is denied; just before, something replaces Word's file.
            let op = if action == Action::Install {
                Op::Write
            } else {
                Op::Remove
            };
            let gate = |seen, path: &Path| {
                if seen == op && path.starts_with(&powerpoint) {
                    fs::write(&word_manifest, swapped_in).unwrap();
                    return Err(io::Error::from_raw_os_error(1));
                }
                Ok(())
            };
            let [word_result, powerpoint_result] =
                apply_with(&Fs { gate: &gate }, &home.0, &addin, action);
            assert_eq!(
                powerpoint_result.error_kind,
                Some(FailureKind::PermissionDenied)
            );
            assert!(!word_result.rolled_back);
            assert_eq!(word_result.error_kind, Some(FailureKind::Other));
            let error = word_result.error.unwrap();
            assert!(
                error.starts_with("ChemDraft could not undo this change after PowerPoint failed: "),
                "{error}"
            );
            assert!(
                error.ends_with(&format!("{} {says}", word_manifest.display())),
                "{error}"
            );
            assert_eq!(fs::read_to_string(&word_manifest).unwrap(), swapped_in);
        }
    }

    /// Another process (not covered by `ACTION_LOCK`) replaces Word's file after the re-read, just
    /// before the file is renamed into place or removed. Its file is never replaced or deleted.
    #[test]
    fn a_manifest_replaced_after_the_reread_is_left_in_place() {
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let foreign = addin.manifest.replace(
            "<ProviderName>ChemDraft</ProviderName>",
            "<ProviderName>Someone Else</ProviderName>",
        );
        for (action, op) in [(Action::Install, Op::Rename), (Action::Remove, Op::Remove)] {
            let (home, _word, _powerpoint) = office_home();
            if action == Action::Remove {
                apply(&home.0, &addin, Action::Install);
            }
            let word_manifest = manifest_path(&home.0, OfficeApp::Word, &addin);
            let swapped = std::cell::Cell::new(false);
            let swap = |seen, path: &Path| {
                if seen == op && path == word_manifest && !swapped.replace(true) {
                    fs::write(&word_manifest, &foreign).unwrap();
                }
                Ok(())
            };
            let [word_result, powerpoint_result] =
                apply_with(&Fs { gate: &swap }, &home.0, &addin, action);
            assert!(swapped.get(), "{action:?}");
            assert_eq!(
                (word_result.status, word_result.changed, word_result.error),
                (Status::Unrecognized, false, None),
                "{action:?}"
            );
            assert_eq!(fs::read_to_string(&word_manifest).unwrap(), foreign);
            // No staged or set-aside file is left in Word's folder.
            assert_eq!(
                fs::read_dir(word_manifest.parent().unwrap())
                    .unwrap()
                    .count(),
                1,
                "{action:?}"
            );
            assert!(powerpoint_result.changed, "{action:?}");
            assert_eq!(
                manifest_path(&home.0, OfficeApp::PowerPoint, &addin).exists(),
                action == Action::Install
            );
        }
    }

    /// An upgrade whose file another process replaces with a different ChemDraft manifest after
    /// the re-read keeps that file and stops, so PowerPoint is not left changed alone.
    #[test]
    fn an_upgrade_never_replaces_a_manifest_changed_after_the_reread() {
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let older = addin.manifest.replace("<Version>", "<Version>9");
        let other = addin.manifest.replace("<Version>", "<Version>8");
        let (home, word, _powerpoint) = office_home();
        let word_wef = word.join("Data").join("Documents").join("wef");
        fs::create_dir_all(&word_wef).unwrap();
        let word_manifest = word_wef.join(addin.filename);
        fs::write(&word_manifest, &older).unwrap();
        let swap = |seen, path: &Path| {
            if seen == Op::Rename && path == word_manifest {
                fs::write(&word_manifest, &other).unwrap();
            }
            Ok(())
        };
        let [word_result, powerpoint_result] =
            apply_with(&Fs { gate: &swap }, &home.0, &addin, Action::Install);
        let error = word_result.error.unwrap();
        assert!(
            error.ends_with("changed while ChemDraft was working, so ChemDraft left it in place."),
            "{error}"
        );
        assert!(!word_result.changed);
        assert_eq!(fs::read_to_string(&word_manifest).unwrap(), other);
        assert_eq!(fs::read_dir(&word_wef).unwrap().count(), 1);
        assert!(!powerpoint_result.changed);
        assert!(!manifest_path(&home.0, OfficeApp::PowerPoint, &addin).exists());
    }

    /// Word's Remove succeeded and PowerPoint's failed. Between the undo's check that Word's path
    /// is empty and the restore, another process creates a file there: the undo keeps it.
    #[test]
    fn an_undo_after_remove_never_replaces_a_file_created_after_its_check() {
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let foreign = addin.manifest.replace(
            "<ProviderName>ChemDraft</ProviderName>",
            "<ProviderName>Someone Else</ProviderName>",
        );
        let (home, _word, powerpoint) = office_home();
        apply(&home.0, &addin, Action::Install);
        let word_manifest = manifest_path(&home.0, OfficeApp::Word, &addin);
        let gate = |seen, path: &Path| {
            if seen == Op::Remove && path.starts_with(&powerpoint) {
                return Err(io::Error::from_raw_os_error(1));
            }
            // The undo's restore of Word's manifest, after its read found the path empty.
            if seen == Op::Rename && path == word_manifest {
                fs::write(&word_manifest, &foreign).unwrap();
            }
            Ok(())
        };
        let [word_result, powerpoint_result] =
            apply_with(&Fs { gate: &gate }, &home.0, &addin, Action::Remove);
        assert_eq!(
            powerpoint_result.error_kind,
            Some(FailureKind::PermissionDenied)
        );
        assert!(!word_result.rolled_back);
        let error = word_result.error.unwrap();
        assert!(
            error.ends_with(&format!(
                "{} is not a ChemDraft add-in manifest, so ChemDraft did not replace it.",
                word_manifest.display()
            )),
            "{error}"
        );
        assert_eq!(fs::read_to_string(&word_manifest).unwrap(), foreign);
        assert_eq!(
            fs::read_dir(word_manifest.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn a_denied_read_writes_nothing_to_either_app() {
        for op in [Op::Inspect, Op::Read] {
            let (home, word, powerpoint) = office_home();
            let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
            // PowerPoint holds an older manifest, so Inspect and Read both run on it.
            fs::write(
                manifest_path(&home.0, OfficeApp::PowerPoint, &addin),
                addin.manifest.replace("<Version>", "<Version>9"),
            )
            .unwrap();
            let before = (tree(&word), tree(&powerpoint));
            let data = powerpoint.join("Data");
            let gate = deny_under(
                &data,
                if op == Op::Inspect {
                    &[Op::Inspect]
                } else {
                    &[Op::Read]
                },
            );
            let attempted = std::cell::RefCell::new(Vec::new());
            let recording = |op, path: &Path| {
                if !matches!(op, Op::Inspect | Op::Read) {
                    attempted.borrow_mut().push((op, path.to_path_buf()));
                }
                gate(op, path)
            };
            for action in [Action::Install, Action::Remove] {
                let [word_result, powerpoint_result] =
                    apply_with(&Fs { gate: &recording }, &home.0, &addin, action);
                assert_eq!(
                    (
                        word_result.status,
                        word_result.changed,
                        word_result.rolled_back
                    ),
                    (Status::NotInstalled, false, false)
                );
                assert_eq!(
                    (powerpoint_result.status, powerpoint_result.error_kind),
                    (Status::Unavailable, Some(FailureKind::PermissionDenied))
                );
            }
            assert!(attempted.borrow().is_empty(), "{:?}", attempted.borrow());
            assert_eq!((tree(&word), tree(&powerpoint)), before);
        }
    }

    #[test]
    fn commands_run_the_file_work_off_the_main_thread() {
        let source = include_str!("office_addin.rs");
        for command in ["office_addin_install", "office_addin_remove"] {
            // Tauri 2 runs a non-async command on the main thread.
            assert!(source.contains(&format!("pub(crate) async fn {command}(")));
        }
        let run = source.split("async fn run(").nth(1).unwrap();
        let run = run.split("#[tauri::command]").next().unwrap();
        let blocking = run.find("spawn_blocking(").unwrap();
        assert!(run.find("apply(&home, &addin, action)").unwrap() > blocking);
    }

    #[test]
    fn embedded_manifest_matches_the_versioned_office_build() {
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        assert!(addin.is_current(STABLE_MANIFEST));
        assert!(!STABLE_MANIFEST.contains("{{"));
        let urls = STABLE_MANIFEST
            .split("DefaultValue=\"")
            .skip(1)
            .filter_map(|part| {
                let value = part.split('"').next()?;
                value.contains("://").then_some(value)
            })
            .collect::<Vec<_>>();
        assert_eq!(urls.len(), 8);
        let versioned_url = concat!(
            "https://chemdraft.ai/office/",
            env!("CARGO_PKG_VERSION"),
            "/"
        );
        assert!(urls
            .iter()
            .all(|url| url.starts_with(versioned_url) || *url == "https://chemdraft.ai/"));
        if let Some(built) = std::env::var_os("CHEMDRAFT_TEST_OFFICE_MANIFEST") {
            assert_eq!(fs::read_to_string(built).unwrap(), STABLE_MANIFEST);
        }
    }
}
