//! Admission checks shared by the native clipboard readers.
//! Call before locking/copying bytes or converting a native string to an owned Rust string.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]

use crate::clipboard_images::{is_image_clipboard_type, MAX_CLIPBOARD_IMAGE_BYTES};

// Ten times a full 64 MiB copy plus native representations and Office siblings.
pub(crate) const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024 * 1024;

fn clipboard_flavor_name(kind: &str) -> &str {
    match kind {
        "public.utf8-plain-text"
        | "public.utf16-plain-text"
        | "public.plain-text"
        | "public.text"
        | "NSStringPboardType"
        | "com.apple.traditional-mac-plain-text" => "text/plain",
        "public.png" | "PNG" | "CF_DIB" | "CF_DIBV5" => "image/png",
        "public.svg" | "public.svg-image" => "image/svg+xml",
        other => other,
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ClipboardSkipReason {
    Flavor,
    Total,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkippedClipboardItem {
    pub(crate) r#type: String,
    pub(crate) byte_length: usize,
    pub(crate) limit_bytes: usize,
    pub(crate) chemistry: bool,
    pub(crate) reason: ClipboardSkipReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total_byte_length: Option<usize>,
}

impl SkippedClipboardItem {
    fn message(&self) -> String {
        if let ClipboardSkipReason::Total = self.reason {
            return format!(
                "Couldn't paste: the clipboard contents are too large ({:.1} MB in total; the limit is {} MB).",
                (self.total_byte_length.expect("total refusal records attempted total") as f64 * 10.0
                    / (1024.0 * 1024.0)).round() / 10.0,
                self.limit_bytes / (1024 * 1024)
            );
        }
        format!(
            "Couldn't paste: clipboard flavor \"{}\" is too large ({:.1} MB; the limit is {} MB).",
            clipboard_flavor_name(&self.r#type),
            (self.byte_length as f64 * 10.0 / (1024.0 * 1024.0)).round() / 10.0,
            self.limit_bytes / (1024 * 1024)
        )
    }
}

#[derive(Default)]
pub(crate) struct ClipboardReadBudget {
    copied_bytes: usize,
    pub(crate) skipped_items: Vec<SkippedClipboardItem>,
}

impl ClipboardReadBudget {
    /// Reserve before copying. Rejected flavors consume no budget, allowing smaller alternatives.
    /// Only retained, successfully decoded flavors consume the shared budget.
    pub(crate) fn reserve(&mut self, source: &str, byte_length: usize) -> Result<(), String> {
        self.check(source, byte_length)?;
        self.copied_bytes += byte_length;
        Ok(())
    }

    /// Failed conversions and discarded representations consume no retained budget.
    pub(crate) fn release(&mut self, byte_length: usize) {
        self.copied_bytes = self.copied_bytes.saturating_sub(byte_length);
    }

    /// A bounded preview of a refused generic text flavor can still identify chemistry.
    pub(crate) fn mark_chemistry(&mut self, source: &str, bytes: &[u8]) {
        let preview = &bytes[..bytes.len().min(8192)];
        let text = crate::decode_clipboard_text_bytes(preview).unwrap_or_default();
        if looks_like_chemistry_text(&text) {
            if let Some(item) = self
                .skipped_items
                .iter_mut()
                .rev()
                .find(|item| item.r#type == source)
            {
                item.chemistry = true;
            }
        }
    }

    /// Preflight NSData before asking AppKit to interpret it as NSString. The eventual read
    /// reserves once using the retained text's UTF-8 size.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn check(&mut self, source: &str, byte_length: usize) -> Result<(), String> {
        self.check_with_total(source, byte_length, true)
    }

    pub(crate) fn check_flavor(&mut self, source: &str, byte_length: usize) -> Result<(), String> {
        self.check_with_total(source, byte_length, false)
    }

    pub(crate) fn check_svg_allocation(
        &mut self,
        source: &str,
        byte_length: usize,
    ) -> Result<(), String> {
        let limit_bytes = crate::clipboard_images::MAX_SVG_TEXT_ALLOCATION_BYTES;
        if byte_length <= limit_bytes {
            return Ok(());
        }
        let item = SkippedClipboardItem {
            r#type: source.into(),
            byte_length,
            limit_bytes,
            chemistry: false,
            reason: ClipboardSkipReason::Flavor,
            total_byte_length: None,
        };
        let message = item.message();
        self.skipped_items.push(item);
        Err(message)
    }

    fn check_with_total(
        &mut self,
        source: &str,
        byte_length: usize,
        include_total: bool,
    ) -> Result<(), String> {
        let flavor_limit = if is_image_clipboard_type(source) {
            MAX_CLIPBOARD_IMAGE_BYTES
        } else {
            MAX_CLIPBOARD_BYTES
        };
        let total = self.copied_bytes.saturating_add(byte_length);
        let refusal = if byte_length > flavor_limit {
            Some((flavor_limit, ClipboardSkipReason::Flavor, None))
        } else if include_total && total > MAX_CLIPBOARD_BYTES {
            Some((MAX_CLIPBOARD_BYTES, ClipboardSkipReason::Total, Some(total)))
        } else {
            None
        };
        if let Some((limit_bytes, reason, total_byte_length)) = refusal {
            let skipped = SkippedClipboardItem {
                r#type: source.to_string(),
                byte_length,
                limit_bytes,
                chemistry: false,
                reason,
                total_byte_length,
            };
            let message = skipped.message();
            self.skipped_items.push(skipped);
            return Err(message);
        }
        Ok(())
    }
}

fn looks_like_chemistry_text(text: &str) -> bool {
    let text = text.trim();
    text.contains("<CDXML")
        || text.contains("chemdraft-selection")
        || text.contains("V2000")
        || text.contains("V3000")
        || text.starts_with("$RXN")
        || text.starts_with("InChI=")
        || (text.len() > 1
            && text
                .bytes()
                .all(|byte| br"BCNOFPSIHbcnops0123456789@+[]().=#$*%-/\".contains(&byte)))
}

/// Sniff only bounded text to place chemistry carried in plain text before pictures.
/// This affects admission order, never the returned text order or format resolution.
pub(crate) fn text_priority_with_preview(kind: &str, bytes: &[u8]) -> Option<u8> {
    let priority = text_read_priority(kind)?;
    if priority == 2 {
        let preview = &bytes[..bytes.len().min(8192)];
        if crate::decode_clipboard_text_bytes(preview)
            .is_some_and(|text| looks_like_chemistry_text(&text))
        {
            return Some(0);
        }
    }
    Some(priority)
}

/// Read explicit chemistry first, pictures next, then prose/rich text. Keep the original
/// text-flavor order in the returned payload: it is the resolver's tie-break, not read order.
pub(crate) fn text_read_priority(kind: &str) -> Option<u8> {
    let lower = kind.to_ascii_lowercase();
    if is_image_clipboard_type(kind)
        || [
            "com.apple.webkit.custom-pasteboard-data",
            "org.webkit.custom-pasteboard-data",
            "chromium web custom mime data format",
            "chromium internal source rfh token",
            "next tiff v4.0 pasteboard type",
            "apple png pasteboard type",
            "public.pdf",
            "com.adobe.pdf",
            "ns pdf pboardtype",
            "com.apple.flat-rtfd",
            "nsrtfdpboardtype",
            "apple web archive pasteboard type",
            "com.apple.webarchive",
            "com.microsoft.ole.source.1",
            "com.microsoft.ole.objectlink",
            "com.microsoft.ole.objectdescriptor",
            "chemical/x-cdx",
        ]
        .contains(&lower.as_str())
        || lower.contains("rtfd")
        || lower.contains("webarchive")
        || lower.contains("pdf")
        || lower.starts_with("com.microsoft.excel")
        || lower.starts_with("com.microsoft.word")
        || lower.starts_with("com.microsoft.powerpoint")
        || lower.contains("office")
        || lower.contains("embed source")
        || lower.contains("biff")
        || lower.contains("tiff")
        || lower.contains("png")
        || lower.ends_with(".cdx")
    {
        return None;
    }
    if is_chemistry_type(kind) {
        Some(0)
    } else if lower.contains("rtf") || lower.contains("html") {
        Some(3)
    } else {
        Some(2)
    }
}

/// The resolver's advertised chemistry list; generic text is classified separately by preview.
pub(crate) fn is_chemistry_type(kind: &str) -> bool {
    let lower = kind.to_ascii_lowercase();
    lower.contains("chemdraft-selection")
        || lower.contains("cdxml")
        || matches!(lower.as_str(), "chemical/x-cdx" | "application/x-cdx")
        || ["molfile", "rxnfile", "inchi", "smiles", "chemical/"]
            .iter()
            .any(|name| lower.contains(name))
}

/// Compare in place before allocating, decoding, or charging a text alias. UTF-16 aliases
/// are compared by scalar value, including BOMs and aligned terminator/allocation padding.
pub(crate) fn is_admitted_text_alias(bytes: &[u8], admitted: &[crate::ClipboardTextItem]) -> bool {
    if bytes.len() > MAX_CLIPBOARD_BYTES || admitted.is_empty() {
        return false;
    }
    let (content, big_endian) = if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        (content, Some(true))
    } else if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        (content, Some(false))
    } else if crate::looks_like_utf16_bytes(&bytes[..bytes.len().min(8192)]) {
        (bytes, Some(false))
    } else {
        (bytes, None)
    };
    if let Some(big_endian) = big_endian {
        admitted.iter().any(|item| {
            let units = content
                .chunks_exact(2)
                .map(|pair| {
                    if big_endian {
                        u16::from_be_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_le_bytes([pair[0], pair[1]])
                    }
                })
                .take_while(|unit| *unit != 0);
            char::decode_utf16(units).eq(item.text.chars().map(Ok))
        })
    } else {
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        admitted
            .iter()
            .any(|item| item.text.as_bytes() == &bytes[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_svg_utf16_allocation_accepts_main_25_mib_decoded_picture_limit() {
        for source in ["public.svg-image", "image/svg+xml", "public.svg"] {
            let mut budget = ClipboardReadBudget::default();
            budget
                .check_svg_allocation(source, 2 * MAX_CLIPBOARD_IMAGE_BYTES + 16)
                .unwrap();
            budget.reserve(source, MAX_CLIPBOARD_IMAGE_BYTES).unwrap();
            assert_eq!(budget.copied_bytes, MAX_CLIPBOARD_IMAGE_BYTES);
            assert!(budget
                .check_svg_allocation(
                    source,
                    crate::clipboard_images::MAX_SVG_TEXT_ALLOCATION_BYTES + 1
                )
                .is_err());
        }
    }

    #[test]
    fn clipboard_large_chemistry_aliases_are_not_read_or_charged_twice() {
        for mib in [9, 20] {
            for (kind, prefix) in [
                ("org.opensmiles.smiles", "CC"),
                ("chemical/x-mdl-molfile", "header\n V2000\n"),
                ("chemical/x-cdxml", "<CDXML>"),
            ] {
                let text = format!("{prefix}{}", "C".repeat(mib * 1024 * 1024 - prefix.len()));
                let mut budget = ClipboardReadBudget::default();
                budget.reserve(kind, text.len()).unwrap();
                let admitted = [crate::ClipboardTextItem {
                    r#type: kind.into(),
                    text,
                }];
                // Simulate a nearly full budget: duplicate aliases still bypass admission entirely.
                budget
                    .reserve("other", MAX_CLIPBOARD_BYTES - admitted[0].text.len())
                    .unwrap();
                assert!(is_admitted_text_alias(
                    admitted[0].text.as_bytes(),
                    &admitted
                ));
                let short = [crate::ClipboardTextItem {
                    r#type: kind.into(),
                    text: format!("{prefix}μ界"),
                }];
                for (big_endian, bom) in [(false, false), (false, true), (true, true)] {
                    let mut bytes = if bom {
                        if big_endian {
                            vec![0xfe, 0xff]
                        } else {
                            vec![0xff, 0xfe]
                        }
                    } else {
                        Vec::new()
                    };
                    bytes.extend(short[0].text.encode_utf16().chain([0]).flat_map(|unit| {
                        if big_endian {
                            unit.to_be_bytes()
                        } else {
                            unit.to_le_bytes()
                        }
                    }));
                    assert!(is_admitted_text_alias(&bytes, &short));
                }
                assert!(budget.skipped_items.is_empty());
                assert_eq!(budget.copied_bytes, MAX_CLIPBOARD_BYTES);
                assert!(!is_admitted_text_alias(b"different", &admitted));
            }
        }
    }

    #[test]
    fn clipboard_upper_realistic_selection_and_office_siblings_fit_unchanged() {
        let mut budget = ClipboardReadBudget::default();
        for (source, bytes) in [
            ("application/x-chemdraft-selection+json", 64 * 1024 * 1024),
            ("public.png", 25 * 1024 * 1024),
            ("chemical/x-cdxml", 20 * 1024 * 1024),
            ("text/rtf", 50 * 1024 * 1024),
            ("text/html", 50 * 1024 * 1024),
        ] {
            budget.reserve(source, bytes).unwrap();
        }
        assert!(budget.skipped_items.is_empty());
    }

    #[test]
    fn clipboard_size_messages_round_half_up_like_dom_to_fixed() {
        let mut budget = ClipboardReadBudget::default();
        budget
            .reserve("text/plain", MAX_CLIPBOARD_BYTES - 1024 * 1024)
            .unwrap();
        assert_eq!(budget.reserve("text/rtf", 5 * 1024 * 1024 / 4), Err(
            "Couldn't paste: the clipboard contents are too large (1024.3 MB in total; the limit is 1024 MB).".into()));
        let metadata = serde_json::to_value(&budget.skipped_items[0]).unwrap();
        assert_eq!(metadata["reason"], "total");
        assert_eq!(metadata["byteLength"], 5 * 1024 * 1024 / 4);
        assert_eq!(
            metadata["totalByteLength"],
            MAX_CLIPBOARD_BYTES + 1024 * 1024 / 4
        );
    }

    #[test]
    fn clipboard_own_cap_refusal_keeps_flavor_size_and_limit_even_when_total_is_full() {
        let mut budget = ClipboardReadBudget::default();
        budget.reserve("text/plain", MAX_CLIPBOARD_BYTES).unwrap();
        assert_eq!(budget.reserve("PNG", 30 * 1024 * 1024), Err(
            "Couldn't paste: clipboard flavor \"image/png\" is too large (30.0 MB; the limit is 25 MB).".into()));
        let metadata = serde_json::to_value(&budget.skipped_items[0]).unwrap();
        assert_eq!(metadata["reason"], "flavor");
        assert!(metadata.get("totalByteLength").is_none());
        assert_eq!(budget.copied_bytes, MAX_CLIPBOARD_BYTES);
    }

    #[test]
    fn clipboard_generic_chemistry_is_admitted_before_pictures_and_prose() {
        for source in ["text/plain", "public.utf8-plain-text"] {
            assert_eq!(text_priority_with_preview(source, b"CCO"), Some(0));
            assert_eq!(text_priority_with_preview(source, b"<CDXML>"), Some(0));
            assert_eq!(
                text_priority_with_preview(source, b"ordinary prose"),
                Some(2)
            );
        }
        assert_eq!(
            text_priority_with_preview("public.rtf", b"{\\rtf1"),
            Some(3)
        );
        assert_eq!(text_priority_with_preview("public.pdf", b"%PDF"), None);
    }

    #[test]
    fn clipboard_native_flavor_messages_match_dom_flavor_messages() {
        for source in [
            "text/plain",
            "public.utf8-plain-text",
            "public.utf16-plain-text",
        ] {
            assert_eq!(ClipboardReadBudget::default().reserve(source, 1500 * 1024 * 1024), Err(
                "Couldn't paste: clipboard flavor \"text/plain\" is too large (1500.0 MB; the limit is 1024 MB).".into()));
        }
        for source in ["public.png", "PNG", "image/png"] {
            assert_eq!(ClipboardReadBudget::default().reserve(source, 30 * 1024 * 1024), Err(
                "Couldn't paste: clipboard flavor \"image/png\" is too large (30.0 MB; the limit is 25 MB).".into()));
        }
    }

    #[test]
    fn clipboard_size_skip_retains_generic_text_chemistry_identity() {
        for text in [
            "<CDXML>",
            "header\n  V2000",
            "InChI=1S/CH4/h1H4",
            "{\"kind\":\"chemdraft-selection\"}",
            "CCCCCCCC",
        ] {
            let mut budget = ClipboardReadBudget::default();
            assert!(budget
                .reserve("text/plain", MAX_CLIPBOARD_BYTES + 1)
                .is_err());
            budget.mark_chemistry("text/plain", text.as_bytes());
            assert!(budget.skipped_items[0].chemistry, "{text}");
        }
    }

    #[test]
    fn clipboard_read_plan_keeps_pictures_ahead_of_rtf_and_never_reads_containers() {
        for kind in [
            "NeXT TIFF v4.0 pasteboard type",
            "Apple PNG pasteboard type",
            "public.pdf",
            "com.apple.flat-rtfd",
            "com.apple.webarchive",
            "Office Drawing Shape Format",
        ] {
            assert_eq!(text_read_priority(kind), None, "{kind}");
        }
        for kind in ["text/rtf", "public.rtf", "text/html"] {
            assert_eq!(text_read_priority(kind), Some(3));
        }
        for kind in [
            "chemical/x-cdxml",
            "chemical/x-mdl-molfile",
            "application/x-chemdraft-selection+json",
        ] {
            assert_eq!(text_read_priority(kind), Some(0));
        }
        let mut budget = ClipboardReadBudget::default();
        assert!(
            budget.reserve("PNG", 24 * 1024 * 1024).is_ok()
                && budget
                    .reserve("private", MAX_CLIPBOARD_BYTES - 64 * 1024 * 1024)
                    .is_ok()
        );
        assert!(budget.reserve("text/rtf", 50 * 1024 * 1024).is_err());
        assert_eq!(budget.skipped_items[0].byte_length, 50 * 1024 * 1024);
        assert_eq!(budget.skipped_items[0].message(), "Couldn't paste: the clipboard contents are too large (1034.0 MB in total; the limit is 1024 MB).");
        assert!(budget.reserve("text/plain", 40 * 1024 * 1024).is_ok());
        budget.release(40 * 1024 * 1024); // An undecodable flavor was discarded.
        assert!(budget.reserve("text/plain", 40 * 1024 * 1024).is_ok());
    }

    #[test]
    fn clipboard_native_lengths_are_checked_without_allocating_the_payload() {
        // The length comes from GlobalSize, NSData.length, or NSString's UTF-8 byte length.
        for source in ["text/plain", "public.utf8-plain-text", "chemical/x-cdxml"] {
            for length in [MAX_CLIPBOARD_BYTES + 1, 1500 * 1024 * 1024, usize::MAX] {
                let mut budget = ClipboardReadBudget::default();
                assert!(budget.reserve(source, length).is_err());
                assert_eq!(budget.copied_bytes, 0);
                assert_eq!(budget.skipped_items[0].byte_length, length);
                assert_eq!(budget.skipped_items[0].limit_bytes, MAX_CLIPBOARD_BYTES);
                assert!(budget.reserve(source, 42).is_ok());
            }
            let mut budget = ClipboardReadBudget::default();
            assert!(budget.reserve(source, MAX_CLIPBOARD_BYTES).is_ok());
            assert!(budget.reserve(source, 0).is_ok());
            assert!(budget.reserve(source, 1).is_err());
        }
    }

    #[test]
    fn clipboard_total_includes_text_and_pictures_and_does_not_overflow() {
        let mut budget = ClipboardReadBudget::default();
        assert!(budget
            .reserve("public.png", MAX_CLIPBOARD_IMAGE_BYTES)
            .is_ok());
        assert!(budget
            .reserve(
                "text/plain",
                MAX_CLIPBOARD_BYTES - MAX_CLIPBOARD_IMAGE_BYTES
            )
            .is_ok());
        assert!(budget.reserve("image/svg+xml", 1).is_err());
        assert_eq!(budget.skipped_items[0].byte_length, 1);
        assert_eq!(budget.skipped_items[0].limit_bytes, MAX_CLIPBOARD_BYTES);
        assert!(budget.reserve("text/plain", usize::MAX).is_err());
        assert_eq!(budget.copied_bytes, MAX_CLIPBOARD_BYTES);
    }

    #[test]
    fn clipboard_nsdata_preflight_does_not_double_charge_string_conversion() {
        let mut budget = ClipboardReadBudget::default();
        assert!(budget.check("public.text", MAX_CLIPBOARD_BYTES).is_ok());
        assert!(budget.reserve("public.text", MAX_CLIPBOARD_BYTES).is_ok());
        assert!(budget.check("public.text", 1).is_err());
        assert_eq!(budget.copied_bytes, MAX_CLIPBOARD_BYTES);
    }

    #[test]
    fn clipboard_pictures_keep_the_stricter_cap_and_refusals_have_a_clear_message() {
        for source in ["PNG", "CF_DIB", "CF_DIBV5", "image/svg+xml", "public.tiff"] {
            let mut budget = ClipboardReadBudget::default();
            assert!(budget
                .reserve(source, MAX_CLIPBOARD_IMAGE_BYTES + 1)
                .is_err());
            assert_eq!(
                budget.skipped_items[0].limit_bytes,
                MAX_CLIPBOARD_IMAGE_BYTES
            );
            assert!(budget.reserve(source, MAX_CLIPBOARD_IMAGE_BYTES).is_ok());
        }
        assert_eq!(
            ClipboardReadBudget::default().reserve("text/plain", 1500 * 1024 * 1024),
            Err(
                "Couldn't paste: clipboard flavor \"text/plain\" is too large (1500.0 MB; the limit is 1024 MB)."
                    .to_string()
            )
        );
    }
}
