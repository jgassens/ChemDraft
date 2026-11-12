//! Panel labels retain the migrated v1 main identity; v2 also captures a document owner.

pub(crate) fn owner_id(label: &str) -> Option<String> {
    let id = label.strip_prefix("plugin-panel-")?;
    if id.is_empty() {
        return None;
    }
    if !id.starts_with("v2x") {
        return Some("main".into());
    }
    let parts: Vec<_> = id.split('x').collect();
    if parts.len() != 4 || parts[0] != "v2" {
        return None;
    }
    let decode = |hex: &str| -> Option<String> {
        if hex.is_empty()
            || !hex.len().is_multiple_of(2)
            || !hex
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
        {
            return None;
        }
        let bytes: Option<Vec<_>> = (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).ok())
            .collect();
        String::from_utf8(bytes?).ok()
    };
    let owner = decode(parts[1])?;
    decode(parts[2])?;
    decode(parts[3])?;
    if owner.len() > 128
        || !owner
            .strip_prefix("doc-")
            .is_some_and(|suffix| !suffix.is_empty())
        || !owner
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
    {
        return None;
    }
    Some(owner)
}

#[cfg(test)]
mod tests {
    use super::owner_id;

    #[test]
    fn legacy_main_and_two_owners_are_distinct_and_malformed_v2_never_falls_back() {
        assert_eq!(owner_id("plugin-panel-v1x61x62").as_deref(), Some("main"));
        assert_eq!(
            owner_id("plugin-panel-v2x646f632d62x61x62").as_deref(),
            Some("doc-b")
        );
        assert_eq!(
            owner_id("plugin-panel-v2x646f632d63x61x62").as_deref(),
            Some("doc-c")
        );
        for label in [
            "runtime",
            "plugin-panel-",
            "plugin-panel-v2x61x62",
            "plugin-panel-v2x6d61696ex61x62",
            "plugin-panel-v2x646f632d2fx61x62",
        ] {
            assert!(owner_id(label).is_none(), "{label}");
        }
    }

    #[test]
    fn two_panel_owners_authorize_only_their_own_publications_and_hides() {
        let registry = crate::document_windows::DocumentWindowRegistry::with_main();
        registry.register("doc-b", "doc-b").unwrap();
        registry.set_ready("main");
        registry.set_ready("doc-b");
        let a = "plugin-panel-v1x61x62";
        let b = "plugin-panel-v2x646f632d62x61x62";
        for (owner, panel, other) in [("main", a, "doc-b"), ("doc-b", b, "main")] {
            assert_eq!(registry.owner_of(panel).unwrap().window_id, owner);
            assert!(
                crate::panel_window_controls::authorize_main_hide(&registry, owner, panel).is_ok()
            );
            assert!(
                crate::panel_window_controls::authorize_main_hide(&registry, other, panel).is_err()
            );
            let publication = crate::PluginPanelPublication {
                target_label: panel.into(),
                event: "chemdraft://plugin-panel-report".into(),
                payload: serde_json::json!({ "report": { "title": "Report", "sections": [] } }),
            };
            let state =
                std::sync::Mutex::new(crate::utility_suspension::UtilitySuspension::default());
            assert!(
                crate::plugin_panel_publication_script(&registry, owner, &publication, &state)
                    .is_ok()
            );
            assert!(
                crate::plugin_panel_publication_script(&registry, other, &publication, &state)
                    .is_err()
            );
        }
        registry.remove("main");
        assert!(registry.owner_of(a).is_none());
        assert_eq!(registry.owner_of(b).unwrap().window_id, "doc-b");
        registry.remove("doc-b");
        assert!(registry.owner_of(b).is_none());
    }
}
