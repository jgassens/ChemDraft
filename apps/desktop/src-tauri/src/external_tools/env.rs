//! Construct from an explicit parent map; never inherit a shell environment wholesale.
use super::probe::ProbePlatform;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
pub type ParentEnv = BTreeMap<String, String>;

/// Sessions remain in this stable home across runs. Credentials are linked, never read or copied.
#[derive(Debug)]
pub struct CodexHome {
    pub path: Option<PathBuf>,
    pub fallback_reason: Option<String>,
}
impl CodexHome {
    pub fn apply(&self, parent: &ParentEnv) -> ParentEnv {
        let mut parent = parent.clone();
        parent.retain(|key, _| !key.eq_ignore_ascii_case("CODEX_HOME"));
        if let Some(path) = &self.path {
            parent.insert("CODEX_HOME".into(), path.to_string_lossy().into_owned());
        }
        parent
    }
}

pub fn real_codex_home(platform: ProbePlatform, parent: &ParentEnv) -> Option<PathBuf> {
    if let Some(path) = get(parent, "CODEX_HOME").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let home = get(
        parent,
        if platform == ProbePlatform::Windows {
            "USERPROFILE"
        } else {
            "HOME"
        },
    )?;
    if home.is_empty() {
        return None;
    }
    // Parameterized Windows paths must also be testable on a Unix host.
    Some(match platform {
        ProbePlatform::MacOS => Path::new(home).join(".codex"),
        ProbePlatform::Windows => {
            PathBuf::from(format!("{}\\.codex", home.trim_end_matches(['\\', '/'])))
        }
    })
}

/// `base` is app_local_data/external-tools, never a plugin-controlled path.
pub fn prepare_codex_home(platform: ProbePlatform, base: &Path, parent: &ParentEnv) -> CodexHome {
    prepare_codex_home_with_link(platform, base, parent, link_codex_auth)
}

pub(super) fn prepare_codex_home_with_link(
    platform: ProbePlatform,
    base: &Path,
    parent: &ParentEnv,
    link: impl FnOnce(ProbePlatform, &Path, &Path) -> std::io::Result<()>,
) -> CodexHome {
    // Probes and starts can overlap; never let them remove each other's staged auth link.
    static LOCK: Mutex<()> = Mutex::new(());
    let _lock = LOCK.lock().unwrap();
    // Child cwd is the conversation directory, so resolve relative parent overrides before spawn.
    let real_home =
        real_codex_home(platform, parent).map(|home| std::path::absolute(&home).unwrap_or(home));
    let isolated = base.join("codex-home");
    let prepared = (|| -> Result<(), String> {
        let real_home = real_home
            .as_ref()
            .ok_or("User's Codex home could not be resolved.")?;
        for path in [base, &isolated] {
            if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("ChemDraft's Codex home must not be a symbolic link.".into());
            }
            super::private_dir(path)
                .map_err(|e| format!("Could not create private Codex home: {e}"))?;
        }
        let auth = fs::canonicalize(real_home.join("auth.json")).map_err(|e| {
            format!("User's Codex auth.json is unavailable (login may use the keychain): {e}")
        })?;
        if !auth.is_file() {
            return Err("User's Codex auth.json is not a file.".into());
        }
        let isolated = fs::canonicalize(&isolated).map_err(|e| e.to_string())?;
        let target = isolated.join("auth.json");
        if auth == target {
            return Err("User's CODEX_HOME is already ChemDraft's isolated home.".into());
        }
        // Keep a correct Unix symlink. A Windows hard link must be refreshed on each preparation:
        // vendor sign-in can atomically replace the source file, leaving the old inode behind.
        if platform == ProbePlatform::MacOS && fs::read_link(&target).ok().as_ref() == Some(&auth) {
            return Ok(());
        }
        let staged = isolated.join(format!("auth-link-{}", super::nonce()));
        link(platform, &auth, &staged)
            .map_err(|e| format!("Could not link Codex auth.json: {e}"))?;
        let replaced = (|| {
            // Unix rename replaces atomically. Windows rename cannot overwrite the old link.
            if platform == ProbePlatform::Windows {
                match fs::remove_file(&target) {
                    Ok(()) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e),
                }
            }
            fs::rename(&staged, &target)
        })();
        if let Err(e) = replaced {
            let _ = fs::remove_file(staged);
            return Err(format!("Could not replace Codex auth link: {e}"));
        }
        Ok(())
    })();
    match prepared {
        Ok(()) => CodexHome {
            path: Some(isolated),
            fallback_reason: None,
        },
        Err(reason) => CodexHome {
            path: real_home,
            fallback_reason: Some(format!(
                "Codex home isolation unavailable; using the user's real Codex home. {reason}"
            )),
        },
    }
}

fn link_codex_auth(platform: ProbePlatform, source: &Path, target: &Path) -> std::io::Result<()> {
    match platform {
        ProbePlatform::Windows => fs::hard_link(source, target),
        ProbePlatform::MacOS => {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(source, target)
            }
            #[cfg(not(unix))]
            {
                Err(std::io::ErrorKind::Unsupported.into())
            }
        }
    }
}

pub fn get<'a>(parent: &'a ParentEnv, key: &str) -> Option<&'a str> {
    parent
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}
pub fn tool_overrides(managed: bool) -> Vec<(String, String)> {
    let mut pairs = [
        "DISABLE_AUTOUPDATER",
        "DISABLE_ERROR_REPORTING",
        "DISABLE_TELEMETRY",
    ]
    .map(|k| (k.to_owned(), "1".to_owned()))
    .to_vec();
    if managed {
        pairs.push(("DISABLE_UPDATES".into(), "1".into()));
    }
    pairs
}
pub fn child_env(
    platform: ProbePlatform,
    parent: &ParentEnv,
    binary: &Path,
    run_dir: &Path,
    managed: bool,
) -> ParentEnv {
    let common = [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
    ];
    let windows = [
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "ProgramFiles",
        "SystemRoot",
        "windir",
        "SystemDrive",
        "ComSpec",
        "PATHEXT",
        "USERNAME",
        "USERDOMAIN",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "OS",
    ];
    let mut result: ParentEnv = parent
        .iter()
        .filter(|(key, _)| {
            let upper = key.to_ascii_uppercase();
            common.iter().any(|k| key.eq_ignore_ascii_case(k))
                || upper.starts_with("LC_")
                || upper.starts_with("XDG_")
                || (platform == ProbePlatform::Windows
                    && windows.iter().any(|k| key.eq_ignore_ascii_case(k)))
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let binary = binary.to_string_lossy();
    let parent_dir = match platform {
        ProbePlatform::MacOS => Path::new(binary.as_ref())
            .parent()
            .unwrap_or(Path::new("/usr/bin"))
            .to_string_lossy()
            .into_owned(),
        ProbePlatform::Windows => binary
            .rsplit_once(['\\', '/'])
            .map(|(p, _)| p.to_owned())
            .unwrap_or_else(|| r"C:\Windows\System32".into()),
    };
    let path = match platform {
        ProbePlatform::MacOS => format!("{parent_dir}:/usr/bin:/bin:/usr/sbin:/sbin"),
        ProbePlatform::Windows => {
            // Winsock needs SystemRoot even when the caller supplies an empty parent.
            let root = get(parent, "SystemRoot").unwrap_or(r"C:\Windows");
            let windir = get(parent, "windir").unwrap_or(root);
            result.retain(|key, _| {
                !key.eq_ignore_ascii_case("SystemRoot") && !key.eq_ignore_ascii_case("windir")
            });
            result.insert("SystemRoot".into(), root.into());
            result.insert("windir".into(), windir.into());
            let root = root.trim_end_matches(['\\', '/']);
            format!("{parent_dir};{root}\\System32;{root};{root}\\System32\\Wbem")
        }
    };
    result.insert("PATH".into(), path);
    for key in ["TMPDIR", "TEMP", "TMP"] {
        result.insert(key.into(), run_dir.to_string_lossy().into_owned());
    }
    result.insert("TERM".into(), "dumb".into());
    result.insert("NO_COLOR".into(), "1".into());
    result.extend(tool_overrides(managed));
    result
}

/// Never inherit CHEMDRAFT_* values. Only a Rust-owned credential supplied
/// explicitly for a bound run is allowed (Codex reads this variable by name).
pub(super) fn with_mcp_token(mut environment: ParentEnv, bound_token: Option<&str>) -> ParentEnv {
    environment.retain(|key, _| !key.to_ascii_uppercase().starts_with("CHEMDRAFT_"));
    if let Some(token) = bound_token {
        environment.insert("CHEMDRAFT_MCP_TOKEN".into(), token.into());
    }
    environment
}
