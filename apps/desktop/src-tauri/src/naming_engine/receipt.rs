use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use super::pins;
use crate::local_engine::{pins::UV_VERSION, platform::EnginePlatform};

pub const RECEIPT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallReceipt {
    pub receipt_version: u32,
    pub engine_dir: String,
    pub uv_version: String,
    pub uv_asset: String,
    pub uv_sha256: String,
    pub python_version: String,
    pub orthonym_version: String,
    pub orthonym_commit: String,
    pub orthonym_wheel_sha256: String,
    pub requirements_sha256: String,
    pub centres_url: String,
    pub centres_bytes: u64,
    pub centres_sha256: String,
    pub installed_at: String,
    pub disk_bytes: u64,
}

impl InstallReceipt {
    pub fn pinned(platform: &dyn EnginePlatform, disk_bytes: u64) -> Self {
        Self {
            receipt_version: RECEIPT_VERSION,
            engine_dir: pins::DIR_NAME.into(),
            uv_version: UV_VERSION.into(),
            uv_asset: platform.uv_asset().into(),
            uv_sha256: platform.uv_sha256().into(),
            python_version: pins::PYTHON_VERSION.into(),
            orthonym_version: pins::ORTHONYM_VERSION.into(),
            orthonym_commit: pins::ORTHONYM_COMMIT.into(),
            orthonym_wheel_sha256: pins::ORTHONYM_WHEEL_SHA256.into(),
            requirements_sha256: pins::REQUIREMENTS_LOCK_SHA256.into(),
            centres_url: pins::CENTRES_URL.into(),
            centres_bytes: pins::CENTRES_BYTES,
            centres_sha256: pins::CENTRES_SHA256.into(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            disk_bytes,
        }
    }

    pub fn matches_pins(&self, platform: &dyn EnginePlatform) -> bool {
        let mut expected = Self::pinned(platform, self.disk_bytes);
        expected.installed_at.clone_from(&self.installed_at);
        self == &expected
    }
}

pub fn parse_receipt(text: &str) -> Result<InstallReceipt, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| format!("The naming engine installation record is damaged: {error}"))?;
    // Dispatch before deserialization so future schemas receive a useful diagnostic.
    if let Some(version) = value["receiptVersion"].as_u64() {
        if version > u64::from(RECEIPT_VERSION) {
            return Err(format!("The naming engine installation record version {version} is newer than this build's {RECEIPT_VERSION}. Update ChemDraft or reinstall the engine."));
        }
    }
    let receipt: InstallReceipt = serde_json::from_value(value)
        .map_err(|error| format!("The naming engine installation record is damaged: {error}"))?;
    if receipt.receipt_version != RECEIPT_VERSION {
        return Err(format!(
            "Unsupported naming engine installation record version {}.",
            receipt.receipt_version
        ));
    }
    Ok(receipt)
}

pub fn read_receipt(path: &Path) -> Result<InstallReceipt, String> {
    let text = fs::read_to_string(path).map_err(|error| {
        format!("Could not read the naming engine installation record: {error}")
    })?;
    parse_receipt(&text)
}
