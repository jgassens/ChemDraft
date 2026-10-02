//! The Windows clipboard, translated to and from the payload types the TS clipboard adapter already
//! understands (the macOS reader hands it pasteboard UTIs; this hands it MIME-style names).
//!
//! | payload type                                 | Windows clipboard format                  |
//! |----------------------------------------------|-------------------------------------------|
//! | `text/plain`                                 | `CF_UNICODETEXT`                          |
//! | `image/png`                                  | registered `PNG` (+ `CF_DIBV5` on write)  |
//! | `chemical/x-cdx`                             | registered `ChemDraw Interchange Format`  |
//! | `chemical/x-mdl-molfile`                     | registered `MDLCT` (length-prefixed lines)|
//! | `text/html`, `text/rtf`                      | `HTML Format`, `Rich Text Format`         |
//! | anything else (`image/svg+xml`, ChemDraft's  | a registered format of the same name,     |
//! | selection JSON, other apps' formats)         | UTF-8 text                                |
//!
//! The ChemDraw and MDL names are what those apps are documented to register; confirm against a real
//! ChemDraw for Windows. Unknown names pass through unchanged, so a wrong guess costs a detection,
//! never data.
//!
//! The pure translation helpers below compile and are tested on every platform; the Win32 calls live
//! in [`native`].

use super::{decode_clipboard_text_bytes, text_is_plausible_clipboard_text};

// Standard clipboard format ids (winuser.h). Kept local so the pure helpers build off Windows.
const CF_TEXT: u32 = 1;
const CF_OEMTEXT: u32 = 7;
const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_ENHMETAFILE: u32 = 14;
const CF_LOCALE: u32 = 16;
const CF_DIBV5: u32 = 17;

const PNG_FORMAT: &str = "PNG";
const CDX_FORMAT: &str = "ChemDraw Interchange Format";
const MDLCT_FORMAT: &str = "MDLCT";

/// Formats whose bytes are never text a user meant to paste: list them as types, but do not fetch
/// or decode them. Besides binary payloads this covers the shell's and OLE's bookkeeping formats —
/// an Explorer file copy carries `DataObject` (a window handle), `Preferred DropEffect` (a DWORD)
/// and `FileName` (an 8.3 path), which the text fallback used to turn into a junk text object — and
/// the formats Office renders on demand: fetching those makes Excel/Word/PowerPoint serialize the
/// whole selection again (WM_RENDERFORMAT) while ChemDraft's thread waits, for nothing it can use.
const NON_TEXT_FORMATS: [&str; 39] = [
    PNG_FORMAT,
    CDX_FORMAT,
    "Embed Source",
    "Link Source",
    "Object Descriptor",
    "Link Source Descriptor",
    "Native",
    "OwnerLink",
    "ObjectLink",
    "Ole Private Data",
    "DataObject",
    "DataObjectAttributes",
    "DataObjectAttributesRequiringElevation",
    "Preferred DropEffect",
    "Performed DropEffect",
    "Paste Succeeded",
    "Shell IDList Array",
    "Shell Object Offsets",
    "FileName",
    "FileNameW",
    "FileContents",
    "FileGroupDescriptor",
    "FileGroupDescriptorW",
    "DragContext",
    "DragImageBits",
    "UsingDefaultDragImage",
    "IsShowingLayered",
    "IsShowingText",
    "Chromium internal source URL",
    "XML Spreadsheet",
    "SYLK",
    "DIF",
    "Csv",
    "Hyperlink",
    "Link",
    "JFIF",
    "GIF",
    "Link Preview Format",
    "Rich Text Format Without Objects",
];

/// Name prefixes of the same kind: Excel's binary workbook formats, Office drawing formats, and the
/// clipboard-history flags Windows attaches (`CanIncludeInClipboardHistory`, …).
const NON_TEXT_FORMAT_PREFIXES: [&str; 7] = [
    "Biff",
    "Art::",
    "Office Drawing",
    "PowerPoint",
    "CanInclude",
    "CanUpload",
    "ExcludeClipboardContent",
];

/// The payload type a clipboard format is reported as, or `None` to leave it out entirely.
/// `name` is the registered name (from `GetClipboardFormatNameW`), absent for standard formats.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn payload_type_for_format(id: u32, name: Option<&str>) -> Option<String> {
    let Some(name) = name else {
        return match id {
            CF_UNICODETEXT => Some("text/plain".to_string()),
            CF_DIB | CF_DIBV5 => Some("image/bmp".to_string()),
            CF_ENHMETAFILE => Some("image/emf".to_string()),
            // CF_TEXT/CF_OEMTEXT/CF_LOCALE are synthesized from CF_UNICODETEXT; others are not text.
            CF_TEXT | CF_OEMTEXT | CF_LOCALE => None,
            _ => None,
        };
    };
    Some(
        match name {
            PNG_FORMAT => "image/png",
            CDX_FORMAT => "chemical/x-cdx",
            MDLCT_FORMAT => "chemical/x-mdl-molfile",
            "HTML Format" => "text/html",
            "Rich Text Format" => "text/rtf",
            other => other,
        }
        .to_string(),
    )
}

/// Where a payload type is written.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum WindowsTarget {
    UnicodeText,
    Registered(String),
    /// Written under another name already (`public.svg-image` duplicates `image/svg+xml`).
    Skip,
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_target_for_payload_type(payload_type: &str) -> WindowsTarget {
    match payload_type {
        "text/plain" => WindowsTarget::UnicodeText,
        "public.svg-image" => WindowsTarget::Skip,
        other => WindowsTarget::Registered(other.to_string()),
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_binary_windows_format(name: &str) -> bool {
    NON_TEXT_FORMATS.contains(&name)
        || NON_TEXT_FORMAT_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        || name.starts_with("image/") && name != "image/svg+xml"
}

/// Accept decoded clipboard text only if it could be something a person copied: plausible (no
/// stray control characters) and not just whitespace. The shared decoder's UTF-8 branch has no
/// such check, which is how a DWORD like `05 00 00 00` came back as the text "\u{5}".
fn accepted_text(text: &str) -> Option<String> {
    (!text.trim().is_empty() && text_is_plausible_clipboard_text(text)).then(|| text.to_string())
}

/// Text from a registered format's bytes. Registered text formats are UTF-8 C strings by convention
/// (and always, when ChemDraft wrote them), so UTF-8 is tried first. Going straight to the shared
/// decoder would be wrong: a single trailing NUL is enough for its UTF-16 heuristics to read
/// `"abc\0"` as two UTF-16 units.
///
/// A block may also be larger than the string it holds (a writer is free to over-allocate, and
/// `GlobalSize` reports the allocation), so after the whole-block attempt the text up to the first
/// NUL is tried — unless the bytes look like UTF-16, whose ASCII has a NUL in every other byte. Only
/// then does the shared UTF-16-aware decoder run, minus any aligned UTF-16 terminator, and its
/// answer must pass the same plausibility check.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn decode_registered_text(bytes: &[u8]) -> Option<String> {
    let last = bytes.iter().rposition(|byte| *byte != 0)?;
    let without_nuls = &bytes[..=last];
    if let Ok(text) = std::str::from_utf8(without_nuls) {
        if !text.contains('\0') {
            if let Some(text) = accepted_text(text) {
                return Some(text);
            }
        }
    }

    if !crate::looks_like_utf16_bytes(bytes) {
        if let Some(first_nul) = bytes.iter().position(|byte| *byte == 0) {
            if let Ok(text) = std::str::from_utf8(&bytes[..first_nul]) {
                if let Some(text) = accepted_text(text) {
                    return Some(text);
                }
            }
        }
    }

    let mut end = bytes.len() - bytes.len() % 2;
    while end >= 2 && bytes[end - 2] == 0 && bytes[end - 1] == 0 {
        end -= 2;
    }
    decode_clipboard_text_bytes(&bytes[..end]).and_then(|text| accepted_text(&text))
}

/// MDL "clip text": each molfile line is prefixed by one byte holding its length.
///
/// Lines are decoded as UTF-8, or as Latin-1 when they are not (ISIS/ChemDraw write the header and
/// comment lines in the system code page, e.g. a `°` in a comment), so one non-ASCII byte no longer
/// drops the whole molfile. Parsing stops at trailing zero padding, and a block that runs past its
/// end after the molfile's `M  END` keeps the complete molfile it has already read.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn decode_mdlct(bytes: &[u8]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].iter().all(|byte| *byte == 0) {
            break;
        }
        let length = bytes[index] as usize;
        let Some(line) = bytes.get(index + 1..index + 1 + length) else {
            if lines.iter().any(|line| line.trim_end() == "M  END") {
                break;
            }
            return None;
        };
        lines.push(match std::str::from_utf8(line) {
            Ok(text) => text.to_string(),
            Err(_) => line.iter().map(|byte| char::from(*byte)).collect(),
        });
        index += 1 + length;
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// `text/plain` as Windows text: CF_TEXT's documented line ending is CR-LF (Windows synthesizes
/// CF_TEXT/CF_OEMTEXT from what is written here), and classic multi-line EDIT controls show bare-LF
/// text as a single line.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// The pixels-per-metre a PNG declares in its `pHYs` chunk (unit 1 = metre), if any. Copy As PNG
/// stamps the real print density there (e.g. 384 dpi for its 4x render).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn png_pixels_per_meter(png: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !png.starts_with(SIGNATURE) {
        return None;
    }
    let mut index = SIGNATURE.len();
    while index + 8 <= png.len() {
        let length = u32::from_be_bytes(png[index..index + 4].try_into().ok()?) as usize;
        let kind = &png[index + 4..index + 8];
        let data = png.get(index + 8..index + 8 + length)?;
        if kind == b"pHYs" && length == 9 {
            let x = u32::from_be_bytes(data[0..4].try_into().ok()?);
            let y = u32::from_be_bytes(data[4..8].try_into().ok()?);
            return (data[8] == 1 && x > 0 && y > 0).then_some((x, y));
        }
        if kind == b"IDAT" || kind == b"IEND" {
            // pHYs must precede the image data.
            return None;
        }
        index += 12 + length;
    }
    None
}

/// A PNG as a `CF_DIBV5` block: BITMAPV5HEADER + 32-bit BGRA pixels (bottom-up, alpha preserved),
/// for applications that paste bitmaps but not the registered `PNG` format (Paint, older Office).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn png_to_dibv5(png: &[u8]) -> Result<Vec<u8>, String> {
    const HEADER_SIZE: u32 = 124;
    const BI_BITFIELDS: u32 = 3;
    const LCS_SRGB: u32 = 0x7352_4742;
    const LCS_GM_IMAGES: u32 = 4;

    // into_rgba8 reuses an already-RGBA8 buffer (to_rgba8 cloned it: one more full-size copy of a
    // 4x render).
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|error| format!("Could not decode PNG for the clipboard: {error}"))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    let size_image = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|size| *size <= u32::MAX - HEADER_SIZE)
        .ok_or_else(|| format!("Image too large for the clipboard: {width}x{height}"))?;
    // Declare the PNG's own density: a hard-coded 72 dpi told bitmap-only readers that honor DIB
    // resolution (older Office, WordPad) a 384 dpi Copy As PNG was 5.3x its real size.
    let (pixels_per_meter_x, pixels_per_meter_y) =
        png_pixels_per_meter(png).unwrap_or((2835, 2835));

    let mut dib = Vec::with_capacity((HEADER_SIZE + size_image) as usize);
    let push = |dib: &mut Vec<u8>, value: u32| dib.extend_from_slice(&value.to_le_bytes());
    push(&mut dib, HEADER_SIZE); // bV5Size
    dib.extend_from_slice(&(width as i32).to_le_bytes()); // bV5Width
    dib.extend_from_slice(&(height as i32).to_le_bytes()); // bV5Height (positive: bottom-up)
    dib.extend_from_slice(&1u16.to_le_bytes()); // bV5Planes
    dib.extend_from_slice(&32u16.to_le_bytes()); // bV5BitCount
    push(&mut dib, BI_BITFIELDS); // bV5Compression
    push(&mut dib, size_image); // bV5SizeImage
    push(&mut dib, pixels_per_meter_x); // bV5XPelsPerMeter (72 dpi when the PNG has no pHYs)
    push(&mut dib, pixels_per_meter_y); // bV5YPelsPerMeter
    push(&mut dib, 0); // bV5ClrUsed
    push(&mut dib, 0); // bV5ClrImportant
    push(&mut dib, 0x00ff_0000); // bV5RedMask
    push(&mut dib, 0x0000_ff00); // bV5GreenMask
    push(&mut dib, 0x0000_00ff); // bV5BlueMask
    push(&mut dib, 0xff00_0000); // bV5AlphaMask
    push(&mut dib, LCS_SRGB); // bV5CSType
    dib.extend_from_slice(&[0u8; 36]); // bV5Endpoints (unused for sRGB)
    push(&mut dib, 0); // bV5GammaRed
    push(&mut dib, 0); // bV5GammaGreen
    push(&mut dib, 0); // bV5GammaBlue
    push(&mut dib, LCS_GM_IMAGES); // bV5Intent
    push(&mut dib, 0); // bV5ProfileData
    push(&mut dib, 0); // bV5ProfileSize
    push(&mut dib, 0); // bV5Reserved
    debug_assert_eq!(dib.len(), HEADER_SIZE as usize);

    for row in image.rows().rev() {
        for pixel in row {
            let [red, green, blue, alpha] = pixel.0;
            dib.extend_from_slice(&[blue, green, red, alpha]);
        }
    }
    Ok(dib)
}

#[cfg(windows)]
pub(crate) mod native {
    use super::*;
    use crate::{
        is_opaque_clipboard_type, ClipboardReadPayload, ClipboardTextItem, ClipboardWriteTextItem,
    };
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
        GetClipboardFormatNameW, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };

    /// An open clipboard, closed on drop. Another process can hold the clipboard for a moment
    /// (clipboard managers, RDP), so opening retries briefly before giving up.
    struct OpenedClipboard;

    impl OpenedClipboard {
        fn open(owner: HWND) -> Result<Self, String> {
            for _ in 0..10 {
                // SAFETY: plain Win32 call; `owner` is null or a live window handle.
                if unsafe { OpenClipboard(owner) } != 0 {
                    return Ok(Self);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err("The clipboard is in use by another application.".to_string())
        }
    }

    impl Drop for OpenedClipboard {
        fn drop(&mut self) {
            // SAFETY: this guard exists only while the clipboard is open on this thread.
            unsafe { CloseClipboard() };
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn format_name(id: u32) -> Option<String> {
        let mut buffer = [0u16; 256];
        // SAFETY: the buffer length passed matches the buffer.
        let length =
            unsafe { GetClipboardFormatNameW(id, buffer.as_mut_ptr(), buffer.len() as i32) };
        (length > 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    /// Copy of a clipboard handle's bytes (the clipboard still owns the handle).
    fn format_bytes(id: u32) -> Option<Vec<u8>> {
        // SAFETY: the clipboard is open; the handle stays owned by it and is only read while locked.
        unsafe {
            let handle = GetClipboardData(id);
            if handle.is_null() {
                return None;
            }
            let size = GlobalSize(handle as HGLOBAL);
            let pointer = GlobalLock(handle as HGLOBAL) as *const u8;
            if pointer.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(pointer, size).to_vec();
            GlobalUnlock(handle as HGLOBAL);
            Some(bytes)
        }
    }

    fn unicode_text() -> Option<String> {
        let bytes = format_bytes(CF_UNICODETEXT)?;
        let units = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect::<Vec<_>>();
        // Lossy: one unpaired surrogate (a truncated emoji) used to fail the whole decode, leaving
        // `text/plain` listed with no text — and a paste that silently did nothing.
        Some(String::from_utf16_lossy(&units)).filter(|text| !text.is_empty())
    }

    pub(crate) fn read_payload() -> Result<ClipboardReadPayload, String> {
        let _clipboard = OpenedClipboard::open(std::ptr::null_mut())?;
        let mut types = Vec::new();
        let mut text_items = Vec::new();

        let mut id = 0;
        loop {
            // SAFETY: the clipboard is open.
            id = unsafe { EnumClipboardFormats(id) };
            if id == 0 {
                break;
            }
            let name = format_name(id);
            let Some(payload_type) = payload_type_for_format(id, name.as_deref()) else {
                continue;
            };
            if types.contains(&payload_type) {
                continue;
            }
            types.push(payload_type.clone());

            let text = match name.as_deref() {
                None if id == CF_UNICODETEXT => unicode_text(),
                None => None,
                Some(MDLCT_FORMAT) => format_bytes(id).and_then(|bytes| decode_mdlct(&bytes)),
                Some(name) if is_binary_windows_format(name) || is_opaque_clipboard_type(name) => {
                    None
                }
                Some(_) => format_bytes(id).and_then(|bytes| decode_registered_text(&bytes)),
            };
            if let Some(text) = text {
                text_items.push(ClipboardTextItem {
                    r#type: payload_type,
                    text,
                });
            }
        }

        Ok(ClipboardReadPayload { types, text_items })
    }

    /// Hand `bytes` to the clipboard under `format`. On success the clipboard owns the memory; on
    /// failure it is freed here.
    fn set_bytes(format: u32, bytes: &[u8]) -> bool {
        // SAFETY: allocate, fill while locked, then transfer ownership via SetClipboardData.
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
            if memory.is_null() {
                return false;
            }
            let pointer = GlobalLock(memory) as *mut u8;
            if pointer.is_null() {
                GlobalFree(memory);
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
            GlobalUnlock(memory);
            if SetClipboardData(format, memory as HANDLE).is_null() {
                GlobalFree(memory);
                return false;
            }
            true
        }
    }

    fn registered(name: &str) -> u32 {
        // SAFETY: `wide` is NUL-terminated.
        unsafe { RegisterClipboardFormatW(wide(name).as_ptr()) }
    }

    /// Replace the clipboard with `items`, all in one transaction so readers see them together.
    /// `owner` must be a window: with a null owner, EmptyClipboard leaves no owner and every
    /// SetClipboardData after it fails.
    pub(crate) fn write_text_items(
        owner: HWND,
        items: &[ClipboardWriteTextItem],
    ) -> Result<(), String> {
        let _clipboard = OpenedClipboard::open(owner)?;
        // SAFETY: the clipboard is open with an owner window.
        if unsafe { EmptyClipboard() } == 0 {
            return Err("Could not clear the clipboard.".to_string());
        }

        let failed_types = items
            .iter()
            .filter(|item| {
                let written = match windows_target_for_payload_type(&item.r#type) {
                    WindowsTarget::Skip => true,
                    WindowsTarget::UnicodeText => {
                        let units = wide(&windows_line_endings(&item.text));
                        let bytes = units
                            .iter()
                            .flat_map(|unit| unit.to_le_bytes())
                            .collect::<Vec<_>>();
                        set_bytes(CF_UNICODETEXT, &bytes)
                    }
                    WindowsTarget::Registered(name) => {
                        let format = registered(&name);
                        let mut bytes = item.text.as_bytes().to_vec();
                        bytes.push(0);
                        format != 0 && set_bytes(format, &bytes)
                    }
                };
                !written
            })
            .map(|item| item.r#type.clone())
            .collect::<Vec<_>>();

        if failed_types.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Could not write clipboard text for type(s): {}",
                failed_types.join(", ")
            ))
        }
    }

    /// Replace the clipboard with an image: registered `PNG` (and `image/png`, which Chromium-based
    /// apps look for) keep transparency; `CF_DIBV5` serves bitmap-only readers, and Windows
    /// synthesizes `CF_DIB`/`CF_BITMAP` from it.
    pub(crate) fn write_png(owner: HWND, png: &[u8]) -> Result<(), String> {
        let dib = png_to_dibv5(png)?;
        let _clipboard = OpenedClipboard::open(owner)?;
        // SAFETY: the clipboard is open with an owner window.
        if unsafe { EmptyClipboard() } == 0 {
            return Err("Could not clear the clipboard.".to_string());
        }
        let png_ok = set_bytes(registered(PNG_FORMAT), png);
        let mime_ok = set_bytes(registered("image/png"), png);
        let dib_ok = set_bytes(CF_DIBV5, &dib);
        if png_ok || mime_ok || dib_ok {
            Ok(())
        } else {
            Err("Could not write PNG data to the clipboard.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_standard_and_registered_formats_to_payload_types() {
        assert_eq!(
            payload_type_for_format(CF_UNICODETEXT, None).as_deref(),
            Some("text/plain")
        );
        assert_eq!(payload_type_for_format(CF_TEXT, None), None);
        assert_eq!(payload_type_for_format(CF_LOCALE, None), None);
        assert_eq!(
            payload_type_for_format(CF_DIBV5, None).as_deref(),
            Some("image/bmp")
        );
        assert_eq!(
            payload_type_for_format(0xC100, Some("PNG")).as_deref(),
            Some("image/png")
        );
        assert_eq!(
            payload_type_for_format(0xC101, Some("ChemDraw Interchange Format")).as_deref(),
            Some("chemical/x-cdx")
        );
        assert_eq!(
            payload_type_for_format(0xC102, Some("MDLCT")).as_deref(),
            Some("chemical/x-mdl-molfile")
        );
        assert_eq!(
            payload_type_for_format(0xC103, Some("application/x-chemdraft-selection+json"))
                .as_deref(),
            Some("application/x-chemdraft-selection+json")
        );
    }

    #[test]
    fn writes_plain_text_as_unicode_and_skips_the_svg_alias() {
        assert_eq!(
            windows_target_for_payload_type("text/plain"),
            WindowsTarget::UnicodeText
        );
        assert_eq!(
            windows_target_for_payload_type("public.svg-image"),
            WindowsTarget::Skip
        );
        assert_eq!(
            windows_target_for_payload_type("image/svg+xml"),
            WindowsTarget::Registered("image/svg+xml".to_string())
        );
    }

    #[test]
    fn binary_formats_are_not_decoded_as_text() {
        assert!(is_binary_windows_format("PNG"));
        assert!(is_binary_windows_format("ChemDraw Interchange Format"));
        assert!(is_binary_windows_format("image/png"));
        assert!(!is_binary_windows_format("image/svg+xml"));
        assert!(!is_binary_windows_format(
            "application/x-chemdraft-selection+json"
        ));
    }

    #[test]
    fn decodes_registered_utf8_c_strings_without_utf16_misreads() {
        // "abc\0" satisfies the shared decoder's UTF-16 heuristics; UTF-8 must win.
        assert_eq!(decode_registered_text(b"abc\0").as_deref(), Some("abc"));
        assert_eq!(
            decode_registered_text(b"{\"a\":1}\0\0\0\0").as_deref(),
            Some("{\"a\":1}")
        );
        assert_eq!(
            decode_registered_text("<svg>é</svg>\0".as_bytes()).as_deref(),
            Some("<svg>é</svg>")
        );
        assert_eq!(decode_registered_text(b"\0\0"), None);
    }

    #[test]
    fn decodes_registered_utf16_with_its_terminator() {
        let bytes = "CCO\n"
            .encode_utf16()
            .chain([0u16])
            .flat_map(|unit| unit.to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(decode_registered_text(&bytes).as_deref(), Some("CCO\n"));
    }

    #[test]
    fn decodes_mdl_clip_text_lines() {
        let mut bytes = Vec::new();
        for line in [
            "",
            "  ChemDraft",
            "",
            "  0  0  0  0  0  0  0  0  0  0999 V2000",
            "M  END",
        ] {
            bytes.push(line.len() as u8);
            bytes.extend_from_slice(line.as_bytes());
        }
        assert_eq!(
            decode_mdlct(&bytes).as_deref(),
            Some("\n  ChemDraft\n\n  0  0  0  0  0  0  0  0  0  0999 V2000\nM  END")
        );
        // A length running past the end is not MDLCT.
        assert_eq!(decode_mdlct(&[5, b'a']), None);
    }

    #[test]
    fn shell_and_office_bookkeeping_formats_are_not_text() {
        // An Explorer file copy: these used to decode into junk text objects on paste.
        for name in [
            "DataObject",
            "Preferred DropEffect",
            "FileName",
            "FileNameW",
            "Shell IDList Array",
            "Chromium internal source URL",
            "Biff12",
            "Art::GVML ClipFormat",
            "CanIncludeInClipboardHistory",
        ] {
            assert!(is_binary_windows_format(name), "{name}");
        }
        assert!(!is_binary_windows_format("HTML Format"));
        assert!(!is_binary_windows_format("MDLCT"));
    }

    #[test]
    fn binary_dwords_never_decode_as_text() {
        assert_eq!(decode_registered_text(&[5, 0, 0, 0]), None);
        assert_eq!(decode_registered_text(&[1, 0, 0, 0]), None);
        assert_eq!(
            decode_registered_text(&[0x74, 0x02, 0x07, 0x00, 0, 0, 0, 0]),
            None
        );
    }

    #[test]
    fn registered_text_ignores_slack_after_its_terminator() {
        assert_eq!(
            decode_registered_text(b"CCO\0\x13\x7f").as_deref(),
            Some("CCO")
        );
    }

    #[test]
    fn mdl_clip_text_survives_code_page_bytes_and_padding() {
        let mut bytes = Vec::new();
        for line in [b"".as_slice(), b"  25\xb0C sample", b"", b"M  END"] {
            bytes.push(line.len() as u8);
            bytes.extend_from_slice(line);
        }
        let mut padded = bytes.clone();
        padded.extend_from_slice(&[0, 0, 0, 0]);
        let decoded = decode_mdlct(&padded).expect("molfile");
        assert_eq!(decoded, "\n  25\u{b0}C sample\n\nM  END");
        // Garbage after a complete molfile keeps the molfile.
        let mut trailing = bytes;
        trailing.extend_from_slice(&[9, b'x']);
        assert_eq!(decode_mdlct(&trailing).as_deref(), Some(decoded.as_str()));
    }

    #[test]
    fn plain_text_is_written_with_windows_line_endings() {
        assert_eq!(windows_line_endings("a\nb\r\nc"), "a\r\nb\r\nc");
    }

    #[test]
    fn reads_the_density_a_png_declares() {
        let mut image = image::RgbaImage::new(1, 1);
        image.put_pixel(0, 0, image::Rgba([0, 0, 0, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode png");
        assert_eq!(png_pixels_per_meter(&png), None);

        // Insert a pHYs chunk (15118 px/m = 384 dpi) right after IHDR, as export.rs does.
        let ihdr_end = 8 + 12 + 13;
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&9u32.to_be_bytes());
        chunk.extend_from_slice(b"pHYs");
        chunk.extend_from_slice(&15118u32.to_be_bytes());
        chunk.extend_from_slice(&15118u32.to_be_bytes());
        chunk.push(1);
        chunk.extend_from_slice(&[0, 0, 0, 0]); // CRC is not checked by the reader
        let mut stamped = png[..ihdr_end].to_vec();
        stamped.extend_from_slice(&chunk);
        stamped.extend_from_slice(&png[ihdr_end..]);
        assert_eq!(png_pixels_per_meter(&stamped), Some((15118, 15118)));
    }

    #[test]
    fn converts_png_to_a_bottom_up_bgra_dibv5() {
        let mut image = image::RgbaImage::new(2, 1);
        image.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, image::Rgba([0, 0, 255, 128]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode png");

        let dib = png_to_dibv5(&png).expect("dib");
        assert_eq!(u32::from_le_bytes(dib[0..4].try_into().unwrap()), 124);
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(dib[14..16].try_into().unwrap()), 32);
        assert_eq!(dib.len(), 124 + 2 * 4);
        // BGRA: red pixel, then half-transparent blue.
        assert_eq!(&dib[124..128], &[0, 0, 255, 255]);
        assert_eq!(&dib[128..132], &[255, 0, 0, 128]);
    }
}
