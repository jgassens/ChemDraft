use super::{
    identity::{App, ExecutableIdentity, Identity},
    temp_files,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const CONSENT_TEXT_VERSION: u32 = 1;
const SCHEMA_VERSION: u32 = 2;
const MAX_CONSENT_BYTES: usize = 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Row {
    pub plugin_id: String,
    pub app_id: String,
    pub app_path: PathBuf,
    pub app_identity: Identity,
    pub template_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    handoff_install_id: Option<String>,
    consent_text_version: u32,
    pub granted: bool,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    picked_companion: Option<ExecutableIdentity>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

impl Row {
    fn ungranted(
        plugin_id: &str,
        app_id: String,
        app_path: PathBuf,
        mut app_identity: Identity,
        pipeline: Option<&str>,
    ) -> Self {
        app_identity.companion = None;
        Self {
            plugin_id: plugin_id.into(),
            app_id,
            app_path,
            app_identity,
            template_digest: String::new(),
            handoff_install_id: None,
            consent_text_version: CONSENT_TEXT_VERSION,
            granted: false,
            at: timestamp(),
            pipeline: pipeline.map(str::to_owned),
            revision: None,
            picked_companion: None,
            extra: BTreeMap::new(),
        }
    }

    pub(super) fn consent_id(&self) -> String {
        use sha2::{Digest, Sha256};
        // The random picker ID stays private. The manager gets a one-way, revocation-only reference.
        let scope = serde_json::to_vec(&(&self.plugin_id, &self.app_id, &self.pipeline))
            .expect("consent scope is serializable");
        format!("consent-{:x}", Sha256::digest(scope))
    }

    pub(super) fn grants(
        &self,
        app: &App,
        pipeline: Option<&str>,
        digest: &str,
        install_id: &str,
    ) -> bool {
        self.granted
            && self.pipeline.as_deref() == pipeline
            && app.identity.companion.is_some() == pipeline.is_some()
            && self.belongs_to_install(install_id)
            && self.app_path == app.path
            && self.app_identity.matches(&app.identity)
            && self.consent_text_version == CONSENT_TEXT_VERSION
            && self.template_digest == digest
    }

    pub(super) fn belongs_to_install(&self, install_id: &str) -> bool {
        self.handoff_install_id.as_deref() == Some(install_id)
    }

    pub(super) fn accepts_companion(&self, app: &App, digest: &str) -> bool {
        self.app_identity.companion.is_none()
            || self.template_digest != digest
            || self.app_identity.matches(&app.identity)
            || self
                .picked_companion
                .as_ref()
                .zip(app.identity.companion.as_ref())
                .is_some_and(|(picked, current)| picked.matches(current))
    }

    fn approve(&mut self, app: &App, digest: String, install_id: &str) -> io::Result<()> {
        if self.app_path != app.path
            || !self.app_identity.main_matches(&app.identity)
            || self.pipeline.is_some() != app.identity.companion.is_some()
            || !self.accepts_companion(app, &digest)
            || digest.is_empty()
        {
            return Err(io::Error::other("App handoff consent scope changed."));
        }
        self.app_identity.update_from(&app.identity);
        self.template_digest = digest;
        self.handoff_install_id = Some(install_id.into());
        self.consent_text_version = CONSENT_TEXT_VERSION;
        self.granted = true;
        self.at = timestamp();
        self.picked_companion = None;
        self.revision = Some(temp_files::nonce()?);
        Ok(())
    }

    pub(super) fn same_grant(&self, other: &Self) -> bool {
        self.plugin_id == other.plugin_id
            && self.app_id == other.app_id
            && self.app_path == other.app_path
            && self.app_identity.matches(&other.app_identity)
            && self.template_digest == other.template_digest
            && self.handoff_install_id == other.handoff_install_id
            && self.consent_text_version == other.consent_text_version
            && self.granted == other.granted
            && self.at == other.at
            && self.pipeline == other.pipeline
            && self.revision == other.revision
    }

    fn for_operation(&self, pipeline: Option<&str>) -> Self {
        Self::ungranted(
            &self.plugin_id,
            self.app_id.clone(),
            self.app_path.clone(),
            self.app_identity.clone(),
            pipeline,
        )
    }
}

pub(super) struct Entry {
    pub row: Row,
    persisted: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    schema_version: u32,
    rows: Vec<Row>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

impl Document {
    fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            rows: Vec::new(),
            extra: BTreeMap::new(),
        }
    }

    fn validate(&self) -> io::Result<()> {
        if !matches!(self.schema_version, 1 | SCHEMA_VERSION) {
            return Err(io::Error::other(
                "Unknown app handoff consent schema version.",
            ));
        }
        let mut apps = BTreeMap::<_, &Row>::new();
        let mut operations = BTreeSet::new();
        for row in &self.rows {
            let app = (&row.plugin_id, &row.app_id);
            let first = apps.entry(app).or_insert(row);
            let pipeline = if self.schema_version == 1 {
                None
            } else {
                row.pipeline.as_deref()
            };
            if first.app_path != row.app_path
                || !first.app_identity.main_matches(&row.app_identity)
                || !operations.insert((app, pipeline))
            {
                return Err(io::Error::other("Conflicting app handoff consent rows."));
            }
        }
        Ok(())
    }
}

pub(super) struct Store(PathBuf);

impl Store {
    pub(super) fn new(app_local_data_dir: &Path) -> Self {
        Self(app_local_data_dir.join("app-handoff").join("consents.json"))
    }

    pub(super) fn list(&self) -> io::Result<Vec<Row>> {
        let _lock = LOCK.lock().unwrap();
        Ok(self
            .read()?
            .rows
            .into_iter()
            .filter(|row| !row.template_digest.is_empty())
            .collect())
    }

    pub(super) fn for_app(&self, plugin: &str, app: &str) -> io::Result<Vec<Row>> {
        let _lock = LOCK.lock().unwrap();
        Ok(self
            .read()?
            .rows
            .into_iter()
            .filter(|row| row.plugin_id == plugin && row.app_id == app)
            .collect())
    }

    pub(super) fn get(
        &self,
        plugin: &str,
        app: &str,
        pipeline: Option<&str>,
    ) -> io::Result<Option<Entry>> {
        let rows = self.for_app(plugin, app)?;
        Ok(rows
            .iter()
            .find(|row| row.pipeline.as_deref() == pipeline)
            .map(|row| Entry {
                row: row.clone(),
                persisted: true,
            })
            .or_else(|| {
                rows.first().map(|row| Entry {
                    row: row.for_operation(pipeline),
                    persisted: false,
                })
            }))
    }

    /// Order the grant check and launch against revocations and other consent writes.
    pub(super) fn with_grant<T>(
        &self,
        expected: &Row,
        launch: impl FnOnce(&Row) -> T,
    ) -> io::Result<Option<T>> {
        let _lock = LOCK.lock().unwrap();
        let document = self.read()?;
        Ok(document
            .rows
            .iter()
            .find(|row| row.granted && row.same_grant(expected))
            .map(launch))
    }

    pub(super) fn pick(
        &self,
        plugin: &str,
        app: App,
        mut read_companion: impl FnMut(&Row) -> Option<ExecutableIdentity>,
    ) -> io::Result<String> {
        let _lock = LOCK.lock().unwrap();
        let mut document = self.read()?;
        // Legacy stores can already have aliases after a companion change. Reuse the first
        // matching ID so later grants cannot change which ID a re-pick returns.
        let existing = document.rows.iter().find(|row| {
            row.plugin_id == plugin
                && row.app_path == app.path
                && row.app_identity.main_matches(&app.identity)
        });
        if let Some(id) = existing.map(|row| row.app_id.clone()) {
            let mut changed = false;
            for row in document
                .rows
                .iter_mut()
                .filter(|row| row.plugin_id == plugin && row.app_id == id)
            {
                let Some(approved) = &row.app_identity.companion else {
                    continue;
                };
                let picked = read_companion(row).filter(|current| !approved.matches(current));
                let same = match (&row.picked_companion, &picked) {
                    (Some(previous), Some(current)) => previous.matches(current),
                    (None, None) => true,
                    _ => false,
                };
                if !same {
                    // This only lets the new companion reach a fresh consent prompt.
                    row.picked_companion = picked;
                    row.revision = Some(temp_files::nonce()?);
                    changed = true;
                }
            }
            if changed {
                self.write(document)?;
            }
            return Ok(id);
        }
        let id = temp_files::nonce()?;
        document.rows.push(Row::ungranted(
            plugin,
            id.clone(),
            app.path,
            app.identity,
            None,
        ));
        self.write(document)?;
        Ok(id)
    }

    #[cfg(test)]
    pub(super) fn insert(&self, row: Row) -> io::Result<()> {
        self.update(|rows| {
            rows.push(row);
            Ok(())
        })
    }

    pub(super) fn replace(
        &self,
        before: &Entry,
        app: &App,
        digest: String,
        install_id: &str,
    ) -> io::Result<Row> {
        self.update(|rows| {
            let scope = &before.row;
            let same_app =
                |row: &Row| row.plugin_id == scope.plugin_id && row.app_id == scope.app_id;
            let current = rows
                .iter()
                .position(|row| same_app(row) && row.pipeline == scope.pipeline);
            match current {
                Some(index) if before.persisted && rows[index].same_grant(scope) => {
                    let row = &mut rows[index];
                    row.approve(app, digest, install_id)?;
                    Ok(row.clone())
                }
                None if !before.persisted && rows.iter().any(same_app) => {
                    let mut row = scope.clone();
                    row.approve(app, digest, install_id)?;
                    rows.push(row.clone());
                    Ok(row)
                }
                _ => Err(io::Error::other(
                    "App handoff consent changed while it was open.",
                )),
            }
        })
    }

    pub(super) fn revoke(&self, plugin: &str, consent_id: &str) -> io::Result<()> {
        self.update(|rows| {
            let row = rows
                .iter_mut()
                .find(|row| {
                    row.plugin_id == plugin
                        && !row.template_digest.is_empty()
                        && row.consent_id() == consent_id
                })
                .ok_or(io::ErrorKind::NotFound)?;
            row.granted = false;
            row.at = timestamp();
            row.revision = Some(temp_files::nonce()?);
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
        let dir = self.0.parent().expect("consent directory");
        match temp_files::safe_dir(dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Document::empty());
            }
            Err(error) => return Err(error),
        }
        let file = match temp_files::open_plain_file(&self.0) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Document::empty());
            }
            Err(error) => return Err(error),
        };
        #[cfg(unix)]
        temp_files::require_private_owner(&file.metadata()?)?;
        #[cfg(windows)]
        require_owner_only_acl(&file)?;
        let bytes = temp_files::read_bounded_file(file, MAX_CONSENT_BYTES)?;
        let document: Document = serde_json::from_slice(&bytes)?;
        document.validate()?;
        Ok(document)
    }

    fn update<T>(&self, change: impl FnOnce(&mut Vec<Row>) -> io::Result<T>) -> io::Result<T> {
        let _lock = LOCK.lock().unwrap();
        let mut document = self.read()?;
        let changed = change(&mut document.rows)?;
        self.write(document)?;
        Ok(changed)
    }

    fn write(&self, mut document: Document) -> io::Result<()> {
        // The v1 reader refuses this version before it can use rows keyed only by app.
        document.schema_version = SCHEMA_VERSION;
        document.validate()?;
        let bytes = serde_json::to_vec(&document)?;
        if bytes.len() >= MAX_CONSENT_BYTES {
            return Err(io::Error::other(
                "App handoff consent exceeds the 1 MiB store limit.",
            ));
        }
        let dir = self.0.parent().expect("consent directory");
        temp_files::private_dir(dir, true)?;
        temp_files::safe_dir(dir)?;
        let dir = dir.canonicalize()?;
        let temp = dir.join(format!("consents-{}.tmp", temp_files::nonce()?));
        let result = (|| {
            let mut file = create_private(&temp)?;
            file.write_all(&bytes)?;
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
const OWNER_ONLY_DACL: &str = "D:P(A;;FA;;;OW)";

#[cfg(windows)]
fn require_owner_only_acl(file: &fs::File) -> io::Result<()> {
    use std::{os::windows::io::AsRawHandle, ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
                SE_FILE_OBJECT,
            },
            DACL_SECURITY_INFORMATION,
        },
    };
    let mut descriptor = ptr::null_mut();
    // Inspect the handle we will read, keeping the policy identical to creation.
    unsafe {
        let status = GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let mut sddl = ptr::null_mut();
        let mut len = 0;
        let converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            1,
            DACL_SECURITY_INFORMATION,
            &mut sddl,
            &mut len,
        );
        let result = if converted == 0 {
            Err(io::Error::last_os_error())
        } else {
            let acl = slice::from_raw_parts(sddl, len as usize);
            let acl = acl.strip_suffix(&[0]).unwrap_or(acl);
            if acl.iter().copied().eq(OWNER_ONLY_DACL.encode_utf16()) {
                Ok(())
            } else {
                Err(io::ErrorKind::PermissionDenied.into())
            }
        };
        LocalFree(sddl.cast());
        LocalFree(descriptor.cast());
        result
    }
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
    let sddl: Vec<u16> = OWNER_ONLY_DACL.encode_utf16().chain(Some(0)).collect();
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
