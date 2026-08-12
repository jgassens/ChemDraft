use std::io::Cursor;

use image::{codecs::jpeg::JpegEncoder, ColorType, DynamicImage, ImageEncoder, ImageFormat};
use resvg::{tiny_skia, usvg};

use crate::fonts::shared_fontdb;

const DEFAULT_RASTER_SCALE: f64 = 1.0;
const DEFAULT_MAX_DIMENSION_PX: u32 = 8192;
const DEFAULT_JPEG_QUALITY: u8 = 90;

#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RasterExportFormat {
    Png,
    Jpeg,
    Bmp,
    Gif,
    Tiff,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RasterExportRequest {
    svg: String,
    format: RasterExportFormat,
    scale: Option<f64>,
    background: Option<String>,
    jpeg_quality: Option<u8>,
    max_dimension_px: Option<u32>,
    /// The physical size, in CSS pixels per inch (96, by the CSS/SVG convention every source SVG
    /// this app emits is authored in), that the SOURCE SVG's own units represent — NOT the final
    /// stamped density. The actual density is derived from this times the scale really applied
    /// (see `target_size`), so a request that gets clamped for `max_dimension_px` still gets a
    /// truthful density instead of one describing the unclamped size that was asked for.
    css_px_per_inch: Option<f64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RasterExportWarning {
    code: &'static str,
    message: String,
    severity: &'static str,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RasterExportResponse {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    warnings: Vec<RasterExportWarning>,
}

#[tauri::command]
pub(crate) fn rasterize_svg(request: RasterExportRequest) -> Result<RasterExportResponse, String> {
    rasterize_svg_impl(request)
}

fn rasterize_svg_impl(request: RasterExportRequest) -> Result<RasterExportResponse, String> {
    let options = usvg::Options {
        fontdb: shared_fontdb(),
        ..Default::default()
    };

    let tree = usvg::Tree::from_data(request.svg.as_bytes(), &options)
        .map_err(|error| format!("Could not parse SVG for raster export: {error}"))?;
    let base_size = tree.size().to_int_size();
    let (width, height, scale_x, scale_y, mut warnings) = target_size(&request, base_size)?;
    let background = parse_background(request.background.as_deref())?;

    let mut pixmap =
        tiny_skia::Pixmap::new(width, height).ok_or("Could not allocate raster export surface.")?;
    if let Some([red, green, blue]) = background {
        pixmap.fill(tiny_skia::Color::from_rgba8(red, green, blue, 255));
    }

    let transform = tiny_skia::Transform::from_scale(scale_x, scale_y);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    let (mut bytes, encode_warnings) =
        encode_raster(&pixmap, request.format, background, request.jpeg_quality)?;
    warnings.extend(encode_warnings);
    if request.format == RasterExportFormat::Png {
        if let Some(css_px_per_inch) = request.css_px_per_inch {
            // scale_x/scale_y are the ACTUAL raster-px-per-source-px ratio after any
            // max-dimension clamping above, so this always matches the bitmap really produced —
            // never a nominal request that clamping silently made too large.
            let applied_scale = f64::from((scale_x + scale_y) / 2.0);
            bytes = png_with_physical_density(bytes, applied_scale * css_px_per_inch)?;
        }
    }

    Ok(RasterExportResponse {
        bytes,
        width,
        height,
        warnings,
    })
}

fn target_size(
    request: &RasterExportRequest,
    base_size: tiny_skia::IntSize,
) -> Result<(u32, u32, f32, f32, Vec<RasterExportWarning>), String> {
    let scale = request.scale.unwrap_or(DEFAULT_RASTER_SCALE);
    if !scale.is_finite() || scale <= 0.0 {
        return Err("Raster export scale must be a positive finite number.".to_string());
    }

    let max_dimension_px = request
        .max_dimension_px
        .unwrap_or(DEFAULT_MAX_DIMENSION_PX)
        .clamp(1, DEFAULT_MAX_DIMENSION_PX);
    let requested_width = (f64::from(base_size.width()) * scale).round().max(1.0);
    let requested_height = (f64::from(base_size.height()) * scale).round().max(1.0);
    let requested_max = requested_width.max(requested_height);
    let mut warnings = Vec::new();
    let clamp_scale = if requested_max > f64::from(max_dimension_px) {
        warnings.push(warning(
            "raster_dimension_clamped",
            format!("Raster export was clamped to {max_dimension_px}px on its longest side."),
        ));
        f64::from(max_dimension_px) / requested_max
    } else {
        1.0
    };

    let width = (requested_width * clamp_scale)
        .round()
        .clamp(1.0, f64::from(max_dimension_px)) as u32;
    let height = (requested_height * clamp_scale)
        .round()
        .clamp(1.0, f64::from(max_dimension_px)) as u32;
    let scale_x = width as f32 / base_size.width() as f32;
    let scale_y = height as f32 / base_size.height() as f32;

    Ok((width, height, scale_x, scale_y, warnings))
}

fn encode_raster(
    pixmap: &tiny_skia::Pixmap,
    format: RasterExportFormat,
    background: Option<[u8; 3]>,
    jpeg_quality: Option<u8>,
) -> Result<(Vec<u8>, Vec<RasterExportWarning>), String> {
    let width = pixmap.width();
    let height = pixmap.height();
    let mut warnings = Vec::new();
    let mut cursor = Cursor::new(Vec::new());

    match format {
        RasterExportFormat::Png => {
            let image = image::RgbaImage::from_raw(width, height, straight_rgba(pixmap.data()))
                .ok_or("Could not prepare PNG raster export data.")?;
            DynamicImage::ImageRgba8(image)
                .write_to(&mut cursor, ImageFormat::Png)
                .map_err(|error| format!("Could not encode PNG export: {error}"))?;
        }
        RasterExportFormat::Jpeg => {
            let quality = jpeg_quality.unwrap_or(DEFAULT_JPEG_QUALITY).clamp(1, 100);
            if let Some(requested) = jpeg_quality {
                if requested != quality {
                    warnings.push(warning(
                        "jpeg_quality_clamped",
                        "JPEG export quality was clamped to the supported 1-100 range.".to_string(),
                    ));
                }
            }
            let rgb = flatten_to_rgb(pixmap.data(), background.unwrap_or([255, 255, 255]));
            let encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
            encoder
                .write_image(&rgb, width, height, ColorType::Rgb8.into())
                .map_err(|error| format!("Could not encode JPEG export: {error}"))?;
        }
        RasterExportFormat::Bmp => {
            let image = image::RgbImage::from_raw(
                width,
                height,
                flatten_to_rgb(pixmap.data(), background.unwrap_or([255, 255, 255])),
            )
            .ok_or("Could not prepare BMP raster export data.")?;
            DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, ImageFormat::Bmp)
                .map_err(|error| format!("Could not encode BMP export: {error}"))?;
        }
        RasterExportFormat::Gif => {
            let image = image::RgbImage::from_raw(
                width,
                height,
                flatten_to_rgb(pixmap.data(), background.unwrap_or([255, 255, 255])),
            )
            .ok_or("Could not prepare GIF raster export data.")?;
            DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, ImageFormat::Gif)
                .map_err(|error| format!("Could not encode GIF export: {error}"))?;
        }
        RasterExportFormat::Tiff => {
            let image = image::RgbImage::from_raw(
                width,
                height,
                flatten_to_rgb(pixmap.data(), background.unwrap_or([255, 255, 255])),
            )
            .ok_or("Could not prepare TIFF raster export data.")?;
            DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, ImageFormat::Tiff)
                .map_err(|error| format!("Could not encode TIFF export: {error}"))?;
        }
    }

    Ok((cursor.into_inner(), warnings))
}

fn straight_rgba(data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    for pixel in data.chunks_exact(4) {
        let alpha = u16::from(pixel[3]);
        if alpha == 0 {
            output.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if alpha == 255 {
            output.extend_from_slice(pixel);
            continue;
        }

        output.push(unpremultiply(pixel[0], alpha));
        output.push(unpremultiply(pixel[1], alpha));
        output.push(unpremultiply(pixel[2], alpha));
        output.push(pixel[3]);
    }
    output
}

fn unpremultiply(value: u8, alpha: u16) -> u8 {
    ((u16::from(value) * 255 + alpha / 2) / alpha).min(255) as u8
}

fn flatten_to_rgb(data: &[u8], background: [u8; 3]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len() / 4 * 3);
    for pixel in data.chunks_exact(4) {
        let alpha = u16::from(pixel[3]);
        let inverse_alpha = 255 - alpha;
        output.push(flatten_channel(pixel[0], background[0], inverse_alpha));
        output.push(flatten_channel(pixel[1], background[1], inverse_alpha));
        output.push(flatten_channel(pixel[2], background[2], inverse_alpha));
    }
    output
}

fn flatten_channel(premultiplied: u8, background: u8, inverse_alpha: u16) -> u8 {
    (u16::from(premultiplied) + ((u16::from(background) * inverse_alpha + 127) / 255)).min(255)
        as u8
}

fn parse_background(value: Option<&str>) -> Result<Option<[u8; 3]>, String> {
    let Some(raw_value) = value else {
        return Ok(Some([255, 255, 255]));
    };
    let value = raw_value.trim();
    if value.eq_ignore_ascii_case("transparent") {
        return Ok(None);
    }

    let hex = value.strip_prefix('#').ok_or_else(|| {
        "Raster export background must be a hex color or transparent.".to_string()
    })?;
    // Validate as ASCII hex before indexing: the command accepts arbitrary strings,
    // and byte-slicing a multi-byte char (e.g. "#\u{2603}") would otherwise panic.
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Raster export background contains an invalid hex color.".to_string());
    }
    let digits = hex.as_bytes();
    match digits.len() {
        3 => Ok(Some([
            expand_hex_nibble(digits[0]),
            expand_hex_nibble(digits[1]),
            expand_hex_nibble(digits[2]),
        ])),
        6 => Ok(Some([
            combine_hex_pair(digits[0], digits[1]),
            combine_hex_pair(digits[2], digits[3]),
            combine_hex_pair(digits[4], digits[5]),
        ])),
        _ => Err("Raster export background must be a 3- or 6-digit hex color.".to_string()),
    }
}

/// Expands a single hex nibble to a full byte (`A` -> `0xAA`), matching CSS short hex.
fn expand_hex_nibble(digit: u8) -> u8 {
    hex_value(digit) * 17
}

fn combine_hex_pair(high: u8, low: u8) -> u8 {
    hex_value(high) * 16 + hex_value(low)
}

/// Caller validates ASCII-hex first, so the wildcard arm is unreachable in practice.
fn hex_value(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        b'A'..=b'F' => digit - b'A' + 10,
        _ => 0,
    }
}

/// Inserts a pHYs chunk after IHDR so consumers paste an oversampled PNG at its
/// intended physical size instead of its pixel size. Replaces any existing pHYs.
fn png_with_physical_density(bytes: Vec<u8>, pixels_per_inch: f64) -> Result<Vec<u8>, String> {
    if !pixels_per_inch.is_finite() || pixels_per_inch <= 0.0 {
        return Err("PNG export density must be a positive finite number.".to_string());
    }
    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err("PNG export density metadata requires a PNG payload.".to_string());
    }

    let pixels_per_meter = (pixels_per_inch / 0.0254).round();
    if pixels_per_meter < 1.0 || pixels_per_meter > f64::from(u32::MAX) {
        return Err("PNG export density is out of the representable range.".to_string());
    }
    let pixels_per_meter = pixels_per_meter as u32;

    let mut phys_chunk = Vec::with_capacity(21);
    phys_chunk.extend_from_slice(&9u32.to_be_bytes());
    phys_chunk.extend_from_slice(b"pHYs");
    phys_chunk.extend_from_slice(&pixels_per_meter.to_be_bytes());
    phys_chunk.extend_from_slice(&pixels_per_meter.to_be_bytes());
    phys_chunk.push(1); // unit: meter
    let crc = png_crc32(&phys_chunk[4..]);
    phys_chunk.extend_from_slice(&crc.to_be_bytes());

    let mut output = Vec::with_capacity(bytes.len() + phys_chunk.len());
    output.extend_from_slice(&PNG_SIGNATURE);
    let mut offset = PNG_SIGNATURE.len();
    let mut inserted = false;
    while offset + 8 <= bytes.len() {
        let length = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        let chunk_end = offset
            .checked_add(12 + length)
            .filter(|end| *end <= bytes.len())
            .ok_or("PNG export payload has a malformed chunk length.")?;
        let chunk_type = &bytes[offset + 4..offset + 8];
        if chunk_type != b"pHYs" {
            output.extend_from_slice(&bytes[offset..chunk_end]);
        }
        if chunk_type == b"IHDR" && !inserted {
            output.extend_from_slice(&phys_chunk);
            inserted = true;
        }
        offset = chunk_end;
    }
    if !inserted {
        return Err("PNG export payload is missing its IHDR chunk.".to_string());
    }

    Ok(output)
}

fn png_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn warning(code: &'static str, message: String) -> RasterExportWarning {
    RasterExportWarning {
        code,
        message,
        severity: "warning",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32"><rect width="64" height="32" fill="#ffffff"/><circle cx="16" cy="16" r="8" fill="#111111"/></svg>"##;

    fn request(format: RasterExportFormat) -> RasterExportRequest {
        RasterExportRequest {
            svg: SIMPLE_SVG.to_string(),
            format,
            scale: None,
            background: None,
            jpeg_quality: None,
            max_dimension_px: None,
            css_px_per_inch: None,
        }
    }

    #[test]
    fn encodes_supported_raster_formats() {
        let cases = [
            (RasterExportFormat::Png, &[0x89, b'P', b'N', b'G'][..]),
            (RasterExportFormat::Jpeg, &[0xff, 0xd8][..]),
            (RasterExportFormat::Bmp, &b"BM"[..]),
            (RasterExportFormat::Gif, &b"GIF8"[..]),
        ];

        for (format, magic) in cases {
            let response =
                rasterize_svg_impl(request(format)).expect("raster export should encode");
            assert_eq!(response.width, 64);
            assert_eq!(response.height, 32);
            assert!(response.bytes.starts_with(magic));
        }

        let tiff = rasterize_svg_impl(request(RasterExportFormat::Tiff))
            .expect("TIFF export should encode");
        assert_eq!(tiff.width, 64);
        assert_eq!(tiff.height, 32);
        assert!(tiff.bytes.starts_with(b"II") || tiff.bytes.starts_with(b"MM"));
    }

    #[test]
    fn png_export_embeds_density_derived_from_the_applied_scale() {
        let response = rasterize_svg_impl(RasterExportRequest {
            scale: Some(4.0),
            css_px_per_inch: Some(96.0),
            ..request(RasterExportFormat::Png)
        })
        .expect("PNG export with density should encode");

        assert_eq!(response.width, 256);
        assert_eq!(response.height, 128);
        let phys_offset = response
            .bytes
            .windows(4)
            .position(|window| window == b"pHYs")
            .expect("PNG should contain a pHYs chunk");
        let data = &response.bytes[phys_offset + 4..phys_offset + 13];
        let pixels_per_meter = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        // scale 4 on a 96 css-px/inch source is 384 real dpi, not the unrelated 288 (4x72) a
        // caller might otherwise be tempted to hardcode — 384 / 0.0254 = 15118 px/meter.
        assert_eq!(pixels_per_meter, 15118);
        assert_eq!(data[8], 1);

        // The IHDR chunk must still come first and decode cleanly.
        assert_eq!(&response.bytes[12..16], b"IHDR");
        image::load_from_memory(&response.bytes).expect("PNG with pHYs should still decode");
    }

    #[test]
    fn clamps_large_output_dimensions() {
        let response = rasterize_svg_impl(RasterExportRequest {
            scale: Some(100.0),
            max_dimension_px: Some(128),
            ..request(RasterExportFormat::Png)
        })
        .expect("clamped raster export should encode");

        assert_eq!(response.width, 128);
        assert_eq!(response.height, 64);
        assert_eq!(response.warnings[0].code, "raster_dimension_clamped");
    }

    #[test]
    fn png_density_reflects_the_scale_actually_applied_after_clamping() {
        // Request scale 100 on a 96 css-px/inch source, clamped to 128px wide (from 6400px
        // nominal) — the actually-applied scale is only 128/64 = 2, not the nominal 100, so the
        // embedded density must reflect 2 * 96 = 192dpi, never a value describing the unclamped
        // 100x request that was silently cut down.
        let response = rasterize_svg_impl(RasterExportRequest {
            scale: Some(100.0),
            max_dimension_px: Some(128),
            css_px_per_inch: Some(96.0),
            ..request(RasterExportFormat::Png)
        })
        .expect("clamped PNG export with density should encode");

        assert_eq!(response.width, 128);
        assert_eq!(response.height, 64);
        let phys_offset = response
            .bytes
            .windows(4)
            .position(|window| window == b"pHYs")
            .expect("PNG should contain a pHYs chunk");
        let data = &response.bytes[phys_offset + 4..phys_offset + 13];
        let pixels_per_meter = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        // 192dpi / 0.0254 = 7559 px/meter (rounded) — NOT 100*96/0.0254 = 377953, which is what
        // stamping the unclamped nominal request would have produced.
        assert_eq!(pixels_per_meter, 7559);
    }

    #[test]
    fn rejects_invalid_background_color() {
        let error = rasterize_svg_impl(RasterExportRequest {
            background: Some("white".to_string()),
            ..request(RasterExportFormat::Png)
        })
        .expect_err("invalid background should fail");

        assert!(error.contains("background"));
    }

    #[test]
    fn parses_short_hex_and_rejects_non_ascii_background() {
        assert_eq!(
            parse_background(Some("#abc")).expect("short hex parses"),
            Some([0xaa, 0xbb, 0xcc])
        );
        assert_eq!(
            parse_background(Some("#1A2b3C")).expect("full hex parses"),
            Some([0x1a, 0x2b, 0x3c])
        );
        assert_eq!(
            parse_background(Some("transparent")).expect("transparent parses"),
            None
        );
        // A multi-byte char reaches the 3-length arm by byte count; it must return an
        // error rather than panic on a non-char-boundary slice.
        assert!(parse_background(Some("#\u{2603}")).is_err());
    }
}
