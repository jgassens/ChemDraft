//! The Windows clipboard, translated to and from the payload types the TS clipboard adapter already
//! understands (the macOS reader hands it pasteboard UTIs; this hands it MIME-style names).
//!
//! | payload type                                 | Windows clipboard format                  |
//! |----------------------------------------------|-------------------------------------------|
//! | `text/plain`                                 | `CF_UNICODETEXT`                          |
//! | `image/png`                                  | registered `PNG` (required); `image/png` and `CF_DIBV5` best effort |
//! | `chemical/x-cdx`                             | registered `ChemDraw Interchange Format`  |
//! | `chemical/x-mdl-molfile`                     | registered `MDLCT` (length-prefixed lines)|
//! | `text/html`                                  | `HTML Format` (CF_HTML byte offsets; header stripped on read) |
//! | `text/rtf`                                   | `Rich Text Format` (ASCII + NUL)           |
//! | anything else (`image/svg+xml`, ChemDraft's  | a registered format of the same name,     |
//! | selection JSON, other apps' formats)         | UTF-8 + NUL for text, raw bytes for binary |
//! | `public.svg-image`                           | skipped (macOS alias for `image/svg+xml`) |
//!
//! The ChemDraw and MDL names are what those apps are documented to register; confirm against a real
//! ChemDraw for Windows. Unknown names pass through unchanged, so a wrong guess costs a detection,
//! never data.
//!
//! The pure translation helpers below compile and are tested on every platform; the Win32 calls live
//! in [`native`].

use super::{decode_clipboard_text_bytes, text_is_plausible_clipboard_text};
#[cfg(any(windows, test))]
use crate::clipboard_formats::{windows_target_for_payload_type, WindowsTarget};

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

/// Native PNG is preferred, followed by the MIME alias ChemDraft also writes, then DIBs.
/// Registered IDs are injected so this order can be tested without the Windows clipboard.
#[cfg_attr(not(windows), allow(dead_code))]
fn image_read_formats(png_id: u32, mime_png_id: u32, svg_id: u32) -> [(&'static str, u32); 5] {
    [
        (PNG_FORMAT, png_id),
        ("image/png", mime_png_id),
        ("CF_DIBV5", CF_DIBV5),
        ("CF_DIB", CF_DIB),
        ("image/svg+xml", svg_id),
    ]
}

/// Formats whose bytes are never text a user meant to paste: list them as types, but do not fetch
/// or decode them. Besides binary payloads this covers the shell's and OLE's bookkeeping formats —
/// an Explorer file copy carries `DataObject` (a window handle), `Preferred DropEffect` (a DWORD)
/// and `FileName` (an 8.3 path), which the text fallback used to turn into a junk text object — and
/// the formats Office renders on demand: fetching those makes Excel/Word/PowerPoint serialize the
/// whole selection again (WM_RENDERFORMAT) while ChemDraft's thread waits, for nothing it can use.
const NON_TEXT_FORMATS: [&str; 41] = [
    PNG_FORMAT,
    CDX_FORMAT,
    "Embedded Object",
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
    // Word's second copies of its RTF, rendered on demand; "Rich Text Format" carries it once.
    "Rich Text Format Without Objects",
    "RTF As Text",
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

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_binary_windows_format(name: &str) -> bool {
    NON_TEXT_FORMATS.contains(&name)
        || NON_TEXT_FORMAT_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        || crate::clipboard_images::is_image_clipboard_type(name) && name != "image/svg+xml"
}

/// The shared admission priority of a format, before any preview of its bytes. Binary and opaque
/// registered formats are never read; HTML Format and Rich Text Format are (see
/// `clipboard_limits::clipboard_read_steps`).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_text_read_priority(payload_type: &str, name: Option<&str>) -> Option<u8> {
    if name
        .is_some_and(|name| is_binary_windows_format(name) || crate::is_opaque_clipboard_type(name))
    {
        return None;
    }
    crate::clipboard_limits::text_read_priority(payload_type)
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
/// Refuse corrupt or unrepresentable metadata before preparing any native clipboard formats.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn png_pixels_per_meter(png: &[u8]) -> Result<Option<(u32, u32)>, String> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    let malformed = || "Malformed PNG density metadata.".to_string();
    if !png.starts_with(SIGNATURE) {
        return Err(malformed());
    }
    let mut index = SIGNATURE.len();
    let mut density = None;
    let mut seen_density = false;
    let mut seen_image = false;
    while index + 8 <= png.len() {
        let length = u32::from_be_bytes(png[index..index + 4].try_into().unwrap()) as usize;
        let kind = &png[index + 4..index + 8];
        let data_end = (index + 8).checked_add(length).ok_or_else(malformed)?;
        let chunk_end = data_end.checked_add(4).ok_or_else(malformed)?;
        let chunk = png.get(index + 4..chunk_end).ok_or_else(malformed)?;
        if kind == b"pHYs" {
            // PNG permits a single pHYs chunk, before the image data.
            if length != 9 || seen_density || seen_image {
                return Err(malformed());
            }
            seen_density = true;
            let crc = u32::from_be_bytes(png[data_end..chunk_end].try_into().unwrap());
            if png_crc32(&chunk[..4 + length]) != crc {
                return Err("PNG density metadata has an invalid CRC.".into());
            }
            let data = &png[index + 8..data_end];
            let x = u32::from_be_bytes(data[0..4].try_into().unwrap());
            let y = u32::from_be_bytes(data[4..8].try_into().unwrap());
            if data[8] == 1 {
                density = (x > 0 && y > 0).then_some((x, y));
            }
        }
        index = chunk_end;
        if kind == b"IDAT" {
            seen_image = true;
        } else if kind == b"IEND" {
            return Ok(density);
        }
    }
    Err(malformed())
}

// Clipboard compatibility extras are optional: cap each dimension at 16384 pixels and the
// decoded RGBA buffer at 256 MiB, independently of the compressed clipboard byte limit.
const MAX_PNG_SIDE: u32 = 16_384;
const MAX_PNG_DECODED_BYTES: u64 = 256 * 1024 * 1024;

fn png_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn png_size_limit_error(width: u32, height: u32) -> String {
    format!(
        "picture {width}x{height} exceeds the {MAX_PNG_SIDE}-pixel per-side or {MAX_PNG_DECODED_BYTES}-byte decode limit."
    )
}

fn png_decode_error(error: image::ImageError, width: u32, height: u32) -> String {
    if matches!(&error, image::ImageError::Limits(limit)
        if matches!(limit.kind(), image::error::LimitErrorKind::InsufficientMemory))
    {
        png_size_limit_error(width, height)
    } else {
        format!("could not decode PNG: {error}.")
    }
}

/// Inspect the complete first IHDR without allocating or invoking an image decoder.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn bounded_png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    let malformed = || "malformed PNG IHDR.".to_string();
    let header = png.get(..33).ok_or_else(malformed)?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n"
        || &header[8..16] != b"\0\0\0\rIHDR"
        || png_crc32(&header[12..29]) != u32::from_be_bytes(header[29..33].try_into().unwrap())
        || !matches!(
            (header[25], header[24]),
            (0, 1 | 2 | 4 | 8 | 16) | (2 | 4 | 6, 8 | 16) | (3, 1 | 2 | 4 | 8)
        )
        || header[26] != 0
        || header[27] != 0
        || header[28] > 1
    {
        return Err(malformed());
    }
    let width = u32::from_be_bytes(header[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(header[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err(malformed());
    }
    if width > MAX_PNG_SIDE
        || height > MAX_PNG_SIDE
        || u64::from(width) * u64::from(height) * 4 > MAX_PNG_DECODED_BYTES
    {
        return Err(png_size_limit_error(width, height));
    }
    Ok((width, height))
}

/// A PNG as a `CF_DIBV5` block: BITMAPV5HEADER + 32-bit BGRA pixels (bottom-up, alpha preserved),
/// for applications that paste bitmaps but not the registered `PNG` format (Paint, older Office).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn png_to_dibv5(png: &[u8]) -> Result<Vec<u8>, String> {
    const HEADER_SIZE: u32 = 124;
    const BI_BITFIELDS: u32 = 3;
    const LCS_SRGB: u32 = 0x7352_4742;
    const LCS_GM_IMAGES: u32 = 4;

    let (width, height) = bounded_png_dimensions(png)?;
    // Declare the PNG's own density: a hard-coded 72 dpi told bitmap-only readers that honor DIB
    // resolution (older Office, WordPad) a 384 dpi Copy As PNG was 5.3x its real size.
    let (pixels_per_meter_x, pixels_per_meter_y) =
        png_pixels_per_meter(png)?.unwrap_or((2835, 2835));
    // DIB is an optional sibling. PNG can retain the full unsigned pHYs range.
    if pixels_per_meter_x > i32::MAX as u32 || pixels_per_meter_y > i32::MAX as u32 {
        return Err("PNG density exceeds the signed DIB range.".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PNG_SIDE);
    limits.max_image_height = Some(MAX_PNG_SIDE);
    limits.max_alloc = Some(MAX_PNG_DECODED_BYTES);
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(png), image::ImageFormat::Png);
    reader.limits(limits);
    // into_rgba8 reuses an already-RGBA8 buffer (to_rgba8 cloned it: one more full-size copy of a
    // 4x render).
    let image = reader
        .decode()
        .map_err(|error| png_decode_error(error, width, height))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    let size_image = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|size| *size <= u32::MAX - HEADER_SIZE)
        .ok_or_else(|| format!("Image too large for the clipboard: {width}x{height}"))?;
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

/// One optional clipboard read at a time per worker, on a long-lived thread made on first use.
/// OLE and delayed Win32 rendering can block inside another program. A read that outlives its
/// paste's wait stays outstanding, and later pastes skip that worker ([`Flight::Busy`]) until the
/// read returns. Host-neutral, so it is tested on every platform.
#[cfg(any(windows, test))]
mod single_flight {
    use std::{
        panic::{catch_unwind, AssertUnwindSafe},
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Mutex, PoisonError,
        },
        time::Duration,
    };

    type Job<J, R> = (J, mpsc::Sender<R>);

    pub(super) struct SingleFlight<J, R> {
        name: &'static str,
        work: fn(J) -> R,
        /// A read is outstanding. Set by the paste that starts it; cleared by the reader thread
        /// once the read returns, whether or not that paste still waits for it.
        busy: AtomicBool,
        /// The reader thread's queue, once it started.
        queue: Mutex<Option<mpsc::Sender<Job<J, R>>>>,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Flight<R> {
        Done(R),
        /// A read an earlier paste started has not returned, so none was started.
        Busy,
        /// No answer within the wait. The read stays outstanding, and `Busy`, until it returns.
        TimedOut,
        /// The reader thread could not start, or stopped during the read.
        Failed(String),
    }

    impl<J: Send + 'static, R: Send + 'static> SingleFlight<J, R> {
        pub(super) const fn new(name: &'static str, work: fn(J) -> R) -> Self {
            Self {
                name,
                work,
                busy: AtomicBool::new(false),
                queue: Mutex::new(None),
            }
        }

        pub(super) fn is_busy(&self) -> bool {
            self.busy.load(Ordering::Acquire)
        }

        /// Waits at most `wait`, and never for a read an earlier paste started.
        pub(super) fn read(&'static self, job: J, wait: Duration) -> Flight<R> {
            if self.busy.swap(true, Ordering::AcqRel) {
                return Flight::Busy;
            }
            let (reply, answer) = mpsc::channel();
            if let Err(error) = self.send((job, reply)) {
                self.busy.store(false, Ordering::Release);
                return Flight::Failed(error);
            }
            match answer.recv_timeout(wait) {
                Ok(result) => Flight::Done(result),
                Err(mpsc::RecvTimeoutError::Timeout) => Flight::TimedOut,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    Flight::Failed(format!("{} stopped during the read", self.name))
                }
            }
        }

        /// Hand the job to the reader thread, starting it on first use or after it stopped.
        fn send(&'static self, job: Job<J, R>) -> Result<(), String> {
            let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
            if queue.is_none() {
                let (sender, jobs) = mpsc::channel();
                std::thread::Builder::new()
                    .name(self.name.into())
                    .spawn(move || self.serve(jobs))
                    .map_err(|error| format!("Could not start {}: {error}", self.name))?;
                *queue = Some(sender);
            }
            if queue
                .as_ref()
                .is_some_and(|sender| sender.send(job).is_ok())
            {
                return Ok(());
            }
            *queue = None;
            Err(format!("{} has stopped", self.name))
        }

        fn serve(&'static self, jobs: mpsc::Receiver<Job<J, R>>) {
            for (job, reply) in jobs {
                let result = catch_unwind(AssertUnwindSafe(|| (self.work)(job)));
                // Free before answering, so the paste that gets this answer can read again.
                self.busy.store(false, Ordering::Release);
                if let Ok(result) = result {
                    // The paste may have stopped waiting.
                    let _ = reply.send(result);
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            thread::{self, ThreadId},
            time::Instant,
        };

        type Gate = Option<mpsc::Receiver<()>>;
        type TestReader = SingleFlight<(u32, Gate), (u32, ThreadId)>;

        /// Waits for its gate, if any; panics on 0.
        fn doubled((value, gate): (u32, Gate)) -> (u32, ThreadId) {
            if let Some(gate) = gate {
                let _ = gate.recv();
            }
            assert_ne!(value, 0, "a deliberate panic: this OLE read failed");
            (value * 2, thread::current().id())
        }

        fn reader() -> &'static TestReader {
            Box::leak(Box::new(SingleFlight::new(
                "ChemDraft OLE paste (test)",
                doubled,
            )))
        }

        fn wait_until_free(reader: &TestReader) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while reader.is_busy() {
                assert!(Instant::now() < deadline, "the read never returned");
                thread::sleep(Duration::from_millis(1));
            }
        }

        const WAIT: Duration = Duration::from_secs(10);

        /// A read that outlives its paste's wait keeps later pastes off OLE, without making
        /// them wait, until it returns. Every read runs on one thread, made on first use.
        #[test]
        fn one_ole_read_at_a_time_on_one_thread_and_later_pastes_skip_a_late_read() {
            let reader = reader();
            assert!(
                reader.queue.lock().unwrap().is_none(),
                "no thread before a paste"
            );
            let Flight::Done((4, ole_thread)) = reader.read((2, None), WAIT) else {
                panic!("the first read answers");
            };
            assert_ne!(ole_thread, thread::current().id());

            let (release, gate) = mpsc::channel();
            let short = Duration::from_millis(20);
            assert_eq!(reader.read((3, Some(gate)), short), Flight::TimedOut);
            let started = Instant::now();
            assert_eq!(reader.read((4, None), WAIT), Flight::Busy);
            assert_eq!(reader.read((5, None), WAIT), Flight::Busy);
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "Busy never waits"
            );

            release.send(()).unwrap();
            wait_until_free(reader);
            assert_eq!(reader.read((6, None), WAIT), Flight::Done((12, ole_thread)));
        }

        #[test]
        fn a_failed_ole_read_frees_the_reader_for_the_next_paste() {
            let reader = reader();
            let Flight::Failed(reason) = reader.read((0, None), WAIT) else {
                panic!("a read that panics fails");
            };
            assert_eq!(reason, "ChemDraft OLE paste (test) stopped during the read");
            wait_until_free(reader);
            assert!(matches!(
                reader.read((7, None), WAIT),
                Flight::Done((14, _))
            ));
        }
    }
}

#[cfg(windows)]
pub(crate) mod native {
    use super::single_flight::{Flight, SingleFlight};
    use super::*;
    use crate::clipboard_formats::{
        build_cf_html, clipboard_utf8, parse_cf_html, ClipboardWriteData, ClipboardWriteResult,
        ValidatedClipboardItem,
    };
    use crate::clipboard_images::{
        dib_image_item, office_archive_item, office_embedded_object_item,
        office_embedded_object_type, office_picture_archive_type, png_image_item, svg_image_item,
        ClipboardImageItem, ClipboardOfficeItem, SkippedClipboardImageItem,
        MAX_OFFICE_ARCHIVE_BYTES,
    };
    use crate::clipboard_limits::{ClipboardReadBudget, ClipboardReadStep, SkippedClipboardItem};
    use crate::{is_opaque_clipboard_type, ClipboardReadPayload, ClipboardTextItem};
    use std::{num::NonZeroU32, time::Duration};
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
        GetClipboardFormatNameW, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };

    /// Why the clipboard would not open, when nothing of ChemDraft's own is known to hold it.
    const CLIPBOARD_IN_USE: &str = "The clipboard is in use by another application.";

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
            Err(CLIPBOARD_IN_USE.to_string())
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

    fn is_text_alias(id: u32, admitted: &[ClipboardTextItem]) -> bool {
        // SAFETY: caller holds the clipboard open; no pointer survives GlobalUnlock.
        unsafe {
            let handle = GetClipboardData(id);
            if handle.is_null() {
                return false;
            }
            let size = GlobalSize(handle as HGLOBAL);
            let pointer = GlobalLock(handle as HGLOBAL) as *const u8;
            if pointer.is_null() {
                return false;
            }
            let alias = crate::clipboard_limits::is_admitted_text_alias(
                std::slice::from_raw_parts(pointer, size),
                admitted,
            );
            GlobalUnlock(handle as HGLOBAL);
            alias
        }
    }

    fn decode_format(
        id: u32,
        source: &str,
        budget: &mut ClipboardReadBudget,
        decode: impl FnOnce(&[u8]) -> Option<String>,
    ) -> Option<String> {
        // Decode directly from the locked OS-owned buffer. There is no ChemDraft Vec
        // alive alongside the decoded String, so the native and decoded reservations
        // describe successive owned allocations rather than an unaccounted peak.
        // SAFETY: read_payload holds the clipboard open. No borrowed bytes escape the lock.
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
            let bytes = std::slice::from_raw_parts(pointer, size);
            let reservation = if id == CF_UNICODETEXT {
                budget.reserve_utf16_allocation(source, size, unicode_text_utf8_length(bytes))
            } else if source != "chemical/x-mdl-molfile"
                && (source.contains("utf16")
                    || crate::looks_like_utf16_bytes(&bytes[..bytes.len().min(8192)]))
            {
                budget.reserve_utf16_allocation(
                    source,
                    size,
                    crate::clipboard_limits::utf16_utf8_byte_length(bytes),
                )
            } else {
                budget.reserve(source, size).map(|()| size)
            };
            let text = match reservation {
                Ok(reserved) => {
                    let text = decode(bytes);
                    budget.release(reserved);
                    text
                }
                Err(_) => {
                    budget.mark_chemistry(source, bytes);
                    None
                }
            };
            GlobalUnlock(handle as HGLOBAL);
            // The caller checks and reserves the retained UTF-8 size.
            text
        }
    }

    fn unicode_text_utf8_length(bytes: &[u8]) -> usize {
        let units = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0);
        char::decode_utf16(units)
            .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
            .sum()
    }

    fn unicode_text(bytes: &[u8]) -> Option<String> {
        let units = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0);
        // Preserve the existing lossy-surrogate behavior without an intermediate Vec<u16>.
        let text: String = char::decode_utf16(units)
            .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        (!text.is_empty()).then_some(text)
    }

    /// Check the allocation size before copying image bytes, including SVG used as text.
    fn image_format_bytes(
        id: u32,
        source: &str,
        kind: &str,
        budget: &mut ClipboardReadBudget,
    ) -> Result<Vec<u8>, SkippedClipboardImageItem> {
        let refused = |length, reason| SkippedClipboardImageItem::new(kind, length, reason);
        // SAFETY: read_payload holds the clipboard open. The clipboard owns the handle; the
        // pointer is read only while locked and the copied slice fits its GlobalSize allocation.
        unsafe {
            let handle = GetClipboardData(id);
            if handle.is_null() {
                return Err(refused(
                    0,
                    format!("Could not read {source} clipboard data"),
                ));
            }
            let size = GlobalSize(handle as HGLOBAL);
            if source == "image/svg+xml" {
                budget.reserve_svg_allocation(source, size)
            } else {
                budget.reserve(source, size)
            }
            .map_err(|reason| refused(size, reason))?;
            let pointer = GlobalLock(handle as HGLOBAL) as *const u8;
            if pointer.is_null() {
                budget.release(size);
                return Err(refused(
                    size,
                    format!("Could not lock {source} clipboard data"),
                ));
            }
            let bytes = std::slice::from_raw_parts(pointer, size).to_vec();
            GlobalUnlock(handle as HGLOBAL);
            Ok(bytes)
        }
    }

    fn read_images(
        budget: &mut ClipboardReadBudget,
    ) -> (Vec<ClipboardImageItem>, Vec<SkippedClipboardImageItem>) {
        let mut items = Vec::new();
        let mut skipped = Vec::new();
        for (source, id) in image_read_formats(
            registered(PNG_FORMAT),
            registered("image/png"),
            registered("image/svg+xml"),
        ) {
            let kind = if source == "image/svg+xml" {
                "image/svg+xml"
            } else {
                "image/png"
            };
            if items
                .iter()
                .any(|item: &ClipboardImageItem| item.r#type == kind)
            {
                continue;
            }
            // SAFETY: format IDs are standard or returned by RegisterClipboardFormatW.
            if id == 0 || unsafe { IsClipboardFormatAvailable(id) } == 0 {
                continue;
            }
            let result = image_format_bytes(id, source, kind, budget).and_then(|bytes| {
                let item = match source {
                    PNG_FORMAT | "image/png" => png_image_item(&bytes),
                    "image/svg+xml" => svg_image_item(&bytes, source),
                    _ => dib_image_item(&bytes, source),
                };
                // Replace the SVG allocation reservation even when conversion fails.
                if source == "image/svg+xml" {
                    budget.release(bytes.len());
                }
                let item = item.and_then(|item| {
                    if source == "image/svg+xml" {
                        budget.reserve(source, item.retained_byte_length())?;
                    }
                    Ok(item)
                });
                item.map_err(|reason| {
                    if source != "image/svg+xml" {
                        budget.release(bytes.len());
                    }
                    SkippedClipboardImageItem::new(kind, bytes.len(), reason)
                })
            });
            match result {
                Ok(item) => {
                    items.push(item);
                    break;
                }
                Err(reason) => skipped.push(reason),
            }
        }
        (items, skipped)
    }

    fn text_read_priority(id: u32, kind: &str, name: Option<&str>) -> Option<u8> {
        let priority = windows_text_read_priority(kind, name);
        if priority != Some(2) {
            return priority;
        }
        // SAFETY: read_payload holds the clipboard open. Preview at most 8 KiB,
        // without copying the allocation or keeping the clipboard pointer.
        unsafe {
            let handle = GetClipboardData(id);
            if handle.is_null() {
                return priority;
            }
            let size = GlobalSize(handle as HGLOBAL);
            let pointer = GlobalLock(handle as HGLOBAL) as *const u8;
            if pointer.is_null() {
                return priority;
            }
            let priority = crate::clipboard_limits::text_priority_with_preview(
                kind,
                std::slice::from_raw_parts(pointer, size.min(8192)),
            );
            GlobalUnlock(handle as HGLOBAL);
            priority
        }
    }

    // GetClipboardData can wait for Office to render GVML even when the PNG is already readable.
    const OFFICE_ARCHIVE_TIMEOUT: Duration = Duration::from_secs(1);

    struct ArchiveRequest {
        source: &'static str,
        sequence: NonZeroU32,
        budget: ClipboardReadBudget,
    }

    struct ArchiveRead {
        item: Result<Option<ClipboardOfficeItem>, String>,
        skipped_items: Vec<SkippedClipboardItem>,
    }

    static ARCHIVE_READER: SingleFlight<ArchiveRequest, ArchiveRead> =
        SingleFlight::new("ChemDraft Office archive paste", read_archive_request);

    fn clipboard_sequence() -> Option<NonZeroU32> {
        // SAFETY: plain Win32 call; zero means the sequence could not be determined.
        NonZeroU32::new(unsafe { GetClipboardSequenceNumber() })
    }

    fn read_archive_request(mut request: ArchiveRequest) -> ArchiveRead {
        let item = read_office_archive(request.source, request.sequence, &mut request.budget);
        ArchiveRead {
            item,
            skipped_items: request.budget.skipped_items,
        }
    }

    /// The archive keeps the carrier the PNG rendition may have dropped. Checking the sequence
    /// under the Win32 lock ties it to the snapshot. The lock prevents replacement during the
    /// read, even if rendering this advertised format advances the sequence.
    fn read_office_archive(
        source: &str,
        sequence: NonZeroU32,
        budget: &mut ClipboardReadBudget,
    ) -> Result<Option<ClipboardOfficeItem>, String> {
        let _clipboard = OpenedClipboard::open(std::ptr::null_mut())?;
        if clipboard_sequence() != Some(sequence) {
            return Ok(None);
        }
        let id = registered(source);
        // SAFETY: this thread holds the clipboard open and the ID came from
        // RegisterClipboardFormatW. The pointer is read only while locked, within GlobalSize.
        unsafe {
            if id == 0 || IsClipboardFormatAvailable(id) == 0 {
                return Ok(None);
            }
            let handle = GetClipboardData(id);
            if handle.is_null() {
                return Err(format!("Could not read {source} clipboard data"));
            }
            let size = GlobalSize(handle as HGLOBAL);
            if size > MAX_OFFICE_ARCHIVE_BYTES {
                return Err(format!("{source} is over the 32 MB limit"));
            }
            budget.reserve(source, size)?;
            let pointer = GlobalLock(handle as HGLOBAL) as *const u8;
            if pointer.is_null() {
                return Err(format!("Could not lock {source} clipboard data"));
            }
            // GlobalSize may include padding after the archive; the TypeScript reader trims it.
            let item = office_archive_item(source, std::slice::from_raw_parts(pointer, size));
            GlobalUnlock(handle as HGLOBAL);
            item.map(Some)
        }
    }

    fn finish_archive_read(payload: &mut ClipboardReadPayload, outcome: Flight<ArchiveRead>) {
        let reason = match outcome {
            Flight::Done(read) => {
                payload.skipped_items.extend(read.skipped_items);
                match read.item {
                    Ok(item) => {
                        payload.office_items.extend(item);
                        return;
                    }
                    Err(reason) => reason,
                }
            }
            Flight::Busy => "an earlier archive read is unfinished".into(),
            Flight::TimedOut => "the archive was not ready within 1 second".into(),
            Flight::Failed(reason) => reason,
        };
        eprintln!("Paste-back skipped the Office picture archive: {reason}");
    }

    /// How long paste waits for Word or PowerPoint to hand over a copied object.
    const EMBEDDED_OBJECT_TIMEOUT: Duration = Duration::from_secs(10);

    /// The class and drawing of a copied ChemDraft object, or why it could not be read.
    type OleDrawing = (&'static str, String);
    type OleRead = Result<Option<OleDrawing>, String>;

    /// OLE needs a single-threaded apartment, which this command's worker thread may not be. One
    /// shared reader thread does every OLE read, one at a time.
    static OLE_READER: SingleFlight<(&'static str, NonZeroU32), OleRead> =
        SingleFlight::new("ChemDraft OLE paste", read_ole_object);

    /// Paste's answer when only an earlier, unfinished OLE or archive read stood between it and
    /// the data.
    const STILL_READING: &str =
        "Windows is still reading the previous clipboard item. Try pasting again in a moment.";

    /// Paste's answer when the clipboard would not open. An unfinished optional read may be what
    /// holds it: the OLE reader while Word or PowerPoint hands over an object, and the archive
    /// reader, which keeps the clipboard open while Office renders GVML, past its paste's
    /// 1-second wait. Only the thread that opened the clipboard may close it, so paste waits
    /// for that read to return rather than closing it.
    fn paste_open_error(error: String, ole_busy: bool, archive_busy: bool) -> String {
        if ole_busy || archive_busy {
            STILL_READING.into()
        } else {
            error
        }
    }

    /// Open the clipboard on this paste's thread, naming an unfinished optional read as the
    /// reason when one may be what holds it.
    fn open_for_paste() -> Result<OpenedClipboard, String> {
        OpenedClipboard::open(std::ptr::null_mut()).map_err(|error| {
            paste_open_error(error, OLE_READER.is_busy(), ARCHIVE_READER.is_busy())
        })
    }

    /// The OLE read is still outstanding after this paste's wait, or was already outstanding.
    #[derive(Debug)]
    struct StillReading;

    /// OLE opens the clipboard itself, so the ordinary snapshot's lock must have been released.
    /// Reopen it to confirm that the result still belongs to that snapshot before using it.
    fn read_embedded_object(
        source: &'static str,
        sequence: NonZeroU32,
    ) -> Result<Option<ClipboardOfficeItem>, StillReading> {
        let outcome = OLE_READER.read((source, sequence), EMBEDDED_OBJECT_TIMEOUT);
        let Some((clsid, json)) = finish_ole_read(source, outcome)? else {
            return Ok(None);
        };
        {
            // An earlier paste's unfinished archive read may hold the clipboard.
            let _clipboard = match open_for_paste() {
                Ok(clipboard) => clipboard,
                Err(error) if error == STILL_READING => return Err(StillReading),
                Err(_) => return Ok(None),
            };
            if clipboard_sequence() != Some(sequence) {
                return Ok(None);
            }
        }
        Ok(Some(office_embedded_object_item(source, clsid, &json)))
    }

    fn finish_ole_read(
        source: &str,
        outcome: Flight<OleRead>,
    ) -> Result<Option<OleDrawing>, StillReading> {
        let outcome = match outcome {
            Flight::Done(outcome) => outcome,
            Flight::Busy => {
                eprintln!(
                    "Paste-back skipped the copied object: an earlier OLE read is unfinished"
                );
                return Err(StillReading);
            }
            Flight::TimedOut => {
                eprintln!("Paste-back skipped the copied object: {source} was not ready within 10 seconds");
                return Err(StillReading);
            }
            Flight::Failed(reason) => Err(format!("{source}: {reason}")),
        };
        Ok(match outcome {
            Ok(drawing) => drawing,
            Err(reason) => {
                eprintln!("Paste-back skipped the copied Office object: {reason}");
                None
            }
        })
    }

    /// The class and drawing of the copied object, on the OLE reader thread.
    fn read_ole_object((source, sequence): (&'static str, NonZeroU32)) -> OleRead {
        use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
        // SAFETY: balanced by OleUninitialize below, on this thread.
        unsafe { OleInitialize(None) }.map_err(|error| format!("Could not start OLE: {error}"))?;
        let result = read_ole_at_sequence(sequence, clipboard_sequence, || {
            read_ole_clipboard_object(source)
        });
        // SAFETY: read_ole_clipboard_object released every interface and medium it obtained.
        unsafe { OleUninitialize() };
        result
    }

    fn read_ole_at_sequence(
        sequence: NonZeroU32,
        current_sequence: impl Fn() -> Option<NonZeroU32>,
        read: impl FnOnce() -> OleRead,
    ) -> OleRead {
        if current_sequence() != Some(sequence) {
            return Ok(None);
        }
        let result = read();
        // OLE does not hold our Win32 lock. A sequence change can mean a new copy or delayed
        // rendering. Either way, the association with the ordinary snapshot is ambiguous.
        if current_sequence() != Some(sequence) {
            return Ok(None);
        }
        result
    }

    fn read_ole_clipboard_object(source: &'static str) -> OleRead {
        use windows::Win32::System::Com::{
            DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL, TYMED_ISTORAGE,
        };
        use windows::Win32::System::Ole::{OleGetClipboard, ReleaseStgMedium};
        let format = u16::try_from(registered(source))
            .map_err(|_| format!("{source} has no clipboard format ID"))?;
        // SAFETY: OLE is initialized on this thread (read_ole_object).
        let data = unsafe { OleGetClipboard() }
            .map_err(|error| format!("Could not open the OLE clipboard: {error}"))?;
        let request = FORMATETC {
            cfFormat: format,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: (TYMED_ISTORAGE.0 | TYMED_HGLOBAL.0) as u32,
        };
        // SAFETY: `request` outlives the call; the medium is released below.
        let mut medium = unsafe { data.GetData(&request) }
            .map_err(|error| format!("Could not read {source}: {error}"))?;
        let result = read_object_medium(source, &medium);
        // SAFETY: the medium came from GetData, and nothing taken from it is still alive.
        unsafe { ReleaseStgMedium(&mut medium) };
        result
    }

    /// The object's storage, as OLE hands it over (TYMED_ISTORAGE), or opened over the flattened
    /// compound file a flushed clipboard holds (TYMED_HGLOBAL), within the 50 MiB storage limit.
    fn read_object_medium(
        source: &str,
        medium: &windows::Win32::System::Com::STGMEDIUM,
    ) -> OleRead {
        use crate::office_ole::storage::MAX_STORAGE_BYTES;
        use windows::Win32::System::Com::StructuredStorage::{
            CreateILockBytesOnHGlobal, IStorage, StgOpenStorageOnILockBytes,
        };
        use windows::Win32::System::Com::{
            STGM_READ, STGM_SHARE_EXCLUSIVE, TYMED_HGLOBAL, TYMED_ISTORAGE,
        };
        let storage = if medium.tymed == TYMED_ISTORAGE.0 as u32 {
            // SAFETY: tymed says the union holds a storage; the clone holds its own reference.
            unsafe { (*medium.u.pstg).clone() }.ok_or_else(|| format!("{source} has no storage"))?
        } else if medium.tymed == TYMED_HGLOBAL.0 as u32 {
            // SAFETY: tymed says the union holds a global memory handle, owned by the medium.
            let memory = unsafe { medium.u.hGlobal };
            // SAFETY: a valid handle from GetData.
            if unsafe { windows::Win32::System::Memory::GlobalSize(memory) } > MAX_STORAGE_BYTES {
                return Err(format!("{source} is over the 50 MiB limit"));
            }
            // SAFETY: the lock bytes and the storage are dropped before the medium is released,
            // and they never free the memory (fDeleteOnRelease is false).
            let bytes = unsafe { CreateILockBytesOnHGlobal(Some(memory), false) }
                .map_err(|error| format!("Could not read {source}: {error}"))?;
            unsafe {
                StgOpenStorageOnILockBytes(
                    &bytes,
                    None::<&IStorage>,
                    STGM_READ | STGM_SHARE_EXCLUSIVE,
                    None,
                    None,
                )
            }
            .map_err(|error| format!("{source} is not an OLE storage: {error}"))?
        } else {
            return Err(format!(
                "{source} came in an unexpected medium ({})",
                medium.tymed
            ));
        };
        crate::office_ole::server::pasted_drawing(&storage).map_err(|error| error.message())
    }

    pub(crate) fn read_payload() -> Result<ClipboardReadPayload, String> {
        let mut budget = ClipboardReadBudget::default();
        let (mut payload, sequence) = read_ordinary_payload(&mut budget)?;
        let mut still_reading = false;
        if let Some((sequence, source)) = sequence.zip(office_embedded_object_type(&payload.types))
        {
            match read_embedded_object(source, sequence) {
                Ok(Some(item)) => match budget.reserve(&item.r#type, item.bytes_base64.len()) {
                    Ok(()) => payload.office_items.push(item),
                    Err(reason) => {
                        eprintln!("Paste-back skipped the copied Office object: {reason}")
                    }
                },
                Ok(None) => {}
                Err(StillReading) => still_reading = true,
            }
        }
        payload.skipped_items = std::mem::take(&mut budget.skipped_items);
        // Keep the archive available even beside an OLE drawing. The adapter validates that
        // drawing before deciding whether it needs to decode the archive.
        if let Some((sequence, source)) = sequence.zip(office_picture_archive_type(&payload.types))
        {
            let request = ArchiveRequest {
                source,
                sequence,
                budget,
            };
            finish_archive_read(
                &mut payload,
                ARCHIVE_READER.read(request, OFFICE_ARCHIVE_TIMEOUT),
            );
        }
        finish_paste_read(payload, still_reading)
    }

    fn finish_paste_read(
        payload: ClipboardReadPayload,
        still_reading: bool,
    ) -> Result<ClipboardReadPayload, String> {
        if still_reading
            && payload.text_items.is_empty()
            && payload.image_items.is_empty()
            && payload.office_items.is_empty()
        {
            return Err(STILL_READING.into());
        }
        Ok(payload)
    }

    /// Snapshot ordinary formats before either optional read can block. Return the sequence after
    /// any delayed ordinary formats were rendered, while the clipboard is still locked.
    fn read_ordinary_payload(
        budget: &mut ClipboardReadBudget,
    ) -> Result<(ClipboardReadPayload, Option<NonZeroU32>), String> {
        // An unfinished OLE or archive read may be what holds the clipboard open.
        let _clipboard = open_for_paste()?;
        let mut types = Vec::new();
        let mut text_items = Vec::new();

        let mut formats = Vec::new();
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

            let priority = text_read_priority(id, &payload_type, name.as_deref());
            formats.push((id, name, payload_type, priority));
        }
        // Chemistry precedes artwork; plain text, then HTML and RTF follow it, beside a picture
        // too. The returned text order remains the native order used by the resolver.
        let mut image_items = Vec::new();
        let mut skipped_image_items = Vec::new();
        let priorities = formats
            .iter()
            .map(|(_, _, _, priority)| *priority)
            .collect::<Vec<_>>();
        for step in crate::clipboard_limits::clipboard_read_steps(&priorities) {
            let index = match step {
                ClipboardReadStep::Pictures => {
                    (image_items, skipped_image_items) = read_images(budget);
                    continue;
                }
                ClipboardReadStep::Text(index) => index,
            };
            let (id, name, payload_type, _) = &formats[index];
            let id = *id;
            if is_text_alias(id, &text_items) {
                continue;
            }
            let text = match name.as_deref() {
                None if id == CF_UNICODETEXT => {
                    decode_format(id, payload_type, budget, unicode_text)
                }
                None => None,
                Some(MDLCT_FORMAT) => decode_format(id, payload_type, budget, decode_mdlct),
                Some("HTML Format") => {
                    decode_format(id, payload_type, budget, |bytes| parse_cf_html(bytes).ok())
                }
                // Images are handled only by read_images, after the allocation guard.
                Some(name)
                    if crate::clipboard_images::is_image_clipboard_type(name)
                        || is_binary_windows_format(name)
                        || is_opaque_clipboard_type(name) =>
                {
                    None
                }
                Some(_) => decode_format(id, payload_type, budget, decode_registered_text),
            };
            if let Some(text) = text {
                // A provider may use an encoding whose bounded prefix was inconclusive.
                if text_items
                    .iter()
                    .any(|item: &ClipboardTextItem| item.text == text)
                {
                    continue;
                }
                if budget.reserve(payload_type, text.len()).is_err() {
                    budget.mark_chemistry(payload_type, text.as_bytes());
                    continue;
                }
                text_items.push(ClipboardTextItem {
                    r#type: payload_type.clone(),
                    text,
                });
            }
        }
        text_items.sort_by_key(|item| types.iter().position(|kind| kind == &item.r#type));
        Ok((
            ClipboardReadPayload {
                types,
                text_items,
                image_items,
                skipped_image_items,
                skipped_items: Vec::new(),
                office_items: Vec::new(),
            },
            clipboard_sequence(),
        ))
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

    enum PreparedExtra {
        RegisteredAlias(&'static str),
        Dibv5(Result<Vec<u8>, String>),
    }

    struct PreparedWrite {
        target: WindowsTarget,
        bytes: Vec<u8>,
        extras: Vec<PreparedExtra>,
    }

    fn prepare_write(item: &ValidatedClipboardItem) -> Result<PreparedWrite, String> {
        let target = windows_target_for_payload_type(&item.r#type);
        if target == WindowsTarget::Png {
            png_pixels_per_meter(item.data.bytes())?;
        }
        let bytes = match &target {
            WindowsTarget::UnicodeText => wide(&windows_line_endings(clipboard_utf8(
                item.data.bytes(),
                "Plain text",
            )?))
            .iter()
            .flat_map(|unit| unit.to_le_bytes())
            .collect(),
            WindowsTarget::Html => build_cf_html(clipboard_utf8(item.data.bytes(), "HTML")?)?,
            WindowsTarget::Rtf => {
                let mut bytes = item.data.bytes().to_vec();
                bytes.push(0);
                bytes
            }
            WindowsTarget::Registered(_) => {
                let mut bytes = item.data.bytes().to_vec();
                if matches!(&item.data, ClipboardWriteData::Text(_)) {
                    bytes.push(0);
                }
                bytes
            }
            WindowsTarget::Png => item.data.bytes().to_vec(),
            WindowsTarget::Skip => Vec::new(),
        };
        // DIB conversion is a best-effort extra, prepared before the clipboard is cleared.
        let extras = if target == WindowsTarget::Png {
            vec![
                PreparedExtra::RegisteredAlias("image/png"),
                PreparedExtra::Dibv5(png_to_dibv5(&bytes)),
            ]
        } else {
            Vec::new()
        };
        Ok(PreparedWrite {
            target,
            bytes,
            extras,
        })
    }

    fn set_registered_bytes(name: &str, bytes: &[u8]) -> bool {
        let format = registered(name);
        format != 0 && set_bytes(format, bytes)
    }

    /// All validation/encoding precedes the single clear. The owner must be a window: a null owner
    /// leaves EmptyClipboard ownerless, so every subsequent SetClipboardData would fail.
    pub(crate) fn write_items(
        owner: HWND,
        items: &[ValidatedClipboardItem],
    ) -> Result<ClipboardWriteResult, String> {
        let prepared = items
            .iter()
            .map(prepare_write)
            .collect::<Result<Vec<_>, _>>()?;
        if owner.is_null() {
            return Err("Could not find the document window for the clipboard write.".to_string());
        }
        let _clipboard = OpenedClipboard::open(owner)?;
        // SAFETY: the clipboard is open with an owner window.
        if unsafe { EmptyClipboard() } == 0 {
            return Err("Could not clear the clipboard.".to_string());
        }

        let mut result = ClipboardWriteResult::new();
        for (item, prepared) in items.iter().zip(prepared) {
            let written = match prepared.target {
                // Preserve the existing ignored alias without claiming it was written.
                WindowsTarget::Skip => continue,
                WindowsTarget::UnicodeText => set_bytes(CF_UNICODETEXT, &prepared.bytes),
                WindowsTarget::Html => set_registered_bytes("HTML Format", &prepared.bytes),
                WindowsTarget::Rtf => set_registered_bytes("Rich Text Format", &prepared.bytes),
                WindowsTarget::Registered(name) => set_registered_bytes(&name, &prepared.bytes),
                WindowsTarget::Png => set_registered_bytes(PNG_FORMAT, &prepared.bytes),
            };
            for extra in prepared.extras {
                let (format, extra_result) = match extra {
                    PreparedExtra::RegisteredAlias(name) => {
                        (name, Ok(set_registered_bytes(name, &prepared.bytes)))
                    }
                    PreparedExtra::Dibv5(dib) => {
                        ("CF_DIBV5", dib.map(|bytes| set_bytes(CF_DIBV5, &bytes)))
                    }
                };
                let reason = match extra_result {
                    Ok(true) => continue,
                    Ok(false) => "native clipboard write failed.".to_string(),
                    Err(reason) => reason,
                };
                result
                    .warnings
                    .push(format!("Windows {format} copy skipped: {reason}"));
            }
            // Native extras must never mask failure of the primary requested flavour.
            result.record(
                item,
                if written {
                    Ok(())
                } else {
                    Err(format!(
                        "Could not write clipboard data for type {}.",
                        item.r#type
                    ))
                },
            );
        }
        Ok(result)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::clipboard_formats::{native_test_data as fixture, validate_clipboard_items};

        fn office_snapshot() -> ClipboardReadPayload {
            ClipboardReadPayload {
                types: vec!["Embedded Object".into(), "Art::GVML ClipFormat".into()],
                text_items: Vec::new(),
                image_items: Vec::new(),
                skipped_image_items: Vec::new(),
                skipped_items: Vec::new(),
                office_items: Vec::new(),
            }
        }

        #[test]
        fn gvml_timeout_or_busy_keeps_the_saved_png() {
            let mut payload = office_snapshot();
            let (_, png) = fixture::items();
            payload.image_items.push(png_image_item(&png).unwrap());
            let saved_bytes = payload.image_items[0].bytes_base64.clone();
            for outcome in [Flight::TimedOut, Flight::Busy] {
                finish_archive_read(&mut payload, outcome);
                assert!(payload.office_items.is_empty());
                assert_eq!(payload.image_items[0].bytes_base64, saved_bytes);
            }
        }

        #[test]
        fn ole_timeout_and_busy_report_pending_without_a_fallback() {
            for outcome in [Flight::TimedOut, Flight::Busy] {
                let still_reading = finish_ole_read("Embedded Object", outcome).is_err();
                assert_eq!(
                    finish_paste_read(office_snapshot(), still_reading)
                        .err()
                        .as_deref(),
                    Some(STILL_READING)
                );
                let mut payload = office_snapshot();
                let (_, png) = fixture::items();
                payload.image_items.push(png_image_item(&png).unwrap());
                assert!(finish_paste_read(payload, still_reading).is_ok());
            }
        }

        /// A stuck GVML render keeps the archive reader's thread inside GetClipboardData with the
        /// clipboard open. The next paste cannot open it either, and must say so as pending,
        /// whichever optional read is unfinished, not blame another program.
        #[test]
        fn a_failed_open_reports_pending_while_either_optional_read_is_unfinished() {
            assert_eq!(
                paste_open_error(CLIPBOARD_IN_USE.into(), false, false),
                CLIPBOARD_IN_USE
            );
            for (ole_busy, archive_busy) in [(true, false), (false, true), (true, true)] {
                assert_eq!(
                    paste_open_error(CLIPBOARD_IN_USE.into(), ole_busy, archive_busy),
                    STILL_READING,
                    "OLE busy: {ole_busy}, archive busy: {archive_busy}"
                );
            }
            let other = "Could not open the clipboard.";
            assert_eq!(paste_open_error(other.into(), false, false), other);
            assert_eq!(paste_open_error(other.into(), false, true), STILL_READING);
        }

        #[test]
        fn ole_read_discards_changed_or_unavailable_clipboard_sequences() {
            let saved = NonZeroU32::new(7).unwrap();
            let changed = NonZeroU32::new(8).unwrap();
            assert_eq!(
                read_ole_at_sequence(saved, || Some(saved), || Ok(Some(("class", "{}".into())))),
                Ok(Some(("class", "{}".into())))
            );
            for now in [Some(changed), None] {
                assert_eq!(
                    read_ole_at_sequence(
                        saved,
                        || now,
                        || panic!("clipboard changed before OLE read")
                    ),
                    Ok(None)
                );
                let current = std::cell::Cell::new(Some(saved));
                assert_eq!(
                    read_ole_at_sequence(
                        saved,
                        || current.get(),
                        || {
                            current.set(now);
                            Ok(Some(("class", "{}".into())))
                        }
                    ),
                    Ok(None)
                );
            }
        }

        #[test]
        fn gvml_stays_in_the_payload_beside_an_ole_drawing() {
            let mut payload = office_snapshot();
            let ole = office_embedded_object_item("Embedded Object", "class", "{}");
            payload.office_items.push(ole);
            finish_archive_read(
                &mut payload,
                Flight::Done(ArchiveRead {
                    item: office_archive_item("Art::GVML ClipFormat", b"PK\x03\x04rest").map(Some),
                    skipped_items: Vec::new(),
                }),
            );
            assert_eq!(
                payload
                    .office_items
                    .iter()
                    .map(|item| item.r#type.as_str())
                    .collect::<Vec<_>>(),
                ["Embedded Object", "Art::GVML ClipFormat"]
            );
        }

        #[test]
        fn windows_utf16_and_utf8_text_share_the_decoded_cap() {
            crate::clipboard_limits::assert_text_encoding_size_admission(
                "text/plain",
                "text/plain",
            );
            for text in ["ASCII", "μ界😀"] {
                let bytes: Vec<u8> = text
                    .encode_utf16()
                    .chain([0])
                    .flat_map(u16::to_le_bytes)
                    .collect();
                assert_eq!(unicode_text_utf8_length(&bytes), text.len());
                assert_eq!(unicode_text(&bytes).as_deref(), Some(text));
            }
        }

        #[test]
        fn windows_preparation_refuses_markerless_html_before_opening_or_clearing() {
            let items =
                validate_clipboard_items(vec![crate::clipboard_formats::ClipboardWriteItem {
                    r#type: "text/html".to_string(),
                    text: Some("<b>table</b>".to_string()),
                    bytes_base64: None,
                    required: false,
                }])
                .expect("shared HTML validation accepts markerless UTF-8");
            assert_eq!(
                prepare_write(&items[0])
                    .err()
                    .expect("Windows refuses missing markers"),
                "HTML clipboard item has no <!--StartFragment--> marker"
            );
            // Preparation happens even before checking the owner, with no native side effects.
            assert_eq!(
                write_items(std::ptr::null_mut(), &items).unwrap_err(),
                "HTML clipboard item has no <!--StartFragment--> marker"
            );
        }

        #[test]
        fn png_preparation_rejects_malformed_metadata_before_opening_or_clearing() {
            let item = ValidatedClipboardItem {
                r#type: "image/png".to_string(),
                data: ClipboardWriteData::Binary(b"malformed PNG".to_vec()),
                required: true,
            };
            assert_eq!(
                prepare_write(&item).err().unwrap(),
                "Malformed PNG density metadata."
            );
            assert_eq!(
                write_items(std::ptr::null_mut(), &[item]).unwrap_err(),
                "Malformed PNG density metadata."
            );
        }

        #[test]
        fn png_preparation_rejects_corrupt_density_before_opening_or_clearing() {
            let mut corrupt = super::super::tests::png_with_density(15118, 15118, 1);
            corrupt[50] ^= 1;
            let reason = png_pixels_per_meter(&corrupt).unwrap_err();
            assert_eq!(reason, "PNG density metadata has an invalid CRC.");
            let item = ValidatedClipboardItem {
                r#type: "image/png".into(),
                data: ClipboardWriteData::Binary(corrupt),
                required: true,
            };
            assert_eq!(prepare_write(&item).err().unwrap(), reason);
            assert_eq!(
                write_items(std::ptr::null_mut(), &[item]).unwrap_err(),
                reason
            );
        }

        #[test]
        fn png_preparation_preserves_unsigned_density_and_declines_only_dib() {
            for (x, y) in [(u32::MAX, 15118), (15118, u32::MAX)] {
                let png = super::super::tests::png_with_density(x, y, 1);
                assert_eq!(png_pixels_per_meter(&png), Ok(Some((x, y))));
                let item = ValidatedClipboardItem {
                    r#type: "image/png".into(),
                    data: ClipboardWriteData::Binary(png),
                    required: true,
                };
                let prepared =
                    prepare_write(&item).expect("PNG density is valid unsigned metadata");
                assert_eq!(prepared.target, WindowsTarget::Png);
                assert_eq!(prepared.bytes, item.data.bytes());
                assert!(matches!(
                    &prepared.extras[..],
                    [
                        PreparedExtra::RegisteredAlias("image/png"),
                        PreparedExtra::Dibv5(Err(reason))
                    ] if reason == "PNG density exceeds the signed DIB range."
                ));
            }
        }

        #[test]
        fn png_preparation_keeps_both_registered_formats_when_dib_conversion_fails() {
            for (width, height) in [(20_000u32, 20_000u32), (1, 1)] {
                let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
                png.extend_from_slice(&width.to_be_bytes());
                png.extend_from_slice(&height.to_be_bytes());
                png.extend_from_slice(&[8, 6, 0, 0, 0]);
                png.extend_from_slice(&png_crc32(&png[12..]).to_be_bytes());
                png.extend_from_slice(b"\0\0\0\0IEND");
                png.extend_from_slice(&png_crc32(b"IEND").to_be_bytes());
                let item = ValidatedClipboardItem {
                    r#type: "image/png".to_string(),
                    data: ClipboardWriteData::Binary(png),
                    required: true,
                };
                let prepared = prepare_write(&item).expect("PNG bytes remain writable");
                assert_eq!(prepared.target, WindowsTarget::Png);
                assert_eq!(prepared.bytes, item.data.bytes());
                assert!(matches!(
                    &prepared.extras[..],
                    [
                        PreparedExtra::RegisteredAlias("image/png"),
                        PreparedExtra::Dibv5(Err(_))
                    ]
                ));
            }
        }

        // This stomps the user's clipboard. Run alone in an interactive Windows session with:
        // cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml native_windows_multiformat_round_trip -- --ignored --test-threads=1
        #[test]
        #[ignore = "overwrites the user's native clipboard"]
        fn native_windows_multiformat_round_trip() {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, HWND_MESSAGE,
            };

            struct Owner(HWND);
            impl Drop for Owner {
                fn drop(&mut self) {
                    // SAFETY: this test owns the live window and drops it on its creating thread.
                    unsafe { DestroyWindow(self.0) };
                }
            }
            // SAFETY: STATIC is a system class; both strings are NUL-terminated and the message-only
            // window is created, used, and destroyed on this test thread without showing any UI.
            let owner = Owner(unsafe {
                CreateWindowExW(
                    0,
                    wide("STATIC").as_ptr(),
                    wide("ChemDraft clipboard test").as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            });
            assert!(!owner.0.is_null(), "create clipboard owner window");
            let (items, png) = fixture::items();
            let items = validate_clipboard_items(items).expect("valid multi-format request");
            // The native transaction used by write_clipboard_items, with a real owner HWND.
            let result = write_items(owner.0, &items).expect("write all native flavours at once");
            assert!(result.ok, "{:?}", result.failed);
            assert!(result.failed.is_empty(), "{:?}", result.failed);
            assert_eq!(result.written.len(), 5);

            let payload = read_payload().expect("read native clipboard");
            for (kind, expected) in [
                (fixture::PRIVATE_TYPE, fixture::JSON),
                ("text/plain", fixture::TEXT),
                ("text/html", fixture::HTML),
                ("text/rtf", fixture::RTF),
            ] {
                assert!(payload.types.iter().any(|entry| entry == kind));
                let text = &payload
                    .text_items
                    .iter()
                    .find(|item| item.r#type == kind)
                    .expect("text flavour reads back")
                    .text;
                // Exact HTML equality also proves the CF_HTML header was removed on read.
                assert_eq!(text, expected);
            }
            assert!(payload.types.iter().any(|kind| kind == "image/png"));
            assert_eq!(payload.image_items.len(), 1);
            assert!(payload.skipped_image_items.is_empty());
            {
                use base64::{engine::general_purpose::STANDARD, Engine};
                let bytes = STANDARD
                    .decode(&payload.image_items[0].bytes_base64)
                    .unwrap();
                assert_eq!(bytes.get(..png.len()), Some(png.as_slice()));
            }
            let _clipboard = OpenedClipboard::open(owner.0).expect("open for binary readback");
            let bytes = image_format_bytes(
                registered(PNG_FORMAT),
                PNG_FORMAT,
                "image/png",
                &mut ClipboardReadBudget::default(),
            )
            .expect("registered PNG reads back");
            // GlobalSize may include allocation padding after the original binary payload.
            assert_eq!(bytes.get(..png.len()), Some(png.as_slice()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        header.extend_from_slice(&width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        header.extend_from_slice(&png_crc32(&header[12..]).to_be_bytes());
        header
    }

    #[test]
    fn bounds_png_ihdr_before_any_decoder_allocation() {
        for (width, height) in [(1, 1), (16_384, 1), (1, 16_384), (8192, 8192)] {
            assert_eq!(
                bounded_png_dimensions(&png_header(width, height)),
                Ok((width, height))
            );
        }
        for (width, height) in [(16_385, 1), (1, 16_385), (8192, 8193), (u32::MAX, u32::MAX)] {
            let header = png_header(width, height);
            assert!(bounded_png_dimensions(&header)
                .unwrap_err()
                .contains("exceeds"));
            // A header alone cannot decode: this error proves the size guard ran first.
            assert!(png_to_dibv5(&header).unwrap_err().contains("exceeds"));
        }
    }

    #[test]
    fn png_allocation_limit_reports_the_same_dimensions_and_limit_as_the_header_guard() {
        let (width, height) = (8192, 8193);
        let error = image::ImageError::Limits(image::error::LimitError::from_kind(
            image::error::LimitErrorKind::InsufficientMemory,
        ));
        assert_eq!(
            png_decode_error(error, width, height),
            bounded_png_dimensions(&png_header(width, height)).unwrap_err()
        );
    }

    #[test]
    fn refuses_malformed_png_ihdr_without_decoding() {
        let header = png_header(1, 1);
        for length in 0..header.len() {
            assert!(bounded_png_dimensions(&header[..length]).is_err());
        }
        for offset in [0, 8, 12, 29] {
            let mut bad = header.clone();
            bad[offset] ^= 1;
            assert!(bounded_png_dimensions(&bad)
                .unwrap_err()
                .contains("malformed"));
        }
        for (offset, value) in [(24, 3), (25, 1), (26, 1), (27, 1), (28, 2)] {
            let mut bad = header.clone();
            bad[offset] = value;
            let crc = png_crc32(&bad[12..29]);
            bad[29..33].copy_from_slice(&crc.to_be_bytes());
            assert!(bounded_png_dimensions(&bad)
                .unwrap_err()
                .contains("malformed"));
        }
        assert!(bounded_png_dimensions(&png_header(0, 1)).is_err());
        assert!(bounded_png_dimensions(&png_header(1, 0)).is_err());
    }

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
    fn office_table_html_and_rtf_are_read_beside_its_picture() {
        use crate::clipboard_limits::{clipboard_read_steps, ClipboardReadStep};
        const CF_BITMAP: u32 = 2;
        // Word's and Excel's table formats (abridged), in the order Office registers them.
        for (formats, expected) in [
            (
                &[
                    (0xC001, Some("Object Descriptor")),
                    (0xC002, Some("Rich Text Format")),
                    (0xC003, Some("HTML Format")),
                    (0xC004, Some("Rich Text Format Without Objects")),
                    (0xC005, Some("RTF As Text")),
                    (CF_UNICODETEXT, None),
                    (0xC006, Some("PNG")),
                    (CF_ENHMETAFILE, None),
                    (0xC007, Some("Embed Source")),
                ][..],
                ["pictures", "text/plain", "text/rtf", "text/html"],
            ),
            (
                &[
                    (0xC011, Some("DataObject")),
                    (0xC012, Some("Biff12")),
                    (CF_ENHMETAFILE, None),
                    (CF_BITMAP, None),
                    (0xC013, Some("HTML Format")),
                    (0xC014, Some("Rich Text Format")),
                    (CF_UNICODETEXT, None),
                    (0xC015, Some("PNG")),
                    (CF_DIB, None),
                    (0xC016, Some("XML Spreadsheet")),
                ][..],
                ["pictures", "text/plain", "text/html", "text/rtf"],
            ),
        ] {
            let read = formats
                .iter()
                .filter_map(|(id, name)| {
                    let kind = payload_type_for_format(*id, *name)?;
                    let priority = windows_text_read_priority(&kind, *name);
                    Some((kind, priority))
                })
                .collect::<Vec<_>>();
            let priorities = read
                .iter()
                .map(|(_, priority)| *priority)
                .collect::<Vec<_>>();
            let steps = clipboard_read_steps(&priorities)
                .into_iter()
                .map(|step| match step {
                    ClipboardReadStep::Pictures => "pictures",
                    ClipboardReadStep::Text(index) => read[index].0.as_str(),
                })
                .collect::<Vec<_>>();
            assert_eq!(steps, expected);
        }
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
        assert!(is_binary_windows_format("image/tiff"));
        assert!(is_binary_windows_format("public.png"));
        assert!(is_binary_windows_format("public.tiff"));
        assert!(!is_binary_windows_format("image/svg+xml"));
        assert!(!is_binary_windows_format(
            "application/x-chemdraft-selection+json"
        ));
    }

    #[test]
    fn image_read_order_prefers_both_png_formats_before_dibs() {
        assert_eq!(
            image_read_formats(0xC100, 0xC101, 0xC102),
            [
                ("PNG", 0xC100),
                ("image/png", 0xC101),
                ("CF_DIBV5", CF_DIBV5),
                ("CF_DIB", CF_DIB),
                ("image/svg+xml", 0xC102),
            ]
        );
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

    pub(super) fn png_with_density(x: u32, y: u32, unit: u8) -> Vec<u8> {
        let mut image = image::RgbaImage::new(1, 1);
        image.put_pixel(0, 0, image::Rgba([0, 0, 0, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode png");
        assert_eq!(png_pixels_per_meter(&png), Ok(None));

        // Insert a pHYs chunk right after IHDR, as export.rs does (15118 px/m = 384 dpi).
        let ihdr_end = 8 + 12 + 13;
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&9u32.to_be_bytes());
        chunk.extend_from_slice(b"pHYs");
        chunk.extend_from_slice(&x.to_be_bytes());
        chunk.extend_from_slice(&y.to_be_bytes());
        chunk.push(unit);
        chunk.extend_from_slice(&png_crc32(&chunk[4..]).to_be_bytes());
        let mut stamped = png[..ihdr_end].to_vec();
        stamped.extend_from_slice(&chunk);
        stamped.extend_from_slice(&png[ihdr_end..]);
        stamped
    }

    #[test]
    fn reads_the_density_a_png_declares() {
        let png = png_with_density(15118, 15118, 1);
        assert_eq!(png_pixels_per_meter(&png), Ok(Some((15118, 15118))));
        let dib = png_to_dibv5(&png).unwrap();
        assert_eq!(i32::from_le_bytes(dib[24..28].try_into().unwrap()), 15118);
        assert_eq!(i32::from_le_bytes(dib[28..32].try_into().unwrap()), 15118);
        for png in [png_with_density(4, 3, 0), png_with_density(0, 15118, 1)] {
            assert_eq!(png_pixels_per_meter(&png), Ok(None));
            let dib = png_to_dibv5(&png).unwrap();
            assert_eq!(i32::from_le_bytes(dib[24..28].try_into().unwrap()), 2835);
            assert_eq!(i32::from_le_bytes(dib[28..32].try_into().unwrap()), 2835);
        }
    }

    #[test]
    fn rejects_density_crc_corruption_and_truncation_before_dib_conversion() {
        let png = png_with_density(15118, 15118, 1);
        for offset in [41, 45, 50] {
            let mut corrupt = png.clone();
            corrupt[offset] ^= 1;
            assert!(png_pixels_per_meter(&corrupt).unwrap_err().contains("CRC"));
            assert!(png_to_dibv5(&corrupt).unwrap_err().contains("CRC"));
        }
        // The density is not trusted until the complete CRC is present.
        for length in 41..54 {
            assert!(png_pixels_per_meter(&png[..length]).is_err());
            assert!(png_to_dibv5(&png[..length]).is_err());
        }
        let mut duplicate = png.clone();
        duplicate.splice(54..54, png[33..54].iter().copied());
        assert!(png_pixels_per_meter(&duplicate).is_err());
        let mut late = png[..33].to_vec();
        late.extend_from_slice(&png[54..png.len() - 12]);
        late.extend_from_slice(&png[33..54]);
        late.extend_from_slice(&png[png.len() - 12..]);
        assert!(png_pixels_per_meter(&late).is_err());
    }

    #[test]
    fn density_fits_signed_dib_fields_without_changing_valid_values() {
        let max = i32::MAX as u32;
        for (x, y) in [(1, 1), (15118, 11811), (max, max)] {
            let png = png_with_density(x, y, 1);
            assert_eq!(png_pixels_per_meter(&png), Ok(Some((x, y))));
            let dib = png_to_dibv5(&png).unwrap();
            assert_eq!(
                i32::from_le_bytes(dib[24..28].try_into().unwrap()),
                x as i32
            );
            assert_eq!(
                i32::from_le_bytes(dib[28..32].try_into().unwrap()),
                y as i32
            );
        }
        for (x, y) in [
            (max + 1, 15118),
            (15118, max + 1),
            (u32::MAX, u32::MAX),
            (max + 1, 0),
            (0, max + 1),
        ] {
            let png = png_with_density(x, y, 1);
            assert_eq!(
                png_pixels_per_meter(&png),
                Ok((x > 0 && y > 0).then_some((x, y)))
            );
            if x > 0 && y > 0 {
                assert!(png_to_dibv5(&png).unwrap_err().contains("signed DIB"));
            } else {
                assert!(png_to_dibv5(&png).is_ok());
            }
        }
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
