//! Shared runtime-tool pins and digest verification.
use sha2::{Digest, Sha256};
use std::io::{self, Read};
pub const UV_VERSION: &str = "0.12.18";
#[cfg(any(target_os = "macos", test))]
pub const UV_AARCH64_APPLE_ASSET: &str = "uv-aarch64-apple-darwin.tar.gz";
#[cfg(any(target_os = "macos", test))]
pub const UV_AARCH64_APPLE_SHA256: &str =
    "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b";
#[cfg(any(target_os = "macos", test))]
pub const UV_X86_64_APPLE_ASSET: &str = "uv-x86_64-apple-darwin.tar.gz";
#[cfg(any(target_os = "macos", test))]
pub const UV_X86_64_APPLE_SHA256: &str =
    "2e4108f5395397c8bc5d43bf83d3bdbb2d0e92b90d0efa607756be704905fa33";
#[cfg(any(target_os = "windows", test))]
pub const UV_X86_64_WINDOWS_ASSET: &str = "uv-x86_64-pc-windows-msvc.zip";
#[cfg(any(target_os = "windows", test))]
pub const UV_X86_64_WINDOWS_SHA256: &str =
    "cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff";
// Official release .sha256 files and downloaded archive bytes verified on 2026-10-29.
#[cfg(any(target_os = "linux", test))]
pub const UV_X86_64_LINUX_ASSET: &str = "uv-x86_64-unknown-linux-gnu.tar.gz";
#[cfg(any(target_os = "linux", test))]
pub const UV_X86_64_LINUX_SHA256: &str =
    "89eadd7c76fc063887959510d5ba0ab1264dfd5f1143b925ddb73021a40acf16";
#[cfg(any(target_os = "linux", test))]
pub const UV_AARCH64_LINUX_ASSET: &str = "uv-aarch64-unknown-linux-gnu.tar.gz";
#[cfg(any(target_os = "linux", test))]
pub const UV_AARCH64_LINUX_SHA256: &str =
    "afb6291f3f0a6b4521fc67b947822506c41dde5b60d2189dd8f3695b2ac8c9e7";

pub fn uv_url(asset: &str) -> String {
    format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{asset}")
}

pub fn sha256_reader(mut reader: impl Read) -> io::Result<(u64, String)> {
    let mut digest = Sha256::new();
    let mut count = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        count += read as u64;
    }
    Ok((count, format!("{:x}", digest.finalize())))
}

pub fn verify_reader(
    reader: impl Read,
    expected_size: Option<u64>,
    expected_sha256: &str,
) -> Result<u64, String> {
    let (size, actual) = sha256_reader(reader).map_err(|error| error.to_string())?;
    verify_digest(size, &actual, expected_size, expected_sha256)
}

/// SHA-256 of a text file's bytes with every CRLF read as LF, so the pin is independent of how a
/// checkout wrote line endings.
pub fn text_sha256(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    let mut rest = bytes;
    while let Some(index) = rest.windows(2).position(|pair| pair == b"\r\n") {
        digest.update(&rest[..index]);
        rest = &rest[index + 1..];
    }
    digest.update(rest);
    format!("{:x}", digest.finalize())
}

pub fn verify_digest(
    size: u64,
    actual_sha256: &str,
    expected_size: Option<u64>,
    expected_sha256: &str,
) -> Result<u64, String> {
    if let Some(expected) = expected_size {
        if size != expected {
            return Err(format!("expected {expected} bytes, received {size}"));
        }
    }
    if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "expected SHA-256 {expected_sha256}, received {actual_sha256}"
        ));
    }
    Ok(size)
}
