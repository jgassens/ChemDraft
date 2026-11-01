//! Admission checks shared by the native clipboard readers.
//! Call before locking/copying bytes or converting a native string to an owned Rust string.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]

use crate::clipboard_images::{is_image_clipboard_type, MAX_CLIPBOARD_IMAGE_BYTES};

pub(crate) const MAX_CLIPBOARD_BYTES: usize = 64 * 1024 * 1024;

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
pub(crate) struct SkippedClipboardItem {
    pub(crate) r#type: String,
    pub(crate) byte_length: usize,
    pub(crate) limit_bytes: usize,
    pub(crate) chemistry: bool,
}

impl SkippedClipboardItem {
    fn message(&self) -> String {
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
        let flavor_limit = if is_image_clipboard_type(source) {
            MAX_CLIPBOARD_IMAGE_BYTES
        } else {
            MAX_CLIPBOARD_BYTES
        };
        let total = self.copied_bytes.saturating_add(byte_length);
        let refusal = if byte_length > flavor_limit {
            Some((byte_length, flavor_limit))
        } else if total > MAX_CLIPBOARD_BYTES {
            Some((byte_length, MAX_CLIPBOARD_BYTES))
        } else {
            None
        };
        if let Some((byte_length, limit_bytes)) = refusal {
            let skipped = SkippedClipboardItem {
                r#type: source.to_string(),
                byte_length,
                limit_bytes,
                chemistry: false,
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
    if lower.contains("chemdraft-selection")
        || lower.contains("cdxml")
        || lower.contains("molfile")
        || lower.contains("smiles")
        || lower.contains("inchi")
        || lower.starts_with("chemical/")
    {
        Some(0)
    } else if lower.contains("rtf") || lower.contains("html") {
        Some(3)
    } else {
        Some(2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_size_messages_round_half_up_like_dom_to_fixed() {
        let mut budget = ClipboardReadBudget::default();
        budget.reserve("text/plain", 63 * 1024 * 1024).unwrap();
        assert_eq!(budget.reserve("text/rtf", 5 * 1024 * 1024 / 4), Err(
            "Couldn't paste: clipboard flavor \"text/rtf\" is too large (1.3 MB; the limit is 64 MB).".into()));
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
            assert_eq!(ClipboardReadBudget::default().reserve(source, 500 * 1024 * 1024), Err(
                "Couldn't paste: clipboard flavor \"text/plain\" is too large (500.0 MB; the limit is 64 MB).".into()));
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
        assert!(budget.reserve("PNG", 24 * 1024 * 1024).is_ok());
        assert!(budget.reserve("text/rtf", 50 * 1024 * 1024).is_err());
        assert_eq!(budget.skipped_items[0].byte_length, 50 * 1024 * 1024);
        assert_eq!(budget.skipped_items[0].message(), "Couldn't paste: clipboard flavor \"text/rtf\" is too large (50.0 MB; the limit is 64 MB).");
        assert!(budget.reserve("text/plain", 40 * 1024 * 1024).is_ok());
        budget.release(40 * 1024 * 1024); // An undecodable flavor was discarded.
        assert!(budget.reserve("text/plain", 40 * 1024 * 1024).is_ok());
    }

    #[test]
    fn clipboard_native_lengths_are_checked_without_allocating_the_payload() {
        // The length comes from GlobalSize, NSData.length, or NSString's UTF-8 byte length.
        for source in ["text/plain", "public.utf8-plain-text", "chemical/x-cdxml"] {
            for length in [MAX_CLIPBOARD_BYTES + 1, 500 * 1024 * 1024, usize::MAX] {
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
        assert!(budget.reserve("text/plain", 39 * 1024 * 1024).is_ok());
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
            ClipboardReadBudget::default().reserve("text/plain", 500 * 1024 * 1024),
            Err(
                "Couldn't paste: clipboard flavor \"text/plain\" is too large (500.0 MB; the limit is 64 MB)."
                    .to_string()
            )
        );
    }
}
