//! Read a user-chosen local ZIP and exactly its adjacent `.sha256`, without extending webview scope.
//! The optional sibling and ZIP are read once; TypeScript checks SHA-256, CRC, manifest, API and handshake.

#[cfg(test)]
use std::fs;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read};
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
    read_chosen_package_with_open(zip, is_allowed, open_regular_file)
}

// Tests can swap an ancestor immediately before the OS open. All authority/identity checks must
// happen afterwards, against the handles, never against the caller's spelling of the path.
fn read_chosen_package_with_open(
    zip: &Path,
    is_allowed: impl Fn(&Path) -> bool,
    open: impl Fn(&Path) -> io::Result<File>,
) -> Result<LocalPluginPackage, String> {
    sibling_checksum_path(zip)?; // Preserve input extension/traversal refusals before opening.
    let mut archive = open(zip).map_err(|error| format!("Cannot open Plugin package: {error}"))?;
    let zip = opened_file_path(&archive, zip)
        .map_err(|error| format!("Cannot resolve opened Plugin package: {error}"))?;
    if !is_allowed(&zip) {
        return Err("Opened plugin package path was not granted by the native file dialog.".into());
    }
    // Use the opened handle's long basename, never a caller's case/8.3 alias. The sibling receives
    // no additional fs scope grant; only its exact final location beside this ZIP is permitted.
    let sibling = sibling_checksum_path(&zip)?;
    let zip_bytes = read_bounded(&mut archive, MAX_ZIP_BYTES, "Plugin package")?;
    let sidecar = match open(&sibling) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot open Plugin package checksum: {error}")),
        Ok(mut checksum) => {
            let final_sibling = opened_file_path(&checksum, &sibling).map_err(|error| {
                format!("Cannot resolve opened Plugin package checksum: {error}")
            })?;
            require_exact_sibling(&sibling, &final_sibling)?;
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

fn require_exact_sibling(expected: &Path, opened: &Path) -> Result<(), String> {
    if !same_path(expected.parent(), opened.parent())
        || !same_path(
            expected.file_name().map(Path::new),
            opened.file_name().map(Path::new),
        )
    {
        return Err("Plugin package checksum resolves outside its exact sibling path in the chosen package's directory.".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn same_path(left: Option<&Path>, right: Option<&Path>) -> bool {
    left == right
}

#[cfg(windows)]
fn same_path(left: Option<&Path>, right: Option<&Path>) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    let left: Vec<u16> = left.as_os_str().encode_wide().collect();
    let right: Vec<u16> = right.as_os_str().encode_wide().collect();
    let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
    else {
        return false;
    };
    // Windows ordinal casing, including non-ASCII names, without lossy UTF-16 conversion.
    unsafe {
        CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) == CSTR_EQUAL
    }
}

#[cfg(target_os = "macos")]
fn opened_file_path(file: &File, _input: &Path) -> io::Result<PathBuf> {
    use std::ffi::{CStr, OsString};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;
    let mut buffer = [0u8; libc::MAXPATHLEN as usize];
    // F_GETPATH resolves this descriptor, including the filesystem's actual filename casing.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let path = CStr::from_bytes_until_nul(&buffer)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(PathBuf::from(OsString::from_vec(path.to_bytes().to_vec())))
}

#[cfg(windows)]
fn opened_file_path(file: &File, _input: &Path) -> io::Result<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };
    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if (length as usize) < buffer.len() {
            return Ok(PathBuf::from(OsString::from_wide(
                &buffer[..length as usize],
            )));
        }
        buffer.resize(length as usize + 1, 0);
    }
}

// Linux CI only compiles the web surface. Preserve the path-based fallback on other targets;
// both shipping desktop platforms above resolve the opened handle.
#[cfg(not(any(target_os = "macos", windows)))]
fn opened_file_path(_file: &File, input: &Path) -> io::Result<PathBuf> {
    input.canonicalize()
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

fn open_regular_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .share_mode(FILE_SHARE_READ);
    }
    let file = options.open(path);
    #[cfg(unix)]
    let file = file.map_err(|error| {
        if error.raw_os_error() == Some(libc::ELOOP) {
            return regular_file_error();
        }
        error
    });
    let file = file?;
    let metadata = file.metadata()?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(regular_file_error());
    }
    Ok(file)
}

fn regular_file_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "must be a regular file, not a symlink or reparse point.",
    )
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

    #[cfg(any(target_os = "macos", windows))]
    fn link_directory(target: &Path, link: &Path) {
        #[cfg(target_os = "macos")]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            // Junctions do not need Developer Mode, unlike Windows symlinks.
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "Cannot create junction: {output:?}"
            );
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn parent_swapped_immediately_before_open_is_authorized_as_opened() {
        use std::cell::Cell;
        let fixture = Fixture::new();
        let picked = fixture.0.join("picked");
        let outside = fixture.0.join("unpicked");
        fs::create_dir(&picked).unwrap();
        fs::create_dir(&outside).unwrap();
        let zip = picked.join("plugin.zip");
        fs::write(&zip, b"picked bytes").unwrap();
        let unpicked_zip = outside.join("plugin.zip");
        fs::write(&unpicked_zip, b"unpicked bytes").unwrap();
        let authorized = Cell::new(false);
        // This hook is at the OS open boundary: under the previous ordering it runs after all
        // path/scope/canonicalization checks and the unpicked bytes would then be returned.
        let result = read_chosen_package_with_open(
            &zip,
            |path| {
                authorized.set(true);
                assert_eq!(path, unpicked_zip.canonicalize().unwrap());
                path == zip
            },
            |path| {
                assert!(!authorized.get(), "scope must be checked after open");
                fs::rename(&picked, fixture.0.join("original")).unwrap();
                link_directory(&outside, &picked);
                open_regular_file(path)
            },
        );
        assert!(result.unwrap_err().contains("native file dialog"));
        assert!(authorized.get());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parent_swapped_after_authorization_cannot_redirect_archive_bytes() {
        let fixture = Fixture::new();
        let picked = fixture.0.join("picked");
        let outside = fixture.0.join("unpicked");
        fs::create_dir(&picked).unwrap();
        fs::create_dir(&outside).unwrap();
        let zip = picked.join("plugin.zip");
        fs::write(&zip, b"picked bytes").unwrap();
        fs::write(outside.join("plugin.zip"), b"unpicked bytes").unwrap();
        let calls = std::cell::Cell::new(0);
        let package = read_chosen_package(&zip, |path| {
            calls.set(calls.get() + 1);
            assert_eq!(calls.get(), 1, "authorize the opened handle exactly once");
            assert_eq!(path, zip);
            fs::rename(&picked, fixture.0.join("original")).unwrap();
            link_directory(&outside, &picked);
            true
        })
        .unwrap();
        assert_eq!(package.zip_bytes, b"picked bytes");
        assert_eq!(calls.get(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sibling_parent_swapped_before_open_is_refused() {
        let fixture = Fixture::new();
        let picked = fixture.0.join("picked");
        let outside = fixture.0.join("unpicked");
        fs::create_dir(&picked).unwrap();
        fs::create_dir(&outside).unwrap();
        let zip = picked.join("plugin.zip");
        fs::write(&zip, b"picked bytes").unwrap();
        fs::write(outside.join("plugin.zip.sha256"), "not a digest").unwrap();
        let error = read_chosen_package_with_open(
            &zip,
            |path| path == zip,
            |path| {
                if path.extension().is_some_and(|ext| ext == "sha256") {
                    fs::rename(&picked, fixture.0.join("original")).unwrap();
                    link_directory(&outside, &picked);
                }
                open_regular_file(path)
            },
        )
        .unwrap_err();
        assert!(error.contains("exact sibling path"), "{error}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn alias_checks_the_real_basename_sibling() {
        let fixture = Fixture::new();
        let zip = fixture.0.join("LongPluginName.zip");
        fs::write(&zip, b"archive bytes").unwrap();
        let alias = fixture.0.join("longpluginname.ZIP");
        // On a case-sensitive volume exercise a symlinked ancestor instead.
        let alias = if alias.exists() {
            alias
        } else {
            let parent_alias = fixture.0.join("alias");
            link_directory(&fixture.0, &parent_alias);
            parent_alias.join("LongPluginName.zip")
        };
        assert_real_sibling_checked(&zip, &alias);
    }

    #[cfg(windows)]
    #[test]
    fn short_name_alias_checks_the_long_basename_sibling() {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
        let fixture = Fixture::new();
        let zip = fixture.0.join("LongPluginName.zip");
        fs::write(&zip, b"archive bytes").unwrap();
        let input: Vec<u16> = zip.as_os_str().encode_wide().chain(Some(0)).collect();
        let length = unsafe { GetShortPathNameW(input.as_ptr(), std::ptr::null_mut(), 0) };
        assert_ne!(
            length,
            0,
            "GetShortPathNameW: {}",
            io::Error::last_os_error()
        );
        let mut buffer = vec![0u16; length as usize];
        let length = unsafe { GetShortPathNameW(input.as_ptr(), buffer.as_mut_ptr(), length) };
        assert!(length > 0 && (length as usize) < buffer.len());
        let alias = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
        if same_path(
            alias.file_name().map(Path::new),
            zip.file_name().map(Path::new),
        ) {
            eprintln!(
                "SKIP 8.3 regression: this volume does not generate a short basename ({})",
                zip.display()
            );
            return;
        }
        assert_real_sibling_checked(&zip, &alias);
    }

    #[cfg(any(target_os = "macos", windows))]
    fn assert_real_sibling_checked(zip: &Path, alias: &Path) {
        let sibling = sibling_checksum_path(zip).unwrap();
        fs::write(&sibling, "not a digest").unwrap();
        let error =
            read_chosen_package(alias, |path| path == zip.canonicalize().unwrap()).unwrap_err();
        assert!(error.contains("SHA-256 digest"), "{error}");
        let checksum = format!(
            "{:x}  LongPluginName.zip\n",
            Sha256::digest(b"archive bytes")
        );
        fs::write(&sibling, &checksum).unwrap();
        let package =
            read_chosen_package(alias, |path| path == zip.canonicalize().unwrap()).unwrap();
        assert_eq!(package.sidecar.as_deref(), Some(checksum.as_str()));
        assert_eq!(package.zip_bytes, b"archive bytes");
    }

    #[test]
    fn exact_sibling_requires_both_parent_and_filename() {
        let fixture = Fixture::new();
        let expected = sibling_checksum_path(&fixture.zip()).unwrap();
        require_exact_sibling(&expected, &expected).unwrap();
        assert!(require_exact_sibling(&expected, &fixture.0.join("other.zip.sha256")).is_err());
        assert!(require_exact_sibling(
            &expected,
            &fixture.0.join("other").join(expected.file_name().unwrap())
        )
        .is_err());
        let upper = PathBuf::from(expected.as_os_str().to_str().unwrap().to_uppercase());
        #[cfg(windows)]
        require_exact_sibling(&expected, &upper).unwrap();
        #[cfg(not(windows))]
        assert!(require_exact_sibling(&expected, &upper).is_err());
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
        assert!(require_exact_sibling(
            &sibling_checksum_path(&zip).unwrap(),
            &fixture
                .0
                .join("elsewhere/mass-fragment-demo-0.0.0.zip.sha256"),
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
            .contains("must be a regular file"));
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
