use std::io::{Cursor, Read};
use std::sync::{Arc, Mutex};

use image::{
    codecs::jpeg::JpegEncoder, ColorType, DynamicImage, ImageDecoder, ImageEncoder, ImageFormat,
};
use resvg::{tiny_skia, usvg};

use crate::clipboard_images::{MAX_DECODED_BYTES, MAX_IMAGE_SIDE};
use crate::fonts::shared_fontdb;

const DEFAULT_RASTER_SCALE: f64 = 1.0;
const DEFAULT_MAX_DIMENSION_PX: u32 = 8192;
const DEFAULT_JPEG_QUALITY: u8 = 90;
// Bound parser input as well as output pixels. A permitted 25 MiB image becomes 33.3 MiB
// when base64-embedded (PluginImageMaxBytes in plugin-api). 128 MiB accommodates two such
// images plus 500 molecules at the largest checked-in SVG fixture's size (82,007 bytes,
// fixtures/ocsr/brevetoxin-a.svg): about 106 MiB total, with room for page markup.
const MAX_SVG_BYTES: usize = 128 * 1024 * 1024;
const MAX_PICTURE_SVG_DEPTH: usize = 8;

#[derive(Default)]
struct PictureBudget {
    decoded_bytes: u64,
    error: Option<String>,
}

/// Every nested SVG and feImage shares this resolver policy and decoded-pixel budget.
/// Only PNGs encoded from bounded, decoded pixels may cross into resvg's raster decoders.
fn export_svg_options(
    format: RasterExportFormat,
    budget: &Mutex<PictureBudget>,
    depth: usize,
) -> usvg::Options<'_> {
    usvg::Options {
        fontdb: shared_fontdb(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(move |_, data, _| {
                if budget.lock().expect("picture budget lock").error.is_some() {
                    return None;
                }
                match bounded_export_image(&data, format, budget, depth) {
                    Ok(kind) => Some(kind),
                    Err(error) => {
                        budget
                            .lock()
                            .expect("picture budget lock")
                            .error
                            .get_or_insert(error);
                        None
                    }
                }
            }),
            // usvg parses data: URLs (including MIME parameters and percent encoding)
            // before calling resolve_data. Never fall back to files or network URLs.
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    }
}

fn picture_error(format: RasterExportFormat, reason: &str) -> String {
    format!("Could not export {}: {reason}", format.label())
}

fn picture_decode_error(format: RasterExportFormat, error: image::ImageError) -> String {
    let reason = match error {
        image::ImageError::Limits(error) => match error.kind() {
            image::error::LimitErrorKind::DimensionError => {
                format!("a picture exceeds the {MAX_IMAGE_SIDE} pixel side limit.")
            }
            _ => format!(
                "a picture exceeds the {} MiB picture budget shared by this export.",
                MAX_DECODED_BYTES / (1024 * 1024)
            ),
        },
        _ => "a picture could not be decoded safely.".to_string(),
    };
    picture_error(format, &reason)
}

/// Keep SVG/SVGZ parsing in usvg, but bound decompression and recursive data: images.
fn bounded_export_svg(
    data: &[u8],
    format: RasterExportFormat,
    budget: &Mutex<PictureBudget>,
    depth: usize,
) -> Result<usvg::Tree, String> {
    let mut uncompressed = Vec::new();
    let data = if data.starts_with(&[0x1f, 0x8b]) {
        flate2::read::GzDecoder::new(data)
            .take(MAX_SVG_BYTES as u64 + 1)
            .read_to_end(&mut uncompressed)
            .map_err(|_| picture_error(format, "a picture has unreadable compressed SVG data."))?;
        uncompressed.as_slice()
    } else {
        data
    };
    if data.len() > MAX_SVG_BYTES {
        return Err(picture_error(
            format,
            "a picture exceeds the SVG input size limit.",
        ));
    }
    let options = export_svg_options(format, budget, depth);
    // Pass text, not from_data: a second gzip layer must not invoke usvg's
    // unbounded SVGZ decompressor after our bounded decompression above.
    let text = std::str::from_utf8(data)
        .map_err(|_| picture_error(format, "a picture could not be decoded safely as SVG."))?;
    let tree = usvg::Tree::from_str(text, &options);
    // A resolver returns Option. Propagate its first refusal explicitly so a failed
    // picture never becomes a successful export with that picture silently omitted.
    if let Some(error) = &budget.lock().expect("picture budget lock").error {
        return Err(error.clone());
    }
    tree.map_err(|error| {
        picture_error(
            format,
            &format!("a picture could not be decoded safely as SVG: {error}"),
        )
    })
}

fn bounded_export_image(
    data: &[u8],
    format: RasterExportFormat,
    budget: &Mutex<PictureBudget>,
    depth: usize,
) -> Result<usvg::ImageKind, String> {
    // Ignore MIME claims entirely: raster bytes must use the bounded decoder even
    // when labelled image/svg+xml or given unusual MIME parameters.
    let mut reader = image::ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .map_err(|_| picture_error(format, "a picture could not be decoded safely."))?;
    match reader.format() {
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif) => {}
        Some(ImageFormat::WebP) => {
            return Err(picture_error(
                format,
                "WebP pictures cannot be decoded safely by this build.",
            ));
        }
        Some(_) => {
            return Err(picture_error(
                format,
                "a picture uses a format not supported for safe raster export.",
            ));
        }
        None => {
            if depth >= MAX_PICTURE_SVG_DEPTH {
                return Err(picture_error(
                    format,
                    &format!(
                        "a picture exceeds the nested SVG picture limit of {MAX_PICTURE_SVG_DEPTH} levels."
                    ),
                ));
            }
            return bounded_export_svg(data, format, budget, depth + 1).map(usvg::ImageKind::SVG);
        }
    }

    // Audited against ~/.cargo/registry/src/.../image-0.25.10 (Cargo.lock).
    // Cargo.toml enables png/jpeg/bmp/gif/tiff, without default features or webp.
    // io/image_reader_type.rs supplies Limits to PNG construction; codecs/png.rs
    // checks dimensions before read_info and passes max_alloc to png 0.18.1.
    // JPEG (codecs/jpeg/decoder.rs, zune-jpeg 0.5.15) only reads headers during
    // construction; set_limits checks dimensions before read_image/decode_into.
    // GIF checks the screen dimensions in set_limits and reserves any separate
    // frame buffer before allocating it (codecs/gif.rs::read_image).
    // As in ImageReader::decode, reserve total_bytes BEFORE from_decoder allocates
    // output pixels. Also budget RGBA8 expansion, which resvg ultimately needs.
    // WebP is refused even if enabled later: its wrapper never forwards max_alloc
    // to image-webp 0.2.4, whose ANMF/ALPH path decodes an unchecked VP8 subchunk.
    // Other formats are deliberately excluded from this audited export allowlist.
    let remaining = MAX_DECODED_BYTES - budget.lock().expect("picture budget lock").decoded_bytes;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(remaining);
    reader.limits(limits.clone());
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| picture_decode_error(format, error))?;
    let (width, height) = decoder.dimensions();
    let decoded_bytes = decoder
        .total_bytes()
        .max(u64::from(width) * u64::from(height) * 4);
    if decoded_bytes > remaining {
        return Err(picture_error(
            format,
            &format!(
                "a picture is {width} x {height} pixels and exceeds the {} MiB picture budget shared by this export.",
                MAX_DECODED_BYTES / (1024 * 1024)
            ),
        ));
    }
    limits
        .reserve(decoder.total_bytes())
        .map_err(|error| picture_decode_error(format, error))?;
    decoder
        .set_limits(limits)
        .map_err(|error| picture_decode_error(format, error))?;
    let pixels = DynamicImage::from_decoder(decoder)
        .map_err(|error| picture_decode_error(format, error))?
        .into_rgba8();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&pixels, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|_| {
            picture_error(
                format,
                "a picture could not be prepared safely for rendering.",
            )
        })?;
    budget.lock().expect("picture budget lock").decoded_bytes += decoded_bytes;
    Ok(usvg::ImageKind::PNG(Arc::new(png)))
}

#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RasterExportFormat {
    Png,
    Jpeg,
    Bmp,
    Gif,
    Tiff,
}

impl RasterExportFormat {
    fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
            Self::Bmp => "BMP",
            Self::Gif => "GIF",
            Self::Tiff => "TIFF",
        }
    }
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
pub(crate) async fn rasterize_svg(
    request: RasterExportRequest,
) -> Result<RasterExportResponse, String> {
    let format = request.format;
    tauri::async_runtime::spawn_blocking(move || rasterize_svg_impl(request))
        .await
        .map_err(|error| {
            format!(
                "Could not export {}: the raster rendering worker failed: {error}",
                format.label()
            )
        })?
}

fn rasterize_svg_impl(request: RasterExportRequest) -> Result<RasterExportResponse, String> {
    // Check UTF-8 bytes before font discovery or usvg parsing; usvg's tree limits do not
    // bound the input string (including embedded data: images).
    if request.svg.len() > MAX_SVG_BYTES {
        return Err(format!(
            "Could not export {}: the drawing is too large to render ({:.1} MiB of SVG; the limit is {} MiB).",
            request.format.label(),
            request.svg.len() as f64 / (1024.0 * 1024.0),
            MAX_SVG_BYTES / (1024 * 1024)
        ));
    }

    let tree = bounded_export_svg(
        request.svg.as_bytes(),
        request.format,
        &Mutex::new(PictureBudget::default()),
        0,
    )?;
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
    use base64::Engine as _;

    #[test]
    fn export_images_accept_only_data_urls() {
        let directory =
            std::env::temp_dir().join(format!("chemdraft-export-images-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create image fixture directory");
        let image_path = directory.join("fixture.svg");
        std::fs::write(&image_path, r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>"#)
            .expect("write real image fixture");
        let budget = Mutex::new(PictureBudget::default());
        let mut options = export_svg_options(RasterExportFormat::Png, &budget, 0);
        options.resources_dir = Some(directory.clone());
        let absolute = image_path.to_string_lossy().replace('\\', "/");
        for href in [
            format!("file:///{absolute}"),
            "https://example.invalid/fixture.svg".to_string(),
            "http://example.invalid/fixture.png".to_string(),
            "fixture.svg".to_string(),
            absolute,
        ] {
            let escaped_href = href
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&apos;");
            for attribute in ["href", "xlink:href"] {
                let svg = format!(
                    r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><image {attribute}="{escaped_href}" width="8" height="8"/></svg>"#
                );
                let tree = usvg::Tree::from_data(svg.as_bytes(), &options).expect("parse SVG");
                assert!(tree.root().children().is_empty(), "must not load {href}");
                let response = rasterize_svg_impl(RasterExportRequest {
                    svg,
                    background: Some("transparent".to_string()),
                    ..request(RasterExportFormat::Png)
                })
                .expect("rasterize SVG");
                let pixels = image::load_from_memory(&response.bytes)
                    .expect("decode PNG")
                    .to_rgba8();
                assert!(
                    pixels.pixels().all(|pixel| pixel[3] == 0),
                    "raster must not load {href}"
                );
            }
        }

        let embedded = r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><image href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='red'/%3E%3C/svg%3E" width="8" height="8"/></svg>"#;
        let tree =
            usvg::Tree::from_data(embedded.as_bytes(), &options).expect("parse embedded SVG");
        assert!(!tree.root().children().is_empty(), "data URL must load");
        std::fs::remove_dir_all(&directory).expect("remove fixture directory");
    }

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

    fn red_png_data_url() -> String {
        let image = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("encode the solid red 4x4 picture");
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        )
    }

    fn data_url(mime: &str, bytes: &[u8]) -> String {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    fn picture_svg(href: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><g data-object-id="g12"><image href="{href}" width="64" height="64"/></g></svg>"#
        )
    }

    fn encoded_red_picture(format: ImageFormat) -> Vec<u8> {
        let pixels = image::RgbImage::from_pixel(4, 4, image::Rgb([255, 0, 0]));
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(pixels)
            .write_to(&mut cursor, format)
            .expect("encode a small test picture");
        cursor.into_inner()
    }

    fn png_with_declared_dimensions(width: u32, height: u32) -> Vec<u8> {
        // A tiny PNG of zlib-compressed zeros, with an oversized IHDR and valid CRC.
        // It must be refused before allocating the declared bitmap or reading IDAT.
        let pixels = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 0]));
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(pixels)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("encode tiny zero-filled PNG");
        let mut png = cursor.into_inner();
        png[16..20].copy_from_slice(&width.to_be_bytes());
        png[20..24].copy_from_slice(&height.to_be_bytes());
        let crc = png_crc32(&png[12..29]);
        png[29..33].copy_from_slice(&crc.to_be_bytes());
        assert!(png.len() < 1024, "bomb fixtures must stay tiny");
        png
    }

    fn jpeg_restart_marker_bomb() -> Vec<u8> {
        // The old guard skipped RST0 and saw the first SOF as 1x1. zune-jpeg reads
        // FF C0 as a segment length and skips to the second, 16384x16384 SOF.
        let mut jpeg =
            b"\xff\xd8\xff\xd0\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00".to_vec();
        jpeg.resize(jpeg.len() + 65_459, 0);
        jpeg.extend_from_slice(b"\xff\xc0\x00\x0b\x08\x40\x00\x40\x00\x01\x01\x11\x00\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xff\xd9");
        jpeg
    }

    fn webp_alpha_junk_bomb() -> Vec<u8> {
        fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut chunk = tag.to_vec();
            chunk.extend_from_slice(&(data.len() as u32).to_le_bytes());
            chunk.extend_from_slice(data);
            if !data.len().is_multiple_of(2) {
                chunk.push(0);
            }
            chunk
        }
        // Animated 1x1 canvas/frame, raw 1x1 alpha, then a JUNK-tagged VP8 frame.
        // image-webp 0.2.4's ALPH path ignores that tag and allocates for 16383x16383.
        let mut body = b"WEBP".to_vec();
        body.extend(chunk(b"VP8X", &[0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        body.extend(chunk(b"ANIM", &[0; 6]));
        let mut frame = vec![0; 16];
        frame.extend(chunk(b"ALPH", &[0, 255]));
        frame.extend(chunk(b"JUNK", b"\x00\x00\x00\x9d\x01\x2a\xff\x3f\xff\x3f"));
        body.extend(chunk(b"ANMF", &frame));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&(body.len() as u32).to_le_bytes());
        webp.extend(body);
        assert!(webp.len() < 128);
        webp
    }

    #[test]
    fn refuses_embedded_png_source_bomb_before_render() {
        let png = png_with_declared_dimensions(65_536, 65_536);
        for format in [RasterExportFormat::Png, RasterExportFormat::Jpeg] {
            let error = rasterize_svg_impl(RasterExportRequest {
                svg: picture_svg(&data_url("image/png", &png)),
                ..request(format)
            })
            .expect_err("refuse the 16 GiB source bitmap on a 64x64 page");
            assert_eq!(
                error,
                format!(
                    "Could not export {}: a picture exceeds the 16384 pixel side limit.",
                    format.label()
                )
            );
        }
    }

    #[test]
    fn refuses_jpeg_restart_marker_decoder_differential() {
        let jpeg = jpeg_restart_marker_bomb();
        assert_eq!(jpeg.len(), 17 + 65_459 + 25);
        let error = rasterize_svg_impl(RasterExportRequest {
            svg: picture_svg(&data_url("image/jpeg", &jpeg)),
            ..request(RasterExportFormat::Png)
        })
        .expect_err("must reserve the decoder's actual dimensions before decoding pixels");
        assert_eq!(error, "Could not export PNG: a picture is 16384 x 16384 pixels and exceeds the 256 MiB picture budget shared by this export.");
    }

    #[test]
    fn refuses_webp_alpha_junk_decoder_differential_for_any_mime() {
        let webp = webp_alpha_junk_bomb();
        for mime in [
            "image/webp",
            "application/octet-stream;name=picture",
            "image/svg+xml",
        ] {
            let error = rasterize_svg_impl(RasterExportRequest {
                svg: picture_svg(&data_url(mime, &webp)),
                ..request(RasterExportFormat::Png)
            })
            .expect_err("WebP must never reach image-webp through resvg");
            assert_eq!(
                error,
                "Could not export PNG: WebP pictures cannot be decoded safely by this build."
            );
        }
    }

    #[test]
    fn refuses_nested_svg_and_svgz_source_bombs() {
        for (mime, bytes) in [
            ("image/png", png_with_declared_dimensions(65_536, 65_536)),
            ("image/jpeg", jpeg_restart_marker_bomb()),
            ("image/webp", webp_alpha_junk_bomb()),
        ] {
            let href = data_url(mime, &bytes);
            let nested = picture_svg(&href);
            let mut gzip =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            std::io::Write::write_all(&mut gzip, nested.as_bytes()).expect("gzip nested SVG");
            let svgz = gzip.finish().expect("finish SVGZ");
            for payload in [nested.as_bytes(), svgz.as_slice()] {
                let error = rasterize_svg_impl(RasterExportRequest {
                    svg: picture_svg(&data_url("image/svg+xml;charset=utf-8", payload)),
                    ..request(RasterExportFormat::Png)
                })
                .expect_err("nested SVG must not bypass the raster resolver");
                let direct_error = rasterize_svg_impl(RasterExportRequest {
                    svg: picture_svg(&href),
                    ..request(RasterExportFormat::Png)
                })
                .expect_err("direct bomb");
                assert_eq!(error, direct_error);
            }
        }
    }

    #[test]
    fn refuses_a_picture_over_the_decoded_budget() {
        let png = png_with_declared_dimensions(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE);
        let error = rasterize_svg_impl(RasterExportRequest {
            svg: picture_svg(&data_url("image/png", &png)),
            ..request(RasterExportFormat::Png)
        })
        .expect_err("source fits side limit but requires 1 GiB decoded");
        assert_eq!(error, "Could not export PNG: a picture is 16384 x 16384 pixels and exceeds the 256 MiB picture budget shared by this export.");
    }

    #[test]
    fn refuses_total_decoded_budget_overflow_across_nested_pictures() {
        // Model earlier pictures consuming all but 128 bytes of the real 256 MiB
        // budget. Three valid 4x4 RGBA pictures then exercise the same accounting
        // without allocating hundreds of MiB in a security regression test.
        let budget = Mutex::new(PictureBudget {
            decoded_bytes: MAX_DECODED_BYTES - 128,
            ..Default::default()
        });
        let gif = data_url("image/gif", &encoded_red_picture(ImageFormat::Gif));
        let nested = data_url("image/svg+xml", picture_svg(&gif).as_bytes());
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="{gif}" width="8" height="8"/><image href="{gif}" width="8" height="8"/><image href="{nested}" width="8" height="8"/></svg>"#
        );
        let error = bounded_export_svg(svg.as_bytes(), RasterExportFormat::Png, &budget, 0)
            .expect_err("the third picture must exceed the shared budget");
        assert_eq!(error, "Could not export PNG: a picture is 4 x 4 pixels and exceeds the 256 MiB picture budget shared by this export.");
        assert_eq!(budget.lock().unwrap().decoded_bytes, MAX_DECODED_BYTES);
    }

    #[test]
    fn permits_the_exact_remaining_decoded_budget() {
        let budget = Mutex::new(PictureBudget {
            decoded_bytes: MAX_DECODED_BYTES - 64,
            ..Default::default()
        });
        let gif = data_url("image/gif", &encoded_red_picture(ImageFormat::Gif));
        bounded_export_svg(
            picture_svg(&gif).as_bytes(),
            RasterExportFormat::Png,
            &budget,
            0,
        )
        .expect("a 4x4 picture fits exactly in the remaining 64 bytes");
        assert_eq!(budget.lock().unwrap().decoded_bytes, MAX_DECODED_BYTES);
    }

    #[test]
    fn refuses_undecodable_pictures_instead_of_silently_omitting_them() {
        for mime in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "odd/type;p=v",
        ] {
            let error = rasterize_svg_impl(RasterExportRequest {
                svg: picture_svg(&data_url(mime, b"truncated header")),
                ..request(RasterExportFormat::Png)
            })
            .expect_err("undecodable pictures must fail closed");
            assert!(
                error.starts_with("Could not export PNG: a picture could not be decoded safely")
            );
        }
        // Valid dimensions alone are insufficient: the actual pixel decoder must run.
        let error = rasterize_svg_impl(RasterExportRequest {
            svg: picture_svg(&data_url("image/png", &png_with_declared_dimensions(8, 8))),
            ..request(RasterExportFormat::Png)
        })
        .expect_err("short PNG pixel stream must fail, rather than pass a header check");
        assert_eq!(
            error,
            "Could not export PNG: a picture could not be decoded safely."
        );
    }

    #[test]
    fn refuses_source_bombs_for_any_mime_and_percent_encoded_xlink_hrefs() {
        let png = png_with_declared_dimensions(65_536, 65_536);
        for mime in [
            "text/plain",
            "application/octet-stream;charset=utf-8;name=picture",
            "image/svg+xml",
            "image/png;unusual=value",
        ] {
            let error = rasterize_svg_impl(RasterExportRequest {
                svg: picture_svg(&data_url(mime, &png)),
                ..request(RasterExportFormat::Png)
            })
            .expect_err("MIME parameters must not bypass content guessing or limits");
            assert_eq!(
                error,
                "Could not export PNG: a picture exceeds the 16384 pixel side limit."
            );
        }
        let encoded: String = png.iter().map(|byte| format!("%{byte:02X}")).collect();
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><image xlink:href="data:image/png,{encoded}" width="64" height="64"/></svg>"#
        );
        let error = rasterize_svg_impl(RasterExportRequest {
            svg,
            ..request(RasterExportFormat::Png)
        })
        .expect_err("percent-encoded raster sources must also be bounded");
        assert_eq!(
            error,
            "Could not export PNG: a picture exceeds the 16384 pixel side limit."
        );
    }

    #[test]
    fn refuses_raster_sources_inside_filter_images() {
        let png = data_url("image/png", &png_with_declared_dimensions(65_536, 65_536));
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><filter id="f"><feImage href="{png}"/></filter></defs><rect width="64" height="64" filter="url(#f)"/></svg>"#
        );
        let error = rasterize_svg_impl(RasterExportRequest {
            svg,
            ..request(RasterExportFormat::Png)
        })
        .expect_err("feImage must not bypass the source budget");
        assert_eq!(
            error,
            "Could not export PNG: a picture exceeds the 16384 pixel side limit."
        );
    }

    #[test]
    fn refuses_excessive_svg_picture_nesting() {
        let mut svg = SIMPLE_SVG.to_string();
        for _ in 0..=MAX_PICTURE_SVG_DEPTH {
            svg = picture_svg(&data_url("image/svg+xml", svg.as_bytes()));
        }
        let error = rasterize_svg_impl(RasterExportRequest {
            svg,
            ..request(RasterExportFormat::Png)
        })
        .expect_err("nested SVG parsing must stop before stack exhaustion");
        assert_eq!(
            error,
            "Could not export PNG: a picture exceeds the nested SVG picture limit of 8 levels."
        );
    }

    #[test]
    fn resolver_reencodes_supported_rasters_as_png_regardless_of_mime() {
        for source_format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Gif] {
            let source = encoded_red_picture(source_format);
            let budget = Mutex::new(PictureBudget::default());
            let options = export_svg_options(RasterExportFormat::Png, &budget, 0);
            let kind = (options.image_href_resolver.resolve_data)(
                "application/octet-stream",
                Arc::new(source.clone()),
                &options,
            )
            .expect("bounded raster resolver");
            let usvg::ImageKind::PNG(png) = kind else {
                panic!("only newly encoded PNGs may be passed to resvg");
            };
            assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert_eq!(budget.lock().unwrap().decoded_bytes, 4 * 4 * 4);
            let pixels = image::load_from_memory(&png)
                .expect("decode trusted PNG")
                .to_rgba8();
            for pixel in pixels.pixels() {
                assert!(pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10 && pixel[3] == 255);
            }
            // Exercise usvg's own data-URI parser with MIME parameters as well.
            let response = rasterize_svg_impl(RasterExportRequest {
                svg: picture_svg(&data_url("odd/type;charset=utf-8;name=picture", &source)),
                ..request(RasterExportFormat::Png)
            })
            .expect("render a raster with arbitrary MIME");
            let pixels = image::load_from_memory(&response.bytes)
                .expect("decode export")
                .to_rgba8();
            let pixel = pixels.get_pixel(32, 32);
            assert!(pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10 && pixel[3] == 255);
        }
    }

    #[test]
    fn embedded_png_picture_pixels_survive_every_raster_format_at_1x_and_3x() {
        let href = red_png_data_url();
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ffffff"/><image href="{href}" x="16" y="16" width="32" height="32" preserveAspectRatio="none"/></svg>"##
        );
        for format in [
            RasterExportFormat::Png,
            RasterExportFormat::Jpeg,
            RasterExportFormat::Bmp,
            RasterExportFormat::Gif,
            RasterExportFormat::Tiff,
        ] {
            for scale in [1, 3] {
                let response = rasterize_svg_impl(RasterExportRequest {
                    svg: svg.clone(),
                    scale: Some(f64::from(scale)),
                    ..request(format)
                })
                .expect("export the embedded PNG picture");
                assert_eq!((response.width, response.height), (64 * scale, 64 * scale));
                assert!(response.warnings.is_empty());
                let pixels = image::load_from_memory(&response.bytes)
                    .expect("decode exported picture")
                    .to_rgba8();
                for (x, y) in [(28, 28), (32, 32), (36, 36)] {
                    let pixel = pixels.get_pixel(x * scale, y * scale).0;
                    if format == RasterExportFormat::Jpeg {
                        // JPEG is lossy, but the interior must remain solid red.
                        assert!(pixel[0] > 240 && pixel[1] < 16 && pixel[2] < 16);
                    } else {
                        assert_eq!(pixel, [255, 0, 0, 255], "{format:?} at {scale}x");
                    }
                }
                assert_eq!(pixels.get_pixel(4 * scale, 4 * scale).0, [255; 4]);
            }
        }
    }

    #[test]
    fn nested_svg_picture_renders_vector_and_embedded_png_pixels() {
        let png = red_png_data_url();
        let nested = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><rect width="4" height="4" fill="blue"/><image href="{png}" x="4" width="4" height="4"/></svg>"#
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(nested);
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><g data-object-id="g12"><image href="data:image/svg+xml;base64,{encoded}" x="16" y="16" width="32" height="16" preserveAspectRatio="none"/></g></svg>"#
        );
        for scale in [1, 3] {
            let response = rasterize_svg_impl(RasterExportRequest {
                svg: svg.clone(),
                scale: Some(f64::from(scale)),
                background: Some("transparent".to_string()),
                ..request(RasterExportFormat::Png)
            })
            .expect("export an SVG picture containing vectors and a PNG");
            assert!(response.warnings.is_empty());
            let pixels = image::load_from_memory(&response.bytes)
                .expect("decode SVG picture export")
                .to_rgba8();
            assert_eq!(pixels.get_pixel(24 * scale, 24 * scale).0, [0, 0, 255, 255]);
            assert_eq!(pixels.get_pixel(40 * scale, 24 * scale).0, [255, 0, 0, 255]);
            assert_eq!(pixels.get_pixel(4 * scale, 4 * scale).0, [0; 4]);
        }
    }

    #[test]
    fn letter_page_with_a_picture_and_benzene_is_not_blank_at_1x() {
        // Match the app's physical Letter page, native-unit viewBox, page background,
        // separate molecule/picture groups and data-URI image. Neither may disappear at 1x.
        let href = red_png_data_url();
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 816 1056"><rect width="816" height="1056" fill="#ffffff"/><g data-object-id="benzene" fill="none" stroke="#000000" stroke-width="1"><path d="M 500 280 L 517.32 290 L 517.32 310 L 500 320 L 482.68 310 L 482.68 290 Z"/><path d="M 501 285 L 513 292 M 513 308 L 501 315 M 487 307 L 487 293"/></g><g data-object-id="g12"><image href="{href}" x="192" y="192" width="16" height="16" preserveAspectRatio="none"/></g></svg>"##
        );
        let response = rasterize_svg_impl(RasterExportRequest {
            svg,
            scale: Some(1.0),
            ..request(RasterExportFormat::Png)
        })
        .expect("export a page with benzene and a picture at 1x");
        assert_eq!((response.width, response.height), (816, 1056));
        assert!(response.warnings.is_empty());
        let pixels = image::load_from_memory(&response.bytes)
            .expect("decode page PNG")
            .to_rgba8();
        assert_eq!(pixels.get_pixel(200, 200).0, [255, 0, 0, 255]);
        assert!(pixels.enumerate_pixels().any(|(x, y, pixel)| {
            (480..520).contains(&x)
                && (278..322).contains(&y)
                && pixel[0] < 128
                && pixel[1] < 128
                && pixel[2] < 128
        }));
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
    fn rejects_oversized_svg_before_parsing() {
        // Deliberately invalid SVG: a parser error here would mean the guard ran too late.
        // Multi-byte text also proves the limit counts bytes rather than characters.
        let response = rasterize_svg_impl(RasterExportRequest {
            svg: "é".repeat(MAX_SVG_BYTES / 2 + 1),
            ..request(RasterExportFormat::Png)
        });
        assert_eq!(
            response.expect_err("oversized input should fail before parsing"),
            "Could not export PNG: the drawing is too large to render (128.0 MiB of SVG; the limit is 128 MiB)."
        );
    }

    #[test]
    fn async_command_preserves_synchronous_render_bytes() {
        for format in [
            RasterExportFormat::Png,
            RasterExportFormat::Jpeg,
            RasterExportFormat::Bmp,
            RasterExportFormat::Gif,
            RasterExportFormat::Tiff,
        ] {
            let expected =
                rasterize_svg_impl(request(format)).expect("normal render should encode");
            let actual = tauri::async_runtime::block_on(rasterize_svg(request(format)))
                .expect("background render should encode");
            assert_eq!(actual.bytes, expected.bytes);
            assert_eq!(actual.width, expected.width);
            assert_eq!(actual.height, expected.height);
            assert!(actual.warnings.is_empty());
        }
    }

    #[test]
    fn output_dimension_limit_cannot_be_raised_by_the_request() {
        let request = RasterExportRequest {
            scale: Some(1000.0),
            max_dimension_px: Some(u32::MAX),
            ..request(RasterExportFormat::Png)
        };
        let base_size = tiny_skia::IntSize::from_wh(64, 32).expect("valid source dimensions");
        let (width, height, _, _, warnings) =
            target_size(&request, base_size).expect("large dimensions should clamp");
        assert_eq!(width, DEFAULT_MAX_DIMENSION_PX);
        assert_eq!(height, DEFAULT_MAX_DIMENSION_PX / 2);
        assert_eq!(warnings[0].code, "raster_dimension_clamped");
        assert_eq!(
            warnings[0].message,
            "Raster export was clamped to 8192px on its longest side."
        );
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
    fn png_export_at_3x_declares_288_dpi_on_both_axes() {
        let response = rasterize_svg_impl(RasterExportRequest {
            scale: Some(3.0),
            css_px_per_inch: Some(96.0),
            ..request(RasterExportFormat::Png)
        })
        .expect("PNG export at 3x should encode with density");
        assert_eq!((response.width, response.height), (192, 96));
        let phys_offset = response
            .bytes
            .windows(4)
            .position(|window| window == b"pHYs")
            .expect("PNG should contain a pHYs chunk");
        let data = &response.bytes[phys_offset + 4..phys_offset + 13];
        let expected = (288.0_f64 / 0.0254).round() as u32;
        assert_eq!(u32::from_be_bytes(data[0..4].try_into().unwrap()), expected);
        assert_eq!(u32::from_be_bytes(data[4..8].try_into().unwrap()), expected);
        assert_eq!(data[8], 1, "pHYs unit must be metres");
        image::load_from_memory(&response.bytes).expect("PNG with 288 dpi should decode");
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
