//! Supply-chain pins for the user-installed OCSR engine.
//!
//! Bumping any value in this file is a deliberate, reviewed dependency change. Keep the bundled
//! requirements file, the install receipt, NOTICE, and the dependency inventory in sync.

use sha2::{Digest, Sha256};
#[cfg(test)]
use std::io::{self, Read};

pub const PROTOCOL_VERSION: u32 = 2;
pub const REQUIRED_DISK_BYTES: u64 = 3_000_000_000;
pub const UV_VERSION: &str = "0.12.18";
pub const PYTHON_VERSION: &str = "3.10";
pub const MOLSCRIBE_COMMIT: &str = "7296a30413eb55436702011efdff78131f66d162";
pub const MOLSCRIBE_SOURCE_URL: &str =
    "https://github.com/thomas0809/MolScribe/archive/7296a30413eb55436702011efdff78131f66d162.tar.gz";
/// The archive at `MOLSCRIBE_SOURCE_URL`, measured 2026-09-24. A requirements file cannot hash-lock
/// a URL, so Rust downloads and verifies the tarball and uv installs the local file `--no-deps`.
pub const MOLSCRIBE_SOURCE_BYTES: u64 = 5_727_892;
pub const MOLSCRIBE_SOURCE_SHA256: &str =
    "8e323f473b96c80ff88112f2653a064a443fcfd918654a0d7e0f7866bd5ee2d6";
pub const MOLSCRIBE_SOURCE_FILENAME: &str =
    "molscribe-7296a30413eb55436702011efdff78131f66d162.tar.gz";
/// The versions `resources/ocsr/requirements.txt` locks (with hashes) for the three packages the
/// engine is reviewed against; a test asserts the lock agrees.
pub const TORCH_VERSION: &str = "2.14.0";
pub const TORCHVISION_VERSION: &str = "0.29.0";
pub const NUMPY_VERSION: &str = "1.26.4";
/// SHA-256 of the bundled, hash-locked `resources/ocsr/requirements.txt`, taken with line endings
/// normalized to LF (a Windows checkout may write CRLF). The installer refuses a requirements file
/// that differs, and a test fails until this is updated after a re-lock.
pub const REQUIREMENTS_LOCK_SHA256: &str =
    "6c71c47f1bf1ee6c419948121ab3923b50dff75488445e4dbd3c0a84b08d7383";
pub const MODEL_REVISION: &str = "a0189776b7415b82795c7ee81eed311bf5c8724b";
pub const MODEL_URL: &str = "https://huggingface.co/yujieq/MolScribe/resolve/a0189776b7415b82795c7ee81eed311bf5c8724b/swin_base_char_aux_1m.pth";
pub const MODEL_FILENAME: &str = "swin_base_char_aux_1m.pth";
pub const MODEL_BYTES: u64 = 1_134_940_406;
pub const MODEL_SHA256: &str = "6f0df56fa32b5ffc21f8c7f311ef333da522f590bf5622e966c6bcb1f2d9ea1d";

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

pub fn uv_url(asset: &str) -> String {
    format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{asset}")
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_verification_accepts_pinned_bytes_and_rejects_tampering() {
        let bytes = b"pinned fixture";
        let (_, checksum) = sha256_reader(&bytes[..]).expect("hash fixture");
        assert_eq!(
            verify_reader(&bytes[..], Some(bytes.len() as u64), &checksum),
            Ok(bytes.len() as u64)
        );
        assert!(verify_reader(&b"tampered"[..], None, &checksum)
            .expect_err("tampering must fail")
            .contains("SHA-256"));
    }

    #[test]
    fn size_verification_is_independent_of_checksum() {
        let bytes = b"abc";
        let (_, checksum) = sha256_reader(&bytes[..]).expect("hash fixture");
        assert!(verify_reader(&bytes[..], Some(4), &checksum)
            .expect_err("wrong size must fail")
            .contains("expected 4 bytes"));
    }

    #[test]
    fn text_digest_ignores_line_ending_style_but_not_content() {
        let lf = text_sha256(b"torch==2.14.0 \\\n    --hash=sha256:ab\n");
        assert_eq!(
            lf,
            text_sha256(b"torch==2.14.0 \\\r\n    --hash=sha256:ab\r\n")
        );
        assert_ne!(lf, text_sha256(b"torch==2.14.1 \\\n    --hash=sha256:ab\n"));
        let (_, plain) = sha256_reader(&b"a\nb"[..]).expect("hash");
        assert_eq!(text_sha256(b"a\r\nb"), plain);
    }

    #[test]
    fn digest_verification_rejects_a_tampered_digest() {
        assert!(verify_digest(3, "bad", Some(3), &"0".repeat(64))
            .expect_err("tampered digest")
            .contains("SHA-256"));
    }
}
