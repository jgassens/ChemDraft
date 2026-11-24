use super::wire::Extension;
use std::{
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

pub(super) fn nonce() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) fn unsafe_name_char(ch: char) -> bool {
    ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
}

pub(super) fn reserved_name(name: &str) -> bool {
    let first = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_lowercase();
    matches!(
        first.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || first
        .strip_prefix("com")
        .or_else(|| first.strip_prefix("lpt"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

pub(super) fn safe_name(name: &str) -> String {
    let mut stem = String::new();
    for ch in name.chars().filter(|ch| !unsafe_name_char(*ch)) {
        if stem.len() + ch.len_utf8() > 250 {
            break;
        }
        stem.push(ch);
    }
    let stem = stem.trim_end_matches(['.', ' ']);
    if stem.is_empty() || reserved_name(stem) {
        "handoff".into()
    } else {
        stem.into()
    }
}

pub(super) fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(super) fn plain_path(root: &Path, relative: &Path, directory: bool) -> io::Result<PathBuf> {
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut path = root.to_owned();
    for component in relative.components() {
        path.push(component);
        if reparse(&fs::symlink_metadata(&path)?) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let metadata = fs::symlink_metadata(&path)?;
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(root)
        || !(if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        })
    {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(canonical)
}

pub(super) fn private_dir(path: &Path, recursive: bool) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

pub(super) fn safe_dir(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || reparse(&metadata) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    #[cfg(unix)]
    require_private_owner(&metadata)?;
    Ok(())
}

#[cfg(unix)]
pub(super) fn require_private_owner(metadata: &Metadata) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    // geteuid takes no pointers and has no failure mode.
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

pub(super) fn open_plain_file(path: &Path) -> io::Result<File> {
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
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || reparse(&metadata) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}

pub(super) fn create_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub(super) fn read_bounded(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    read_bounded_file(File::open(path)?, maximum)
}

pub(super) fn read_bounded_file(file: File, maximum: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(bytes)
}

pub(super) struct TempFiles {
    pub root: PathBuf,
    pub stem: String,
    keep: bool,
}

impl TempFiles {
    pub(super) fn new(cache: &Path, plugin_id: &str) -> io::Result<Self> {
        if !super::plugin_id_valid(plugin_id) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let handoff = cache.join("handoff");
        private_dir(&handoff, true)?;
        safe_dir(&handoff)?;
        let plugin_dir = handoff.join(plugin_id);
        private_dir(&plugin_dir, true)?;
        safe_dir(&plugin_dir)?;
        let random = nonce()?;
        let stem = format!("cdx_{}", nonce()?);
        let root = plugin_dir.canonicalize()?.join(&random);
        private_dir(&root, false)?;
        Ok(Self {
            root,
            stem,
            keep: false,
        })
    }

    pub(super) fn write(
        &self,
        name: &str,
        extension: Extension,
        text: &str,
    ) -> io::Result<PathBuf> {
        let path = self
            .root
            .join(format!("{}.{}", safe_name(name), extension.as_str()));
        create_file(&path)?.write_all(text.as_bytes())?;
        Ok(path)
    }

    pub(super) fn keep_for_open_app(&mut self) {
        self.keep = true;
    }
}

impl Drop for TempFiles {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

pub(super) fn clean(cache: &Path, now: SystemTime) {
    let root = cache.join("handoff");
    if safe_dir(&root).is_err() {
        return;
    }
    let Ok(plugins) = fs::read_dir(root) else {
        return;
    };
    for plugin in plugins.flatten() {
        if plugin
            .file_name()
            .to_str()
            .is_none_or(|id| !super::plugin_id_valid(id))
            || safe_dir(&plugin.path()).is_err()
        {
            continue;
        }
        let Ok(directories) = fs::read_dir(plugin.path()) else {
            continue;
        };
        for directory in directories.flatten() {
            let name = directory.file_name();
            if name.to_str().is_none_or(|name| {
                name.len() != 32 || !name.bytes().all(|ch| ch.is_ascii_hexdigit())
            }) {
                continue;
            }
            let path = directory.path();
            if let Ok(metadata) = fs::symlink_metadata(&path) {
                if !reparse(&metadata)
                    && metadata.is_dir()
                    && metadata
                        .modified()
                        .ok()
                        .and_then(|time| now.duration_since(time).ok())
                        .is_some_and(|age| age >= Duration::from_secs(86400))
                {
                    let _ = fs::remove_dir_all(&path);
                }
            }
        }
    }
}
