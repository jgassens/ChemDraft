//! Supply-chain pins for the user-installed OCSR engine.
//!
//! Bumping any value in this file is a deliberate, reviewed dependency change. Keep the bundled
//! requirements file, the install receipt, NOTICE, and the dependency inventory in sync.

pub const PROTOCOL_VERSION: u32 = 2;
// Linux CPU wheels use about 3.1 GB installed. Allow additional free space for staging/cache;
// an existing engine is already allocated and only renamed during replacement.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const REQUIRED_DISK_BYTES: u64 = 8_000_000_000;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub const REQUIRED_DISK_BYTES: u64 = 3_000_000_000;
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
/// The versions the platform-selected requirements file locks for the three packages the
/// engine is reviewed against; a test asserts the lock agrees.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const TORCH_VERSION: &str = "2.14.0+cpu";
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub const TORCH_VERSION: &str = "2.14.0";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const TORCHVISION_VERSION: &str = "0.29.0+cpu";
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub const TORCHVISION_VERSION: &str = "0.29.0";
pub const NUMPY_VERSION: &str = "1.26.4";
pub const REQUIREMENTS_RESOURCE: &str = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "resources/ocsr/requirements-linux-x86_64.txt"
} else {
    "resources/ocsr/requirements.txt"
};
#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
pub const BUNDLED_REQUIREMENTS: &str =
    include_str!("../../resources/ocsr/requirements-linux-x86_64.txt");
#[cfg(all(test, not(all(target_os = "linux", target_arch = "x86_64"))))]
pub const BUNDLED_REQUIREMENTS: &str = include_str!("../../resources/ocsr/requirements.txt");
/// SHA-256 of the platform-selected requirements file, taken with line endings
/// normalized to LF (a Windows checkout may write CRLF). The installer refuses a requirements file
/// that differs, and a test fails until this is updated after a re-lock.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const REQUIREMENTS_LOCK_SHA256: &str =
    "381da6b0648e386311c87eed9c4dde0b79dbf68bf9ef6dbda1bd3e3e7173413f";
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub const REQUIREMENTS_LOCK_SHA256: &str =
    "6c71c47f1bf1ee6c419948121ab3923b50dff75488445e4dbd3c0a84b08d7383";
pub const MODEL_REVISION: &str = "a0189776b7415b82795c7ee81eed311bf5c8724b";
pub const MODEL_URL: &str = "https://huggingface.co/yujieq/MolScribe/resolve/a0189776b7415b82795c7ee81eed311bf5c8724b/swin_base_char_aux_1m.pth";
pub const MODEL_FILENAME: &str = "swin_base_char_aux_1m.pth";
pub const MODEL_BYTES: u64 = 1_134_940_406;
pub const MODEL_SHA256: &str = "6f0df56fa32b5ffc21f8c7f311ef333da522f590bf5622e966c6bcb1f2d9ea1d";

pub use crate::local_engine::pins::*;
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
