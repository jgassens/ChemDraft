//! Linux clipboard through GTK, the toolkit Tauri's webview (WebKitGTK) already runs on.
//!
//! X11 and Wayland both reach the clipboard through `gtk::Clipboard`, and Linux clipboard targets
//! are MIME types already, so the payload types the editor writes (`text/plain`, `text/html`,
//! `image/png`, `image/svg+xml`, `chemical/x-cdxml`, …) go to the clipboard unchanged. Reading
//! follows the same admission order and byte budget as the macOS and Windows readers
//! (`clipboard_limits`), so a paste resolves the same way on every platform.
//!
//! Both commands run on the main thread (they are sync Tauri commands off Windows), which GTK
//! requires. `wait_for_*` spins a nested main loop there, as every GTK application's paste does.

use gtk::gdk;

use crate::clipboard_formats::{ClipboardWriteResult, ValidatedClipboardItem};
use crate::clipboard_images::{self, ClipboardImageItem, SkippedClipboardImageItem};
use crate::clipboard_limits;
use crate::{ClipboardReadPayload, ClipboardTextItem};

/// Extra targets other Linux applications ask for when they want plain text.
const PLAIN_TEXT_ALIASES: [&str; 5] = [
    "text/plain;charset=utf-8",
    "UTF8_STRING",
    "STRING",
    "TEXT",
    "COMPOUND_TEXT",
];

/// X11 bookkeeping targets; never pasteable content.
const META_TARGETS: [&str; 6] = [
    "TARGETS",
    "TIMESTAMP",
    "MULTIPLE",
    "SAVE_TARGETS",
    "DELETE",
    "INSERT_PROPERTY",
];

fn clipboard() -> gtk::Clipboard {
    gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD)
}

pub(crate) fn write_items(items: &[ValidatedClipboardItem]) -> ClipboardWriteResult {
    // `info` indexes into `payloads`; a target alias shares its item's index.
    let mut targets = Vec::new();
    let mut payloads: Vec<(bool, Vec<u8>)> = Vec::new();
    for item in items {
        let index = payloads.len() as u32;
        let plain = item.r#type == "text/plain";
        payloads.push((plain, item.data.bytes().to_vec()));
        targets.push(gtk::TargetEntry::new(
            &item.r#type,
            gtk::TargetFlags::empty(),
            index,
        ));
        if plain {
            for alias in PLAIN_TEXT_ALIASES {
                targets.push(gtk::TargetEntry::new(
                    alias,
                    gtk::TargetFlags::empty(),
                    index,
                ));
            }
        }
    }

    let owned = clipboard().set_with_data(&targets, move |_, selection, info| {
        let Some((plain, bytes)) = payloads.get(info as usize) else {
            return;
        };
        if *plain {
            // set_text converts to whatever text target (UTF8_STRING, STRING, …) was requested.
            selection.set_text(&String::from_utf8_lossy(bytes));
        } else {
            selection.set(&selection.target(), 8, bytes);
        }
    });

    let mut result = ClipboardWriteResult::new();
    for item in items {
        result.record(
            item,
            if owned {
                Ok(())
            } else {
                Err(format!(
                    "Could not write clipboard data for type {}.",
                    item.r#type
                ))
            },
        );
    }
    if owned {
        // Hand the data to the clipboard manager, so a copy survives ChemDraft quitting.
        clipboard().store();
    }
    result
}

fn read_bytes(clipboard: &gtk::Clipboard, target: &str) -> Option<Vec<u8>> {
    let data = clipboard.wait_for_contents(&gdk::Atom::intern(target))?;
    (data.length() >= 0).then(|| data.data())
}

pub(crate) fn read_payload() -> Result<ClipboardReadPayload, String> {
    let clipboard = clipboard();
    let types = clipboard
        .wait_for_targets()
        .unwrap_or_default()
        .into_iter()
        .map(|atom| atom.name().to_string())
        .filter(|name| !META_TARGETS.contains(&name.as_str()))
        .collect::<Vec<_>>();
    // Plain-text aliases collapse onto one `text/plain` entry: the resolver only knows MIME names.
    let types = normalize_text_types(types);

    let read_plan = types
        .iter()
        .map(|source| {
            let priority = clipboard_limits::text_read_priority(source);
            let priority = if priority == Some(2) {
                read_bytes(&clipboard, &target_for_type(source)).map_or(priority, |bytes| {
                    clipboard_limits::text_priority_with_preview(source, &bytes)
                })
            } else {
                priority
            };
            (source.clone(), priority)
        })
        .collect::<Vec<_>>();

    let mut budget = clipboard_limits::ClipboardReadBudget::default();
    let mut text_items: Vec<ClipboardTextItem> = Vec::new();
    let mut image_items = Vec::new();
    let mut skipped_image_items = Vec::new();
    let priorities = read_plan.iter().map(|(_, p)| *p).collect::<Vec<_>>();
    for step in clipboard_limits::clipboard_read_steps(&priorities) {
        let source = match step {
            clipboard_limits::ClipboardReadStep::Pictures => {
                (image_items, skipped_image_items) = picture_items(&clipboard, &types, &mut budget);
                continue;
            }
            clipboard_limits::ClipboardReadStep::Text(index) => &read_plan[index].0,
        };
        if crate::is_opaque_clipboard_type(source) {
            continue;
        }
        let Some(bytes) = read_bytes(&clipboard, &target_for_type(source)) else {
            continue;
        };
        if clipboard_limits::is_admitted_text_alias(&bytes, &text_items) {
            continue;
        }
        if budget.reserve(source, bytes.len()).is_err() {
            continue;
        }
        budget.mark_chemistry(source, &bytes);
        match crate::decode_clipboard_text_bytes(&bytes) {
            Some(text) => text_items.push(ClipboardTextItem {
                r#type: source.clone(),
                text,
            }),
            None => budget.release(bytes.len()),
        }
    }
    text_items.sort_by_key(|item| types.iter().position(|kind| kind == &item.r#type));

    Ok(ClipboardReadPayload {
        types,
        text_items,
        image_items,
        skipped_image_items,
        skipped_items: budget.skipped_items,
    })
}

/// Linux publishes plain text under several names; the editor only knows `text/plain`.
fn normalize_text_types(types: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut plain_seen = false;
    for name in types {
        let is_plain = name == "text/plain"
            || name.eq_ignore_ascii_case("text/plain;charset=utf-8")
            || PLAIN_TEXT_ALIASES.contains(&name.as_str());
        if is_plain {
            if !plain_seen {
                plain_seen = true;
                out.push("text/plain".to_string());
            }
        } else {
            out.push(name);
        }
    }
    out
}

/// The target to request for a normalized type. `text/plain` asks for UTF-8 explicitly.
fn target_for_type(kind: &str) -> String {
    if kind == "text/plain" {
        "UTF8_STRING".to_string()
    } else {
        kind.to_string()
    }
}

fn picture_items(
    clipboard: &gtk::Clipboard,
    types: &[String],
    budget: &mut clipboard_limits::ClipboardReadBudget,
) -> (Vec<ClipboardImageItem>, Vec<SkippedClipboardImageItem>) {
    let mut image_items = Vec::new();
    let mut skipped = Vec::new();
    for (sources, output_type) in [
        (&["image/png", "image/tiff"][..], "image/png"),
        (&["image/svg+xml"][..], "image/svg+xml"),
    ] {
        if !image_items.is_empty() {
            break;
        }
        for &source in sources {
            if !types.iter().any(|kind| kind == source) {
                continue;
            }
            let Some(bytes) = read_bytes(clipboard, source) else {
                skipped.push(SkippedClipboardImageItem::new(
                    output_type,
                    0,
                    format!("Could not read {source} clipboard data"),
                ));
                continue;
            };
            let svg = output_type == "image/svg+xml";
            let admission = if svg {
                budget.reserve_svg_allocation(source, bytes.len())
            } else {
                budget.reserve(source, bytes.len())
            };
            let result = admission.and_then(|()| {
                let item = match source {
                    "image/png" => clipboard_images::png_image_item(&bytes),
                    "image/tiff" => clipboard_images::tiff_image_item(&bytes),
                    _ => clipboard_images::svg_image_item(&bytes, source),
                };
                if svg {
                    budget.release(bytes.len());
                }
                let item = item?;
                if svg {
                    budget.reserve(source, item.retained_byte_length())?;
                }
                Ok(item)
            });
            match result {
                Ok(item) => {
                    image_items.push(item);
                    break;
                }
                Err(reason) => {
                    if !svg && !budget.skipped_items.iter().any(|s| s.r#type == source) {
                        budget.release(bytes.len());
                    }
                    skipped.push(SkippedClipboardImageItem::new(
                        output_type,
                        bytes.len(),
                        reason,
                    ));
                }
            }
        }
    }
    (image_items, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_aliases_collapse_to_one_mime_type() {
        let types = normalize_text_types(vec![
            "UTF8_STRING".into(),
            "chemical/x-cdxml".into(),
            "text/plain;charset=utf-8".into(),
            "STRING".into(),
            "text/html".into(),
        ]);
        assert_eq!(types, ["text/plain", "chemical/x-cdxml", "text/html"]);
    }

    #[test]
    fn plain_text_is_requested_as_utf8() {
        assert_eq!(target_for_type("text/plain"), "UTF8_STRING");
        assert_eq!(target_for_type("chemical/x-cdxml"), "chemical/x-cdxml");
    }
}
