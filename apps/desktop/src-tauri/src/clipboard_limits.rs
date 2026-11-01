//! Admission checks shared by GlobalSize, NSData length and NSString UTF-8 length readers.
//! Call before locking/copying bytes or converting a native string to an owned Rust string.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]

use crate::clipboard_images::{is_image_clipboard_type, MAX_CLIPBOARD_IMAGE_BYTES};

pub(crate) const MAX_CLIPBOARD_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkippedClipboardItem {
    pub(crate) r#type: String,
    pub(crate) byte_length: usize,
    pub(crate) limit_bytes: usize,
}

impl SkippedClipboardItem {
    fn message(&self) -> String {
        format!(
            "Couldn't paste: the clipboard item is too large ({:.1} MB; the limit is {} MB).",
            self.byte_length as f64 / (1024.0 * 1024.0),
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
    /// Count every admitted read, including undecodable data, against this paste's total.
    pub(crate) fn reserve(&mut self, source: &str, byte_length: usize) -> Result<(), String> {
        self.check(source, byte_length)?;
        self.copied_bytes += byte_length;
        Ok(())
    }

    /// Preflight NSData before asking AppKit to interpret it as NSString. The eventual read
    /// reserves once, using the larger of the source data and the converted string's byte size.
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
            Some((total, MAX_CLIPBOARD_BYTES))
        } else {
            None
        };
        if let Some((byte_length, limit_bytes)) = refusal {
            let skipped = SkippedClipboardItem {
                r#type: source.to_string(),
                byte_length,
                limit_bytes,
            };
            let message = skipped.message();
            self.skipped_items.push(skipped);
            return Err(message);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(budget.skipped_items[0].byte_length, MAX_CLIPBOARD_BYTES + 1);
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
                "Couldn't paste: the clipboard item is too large (500.0 MB; the limit is 64 MB)."
                    .to_string()
            )
        );
    }
}
