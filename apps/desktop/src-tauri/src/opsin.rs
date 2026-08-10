//! Name → structure, by running the vendored OPSIN jar on a bundled Java runtime.
//!
//! Provenance, the licence audit of the shaded jar, and the `jlink` recipe are in
//! `resources/opsin/BUILD.md`. Two facts from there drive every decision in this file, because
//! neither is safe to discover by experiment:
//!
//! * **Exit status is 0 whether or not a name parsed.** Success must be read from the output, never
//!   from the status code.
//! * **A name containing a tab or a newline corrupts the protocol** — a newline reads as two names, a
//!   tab forges the field delimiter. Input is validated before it reaches stdin.
//!
//! The runtime is *bundled rather than detected* because macOS ships no JRE (`/usr/bin/java` is a
//! stub that prints "Unable to locate a Java Runtime"), so detection would leave this feature off for
//! most users. It is also not committed: `scripts/build-opsin-runtime.sh` produces it, and a build
//! without it still runs — the capability reports itself unavailable, with the reason, rather than
//! quietly vanishing.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{Manager, Runtime};

/// How long OPSIN gets before we give up on it. A name is parsed in milliseconds once the JVM is up,
/// and the whole invocation measures ~0.4 s, so this is a hang guard rather than a budget.
const OPSIN_TIMEOUT_SECS: u64 = 30;

/// Longest name we will hand to OPSIN. Systematic names get long — some legitimately run past 200
/// characters — but this bounds the work and the error surface, in the spirit of the analysis
/// scheduler's input-length guard.
const MAX_NAME_LEN: usize = 2000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsinStatus {
    /// Whether a conversion can actually be attempted right now.
    pub available: bool,
    /// Present when `available` is false: what is missing, in words a user can act on.
    pub reason: Option<String>,
    pub jar_present: bool,
    pub runtime_present: bool,
    /// `None` when no jar is bundled — there is no engine whose version this would be.
    pub version: Option<&'static str>,
}

/// Why a conversion could not be attempted — which is not the same as a name that would not parse.
///
/// The two were flattened into one `String` at the boundary, and the TypeScript layer mapped every
/// rejection to `parsed: false` — so a JVM that failed to start, or a 30-second timeout, told the user
/// their chemical name was bad when OPSIN had never run. The distinction exists in the code below;
/// this carries it across.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsinError {
    /// `invalidName` — the input was refused before any process started, so it IS about the name.
    /// `engineFailure` — the engine could not be run or did not finish. Says nothing about the name.
    pub kind: OpsinErrorKind,
    pub message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpsinErrorKind {
    InvalidName,
    EngineFailure,
}

impl OpsinError {
    pub fn invalid_name(message: impl Into<String>) -> Self {
        Self {
            kind: OpsinErrorKind::InvalidName,
            message: message.into(),
        }
    }
    pub fn engine_failure(message: impl Into<String>) -> Self {
        Self {
            kind: OpsinErrorKind::EngineFailure,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsinConversion {
    /// The SMILES OPSIN produced, or `None` when it could not parse the name.
    pub smiles: Option<String>,
    /// Why it could not, taken from OPSIN's own diagnostic. Never synthesised here.
    pub failure_reason: Option<String>,
}

/// The vendored engine's version, mirrored from `BUILD.md`. A test pins the two together.
pub const OPSIN_VERSION: &str = "2.9.0";

const JAR_RELATIVE: &str = "resources/opsin/opsin-cli-2.9.0.jar";
const RUNTIME_RELATIVE: &str = "resources/opsin/jre";

/// Resolve a bundled resource, trying the packaged app first and then the dev tree.
///
/// `resource_dir` points inside the `.app` in a packaged build and at `src-tauri/` under `tauri dev`,
/// so both are tried rather than assuming one — a path that only works in dev is a feature that only
/// works in dev.
fn resource_path<R: Runtime>(app: &tauri::AppHandle<R>, relative: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(relative));
    }
    // DEV ONLY. `CARGO_MANIFEST_DIR` is baked in at compile time, so in a release build this fallback
    // points at the BUILD MACHINE's source tree — a path outside the app bundle, writable by any
    // process running as that user. If the bundle's resource glob ever failed to match (an empty glob
    // is not a build error), a signed, notarized app would have located and `java -jar`'d a jar the
    // code signature says nothing about. Dev needs it because `resource_dir()` points at `src-tauri/`
    // under `tauri dev` only after the resources are staged; a release build must find its resources
    // inside itself or not at all.
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn java_binary<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let runtime = resource_path(app, RUNTIME_RELATIVE)?;
    let java = runtime.join("bin").join("java");
    is_executable(&java).then_some(java)
}

/// Present AND runnable. `exists()` alone reported a truncated or non-executable `java` as available,
/// so `opsin_status` said the engine was ready and the failure surfaced later as a spawn error that
/// the TypeScript layer then reported as "could not parse that name".
fn is_executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Reject names that would corrupt the line-and-tab protocol, or that are not worth sending.
///
/// Returned as `Err(message)` rather than silently sanitised: stripping a newline out of a name and
/// converting whatever is left would answer a question the user did not ask.
pub fn validate_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Enter a chemical name.".into());
    }
    if trimmed.chars().count() > MAX_NAME_LEN {
        return Err(format!(
            "That name is longer than {MAX_NAME_LEN} characters."
        ));
    }
    if let Some(bad) = trimmed.chars().find(|c| c.is_control()) {
        // Tab and newline are the delimiters OPSIN's CLI uses; every other control character is
        // rejected with them because none belongs in a chemical name.
        return Err(format!(
            "That name contains a control character ({}), which cannot be sent to the name parser.",
            bad.escape_debug()
        ));
    }
    Ok(trimmed)
}

/// Pull the SMILES out of one `SMILES<TAB>name` line.
///
/// An empty first field is OPSIN saying it could not parse the name — it still emits the line, which
/// is what keeps input and output aligned. Split on the FIRST tab only: OPSIN echoes the name back
/// after it, and a name cannot contain a tab because `validate_name` refused it.
pub fn parse_output_line(line: &str) -> Option<String> {
    let smiles = line.split('\t').next().unwrap_or("").trim();
    (!smiles.is_empty()).then(|| smiles.to_string())
}

/// Reduce OPSIN's stderr to the part worth showing, dropping its interactive banner.
pub fn parse_failure_reason(stderr: &str) -> Option<String> {
    let reason = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find(|line| !line.starts_with("Run the jar using"))?;
    Some(reason.to_string())
}

#[tauri::command]
pub fn opsin_status<R: Runtime>(app: tauri::AppHandle<R>) -> OpsinStatus {
    let jar_present = resource_path(&app, JAR_RELATIVE).is_some();
    let runtime_present = java_binary(&app).is_some();
    let reason = match (jar_present, runtime_present) {
        (true, true) => None,
        (false, _) => Some("The OPSIN engine is not present in this build.".to_string()),
        (true, false) => Some(
            "The bundled Java runtime is not present in this build, so names cannot be converted. \
             Build it with scripts/build-opsin-runtime.sh."
                .to_string(),
        ),
    };
    OpsinStatus {
        available: jar_present && runtime_present,
        reason,
        jar_present,
        runtime_present,
        // `None` when there is no jar. The version describes the vendored engine, and reporting
        // "2.9.0" for a build that contains no engine states a fact about something that is not there.
        version: jar_present.then_some(OPSIN_VERSION),
    }
}

/// Serialises conversions, so a plugin loop cannot spawn unbounded JVMs.
///
/// Until this command moved off the main thread, Tauri's own main-thread serialisation was the only
/// thing bounding concurrency — an accidental property, and one that came at the cost of freezing
/// every menu and IPC call for the duration. Holding this across the conversion keeps the bound (one
/// JVM at a time, as before) while the UI stays responsive, and a blocking-pool thread is exactly
/// where a 0.4-second wait belongs.
static CONVERSION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub async fn opsin_name_to_structure<R: Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<OpsinConversion, OpsinError> {
    // `async` + `spawn_blocking`, following `fonts.rs`. Tauri 2 runs a non-`async` command ON THE MAIN
    // THREAD, so this spawned a JVM and busy-polled there: ~0.4 s of frozen IPC and menus per call,
    // and up to the full 30 s timeout on a hang.
    let jar = resource_path(&app, JAR_RELATIVE).ok_or_else(|| {
        OpsinError::engine_failure("The OPSIN engine is not present in this build.")
    })?;
    let java = java_binary(&app).ok_or_else(|| {
        OpsinError::engine_failure(
            "The bundled Java runtime is not present in this build, so names cannot be converted.",
        )
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let _serialised = CONVERSION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        convert_with(&java, &jar, &name)
    })
    .await
    .map_err(|error| {
        OpsinError::engine_failure(format!("The name parser could not be scheduled: {error}"))
    })?
}

/// The conversion itself, against explicit paths.
///
/// Split out from the Tauri command so the real engine can be exercised in a test: everything
/// interesting here — the protocol, the timeout, refusing to read success from the exit code — is
/// invisible to a test that can only reach it through an `AppHandle`.
pub fn convert_with(
    java: &std::path::Path,
    jar: &std::path::Path,
    name: &str,
) -> Result<OpsinConversion, OpsinError> {
    // The ONLY `invalidName` path: the input was refused before a process existed. Everything below
    // this line is the engine, and a failure there says nothing about the name.
    let name = validate_name(name).map_err(OpsinError::invalid_name)?;

    let mut child = Command::new(java)
        .arg("-jar")
        .arg(jar)
        .args(["-o", "smi", "-n"])
        // The child inherits the app's environment, and these three change how the JVM starts. Two
        // reasons to drop them. They can alter behaviour we have pinned (GC logging goes to STDOUT and
        // interleaves between result lines; a heap cap can make the JVM refuse to start at all), and
        // the launcher announces them on stderr as "Picked up _JAVA_OPTIONS: …", which
        // `parse_failure_reason` then hands to the user as the reason their chemical name failed.
        .env_remove("JAVA_TOOL_OPTIONS")
        .env_remove("_JAVA_OPTIONS")
        .env_remove("JDK_JAVA_OPTIONS")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            OpsinError::engine_failure(format!("Could not start the name parser: {error}"))
        })?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| OpsinError::engine_failure("Could not write to the name parser."))?;
        // One name, one newline. Closing stdin is what makes OPSIN finish rather than wait for more.
        writeln!(stdin, "{name}").map_err(|error| {
            OpsinError::engine_failure(format!("Could not send the name: {error}"))
        })?;
    }
    drop(child.stdin.take());

    let output =
        wait_with_timeout(child, OPSIN_TIMEOUT_SECS).map_err(OpsinError::engine_failure)?;

    // Deliberately NOT checked: OPSIN exits 0 whether or not the name parsed (BUILD.md). Reading
    // success from the status code would report every unparsable name as a success with no structure.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    match stdout.lines().find_map(parse_output_line) {
        Some(smiles) => Ok(OpsinConversion {
            smiles: Some(smiles),
            failure_reason: None,
        }),
        None => Ok(OpsinConversion {
            smiles: None,
            failure_reason: Some(parse_failure_reason(&stderr).unwrap_or_else(|| {
                format!("\"{name}\" could not be interpreted as a chemical name.")
            })),
        }),
    }
}

/// Wait for the child, killing it if it overruns.
///
/// `wait_with_output` alone would block forever on a hung JVM and take the command thread with it.
fn wait_with_timeout(
    mut child: std::process::Child,
    seconds: u64,
) -> Result<std::process::Output, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("The name parser failed: {error}"))
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "The name parser did not finish within {seconds} seconds."
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => return Err(format!("The name parser failed: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_would_corrupt_the_protocol() {
        // The reason this validation exists: a newline reads as two names and a tab forges the field
        // delimiter, so either one turns "convert this name" into "convert something else".
        assert!(validate_name("benzene\nethanol").is_err());
        assert!(validate_name("benzene\tethanol").is_err());
        assert!(validate_name("benzene\rethanol").is_err());
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"a".repeat(MAX_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn trims_surrounding_whitespace_instead_of_rejecting_it() {
        // A name pasted from a Windows document or a spreadsheet cell arrives with a trailing CR or
        // newline. Trimming is right — it is the INTERIOR control character that forges a delimiter,
        // and rejecting a paste for its line ending would be an obstacle with no safety behind it.
        assert_eq!(validate_name("benzene\r\n"), Ok("benzene"));
        assert_eq!(validate_name("\n  benzene  \n"), Ok("benzene"));
    }

    #[test]
    fn accepts_the_names_chemists_actually_type() {
        // Long, punctuated, and non-ASCII all have to survive: stereodescriptors, locants, primes,
        // and Greek letters are ordinary in systematic names.
        assert_eq!(validate_name("  benzene  "), Ok("benzene"));
        assert_eq!(
            validate_name("(2R,3S)-2,3-dihydroxybutanedioic acid"),
            Ok("(2R,3S)-2,3-dihydroxybutanedioic acid")
        );
        assert!(validate_name("β-D-glucopyranose").is_ok());
        assert!(validate_name("N,N'-dimethylurea").is_ok());
    }

    #[test]
    fn reads_a_smiles_out_of_a_tab_delimited_line() {
        assert_eq!(
            parse_output_line("C1=CC=CC=C1\tbenzene"),
            Some("C1=CC=CC=C1".into())
        );
        // The real aspirin line, from the vendored build.
        assert_eq!(
            parse_output_line("C(C)(=O)OC1=C(C(=O)O)C=CC=C1\t2-acetyloxybenzoic acid"),
            Some("C(C)(=O)OC1=C(C(=O)O)C=CC=C1".into())
        );
    }

    #[test]
    fn treats_an_empty_smiles_field_as_the_failure_it_is() {
        // OPSIN emits the line either way; the empty first field is the whole signal. Reading this
        // wrong would surface an empty structure as a successful conversion.
        assert_eq!(parse_output_line("\txyzzy-not-a-name"), None);
        assert_eq!(parse_output_line(""), None);
        assert_eq!(parse_output_line("   \tname"), None);
    }

    #[test]
    fn drops_the_interactive_banner_when_reporting_why_a_name_failed() {
        let stderr = "Run the jar using the -h flag for help. Enter a chemical name to begin:\n\
                      xyzzy is unparsable due to the following being uninterpretable: xyzzy\n";
        assert_eq!(
            parse_failure_reason(stderr).as_deref(),
            Some("xyzzy is unparsable due to the following being uninterpretable: xyzzy")
        );
        // Banner only means OPSIN said nothing useful, so the caller supplies its own wording.
        assert_eq!(
            parse_failure_reason(
                "Run the jar using the -h flag for help. Enter a chemical name to begin:\n"
            ),
            None
        );
    }

    /// The vendored jar and the built runtime, when they are both present.
    ///
    /// `None` on a checkout that has not run `scripts/build-opsin-runtime.sh` — the runtime is 47 MB
    /// and deliberately not committed, so these tests skip rather than fail. They are the only ones
    /// that prove the protocol against the real engine, so skipping is a real loss; that is the
    /// trade the runtime decision buys.
    fn real_engine() -> Option<(PathBuf, PathBuf)> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let jar = root.join(JAR_RELATIVE);
        let java = root.join(RUNTIME_RELATIVE).join("bin").join("java");
        (jar.exists() && java.exists()).then_some((java, jar))
    }

    #[test]
    fn converts_real_names_against_the_vendored_engine() {
        let Some((java, jar)) = real_engine() else {
            eprintln!("skipping: run scripts/build-opsin-runtime.sh to exercise the real engine");
            return;
        };

        let benzene = convert_with(&java, &jar, "benzene").expect("benzene should convert");
        assert_eq!(benzene.smiles.as_deref(), Some("C1=CC=CC=C1"));
        assert!(benzene.failure_reason.is_none());

        // Aspirin by its systematic name — the conversion a migrating chemist actually wants.
        let aspirin = convert_with(&java, &jar, "2-acetyloxybenzoic acid").expect("aspirin");
        assert_eq!(
            aspirin.smiles.as_deref(),
            Some("C(C)(=O)OC1=C(C(=O)O)C=CC=C1")
        );

        // Stereodescriptors have to survive, or the structure is a different compound.
        let tartaric = convert_with(&java, &jar, "(2R,3S)-2,3-dihydroxybutanedioic acid")
            .expect("tartaric acid");
        let smiles = tartaric.smiles.expect("tartaric acid should convert");
        assert!(smiles.contains('@'), "stereochemistry was lost: {smiles}");
    }

    #[test]
    fn reports_an_unparsable_name_as_a_failure_with_opsin_own_reason() {
        let Some((java, jar)) = real_engine() else {
            eprintln!("skipping: run scripts/build-opsin-runtime.sh to exercise the real engine");
            return;
        };

        // The case that would break if success were read from the exit code: OPSIN exits 0 here.
        let result = convert_with(&java, &jar, "xyzzy-not-a-real-chemical-name").expect("call ok");
        assert!(
            result.smiles.is_none(),
            "an unparsable name produced a structure"
        );
        let reason = result.failure_reason.expect("a reason");
        assert!(
            reason.contains("unparsable") || reason.contains("not parseable"),
            "reason did not come from OPSIN: {reason}"
        );
        assert!(
            !reason.starts_with("Run the jar using"),
            "the interactive banner leaked into the reason: {reason}"
        );
    }

    #[test]
    fn version_matches_the_vendored_artifact() {
        assert!(
            JAR_RELATIVE.contains(OPSIN_VERSION),
            "jar path and version constant disagree"
        );
        let build_doc = include_str!("../resources/opsin/BUILD.md");
        assert!(
            build_doc.contains(OPSIN_VERSION),
            "BUILD.md does not record the pinned version"
        );
    }

    /// The jar's BYTES, not just its version string.
    ///
    /// This was the weakest provenance of any vendored artifact in the repo: the RDKit and IsoSpec
    /// wasm blobs are each pinned three ways (constant ↔ BUILD.md ↔ bytes), while a 14 MB executable
    /// jar that the app hands to a JVM was checked only by the version number appearing in its own
    /// filename — which a replaced jar keeps. Reads the expected digest out of BUILD.md rather than
    /// duplicating it here, so the record and the check cannot drift apart.
    #[test]
    fn jar_bytes_match_the_hash_recorded_in_build_md() {
        use sha2::{Digest, Sha256};

        let jar_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(JAR_RELATIVE);
        let bytes = std::fs::read(&jar_path)
            .unwrap_or_else(|error| panic!("could not read {}: {error}", jar_path.display()));
        let actual = format!("{:x}", Sha256::digest(&bytes));

        let build_doc = include_str!("../resources/opsin/BUILD.md");
        let recorded = build_doc
            .lines()
            .find_map(|line| {
                let rest = line.trim().strip_prefix("- SHA-256:")?;
                Some(rest.trim().trim_matches('`').to_string())
            })
            .expect("BUILD.md records no `- SHA-256:` line for the jar");

        assert_eq!(
            actual, recorded,
            "the vendored OPSIN jar does not match the hash BUILD.md records. Either the jar was \
             replaced without updating BUILD.md, or BUILD.md was edited without rebuilding."
        );
    }
}
