//! Renew per-run file access from the app's persisted session, never from an IPC path argument.
use serde_json::Value;
use std::{fs, path::Path};

pub(crate) mod pending_opens {
    use std::{
        collections::HashSet,
        fs::{self, File, OpenOptions},
        io,
        path::{Path, PathBuf},
    };

    const FILENAME: &str = "pending-opens.json";
    const LIMIT: usize = 50;

    struct PendingLock(File);

    impl Drop for PendingLock {
        fn drop(&mut self) {
            // Explicitly release the lock even if a concurrent child launch inherited the
            // descriptor between fork and exec.
            let _ = self.0.unlock();
        }
    }

    // Lock a stable inode because the JSON file is replaced on every update.
    fn lock(directory: &Path) -> Result<PendingLock, String> {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let mut options = OpenOptions::new();
        options.write(true).read(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(directory.join("pending-opens.lock"))
            .map_err(|error| error.to_string())?;
        // Shutdown must never wait on another writer.
        file.try_lock()
            .map_err(|error| format!("Could not lock pending opens: {error:?}"))?;
        Ok(PendingLock(file))
    }

    // Strings are the existing retry-on-launch format. OS shutdowns leave a native notice.
    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(untagged)]
    enum Entry {
        Replay(String),
        Notice { path: String },
    }

    impl Entry {
        fn path(&self) -> &str {
            match self {
                Self::Replay(path) | Self::Notice { path } => path,
            }
        }
    }

    fn read(file: &Path) -> Result<Vec<Entry>, String> {
        super::super::read_optional_file(file)?
            .map(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    fn write(file: &Path, entries: &[Entry], immediate: bool) -> Result<(), String> {
        if entries.is_empty() {
            return match fs::remove_file(file) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                result => result.map_err(|error| error.to_string()),
            };
        }
        let json = serde_json::to_string(entries).map_err(|error| error.to_string())?;
        if immediate {
            super::super::write_file_atomic_with(file, &json, |temp, target| {
                fs::rename(temp, target)
            })
        } else {
            super::super::write_file_atomic(file, &json)
        }
    }

    pub(crate) fn append(directory: &Path, paths: &[String], notice: bool) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let _guard = lock(directory)?;
        let file = directory.join(FILENAME);
        let mut pending = read(&file)?;
        pending.extend(paths.iter().cloned().map(|path| {
            if notice {
                Entry::Notice { path }
            } else {
                Entry::Replay(path)
            }
        }));
        let mut seen = HashSet::new();
        pending.reverse();
        pending.retain(|entry| seen.insert(entry.path().to_owned()));
        pending.reverse();
        let dropped = pending.len().saturating_sub(LIMIT);
        if dropped > 0 {
            eprintln!(
                "ChemDraft: dropping {dropped} oldest pending document opens (limit {LIMIT})"
            );
            pending.drain(..dropped);
        }
        write(&file, &pending, notice)
    }

    pub(crate) struct Notice {
        directory: PathBuf,
        paths: Vec<String>,
    }

    impl Notice {
        pub(crate) fn message(&self) -> String {
            format!(
                "These files were not opened before ChemDraft quit:\n\n{}",
                self.paths.join("\n")
            )
        }

        pub(crate) fn acknowledge(self) -> Result<(), String> {
            let _guard = lock(&self.directory)?;
            let file = self.directory.join(FILENAME);
            let mut entries = read(&file)?;
            let before = entries.len();
            entries.retain(
                |entry| !matches!(entry, Entry::Notice { path } if self.paths.contains(path)),
            );
            if entries.len() != before {
                write(&file, &entries, false)?;
            }
            Ok(())
        }
    }

    pub(crate) fn read_notice(directory: &Path) -> Result<Option<Notice>, String> {
        let file = directory.join(FILENAME);
        if !file.try_exists().map_err(|error| error.to_string())? {
            return Ok(None);
        }
        let _guard = lock(directory)?;
        let paths: Vec<_> = read(&file)?
            .into_iter()
            .filter_map(|entry| match entry {
                Entry::Notice { path } => Some(path),
                Entry::Replay(_) => None,
            })
            .collect();
        Ok((!paths.is_empty()).then(|| Notice {
            directory: directory.to_owned(),
            paths,
        }))
    }

    #[derive(Default)]
    pub(crate) struct Replay(Option<Vec<Option<String>>>);

    impl Replay {
        pub(crate) fn start(
            &mut self,
            directory: &Path,
            mut deliver: impl FnMut(usize, &str),
        ) -> Result<(), String> {
            if self.0.is_some() {
                return Ok(());
            }
            let file = directory.join(FILENAME);
            let paths: Vec<_> = if file.try_exists().map_err(|error| error.to_string())? {
                let _guard = lock(directory)?;
                read(&file)?
                    .into_iter()
                    .filter_map(|entry| match entry {
                        Entry::Replay(path) => Some(path),
                        Entry::Notice { .. } => None,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            for (receipt, path) in paths.iter().enumerate() {
                deliver(receipt, path);
            }
            self.0 = Some(paths.into_iter().map(Some).collect());
            Ok(())
        }

        pub(crate) fn confirm(&mut self, directory: &Path, receipt: usize) -> Result<(), String> {
            let Some(slot) = self.0.as_mut().and_then(|paths| paths.get_mut(receipt)) else {
                return Ok(());
            };
            let Some(path) = slot.as_deref() else {
                return Ok(());
            };
            let _guard = lock(directory)?;
            let file = directory.join(FILENAME);
            let mut entries = read(&file)?;
            let before = entries.len();
            entries.retain(|entry| !matches!(entry, Entry::Replay(pending) if pending == path));
            if entries.len() != before {
                write(&file, &entries, false)?;
            }
            *slot = None;
            Ok(())
        }
    }
}

/// Match the readable tab envelope in documentSession.ts. Cosmetic metadata is optional. Do not
/// treat the outer active-tab mirror, document contents, or arbitrary nested objects as file grants.
fn readable_tab(tab: &Value) -> bool {
    tab.is_object()
        && tab.get("version").and_then(Value::as_u64) == Some(1)
        && tab.get("tabs").is_none()
        && tab
            .get("contents")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
        && ["payloadHash", "displayName", "savedAt"]
            .iter()
            .all(|key| tab.get(key).is_some_and(Value::is_string))
        && ["blank", "dirty"]
            .iter()
            .all(|key| tab.get(key).is_some_and(Value::is_boolean))
        && tab.get("path").is_none_or(Value::is_string)
        && tab.get("pristine").is_none_or(Value::is_boolean)
        && tab.get("unrestoredTabs").is_none_or(Value::is_array)
}

fn check_saved_file(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("the saved path is not absolute".into());
    }
    if path
        .as_os_str()
        .to_string_lossy()
        .split(['/', '\\'])
        .any(|part| matches!(part, "." | ".."))
    {
        return Err("the saved path contains a dot component".into());
    }
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("chemdraft")
                || ext.eq_ignore_ascii_case("cdxml")
                || ext.eq_ignore_ascii_case("cdx")
        })
    {
        return Err("the saved path is not a ChemDraft, CDXML or CDX file".into());
    }
    // Inspect every component, so a symlinked parent cannot redirect an otherwise ordinary file.
    // On Windows also reject junctions and other reparse points. Never canonicalize and grant a
    // different target instead. These checks are deliberately conservative; Save As can reauthorize.
    for component in path.ancestors() {
        let metadata = fs::symlink_metadata(component)
            .map_err(|error| format!("the saved file is unavailable: {error}"))?;
        if metadata.is_symlink() {
            return Err("the saved path uses a symbolic link".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("the saved path uses a reparse point".into());
            }
        }
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("the saved file is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("the saved path is not a regular file".into());
    }
    if metadata.permissions().readonly() {
        return Err("the saved file is read-only".into());
    }
    Ok(())
}

/// Called only with JSON read natively from DOCUMENT_SESSION_FILENAME. The callback grants one
/// literal file in the fs/asset scopes. A failure annotates this response, preserving all recovery
/// contents and the original path; the frontend then uses Save As. The annotation is not authority.
pub(crate) fn restore_file_scopes(
    session: &mut Value,
    mut allow_file: impl FnMut(&Path) -> Result<(), String>,
) {
    fn restore_tab(tab: &mut Value, allow_file: &mut impl FnMut(&Path) -> Result<(), String>) {
        if !readable_tab(tab) {
            return;
        }
        // Never trust a stale annotation from disk; recompute it for this run.
        tab.as_object_mut().unwrap().remove("restoreSavePathError");
        if let Some(path) = tab.get("path").and_then(Value::as_str) {
            if let Err(error) =
                check_saved_file(Path::new(path)).and_then(|()| allow_file(Path::new(path)))
            {
                tab["restoreSavePathError"] = Value::String(error);
            }
        }
    }

    if session.get("version").and_then(Value::as_u64) != Some(1) {
        return;
    }
    if let Some(tabs) = session.get("tabs") {
        let Some(tabs) = tabs.as_array() else { return };
        if tabs.is_empty()
            || !session
                .get("activeTabIndex")
                .and_then(Value::as_u64)
                .is_some_and(|index| index < tabs.len() as u64)
            || !session.get("unrestoredTabs").is_none_or(Value::is_array)
        {
            return;
        }
        for tab in session["tabs"].as_array_mut().unwrap() {
            restore_tab(tab, &mut allow_file);
        }
    } else {
        if !readable_tab(session) {
            return;
        }
        restore_tab(session, &mut allow_file);
    }
    // Previously unreadable tabs are retried by the frontend too, but only readable envelopes
    // carrying their own saved path can gain access. No recursion into unsupported recovery data.
    if let Some(tabs) = session
        .get_mut("unrestoredTabs")
        .and_then(Value::as_array_mut)
    {
        for tab in tabs {
            restore_tab(tab, &mut allow_file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Files(PathBuf);
    impl Files {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "chemdraft-session-scope-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn file(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, "saved drawing").unwrap();
            path
        }
    }
    impl Drop for Files {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn macos_open_quit_replay_retains_each_path_until_confirmed() {
        let files = Files::new();
        let available = files.file("present.chemdraft");
        let missing = files.0.join("missing.chemdraft");
        let file = files.0.join("pending-opens.json");
        let paths = [&available, &missing].map(|path| path.to_str().unwrap().to_owned());
        pending_opens::append(&files.0, &paths, false).unwrap();

        let mut replay = pending_opens::Replay::default();
        let mut opened = Vec::new();
        replay
            .start(&files.0, |receipt, path| {
                opened.push((receipt, crate::read_document_payload(Path::new(path))));
            })
            .unwrap();
        assert_eq!(opened.len(), 2);
        assert_eq!(opened[0].1.path, paths[0]);
        assert_eq!(opened[0].1.contents, "saved drawing");
        assert!(opened[0].1.error.is_none());
        assert_eq!(opened[1].1.display_name, "missing.chemdraft");
        assert!(opened[1].1.error.is_some());
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            serde_json::to_string(&paths).unwrap()
        );
        replay
            .start(&files.0, |_, _| panic!("already sent to this renderer"))
            .unwrap();

        // Duplicate requests are coalesced by path and satisfied by the same receipt.
        pending_opens::append(&files.0, &paths[..1], false).unwrap();
        replay.confirm(&files.0, opened[0].0).unwrap();
        replay.confirm(&files.0, opened[0].0).unwrap();
        let mut next_launch = pending_opens::Replay::default();
        let mut remaining = Vec::new();
        next_launch
            .start(&files.0, |_, path| remaining.push(path.to_owned()))
            .unwrap();
        assert_eq!(remaining, [paths[1].clone()]);
        // The missing file's failure is confirmed by the next renderer.
        next_launch.confirm(&files.0, 0).unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn system_open_notices_list_each_file_once_and_preserve_replay_entries() {
        for (platform, reason, ending) in [
            (
                crate::QuitPlatform::Macos,
                u32::from_be_bytes(*b"shut"),
                false,
            ),
            (crate::QuitPlatform::Windows, 0, true),
        ] {
            let files = Files::new();
            let kind = crate::shutdown::quit_kind(platform, reason, ending, false);
            pending_opens::append(&files.0, &["retry.cdx".into()], false).unwrap();
            assert!(crate::shutdown::finish_opens(
                kind,
                None,
                |notice| pending_opens::append(
                    &files.0,
                    &["one.cdx".into(), "two.cdx".into(), "two.cdx".into()],
                    notice,
                ),
                || panic!("system quit cannot be vetoed"),
                |_| panic!("the notice belongs to the next launch"),
            ));
            let notice = pending_opens::read_notice(&files.0).unwrap().unwrap();
            assert!(notice.message().ends_with("one.cdx\ntwo.cdx"));
            assert_eq!(notice.message().matches("two.cdx").count(), 1);
            notice.acknowledge().unwrap();
            assert!(pending_opens::read_notice(&files.0).unwrap().is_none());
            let mut retry = pending_opens::Replay::default();
            let mut paths = Vec::new();
            retry
                .start(&files.0, |_, path| paths.push(path.to_owned()))
                .unwrap();
            assert_eq!(paths, ["retry.cdx"]);
        }
    }

    #[test]
    fn undisplayed_notice_survives_relaunch_and_acknowledgement_keeps_new_entries() {
        let files = Files::new();
        pending_opens::append(&files.0, &["first.cdx".into(), "second.cdx".into()], true).unwrap();
        let queued = pending_opens::read_notice(&files.0).unwrap().unwrap();
        drop(queued); // The process exited before displaying the alert.
        let shown = pending_opens::read_notice(&files.0).unwrap().unwrap();
        assert!(shown.message().ends_with("first.cdx\nsecond.cdx"));
        pending_opens::append(&files.0, &["third.cdx".into()], true).unwrap();
        pending_opens::append(&files.0, &["second.cdx".into()], false).unwrap();
        shown.acknowledge().unwrap();
        let next = pending_opens::read_notice(&files.0).unwrap().unwrap();
        assert!(next.message().ends_with("third.cdx"));
        let mut replayed = Vec::new();
        pending_opens::Replay::default()
            .start(&files.0, |_, path| replayed.push(path.to_owned()))
            .unwrap();
        assert_eq!(replayed, ["second.cdx"]);
    }

    #[test]
    fn pending_open_updates_replace_complete_json_and_keep_the_newest_fifty_unique_paths() {
        let files = Files::new();
        let file = files.0.join("pending-opens.json");
        let paths: Vec<_> = (0..55).map(|index| format!("{index}.cdx")).collect();
        pending_opens::append(&files.0, &paths[..10], false).unwrap();
        let old = fs::File::open(&file).unwrap();
        let mut incoming = paths[10..].to_vec();
        incoming.push(paths[0].clone()); // A repeat refreshes the path's place in the queue.
        pending_opens::append(&files.0, &incoming, false).unwrap();
        let prior: Vec<String> = serde_json::from_reader(old).unwrap();
        assert_eq!(prior, paths[..10]);
        let current: Vec<String> = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(current.len(), 50);
        assert_eq!(current[..49], paths[6..]);
        assert_eq!(current[49], paths[0]);
        assert!(files.0.read_dir().unwrap().all(|entry| {
            !entry
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "tmp")
        }));
    }

    #[test]
    fn a_failed_update_keeps_the_previous_pending_open_file() {
        let files = Files::new();
        let file = files.file("pending-opens.json");
        let original = fs::read(&file).unwrap(); // An unreadable older journal.
        assert!(pending_opens::append(&files.0, &["new.cdx".into()], true).is_err());
        assert_eq!(fs::read(&file).unwrap(), original);
    }

    fn tab(path: &Path) -> Value {
        json!({ "version": 1, "contents": "drawing", "payloadHash": "hash", "blank": false,
            "displayName": "drawing", "dirty": true, "savedAt": "now", "path": path })
    }
    fn grants(session: &mut Value) -> Vec<PathBuf> {
        let mut paths = vec![];
        restore_file_scopes(session, |path| {
            paths.push(path.to_path_buf());
            Ok(())
        });
        paths
    }

    #[test]
    fn grants_only_recorded_saved_document_files() {
        let files = Files::new();
        let a = files.file("a.chemdraft");
        let b = files.file("b.CDXML");
        let c = files.file("c.CDX");
        let mirror = files.file("mirror.chemdraft");
        let unrecorded = files.file("unrecorded.chemdraft");
        let mut session = json!({ "version": 1, "tabs": [tab(&a), tab(&b), tab(&c)],
            "activeTabIndex": 1, "path": mirror, "other": { "path": unrecorded } });
        assert_eq!(grants(&mut session), vec![a.clone(), b, c]);
        assert_eq!(grants(&mut tab(&a)), vec![a.clone()]); // legacy single-document session
        let mut unnamed = tab(&a);
        unnamed.as_object_mut().unwrap().remove("path");
        unnamed["contents"] = json!({ "path": a }).to_string().into();
        assert!(grants(&mut unnamed).is_empty());
    }

    #[test]
    fn rejects_relative_missing_directory_and_unsupported_paths_without_losing_contents() {
        let files = Files::new();
        let directory = files.0.join("directory.chemdraft");
        fs::create_dir(&directory).unwrap();
        for path in [
            PathBuf::from("relative.chemdraft"),
            files.file("data.json"),
            files.0.join("missing.chemdraft"),
            directory,
        ] {
            let mut session = tab(&path);
            assert!(grants(&mut session).is_empty());
            assert!(session["restoreSavePathError"].is_string());
            assert_eq!(session["path"], json!(path));
            assert_eq!(session["contents"], "drawing");
        }
    }

    #[test]
    fn rejects_dot_components_in_saved_paths() {
        let files = Files::new();
        let target = files.file("drawing.chemdraft");
        let parent = target.parent().unwrap();
        let parent_text = parent.to_string_lossy();
        #[cfg(windows)]
        let parent_text = parent_text.strip_prefix(r"\\?\").unwrap_or(&parent_text);
        let separator = std::path::MAIN_SEPARATOR;
        let paths = [
            PathBuf::from(format!(
                "{parent_text}{separator}sub{separator}..{separator}drawing.chemdraft"
            )),
            PathBuf::from(format!(
                "{parent_text}{separator}.{separator}drawing.chemdraft"
            )),
        ];
        for path in paths {
            let mut session = tab(&path);
            assert!(grants(&mut session).is_empty());
            assert!(session["restoreSavePathError"].is_string());
            assert_eq!(session["contents"], "drawing");
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_backslash_dot_components_in_saved_paths() {
        let files = Files::new();
        let target = files.file("drawing.chemdraft");
        let parent = target.parent().unwrap();
        let parent_text = parent.to_string_lossy();
        let parent_text = parent_text.strip_prefix(r"\\?\").unwrap_or(&parent_text);
        let paths = [
            PathBuf::from(format!(r"{parent_text}\sub\..\drawing.chemdraft")),
            PathBuf::from(format!(r"{parent_text}\.\drawing.chemdraft")),
        ];
        for path in paths {
            let mut session = tab(&path);
            assert!(grants(&mut session).is_empty());
            assert!(session["restoreSavePathError"].is_string());
        }
    }

    #[test]
    fn skips_invalid_envelopes_and_only_retries_readable_kept_tabs() {
        let files = Files::new();
        let path = files.file("drawing.chemdraft");
        let mut invalid = tab(&path);
        invalid["version"] = json!(99);
        assert!(grants(&mut invalid).is_empty());
        let mut session = json!({ "version": 1, "tabs": [invalid.clone()], "activeTabIndex": 0,
            "unrestoredTabs": [invalid, tab(&path)] });
        assert_eq!(grants(&mut session), vec![path]);
        session["activeTabIndex"] = json!(7);
        assert!(grants(&mut session).is_empty());
    }

    #[test]
    fn grant_failure_is_reported_and_stale_failures_are_recomputed() {
        let files = Files::new();
        let mut session = tab(&files.file("drawing.chemdraft"));
        restore_file_scopes(&mut session, |_| {
            Err("file access could not be restored".into())
        });
        assert_eq!(
            session["restoreSavePathError"],
            "file access could not be restored"
        );
        assert_eq!(grants(&mut session).len(), 1);
        assert!(session.get("restoreSavePathError").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_files_and_parent_directories() {
        use std::os::unix::fs::symlink;
        let files = Files::new();
        let target = files.file("target.chemdraft");
        let link = files.0.join("link.chemdraft");
        symlink(&target, &link).unwrap();
        let parent_link = files.0.join("linked-parent");
        symlink(&files.0, &parent_link).unwrap();
        for path in [link, parent_link.join("target.chemdraft")] {
            let mut session = tab(&path);
            assert!(grants(&mut session).is_empty());
            assert!(session["restoreSavePathError"]
                .as_str()
                .unwrap()
                .contains("symbolic link"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn refuses_symlinks_when_windows_allows_the_test_to_create_one() {
        use std::os::windows::fs::symlink_file;
        let files = Files::new();
        let target = files.file("target.chemdraft");
        let link = files.0.join("link.chemdraft");
        if let Err(error) = symlink_file(&target, &link) {
            // Windows without Developer Mode requires privileges to create symlinks.
            assert_eq!(error.raw_os_error(), Some(1314));
            return;
        }
        assert!(grants(&mut tab(&link)).is_empty());
    }
}
