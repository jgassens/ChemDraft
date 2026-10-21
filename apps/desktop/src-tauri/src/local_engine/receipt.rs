//! Version dispatch and atomic receipt writes; schemas belong to engine adapters.
use super::InstallError;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
/// Writes the receipt beside itself and renames it into place, so a crash mid-write leaves the
/// old receipt or the new one, never half of one.
pub fn write_receipt<S: super::EngineSpec>(
    path: &Path,
    receipt: &S::Receipt,
) -> Result<(), InstallError>
where
    S::Receipt: serde::Serialize,
{
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
        return Err(S::failed_io(error));
    }
    Ok(())
}

/// Reads an explicit schema version, or dispatches an unversioned historical shape. The caller
/// still owns deserialization and how an older or newer schema is presented to the user.
pub fn receipt_version(
    value: &serde_json::Value,
    legacy_version: u32,
    current_version: u32,
    current_shape_key: &str,
) -> Result<u32, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "not a JSON object".to_string())?;
    match object.get("receiptVersion") {
        None if object.contains_key(current_shape_key) => Ok(current_version),
        None => Ok(legacy_version),
        Some(version) => version
            .as_u64()
            .and_then(|version| u32::try_from(version).ok())
            .ok_or_else(|| format!("receiptVersion {version}")),
    }
}
