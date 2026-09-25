//! In-place upgrade of an engine installed under an older receipt version.
//!
//! Installs made before the Python packages were hash-locked wrote a version-1 receipt
//! (`receipt.rs`). Such an engine may be exactly what a fresh install would produce today, so it is
//! checked against the CURRENT pins without downloading anything, and only if every check passes is
//! its receipt rewritten in the current format:
//!
//! 1. the old receipt's recorded pins (uv, Python, MolScribe commit, model) equal today's;
//! 2. the bundled requirements file is the reviewed lock;
//! 3. the installed uv reports the pinned version;
//! 4. the venv's Python is the pinned minor version and imports `cv2, molscribe, numpy, torch,
//!    torchvision`, as the post-install check does;
//! 5. the venv's packages equal the lock exactly by `name==version` — every package the lock
//!    requires on this platform is present, and nothing else is, except MolScribe itself;
//! 6. MolScribe was installed from the pinned commit;
//! 7. the model's size and SHA-256 equal the pin (hashed last; it is the slow step).
//!
//! Step 5 is sufficient for packages because PyPI never lets a file be replaced: the same name and
//! version on the same platform is the same wheel the lock's hashes describe.
//!
//! A failure is reported to the user as [`ENGINE_NEEDS_UPDATE`], never with the technical detail,
//! which goes to the log. Nothing here downloads, and nothing is written except the new receipt.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use sha2::{Digest, Sha256};

use super::install::{ProbeIo, RECEIPT_FILE};
use super::pins;
use super::platform::EnginePlatform;
use super::receipt::{
    write_receipt, InPlaceUpgrade, InstallReceipt, LegacyReceiptV1, LEGACY_RECEIPT_VERSION,
};
use super::{InstallError, InstallErrorCode};

/// What the user is told when an older engine does not match this build.
pub const ENGINE_NEEDS_UPDATE: &str =
    "The recognition engine needs to be updated. Install the engine again to update it.";

/// Imports what the sidecar needs, then prints the environment that the lock's markers are
/// evaluated against — the interpreter's own answer, as pip would read it. Printed last, so the
/// line exists only if every import succeeded.
const PYTHON_PROBE: &str = "\
import json, os, platform, sys
env = {
    'python_version': '%d.%d' % sys.version_info[:2],
    'python_full_version': platform.python_version(),
    'sys_platform': sys.platform,
    'platform_system': platform.system(),
    'platform_machine': platform.machine(),
    'platform_python_implementation': platform.python_implementation(),
    'implementation_name': sys.implementation.name,
    'os_name': os.name,
}
import cv2, molscribe, numpy, torch, torchvision
print(json.dumps(env))
";

/// The model file the engine must hold. Production uses [`ModelPin::pinned`]; tests substitute a
/// small file, since hashing a real-size stand-in would take most of a test run.
#[derive(Debug, Clone)]
pub struct ModelPin {
    pub filename: &'static str,
    pub bytes: u64,
    pub sha256: String,
}

impl ModelPin {
    pub fn pinned() -> Self {
        Self {
            filename: pins::MODEL_FILENAME,
            bytes: pins::MODEL_BYTES,
            sha256: pins::MODEL_SHA256.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpgradeError {
    Cancelled,
    /// The engine does not match this build. The text is for the log, not the user.
    Mismatch(String),
}

impl UpgradeError {
    fn from_probe(what: &str, error: InstallError) -> Self {
        if error.code == InstallErrorCode::Cancelled {
            Self::Cancelled
        } else {
            Self::Mismatch(format!("{what}: {}", error.message))
        }
    }
}

fn mismatch(detail: impl Into<String>) -> UpgradeError {
    UpgradeError::Mismatch(detail.into())
}

/// Checks the engine at `root` against the current pins (see the module comment) and, if it
/// passes, atomically rewrites its receipt in the current format. Returns the new receipt.
pub fn upgrade_legacy_receipt(
    root: &Path,
    platform: &dyn EnginePlatform,
    legacy: &LegacyReceiptV1,
    requirements: &[u8],
    model: &ModelPin,
    io: &dyn ProbeIo,
    cancel: &AtomicBool,
) -> Result<InstallReceipt, UpgradeError> {
    verify_legacy_engine(root, platform, legacy, requirements, model, io, cancel)?;
    check_cancel(cancel)?;
    let receipt = InstallReceipt {
        installed_at: legacy.installed_at.clone(),
        upgraded_in_place: Some(InPlaceUpgrade {
            from_receipt_version: LEGACY_RECEIPT_VERSION,
            upgraded_at: Utc::now().to_rfc3339(),
        }),
        ..InstallReceipt::pinned(platform, legacy.disk_bytes)
    };
    write_receipt(&root.join(RECEIPT_FILE), &receipt)
        .map_err(|error| mismatch(format!("could not rewrite the receipt: {}", error.message)))?;
    Ok(receipt)
}

/// The checks alone; reads the engine and runs its uv and Python, and writes nothing.
pub fn verify_legacy_engine(
    root: &Path,
    platform: &dyn EnginePlatform,
    legacy: &LegacyReceiptV1,
    requirements: &[u8],
    model: &ModelPin,
    io: &dyn ProbeIo,
    cancel: &AtomicBool,
) -> Result<(), UpgradeError> {
    let stale = legacy.pin_mismatches(platform);
    if !stale.is_empty() {
        return Err(mismatch(format!(
            "the old receipt records different pins: {}",
            stale.join(", ")
        )));
    }
    let lock_sha256 = pins::text_sha256(requirements);
    if lock_sha256 != pins::REQUIREMENTS_LOCK_SHA256 {
        return Err(mismatch(format!(
            "the bundled requirements lock is {lock_sha256}, not the reviewed {}",
            pins::REQUIREMENTS_LOCK_SHA256
        )));
    }
    let lock = parse_lock(&String::from_utf8_lossy(requirements)).map_err(mismatch)?;

    let uv = platform.uv_executable(root);
    let python = platform.venv_python(root);
    let model_path = root.join(model.filename);
    for (label, path) in [("uv", &uv), ("Python", &python), ("model", &model_path)] {
        if !path.is_file() {
            return Err(mismatch(format!(
                "the {label} file is missing at {}",
                path.display()
            )));
        }
    }
    let model_size = fs::metadata(&model_path)
        .map_err(|error| mismatch(format!("could not read the model: {error}")))?
        .len();
    if model_size != model.bytes {
        return Err(mismatch(format!(
            "the model is {model_size} bytes, not {}",
            model.bytes
        )));
    }

    let uv_output = io
        .output(platform, &uv, &[OsString::from("--version")], cancel)
        .map_err(|error| UpgradeError::from_probe("uv --version failed", error))?;
    let uv_version = uv_output.split_whitespace().nth(1).unwrap_or_default();
    if uv_version != pins::UV_VERSION {
        return Err(mismatch(format!(
            "uv reports {:?}, not {}",
            uv_output.trim(),
            pins::UV_VERSION
        )));
    }

    // `-I` ignores the user's site and PYTHON* variables; `-B` writes no bytecode into the venv.
    let probe = io
        .output(
            platform,
            &python,
            &[
                OsString::from("-I"),
                OsString::from("-B"),
                OsString::from("-c"),
                OsString::from(PYTHON_PROBE),
            ],
            cancel,
        )
        .map_err(|error| UpgradeError::from_probe("the import check failed", error))?;
    let environment = parse_probe(&probe).map_err(mismatch)?;
    let python_version = environment
        .get("python_version")
        .map(String::as_str)
        .unwrap_or_default();
    if python_version != pins::PYTHON_VERSION {
        return Err(mismatch(format!(
            "the venv runs Python {python_version}, not {}",
            pins::PYTHON_VERSION
        )));
    }

    let site_packages = site_packages(root, python_version)
        .ok_or_else(|| mismatch("the venv has no site-packages directory"))?;
    let installed = installed_distributions(&site_packages).map_err(mismatch)?;
    let problems = compare_with_lock(&installed, &lock, &environment);
    if !problems.is_empty() {
        return Err(mismatch(format!(
            "the venv differs from the lock: {}",
            problems.join("; ")
        )));
    }
    check_molscribe_source(&installed).map_err(mismatch)?;

    check_cancel(cancel)?;
    let (size, sha256) = hash_file(&model_path, cancel)?;
    pins::verify_digest(size, &sha256, Some(model.bytes), &model.sha256)
        .map_err(|detail| mismatch(format!("the model does not verify: {detail}")))?;
    Ok(())
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), UpgradeError> {
    if cancel.load(Ordering::SeqCst) {
        Err(UpgradeError::Cancelled)
    } else {
        Ok(())
    }
}

fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<(u64, String), UpgradeError> {
    let read_error = |error: std::io::Error| mismatch(format!("could not read the model: {error}"));
    let mut file = File::open(path).map_err(read_error)?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check_cancel(cancel)?;
        let read = file.read(&mut buffer).map_err(read_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

/// The last line of the probe's stdout: a library may print while it is imported.
fn parse_probe(output: &str) -> Result<HashMap<String, String>, String> {
    let line = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("the import check printed nothing")?;
    serde_json::from_str(line.trim())
        .map_err(|error| format!("the import check printed {line:?}: {error}"))
}

fn site_packages(root: &Path, python_version: &str) -> Option<PathBuf> {
    let venv = root.join("venv");
    [
        venv.join("lib")
            .join(format!("python{python_version}"))
            .join("site-packages"),
        venv.join("Lib").join("site-packages"),
    ]
    .into_iter()
    .find(|path| path.is_dir())
}

/// PEP 503 normalization: lower case, runs of `-`, `_` and `.` as one `-`.
fn normalize_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    let mut separator = false;
    for character in name.trim().chars() {
        if matches!(character, '-' | '_' | '.') {
            separator = true;
        } else {
            if separator && !normalized.is_empty() {
                normalized.push('-');
            }
            separator = false;
            normalized.push(character.to_ascii_lowercase());
        }
    }
    normalized
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstalledDistribution {
    name: String,
    version: String,
    dist_info: PathBuf,
}

/// Every distribution in `site-packages`, read from its `*.dist-info/METADATA`. An `.egg-info`
/// cannot be checked the same way, and uv never writes one, so it fails the check.
fn installed_distributions(site_packages: &Path) -> Result<Vec<InstalledDistribution>, String> {
    let entries = fs::read_dir(site_packages)
        .map_err(|error| format!("could not list {}: {error}", site_packages.display()))?;
    let mut installed = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|error| format!("could not list site-packages: {error}"))?
            .path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.ends_with(".egg-info") {
            return Err(format!("an unlocked egg-info install is present: {name}"));
        }
        if !name.ends_with(".dist-info") {
            continue;
        }
        let metadata = fs::read_to_string(path.join("METADATA"))
            .map_err(|error| format!("could not read {name}/METADATA: {error}"))?;
        let header = |key: &str| {
            metadata
                .lines()
                .take_while(|line| !line.is_empty())
                .find_map(|line| line.strip_prefix(key))
                .map(|value| value.trim().to_string())
        };
        let (Some(distribution), Some(version)) = (header("Name:"), header("Version:")) else {
            return Err(format!("{name}/METADATA has no Name or Version"));
        };
        installed.push(InstalledDistribution {
            name: normalize_name(&distribution),
            version,
            dist_info: path,
        });
    }
    installed.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(installed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LockedPackage {
    name: String,
    version: String,
    marker: Option<String>,
}

/// The requirement lines of a `uv pip compile --generate-hashes` file: `name==version`, an optional
/// `; marker`, and a trailing `\`. Hash lines and `# via` comments are indented. Anything else — an
/// option line, extras, a range — fails, so a lock this parser does not fully understand is never
/// half-checked.
fn parse_lock(text: &str) -> Result<Vec<LockedPackage>, String> {
    let mut packages = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() || line.starts_with('#') || line.starts_with(char::is_whitespace)
        {
            continue;
        }
        let entry = line.trim_end().trim_end_matches('\\').trim();
        let (requirement, marker) = match entry.split_once(';') {
            Some((requirement, marker)) => (requirement.trim(), Some(marker.trim().to_string())),
            None => (entry, None),
        };
        let (name, version) = requirement
            .split_once("==")
            .ok_or_else(|| format!("the lock line {line:?} is not an exact pin"))?;
        let valid_name = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        let version = version.trim();
        if !valid_name || version.is_empty() || version.contains(|c: char| c.is_whitespace()) {
            return Err(format!("the lock line {line:?} is not an exact pin"));
        }
        packages.push(LockedPackage {
            name: normalize_name(name),
            version: version.to_string(),
            marker,
        });
    }
    if packages.is_empty() {
        return Err("the lock names no packages".to_string());
    }
    Ok(packages)
}

/// Every difference between the venv and what the lock requires in `environment`. MolScribe is
/// installed from its own verified archive, not the lock, and is checked separately.
fn compare_with_lock(
    installed: &[InstalledDistribution],
    lock: &[LockedPackage],
    environment: &HashMap<String, String>,
) -> Vec<String> {
    let mut problems = Vec::new();
    let mut required = BTreeMap::new();
    let mut locked_elsewhere = BTreeMap::new();
    for package in lock {
        let applies = match &package.marker {
            None => Ok(true),
            Some(marker) => marker_applies(marker, environment),
        };
        match applies {
            Ok(true) => {
                required.insert(package.name.as_str(), package.version.as_str());
            }
            Ok(false) => {
                locked_elsewhere.insert(package.name.as_str(), package.version.as_str());
            }
            Err(error) => problems.push(format!("the marker for {} is {error}", package.name)),
        }
    }
    let mut seen = BTreeMap::new();
    for distribution in installed {
        if let Some(previous) = seen.insert(distribution.name.as_str(), &distribution.version) {
            problems.push(format!(
                "{} is installed twice ({previous} and {})",
                distribution.name, distribution.version
            ));
        }
        if distribution.name == "molscribe" {
            continue;
        }
        match required.get(distribution.name.as_str()) {
            Some(version) if *version == distribution.version => {}
            Some(version) => problems.push(format!(
                "{} is {}, the lock pins {version}",
                distribution.name, distribution.version
            )),
            None if locked_elsewhere.contains_key(distribution.name.as_str()) => {
                problems.push(format!(
                    "{} is installed but not locked for this computer",
                    distribution.name
                ))
            }
            None => problems.push(format!(
                "{}=={} is not in the lock",
                distribution.name, distribution.version
            )),
        }
    }
    for (name, version) in &required {
        if !seen.contains_key(name) {
            problems.push(format!("{name}=={version} is missing"));
        }
    }
    problems
}

/// MolScribe comes from its pinned commit: installs before the lock named the GitHub archive URL;
/// the current installer names the verified local archive.
fn check_molscribe_source(installed: &[InstalledDistribution]) -> Result<(), String> {
    let molscribe = installed
        .iter()
        .find(|distribution| distribution.name == "molscribe")
        .ok_or("MolScribe is not installed")?;
    let direct_url = fs::read_to_string(molscribe.dist_info.join("direct_url.json"))
        .map_err(|error| format!("MolScribe records no source: {error}"))?;
    let url = serde_json::from_str::<serde_json::Value>(&direct_url)
        .ok()
        .and_then(|value| value.get("url")?.as_str().map(str::to_string))
        .ok_or("MolScribe's direct_url.json names no URL")?;
    let local_archive = url.starts_with("file://")
        && url.ends_with(&format!("/{}", pins::MOLSCRIBE_SOURCE_FILENAME));
    if url == pins::MOLSCRIBE_SOURCE_URL || local_archive {
        Ok(())
    } else {
        Err(format!("MolScribe was installed from {url}"))
    }
}

// ---- Environment markers -------------------------------------------------------------------
//
// Enough of PEP 508 for the markers `uv pip compile --universal` writes: `and`, `or`,
// parentheses, and comparisons of a marker variable with a quoted string. A variable, operator
// or form it does not know is an error, which fails the check rather than guessing.

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Open,
    Close,
    And,
    Or,
    Not,
    In,
    Operator(&'static str),
    Variable(String),
    Literal(String),
}

fn tokenize(marker: &str) -> Result<Vec<Token>, String> {
    let characters: Vec<char> = marker.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character.is_whitespace() {
            index += 1;
            continue;
        }
        match character {
            '(' => {
                tokens.push(Token::Open);
                index += 1;
            }
            ')' => {
                tokens.push(Token::Close);
                index += 1;
            }
            '\'' | '"' => {
                let end = characters[index + 1..]
                    .iter()
                    .position(|c| *c == character)
                    .ok_or("an unterminated string")?;
                tokens.push(Token::Literal(
                    characters[index + 1..index + 1 + end].iter().collect(),
                ));
                index += end + 2;
            }
            '=' | '!' | '<' | '>' | '~' => {
                let two: String = characters[index..(index + 2).min(characters.len())]
                    .iter()
                    .collect();
                let operator = match two.as_str() {
                    "==" => "==",
                    "!=" => "!=",
                    "<=" => "<=",
                    ">=" => ">=",
                    _ if character == '<' => "<",
                    _ if character == '>' => ">",
                    _ => return Err(format!("the operator {two:?} is unsupported")),
                };
                tokens.push(Token::Operator(operator));
                index += operator.len();
            }
            _ if character.is_ascii_alphabetic() || character == '_' => {
                let length = characters[index..]
                    .iter()
                    .take_while(|c| c.is_ascii_alphanumeric() || **c == '_' || **c == '.')
                    .count();
                let word: String = characters[index..index + length].iter().collect();
                tokens.push(match word.as_str() {
                    "and" => Token::And,
                    "or" => Token::Or,
                    "not" => Token::Not,
                    "in" => Token::In,
                    _ => Token::Variable(word),
                });
                index += length;
            }
            _ => return Err(format!("{character:?} is unexpected")),
        }
    }
    Ok(tokens)
}

struct MarkerParser<'a> {
    tokens: Vec<Token>,
    position: usize,
    environment: &'a HashMap<String, String>,
}

impl MarkerParser<'_> {
    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.position).cloned();
        self.position += 1;
        token
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn or_expression(&mut self) -> Result<bool, String> {
        let mut value = self.and_expression()?;
        while self.peek() == Some(&Token::Or) {
            self.position += 1;
            // Both sides are evaluated so an unsupported form anywhere is reported.
            value |= self.and_expression()?;
        }
        Ok(value)
    }

    fn and_expression(&mut self) -> Result<bool, String> {
        let mut value = self.atom()?;
        while self.peek() == Some(&Token::And) {
            self.position += 1;
            value &= self.atom()?;
        }
        Ok(value)
    }

    fn atom(&mut self) -> Result<bool, String> {
        if self.peek() == Some(&Token::Open) {
            self.position += 1;
            let value = self.or_expression()?;
            return match self.next() {
                Some(Token::Close) => Ok(value),
                _ => Err("an unclosed parenthesis".to_string()),
            };
        }
        let (left, left_variable) = self.operand()?;
        let operator = match self.next() {
            Some(Token::Operator(operator)) => operator,
            Some(Token::In) => "in",
            Some(Token::Not) if self.next() == Some(Token::In) => "not in",
            other => return Err(format!("{other:?} is not a comparison")),
        };
        let (right, right_variable) = self.operand()?;
        let variable = left_variable.or(right_variable).unwrap_or_default();
        compare(&left, operator, &right, is_version_variable(&variable))
    }

    /// A value and, if it came from one, the variable that named it.
    fn operand(&mut self) -> Result<(String, Option<String>), String> {
        match self.next() {
            Some(Token::Literal(value)) => Ok((value, None)),
            Some(Token::Variable(name)) => {
                let value = self
                    .environment
                    .get(&name)
                    .cloned()
                    .ok_or_else(|| format!("the variable {name:?} is unknown"))?;
                Ok((value, Some(name)))
            }
            other => Err(format!("{other:?} is not a value")),
        }
    }
}

fn is_version_variable(name: &str) -> bool {
    matches!(
        name,
        "python_version" | "python_full_version" | "implementation_version"
    )
}

fn compare(left: &str, operator: &str, right: &str, as_version: bool) -> Result<bool, String> {
    if operator == "in" {
        return Ok(right.contains(left));
    }
    if operator == "not in" {
        return Ok(!right.contains(left));
    }
    let ordering = if as_version {
        compare_versions(left, right)?
    } else {
        match operator {
            "==" => return Ok(left == right),
            "!=" => return Ok(left != right),
            _ => return Err(format!("{operator} compares text")),
        }
    };
    Ok(match operator {
        "==" => ordering.is_eq(),
        "!=" => ordering.is_ne(),
        "<" => ordering.is_lt(),
        "<=" => ordering.is_le(),
        ">" => ordering.is_gt(),
        ">=" => ordering.is_ge(),
        _ => return Err(format!("{operator} is unsupported")),
    })
}

/// Release versions only (`3.10.18`, `3.11`): a pre-release or local suffix is an error.
fn compare_versions(left: &str, right: &str) -> Result<std::cmp::Ordering, String> {
    let parts = |version: &str| -> Result<Vec<u64>, String> {
        version
            .split('.')
            .map(|part| {
                part.parse::<u64>()
                    .map_err(|_| format!("{version:?} is not a release version"))
            })
            .collect()
    };
    let (mut left, mut right) = (parts(left)?, parts(right)?);
    let length = left.len().max(right.len());
    left.resize(length, 0);
    right.resize(length, 0);
    Ok(left.cmp(&right))
}

fn marker_applies(marker: &str, environment: &HashMap<String, String>) -> Result<bool, String> {
    let mut parser = MarkerParser {
        tokens: tokenize(marker)?,
        position: 0,
        environment,
    };
    let value = parser.or_expression()?;
    if parser.position != parser.tokens.len() {
        return Err("trailing text after the marker".to_string());
    }
    Ok(value)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ocsr_engine::platform::{MacArchitecture, MacPlatform};
    use crate::ocsr_engine::receipt::{
        parse_receipt, read_receipt, tests::OWNER_LEGACY_RECEIPT, ReceiptRead,
    };
    use std::sync::Mutex;

    pub(crate) const BUNDLED_REQUIREMENTS: &str =
        include_str!("../../resources/ocsr/requirements.txt");

    /// The marker environment of the interpreter on an Apple-silicon Mac.
    pub(crate) fn mac_arm64_environment() -> HashMap<String, String> {
        [
            ("python_version", "3.10"),
            ("python_full_version", "3.10.18"),
            ("sys_platform", "darwin"),
            ("platform_system", "Darwin"),
            ("platform_machine", "arm64"),
            ("platform_python_implementation", "CPython"),
            ("implementation_name", "cpython"),
            ("os_name", "posix"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
    }

    /// Answers `uv --version` and the Python probe as the installed engine would, and counts how
    /// often it was asked.
    pub(crate) struct FakeProbe {
        pub uv_output: String,
        pub python_output: Result<String, InstallErrorCode>,
        pub calls: Mutex<Vec<String>>,
    }

    impl FakeProbe {
        pub(crate) fn matching() -> Self {
            Self {
                uv_output: format!("uv {} (0000000 2026-09-01)\n", pins::UV_VERSION),
                python_output: Ok(format!(
                    "torch: some import-time chatter\n{}\n",
                    serde_json::to_string(&mac_arm64_environment()).expect("env json")
                )),
                calls: Mutex::new(Vec::new()),
            }
        }

        pub(crate) fn call_count(&self) -> usize {
            self.calls.lock().expect("calls").len()
        }
    }

    impl ProbeIo for FakeProbe {
        fn output(
            &self,
            _platform: &dyn EnginePlatform,
            program: &Path,
            args: &[OsString],
            _cancel: &AtomicBool,
        ) -> Result<String, InstallError> {
            let name = program
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            self.calls.lock().expect("calls").push(name.clone());
            if name.starts_with("uv") {
                assert_eq!(args, [OsString::from("--version")]);
                return Ok(self.uv_output.clone());
            }
            assert!(args.contains(&OsString::from("-I")) && args.contains(&OsString::from("-B")));
            self.python_output.clone().map_err(|code| InstallError {
                code,
                message: "fake import failure".to_string(),
            })
        }
    }

    pub(crate) fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "chemdraft-ocsr-upgrade-{label}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    pub(crate) const FAKE_MODEL: &[u8] = b"a small stand-in for the pinned MolScribe model";

    pub(crate) fn fake_model_pin() -> ModelPin {
        let digest = Sha256::digest(FAKE_MODEL);
        ModelPin {
            filename: pins::MODEL_FILENAME,
            bytes: FAKE_MODEL.len() as u64,
            sha256: format!("{digest:x}"),
        }
    }

    fn write_dist_info(site_packages: &Path, name: &str, version: &str) -> PathBuf {
        let dist_info =
            site_packages.join(format!("{}-{version}.dist-info", name.replace('-', "_")));
        fs::create_dir_all(&dist_info).expect("dist-info");
        fs::write(
            dist_info.join("METADATA"),
            format!("Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n\nLong description with Name: other\n"),
        )
        .expect("METADATA");
        dist_info
    }

    /// An engine tree laid out as an Apple-silicon install before 6635f42 left it: uv, the venv's
    /// interpreter, every package the lock requires on that platform, MolScribe from the GitHub
    /// archive, the (stand-in) model, and the owner's version-1 receipt.
    pub(crate) fn fake_legacy_engine(root: &Path) -> PathBuf {
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        let engine = root.join("ocsr-engine");
        let python = platform.venv_python(&engine);
        fs::create_dir_all(python.parent().expect("venv bin")).expect("venv bin");
        fs::write(&python, b"interpreter").expect("python");
        fs::write(platform.uv_executable(&engine), b"uv").expect("uv");
        fs::write(engine.join(pins::MODEL_FILENAME), FAKE_MODEL).expect("model");
        fs::write(engine.join(RECEIPT_FILE), OWNER_LEGACY_RECEIPT).expect("receipt");
        let site_packages = engine.join("venv/lib/python3.10/site-packages");
        let environment = mac_arm64_environment();
        for package in parse_lock(BUNDLED_REQUIREMENTS).expect("lock") {
            let applies = package
                .marker
                .as_deref()
                .map_or(Ok(true), |marker| marker_applies(marker, &environment))
                .expect("marker");
            if applies {
                write_dist_info(&site_packages, &package.name, &package.version);
            }
        }
        let molscribe = write_dist_info(&site_packages, "MolScribe", "1.1.1");
        fs::write(
            molscribe.join("direct_url.json"),
            format!(
                r#"{{"url":"{}","archive_info":{{}}}}"#,
                pins::MOLSCRIBE_SOURCE_URL
            ),
        )
        .expect("direct_url.json");
        engine
    }

    pub(crate) fn owner_legacy_receipt() -> LegacyReceiptV1 {
        match parse_receipt(OWNER_LEGACY_RECEIPT).expect("legacy receipt") {
            ReceiptRead::Legacy(legacy) => legacy,
            ReceiptRead::Current(_) => panic!("version 1"),
        }
    }

    fn upgrade(engine: &Path, probe: &FakeProbe) -> Result<InstallReceipt, UpgradeError> {
        upgrade_legacy_receipt(
            engine,
            &MacPlatform::new(MacArchitecture::Aarch64),
            &owner_legacy_receipt(),
            BUNDLED_REQUIREMENTS.as_bytes(),
            &fake_model_pin(),
            probe,
            &AtomicBool::new(false),
        )
    }

    #[test]
    fn the_bundled_lock_parses_and_selects_88_packages_on_an_apple_silicon_mac() {
        let lock = parse_lock(BUNDLED_REQUIREMENTS).expect("lock");
        assert_eq!(lock.len(), 109);
        let applies = |environment: &HashMap<String, String>| {
            lock.iter()
                .filter(|package| {
                    package
                        .marker
                        .as_deref()
                        .map_or(Ok(true), |marker| marker_applies(marker, environment))
                        .expect("every marker in the lock is understood")
                })
                .count()
        };
        // The owner's real venv holds 89 distributions: these 88 and MolScribe.
        assert_eq!(applies(&mac_arm64_environment()), 88);
        let mut linux = mac_arm64_environment();
        linux.insert("sys_platform".into(), "linux".into());
        linux.insert("platform_machine".into(), "x86_64".into());
        assert!(applies(&linux) > 88, "CUDA packages are Linux-only");
    }

    #[test]
    fn markers_evaluate_like_pep_508_and_refuse_what_they_do_not_know() {
        let env = mac_arm64_environment();
        let yes = |marker: &str| marker_applies(marker, &env).expect(marker);
        assert!(yes("sys_platform == 'darwin' or sys_platform == 'linux'"));
        assert!(!yes("(platform_machine == 'aarch64' and sys_platform == 'linux') or (platform_machine == 'x86_64' and sys_platform == 'linux')"));
        assert!(yes("python_full_version < '3.11'"));
        assert!(!yes(
            "python_full_version >= '3.12' and sys_platform == 'emscripten'"
        ));
        assert!(yes("platform_python_implementation != 'PyPy' and sys_platform != 'cygwin' and sys_platform != 'win32'"));
        assert!(yes("'darwin' == sys_platform"));
        assert!(marker_applies("extra == 'cuda'", &env).is_err());
        assert!(marker_applies("sys_platform ~= 'darwin'", &env).is_err());
        assert!(marker_applies("sys_platform < 'linux'", &env).is_err());
        assert!(marker_applies("(sys_platform == 'darwin'", &env).is_err());
        assert!(parse_lock("torch>=2.14\n").is_err());
        assert!(parse_lock("--index-url https://example.invalid\ntorch==2.14.0\n").is_err());
        assert_eq!(normalize_name("Typing_Extensions"), "typing-extensions");
        assert_eq!(normalize_name("ruamel.yaml"), "ruamel-yaml");
    }

    #[test]
    fn an_engine_that_matches_the_pins_is_upgraded_in_place() {
        let root = temp_root("match");
        let engine = fake_legacy_engine(&root);
        let probe = FakeProbe::matching();
        let receipt = upgrade(&engine, &probe).expect("a matching engine upgrades");
        assert_eq!(probe.call_count(), 2, "uv --version and the import check");
        assert_eq!(receipt.installed_at, "2026-09-24T21:32:08.676809+00:00");
        assert_eq!(receipt.disk_bytes, 2_414_387_108);
        assert_eq!(receipt.requirements_sha256, pins::REQUIREMENTS_LOCK_SHA256);
        assert_eq!(
            receipt
                .upgraded_in_place
                .as_ref()
                .map(|u| u.from_receipt_version),
            Some(1)
        );
        assert!(receipt.matches_pins(&MacPlatform::new(MacArchitecture::Aarch64)));
        assert_eq!(
            read_receipt(&engine.join(RECEIPT_FILE)).expect("rewritten receipt"),
            ReceiptRead::Current(receipt)
        );
        let _ = fs::remove_dir_all(root);
    }

    fn assert_refused(engine: &Path, probe: &FakeProbe, expected: &str) {
        match upgrade(engine, probe) {
            Err(UpgradeError::Mismatch(detail)) => {
                assert!(detail.contains(expected), "{detail:?} lacks {expected:?}")
            }
            other => panic!("expected a mismatch about {expected:?}, got {other:?}"),
        }
        // The old receipt is left exactly as it was.
        assert_eq!(
            fs::read_to_string(engine.join(RECEIPT_FILE)).expect("receipt"),
            OWNER_LEGACY_RECEIPT
        );
    }

    #[test]
    fn a_package_at_another_version_is_refused() {
        let root = temp_root("package");
        let engine = fake_legacy_engine(&root);
        let site_packages = engine.join("venv/lib/python3.10/site-packages");
        fs::remove_dir_all(site_packages.join("torch-2.14.0.dist-info")).expect("torch");
        write_dist_info(&site_packages, "torch", "2.14.1");
        assert_refused(&engine, &FakeProbe::matching(), "torch is 2.14.1");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_or_extra_package_is_refused() {
        let root = temp_root("extra");
        let engine = fake_legacy_engine(&root);
        let site_packages = engine.join("venv/lib/python3.10/site-packages");
        write_dist_info(&site_packages, "requests-toolbelt", "1.0.0");
        assert_refused(
            &engine,
            &FakeProbe::matching(),
            "requests-toolbelt==1.0.0 is not in the lock",
        );
        let _ = fs::remove_dir_all(root);

        let root = temp_root("missing");
        let engine = fake_legacy_engine(&root);
        let site_packages = engine.join("venv/lib/python3.10/site-packages");
        fs::remove_dir_all(site_packages.join("numpy-1.26.4.dist-info")).expect("numpy");
        assert_refused(&engine, &FakeProbe::matching(), "numpy==1.26.4 is missing");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_model_with_the_wrong_hash_is_refused() {
        let root = temp_root("model");
        let engine = fake_legacy_engine(&root);
        let mut tampered = FAKE_MODEL.to_vec();
        tampered[0] ^= 1;
        fs::write(engine.join(pins::MODEL_FILENAME), tampered).expect("tampered model");
        assert_refused(&engine, &FakeProbe::matching(), "SHA-256");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wrong_uv_python_or_molscribe_source_is_refused() {
        let root = temp_root("uv");
        let engine = fake_legacy_engine(&root);
        let mut probe = FakeProbe::matching();
        probe.uv_output = "uv 0.12.17 (0000000 2026-08-01)".to_string();
        assert_refused(&engine, &probe, "uv reports");

        let mut probe = FakeProbe::matching();
        probe.python_output = Err(InstallErrorCode::Failed);
        assert_refused(&engine, &probe, "import check failed");

        let mut environment = mac_arm64_environment();
        environment.insert("python_version".into(), "3.11".into());
        let mut probe = FakeProbe::matching();
        probe.python_output = Ok(serde_json::to_string(&environment).expect("json"));
        assert_refused(&engine, &probe, "Python 3.11");

        let molscribe = engine.join("venv/lib/python3.10/site-packages/MolScribe-1.1.1.dist-info");
        fs::write(
            molscribe.join("direct_url.json"),
            r#"{"url":"https://github.com/thomas0809/MolScribe/archive/main.tar.gz"}"#,
        )
        .expect("direct_url.json");
        assert_refused(
            &engine,
            &FakeProbe::matching(),
            "MolScribe was installed from",
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_cancelled_upgrade_is_not_a_mismatch_and_writes_nothing() {
        let root = temp_root("cancel");
        let engine = fake_legacy_engine(&root);
        let result = upgrade_legacy_receipt(
            &engine,
            &MacPlatform::new(MacArchitecture::Aarch64),
            &owner_legacy_receipt(),
            BUNDLED_REQUIREMENTS.as_bytes(),
            &fake_model_pin(),
            &FakeProbe::matching(),
            &AtomicBool::new(true),
        );
        assert_eq!(result, Err(UpgradeError::Cancelled));
        assert_eq!(
            fs::read_to_string(engine.join(RECEIPT_FILE)).expect("receipt"),
            OWNER_LEGACY_RECEIPT
        );
        let _ = fs::remove_dir_all(root);
    }

    /// Runs the real verification, read-only, against an installed engine: its uv and Python are
    /// run (Python with `-B`, so no bytecode is written) and its model is hashed; nothing is
    /// written. Run it with
    ///
    /// ```sh
    /// CHEMDRAFT_OCSR_ENGINE_DIR="$HOME/Library/Application Support/<bundle id>/ocsr-engine" \
    ///   cargo test --lib ocsr_engine::upgrade::tests::real_engine -- --ignored --nocapture
    /// ```
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "needs a real engine; set CHEMDRAFT_OCSR_ENGINE_DIR"]
    fn real_engine_passes_the_upgrade_verification_read_only() {
        let root = PathBuf::from(
            std::env::var_os("CHEMDRAFT_OCSR_ENGINE_DIR").expect("set CHEMDRAFT_OCSR_ENGINE_DIR"),
        );
        let receipt_before = fs::read(root.join(RECEIPT_FILE)).expect("receipt");
        let ReceiptRead::Legacy(legacy) = read_receipt(&root.join(RECEIPT_FILE)).expect("receipt")
        else {
            panic!("this engine already has a current receipt");
        };
        let io = super::super::install::SystemInstallIo::new(Default::default()).expect("io");
        let started = std::time::Instant::now();
        let result = verify_legacy_engine(
            &root,
            &MacPlatform::new(MacArchitecture::Aarch64),
            &legacy,
            BUNDLED_REQUIREMENTS.as_bytes(),
            &ModelPin::pinned(),
            &io,
            &AtomicBool::new(false),
        );
        eprintln!("verification took {:?}: {result:?}", started.elapsed());
        assert_eq!(
            fs::read(root.join(RECEIPT_FILE)).expect("receipt"),
            receipt_before
        );
        result.expect("the real engine matches the current pins");
    }
}
