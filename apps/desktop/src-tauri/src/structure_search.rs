use tauri::Manager;

// Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: fixed substance-search links with native preference and rate gates.

use std::sync::Mutex;
use std::time::{Duration, Instant};

const PUBCHEM_PREFIX: &str = "https://pubchem.ncbi.nlm.nih.gov/#query=";
const REAXYS_PREFIX: &str = "https://www.reaxys.com/reaxys/secured/hopinto.do?context=S&query=";
const MAX_INPUT_CHARS: usize = 20_000;
const MAX_URL_BYTES: usize = 2000;
const TOO_LARGE: &str = "This structure is too large for a search link. Select a smaller part.";

// Preferences live in webview localStorage. The document window mirrors the setting with a
// separate command, as it does for quit preferences. Refuse until that initial sync completes.
struct SearchState {
    enabled: bool,
    last_opened: Option<Instant>,
}

static SEARCH_STATE: Mutex<SearchState> = Mutex::new(SearchState {
    enabled: false,
    last_opened: None,
});

fn authorize_document(
    registry: &super::document_windows::DocumentWindowRegistry,
    label: &str,
) -> Result<(), String> {
    if registry.is_document_window(label) {
        Ok(())
    } else {
        Err("Structure searches are available only in the document window.".into())
    }
}

#[tauri::command]
pub(crate) fn set_structure_search_enabled(
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    authorize_document(
        &window.state::<super::document_windows::DocumentWindowRegistry>(),
        window.label(),
    )?;
    SEARCH_STATE
        .lock()
        .map_err(|error| error.to_string())?
        .enabled = enabled;
    Ok(())
}

fn encode_parameter(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn search_url(site: &str, smiles: &str, version: &str) -> Result<String, String> {
    if !matches!(site, "pubchem" | "reaxys") {
        return Err("Unknown structure search site.".into());
    }
    if smiles.chars().count() > MAX_INPUT_CHARS {
        return Err(TOO_LARGE.into());
    }
    if smiles.trim().is_empty() {
        return Err("Select a structure to search.".into());
    }
    let url = match site {
        "pubchem" => format!("{PUBCHEM_PREFIX}{}&input_type=smiles", encode_parameter(smiles)),
        "reaxys" => format!(
            "{REAXYS_PREFIX}{}&options=substructure,isotopes,stereo_absolute,salts,charges,radicals,mixtures&origin=ChemDraft{}&ln=",
            encode_parameter(&format!("SMILES='{smiles}'")),
            encode_parameter(version)
        ),
        _ => unreachable!(),
    };
    if url.len() > MAX_URL_BYTES {
        Err(TOO_LARGE.into())
    } else {
        Ok(url)
    }
}

#[tauri::command]
pub(crate) fn open_structure_search(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    site: String,
    smiles: String,
) -> Result<(), String> {
    authorize_document(
        &window.state::<super::document_windows::DocumentWindowRegistry>(),
        window.label(),
    )?;
    let mut state = SEARCH_STATE.lock().map_err(|error| error.to_string())?;
    if !state.enabled {
        return Err("Online structure search is off in Preferences.".into());
    }
    let url = search_url(&site, &smiles, &app.package_info().version.to_string())?;
    if state
        .last_opened
        .is_some_and(|last| last.elapsed() < Duration::from_secs(1))
    {
        return Err("Wait a second before searching again.".into());
    }
    crate::problem_reports::open_external_address(&url)
        .map_err(|error| format!("Could not open your browser: {error}"))?;
    state.last_opened = Some(Instant::now());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_every_non_alphanumeric_byte() {
        assert_eq!(
            encode_parameter("Az09-_.~%#/[C@@H+]&=' é"),
            "Az09%2D%5F%2E%7E%25%23%2F%5BC%40%40H%2B%5D%26%3D%27%20%C3%A9"
        );
    }

    #[test]
    fn fixed_hosts_and_parameter_forms() {
        assert_eq!(
            search_url("pubchem", "C/C=C/C", "1.2.3").unwrap(),
            "https://pubchem.ncbi.nlm.nih.gov/#query=C%2FC%3DC%2FC&input_type=smiles"
        );
        assert_eq!(search_url("reaxys", "CC(=O)O", "1.2.3").unwrap(),
            "https://www.reaxys.com/reaxys/secured/hopinto.do?context=S&query=SMILES%3D%27CC%28%3DO%29O%27&options=substructure,isotopes,stereo_absolute,salts,charges,radicals,mixtures&origin=ChemDraft1%2E2%2E3&ln=");
    }

    #[test]
    fn refuses_unknown_sites_and_empty_input() {
        for site in ["", "https://example.com", "PubChem", "reaxys&host=evil"] {
            assert!(search_url(site, "C", "1").is_err());
        }
        assert!(search_url("pubchem", " ", "1").is_err());
        assert!(authorize_document(&crate::test_documents(), "preferences").is_err());
        assert!(authorize_document(&crate::test_documents(), "main").is_ok());
    }

    #[test]
    fn caps_input_and_final_url() {
        for site in ["pubchem", "reaxys"] {
            assert_eq!(
                search_url(site, &"C".repeat(20_001), "1").unwrap_err(),
                TOO_LARGE
            );
            assert_eq!(
                search_url(site, &"#".repeat(1000), "1").unwrap_err(),
                TOO_LARGE
            );
            let overhead = search_url(site, "C", "1").unwrap().len() - 1;
            assert_eq!(
                search_url(site, &"C".repeat(MAX_URL_BYTES - overhead), "1")
                    .unwrap()
                    .len(),
                MAX_URL_BYTES
            );
            assert_eq!(
                search_url(site, &"C".repeat(MAX_URL_BYTES - overhead + 1), "1").unwrap_err(),
                TOO_LARGE
            );
        }
    }

    #[test]
    fn every_built_url_has_a_fixed_prefix() {
        for site in ["pubchem", "reaxys"] {
            for smiles in ["C", "C%10#N/[C@@H+]&x='y'", "https://evil.test/?x#z"] {
                let url = search_url(site, smiles, "1&origin=evil").unwrap();
                assert!(url.starts_with(PUBCHEM_PREFIX) || url.starts_with(REAXYS_PREFIX));
            }
        }
    }
}
