use std::{
    ffi::{OsStr, OsString},
    path::PathBuf,
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

use super::{
    install,
    protocol::{self, RawResult},
};
use crate::local_engine::{
    platform::EnginePlatform,
    process::{
        self as shared, FailureKind, KillSwitch, ProcessFailure, ProcessMessages, ResponseLine,
        SidecarProtocol,
    },
};

pub const START_TIMEOUT: Duration = Duration::from_secs(60);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub type ProcessManager = shared::ProcessManager<NamingProtocol>;

#[derive(Clone)]
pub struct LaunchPaths {
    pub python: PathBuf,
    pub sidecar: PathBuf,
    pub engine: PathBuf,
    pub jre: PathBuf,
    pub opsin: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProcessError {
    InvalidSmiles(String),
    NamingFailed(String),
    Crashed(String),
    Timeout,
    Cancelled,
}

impl ProcessFailure for ProcessError {
    fn cancelled() -> Self {
        Self::Cancelled
    }
    fn timeout() -> Self {
        Self::Timeout
    }
    fn crashed(message: String) -> Self {
        Self::Crashed(message)
    }
    fn kind(&self) -> FailureKind {
        match self {
            Self::Cancelled => FailureKind::Cancelled,
            Self::Timeout => FailureKind::Timeout,
            Self::Crashed(_) => FailureKind::Crashed,
            _ => FailureKind::Answer,
        }
    }
}

/// Takes the inherited keys explicitly so tests never mutate the process-wide environment.
pub fn scrub_environment(command: &mut Command, keys: impl IntoIterator<Item = OsString>) {
    for key in keys {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if crate::local_engine::install::SCRUBBED_ENV_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix))
            || upper.starts_with("ORTHONYM_")
            || [
                "JAVA_TOOL_OPTIONS",
                "_JAVA_OPTIONS",
                "JDK_JAVA_OPTIONS",
                "CLASSPATH",
                "JAVA_HOME",
                "PATH",
            ]
            .contains(&upper.as_str())
        {
            command.env_remove(key);
        }
    }
}

fn system_path(jre: &std::path::Path) -> OsString {
    let mut directories = vec![jre.join("bin")];
    #[cfg(windows)]
    {
        let windows = PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows")),
        );
        directories.extend([
            windows.join("System32"),
            windows.clone(),
            windows.join("System32").join("Wbem"),
        ]);
    }
    #[cfg(not(windows))]
    directories.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
    std::env::join_paths(directories)
        .expect("runtime and system directories are valid PATH entries")
}

pub fn command(paths: &LaunchPaths) -> Command {
    let mut command = Command::new(&paths.python);
    scrub_environment(&mut command, std::env::vars_os().map(|(key, _)| key));
    command
        .args(["-I", "-B"])
        .arg(&paths.sidecar)
        .current_dir(&paths.engine)
        .env("JAVA_HOME", &paths.jre)
        .env("PATH", system_path(&paths.jre))
        .env("ORTHONYM_OPSIN_JAR", &paths.opsin)
        .env("ORTHONYM_CENTRES_JAR", install::centres_path(&paths.engine))
        .env("ORTHONYM_NO_DOWNLOAD", "1")
        .env("ORTHONYM_CACHE_DIR", paths.engine.join("cache"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Explicit removals are also visible in Command::get_envs when the parent has no such key.
    for key in [
        "JAVA_TOOL_OPTIONS",
        "_JAVA_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "ORTHONYM_ALLOW_REDUCED",
        "ORTHONYM_DISABLE_JPYPE",
    ] {
        command.env_remove(key);
    }
    command
}

pub struct NamingProtocol;
impl SidecarProtocol for NamingProtocol {
    type Input = str;
    type Response = RawResult;
    type Progress = ();
    type Error = ProcessError;
    type LaunchPaths = LaunchPaths;
    type Process = shared::SystemProcess<Self>;
    type Spawner = ();
    const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
    const START_TIMEOUT: Option<Duration> = Some(START_TIMEOUT);
    const LOG_PREFIX: &'static str = "[chemdraft naming]";
    const REQUEST_PREFIX: &'static str = "n-";
    fn system_spawner() -> Arc<()> {
        Arc::new(())
    }
    fn spawn(
        _: &(),
        platform: &dyn EnginePlatform,
        paths: &LaunchPaths,
        timeout: Duration,
        kill: &KillSwitch,
    ) -> Result<Box<Self::Process>, ProcessError> {
        // Orthonym trusts env-given jars. Check the installed download on EVERY spawn, including a
        // crash retry. The bundled OPSIN jar is pinned by opsin's BUILD.md artifact hash test.
        install::verify_centres(&paths.engine)
            .map_err(|error| ProcessError::Crashed(error.message))?;
        shared::SystemProcess::<Self>::spawn(platform, paths, timeout, kill).map(Box::new)
    }
    fn recognize(
        process: &mut Self::Process,
        id: &str,
        input: &str,
        timeout: Duration,
        progress: &dyn Fn(()),
    ) -> Result<RawResult, ProcessError> {
        process.recognize(id, input, timeout, progress)
    }
    fn shutdown(process: &mut Self::Process) {
        process.shutdown();
    }
    fn starting() {}
    fn configure_command(paths: &LaunchPaths) -> Command {
        command(paths)
    }
    fn ready(line: &str) -> Result<(), ProcessError> {
        protocol::ready(line)
    }
    fn encode(id: &str, input: &str) -> Result<String, ProcessError> {
        protocol::encode(id, input)
    }
    fn classify(line: &str, id: &str) -> ResponseLine<Self> {
        ResponseLine::Final(protocol::result(line, id))
    }
    fn shutdown_line() -> Result<String, ProcessError> {
        Ok(r#"{"type":"shutdown"}"#.into())
    }
    fn messages() -> ProcessMessages {
        ProcessMessages {
            stopped: "The naming engine stopped during a request.",
            stopped_twice: "The naming engine stopped twice during a request.",
            start: "Could not start the naming engine: ",
            input: "Could not open the naming engine input.",
            output: "Could not open the naming engine output.",
            log: "Could not open the naming engine log.",
            exited: "The naming engine exited with ",
            closed: "The naming engine closed its output unexpectedly.",
            inspect: "Could not inspect the naming engine: ",
            inspect_request: "Could not inspect the naming engine request: ",
            not_running: "The naming engine is no longer running.",
            send: "Could not send SMILES to the naming engine: ",
        }
    }
}

pub fn java_executable(jre: &std::path::Path) -> PathBuf {
    jre.join("bin").join(if cfg!(windows) {
        OsStr::new("java.exe")
    } else {
        OsStr::new("java")
    })
}
