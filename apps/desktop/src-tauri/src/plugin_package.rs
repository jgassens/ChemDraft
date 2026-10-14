//! Read a user-chosen local ZIP and exactly its adjacent `.sha256`, without extending webview scope.
//! The optional sibling and ZIP are read once; TypeScript checks SHA-256, CRC, manifest, API and handshake.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri_plugin_fs::FsExt;

// Match the archive reader's compressed-byte limit. A checksum should be one short text line.
const MAX_ZIP_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: u64 = 4096;

#[derive(Debug)]
pub struct LocalPluginPackage {
    zip_bytes: Vec<u8>,
    sidecar: Option<String>,
}

impl LocalPluginPackage {
    // One binary response: u32 little-endian UTF-8 checksum length, checksum, then ZIP bytes.
    // Zero means absent; a present empty checksum is refused during validation before framing.
    fn into_binary(self) -> Vec<u8> {
        let checksum = self.sidecar.unwrap_or_default().into_bytes();
        let mut bytes = Vec::with_capacity(4 + checksum.len() + self.zip_bytes.len());
        bytes.extend_from_slice(&(checksum.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&checksum);
        bytes.extend_from_slice(&self.zip_bytes);
        bytes
    }
}

#[tauri::command]
pub fn read_plugin_package(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    zip_path: PathBuf,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" {
        return Err("Plugin packages can only be chosen in the document window.".into());
    }
    // The fs plugin's runtime scope is populated by the native dialog (not the broad per-command
    // filesystem capability scopes). Do not grant the sibling, its directory, or a glob here.
    read_chosen_package(&zip_path, |path| app.fs_scope().is_allowed(path))
        .map(|package| tauri::ipc::Response::new(package.into_binary()))
}

fn sibling_checksum_path(zip: &Path) -> Result<PathBuf, String> {
    if !zip.is_absolute()
        || zip.components().any(|c| matches!(c, Component::ParentDir))
        || !zip
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err("Plugin package must be an absolute .zip path without traversal.".into());
    }
    let mut name = zip
        .file_name()
        .ok_or("Plugin package path has no filename.")?
        .to_os_string();
    name.push(".sha256");
    Ok(zip.with_file_name(name))
}

fn read_chosen_package(
    zip: &Path,
    is_allowed: impl Fn(&Path) -> bool,
) -> Result<LocalPluginPackage, String> {
    let sibling = sibling_checksum_path(zip)?;
    if !is_allowed(zip) {
        return Err("Plugin package path was not granted by the native file dialog.".into());
    }
    let directory = zip
        .parent()
        .ok_or("Plugin package path has no directory.")?
        .canonicalize()
        .map_err(|error| format!("Cannot resolve plugin package directory: {error}"))?;
    // Anchor both reads to the same resolved directory, including on Windows UNC/8.3 paths.
    let zip = directory.join(zip.file_name().ok_or("Plugin package has no filename.")?);
    let sibling = directory.join(sibling.file_name().ok_or("Checksum has no filename.")?);
    if !is_allowed(&zip) {
        return Err(
            "Resolved plugin package path was not granted by the native file dialog.".into(),
        );
    }
    let mut archive = open_same_directory_file(&directory, &zip, "Plugin package")?;
    let zip_bytes = read_bounded(&mut archive, MAX_ZIP_BYTES, "Plugin package")?;
    // Only absence at the exact sibling path is optional (ADR-0029 §4). A dangling symlink
    // still has metadata, and every error after observing an existing sibling fails closed.
    let sidecar = match fs::symlink_metadata(&sibling) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        _ => {
            let mut checksum =
                open_same_directory_file(&directory, &sibling, "Plugin package checksum")?;
            let text = String::from_utf8(read_bounded(
                &mut checksum,
                MAX_CHECKSUM_BYTES,
                "Plugin package checksum",
            )?)
            .map_err(|_| "Plugin package checksum is not UTF-8 text.".to_string())?;
            verify_checksum(&zip_bytes, &text, &zip)?;
            Some(text)
        }
    };
    Ok(LocalPluginPackage { zip_bytes, sidecar })
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Refuse all reparse points, including junctions, not just symbolic links.
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn open_same_directory_file(directory: &Path, path: &Path, label: &str) -> Result<File, String> {
    if path.parent() != Some(directory) {
        return Err(format!(
            "{label} must be in the chosen package's directory."
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "{label} is missing or unreadable at {}: {error}",
            path.display()
        )
    })?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(format!(
            "{label} must be a regular file, not a symlink or reparse point."
        ));
    }
    if path
        .canonicalize()
        .map_err(|error| error.to_string())?
        .parent()
        != Some(directory)
    {
        return Err(format!("{label} resolves outside its exact sibling path."));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // Also refuse a symlink swapped in between metadata inspection and opening the file.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Cannot open {label}: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(format!(
            "{label} must be a regular file, not a symlink or reparse point."
        ));
    }
    Ok(file)
}

fn read_bounded(file: &mut File, limit: u64, label: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read {label}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{label} exceeds the {limit}-byte limit."));
    }
    Ok(bytes)
}

fn verify_checksum(bytes: &[u8], sidecar: &str, zip: &Path) -> Result<(), String> {
    let line = sidecar.trim();
    let (digest, filename) = match line.find(char::is_whitespace) {
        Some(index) => (
            &line[..index],
            line[index..].trim_start().trim_start_matches('*'),
        ),
        None => (line, ""),
    };
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Plugin package checksum does not contain a SHA-256 digest.".into());
    }
    // Bare digests remain supported. If shasum names a file, require exactly the chosen basename;
    // paths (even another file in the same directory) and extra checksum lines are refused.
    if !filename.is_empty() && Some(filename) != zip.file_name().and_then(|name| name.to_str()) {
        return Err(
            "Plugin package checksum names a different file; expected the chosen ZIP basename."
                .into(),
        );
    }
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(digest) {
        return Err(format!(
            "Plugin package does not match its .sha256 checksum. Expected {digest}, got {actual}. Refusing to install it."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "chemdraft-plugin-package-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }

        fn zip(&self) -> PathBuf {
            self.0.join("mass-fragment-demo-0.0.0.zip")
        }

        fn package(&self) -> PathBuf {
            let zip = self.zip();
            fs::write(&zip, b"archive bytes").unwrap();
            fs::write(sibling_checksum_path(&zip).unwrap(), self.checksum()).unwrap();
            zip
        }

        fn checksum(&self) -> String {
            format!(
                "{:x}  mass-fragment-demo-0.0.0.zip\n",
                Sha256::digest(b"archive bytes")
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn derives_exact_sibling_using_host_path_rules() {
        let fixture = Fixture::new();
        assert_eq!(
            sibling_checksum_path(&fixture.zip()).unwrap(),
            fixture.0.join("mass-fragment-demo-0.0.0.zip.sha256")
        );
        for path in [
            Path::new("relative.zip").to_path_buf(),
            fixture.0.join("other.sha256"),
            fixture.0.join("../other.zip"),
        ] {
            assert!(sibling_checksum_path(&path).is_err());
        }
        let spaced = fixture.0.join("plugin with spaces.ZIP");
        assert_eq!(
            sibling_checksum_path(&spaced).unwrap(),
            fixture.0.join("plugin with spaces.ZIP.sha256")
        );
    }

    #[test]
    fn regression_reads_sibling_with_only_zip_granted() {
        let fixture = Fixture::new();
        let zip = fixture.package();
        // The reported Windows failure: the selected ZIP is granted, the sibling is not. Only the
        // ZIP is checked against the dialog scope, and no additional scope is requested or granted.
        let result = read_chosen_package(&zip, |path| path == zip).unwrap();
        assert_eq!(result.zip_bytes, b"archive bytes");
        assert_eq!(result.sidecar, Some(fixture.checksum()));
        let binary = result.into_binary();
        let checksum_length = u32::from_le_bytes(binary[..4].try_into().unwrap()) as usize;
        assert_eq!(checksum_length, fixture.checksum().len());
        assert_eq!(
            &binary[4..4 + checksum_length],
            fixture.checksum().as_bytes()
        );
        assert_eq!(&binary[4 + checksum_length..], b"archive bytes");
        assert!(read_chosen_package(&zip, |_| false)
            .unwrap_err()
            .contains("native file dialog"));
    }

    #[test]
    fn missing_checksum_is_optional_even_with_different_name_or_directory_available() {
        let fixture = Fixture::new();
        let zip = fixture.zip();
        fs::write(&zip, b"archive bytes").unwrap();
        fs::write(
            fixture.0.join("mass-fragment-demo-0.0.0.sha256"),
            fixture.checksum(),
        )
        .unwrap();
        fs::create_dir(fixture.0.join("elsewhere")).unwrap();
        fs::write(
            fixture
                .0
                .join("elsewhere/mass-fragment-demo-0.0.0.zip.sha256"),
            fixture.checksum(),
        )
        .unwrap();
        let package = read_chosen_package(&zip, |_| true).unwrap();
        assert!(package.sidecar.is_none());
        assert_eq!(package.zip_bytes, b"archive bytes");
        assert_eq!(
            package.into_binary(),
            [b"\0\0\0\0".as_slice(), b"archive bytes"].concat()
        );
        assert!(open_same_directory_file(
            &fixture.0,
            &fixture
                .0
                .join("elsewhere/mass-fragment-demo-0.0.0.zip.sha256"),
            "Checksum"
        )
        .unwrap_err()
        .contains("chosen package's directory"));
    }

    #[test]
    fn mismatched_digest_and_filename_are_refused() {
        let fixture = Fixture::new();
        let zip = fixture.package();
        fs::write(
            sibling_checksum_path(&zip).unwrap(),
            format!("{}  mass-fragment-demo-0.0.0.zip", "0".repeat(64)),
        )
        .unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("does not match its .sha256"));
        let digest = format!("{:x}", Sha256::digest(b"archive bytes"));
        for name in [
            "other.zip",
            "../mass-fragment-demo-0.0.0.zip",
            "elsewhere/mass-fragment-demo-0.0.0.zip",
        ] {
            fs::write(
                sibling_checksum_path(&zip).unwrap(),
                format!("{digest}  {name}\n"),
            )
            .unwrap();
            assert!(read_chosen_package(&zip, |_| true)
                .unwrap_err()
                .contains("names a different file"));
        }
        verify_checksum(b"archive bytes", &digest, &zip).unwrap();
        verify_checksum(
            b"archive bytes",
            &format!("{digest} *mass-fragment-demo-0.0.0.zip\r\n"),
            &zip,
        )
        .unwrap();
    }

    #[test]
    fn malformed_and_oversized_checksums_are_refused() {
        let fixture = Fixture::new();
        let zip = fixture.package();
        let sidecar = sibling_checksum_path(&zip).unwrap();
        fs::write(&sidecar, "not a digest").unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("SHA-256 digest"));
        fs::write(&sidecar, vec![b'a'; MAX_CHECKSUM_BYTES as usize + 1]).unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("byte limit"));
        fs::write(&sidecar, [0xff]).unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("UTF-8"));
    }

    #[test]
    fn checksum_directory_and_oversized_archive_are_refused() {
        let fixture = Fixture::new();
        let zip = fixture.package();
        let sidecar = sibling_checksum_path(&zip).unwrap();
        fs::remove_file(&sidecar).unwrap();
        fs::create_dir(&sidecar).unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("checksum must be a regular file"));
        fs::remove_dir(&sidecar).unwrap();
        File::create(&zip)
            .unwrap()
            .set_len(MAX_ZIP_BYTES + 1)
            .unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("Plugin package exceeds"));
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_checksum_is_not_treated_as_absent() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let zip = fixture.package();
        let sidecar = sibling_checksum_path(&zip).unwrap();
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o0)).unwrap();
        let result = read_chosen_package(&zip, |_| true);
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(result
            .unwrap_err()
            .contains("Cannot open Plugin package checksum"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn symlinked_archive_and_checksum_are_refused() {
        let fixture = Fixture::new();
        let zip = fixture.package();
        let sidecar = sibling_checksum_path(&zip).unwrap();
        let target = fixture.0.join("real-checksum");
        fs::rename(&sidecar, &target).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &sidecar).unwrap();
        #[cfg(windows)]
        {
            if let Err(error) = std::os::windows::fs::symlink_file(&target, &sidecar) {
                // Windows requires Developer Mode or SeCreateSymbolicLinkPrivilege. Fail for all
                // other errors; CI with that privilege exercises the real filesystem refusal.
                if error.raw_os_error() == Some(1314) {
                    eprintln!("Symlink fixture requires Windows Developer Mode: {error}");
                    return;
                }
                panic!("Cannot create checksum symlink fixture: {error}");
            }
        }
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("symlink or reparse point"));
        // A dangling symlink also exists and must not become the optional-missing case.
        fs::remove_file(&target).unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("symlink or reparse point"));
        fs::remove_file(&sidecar).unwrap();
        fs::write(&sidecar, fixture.checksum()).unwrap();
        let target = fixture.0.join("real-archive");
        fs::rename(&zip, &target).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &zip).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &zip).unwrap();
        assert!(read_chosen_package(&zip, |_| true)
            .unwrap_err()
            .contains("symlink or reparse point"));
    }

    #[test]
    fn command_has_main_window_only_permission_without_fs_scope_grant() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/document-dialogs.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("allow-read-plugin-package")));
        assert!(include_str!("../build.rs").contains("\"read_plugin_package\""));
        assert!(include_str!("lib.rs").contains("plugin_package::read_plugin_package,"));
        let permission = include_str!("../permissions/autogenerated/read_plugin_package.toml");
        assert!(permission.contains("commands.allow = [\"read_plugin_package\"]"));
    }
}
