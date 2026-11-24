use super::{command_line::Pipeline, temp_files};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(super) const OFFICIAL_COMPANION_PLUGINS: &[(&str, &str)] = &[(
    "org.chemdraft.handoff.crystalBuilder",
    "jgassens/ChemDraft-CrystalBuilder-Plugin",
)];

pub(super) fn is_development_build(identifier: &str) -> bool {
    identifier == "org.chemdraft.desktop.dev"
}

#[derive(Deserialize)]
struct Catalog {
    version: u32,
    plugins: Vec<Installed>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    id: String,
    version: String,
    staged_path: String,
    source_checksum: String,
    source: Option<String>,
    repository: Option<String>,
    #[serde(default)]
    checksum_verified: bool,
}

#[derive(Deserialize)]
pub(super) struct Manifest {
    id: String,
    version: String,
    pub name: String,
    permissions: Vec<String>,
    #[serde(default)]
    contributes: Contributions,
    #[serde(default)]
    companions: Vec<Pipeline>,
}

#[derive(Default, Deserialize)]
struct Contributions {
    #[serde(default)]
    commands: Vec<Command>,
    #[serde(default)]
    menus: Vec<Menu>,
}

#[derive(Deserialize)]
struct Command {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Menu {
    command_id: String,
}

pub(super) struct Plugin {
    pub manifest: Manifest,
    developer_sideload: bool,
}

impl Plugin {
    pub(super) fn read(app: &AppHandle, id: &str) -> Result<Self, String> {
        let base = app
            .path()
            .app_data_dir()
            .map_err(|_| "ChemDraft's installed plugin catalog is unavailable.")?;
        load(&base, id, is_development_build(&app.config().identifier))
    }

    pub(super) fn consent_note(&self) -> &'static str {
        if self.developer_sideload {
            "\n\nThis hand-installed package is accepted only because this is a ChemDraft development build."
        } else {
            ""
        }
    }

    pub(super) fn owns_menu_command(&self, id: &str) -> bool {
        id.starts_with("plugin.")
            && self
                .manifest
                .contributes
                .commands
                .iter()
                .any(|command| command.id == id)
            && self
                .manifest
                .contributes
                .menus
                .iter()
                .any(|menu| menu.command_id == id)
    }

    pub(super) fn pipeline(&self, id: &str) -> Result<Pipeline, String> {
        let mut matches = self
            .manifest
            .companions
            .iter()
            .filter(|pipeline| pipeline.id == id);
        let pipeline = matches
            .next()
            .ok_or("The installed plugin does not declare that companion pipeline.")?;
        if matches.next().is_some() {
            return Err("The installed plugin declares the companion pipeline twice.".into());
        }
        pipeline.validate()?;
        Ok(pipeline.clone())
    }
}

pub(super) fn load(base: &Path, id: &str, developer: bool) -> Result<Plugin, String> {
    let repository = OFFICIAL_COMPANION_PLUGINS
        .iter()
        .find(|(plugin, _)| *plugin == id)
        .map(|(_, repository)| *repository)
        .ok_or("This plugin is outside the official app handoff catalog.")?;
    let read = |name: &Path| {
        temp_files::read_bounded(name, 1024 * 1024)
            .map_err(|_| "ChemDraft could not read the installed app handoff plugin.")
    };
    let catalog: Catalog = serde_json::from_slice(&read(&base.join("installed-plugins.json"))?)
        .map_err(|_| "The installed plugin catalog is invalid.")?;
    if catalog.version != 1 {
        return Err("The installed plugin catalog version is unsupported.".into());
    }
    let mut entries = catalog.plugins.iter().filter(|plugin| plugin.id == id);
    let record = entries
        .next()
        .ok_or("The app handoff plugin is no longer installed.")?;
    if entries.next().is_some() {
        return Err("The app handoff plugin has duplicate install records.".into());
    }
    let checksum_valid = record.source_checksum.len() == 64
        && record
            .source_checksum
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch));
    let verified = record.source.as_deref() == Some("catalog")
        && record.repository.as_deref() == Some(repository)
        && record.checksum_verified
        && checksum_valid;
    let sideload = developer && matches!(record.source.as_deref(), None | Some("sideload"));
    if !(verified || sideload) {
        return Err("The app handoff plugin needs a checksum-verified install from its official catalog repository.".into());
    }
    // Use the installer catalog only to select between these two host-owned locations.
    let relative = if record.staged_path == format!("installed-plugins/{id}") {
        PathBuf::from("installed-plugins").join(id)
    } else if checksum_valid
        && record.staged_path == format!("installed-plugins/packages/{}", record.source_checksum)
    {
        PathBuf::from("installed-plugins")
            .join("packages")
            .join(&record.source_checksum)
    } else {
        return Err("The app handoff plugin has an invalid installation path.".into());
    };
    let root = base
        .canonicalize()
        .map_err(|_| "ChemDraft's installed plugin catalog is unavailable.")?;
    let manifest_path = temp_files::plain_path(&root, &relative.join("manifest.json"), false)
        .map_err(|_| "The app handoff plugin manifest is missing from its installed package.")?;
    let manifest: Manifest = serde_json::from_slice(&read(&manifest_path)?)
        .map_err(|_| "The installed app handoff manifest is invalid.")?;
    if manifest.id != id
        || manifest.version != record.version
        || !["apps.handoff", "native.execute"].iter().all(|permission| {
            manifest
                .permissions
                .iter()
                .any(|declared| declared == permission)
        })
    {
        return Err(
            "The installed plugin must still declare apps.handoff and native.execute.".into(),
        );
    }
    Ok(Plugin {
        manifest,
        developer_sideload: sideload,
    })
}
