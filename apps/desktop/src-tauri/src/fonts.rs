use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, OnceLock},
};

use resvg::usvg;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SystemFontStyle {
    Normal,
    Italic,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemFontFace {
    weight: u16,
    style: SystemFontStyle,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemFontFamily {
    family: String,
    faces: Vec<SystemFontFace>,
}

/// System fonts are scanned from disk once and shared by raster export and UI font discovery.
/// `load_system_fonts` walks every OS font directory (hundreds of ms, and over a
/// second on Windows installs with many fonts), so ownership lives here instead of in
/// any one feature surface.
pub(crate) fn shared_fontdb() -> Arc<usvg::fontdb::Database> {
    static FONTDB: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTDB
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_system_fonts();
            Arc::new(db)
        })
        .clone()
}

#[tauri::command]
pub(crate) async fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    tauri::async_runtime::spawn_blocking(system_font_catalog)
        .await
        .map_err(|error| format!("Could not list system fonts: {error}"))
}

pub(crate) fn system_font_catalog() -> Vec<SystemFontFamily> {
    static CATALOG: OnceLock<Vec<SystemFontFamily>> = OnceLock::new();
    CATALOG.get_or_init(collect_system_font_catalog).clone()
}

fn collect_system_font_catalog() -> Vec<SystemFontFamily> {
    let db = shared_fontdb();
    let mut families = BTreeMap::<String, BTreeSet<SystemFontFace>>::new();
    for face in db.faces() {
        let style = match face.style {
            usvg::fontdb::Style::Normal => SystemFontStyle::Normal,
            usvg::fontdb::Style::Italic | usvg::fontdb::Style::Oblique => SystemFontStyle::Italic,
        };
        let font_face = SystemFontFace {
            weight: face.weight.0.clamp(1, 1000),
            style,
        };
        for (family, _) in &face.families {
            let family = family.trim();
            if family.is_empty() || family.chars().any(|character| character.is_control()) {
                continue;
            }
            families
                .entry(family.to_string())
                .or_default()
                .insert(font_face.clone());
        }
    }

    for family in [
        "Arial",
        "Helvetica",
        "Times New Roman",
        "Courier New",
        "sans-serif",
        "serif",
        "monospace",
    ] {
        families
            .entry(family.to_string())
            .or_default()
            .insert(SystemFontFace {
                weight: 400,
                style: SystemFontStyle::Normal,
            });
    }

    families
        .into_iter()
        .map(|(family, faces)| SystemFontFamily {
            family,
            faces: faces.into_iter().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_contains_sorted_deduplicated_public_font_metadata() {
        let catalog = system_font_catalog();
        assert!(!catalog.is_empty());
        assert!(catalog
            .windows(2)
            .all(|pair| pair[0].family <= pair[1].family));
        assert!(catalog.iter().any(|family| family.family == "Arial"));
        for family in catalog {
            assert!(!family.family.is_empty());
            assert!(!family.family.contains('/'));
            assert!(family.faces.windows(2).all(|pair| pair[0] <= pair[1]));
            assert!(family
                .faces
                .iter()
                .all(|face| (1..=1000).contains(&face.weight)));
        }
    }
}
