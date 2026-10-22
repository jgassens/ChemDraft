//! Platform-parameterized discovery and bounded CLI probes. Batch shims are never executable.
use super::{
    catalog::{AuthStatus, RenderedRun, ToolId, ToolSpec},
    env::{self, ParentEnv},
    run::{CaptureError, RunStatus, ToolRun},
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbePlatform {
    MacOS,
    Windows,
}
impl ProbePlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::MacOS
        }
    }
}
fn join(platform: ProbePlatform, base: &str, child: &str) -> PathBuf {
    match platform {
        ProbePlatform::MacOS => Path::new(base).join(child),
        ProbePlatform::Windows => PathBuf::from(format!(
            "{}\\{}",
            base.trim_end_matches(['\\', '/']),
            child.replace('/', "\\")
        )),
    }
}
pub fn candidate_dirs(
    platform: ProbePlatform,
    home: &Path,
    parent: &ParentEnv,
    login_path: Option<&str>,
) -> Vec<PathBuf> {
    let home = home.to_string_lossy();
    let mut dirs = match platform {
        ProbePlatform::MacOS => vec![
            join(platform, &home, ".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            join(platform, &home, ".codex/bin"),
            join(platform, &home, ".npm-global/bin"),
        ],
        ProbePlatform::Windows => {
            let home = env::get(parent, "USERPROFILE").unwrap_or(&home);
            let mut dirs = vec![join(platform, home, ".local/bin")];
            for (key, suffix) in [
                ("LOCALAPPDATA", "Microsoft/WinGet/Links"),
                ("APPDATA", "npm"),
                ("ProgramFiles", "nodejs"),
            ] {
                if let Some(base) = env::get(parent, key) {
                    dirs.push(join(platform, base, suffix));
                }
            }
            dirs
        }
    };
    let tail = match platform {
        ProbePlatform::MacOS => login_path,
        ProbePlatform::Windows => env::get(parent, "PATH"),
    };
    if let Some(tail) = tail {
        for dir in tail.split(if platform == ProbePlatform::Windows {
            ';'
        } else {
            ':'
        }) {
            // Empty entries mean current directory in PATH: never search them.
            let dir = dir.trim_matches('"');
            if !dir.is_empty() {
                let path = PathBuf::from(dir);
                if !dirs.contains(&path) {
                    dirs.push(path);
                }
            }
        }
    }
    dirs
}
pub fn candidate_paths(
    tool: ToolId,
    platform: ProbePlatform,
    home: &Path,
    parent: &ParentEnv,
    login_path: Option<&str>,
) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for dir in candidate_dirs(platform, home, parent, login_path) {
        if platform == ProbePlatform::MacOS {
            result.push(dir.join(tool.as_str()));
            continue;
        }
        let mut extensions = vec![".exe".to_owned()];
        for ext in env::get(parent, "PATHEXT")
            .unwrap_or(".EXE;.COM;.CMD;.BAT")
            .split(';')
        {
            let ext = ext.to_ascii_lowercase();
            if [".exe", ".com", ".cmd", ".bat"].contains(&ext.as_str())
                && !extensions.contains(&ext)
            {
                extensions.push(ext);
            }
        }
        for ext in extensions {
            result.push(join(
                platform,
                &dir.to_string_lossy(),
                &format!("{}{ext}", tool.as_str()),
            ));
        }
    }
    result
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Candidate {
    Runnable(PathBuf),
    ShimNeedsResolution(PathBuf),
    Missing,
}
pub fn resolve_candidates(paths: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Candidate {
    let mut shim = None;
    for path in paths {
        if !exists(path) {
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat") {
            if shim.is_none() {
                shim = Some(path.clone());
            }
            continue;
        }
        return Candidate::Runnable(path.clone());
    }
    shim.map(Candidate::ShimNeedsResolution)
        .unwrap_or(Candidate::Missing)
}
pub const PATH_MARKER: &str = "__CHEMDRAFT_PATH__";
pub fn parse_login_shell_path(output: &str) -> Result<String, String> {
    let path = output
        .lines()
        .find_map(|line| line.strip_prefix(PATH_MARKER))
        .ok_or("Login shell did not print the PATH marker.")?;
    if path.is_empty() {
        return Err("Login shell printed an empty PATH.".into());
    }
    Ok(path.to_owned())
}
#[derive(Default)]
pub struct LoginShellPath {
    captured: Mutex<Option<Result<String, String>>>,
}
impl LoginShellPath {
    pub fn capture(
        &self,
        shell: &Path,
        parent: &ParentEnv,
        run_dir: &Path,
    ) -> Result<String, String> {
        let mut captured = self.captured.lock().unwrap();
        if let Some(value) = captured.as_ref() {
            return value.clone();
        }
        let result = execute(
            shell,
            &["-l", "-c", "printf '\\n__CHEMDRAFT_PATH__%s\\n' \"$PATH\""],
            parent,
            run_dir,
            false,
            Duration::from_secs(5),
            64 * 1024,
        )
        .and_then(|output| parse_login_shell_path(&output.stdout));
        *captured = Some(result.clone());
        result
    }
}
#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub path: PathBuf,
    pub version: String,
    pub auth: AuthStatus,
    pub probed_at: String,
}
#[derive(Default)]
pub struct ProbeCache {
    entries: Mutex<HashMap<ToolId, CachedProbe>>,
    generation: AtomicU64,
    pub login_path: LoginShellPath,
}
type CachedProbe = (Instant, Result<ProbeResult, String>);
impl ProbeCache {
    pub fn get_or_probe(
        &self,
        tool: ToolId,
        refresh: bool,
        probe: impl FnOnce() -> Result<ProbeResult, String>,
    ) -> Result<ProbeResult, String> {
        let generation = {
            let entries = self.entries.lock().unwrap();
            if !refresh {
                if let Some((at, value)) = entries.get(&tool) {
                    if at.elapsed() < Duration::from_secs(30) {
                        return value.clone();
                    }
                }
            }
            self.generation.load(Ordering::SeqCst)
        };
        let value = probe();
        let mut entries = self.entries.lock().unwrap();
        // An install, uninstall or sign-in during the probe invalidates its result.
        if self.generation.load(Ordering::SeqCst) == generation {
            entries.insert(tool, (Instant::now(), value.clone()));
        }
        value
    }
    pub fn invalidate(&self, tool: ToolId) {
        let mut entries = self.entries.lock().unwrap();
        self.generation.fetch_add(1, Ordering::SeqCst);
        entries.remove(&tool);
    }
}
pub fn probe_tool(
    spec: &ToolSpec,
    path: &Path,
    parent: &ParentEnv,
    run_dir: &Path,
    managed: bool,
) -> Result<ProbeResult, String> {
    if matches!(
        resolve_candidates(&[path.to_owned()], |p| p.is_file()),
        Candidate::ShimNeedsResolution(_)
    ) {
        return Err("A .cmd/.bat shim needs resolution to a native executable; install the vendor's native CLI.".into());
    }
    let output = execute(
        path,
        spec.version_args,
        parent,
        run_dir,
        managed,
        Duration::from_secs(10),
        64 * 1024,
    )?;
    if output.code != Some(0) {
        return Err("External tool --version failed.".into());
    }
    let version = spec
        .parse_version(&output.stdout)
        .ok_or("Unrecognized external tool version.")?;
    if !spec.supports_version(&version) {
        return Err(format!(
            "{} requires version {} or later (found {version}).",
            spec.display_name, spec.minimum_version
        ));
    }
    let auth = execute(
        path,
        spec.auth_status_args,
        parent,
        run_dir,
        managed,
        Duration::from_secs(15),
        64 * 1024,
    )?;
    Ok(ProbeResult {
        path: path.to_owned(),
        version,
        auth: spec.parse_auth(auth.code, &auth.stdout, &auth.stderr),
        probed_at: chrono::Utc::now().to_rfc3339(),
    })
}
pub struct ProbeOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}
pub(super) fn execute(
    program: &Path,
    args: &[&str],
    parent: &ParentEnv,
    run_dir: &Path,
    managed: bool,
    timeout: Duration,
    cap: usize,
) -> Result<ProbeOutput, String> {
    let environment = env::child_env(ProbePlatform::current(), parent, program, run_dir, managed);
    let run = ToolRun::spawn_with_output_limit(
        RenderedRun {
            program: program.to_owned(),
            args: args.iter().map(|s| (*s).into()).collect(),
            env: Vec::new(),
            stdin: None,
        },
        run_dir,
        &environment,
        timeout,
        Some(cap),
    )?;
    let output = run
        .capture_output(cap, || false)
        .map_err(|error| match error {
            CaptureError::OutputLimit => {
                "External tool probe exceeded its output limit.".to_owned()
            }
            CaptureError::Cancelled => "External tool probe was cancelled.".to_owned(),
        })?;
    match output.status {
        RunStatus::Exited { code, .. } => Ok(ProbeOutput {
            code,
            stdout: output.stdout,
            stderr: output.stderr,
        }),
        RunStatus::Killed { .. } => Err("External tool probe timed out.".into()),
        RunStatus::Failed { message } => Err(message),
        RunStatus::Running => unreachable!("capture_output drains a finished run"),
    }
}
