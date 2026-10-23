//! Construct from an explicit parent map; never inherit a shell environment wholesale.
use super::probe::ProbePlatform;
use std::{collections::BTreeMap, path::Path};
pub type ParentEnv = BTreeMap<String, String>;

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
