use serde::Serialize;
use std::{
    borrow::Cow,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::Manager;

const STABLE_IDENTIFIER: &str = "org.chemdraft.desktop";
const STABLE_MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/office-manifest.xml"));
const STABLE_ID: &str = "c2b05f5c-0724-4438-bff6-229da8041c57";
const DEV_ID: &str = "62b8cf76-1e9e-4826-a1b1-1ed9cbea128f";

struct Addin {
    filename: &'static str,
    id: &'static str,
    manifest: Cow<'static, str>,
}

impl Addin {
    fn for_build(identifier: &str, debug: bool, worktree_label: Option<&str>) -> Self {
        let branch_build =
            matches!(worktree_label, Some(label) if !label.is_empty() && label != "UNSIGNED");
        if identifier == STABLE_IDENTIFIER && !debug && !branch_build {
            Self {
                filename: "chemdraft-office-addin.xml",
                id: STABLE_ID,
                manifest: STABLE_MANIFEST.into(),
            }
        } else {
            Self {
                filename: "chemdraft-office-addin-dev.xml",
                id: DEV_ID,
                manifest: STABLE_MANIFEST
                    .replace(STABLE_ID, DEV_ID)
                    .replace(
                        "<DisplayName DefaultValue=\"Edit Structure\"",
                        "<DisplayName DefaultValue=\"ChemDraft (dev)\"",
                    )
                    .into(),
            }
        }
    }

    fn is_current(&self, installed: &str) -> bool {
        let version = env!("CARGO_PKG_VERSION").split(['-', '+']).next().unwrap();
        let source = concat!(
            "https://chemdraft.ai/office/",
            env!("CARGO_PKG_VERSION"),
            "/taskpane"
        );
        // The source URL also distinguishes prereleases with the same numeric Office version.
        installed.contains(&format!("<Id>{}</Id>", self.id))
            && installed.contains(&format!("<Version>{version}.0</Version>"))
            && installed.contains(&format!("<SourceLocation DefaultValue=\"{source}\""))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum OfficeApp {
    Word,
    PowerPoint,
}

impl OfficeApp {
    fn container(self) -> &'static str {
        match self {
            Self::Word => "com.microsoft.Word",
            Self::PowerPoint => "com.microsoft.Powerpoint",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    NotInstalled,
    InstalledSameVersion,
    InstalledOtherVersion,
    AppNotFound,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficeAddinResult {
    app: OfficeApp,
    status: Status,
    changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Copy)]
enum Action {
    Status,
    Install,
    Remove,
}

fn directory_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(format!("{} must be a directory.", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn container_path(home: &Path, app: OfficeApp) -> PathBuf {
    home.join("Library")
        .join("Containers")
        .join(app.container())
}

fn manifest_status(path: &Path, addin: &Addin) -> Result<Status, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            let installed = fs::read(path).map_err(|error| error.to_string())?;
            Ok(
                if std::str::from_utf8(&installed).is_ok_and(|xml| addin.is_current(xml)) {
                    Status::InstalledSameVersion
                } else {
                    Status::InstalledOtherVersion
                },
            )
        }
        Ok(_) => Err(format!("{} must be a regular file.", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Status::NotInstalled),
        Err(error) => Err(error.to_string()),
    }
}

fn apply_to_app(
    home: &Path,
    app: OfficeApp,
    addin: &Addin,
    action: Action,
) -> Result<(Status, bool), String> {
    let library = home.join("Library");
    let containers = library.join("Containers");
    let mut path = container_path(home, app);
    if !directory_exists(&library)? || !directory_exists(&containers)? || !directory_exists(&path)?
    {
        return Ok((Status::AppNotFound, false));
    }

    for component in ["Data", "Documents", "wef"] {
        path.push(component);
        if !directory_exists(&path)? {
            if !matches!(action, Action::Install) {
                return Ok((Status::NotInstalled, false));
            }
            fs::create_dir(&path).map_err(|error| error.to_string())?;
        }
    }

    path.push(addin.filename);
    let status = manifest_status(&path, addin)?;
    match (action, status) {
        (Action::Install, Status::NotInstalled | Status::InstalledOtherVersion) => {
            super::write_file_atomic_in_existing_dir(&path, &addin.manifest)?;
            Ok((Status::InstalledSameVersion, true))
        }
        (Action::Remove, Status::InstalledSameVersion | Status::InstalledOtherVersion) => {
            match fs::remove_file(&path) {
                Ok(()) => Ok((Status::NotInstalled, true)),
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    Ok((Status::NotInstalled, false))
                }
                Err(error) => Err(error.to_string()),
            }
        }
        _ => Ok((status, false)),
    }
}

fn apply(home: &Path, addin: &Addin, action: Action) -> [OfficeAddinResult; 2] {
    [OfficeApp::Word, OfficeApp::PowerPoint].map(|app| {
        match apply_to_app(home, app, addin, action) {
            Ok((status, changed)) => OfficeAddinResult {
                app,
                status,
                changed,
                error: None,
            },
            Err(error) => OfficeAddinResult {
                app,
                status: Status::Unavailable,
                changed: false,
                error: Some(error),
            },
        }
    })
}

fn run(window: &tauri::WebviewWindow, action: Action) -> Result<[OfficeAddinResult; 2], String> {
    if window.label() != super::MAIN_WINDOW_LABEL {
        return Err("Manage the Office add-in from the main document window.".to_owned());
    }
    let home = window
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?;
    let addin = Addin::for_build(
        &window.config().identifier,
        cfg!(debug_assertions),
        option_env!("CHEMDRAFT_WORKTREE_LABEL"),
    );
    Ok(apply(&home, &addin, action))
}

#[tauri::command]
pub(crate) fn office_addin_status(
    window: tauri::WebviewWindow,
) -> Result<[OfficeAddinResult; 2], String> {
    run(&window, Action::Status)
}

#[tauri::command]
pub(crate) fn office_addin_install(
    window: tauri::WebviewWindow,
) -> Result<[OfficeAddinResult; 2], String> {
    run(&window, Action::Install)
}

#[tauri::command]
pub(crate) fn office_addin_remove(
    window: tauri::WebviewWindow,
) -> Result<[OfficeAddinResult; 2], String> {
    run(&window, Action::Remove)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHome(PathBuf);

    impl TempHome {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "chemdraft-office-home-{}",
                crate::external_tools::nonce()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn command_permissions_are_only_granted_to_the_macos_document_window() {
        let office: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/office-addin.json")).unwrap();
        assert_eq!(office["platforms"], serde_json::json!(["macOS"]));
        assert_eq!(office["windows"], serde_json::json!(["main"]));
        assert_eq!(
            office["permissions"],
            serde_json::json!([
                "allow-office-addin-status",
                "allow-office-addin-install",
                "allow-office-addin-remove"
            ])
        );
        let capabilities = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        for entry in fs::read_dir(capabilities).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() != "office-addin.json" {
                assert!(!fs::read_to_string(entry.path())
                    .unwrap()
                    .contains("allow-office-addin-"));
            }
        }
    }

    #[test]
    fn stable_and_dev_use_separate_filenames_and_office_identities() {
        let stable = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let dev = Addin::for_build("org.chemdraft.desktop.dev", false, None);
        assert_eq!(stable.filename, "chemdraft-office-addin.xml");
        assert_eq!(dev.filename, "chemdraft-office-addin-dev.xml");
        assert!(stable.manifest.contains(STABLE_ID));
        assert!(dev.manifest.contains(DEV_ID));
        assert!(!dev.manifest.contains(STABLE_ID));
        assert!(dev
            .manifest
            .contains("<DisplayName DefaultValue=\"ChemDraft (dev)\""));
        assert!(dev
            .manifest
            .contains("<bt:String id=\"ChemDraft.Label\" DefaultValue=\"Edit Structure\""));
        assert_eq!(
            Addin::for_build(STABLE_IDENTIFIER, true, None).filename,
            dev.filename
        );
        assert_eq!(
            Addin::for_build(STABLE_IDENTIFIER, false, Some("worktree [branch]")).filename,
            dev.filename
        );
        assert_eq!(
            Addin::for_build(STABLE_IDENTIFIER, false, Some("UNSIGNED")).filename,
            stable.filename
        );
    }

    #[test]
    fn plans_both_office_container_paths_under_the_given_home() {
        let home = TempHome::new();
        for (app, container) in [
            (OfficeApp::Word, "com.microsoft.Word"),
            (OfficeApp::PowerPoint, "com.microsoft.Powerpoint"),
        ] {
            assert_eq!(
                container_path(&home.0, app),
                home.0.join("Library").join("Containers").join(container)
            );
        }
    }

    #[test]
    fn installs_and_removes_only_the_current_flavors_file() {
        let home = TempHome::new();
        let word = container_path(&home.0, OfficeApp::Word);
        let powerpoint = container_path(&home.0, OfficeApp::PowerPoint);
        let wef = word.join("Data").join("Documents").join("wef");
        fs::create_dir_all(wef.parent().unwrap()).unwrap();
        let stable = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let dev = Addin::for_build("org.chemdraft.desktop.dev", false, None);
        let statuses = |addin: &Addin, action| {
            apply(&home.0, addin, action).map(|entry| (entry.status, entry.changed))
        };
        let missing = (Status::AppNotFound, false);

        assert_eq!(
            statuses(&stable, Action::Status),
            [(Status::NotInstalled, false), missing]
        );
        assert_eq!(
            statuses(&stable, Action::Install),
            [(Status::InstalledSameVersion, true), missing]
        );
        assert_eq!(
            statuses(&stable, Action::Install),
            [(Status::InstalledSameVersion, false), missing]
        );
        assert!(!powerpoint.exists());
        fs::create_dir_all(&powerpoint).unwrap();
        let third_party = wef.join("another-addin.xml");
        fs::write(&third_party, "another add-in").unwrap();
        fs::write(
            wef.join(stable.filename),
            stable.manifest.replace("<Version>", "<Version>9"),
        )
        .unwrap();
        assert_eq!(
            statuses(&stable, Action::Status),
            [
                (Status::InstalledOtherVersion, false),
                (Status::NotInstalled, false)
            ]
        );
        assert_eq!(
            statuses(&stable, Action::Install),
            [(Status::InstalledSameVersion, true); 2]
        );
        assert_eq!(
            statuses(&dev, Action::Install),
            [(Status::InstalledSameVersion, true); 2]
        );
        assert_eq!(
            statuses(&dev, Action::Remove),
            [(Status::NotInstalled, true); 2]
        );
        assert_eq!(
            statuses(&stable, Action::Status),
            [(Status::InstalledSameVersion, false); 2]
        );
        assert_eq!(
            statuses(&stable, Action::Remove),
            [(Status::NotInstalled, true); 2]
        );
        assert_eq!(
            statuses(&stable, Action::Remove),
            [(Status::NotInstalled, false); 2]
        );
        assert_eq!(fs::read_to_string(&third_party).unwrap(), "another add-in");
        assert_eq!(fs::read_dir(wef).unwrap().count(), 1);
    }

    #[test]
    fn rejects_symlinks_and_reports_each_app_independently() {
        use std::os::unix::fs::symlink;

        let home = TempHome::new();
        let word = container_path(&home.0, OfficeApp::Word);
        let powerpoint = container_path(&home.0, OfficeApp::PowerPoint);
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        let outside = home.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let untouched = outside.join(addin.filename);
        fs::write(&untouched, "outside").unwrap();
        let word_documents = word.join("Data").join("Documents");
        fs::create_dir_all(&word_documents).unwrap();
        fs::create_dir_all(&powerpoint).unwrap();
        let wef = word_documents.join("wef");
        symlink(&outside, &wef).unwrap();
        let results = apply(&home.0, &addin, Action::Install);
        assert_eq!(results[0].status, Status::Unavailable);
        assert_eq!(results[1].status, Status::InstalledSameVersion);
        fs::remove_file(&wef).unwrap();
        fs::create_dir(&wef).unwrap();
        symlink(&untouched, wef.join(addin.filename)).unwrap();
        for action in [Action::Status, Action::Install, Action::Remove] {
            assert_eq!(
                apply(&home.0, &addin, action)[0].status,
                Status::Unavailable
            );
        }
        assert_eq!(fs::read_to_string(untouched).unwrap(), "outside");
    }

    #[test]
    fn embedded_manifest_matches_the_versioned_office_build() {
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
        let addin = Addin::for_build(STABLE_IDENTIFIER, false, Some(""));
        assert!(addin.is_current(STABLE_MANIFEST));
        assert!(!STABLE_MANIFEST.contains("{{"));
        let urls = STABLE_MANIFEST
            .split("DefaultValue=\"")
            .skip(1)
            .filter_map(|part| {
                let value = part.split('"').next()?;
                value.contains("://").then_some(value)
            })
            .collect::<Vec<_>>();
        assert_eq!(urls.len(), 8);
        let versioned_url = concat!(
            "https://chemdraft.ai/office/",
            env!("CARGO_PKG_VERSION"),
            "/"
        );
        assert!(urls
            .iter()
            .all(|url| url.starts_with(versioned_url) || *url == "https://chemdraft.ai/"));
        if let Some(built) = std::env::var_os("CHEMDRAFT_TEST_OFFICE_MANIFEST") {
            assert_eq!(fs::read_to_string(built).unwrap(), STABLE_MANIFEST);
        }
    }
}
