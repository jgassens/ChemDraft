use super::{
    identity::{App, Identity},
    temp_files,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const CONSENT_TEXT_VERSION: u32 = 1;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Row {
    pub plugin_id: String,
    pub app_id: String,
    pub app_path: PathBuf,
    pub app_identity: Identity,
    pub template_digest: String,
    consent_text_version: u32,
    pub granted: bool,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

impl Row {
    pub(super) fn picked(plugin_id: &str, app_id: String, app: App) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            app_id,
            app_path: app.path,
            app_identity: app.identity,
            template_digest: String::new(),
            consent_text_version: CONSENT_TEXT_VERSION,
            granted: false,
            at: timestamp(),
            pipeline: None,
            extra: BTreeMap::new(),
        }
    }

    pub(super) fn grants(&self, app: &App, digest: &str) -> bool {
        self.granted
            && self.app_path == app.path
            && self.app_identity.matches(&app.identity)
            && self.consent_text_version == CONSENT_TEXT_VERSION
            && self.template_digest == digest
    }

    pub(super) fn approve(&mut self, app: &App, pipeline: Option<String>, digest: String) {
        self.app_identity = app.identity.clone();
        self.pipeline = pipeline;
        self.template_digest = digest;
        self.consent_text_version = CONSENT_TEXT_VERSION;
        self.granted = true;
        self.at = timestamp();
    }

    pub(super) fn same_grant(&self, other: &Self) -> bool {
        self.plugin_id == other.plugin_id
            && self.app_id == other.app_id
            && self.app_path == other.app_path
            && self.app_identity.matches(&other.app_identity)
            && self.template_digest == other.template_digest
            && self.consent_text_version == other.consent_text_version
            && self.granted == other.granted
            && self.at == other.at
            && self.pipeline == other.pipeline
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    schema_version: u32,
    rows: Vec<Row>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

pub(super) struct Store(PathBuf);

impl Store {
    pub(super) fn new(app_local_data_dir: &Path) -> Self {
        Self(app_local_data_dir.join("app-handoff").join("consents.json"))
    }

    pub(super) fn list(&self) -> io::Result<Vec<Row>> {
        let _lock = LOCK.lock().unwrap();
        Ok(self.read()?.rows)
    }

    pub(super) fn get(&self, plugin: &str, app: &str) -> io::Result<Option<Row>> {
        Ok(self
            .list()?
            .into_iter()
            .find(|row| row.plugin_id == plugin && row.app_id == app))
    }

    pub(super) fn insert(&self, row: Row) -> io::Result<()> {
        self.update(|rows| {
            rows.push(row);
            Ok(())
        })
    }

    pub(super) fn replace(&self, before: &Row, next: Row) -> io::Result<()> {
        self.update(|rows| {
            let row = rows
                .iter_mut()
                .find(|row| row.same_grant(before))
                .ok_or_else(|| {
                    io::Error::other("App handoff consent changed while it was open.")
                })?;
            *row = next;
            Ok(())
        })
    }

    pub(super) fn revoke(&self, plugin: &str, app: &str) -> io::Result<()> {
        self.update(|rows| {
            let row = rows
                .iter_mut()
                .find(|row| row.plugin_id == plugin && row.app_id == app)
                .ok_or(io::ErrorKind::NotFound)?;
            row.granted = false;
            row.at = timestamp();
            Ok(())
        })
    }

    pub(super) fn clear(&self, plugin: &str) -> io::Result<()> {
        self.update(|rows| {
            rows.retain(|row| row.plugin_id != plugin);
            Ok(())
        })
    }

    fn read(&self) -> io::Result<Document> {
        if let Ok(metadata) = fs::symlink_metadata(&self.0) {
            if !metadata.is_file() || temp_files::reparse(&metadata) {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
        }
        let bytes = match temp_files::read_bounded(&self.0, 1024 * 1024) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Document {
                    schema_version: 1,
                    rows: Vec::new(),
                    extra: BTreeMap::new(),
                })
            }
            Err(error) => return Err(error),
        };
        let document: Document = serde_json::from_slice(&bytes)?;
        if document.schema_version != 1 {
            return Err(io::Error::other(
                "Unknown app handoff consent schema version.",
            ));
        }
        Ok(document)
    }

    fn update(&self, change: impl FnOnce(&mut Vec<Row>) -> io::Result<()>) -> io::Result<()> {
        let _lock = LOCK.lock().unwrap();
        let mut document = self.read()?;
        change(&mut document.rows)?;
        let dir = self.0.parent().expect("consent directory");
        temp_files::private_dir(dir, true)?;
        temp_files::safe_dir(dir)?;
        let dir = dir.canonicalize()?;
        let temp = dir.join(format!("consents-{}.tmp", temp_files::nonce()?));
        let result = (|| {
            let mut file = create_private(&temp)?;
            serde_json::to_writer(&mut file, &document)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &self.0)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(not(windows))]
fn create_private(path: &Path) -> io::Result<fs::File> {
    temp_files::create_file(path)
}

#[cfg(windows)]
fn create_private(path: &Path) -> io::Result<fs::File> {
    use std::{
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{LocalFree, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE},
    };
    // A protected DACL with a single Owner Rights ACE, applied at creation so no file contents
    // can be observed during an interval with the parent's inherited permissions.
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.cast(),
            bInheritHandle: 0,
        };
        let handle = CreateFileW(
            path.as_ptr(),
            FILE_GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        );
        let result = if handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(fs::File::from_raw_handle(handle))
        };
        LocalFree(descriptor.cast());
        result
    }
}
