//! Persistent per-tool, per-plugin consent, with atomic replacement and private file permissions.
use super::catalog::ToolId;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consent {
    pub tool: ToolId,
    pub plugin_id: String,
    pub granted: bool,
    pub at: String,
}
// Commands construct stores independently. Protect the whole read-modify-write
// transaction across every instance, including callers outside the Tauri state.
static STORE_LOCK: Mutex<()> = Mutex::new(());
pub struct ConsentStore {
    path: PathBuf,
}
impl ConsentStore {
    pub fn new(base: &Path) -> Self {
        Self {
            path: base.join("consents.json"),
        }
    }
    fn read(&self) -> io::Result<Vec<Consent>> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Consent file exceeds 1 MiB.",
            ));
        }
        serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
    pub fn get(&self, tool: ToolId, plugin_id: &str) -> io::Result<bool> {
        let _guard = STORE_LOCK.lock().unwrap();
        Ok(self
            .read()?
            .iter()
            .any(|c| c.tool == tool && c.plugin_id == plugin_id && c.granted))
    }
    pub fn list(&self) -> io::Result<Vec<Consent>> {
        let _guard = STORE_LOCK.lock().unwrap();
        self.read()
    }
    pub fn set(&self, tool: ToolId, plugin_id: &str, granted: bool) -> io::Result<()> {
        if !super::valid_plugin_id(plugin_id) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let _guard = STORE_LOCK.lock().unwrap();
        let mut entries = self.read()?;
        entries.retain(|c| c.tool != tool || c.plugin_id != plugin_id);
        entries.push(Consent {
            tool,
            plugin_id: plugin_id.into(),
            granted,
            at: chrono::Utc::now().to_rfc3339(),
        });
        self.write(&entries)
    }
    pub fn revoke(&self, tool: ToolId, plugin_id: &str) -> io::Result<()> {
        self.set(tool, plugin_id, false)
    }
    pub fn clear_for_plugin(&self, plugin_id: &str) -> io::Result<()> {
        if !super::valid_plugin_id(plugin_id) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let _guard = STORE_LOCK.lock().unwrap();
        let mut entries = self.read()?;
        entries.retain(|c| c.plugin_id != plugin_id);
        self.write(&entries)
    }
    fn write(&self, entries: &[Consent]) -> io::Result<()> {
        let base = self.path.parent().expect("consent parent");
        super::private_dir(base)?;
        let temp = base.join(format!("consents-{}.tmp", super::nonce()));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            serde_json::to_writer(&mut file, entries)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
}
