use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterComputer {
    platform: &'static str,
    architecture: &'static str,
    build_kind: &'static str,
    executable_path: PathBuf,
    bundle_path: Option<PathBuf>,
}

fn bundle_path(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension().is_some_and(|ext| ext == "app"))
    .then(|| bundle.to_path_buf())
}

#[tauri::command]
pub fn plugin_starter_computer(app: AppHandle) -> Result<StarterComputer, String> {
    let executable_path = std::env::current_exe().map_err(|error| error.to_string())?;
    let bundle_path = if cfg!(target_os = "macos") {
        bundle_path(&executable_path)
    } else {
        None
    };
    Ok(StarterComputer {
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        build_kind: if cfg!(debug_assertions) || app.config().identifier.ends_with(".dev") {
            "dev"
        } else {
            "stable"
        },
        executable_path,
        bundle_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundle_is_only_a_real_bundle_layout() {
        assert_eq!(
            bundle_path(Path::new(
                "/Applications/ChemDraft.app/Contents/MacOS/ChemDraft"
            )),
            Some(PathBuf::from("/Applications/ChemDraft.app"))
        );
        assert_eq!(bundle_path(Path::new("/tmp/chemdraft")), None);
        assert_eq!(
            bundle_path(Path::new("/tmp/nope/Contents/MacOS/chemdraft")),
            None
        );
    }

    #[test]
    fn capability_is_limited_to_main_window() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/plugin-starter.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-plugin-starter-computer"])
        );
    }
}
