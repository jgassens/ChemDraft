//! Clipboard wire validation and format translation, independent of native clipboard APIs.

use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::HashMap;

const MAX_CLIPBOARD_BYTES: usize = 64 * 1024 * 1024;
const CF_HTML_HEADER_BYTES: usize = 105;
const START_FRAGMENT: &str = "<!--StartFragment-->";
const END_FRAGMENT: &str = "<!--EndFragment-->";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClipboardWriteItem {
    pub r#type: String,
    pub text: Option<String>,
    pub bytes_base64: Option<String>,
    #[serde(default = "required_by_default")]
    pub required: bool,
}

fn required_by_default() -> bool {
    true
}

#[derive(Debug)]
pub(crate) enum ClipboardWriteData {
    Text(String),
    Binary(Vec<u8>),
}

impl ClipboardWriteData {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Self::Text(text) => text.as_bytes(),
            Self::Binary(bytes) => bytes,
        }
    }
}

#[derive(Debug)]
pub(crate) struct ValidatedClipboardItem {
    pub r#type: String,
    pub data: ClipboardWriteData,
    pub required: bool,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct ClipboardWriteFailure {
    pub r#type: String,
    pub reason: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipboardWriteResult {
    pub ok: bool,
    pub written: Vec<String>,
    pub failed: Vec<ClipboardWriteFailure>,
    pub warnings: Vec<String>,
}

impl ClipboardWriteResult {
    pub fn new() -> Self {
        Self {
            ok: true,
            written: Vec::new(),
            failed: Vec::new(),
            warnings: Vec::new(),
        }
    }

    pub fn record(&mut self, item: &ValidatedClipboardItem, result: Result<(), String>) {
        match result {
            Ok(()) => self.written.push(item.r#type.clone()),
            Err(reason) => {
                self.ok &= !item.required;
                self.failed.push(ClipboardWriteFailure {
                    r#type: item.r#type.clone(),
                    reason,
                });
            }
        }
    }
}

/// Complete this before opening/clearing a clipboard. A malformed optional item also refuses the
/// transaction: required controls write failures, never permission to discard existing contents.
pub(crate) fn validate_clipboard_items(
    items: Vec<ClipboardWriteItem>,
) -> Result<Vec<ValidatedClipboardItem>, String> {
    validate_clipboard_items_with_limit(items, MAX_CLIPBOARD_BYTES)
}

fn validate_clipboard_items_with_limit(
    items: Vec<ClipboardWriteItem>,
    limit: usize,
) -> Result<Vec<ValidatedClipboardItem>, String> {
    let mut seen = HashMap::<String, usize>::new();
    let mut validated: Vec<ValidatedClipboardItem> = Vec::new();
    let mut total = 0usize;
    for item in items {
        let item_type = item.r#type.trim();
        if item_type.is_empty() {
            continue;
        }
        if item_type.contains('\0') {
            return Err("Clipboard item type contains a NUL character.".to_string());
        }
        let size_error = || format!("Clipboard items exceed the {limit}-byte size limit.");
        let data = match (item.text, item.bytes_base64) {
            (Some(text), None) => ClipboardWriteData::Text(text),
            (None, Some(encoded)) => {
                // Bound allocation before decoding; the final exact check includes padding.
                if encoded.len() > (limit.saturating_sub(total).saturating_add(2) / 3) * 4 {
                    return Err(size_error());
                }
                ClipboardWriteData::Binary(STANDARD.decode(encoded).map_err(|error| {
                    format!("Clipboard item {item_type} has invalid base64: {error}")
                })?)
            }
            _ => {
                return Err(format!(
                    "Clipboard item {item_type} requires exactly one of text or bytesBase64."
                ));
            }
        };
        if data.bytes().is_empty() {
            continue;
        }
        total = total
            .checked_add(data.bytes().len())
            .filter(|total| *total <= limit)
            .ok_or_else(size_error)?;

        match item_type {
            "text/html" => {
                clipboard_utf8(data.bytes(), "HTML")?;
            }
            "text/rtf" => validate_rtf_ascii(data.bytes())?,
            "text/plain" => {
                clipboard_utf8(data.bytes(), "Plain text")?;
            }
            _ => {}
        }
        if let Some(&index) = seen.get(item_type) {
            validated[index].required |= item.required;
            continue;
        }
        seen.insert(item_type.to_string(), validated.len());
        validated.push(ValidatedClipboardItem {
            r#type: item_type.to_string(),
            data,
            required: item.required,
        });
    }
    if validated.is_empty() {
        return Err("Clipboard write requires at least one non-empty item.".to_string());
    }
    Ok(validated)
}

pub(crate) fn clipboard_utf8<'a>(bytes: &'a [u8], kind: &str) -> Result<&'a str, String> {
    std::str::from_utf8(bytes).map_err(|_| format!("{kind} clipboard item is not valid UTF-8."))
}

pub(crate) fn validate_rtf_ascii(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_ascii() {
        Ok(())
    } else {
        Err(
            "RTF clipboard item must contain only ASCII bytes; escape non-ASCII text in RTF."
                .to_string(),
        )
    }
}

fn fragment_range(html: &str) -> Result<std::ops::Range<usize>, String> {
    let start = html
        .find(START_FRAGMENT)
        .ok_or_else(|| format!("HTML clipboard item has no {START_FRAGMENT} marker"))?
        + START_FRAGMENT.len();
    let end = html
        .find(END_FRAGMENT)
        .ok_or_else(|| format!("HTML clipboard item has no {END_FRAGMENT} marker"))?;
    if start > end {
        return Err("HTML clipboard item has misordered fragment markers".to_string());
    }
    if html[start..].contains(START_FRAGMENT)
        || html[end + END_FRAGMENT.len()..].contains(END_FRAGMENT)
    {
        return Err("HTML clipboard item has multiple fragment markers".to_string());
    }
    Ok(start..end)
}

// These pure mappings/codecs stay compiled on every host; only their native consumer varies.
#[allow(dead_code)]
pub(crate) fn build_cf_html(html: &str) -> Result<Vec<u8>, String> {
    let fragment = fragment_range(html)?;
    let end_html = CF_HTML_HEADER_BYTES
        .checked_add(html.len())
        .filter(|end| *end <= 9_999_999_999)
        .ok_or_else(|| "HTML clipboard item is too large for CF_HTML offsets".to_string())?;
    let header = format!(
        "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
        CF_HTML_HEADER_BYTES,
        end_html,
        CF_HTML_HEADER_BYTES + fragment.start,
        CF_HTML_HEADER_BYTES + fragment.end
    );
    debug_assert_eq!(header.len(), CF_HTML_HEADER_BYTES);
    let mut bytes = header.into_bytes();
    bytes.extend_from_slice(html.as_bytes());
    bytes.push(0);
    Ok(bytes)
}

#[allow(dead_code)]
pub(crate) fn parse_cf_html(bytes: &[u8]) -> Result<String, String> {
    let offset = |key: &[u8]| -> Option<i64> {
        bytes
            .split(|byte| *byte == b'\n')
            .take_while(|line| !line.contains(&b'<') && !line.contains(&0))
            .find_map(|line| {
                std::str::from_utf8(line.strip_prefix(key)?)
                    .ok()?
                    .trim()
                    .parse()
                    .ok()
            })
    };
    let (start, end) = match offset(b"StartHTML:") {
        None | Some(-1) => (offset(b"StartFragment:"), offset(b"EndFragment:")),
        start => (start, offset(b"EndHTML:")),
    };
    let range = start
        .zip(end)
        .and_then(|(start, end)| Some(usize::try_from(start).ok()?..usize::try_from(end).ok()?))
        .filter(|range| range.start <= range.end)
        .and_then(|range| bytes.get(range))
        .ok_or_else(|| "CF_HTML clipboard item has invalid or missing byte offsets".to_string())?;
    clipboard_utf8(range, "HTML").map(str::to_string)
}

#[allow(dead_code)]
pub(crate) fn macos_type_for_payload_type(payload_type: &str) -> &str {
    match payload_type {
        "text/plain" => "public.utf8-plain-text",
        "text/html" => "public.html",
        "text/rtf" => "public.rtf",
        "image/png" => "public.png",
        "application/pdf" => "com.adobe.pdf",
        other => other,
    }
}

#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum WindowsTarget {
    UnicodeText,
    Html,
    Rtf,
    Png,
    Registered(String),
    /// The macOS SVG alias is ignored on Windows, where image/svg+xml is used instead.
    Skip,
}

#[allow(dead_code)]
pub(crate) fn windows_target_for_payload_type(payload_type: &str) -> WindowsTarget {
    match payload_type {
        "text/plain" => WindowsTarget::UnicodeText,
        "text/html" => WindowsTarget::Html,
        "text/rtf" => WindowsTarget::Rtf,
        "image/png" => WindowsTarget::Png,
        "public.svg-image" => WindowsTarget::Skip,
        other => WindowsTarget::Registered(other.to_string()),
    }
}

#[cfg(all(test, any(target_os = "macos", windows)))]
pub(crate) mod native_test_data {
    use super::*;

    pub const PRIVATE_TYPE: &str = "application/x-chemdraft-selection+json";
    pub const JSON: &str = r#"{"kind":"chemdraft-selection","label":"Δ °C é"}"#;
    pub const TEXT: &str = "Δ °C é";
    pub const HTML: &str =
        "<html><body><!--StartFragment--><b>Δ °C é</b><!--EndFragment--></body></html>";
    pub const RTF: &str = r"{\rtf1\ansi \u916? \'b0C \'e9}";

    pub fn items() -> (Vec<ClipboardWriteItem>, Vec<u8>) {
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([255, 0, 0, 128]),
        ))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("encode clipboard fixture PNG");
        let mut items: Vec<_> = [
            (PRIVATE_TYPE, JSON),
            ("text/plain", TEXT),
            ("text/html", HTML),
            ("text/rtf", RTF),
        ]
        .into_iter()
        .map(|(kind, text)| ClipboardWriteItem {
            r#type: kind.to_string(),
            text: Some(text.to_string()),
            bytes_base64: None,
            required: true,
        })
        .collect();
        items.push(ClipboardWriteItem {
            r#type: "image/png".to_string(),
            text: None,
            bytes_base64: Some(STANDARD.encode(&png)),
            required: true,
        });
        (items, png)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html(fragment: &str) -> String {
        format!("<html><head><meta charset=\"utf-8\"></head><body>{START_FRAGMENT}{fragment}{END_FRAGMENT}</body></html>")
    }

    #[test]
    fn cf_html_has_golden_ascii_and_utf8_byte_offsets() {
        for (fragment, end_html, end_fragment) in [
            ("<table><tr><td>A</td></tr></table>", 238, 206),
            ("<table><tr><td>Δ °C é</td></tr></table>", 246, 214),
        ] {
            let document = html(fragment);
            let bytes = build_cf_html(&document).unwrap();
            let expected_header = format!(
                "Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:{end_html:010}\r\nStartFragment:0000000172\r\nEndFragment:{end_fragment:010}\r\n"
            );
            assert_eq!(&bytes[..105], expected_header.as_bytes());
            assert_eq!(&bytes[105..end_html], document.as_bytes());
            assert_eq!(&bytes[172..end_fragment], fragment.as_bytes());
            assert_eq!(
                &bytes[end_fragment..end_html],
                b"<!--EndFragment--></body></html>"
            );
            assert_eq!(&bytes[end_html..], &[0]);
            assert_eq!(parse_cf_html(&bytes).unwrap(), document);
        }
    }

    #[test]
    fn cf_html_refuses_missing_and_misordered_markers() {
        assert_eq!(
            build_cf_html("<html>table</html>").unwrap_err(),
            "HTML clipboard item has no <!--StartFragment--> marker"
        );
        assert_eq!(
            build_cf_html("<!--StartFragment-->table").unwrap_err(),
            "HTML clipboard item has no <!--EndFragment--> marker"
        );
        assert_eq!(
            build_cf_html("<!--EndFragment--><!--StartFragment-->").unwrap_err(),
            "HTML clipboard item has misordered fragment markers"
        );
        assert!(build_cf_html(&html("<!--StartFragment-->")).is_err());
    }

    #[test]
    fn reads_word_fragment_when_start_html_is_minus_one_or_absent() {
        // Word may supply fragment offsets only, with optional selection offsets/SourceURL.
        let header = "Version:1.0\r\nStartHTML:-1\r\nEndHTML:-1\r\nStartFragment:0000000120\r\nEndFragment:0000000129\r\nSourceURL:https://example.org\r\n";
        assert_eq!(header.len(), 120);
        let bytes = format!("{header}<p>é</p>\0").into_bytes();
        assert_eq!(parse_cf_html(&bytes).unwrap(), "<p>é</p>");
        let bytes = b"StartFragment:0000000054\r\nEndFragment:0000000055\r\n    x\0";
        assert_eq!(parse_cf_html(bytes).unwrap(), "x");
    }

    #[test]
    fn refuses_invalid_cf_html_offsets_without_guessing() {
        for bytes in [
            b"StartHTML:9999\r\nEndHTML:10000\r\n<html/>".as_slice(),
            b"StartHTML:20\r\nEndHTML:10\r\n",
            b"<html>no header</html>",
            b"StartHTML:-2\r\nEndHTML:0\r\n",
        ] {
            assert!(parse_cf_html(bytes).is_err());
        }
    }

    #[test]
    fn rtf_requires_ascii_with_unicode_escaped_by_the_producer() {
        assert!(validate_rtf_ascii(br"{\rtf1\ansi Temperature \u916? 25\'b0C}").is_ok());
        assert!(validate_rtf_ascii("{\\rtf1 Δ}".as_bytes())
            .unwrap_err()
            .contains("only ASCII"));
    }

    #[test]
    fn maps_native_types_on_both_platforms() {
        for (payload, native) in [
            ("text/plain", "public.utf8-plain-text"),
            ("text/html", "public.html"),
            ("text/rtf", "public.rtf"),
            ("image/png", "public.png"),
            ("application/pdf", "com.adobe.pdf"),
            ("public.svg-image", "public.svg-image"),
            ("private/data", "private/data"),
        ] {
            assert_eq!(macos_type_for_payload_type(payload), native);
        }
        for (payload, target) in [
            ("text/plain", WindowsTarget::UnicodeText),
            ("text/html", WindowsTarget::Html),
            ("text/rtf", WindowsTarget::Rtf),
            ("image/png", WindowsTarget::Png),
            ("public.svg-image", WindowsTarget::Skip),
            (
                "image/svg+xml",
                WindowsTarget::Registered("image/svg+xml".to_string()),
            ),
            (
                "application/pdf",
                WindowsTarget::Registered("application/pdf".to_string()),
            ),
        ] {
            assert_eq!(windows_target_for_payload_type(payload), target);
        }
    }

    fn item(value: serde_json::Value) -> ClipboardWriteItem {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn decodes_base64_and_normalizes_before_any_native_side_effect() {
        let items = validate_clipboard_items(vec![
            item(serde_json::json!({"type": " private/data ", "bytesBase64": "AAH/"})),
            item(serde_json::json!({"type": "private/data", "bytesBase64": "Ag=="})),
            item(serde_json::json!({"type": "empty", "text": ""})),
            item(serde_json::json!({"type": "empty", "text": "kept", "required": false})),
            item(serde_json::json!({"type": "", "text": "dropped"})),
        ])
        .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].r#type, "private/data");
        assert_eq!(items[0].data.bytes(), &[0, 1, 255]);
        assert!(items[0].required);
        assert!(!items[1].required);
    }

    #[test]
    fn validates_duplicates_before_discarding_their_data() {
        for bad in [
            serde_json::json!({"type": "private/data", "bytesBase64": "%%%"}),
            serde_json::json!({"type": "private/data", "text": "x", "bytesBase64": "AA=="}),
            serde_json::json!({"type": "private/data"}),
            serde_json::json!({"type": "text/rtf", "text": "é", "required": false}),
            serde_json::json!({"type": "text/plain", "bytesBase64": "/w=="}),
            serde_json::json!({"type": "text/html", "bytesBase64": "/w=="}),
        ] {
            let request = vec![
                item(serde_json::json!({"type": bad["type"], "text": "valid"})),
                item(bad),
            ];
            assert!(validate_clipboard_items(request).is_err());
        }
    }

    #[test]
    fn keeps_first_duplicate_data_and_requires_it_if_any_duplicate_is_required() {
        for (first, later) in [(false, true), (true, false), (false, false)] {
            let items = validate_clipboard_items(vec![
                item(serde_json::json!({"type": " private/data ", "text": "first", "required": first})),
                item(serde_json::json!({"type": "private/data", "text": "later", "required": later})),
            ])
            .unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].data.bytes(), b"first");
            assert_eq!(items[0].required, first || later);
        }
    }

    #[test]
    fn refuses_bad_items_and_total_size_before_a_writer_can_clear() {
        for bad in [
            serde_json::json!({"type": "binary", "bytesBase64": "%%%"}),
            serde_json::json!({"type": "text/html", "bytesBase64": "/w==", "required": false}),
            serde_json::json!({"type": "text/rtf", "bytesBase64": STANDARD.encode("é")}),
            serde_json::json!({"type": "text/plain", "bytesBase64": "/w=="}),
            serde_json::json!({"type": "binary", "text": "x", "bytesBase64": "AA=="}),
            serde_json::json!({"type": "binary"}),
            serde_json::json!({"type": "bad\u{0000}type", "text": "x"}),
        ] {
            let request = vec![
                // Use a distinct type so normalization cannot discard the bad item as a duplicate.
                item(serde_json::json!({"type": "private/valid", "text": "valid"})),
                item(bad),
            ];
            assert!(validate_clipboard_items(request).is_err());
        }
        let request = || {
            vec![
                item(serde_json::json!({"type": "text/plain", "text": "1234"})),
                item(serde_json::json!({"type": "private/data", "bytesBase64": "AAECAw=="})),
            ]
        };
        assert!(validate_clipboard_items_with_limit(request(), 7).is_err());
        assert!(validate_clipboard_items_with_limit(request(), 8).is_ok());
        assert!(validate_clipboard_items_with_limit(
            vec![item(
                serde_json::json!({"type": "binary", "bytesBase64": "A".repeat(100)})
            )],
            8
        )
        .is_err());
        assert!(validate_clipboard_items(Vec::new()).is_err());
    }

    #[test]
    fn shared_html_validation_accepts_utf8_without_windows_fragment_markers() {
        let items = validate_clipboard_items(vec![item(
            serde_json::json!({"type": "text/html", "text": "<b>table</b>"}),
        )])
        .unwrap();
        assert_eq!(items[0].data.bytes(), b"<b>table</b>");
        assert_eq!(
            build_cf_html(clipboard_utf8(items[0].data.bytes(), "HTML").unwrap()).unwrap_err(),
            "HTML clipboard item has no <!--StartFragment--> marker"
        );
    }

    #[test]
    fn required_items_control_the_aggregate_result() {
        let items = validate_clipboard_items(vec![
            item(serde_json::json!({"type": "text/plain", "text": "ok"})),
            item(serde_json::json!({"type": "optional", "text": "optional", "required": false})),
        ])
        .unwrap();
        let mut result = ClipboardWriteResult::new();
        assert!(result.warnings.is_empty());
        result.record(&items[0], Ok(()));
        result.record(&items[1], Err("unsupported".to_string()));
        assert!(result.ok);
        assert_eq!(result.written, ["text/plain"]);
        assert_eq!(result.failed[0].r#type, "optional");
        result.record(&items[0], Err("clipboard full".to_string()));
        assert!(!result.ok);
    }
}
