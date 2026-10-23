//! Test-only filesystem/process boundary. No vendor discovery or account-home fallback.
use super::env::ParentEnv;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

pub(super) fn register(root: &Path) {
    let resolved = fs::canonicalize(root).expect("test root must exist");
    assert!(resolved.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
    ROOTS
        .lock()
        .unwrap()
        .extend([std::path::absolute(root).unwrap(), resolved]);
}

pub(super) fn check_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|p| p == std::path::Component::ParentDir)
    {
        return Err("Tests may access only registered temporary paths.".into());
    }
    if !ROOTS
        .lock()
        .unwrap()
        .iter()
        .any(|root| path.starts_with(root))
    {
        return Err(
            "Tests must not resolve a binary or home outside their temporary directories.".into(),
        );
    }
    // Resolve the closest existing ancestor, including symlinks, before any auth read/spawn.
    let resolved = path
        .ancestors()
        .find_map(|p| fs::canonicalize(p).ok())
        .ok_or("Test path has no existing ancestor.")?;
    if !ROOTS
        .lock()
        .unwrap()
        .iter()
        .any(|root| resolved.starts_with(root))
    {
        return Err(
            "Tests must not resolve a binary or home outside their temporary directories.".into(),
        );
    }
    Ok(())
}

pub(super) fn fake_parent(root: &Path) -> ParentEnv {
    check_path(root).unwrap();
    let resolved = root
        .ancestors()
        .find_map(|p| fs::canonicalize(p).ok())
        .unwrap();
    let root = ROOTS
        .lock()
        .unwrap()
        .iter()
        .find(|r| resolved.starts_with(r))
        .unwrap()
        .clone();
    let home = root.join("fake-user");
    fs::create_dir_all(&home).unwrap();
    let codex = home.join(".codex");
    fs::create_dir_all(&codex).unwrap();
    let auth = codex.join("auth.json");
    if !auth.exists() {
        super::write_private(&auth, br#"{"last_refresh":"2026-10-22T12:00:00Z","tokens":{"refresh_token":"fake-test-token"}}"#).unwrap();
    }
    let mut parent = ParentEnv::new();
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "CLAUDE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    ] {
        parent.insert(key.into(), home.to_string_lossy().into_owned());
    }
    parent.insert("CODEX_HOME".into(), codex.to_string_lossy().into_owned());
    parent
}

pub(super) fn isolated_parent(parent: &ParentEnv, root: &Path) -> Result<ParentEnv, String> {
    let home_keys = [
        "HOME",
        "USERPROFILE",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    ];
    for (key, value) in parent {
        if home_keys
            .iter()
            .any(|home_key| key.eq_ignore_ascii_case(home_key))
        {
            check_path(Path::new(value))?;
        }
    }
    let mut result = fake_parent(root);
    result.extend(parent.clone());
    Ok(result)
}

#[test]
fn boundary_rejects_real_homes_and_binaries_before_access() {
    // These values are never opened or executed; even a real path injected by a caller fails.
    for path in [
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "/Users/real/.codex",
        r"C:\Users\real\.codex",
        r"C:\Program Files\codex.exe",
    ] {
        assert!(check_path(Path::new(path)).is_err());
    }
    for key in ["HOME", "USERPROFILE", "CODEX_HOME"] {
        if let Some(value) = std::env::var_os(key) {
            assert!(
                check_path(Path::new(&value)).is_err(),
                "real account path accepted"
            );
        }
    }
}
