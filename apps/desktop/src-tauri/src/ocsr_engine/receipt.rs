//! The install receipt, `install.json`, and its schema versions.
//!
//! | Version | Written by | Keys |
//! | --- | --- | --- |
//! | 1 | installs before the hash-locked requirements (6635f42) | [`LegacyReceiptV1`]: constraints (`torchConstraint` …), no `receiptVersion` |
//! | 2 | 6635f42 onward | [`InstallReceipt`]: exact versions and the lock's SHA-256; `receiptVersion` from this change on |
//!
//! A version-2 receipt written by 6635f42 itself carries no `receiptVersion`; it is recognized by its
//! `requirementsSha256`. A version-1 receipt is never rejected as malformed: `ocsr_engine_status`
//! checks the engine it describes against the current pins and, if it matches, rewrites the receipt
//! in place (`upgrade.rs`).

use std::fmt;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::pins;
use super::platform::EnginePlatform;
use super::InstallError;

pub const CURRENT_RECEIPT_VERSION: u32 = 2;
pub const LEGACY_RECEIPT_VERSION: u32 = 1;

fn current_receipt_version() -> u32 {
    CURRENT_RECEIPT_VERSION
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceipt {
    #[serde(default = "current_receipt_version")]
    pub receipt_version: u32,
    pub uv_version: String,
    pub uv_asset: String,
    pub uv_sha256: String,
    pub python_version: String,
    pub requirements_sha256: String,
    pub torch_version: String,
    pub torchvision_version: String,
    pub numpy_version: String,
    pub molscribe_commit: String,
    pub molscribe_source_url: String,
    pub molscribe_source_sha256: String,
    pub model_revision: String,
    pub model_url: String,
    pub model_sha256: String,
    pub model_bytes: u64,
    pub installed_at: String,
    pub disk_bytes: u64,
    /// Present when an older receipt was rewritten after its engine was checked against these
    /// pins, rather than written by a fresh install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upgraded_in_place: Option<InPlaceUpgrade>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InPlaceUpgrade {
    pub from_receipt_version: u32,
    pub upgraded_at: String,
}

impl InstallReceipt {
    pub fn pinned(platform: &dyn EnginePlatform, disk_bytes: u64) -> Self {
        Self {
            receipt_version: CURRENT_RECEIPT_VERSION,
            uv_version: pins::UV_VERSION.to_string(),
            uv_asset: platform.uv_asset().to_string(),
            uv_sha256: platform.uv_sha256().to_string(),
            python_version: pins::PYTHON_VERSION.to_string(),
            requirements_sha256: pins::REQUIREMENTS_LOCK_SHA256.to_string(),
            torch_version: pins::TORCH_VERSION.to_string(),
            torchvision_version: pins::TORCHVISION_VERSION.to_string(),
            numpy_version: pins::NUMPY_VERSION.to_string(),
            molscribe_commit: pins::MOLSCRIBE_COMMIT.to_string(),
            molscribe_source_url: pins::MOLSCRIBE_SOURCE_URL.to_string(),
            molscribe_source_sha256: pins::MOLSCRIBE_SOURCE_SHA256.to_string(),
            model_revision: pins::MODEL_REVISION.to_string(),
            model_url: pins::MODEL_URL.to_string(),
            model_sha256: pins::MODEL_SHA256.to_string(),
            model_bytes: pins::MODEL_BYTES,
            installed_at: Utc::now().to_rfc3339(),
            disk_bytes,
            upgraded_in_place: None,
        }
    }

    pub fn matches_pins(&self, platform: &dyn EnginePlatform) -> bool {
        self.receipt_version == CURRENT_RECEIPT_VERSION
            && self.uv_version == pins::UV_VERSION
            && self.uv_asset == platform.uv_asset()
            && self.uv_sha256 == platform.uv_sha256()
            && self.python_version == pins::PYTHON_VERSION
            && self.requirements_sha256 == pins::REQUIREMENTS_LOCK_SHA256
            && self.torch_version == pins::TORCH_VERSION
            && self.torchvision_version == pins::TORCHVISION_VERSION
            && self.numpy_version == pins::NUMPY_VERSION
            && self.molscribe_commit == pins::MOLSCRIBE_COMMIT
            && self.molscribe_source_url == pins::MOLSCRIBE_SOURCE_URL
            && self.molscribe_source_sha256 == pins::MOLSCRIBE_SOURCE_SHA256
            && self.model_revision == pins::MODEL_REVISION
            && self.model_url == pins::MODEL_URL
            && self.model_sha256 == pins::MODEL_SHA256
            && self.model_bytes == pins::MODEL_BYTES
    }
}

/// The receipt installs wrote before the Python packages were hash-locked: range constraints
/// instead of exact versions, and no record of the requirements file.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyReceiptV1 {
    pub uv_version: String,
    pub uv_asset: String,
    pub uv_sha256: String,
    pub python_version: String,
    pub torch_constraint: String,
    pub torchvision_constraint: String,
    pub numpy_constraint: String,
    pub molscribe_commit: String,
    pub molscribe_source_url: String,
    pub model_revision: String,
    pub model_url: String,
    pub model_sha256: String,
    pub model_bytes: u64,
    pub installed_at: String,
    pub disk_bytes: u64,
}

impl LegacyReceiptV1 {
    /// Every recorded pin that the current pins still name identically. The constraints are not
    /// compared: the upgrade checks the exact versions actually installed instead.
    pub fn pin_mismatches(&self, platform: &dyn EnginePlatform) -> Vec<&'static str> {
        [
            ("uvVersion", self.uv_version == pins::UV_VERSION),
            ("uvAsset", self.uv_asset == platform.uv_asset()),
            ("uvSha256", self.uv_sha256 == platform.uv_sha256()),
            ("pythonVersion", self.python_version == pins::PYTHON_VERSION),
            (
                "molscribeCommit",
                self.molscribe_commit == pins::MOLSCRIBE_COMMIT,
            ),
            (
                "molscribeSourceUrl",
                self.molscribe_source_url == pins::MOLSCRIBE_SOURCE_URL,
            ),
            ("modelRevision", self.model_revision == pins::MODEL_REVISION),
            ("modelUrl", self.model_url == pins::MODEL_URL),
            ("modelSha256", self.model_sha256 == pins::MODEL_SHA256),
            ("modelBytes", self.model_bytes == pins::MODEL_BYTES),
        ]
        .into_iter()
        .filter_map(|(key, matches)| (!matches).then_some(key))
        .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptRead {
    Current(InstallReceipt),
    Legacy(LegacyReceiptV1),
}

/// Why a receipt could not be used. `Display` is the technical detail for the log; the UI gets
/// [`ReceiptError::plain_message`] and never a parser message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptError {
    Unreadable(String),
    Malformed(String),
    NewerVersion(u32),
}

impl ReceiptError {
    pub fn plain_message(&self) -> &'static str {
        match self {
            Self::Unreadable(_) | Self::Malformed(_) => {
                "The recognition engine’s installation record is damaged. Install the engine again."
            }
            Self::NewerVersion(_) => {
                "The recognition engine was installed by a newer version of ChemDraft. Update \
                 ChemDraft, or install the engine again."
            }
        }
    }
}

impl fmt::Display for ReceiptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(detail) => write!(formatter, "install receipt unreadable: {detail}"),
            Self::Malformed(detail) => write!(formatter, "install receipt malformed: {detail}"),
            Self::NewerVersion(version) => write!(
                formatter,
                "install receipt version {version} is newer than this build's {CURRENT_RECEIPT_VERSION}"
            ),
        }
    }
}

pub fn read_receipt(path: &Path) -> Result<ReceiptRead, ReceiptError> {
    let text =
        fs::read_to_string(path).map_err(|error| ReceiptError::Unreadable(error.to_string()))?;
    parse_receipt(&text)
}

/// A receipt only if it is the current version; a legacy one needs the upgrade check first.
pub fn read_current_receipt(path: &Path) -> Option<InstallReceipt> {
    match read_receipt(path) {
        Ok(ReceiptRead::Current(receipt)) => Some(receipt),
        _ => None,
    }
}

pub fn parse_receipt(text: &str) -> Result<ReceiptRead, ReceiptError> {
    let malformed = |error: serde_json::Error| ReceiptError::Malformed(error.to_string());
    let mut value: serde_json::Value = serde_json::from_str(text).map_err(malformed)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| ReceiptError::Malformed("not a JSON object".to_string()))?;
    let version = match object.get("receiptVersion") {
        // 6635f42 wrote the version-2 shape before receipts carried their version.
        None if object.contains_key("requirementsSha256") => CURRENT_RECEIPT_VERSION,
        None => LEGACY_RECEIPT_VERSION,
        Some(version) => version
            .as_u64()
            .and_then(|version| u32::try_from(version).ok())
            .ok_or_else(|| ReceiptError::Malformed(format!("receiptVersion {version}")))?,
    };
    match version {
        LEGACY_RECEIPT_VERSION => serde_json::from_value(value)
            .map(ReceiptRead::Legacy)
            .map_err(malformed),
        CURRENT_RECEIPT_VERSION => {
            object.insert(
                "receiptVersion".to_string(),
                serde_json::Value::from(CURRENT_RECEIPT_VERSION),
            );
            serde_json::from_value(value)
                .map(ReceiptRead::Current)
                .map_err(malformed)
        }
        newer if newer > CURRENT_RECEIPT_VERSION => Err(ReceiptError::NewerVersion(newer)),
        other => Err(ReceiptError::Malformed(format!("receiptVersion {other}"))),
    }
}

/// Writes the receipt beside itself and renames it into place, so a crash mid-write leaves the
/// old receipt or the new one, never half of one.
pub fn write_receipt(path: &Path, receipt: &InstallReceipt) -> Result<(), InstallError> {
    let bytes = serde_json::to_vec_pretty(receipt).map_err(|error| {
        InstallError::failed(format!("Could not encode install receipt: {error}"))
    })?;
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = Path::new(&temporary);
    let written = File::create(temporary).and_then(|mut file| {
        file.write_all(&bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|()| fs::rename(temporary, path)) {
        let _ = fs::remove_file(temporary);
        return Err(InstallError::failed_io(error));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ocsr_engine::platform::{MacArchitecture, MacPlatform};

    /// The owner's real receipt from an install made before 6635f42, key for key.
    pub(crate) const OWNER_LEGACY_RECEIPT: &str = r#"{
  "uvVersion": "0.12.18",
  "uvAsset": "uv-aarch64-apple-darwin.tar.gz",
  "uvSha256": "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b",
  "pythonVersion": "3.10",
  "torchConstraint": "~=2.14.0",
  "torchvisionConstraint": "~=0.29.0",
  "numpyConstraint": "~=1.26.4",
  "molscribeCommit": "7296a30413eb55436702011efdff78131f66d162",
  "molscribeSourceUrl": "https://github.com/thomas0809/MolScribe/archive/7296a30413eb55436702011efdff78131f66d162.tar.gz",
  "modelRevision": "a0189776b7415b82795c7ee81eed311bf5c8724b",
  "modelUrl": "https://huggingface.co/yujieq/MolScribe/resolve/a0189776b7415b82795c7ee81eed311bf5c8724b/swin_base_char_aux_1m.pth",
  "modelSha256": "6f0df56fa32b5ffc21f8c7f311ef333da522f590bf5622e966c6bcb1f2d9ea1d",
  "modelBytes": 1134940406,
  "installedAt": "2026-09-24T21:32:08.676809+00:00",
  "diskBytes": 2414387108
}"#;

    fn temp_file(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "chemdraft-ocsr-receipt-{label}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("test root");
        root.join("install.json")
    }

    #[test]
    fn the_owners_legacy_receipt_parses_as_version_one_and_matches_the_pins() {
        let ReceiptRead::Legacy(legacy) = parse_receipt(OWNER_LEGACY_RECEIPT).expect("parses")
        else {
            panic!("a receipt without requirementsSha256 is version 1");
        };
        assert_eq!(legacy.torch_constraint, "~=2.14.0");
        assert_eq!(legacy.disk_bytes, 2_414_387_108);
        let platform = MacPlatform::new(MacArchitecture::Aarch64);
        assert!(legacy.pin_mismatches(&platform).is_empty());
        let other_model = OWNER_LEGACY_RECEIPT.replace("6f0df56f", "00000000");
        let Ok(ReceiptRead::Legacy(stale)) = parse_receipt(&other_model) else {
            panic!("still version 1");
        };
        assert_eq!(stale.pin_mismatches(&platform), ["modelSha256"]);
    }

    #[test]
    fn current_receipts_round_trip_with_and_without_a_recorded_version() {
        let platform = MacPlatform::new(MacArchitecture::X86_64);
        let receipt = InstallReceipt::pinned(&platform, 42);
        let path = temp_file("round-trip");
        write_receipt(&path, &receipt).expect("write receipt");
        let text = fs::read_to_string(&path).expect("receipt text");
        assert!(text.contains("\"receiptVersion\": 2"));
        assert!(!text.contains("upgradedInPlace"));
        assert_eq!(
            read_receipt(&path).expect("read"),
            ReceiptRead::Current(receipt.clone())
        );
        assert!(!path.with_extension("json.tmp").exists());

        // What 6635f42 wrote: the version-2 keys without `receiptVersion`.
        let mut unversioned = serde_json::to_value(&receipt).expect("value");
        unversioned
            .as_object_mut()
            .expect("object")
            .remove("receiptVersion");
        assert_eq!(
            parse_receipt(&unversioned.to_string()).expect("read"),
            ReceiptRead::Current(receipt.clone())
        );

        let upgraded = InstallReceipt {
            upgraded_in_place: Some(InPlaceUpgrade {
                from_receipt_version: 1,
                upgraded_at: "2026-09-25T00:00:00+00:00".to_string(),
            }),
            ..receipt
        };
        write_receipt(&path, &upgraded).expect("rewrite receipt");
        assert_eq!(
            read_receipt(&path).expect("read"),
            ReceiptRead::Current(upgraded)
        );
        let _ = fs::remove_dir_all(path.parent().expect("root"));
    }

    #[test]
    fn stale_pins_are_detected() {
        let platform = MacPlatform::new(MacArchitecture::X86_64);
        let receipt = InstallReceipt::pinned(&platform, 42);
        assert!(receipt.matches_pins(&platform));
        assert!(!receipt.matches_pins(&MacPlatform::new(MacArchitecture::Aarch64)));
        let stale = InstallReceipt {
            model_sha256: "0".repeat(64),
            ..receipt
        };
        assert!(!stale.matches_pins(&platform));
    }

    #[test]
    fn unusable_receipts_carry_a_plain_message_and_never_the_parser_error() {
        let missing_field = parse_receipt(r#"{"receiptVersion": 2, "uvVersion": "0.12.18"}"#)
            .expect_err("incomplete");
        let broken_json = parse_receipt("{not json").expect_err("not json");
        let legacy_missing = parse_receipt(r#"{"uvVersion": "0.12.18"}"#).expect_err("partial v1");
        let newer = parse_receipt(r#"{"receiptVersion": 9}"#).expect_err("newer");
        assert_eq!(newer, ReceiptError::NewerVersion(9));
        let unreadable = read_receipt(Path::new("/nonexistent/chemdraft/install.json"))
            .expect_err("missing file");
        for error in [
            missing_field,
            broken_json,
            legacy_missing,
            newer,
            unreadable,
        ] {
            let plain = error.plain_message();
            for technical in [
                "missing field",
                "line",
                "column",
                "serde",
                "JSON",
                "receipt",
            ] {
                assert!(
                    !plain.contains(technical),
                    "{plain:?} contains {technical:?}"
                );
            }
            assert!(!error.to_string().is_empty());
        }
    }
}
