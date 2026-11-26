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

use std::ffi::{c_char, c_void, CStr};

use gtk::gdk;
use gtk::glib::prelude::ObjectType;

use crate::clipboard_formats::{ClipboardWriteResult, ValidatedClipboardItem};
use crate::clipboard_images::{self, ClipboardImageItem, SkippedClipboardImageItem};
use crate::clipboard_limits;
use crate::{ClipboardReadPayload, ClipboardTextItem};

#[link(name = "webkit2gtk-4.1")]
unsafe extern "C" {
    fn webkit_web_view_execute_editing_command(webview: *mut c_void, command: *const c_char);
}

/// Execute a menu click as a privileged WebKit editing action on the view's current focus.
pub(crate) fn execute_editing_command<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    command: &'static CStr,
) -> Result<(), String> {
    window
        .with_webview(move |webview| {
            let webview = webview.inner();
            // SAFETY: Tauri's Linux inner view is a live WebKitWebView and this closure runs on
            // its owning thread. The command is a static, nul-terminated WebKit command name.
            unsafe {
                webkit_web_view_execute_editing_command(webview.as_ptr().cast(), command.as_ptr())
            };
        })
        .map_err(|error| error.to_string())
}

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
    let advertised = clipboard
        .wait_for_targets()
        .unwrap_or_default()
        .into_iter()
        .map(|atom| atom.name().to_string())
        .collect::<Vec<_>>();
    Ok(read_advertised(advertised, |target| {
        read_bytes(&clipboard, target)
    }))
}

/// The reader itself: the advertised targets, and `read` for one target's bytes. Kept apart from
/// GTK so tests can replay a recorded clipboard without a display.
fn read_advertised(
    advertised: Vec<String>,
    mut read: impl FnMut(&str) -> Option<Vec<u8>>,
) -> ClipboardReadPayload {
    let types = advertised
        .into_iter()
        .filter(|name| !META_TARGETS.contains(&name.as_str()))
        .collect::<Vec<_>>();
    // Plain-text aliases collapse onto one `text/plain` entry: the resolver only knows MIME names.
    let types = normalize_text_types(types);

    let read_plan = types
        .iter()
        .map(|source| {
            let priority = clipboard_limits::text_read_priority(source);
            let priority = if priority == Some(2) {
                read(&target_for_type(source)).map_or(priority, |bytes| {
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
    let steps = plain_text_read_first(
        clipboard_limits::clipboard_read_steps(&priorities),
        &read_plan,
    );
    for step in steps {
        let source = match step {
            clipboard_limits::ClipboardReadStep::Pictures => {
                (image_items, skipped_image_items) = picture_items(&mut read, &types, &mut budget);
                continue;
            }
            clipboard_limits::ClipboardReadStep::Text(index) => &read_plan[index].0,
        };
        if crate::is_opaque_clipboard_type(source) {
            continue;
        }
        let Some(bytes) = read(&target_for_type(source)) else {
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

    ClipboardReadPayload {
        types,
        text_items,
        image_items,
        skipped_image_items,
        skipped_items: budget.skipped_items,
    }
}

/// Read the `text/plain` entry ahead of the other text flavors just before it in its pass. It
/// never moves past an advertised chemistry type or into another pass.
///
/// A flavor whose text repeats one already read is dropped as its alias, so read order decides
/// which name a text keeps. LibreOffice offers `text/plain;charset=utf-16` before its UTF-8 copy.
/// Read first, the UTF-16 copy kept the text under a name the resolver does not paste as plain
/// text, and the UTF-8 copy was dropped as its repeat. The resolver then pasted the next flavor it
/// takes for text, `text/richtext`: RTF source (GitHub #304). Read first itself, the UTF-8 copy
/// keeps `text/plain` and the repeat is dropped. When it cannot be read, the repeat is still
/// admitted, as before.
fn plain_text_read_first(
    mut steps: Vec<clipboard_limits::ClipboardReadStep>,
    read_plan: &[(String, Option<u8>)],
) -> Vec<clipboard_limits::ClipboardReadStep> {
    use clipboard_limits::ClipboardReadStep::Text;
    let Some(plain) = steps
        .iter()
        .position(|step| matches!(step, Text(index) if read_plan[*index].0 == "text/plain"))
    else {
        return steps;
    };
    let Text(plain_index) = steps[plain] else {
        return steps;
    };
    let pass = read_plan[plain_index].1;
    let mut target = plain;
    while target > 0
        && matches!(steps[target - 1], Text(index) if read_plan[index].1 == pass
            && !clipboard_limits::is_chemistry_type(&read_plan[index].0))
    {
        target -= 1;
    }
    if target < plain {
        let step = steps.remove(plain);
        steps.insert(target, step);
    }
    steps
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
    read: &mut impl FnMut(&str) -> Option<Vec<u8>>,
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
            let Some(bytes) = read(source) else {
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

    /// A copy recorded from LibreOffice 26.8.3 on X11 (Debian sid): the advertised targets and the
    /// bytes of its text targets. `text/richtext` held the same bytes as `text/rtf`, and
    /// `text/plain;charset=utf-8` and `STRING` the same as `UTF8_STRING`, so one file serves each.
    struct RecordedCopy {
        targets: &'static str,
        utf16: &'static [u8],
        utf8: &'static [u8],
        rtf: &'static [u8],
        html: &'static [u8],
        markdown: Option<&'static [u8]>,
    }

    impl RecordedCopy {
        fn advertised(&self) -> Vec<String> {
            self.targets.lines().map(str::to_string).collect()
        }

        fn read(&self, target: &str) -> Option<Vec<u8>> {
            let bytes = match target {
                "text/plain;charset=utf-16" => self.utf16,
                "UTF8_STRING" | "text/plain;charset=utf-8" | "STRING" => self.utf8,
                "text/rtf" | "text/richtext" => self.rtf,
                "text/html" => self.html,
                "text/markdown" => self.markdown?,
                _ => return None,
            };
            Some(bytes.to_vec())
        }
    }

    /// "Hello benzene" in bold, copied from a Writer document.
    const WRITER: RecordedCopy = RecordedCopy {
        targets: include_str!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-writer/targets.txt"
        ),
        utf16: include_bytes!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-writer/text-plain-charset-utf-16.bin"
        ),
        utf8: include_bytes!("../tests/fixtures/linux-clipboard/libreoffice-26.8-writer/utf8-string.bin"),
        rtf: include_bytes!("../tests/fixtures/linux-clipboard/libreoffice-26.8-writer/text-rtf.bin"),
        html: include_bytes!("../tests/fixtures/linux-clipboard/libreoffice-26.8-writer/text-html.bin"),
        markdown: Some(include_bytes!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-writer/text-markdown.bin"
        )),
    };

    /// The cells A1:B2 (Compound, MW / benzene, 78.11), copied from a Calc sheet.
    const CALC: RecordedCopy = RecordedCopy {
        targets: include_str!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-calc/targets.txt"
        ),
        utf16: include_bytes!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-calc/text-plain-charset-utf-16.bin"
        ),
        utf8: include_bytes!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-calc/utf8-string.bin"
        ),
        rtf: include_bytes!("../tests/fixtures/linux-clipboard/libreoffice-26.8-calc/text-rtf.bin"),
        html: include_bytes!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-calc/text-html.bin"
        ),
        markdown: None,
    };

    fn text_of<'a>(payload: &'a ClipboardReadPayload, kind: &str) -> Option<&'a str> {
        payload
            .text_items
            .iter()
            .find(|item| item.r#type == kind)
            .map(|item| item.text.as_str())
    }

    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn libreoffice_writer_text_keeps_its_utf8_copy_as_plain_text() {
        let payload = read_advertised(WRITER.advertised(), |target| WRITER.read(target));
        // Before #304's fix the UTF-16 copy took the text and `text/plain` was missing, so the
        // resolver pasted the RTF source under `text/richtext`.
        assert_eq!(text_of(&payload, "text/plain"), Some("Hello benzene"));
        assert_eq!(text_of(&payload, "text/plain;charset=utf-16"), None);
        // The RTF repeat is still read; it is the resolver's to skip, and it finds `text/plain`.
        assert!(text_of(&payload, "text/richtext").is_some_and(|text| text.starts_with("{\\rtf1")));
        assert!(payload.types.iter().any(|kind| kind == "text/plain"));
    }

    #[test]
    fn libreoffice_on_kwin_through_xwayland_keeps_its_utf8_copy_as_plain_text() {
        // The targets an X11 client saw for a Writer copy from LibreOffice's Qt 6 front end on
        // KWin's Wayland session: KWin turns `text/plain;charset=utf-8` into `UTF8_STRING` and
        // `text/plain` into `TEXT`, and leaves the UTF-16 name as it is, ahead of them.
        let advertised = include_str!(
            "../tests/fixtures/linux-clipboard/libreoffice-26.8-qt6-kwin-xwayland/targets.txt"
        )
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
        let payload = read_advertised(advertised, |target| WRITER.read(target));
        assert_eq!(text_of(&payload, "text/plain"), Some("Hello benzene"));
        assert_eq!(text_of(&payload, "text/plain;charset=utf-16"), None);
    }

    #[test]
    fn libreoffice_writer_smiles_keeps_its_utf8_copy_ahead_of_other_chemistry_looking_text() {
        // Text that previews as chemistry is read in the first pass, with the other flavors that
        // preview the same way (here the unformatted Markdown and the UTF-16 copy).
        let smiles = "c1ccc(O)cc1";
        let utf16 = utf16le(smiles);
        let payload = read_advertised(WRITER.advertised(), |target| match target {
            "text/plain;charset=utf-16" => Some(utf16.clone()),
            "UTF8_STRING" => Some(smiles.as_bytes().to_vec()),
            "text/markdown" => Some(format!("{smiles}\n").into_bytes()),
            other => WRITER.read(other),
        });
        assert_eq!(text_of(&payload, "text/plain"), Some(smiles));
        assert_eq!(text_of(&payload, "text/plain;charset=utf-16"), None);
    }

    #[test]
    fn the_utf16_copy_is_still_read_when_the_utf8_copy_cannot_be() {
        let payload = read_advertised(WRITER.advertised(), |target| match target {
            "UTF8_STRING" => None,
            other => WRITER.read(other),
        });
        assert_eq!(text_of(&payload, "text/plain"), None);
        assert_eq!(
            text_of(&payload, "text/plain;charset=utf-16"),
            Some("Hello benzene")
        );
    }

    #[test]
    fn libreoffice_calc_cells_keep_their_html_table_and_tab_separated_text() {
        let payload = read_advertised(CALC.advertised(), |target| CALC.read(target));
        assert_eq!(
            text_of(&payload, "text/plain"),
            Some("Compound\tMW\nbenzene\t78.11\n")
        );
        assert!(text_of(&payload, "text/html").is_some_and(|html| html.contains("<table")));
        assert_eq!(text_of(&payload, "text/plain;charset=utf-16"), None);
    }

    #[test]
    fn cjk_only_writer_text_still_reads_as_plain_text() {
        // UTF-16 with no zero byte is not recognized as a repeat of the UTF-8 copy, so both items
        // stay; `text/plain` is there for the resolver either way.
        let text = "日本語";
        let utf16 = utf16le(text);
        let payload = read_advertised(WRITER.advertised(), |target| match target {
            "text/plain;charset=utf-16" => Some(utf16.clone()),
            "UTF8_STRING" => Some(text.as_bytes().to_vec()),
            "text/markdown" => Some(format!("**{text}**\n").into_bytes()),
            other => WRITER.read(other),
        });
        assert_eq!(text_of(&payload, "text/plain"), Some(text));
    }

    #[test]
    fn the_paste_test_fixtures_are_this_readers_output() {
        // `packages/fixtures/clipboard-linux/libreoffice-26.8` holds what this reader returned for
        // these copies; `apps/desktop/src/linuxLibreOfficePaste.test.ts` pastes them.
        for (copy, recorded) in [
            (
                &WRITER,
                include_str!(
                    "../../../../packages/fixtures/clipboard-linux/libreoffice-26.8/writer-text.json"
                ),
            ),
            (
                &CALC,
                include_str!(
                    "../../../../packages/fixtures/clipboard-linux/libreoffice-26.8/calc.json"
                ),
            ),
        ] {
            let read =
                serde_json::to_value(read_advertised(copy.advertised(), |target| copy.read(target)))
                    .unwrap();
            let recorded: serde_json::Value = serde_json::from_str(recorded).unwrap();
            assert_eq!(read["types"], recorded["types"]);
            assert_eq!(read["textItems"], recorded["textItems"]);
        }
    }

    #[test]
    fn an_owner_that_offers_only_utf16_text_is_read_as_before() {
        let utf16 = utf16le("Hello UTF-16");
        let payload = read_advertised(
            vec!["TARGETS".into(), "text/plain;charset=utf-16".into()],
            |target| (target == "text/plain;charset=utf-16").then(|| utf16.clone()),
        );
        assert_eq!(payload.types, ["text/plain;charset=utf-16"]);
        assert_eq!(
            text_of(&payload, "text/plain;charset=utf-16"),
            Some("Hello UTF-16")
        );
    }

    #[test]
    fn plain_text_is_read_first_in_its_pass_but_after_advertised_chemistry() {
        use clipboard_limits::ClipboardReadStep::{Pictures, Text};
        fn order(entries: &[(&str, Option<u8>)]) -> Vec<clipboard_limits::ClipboardReadStep> {
            let read_plan = entries
                .iter()
                .map(|(kind, priority)| (kind.to_string(), *priority))
                .collect::<Vec<_>>();
            let priorities = read_plan
                .iter()
                .map(|(_, priority)| *priority)
                .collect::<Vec<_>>();
            plain_text_read_first(
                clipboard_limits::clipboard_read_steps(&priorities),
                &read_plan,
            )
        }
        // Prose: plain text moves ahead of the other prose flavors; HTML stays in its later pass.
        assert_eq!(
            order(&[
                ("text/markdown", Some(2)),
                ("text/plain;charset=utf-16", Some(2)),
                ("text/html", Some(3)),
                ("text/plain", Some(2)),
            ]),
            [Pictures, Text(3), Text(0), Text(1), Text(2)]
        );
        // Previewed as chemistry: ahead of other previewed text, never ahead of a chemistry type.
        assert_eq!(
            order(&[
                ("chemical/x-cdxml", Some(0)),
                ("text/markdown", Some(0)),
                ("text/plain", Some(0)),
                ("image/png", None),
            ]),
            [Text(0), Text(2), Text(1), Pictures]
        );
        // A chemistry type between them stays ahead of it.
        assert_eq!(
            order(&[
                ("text/markdown", Some(0)),
                ("chemical/x-cdxml", Some(0)),
                ("text/plain", Some(0)),
            ]),
            [Text(0), Text(1), Text(2), Pictures]
        );
        // Already first in its pass, in another pass than the rest, or absent: unchanged.
        assert_eq!(
            order(&[("text/plain", Some(2)), ("text/markdown", Some(2))]),
            [Pictures, Text(0), Text(1)]
        );
        assert_eq!(
            order(&[("text/markdown", Some(2)), ("text/plain", Some(0))]),
            [Text(1), Pictures, Text(0)]
        );
        assert_eq!(
            order(&[("text/markdown", Some(2)), ("text/html", Some(3))]),
            [Pictures, Text(0), Text(1)]
        );
    }
}
