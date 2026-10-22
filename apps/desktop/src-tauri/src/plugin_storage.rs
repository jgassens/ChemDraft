//! Shared plugin storage authority for every document webview.
use std::path::Path;
use std::sync::Mutex;

const MAX_BYTES: usize = 5 * 1024 * 1024;
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn read(path: &Path) -> Result<Option<String>, String> {
    let _guard = STORAGE_LOCK.lock().map_err(|error| error.to_string())?;
    super::read_optional_file(path)
}

/// None deletes a key; Some("null") stores JSON null. Keep the existing object-on-disk format.
/// Read/modify/replace is one critical section, including across different webview invoke queues.
pub(crate) fn mutate(path: &Path, key: String, value_json: Option<&str>) -> Result<(), String> {
    let value = value_json
        .map(|json| {
            if json.len() > MAX_BYTES {
                return Err(format!("Plugin storage payload exceeds {MAX_BYTES} bytes."));
            }
            serde_json::from_str::<serde_json::Value>(json).map_err(|error| error.to_string())
        })
        .transpose()?;
    let _guard = STORAGE_LOCK.lock().map_err(|error| error.to_string())?;
    // Unreadable is an error, never permission to replace an unknown existing file.
    let contents = super::read_optional_file(path)?;
    // The frontend reports corrupt JSON before requesting repair. Preserve the prior repair
    // behavior, while ensuring a fresh read here cannot overwrite another window's valid keys.
    let mut values = contents
        .as_deref()
        .and_then(|json| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json).ok()
        })
        .unwrap_or_default();
    if let Some(value) = value {
        values.insert(key, value);
    } else {
        values.remove(&key);
    }
    let contents = serde_json::to_string(&values).map_err(|error| error.to_string())?;
    if contents.len() > MAX_BYTES {
        return Err(format!("Plugin storage payload exceeds {MAX_BYTES} bytes."));
    }
    super::write_file_atomic(path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn path() -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "chemdraft-plugin-storage-{}-{}.json",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn concurrent_key_updates_preserve_every_window_and_existing_data() {
        let path = path();
        std::fs::write(&path, r#"{"existing":true}"#).unwrap();
        let threads: Vec<_> = (0..12)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    mutate(&path, format!("window-{index}"), Some(&index.to_string())).unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let value: serde_json::Value =
            serde_json::from_str(&read(&path).unwrap().unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 13);
        assert_eq!(value["existing"], true);
        for index in 0..12 {
            assert_eq!(value[format!("window-{index}")], index);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn delete_and_null_are_distinct_and_do_not_replace_other_keys() {
        let path = path();
        mutate(&path, "keep".into(), Some("1")).unwrap();
        mutate(&path, "remove".into(), Some("null")).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&read(&path).unwrap().unwrap()).unwrap();
        assert!(value.get("remove").unwrap().is_null());
        mutate(&path, "remove".into(), None).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&read(&path).unwrap().unwrap()).unwrap();
        assert!(value.get("remove").is_none());
        assert_eq!(value["keep"], 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn failed_read_or_invalid_value_never_replaces_existing_data() {
        let path = path();
        std::fs::create_dir(&path).unwrap();
        assert!(mutate(&path, "key".into(), Some("1")).is_err());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, r#"{"keep":1}"#).unwrap();
        assert!(mutate(&path, "key".into(), Some("invalid")).is_err());
        assert_eq!(read(&path).unwrap().unwrap(), r#"{"keep":1}"#);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn oversized_combined_map_is_refused_without_losing_existing_keys() {
        let path = path();
        mutate(&path, "keep".into(), Some("1")).unwrap();
        let value = serde_json::to_string(&"x".repeat(MAX_BYTES - 5)).unwrap();
        assert!(mutate(&path, "large".into(), Some(&value)).is_err());
        assert_eq!(read(&path).unwrap().unwrap(), r#"{"keep":1}"#);
        std::fs::remove_file(path).unwrap();
    }
}
