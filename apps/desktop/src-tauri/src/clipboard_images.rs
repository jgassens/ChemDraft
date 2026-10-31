//! Bounded clipboard image decoding, shared by both native readers and host-independent tests.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]

use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageEncoder;
use std::io::{Cursor, Write};

pub(crate) const MAX_CLIPBOARD_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 16_384;
const MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipboardImageItem {
    pub(crate) r#type: String,
    pub(crate) bytes_base64: String,
    #[serde(serialize_with = "serialize_pixels_per_meter")]
    pub(crate) pixels_per_meter: Option<(u32, u32)>,
    pub(crate) pixel_width: Option<u32>,
    pub(crate) pixel_height: Option<u32>,
}

fn serialize_pixels_per_meter<S: serde::Serializer>(
    value: &Option<(u32, u32)>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    #[derive(serde::Serialize)]
    struct Resolution {
        x: u32,
        y: u32,
    }
    serde::Serialize::serialize(&value.map(|(x, y)| Resolution { x, y }), serializer)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkippedClipboardImageItem {
    pub(crate) r#type: String,
    pub(crate) byte_length: u64,
    pub(crate) reason: String,
}

impl SkippedClipboardImageItem {
    pub(crate) fn new(kind: &str, byte_length: usize, reason: String) -> Self {
        Self {
            r#type: kind.to_string(),
            byte_length: byte_length as u64,
            reason,
        }
    }
}

pub(crate) fn check_image_byte_length(source: &str, byte_length: usize) -> Result<(), String> {
    if byte_length > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err(format!(
            "{source} is {:.1} MB; the limit is 25 MB",
            byte_length as f64 / (1024.0 * 1024.0)
        ));
    }
    Ok(())
}

/// The pixels-per-metre a PNG declares in pHYs (unit 1 = metre), before the image data.
/// Chunk lengths are checked before every slice, including on 32-bit hosts.
pub(crate) fn png_pixels_per_meter(png: &[u8]) -> Option<(u32, u32)> {
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut index = 8usize;
    while let Some(header) = png.get(index..index.checked_add(8)?) {
        let length = u32::from_be_bytes(header[..4].try_into().ok()?) as usize;
        let end = index.checked_add(12)?.checked_add(length)?;
        let chunk = png.get(index..end)?;
        match &header[4..8] {
            b"pHYs" if length == 9 => {
                let x = u32::from_be_bytes(chunk[8..12].try_into().ok()?);
                let y = u32::from_be_bytes(chunk[12..16].try_into().ok()?);
                return (chunk[16] == 1 && x > 0 && y > 0).then_some((x, y));
            }
            b"IDAT" | b"IEND" => return None,
            _ => index = end,
        }
    }
    None
}

fn decode_raster(bytes: &[u8], format: image::ImageFormat) -> Result<image::DynamicImage, String> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| error.to_string())?;
    if u64::from(width) * u64::from(height) * 4 > MAX_DECODED_BYTES {
        return Err(format!(
            "picture {width}x{height} exceeds the {MAX_DECODED_BYTES}-byte RGBA decode limit"
        ));
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    reader.decode().map_err(|error| error.to_string())
}

pub(crate) fn png_image_item(bytes: &[u8]) -> Result<ClipboardImageItem, String> {
    check_image_byte_length("PNG", bytes.len())?;
    // Validate IHDR before decoding; dimensions come from that header, never a guessed print size.
    let (width, height) = crate::windows_clipboard::bounded_png_dimensions(bytes)
        .map_err(|reason| format!("PNG read failed: {reason}"))?;
    decode_raster(bytes, image::ImageFormat::Png)
        .map_err(|reason| format!("PNG decode failed: {reason}"))?;
    Ok(raster_item(
        bytes,
        width,
        height,
        png_pixels_per_meter(bytes),
    ))
}

fn raster_item(
    png: &[u8],
    width: u32,
    height: u32,
    pixels_per_meter: Option<(u32, u32)>,
) -> ClipboardImageItem {
    ClipboardImageItem {
        r#type: "image/png".to_string(),
        bytes_base64: STANDARD.encode(png),
        pixels_per_meter,
        pixel_width: Some(width),
        pixel_height: Some(height),
    }
}

pub(crate) fn svg_image_item(bytes: &[u8], source: &str) -> Result<ClipboardImageItem, String> {
    check_image_byte_length(source, bytes.len())?;
    // Registered Windows text formats can include a C-string terminator/allocation padding.
    let end = bytes
        .iter()
        .rposition(|byte| *byte != 0)
        .map_or(0, |i| i + 1);
    let bytes = &bytes[..end];
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("{source} is not valid UTF-8: {error}"))?;
    if text.trim().is_empty() || text.contains('\0') {
        return Err(format!(
            "{source} is empty or contains an interior NUL byte"
        ));
    }
    Ok(ClipboardImageItem {
        r#type: "image/svg+xml".to_string(),
        bytes_base64: STANDARD.encode(bytes),
        pixels_per_meter: None,
        pixel_width: None,
        pixel_height: None,
    })
}

/// Stop the encoder before it can accumulate an oversized PNG from a compressed TIFF.
#[derive(Default)]
struct PngBuffer(Vec<u8>);

impl Write for PngBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other(
                "PNG conversion exceeds the limit of 25 MB",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    pixels_per_meter: Option<(u32, u32)>,
    source: &str,
) -> Result<ClipboardImageItem, String> {
    let mut png = PngBuffer::default();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|error| format!("{source} to PNG conversion failed: {error}"))?;
    Ok(raster_item(&png.0, width, height, pixels_per_meter))
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn tiff_image_item(bytes: &[u8]) -> Result<ClipboardImageItem, String> {
    check_image_byte_length("TIFF", bytes.len())?;
    let rgba = decode_raster(bytes, image::ImageFormat::Tiff)
        .map_err(|reason| format!("TIFF decode failed: {reason}"))?
        .into_rgba8();
    encode_rgba(
        rgba.as_raw(),
        rgba.width(),
        rgba.height(),
        tiff_pixels_per_meter(bytes),
        "TIFF",
    )
}

/// Read the first classic TIFF IFD's resolution. image's TIFF adapter does not expose these tags.
/// A missing ResolutionUnit defaults to inches per TIFF 6.0; unit 1 is explicitly unitless.
fn tiff_pixels_per_meter(bytes: &[u8]) -> Option<(u32, u32)> {
    let little = match bytes.get(..4)? {
        b"II\x2a\0" => true,
        b"MM\0\x2a" => false,
        _ => return None,
    };
    let u16_at = |offset: usize| -> Option<u16> {
        let pair = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        })
    };
    let u32_at = |offset: usize| -> Option<u32> {
        let word = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(word)
        } else {
            u32::from_be_bytes(word)
        })
    };
    let ifd = u32_at(4)? as usize;
    let count = usize::from(u16_at(ifd)?);
    let mut x = None;
    let mut y = None;
    let mut unit = 2;
    for index in 0..count {
        let entry = ifd.checked_add(2)?.checked_add(index.checked_mul(12)?)?;
        let tag = u16_at(entry)?;
        if u32_at(entry + 4)? != 1 {
            continue;
        }
        match (tag, u16_at(entry + 2)?) {
            (282 | 283, 5) => {
                let offset = u32_at(entry + 8)? as usize;
                let denominator = u32_at(offset.checked_add(4)?)?;
                if denominator == 0 {
                    return None;
                }
                let value = f64::from(u32_at(offset)?) / f64::from(denominator);
                if tag == 282 {
                    x = Some(value);
                } else {
                    y = Some(value);
                }
            }
            (296, 3) => unit = u16_at(entry + 8)?,
            _ => {}
        }
    }
    let scale = match unit {
        2 => 1.0 / 0.0254,
        3 => 100.0,
        _ => return None,
    };
    let convert = |value: f64| {
        let value = (value * scale).round();
        (1.0..=f64::from(u32::MAX))
            .contains(&value)
            .then_some(value as u32)
    };
    Some((convert(x?)?, convert(y?)?))
}

fn dib_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    bytes
        .get(offset..offset + 4)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "truncated bitmap header".to_string())
}

fn channel(pixel: u32, mask: u32) -> u8 {
    let shift = mask.trailing_zeros();
    let maximum = mask >> shift;
    ((u64::from((pixel & mask) >> shift) * 255 + u64::from(maximum / 2)) / u64::from(maximum)) as u8
}

/// A packed clipboard DIB has no BMP file header. Rows are DWORD-aligned; positive heights
/// are bottom-up. Only V5's explicit alpha mask authorizes reading an alpha channel.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) fn dib_image_item(bytes: &[u8], source: &str) -> Result<ClipboardImageItem, String> {
    check_image_byte_length(source, bytes.len())?;
    dib_image_item_inner(bytes).map_err(|reason| format!("{source} {reason}"))
}

fn dib_image_item_inner(bytes: &[u8]) -> Result<ClipboardImageItem, String> {
    let header_size = dib_u32(bytes, 0)? as usize;
    if !matches!(header_size, 40 | 52 | 56 | 108 | 124) {
        return Err(format!("has unsupported header size {header_size}"));
    }
    if bytes.len() < header_size {
        return Err("has a truncated bitmap header".to_string());
    }
    let width = dib_u32(bytes, 4)? as i32;
    let signed_height = dib_u32(bytes, 8)? as i32;
    let height = signed_height.unsigned_abs();
    if width <= 0 || height == 0 || width as u32 > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
        return Err(format!("has invalid or oversized dimensions {width}x{signed_height} (limit {MAX_IMAGE_SIDE} pixels per side)"));
    }
    let width = width as u32;
    let planes = u16::from_le_bytes([bytes[12], bytes[13]]);
    let bits = u16::from_le_bytes([bytes[14], bytes[15]]);
    if planes != 1 || !matches!(bits, 24 | 32) {
        return Err(format!("has unsupported planes/bit depth {planes}/{bits}; expected one plane with 24 or 32 bits"));
    }
    let compression = dib_u32(bytes, 16)?;
    if !matches!(compression, 0 | 3) {
        let name = match compression {
            1 => "BI_RLE8",
            2 => "BI_RLE4",
            4 => "BI_JPEG",
            5 => "BI_PNG",
            6 => "BI_ALPHABITFIELDS",
            _ => "unknown",
        };
        return Err(format!(
            "has unsupported compression {compression} ({name})"
        ));
    }

    let mut pixel_offset = header_size;
    let mut masks = [0x00ff_0000, 0x0000_ff00, 0x0000_00ff, 0];
    if compression == 3 {
        for (index, mask) in masks[..3].iter_mut().enumerate() {
            *mask = dib_u32(bytes, 40 + index * 4)?;
        }
        if header_size == 40 {
            pixel_offset += 12;
        }
    }
    if header_size == 124 {
        masks[3] = dib_u32(bytes, 52)?;
    }
    let valid_bits = if bits == 24 { 0x00ff_ffff } else { u32::MAX };
    let mut used = 0;
    for (index, mask) in masks.into_iter().enumerate() {
        if index == 3 && mask == 0 {
            continue;
        }
        let shifted = mask.checked_shr(mask.trailing_zeros()).unwrap_or(0);
        if mask == 0
            || mask & !valid_bits != 0
            || mask & used != 0
            || shifted & shifted.wrapping_add(1) != 0
        {
            return Err("has invalid or overlapping BITFIELDS masks".to_string());
        }
        used |= mask;
    }
    // True-color DIBs may still include a color table (biClrUsed entries).
    let table_bytes = u64::from(dib_u32(bytes, 32)?) * 4;
    let pixel_offset = (pixel_offset as u64)
        .checked_add(table_bytes)
        .ok_or_else(|| "has an overflowing color table".to_string())?;
    let stride = (u64::from(width) * u64::from(bits)).div_ceil(32) * 4;
    let required = pixel_offset
        .checked_add(stride * u64::from(height))
        .ok_or_else(|| "has overflowing pixel dimensions".to_string())?;
    if required > bytes.len() as u64 {
        return Err(format!(
            "has truncated pixel data: needs {required} bytes, received {}",
            bytes.len()
        ));
    }
    let decoded_size = u64::from(width) * u64::from(height) * 4;
    if decoded_size > MAX_DECODED_BYTES {
        return Err(format!("exceeds the {MAX_DECODED_BYTES}-byte decode limit"));
    }
    let mut rgba = Vec::new();
    rgba.try_reserve_exact(decoded_size as usize)
        .map_err(|error| format!("pixel allocation failed: {error}"))?;
    let pixel_bytes = usize::from(bits / 8);
    for y in 0..height {
        let source_y = if signed_height > 0 { height - 1 - y } else { y };
        let row = (pixel_offset + u64::from(source_y) * stride) as usize;
        for x in 0..width as usize {
            let offset = row + x * pixel_bytes;
            let pixel = u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                if bits == 32 { bytes[offset + 3] } else { 0 },
            ]);
            rgba.extend_from_slice(&[
                channel(pixel, masks[0]),
                channel(pixel, masks[1]),
                channel(pixel, masks[2]),
                if masks[3] == 0 {
                    255
                } else {
                    channel(pixel, masks[3])
                },
            ]);
        }
    }
    let x = dib_u32(bytes, 24)? as i32;
    let y = dib_u32(bytes, 28)? as i32;
    let resolution = (x > 0 && y > 0).then_some((x as u32, y as u32));
    encode_rgba(&rgba, width, height, resolution, "bitmap")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> {
        let item = encode_rgba(&[255, 0, 0, 128], 1, 1, None, "fixture").unwrap();
        STANDARD.decode(item.bytes_base64).unwrap()
    }

    fn decoded(item: &ClipboardImageItem) -> image::RgbaImage {
        let bytes = STANDARD.decode(&item.bytes_base64).unwrap();
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .unwrap()
            .into_rgba8()
    }

    fn dib(header_size: usize, width: i32, height: i32, bits: u16, compression: u32) -> Vec<u8> {
        let mut bytes = vec![0; header_size];
        bytes[..4].copy_from_slice(&(header_size as u32).to_le_bytes());
        bytes[4..8].copy_from_slice(&width.to_le_bytes());
        bytes[8..12].copy_from_slice(&height.to_le_bytes());
        bytes[12..14].copy_from_slice(&1u16.to_le_bytes());
        bytes[14..16].copy_from_slice(&bits.to_le_bytes());
        bytes[16..20].copy_from_slice(&compression.to_le_bytes());
        bytes
    }

    fn density_chunk(x: u32, y: u32, unit: u8) -> Vec<u8> {
        let mut chunk = 9u32.to_be_bytes().to_vec();
        chunk.extend_from_slice(b"pHYs");
        chunk.extend_from_slice(&x.to_be_bytes());
        chunk.extend_from_slice(&y.to_be_bytes());
        chunk.push(unit);
        let mut crc = u32::MAX;
        for byte in &chunk[4..] {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
            }
        }
        chunk.extend_from_slice(&(!crc).to_be_bytes());
        chunk
    }

    #[test]
    fn png_density_requires_absolute_units_and_complete_chunks() {
        let original = png();
        for (x, y, unit, expected) in [
            (3780, 7560, 1, Some((3780, 7560))),
            (3780, 7560, 0, None),
            (0, 7560, 1, None),
            (3780, 0, 1, None),
        ] {
            let mut bytes = original[..33].to_vec();
            bytes.extend_from_slice(&density_chunk(x, y, unit));
            bytes.extend_from_slice(&original[33..]);
            assert_eq!(png_pixels_per_meter(&bytes), expected);
            assert_eq!(png_image_item(&bytes).unwrap().pixels_per_meter, expected);
        }
        let mut truncated = original[..33].to_vec();
        truncated.extend_from_slice(&density_chunk(3780, 3780, 1)[..20]);
        assert_eq!(png_pixels_per_meter(&truncated), None);
        let mut overflow = original[..33].to_vec();
        overflow.extend_from_slice(&u32::MAX.to_be_bytes());
        overflow.extend_from_slice(b"pHYs");
        assert_eq!(png_pixels_per_meter(&overflow), None);
        let mut late = original;
        late.extend_from_slice(&density_chunk(3780, 3780, 1));
        assert_eq!(png_pixels_per_meter(&late), None);
        assert_eq!(png_pixels_per_meter(b"not PNG"), None);
    }

    #[test]
    fn png_read_preserves_bytes_and_ihdr_dimensions_and_refuses_decode_failures() {
        let bytes = png();
        let item = png_image_item(&bytes).unwrap();
        assert_eq!(item.r#type, "image/png");
        assert_eq!((item.pixel_width, item.pixel_height), (Some(1), Some(1)));
        assert_eq!(STANDARD.decode(item.bytes_base64).unwrap(), bytes);
        assert_eq!(item.pixels_per_meter, None);
        assert!(png_image_item(&bytes[..33])
            .unwrap_err()
            .contains("PNG decode failed"));
        assert!(png_image_item(b"not PNG").unwrap_err().contains("IHDR"));
    }

    #[test]
    fn dib_24_bit_bottom_up_respects_padding_orientation_and_resolution() {
        let mut bytes = dib(40, 2, 2, 24, 0);
        bytes[24..28].copy_from_slice(&3780i32.to_le_bytes());
        bytes[28..32].copy_from_slice(&7560i32.to_le_bytes());
        bytes.extend_from_slice(&[
            255, 0, 0, 255, 255, 255, 99, 99, // bottom: blue, white, padding
            0, 0, 255, 0, 255, 0, 88, 88, // top: red, green, padding
        ]);
        let item = dib_image_item(&bytes, "CF_DIB").unwrap();
        assert_eq!((item.pixel_width, item.pixel_height), (Some(2), Some(2)));
        assert_eq!(item.pixels_per_meter, Some((3780, 7560)));
        assert_eq!(
            decoded(&item).as_raw(),
            &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,]
        );
    }

    #[test]
    fn dib_32_bit_top_down_ignores_undeclared_alpha() {
        let mut bytes = dib(40, 1, -2, 32, 0);
        bytes.extend_from_slice(&[0, 0, 255, 0, 255, 0, 0, 128]);
        let item = dib_image_item(&bytes, "CF_DIB").unwrap();
        assert_eq!(decoded(&item).as_raw(), &[255, 0, 0, 255, 0, 0, 255, 255]);
        assert_eq!(item.pixels_per_meter, None);
    }

    #[test]
    fn dib_bitfields_reads_external_and_embedded_masks() {
        let masks: [u32; 3] = [0x3ff0_0000, 0x000f_fc00, 0x0000_03ff];
        for header_size in [40, 108] {
            let mut bytes = dib(header_size, 1, -1, 32, 3);
            let mask_bytes: Vec<_> = masks.iter().flat_map(|mask| mask.to_le_bytes()).collect();
            if header_size == 40 {
                bytes.extend_from_slice(&mask_bytes);
            } else {
                bytes[40..52].copy_from_slice(&mask_bytes);
            }
            bytes.extend_from_slice(&(0x3ff0_0000u32 | 512).to_le_bytes());
            let item = dib_image_item(&bytes, "CF_DIB").unwrap();
            assert_eq!(decoded(&item).as_raw(), &[255, 0, 128, 255]);
        }
        // 24-bit bitfields can also permute channel positions.
        let mut bytes = dib(40, 1, 1, 24, 3);
        for mask in [0xffu32, 0xff00, 0xff0000] {
            bytes.extend_from_slice(&mask.to_le_bytes());
        }
        bytes.extend_from_slice(&[11, 22, 33, 0]);
        assert_eq!(
            decoded(&dib_image_item(&bytes, "CF_DIB").unwrap()).as_raw(),
            &[11, 22, 33, 255]
        );
    }

    #[test]
    fn only_v5_explicit_alpha_mask_preserves_alpha() {
        for (header_size, alpha_mask, expected) in [
            (124, 0xff00_0000, 64),
            (124, 0, 255),
            (108, 0xff00_0000, 255),
        ] {
            let mut bytes = dib(header_size, 1, -1, 32, 3);
            for (index, mask) in [0xff0000u32, 0xff00, 0xff, alpha_mask].iter().enumerate() {
                bytes[40 + index * 4..44 + index * 4].copy_from_slice(&mask.to_le_bytes());
            }
            bytes.extend_from_slice(&[33, 22, 11, 64]);
            assert_eq!(
                decoded(&dib_image_item(&bytes, "CF_DIBV5").unwrap()).as_raw(),
                &[11, 22, 33, expected]
            );
        }
    }

    #[test]
    fn dib_failures_are_specific_and_truncations_do_not_panic() {
        let jpeg = dib(40, 1, 1, 24, 4);
        assert_eq!(
            dib_image_item(&jpeg, "CF_DIB").unwrap_err(),
            "CF_DIB has unsupported compression 4 (BI_JPEG)"
        );
        let mut bytes = dib(40, 1, 1, 24, 0);
        bytes.extend_from_slice(&[1, 2, 3, 0]);
        for end in 0..bytes.len() {
            assert!(dib_image_item(&bytes[..end], "CF_DIB").is_err());
        }
        let mut invalid = dib(40, i32::MAX, i32::MIN, 32, 0);
        assert!(dib_image_item(&invalid, "CF_DIB")
            .unwrap_err()
            .contains("dimensions"));
        invalid = dib(40, 1, 1, 32, 3);
        invalid.extend_from_slice(&[0; 16]);
        assert!(dib_image_item(&invalid, "CF_DIB")
            .unwrap_err()
            .contains("masks"));
        let mut palette = dib(40, 1, 1, 24, 0);
        palette[32..36].copy_from_slice(&1u32.to_le_bytes());
        palette.extend_from_slice(&[99, 99, 99, 0, 3, 2, 1, 0]);
        assert_eq!(
            decoded(&dib_image_item(&palette, "CF_DIB").unwrap()).as_raw(),
            &[1, 2, 3, 255]
        );
    }

    #[test]
    fn image_cap_refusal_names_source_size_and_limit() {
        assert!(check_image_byte_length("PNG", MAX_CLIPBOARD_IMAGE_BYTES).is_ok());
        assert_eq!(
            check_image_byte_length("PNG", 32_715_571).unwrap_err(),
            "PNG is 31.2 MB; the limit is 25 MB"
        );
        let bytes = vec![0; MAX_CLIPBOARD_IMAGE_BYTES + 1];
        assert!(png_image_item(&bytes)
            .unwrap_err()
            .contains("the limit is 25 MB"));
        assert!(tiff_image_item(&bytes).unwrap_err().starts_with("TIFF is"));
        assert!(dib_image_item(&bytes, "CF_DIB")
            .unwrap_err()
            .starts_with("CF_DIB is"));
        assert!(svg_image_item(&bytes, "image/svg+xml")
            .unwrap_err()
            .starts_with("image/svg+xml is"));
        let mut buffer = PngBuffer::default();
        assert!(buffer
            .write_all(&bytes)
            .unwrap_err()
            .to_string()
            .contains("25 MB"));
    }

    #[test]
    fn svg_keeps_utf8_bytes_and_rejects_invalid_encoding() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>α</text></svg>";
        let mut bytes = svg.as_bytes().to_vec();
        bytes.extend_from_slice(&[0; 8]);
        let item = svg_image_item(&bytes, "image/svg+xml").unwrap();
        assert_eq!(item.r#type, "image/svg+xml");
        assert_eq!(STANDARD.decode(item.bytes_base64).unwrap(), svg.as_bytes());
        assert!(svg_image_item(&[0xff], "public.svg-image")
            .unwrap_err()
            .contains("UTF-8"));
        assert!(svg_image_item(b"<svg>\0</svg>", "image/svg+xml").is_err());
        assert!(svg_image_item(b"\0\0", "image/svg+xml").is_err());
    }

    #[test]
    fn tiff_converts_pixels_and_refuses_bad_data() {
        let mut bytes = Cursor::new(Vec::new());
        image::codecs::tiff::TiffEncoder::new(&mut bytes)
            .encode(&[11, 22, 33, 64], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let item = tiff_image_item(bytes.get_ref()).unwrap();
        assert_eq!(decoded(&item).as_raw(), &[11, 22, 33, 64]);
        assert!(tiff_image_item(b"bad TIFF")
            .unwrap_err()
            .contains("TIFF decode failed"));
    }

    #[test]
    fn tiff_resolution_reads_both_endiannesses_and_units() {
        for little in [true, false] {
            let word = |value: u32| {
                if little {
                    value.to_le_bytes()
                } else {
                    value.to_be_bytes()
                }
            };
            let short = |value: u16| {
                if little {
                    value.to_le_bytes()
                } else {
                    value.to_be_bytes()
                }
            };
            for (unit, expected) in [
                (1, None),
                (2, Some((11811, 5906))),
                (3, Some((30000, 15000))),
            ] {
                let mut bytes = if little {
                    b"II\x2a\0".to_vec()
                } else {
                    b"MM\0\x2a".to_vec()
                };
                bytes.extend_from_slice(&word(8));
                bytes.extend_from_slice(&short(3));
                for (tag, offset) in [(282, 50), (283, 58)] {
                    bytes.extend_from_slice(&short(tag));
                    bytes.extend_from_slice(&short(5));
                    bytes.extend_from_slice(&word(1));
                    bytes.extend_from_slice(&word(offset));
                }
                bytes.extend_from_slice(&short(296));
                bytes.extend_from_slice(&short(3));
                bytes.extend_from_slice(&word(1));
                bytes.extend_from_slice(&short(unit));
                bytes.extend_from_slice(&[0; 6]); // inline padding + next IFD
                for value in [300, 1, 150, 1] {
                    bytes.extend_from_slice(&word(value));
                }
                assert_eq!(tiff_pixels_per_meter(&bytes), expected);
                for end in 0..bytes.len() {
                    assert_eq!(tiff_pixels_per_meter(&bytes[..end]), None);
                }
            }
        }
    }

    #[test]
    fn payload_serializes_exact_camel_case_image_fields_and_xy_resolution() {
        let payload = crate::ClipboardReadPayload {
            types: vec!["public.png".to_string()],
            text_items: vec![crate::ClipboardTextItem {
                r#type: "text/plain".to_string(),
                text: "unchanged".to_string(),
            }],
            image_items: vec![ClipboardImageItem {
                r#type: "image/png".to_string(),
                bytes_base64: "AQID".to_string(),
                pixels_per_meter: Some((3780, 7560)),
                pixel_width: Some(2),
                pixel_height: Some(3),
            }],
            skipped_image_items: vec![SkippedClipboardImageItem::new(
                "image/png",
                100,
                "CF_DIB decode failed".to_string(),
            )],
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "types": ["public.png"], "textItems": [{"type": "text/plain", "text": "unchanged"}],
                "imageItems": [{"type": "image/png", "bytesBase64": "AQID", "pixelsPerMeter": {"x": 3780, "y": 7560}, "pixelWidth": 2, "pixelHeight": 3}],
                "skippedImageItems": [{"type": "image/png", "byteLength": 100, "reason": "CF_DIB decode failed"}]
            })
        );
        let svg =
            serde_json::to_value(svg_image_item(b"<svg/>", "image/svg+xml").unwrap()).unwrap();
        assert!(svg["pixelsPerMeter"].is_null());
        assert!(svg["pixelWidth"].is_null());
        assert!(svg["pixelHeight"].is_null());
    }
}
