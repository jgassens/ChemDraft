//! Renew per-run file access from the app's persisted session, never from an IPC path argument.
use serde_json::Value;
use std::{fs, path::Path};

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
    if path.as_os_str().to_string_lossy().split(['/', '\\']).any(|part| {
        matches!(part, "." | "..")
    }) {
        return Err("the saved path contains a dot component".into());
    }
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("chemdraft") || ext.eq_ignore_ascii_case("cdxml")
        })
    {
        return Err("the saved path is not a ChemDraft or CDXML file".into());
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
        let mirror = files.file("mirror.chemdraft");
        let unrecorded = files.file("unrecorded.chemdraft");
        let mut session = json!({ "version": 1, "tabs": [tab(&a), tab(&b)],
            "activeTabIndex": 1, "path": mirror, "other": { "path": unrecorded } });
        assert_eq!(grants(&mut session), vec![a.clone(), b]);
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
            files.file("drawing.cdx"),
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
        let paths = [
            parent.join("sub").join("..").join("drawing.chemdraft"),
            parent.join(".").join("drawing.chemdraft"),
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
        let paths = [
            PathBuf::from(format!(r"{parent_text}\\sub\\..\\drawing.chemdraft")),
            PathBuf::from(format!(r"{parent_text}\\.\\drawing.chemdraft")),
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
