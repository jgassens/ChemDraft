//! Codex saves auth with rename, breaking both symlinks and Windows hard links. Reconcile
//! before reuse and after every supervised process. Never put credential bytes in diagnostics.
use super::{
    env::{self, CodexHome, CodexHomeFallbackKind, ParentEnv},
    probe::ProbePlatform,
};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

static AUTH_LOCK: Mutex<()> = Mutex::new(());
const BLOCKED: &str = "auth-reconcile-blocked";
const CONFLICT_PREFIX: &str = "auth.json.chemdraft-conflict-";

pub(super) fn sign_in_unavailable_detail(platform: ProbePlatform) -> &'static str {
    match platform {
        ProbePlatform::MacOS => "ChemDraft could not read your Codex sign-in from your Mac's Keychain. Sign in again from Setup.",
        ProbePlatform::Windows => "ChemDraft could not read your Codex sign-in from the system credential store (Credential Manager). Sign in again from Setup.",
    }
}

/// Only host-owned paths, captured BEFORE CODEX_HOME is changed for the child.
#[derive(Clone)]
pub(super) struct CodexAuth {
    platform: ProbePlatform,
    base: PathBuf,
    parent: ParentEnv,
    pub(super) processes: Option<Arc<super::run::CodexProcesses>>,
}
impl CodexAuth {
    pub(super) fn new(platform: ProbePlatform, base: &Path, parent: &ParentEnv) -> Self {
        #[cfg(test)]
        let parent = &super::test_support::isolated_parent(parent, base).unwrap();
        let mut original = ParentEnv::new();
        if let Some(home) = env::real_codex_home(platform, parent) {
            // Relative overrides are relative to the host, never the conversation's cwd.
            let home = std::path::absolute(&home).unwrap_or(home);
            original.insert("CODEX_HOME".into(), home.to_string_lossy().into_owned());
        }
        Self {
            platform,
            base: base.to_owned(),
            parent: original,
            processes: None,
        }
    }
    pub(super) fn tracked(mut self, processes: &Arc<super::run::CodexProcesses>) -> Self {
        self.processes = Some(processes.clone());
        self
    }
    pub(super) fn prepare(&self) -> CodexHome {
        prepare_codex_home(self.platform, &self.base, &self.parent)
    }
    pub(super) fn reconcile(&self) -> Option<String> {
        env::reconcile_codex_home_auth(self.platform, &self.base, &self.parent).fallback_reason
    }
}

/// Also used by the supervisor's error paths if a process could not be started/contained.
pub(super) struct CodexAuthCleanup(pub(super) Option<CodexAuth>);
impl CodexAuthCleanup {
    pub(super) fn finish(&mut self) -> Option<String> {
        self.0.take().and_then(|auth| auth.reconcile())
    }
}
impl Drop for CodexAuthCleanup {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

pub fn prepare_codex_home(platform: ProbePlatform, base: &Path, parent: &ParentEnv) -> CodexHome {
    reconcile_codex_home_auth(platform, base, parent)
}

pub fn reconcile_codex_home_auth(
    platform: ProbePlatform,
    base: &Path,
    parent: &ParentEnv,
) -> CodexHome {
    prepare_codex_home_with_link(platform, base, parent, link_auth)
}

pub(super) fn prepare_codex_home_with_link(
    platform: ProbePlatform,
    base: &Path,
    parent: &ParentEnv,
    link: impl FnOnce(ProbePlatform, &Path, &Path) -> io::Result<()>,
) -> CodexHome {
    #[cfg(test)]
    {
        super::test_support::check_path(base).unwrap();
        if let Some(home) = env::real_codex_home(platform, parent) {
            super::test_support::check_path(&home).unwrap();
            super::test_support::check_path(&home.join("auth.json")).unwrap();
        }
        super::test_support::check_path(&base.join("codex-home/auth.json")).unwrap();
    }
    // Serializes reconciliation, quarantine and link creation, including overlapping probes.
    let _lock = AUTH_LOCK.lock().unwrap();
    let real_home = env::real_codex_home(platform, parent)
        .map(|home| std::path::absolute(&home).unwrap_or(home));
    let isolated = base.join("codex-home");
    let mut fallback_kind = CodexHomeFallbackKind::PreparationFailed;
    let prepared = (|| {
        let real_home = real_home
            .as_ref()
            .ok_or("User's Codex home could not be resolved.")?;
        for path in [base, &isolated] {
            if metadata(path)?.is_some_and(|m| m.file_type().is_symlink()) {
                return Err("ChemDraft's Codex home must not be a symbolic link.".into());
            }
            super::private_dir(path).map_err(|e| io_reason("create private Codex home", e))?;
        }
        let isolated =
            fs::canonicalize(&isolated).map_err(|e| io_reason("resolve Codex home", e))?;
        let target = isolated.join("auth.json");
        if fs::canonicalize(real_home).ok().as_ref() == Some(&isolated) {
            return Err("User's CODEX_HOME is already ChemDraft's isolated home.".into());
        }
        // The persistent conflict marker contains no credentials. Within this home, quarantine
        // files are the only other retained credential files besides auth.json: private (0600
        // on Unix, the user's directory ACL on Windows), with contents never logged.
        if metadata(&isolated.join(BLOCKED))?.is_some()
            || fs::read_dir(&isolated)
                .map_err(|e| io_reason("inspect Codex home", e))?
                .any(|entry| {
                    entry.map_or(true, |e| {
                        e.file_name().to_string_lossy().starts_with(CONFLICT_PREFIX)
                    })
                })
        {
            return Err(format!("Unresolved Codex auth reconciliation conflict in {}. Review the quarantined auth file before re-enabling isolation.", isolated.display()));
        }
        let requested = real_home.join("auth.json");
        // Logout leaves a dangling symlink on macOS but a readable hard link on Windows.
        // Neither is evidence of a conflicting refresh. Leave it unused and retry isolation
        // after the user's login is available again, without resurrecting it via write-back.
        require_readable_auth(&requested, &mut fallback_kind)?;
        // Preserve user-owned symlinks by writing to their actual target, never replacing them.
        let auth = fs::canonicalize(&requested).map_err(|e| {
            fallback_kind = CodexHomeFallbackKind::AuthJsonUnreadable;
            io_reason("resolve user's Codex auth.json", e)
        })?;
        if auth == target {
            return Err("User's CODEX_HOME is already ChemDraft's isolated home.".into());
        }
        let target_meta = metadata(&target)?;
        if let Some(meta) = target_meta.as_ref() {
            let linked = if platform == ProbePlatform::MacOS && meta.file_type().is_symlink() {
                fs::read_link(&target).map_err(|e| io_reason("read Codex auth link", e))? == auth
            } else if platform == ProbePlatform::Windows
                && meta.is_file()
                && !meta.file_type().is_symlink()
            {
                match same_file(&target, &auth) {
                    Ok(same) => same,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => false,
                    Err(e) => return Err(io_reason("identify Codex auth link", e)),
                }
            } else {
                false
            };
            if linked {
                require_readable_auth(&auth, &mut fallback_kind)?;
                return Ok(());
            }
            if let Err(reason) = reconcile_copy(&target, &auth) {
                return Err(quarantine(&isolated, &target, reason));
            }
        }
        require_readable_auth(&auth, &mut fallback_kind)?;
        let staged = isolated.join(format!("auth-link-{}", super::nonce()));
        // The user's auth is readable; link failures concern ChemDraft's private folder.
        link(platform, &auth, &staged).map_err(|e| io_reason("link Codex auth.json", e))?;
        // std::fs::rename uses replacement on both Unix and Windows (MoveFileExW).
        if let Err(e) = fs::rename(&staged, &target) {
            let _ = fs::remove_file(staged);
            return Err(io_reason("replace Codex auth link", e));
        }
        Ok(())
    })();
    match prepared {
        Ok(()) => CodexHome {
            path: Some(isolated),
            fallback_reason: None,
            fallback_kind: None,
        },
        Err(reason) => CodexHome {
            path: real_home,
            fallback_kind: Some(fallback_kind),
            fallback_reason: Some(format!(
                "Codex home isolation unavailable; using the user's real Codex home. {reason}"
            )),
        },
    }
}

fn io_reason(action: &str, error: io::Error) -> String {
    // OS kind only: never format a parser error, credential value, or arbitrary error payload.
    format!("Could not {action} ({:?}).", error.kind())
}
fn metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_reason("inspect auth path", e)),
    }
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    #[cfg(test)]
    super::test_support::check_path(path)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound && metadata(path)?.is_none() => Ok(None),
        Err(e) => Err(io_reason("read Codex auth.json", e)),
    }
}
fn require_readable_auth(
    path: &Path,
    fallback_kind: &mut CodexHomeFallbackKind,
) -> Result<(), String> {
    // is_file() hides permission/read errors as absence. Only a confirmed missing path is
    // normal before sign-in; an existing dangling symlink still counts as unreadable.
    let result = match fs::metadata(path) {
        Ok(meta) if !meta.is_file() => Err("User's Codex auth.json is not a regular file.".into()),
        Ok(_) => read_optional(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => read_optional(path),
        Err(e) => Err(io_reason("inspect Codex auth.json", e)),
    };
    match result {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            *fallback_kind = CodexHomeFallbackKind::AuthJsonAbsent;
            Err("User's Codex auth.json is absent.".into())
        }
        Err(reason) => {
            *fallback_kind = CodexHomeFallbackKind::AuthJsonUnreadable;
            Err(reason)
        }
    }
}
fn last_refresh(bytes: &[u8]) -> Result<chrono::DateTime<chrono::FixedOffset>, String> {
    #[derive(serde::Deserialize)]
    struct Refresh {
        last_refresh: String,
    }
    let value: Refresh = serde_json::from_slice(bytes).map_err(|_| {
        "Codex auth.json is not valid JSON with a last_refresh timestamp.".to_owned()
    })?;
    chrono::DateTime::parse_from_rfc3339(&value.last_refresh)
        .map_err(|_| "Codex auth.json last_refresh is not RFC 3339.".into())
}
fn reconcile_copy(target: &Path, auth: &Path) -> Result<(), String> {
    // Protect a regular refreshed file before reading or retaining it. Do not chmod a symlink's
    // possibly unrelated destination; the containing directory already has mode 0700.
    if fs::symlink_metadata(target)
        .map_err(|e| io_reason("inspect refreshed auth", e))?
        .is_file()
    {
        private_file(target).map_err(|e| io_reason("protect refreshed auth", e))?;
    }
    let refreshed = fs::read(target).map_err(|e| io_reason("read refreshed auth", e))?;
    let refreshed_at = last_refresh(&refreshed)?;
    let previous = read_optional(auth)?;
    let replace = match previous.as_ref() {
        None => true,
        Some(previous) => {
            let previous_at = last_refresh(previous)?;
            if refreshed_at == previous_at && *previous != refreshed {
                return Err(format!(
                    "Codex auth files differ at equal last_refresh timestamp {refreshed_at}."
                ));
            }
            refreshed_at > previous_at
        }
    };
    if fs::read(target).map_err(|e| io_reason("recheck refreshed auth", e))? != refreshed {
        return Err("ChemDraft's Codex auth changed during reconciliation.".into());
    }
    if replace {
        atomic_write_back(auth, &refreshed, previous.as_deref())?;
    } else if read_optional(auth)? != previous {
        return Err("User's Codex auth changed during reconciliation.".into());
    }
    if fs::read(target).map_err(|e| io_reason("recheck refreshed auth", e))? != refreshed {
        return Err("ChemDraft's Codex auth changed during reconciliation.".into());
    }
    // Only a proven older/equal copy or a successfully persisted refresh can be discarded.
    fs::remove_file(target).map_err(|e| io_reason("remove reconciled auth", e))
}

fn atomic_write_back(auth: &Path, bytes: &[u8], previous: Option<&[u8]>) -> Result<(), String> {
    atomic_write_back_verified(auth, bytes, previous, verify_written_auth)
}

fn verify_written_auth(auth: &Path, expected: &[u8]) -> Result<(), String> {
    let written = read_optional(auth)?.ok_or("Written Codex auth.json is missing.")?;
    if last_refresh(&written)? != last_refresh(expected)? || written != expected {
        return Err("Written Codex auth.json does not match the expected refresh.".into());
    }
    Ok(())
}

fn atomic_write_back_verified(
    auth: &Path,
    bytes: &[u8],
    previous: Option<&[u8]>,
    verify: impl FnOnce(&Path, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    #[cfg(test)]
    super::test_support::check_path(auth)?;
    let previous = previous.ok_or(
        "User's Codex auth.json is missing; refusing write-back without an original backup.",
    )?;
    let directory = auth
        .parent()
        .ok_or("User's Codex auth directory is unavailable.")?;
    let staged = directory.join(format!(".auth.json.chemdraft-{}.tmp", super::nonce()));
    let backup = directory.join("auth.json.bak");
    if metadata(&backup)?.is_some() {
        return Err(
            "Codex auth.json.bak already exists; retain it for recovery before retrying.".into(),
        );
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&staged)
        .map_err(|e| io_reason("stage Codex auth write-back", e))?;
    let result = (|| {
        private_file(&staged).map_err(|e| io_reason("protect staged Codex auth", e))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| io_reason("sync Codex auth write-back", e))?;
        drop(file);
        // Do not overwrite another Codex process's refresh observed while staging the write.
        if read_optional(auth)?.as_deref() != Some(previous) {
            return Err("User's Codex auth changed during reconciliation.".into());
        }
        // Copy into a new private file, never move/truncate the live login. Keep this recovery
        // copy across commit and verification (including failures or host termination).
        {
            let mut backup_file = options
                .open(&backup)
                .map_err(|e| io_reason("create Codex auth backup", e))?;
            private_file(&backup).map_err(|e| io_reason("protect Codex auth backup", e))?;
            backup_file
                .write_all(previous)
                .and_then(|_| backup_file.sync_all())
                .map_err(|e| io_reason("sync Codex auth backup", e))?;
        }
        if read_optional(auth)?.as_deref() != Some(previous) {
            return Err("User's Codex auth changed during reconciliation; backup retained.".into());
        }
        fs::rename(&staged, auth).map_err(|e| io_reason("commit Codex auth write-back", e))?;
        if let Err(reason) = verify(auth, bytes) {
            let restored = fs::rename(&backup, auth);
            return Err(match restored {
                Ok(()) => format!(
                    "Codex auth write-back verification failed; original restored. {reason}"
                ),
                Err(e) => format!(
                    "Codex auth write-back verification failed; backup retained. {reason} {}",
                    io_reason("restore Codex auth backup", e)
                ),
            });
        }
        fs::remove_file(&backup).map_err(|e| io_reason("remove verified Codex auth backup", e))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staged);
    }
    result
}

fn quarantine(isolated: &Path, target: &Path, reason: String) -> String {
    // Persist the refusal first, so even a failed rename cannot put this credential back in use.
    let marked = super::write_private(&isolated.join(BLOCKED), reason.as_bytes());
    let conflict = isolated.join(format!(
        "{CONFLICT_PREFIX}{}-{}",
        chrono::Utc::now().timestamp_millis(),
        super::nonce()
    ));
    let retained = if fs::symlink_metadata(target).is_ok_and(|m| m.is_file()) {
        private_file(target).and_then(|_| fs::rename(target, &conflict))
    } else {
        fs::rename(target, &conflict)
    };
    match (marked, retained) {
        (_, Ok(())) => format!(
            "{reason} Refreshed auth quarantined at {}.",
            conflict.display()
        ),
        (Ok(()), Err(e)) => format!(
            "{reason} {} Isolated home remains blocked.",
            io_reason("quarantine refreshed auth", e)
        ),
        (Err(_), Err(e)) => format!(
            "{reason} {} Isolated home must not be used.",
            io_reason("quarantine refreshed auth", e)
        ),
    }
}
fn private_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        // Inherit the user's private directory ACL; Windows has no POSIX mode bits.
        let _ = path;
        Ok(())
    }
}
fn link_auth(platform: ProbePlatform, source: &Path, target: &Path) -> io::Result<()> {
    match platform {
        ProbePlatform::Windows => fs::hard_link(source, target),
        ProbePlatform::MacOS => {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(source, target)
            }
            #[cfg(not(unix))]
            {
                Err(io::ErrorKind::Unsupported.into())
            }
        }
    }
}

fn same_file(left: &Path, right: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (left, right) = (fs::metadata(left)?, fs::metadata(right)?);
        Ok(left.dev() == right.dev() && left.ino() == right.ino() && left.nlink() >= 2)
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        fn identity(path: &Path) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
            let file = fs::File::open(path)?;
            // SAFETY: initialized output structure and a live, owned file handle.
            let mut info = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(info)
        }
        let (left, right) = (identity(left)?, identity(right)?);
        Ok(left.dwVolumeSerialNumber == right.dwVolumeSerialNumber
            && left.nFileIndexHigh == right.nFileIndexHigh
            && left.nFileIndexLow == right.nFileIndexLow
            && left.nNumberOfLinks >= 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_back_refuses_changed_user_auth_and_removes_staging() {
        let directory =
            std::env::temp_dir().join(format!("chemdraft-auth-{}", super::super::nonce()));
        super::super::private_dir(&directory).unwrap();
        super::super::test_support::register(&directory);
        let auth = directory.join("auth.json");
        fs::write(&auth, b"fake-new-secret").unwrap();
        let error = atomic_write_back(&auth, b"fake-invalid-secret", Some(b"fake-old-secret"))
            .expect_err("concurrent replacement must be refused");
        for token in ["fake-old-secret", "fake-new-secret", "fake-invalid-secret"] {
            assert!(!error.contains(token), "credential leaked in diagnostics");
        }
        assert!(error.contains("changed during reconciliation"));
        assert!(
            fs::read(&auth).unwrap() == b"fake-new-secret",
            "concurrent login was overwritten"
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backup_survives_until_verification_and_bad_refresh_restores_original() {
        for fail in [false, true] {
            let directory =
                std::env::temp_dir().join(format!("chemdraft-auth-{}", super::super::nonce()));
            super::super::private_dir(&directory).unwrap();
            super::super::test_support::register(&directory);
            let auth = directory.join("auth.json");
            let backup = directory.join("auth.json.bak");
            let old = br#"{"last_refresh":"2026-10-22T12:00:00Z","tokens":{"refresh_token":"fake-old-secret"}}"#;
            let new = br#"{"last_refresh":"2026-10-23T12:00:00Z","tokens":{"refresh_token":"fake-new-secret"}}"#;
            super::super::write_private(&auth, old).unwrap();
            let result = atomic_write_back_verified(&auth, new, Some(old), |auth, expected| {
                assert!(fs::read(&backup).unwrap() == old);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }
                if fail {
                    fs::write(auth, b"{fake-invalid-secret").unwrap();
                }
                verify_written_auth(auth, expected)
            });
            assert_eq!(result.is_err(), fail);
            if let Err(reason) = result {
                assert!(reason.contains("original restored"));
                assert!(!reason.contains("fake-"));
            }
            assert!(fs::read(&auth).unwrap() == if fail { &old[..] } else { &new[..] });
            assert!(!backup.exists());
            // A backup from an interrupted run must never be overwritten or removed.
            fs::write(&backup, old).unwrap();
            assert!(atomic_write_back(&auth, new, Some(old))
                .unwrap_err()
                .contains("already exists"));
            assert!(fs::read(&backup).unwrap() == old);
            fs::remove_dir_all(directory).unwrap();
        }
    }
}
