use std::io::{Cursor, Read};

use image::{codecs::jpeg::JpegEncoder, ColorType, DynamicImage, ImageEncoder, ImageFormat};
use resvg::{tiny_skia, usvg};

use crate::fonts::shared_fontdb;

mod pictures;

const DEFAULT_RASTER_SCALE: f64 = 1.0;
const DEFAULT_MAX_DIMENSION_PX: u32 = 8192;
const DEFAULT_JPEG_QUALITY: u8 = 90;
// Bound parser input as well as output pixels. A permitted 25 MiB image becomes 33.3 MiB
// when base64-embedded (PluginImageMaxBytes in plugin-api). 128 MiB accommodates two such
// images plus 500 molecules at the largest checked-in SVG fixture's size (82,007 bytes,
// fixtures/ocsr/brevetoxin-a.svg): about 106 MiB total, with room for page markup.
const MAX_SVG_BYTES: usize = 128 * 1024 * 1024;

/// Export SVGs may embed data URLs, but must never resolve host file paths or URLs.
fn export_svg_options() -> usvg::Options<'static> {
    usvg::Options {
        fontdb: shared_fontdb(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    }
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
    /// PNG pictures decoded by the webview, keyed by the id of their stand-in `<image>`
    /// (`rasterPictureDecode.ts`, `export/pictures.rs`). Absent when the drawing has none.
    #[serde(default)]
    pictures: Vec<pictures::RasterPictureInput>,
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

fn rasterize_svg_impl(mut request: RasterExportRequest) -> Result<RasterExportResponse, String> {
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

    // serde has already deserialized the request by now; sizes, lengths and the decoded-pixel
    // budget are checked before any pixels are unpacked.
    let supplied_pictures = pictures::SuppliedPictures::from_request(
        std::mem::take(&mut request.pictures),
        request.format.label(),
    )?;
    let options = export_svg_options();

    // Inspect the source XML: usvg can discard unsupported or malformed pictures.
    // roxmltree is publicly re-exported by usvg; no extra dependency is needed.
    let document = usvg::roxmltree::Document::parse_with_options(
        &request.svg,
        usvg::roxmltree::ParsingOptions {
            // Match usvg::Tree::from_str.
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|error| format!("Could not parse SVG for raster export: {error}"))?;
    let stand_ins = supplied_pictures.find_stand_ins(&document);
    let over_count_pictures = document
        .descendants()
        .filter(pictures::is_over_count_stand_in)
        .count();
    let mut inspection_budget = MAX_SVG_BYTES;
    let contains_bitmap_pictures = document.descendants().any(|node| {
        let id = node.attribute("id").unwrap_or_default();
        // Supplied pictures are reported below, each with its own reason when not drawn.
        !stand_ins.contains_key(id) && image_is_omitted_bitmap(&node, 0, &mut inspection_budget)
    });
    let tree = usvg::Tree::from_xmltree(&document, &options)
        .map_err(|error| format!("Could not parse SVG for raster export: {error}"))?;
    let base_size = tree.size().to_int_size();
    let (width, height, scale_x, scale_y, mut warnings) = target_size(&request, base_size)?;
    if contains_bitmap_pictures {
        warnings.push(warning(
            "raster_pictures_omitted",
            format!(
                "{} export: PNG and other bitmap pictures are not included in image exports yet; export SVG or PDF to include them.",
                request.format.label()
            ),
        ));
    }
    let background = parse_background(request.background.as_deref())?;

    let mut pixmap =
        tiny_skia::Pixmap::new(width, height).ok_or("Could not allocate raster export surface.")?;
    if let Some([red, green, blue]) = background {
        pixmap.fill(tiny_skia::Color::from_rgba8(red, green, blue, 255));
    }

    let transform = tiny_skia::Transform::from_scale(scale_x, scale_y);
    let drawn_pictures = if supplied_pictures.is_empty() {
        resvg::render(&tree, transform, &mut pixmap.as_mut());
        Default::default()
    } else {
        supplied_pictures.render(&tree, &stand_ins, transform, &mut pixmap.as_mut())
    };
    warnings.extend(supplied_pictures.omission_warnings(
        &stand_ins,
        &drawn_pictures,
        over_count_pictures,
        request.format.label(),
    ));

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

// Inspect source XML: usvg may discard an image before the renderer sees it.
// Check all href namespaces and ambiguous duplicates conservatively.
fn contains_bitmap_pictures(
    document: &usvg::roxmltree::Document<'_>,
    depth: usize,
    remaining_bytes: &mut usize,
) -> bool {
    document
        .descendants()
        .any(|node| image_is_omitted_bitmap(&node, depth, remaining_bytes))
}

/// Whether `node` is an `<image>` that resvg would leave out of the raster: anything but an SVG
/// picture whose own pictures (to a bounded depth) are all SVG.
fn image_is_omitted_bitmap(
    node: &usvg::roxmltree::Node<'_, '_>,
    depth: usize,
    remaining_bytes: &mut usize,
) -> bool {
    if !node.is_element() || node.tag_name().name() != "image" {
        return false;
    }
    // A picture stand-in whose pixels were not supplied with this request.
    if pictures::is_unsupplied_stand_in(node) {
        return true;
    }
    // Left out by the webview for the picture count, and reported with that reason.
    if pictures::is_over_count_stand_in(node) {
        return false;
    }
    let mut hrefs = node
        .attributes()
        .filter(|attr| attr.name() == "href")
        .peekable();
    if hrefs.peek().is_none() {
        return true;
    }
    hrefs.any(|attr| {
        // usvg 0.47 has no explicit image nesting bound. Cap inspection and
        // warn on exhaustion so a deeper bitmap can never be missed.
        if depth >= 32 {
            return true;
        }
        let Some(data) = decode_svg_picture(attr.value(), remaining_bytes) else {
            return true;
        };
        let Ok(text) = std::str::from_utf8(&data) else {
            return true;
        };
        let Ok(nested) = usvg::roxmltree::Document::parse_with_options(
            text,
            usvg::roxmltree::ParsingOptions {
                allow_dtd: true,
                ..Default::default()
            },
        ) else {
            return true;
        };
        contains_bitmap_pictures(&nested, depth + 1, remaining_bytes)
    })
}

// Accept a strict subset of usvg's data-url syntax; anything uncertain warns.
// For this subset, percent decoding followed by base64 decoding matches usvg.
// SVGZ uses the same gzip decoder as usvg, with a bounded output size.
fn decode_svg_picture(href: &str, remaining_bytes: &mut usize) -> Option<Vec<u8>> {
    let href = href.trim_matches(|ch| ch <= ' ');
    let (header, body) = href.split_once(',')?;
    let header = header.to_ascii_lowercase();
    let is_base64 = match header.as_str() {
        "data:image/svg+xml" => false,
        "data:image/svg+xml;base64" => true,
        _ => return None,
    };
    let body = body.split('#').next()?;
    if body.len() > *remaining_bytes {
        return None;
    }
    let body = body.as_bytes();
    let mut data = Vec::with_capacity(body.len());
    let mut index = 0;
    while index < body.len() {
        // Match data-url's handling of literal tabs/newlines, while leaving
        // percent-encoded whitespace intact (it belongs to the decoded SVG).
        if matches!(body[index], b'\t' | b'\n' | b'\r') {
            index += 1;
        } else if body[index] == b'%' {
            let high = char::from(*body.get(index + 1)?).to_digit(16)?;
            let low = char::from(*body.get(index + 2)?).to_digit(16)?;
            data.push((high * 16 + low) as u8);
            index += 3;
        } else {
            data.push(body[index]);
            index += 1;
        }
    }
    if is_base64 {
        data.retain(|byte| !matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '));
        data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()?;
    }
    if data.starts_with(&[0x1f, 0x8b]) {
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(data.as_slice())
            .take(*remaining_bytes as u64 + 1)
            .read_to_end(&mut decoded)
            .ok()?;
        data = decoded;
    }
    *remaining_bytes = remaining_bytes.checked_sub(data.len())?;
    Some(data)
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
        let mut options = export_svg_options();
        options.resources_dir = Some(directory.clone());
        let absolute = image_path.to_string_lossy().replace('\\', "/");
        for href in [
            format!("file:///{absolute}"),
            "https://example.invalid/fixture.svg".to_string(),
            "http://example.invalid/fixture.png".to_string(),
            "fixture.svg".to_string(),
            r"C:\pictures\fixture.png".to_string(),
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
            pictures: Vec::new(),
        }
    }

    fn assert_picture_warning(response: &RasterExportResponse, format: RasterExportFormat) {
        assert_eq!(response.warnings.len(), 1);
        assert_eq!(response.warnings[0].code, "raster_pictures_omitted");
        assert_eq!(response.warnings[0].severity, "warning");
        assert_eq!(
            response.warnings[0].message,
            format!(
                "{} export: PNG and other bitmap pictures are not included in image exports yet; export SVG or PDF to include them.",
                format.label()
            )
        );
    }

    fn svg_picture_page(href: &str, element: &str, attribute: &str) -> String {
        let href = href
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;");
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><{element} {attribute}="{href}" width="8" height="8"/></svg>"#
        )
    }

    fn svg_data_uri(svg: &str) -> String {
        format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(svg)
        )
    }

    #[test]
    fn svg_pictures_render_red_without_a_bitmap_warning() {
        let red = r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>"#;
        let percent_encoded = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='red'/%3E%3C/svg%3E";
        for href in [svg_data_uri(red), percent_encoded.to_string()] {
            for element in ["image", "s:image"] {
                for attribute in ["href", "xlink:href", "s:href"] {
                    let response = rasterize_svg_impl(RasterExportRequest {
                        svg: svg_picture_page(&href, element, attribute),
                        ..request(RasterExportFormat::Png)
                    })
                    .expect("render SVG picture");
                    assert!(response.warnings.is_empty());
                    let pixels = image::load_from_memory(&response.bytes)
                        .expect("decode exported page")
                        .to_rgba8();
                    assert_eq!(pixels.get_pixel(4, 4).0, [255, 0, 0, 255]);
                }
            }
        }
    }

    #[test]
    fn bitmap_pictures_nested_in_svg_pictures_warn() {
        let picture = image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(picture)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("encode nested PNG");
        let href = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        );
        for element in ["image", "s:image", "image xmlns=\"\""] {
            for attribute in ["href", "xlink:href", "s:href"] {
                let mut nested = svg_picture_page(&href, element, attribute);
                for _ in 0..3 {
                    let page = svg_picture_page(&svg_data_uri(&nested), "image", "href");
                    let response = rasterize_svg_impl(RasterExportRequest {
                        svg: page.clone(),
                        ..request(RasterExportFormat::Png)
                    })
                    .expect("export page with nested bitmap");
                    assert_picture_warning(&response, RasterExportFormat::Png);
                    nested = page;
                }
            }
        }
    }

    #[test]
    fn nested_inspection_warns_on_decode_failure_or_exhaustion() {
        for href in [
            "data:image/svg+xml;base64,!",
            "data:image/svg+xml,%FF",
            "data:image/svg+xml,%3Csvg",
        ] {
            let response = rasterize_svg_impl(RasterExportRequest {
                svg: svg_picture_page(href, "image", "href"),
                ..request(RasterExportFormat::Png)
            })
            .expect("undecodable pictures do not prevent page export");
            assert_picture_warning(&response, RasterExportFormat::Png);
        }
        let page = svg_picture_page(&svg_data_uri(SIMPLE_SVG), "image", "href");
        let document = usvg::roxmltree::Document::parse(&page).expect("parse fixture");
        let mut budget = MAX_SVG_BYTES;
        assert!(contains_bitmap_pictures(&document, 32, &mut budget));
        assert!(contains_bitmap_pictures(&document, 0, &mut 1));
    }

    #[test]
    fn svgz_picture_inspection_is_bounded_and_checks_nested_bitmaps() {
        use std::io::Write;

        for (svg, expected_warning) in [
            (SIMPLE_SVG.to_string(), false),
            (
                svg_picture_page("data:image/png;base64,!", "image", "href"),
                true,
            ),
        ] {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(svg.as_bytes()).expect("compress SVG");
            let href = format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD
                    .encode(encoder.finish().expect("finish SVGZ"))
            );
            let page = svg_picture_page(&href, "image", "href");
            let document = usvg::roxmltree::Document::parse(&page).expect("parse SVGZ page");
            let mut budget = MAX_SVG_BYTES;
            assert_eq!(
                contains_bitmap_pictures(&document, 0, &mut budget),
                expected_warning
            );
            let mut small_budget = 1;
            assert!(decode_svg_picture(&href, &mut small_budget).is_none());
        }
    }

    #[test]
    fn page_with_png_picture_warns_and_still_draws_benzene() {
        let picture = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(picture)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("encode the picture fixture");
        let encoded = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 816 1056"><rect width="816" height="1056" fill="#ffffff"/><g data-object-id="benzene" fill="none" stroke="#000000" stroke-width="1"><path d="M 500 280 L 517.32 290 L 517.32 310 L 500 320 L 482.68 310 L 482.68 290 Z"/><path d="M 501 285 L 513 292 M 513 308 L 501 315 M 487 307 L 487 293"/></g><image href="data:image/png;base64,{encoded}" x="192" y="192" width="16" height="16"/></svg>"##
        );
        for scale in [1, 3] {
            let response = rasterize_svg_impl(RasterExportRequest {
                svg: svg.clone(),
                scale: Some(f64::from(scale)),
                ..request(RasterExportFormat::Png)
            })
            .expect("export vectors even when a picture is omitted");
            assert_eq!(
                (response.width, response.height),
                (816 * scale, 1056 * scale)
            );
            assert_picture_warning(&response, RasterExportFormat::Png);
            let pixels = image::load_from_memory(&response.bytes)
                .expect("decode the exported page")
                .to_rgba8();
            assert_eq!(pixels.get_pixel(200 * scale, 200 * scale).0, [255; 4]);
            assert!(pixels.enumerate_pixels().any(|(x, y, pixel)| {
                (480 * scale..520 * scale).contains(&x)
                    && (278 * scale..322 * scale).contains(&y)
                    && pixel[0] < 128
                    && pixel[1] < 128
                    && pixel[2] < 128
            }));
        }
    }

    #[test]
    fn warns_once_for_image_elements_with_any_href_form_in_every_format() {
        for format in [
            RasterExportFormat::Png,
            RasterExportFormat::Jpeg,
            RasterExportFormat::Bmp,
            RasterExportFormat::Gif,
            RasterExportFormat::Tiff,
        ] {
            for attribute in [
                "href=\"data:image/png;base64,!\"",
                "xlink:href=\"data:image/png,%89PNG\"",
                "href=\"https://example.invalid/picture.png\"",
                "href=\"file:///picture.png\"",
                "href=\"picture.png\"",
                "href=\"#picture\"",
                "",
            ] {
                let response = rasterize_svg_impl(RasterExportRequest {
                    svg: format!(
                        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8" height="8"><s:image {attribute} width="8" height="8"/><image width="0" height="0"/></svg>"#
                    ),
                    ..request(format)
                })
                .expect("omitted pictures should warn without failing the export");
                assert_picture_warning(&response, format);
            }
            let response = rasterize_svg_impl(request(format)).expect("export without pictures");
            assert!(response.warnings.is_empty());
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

    const PICTURE_ID: &str = "chemdraft-raster-picture-0";
    /// Straight-alpha colours of the 8 × 8 test picture's quadrants: top left, top right,
    /// bottom left, bottom right.
    const QUADRANTS: [[u8; 4]; 4] = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
    ];
    const WHITE: [u8; 4] = [255; 4];

    fn supplied_picture(
        id: &str,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> pictures::RasterPictureInput {
        pictures::RasterPictureInput {
            id: id.to_string(),
            width: Some(width),
            height: Some(height),
            rgba_base64: Some(base64::engine::general_purpose::STANDARD.encode(rgba)),
            refused: None,
        }
    }

    fn quadrant_picture(id: &str) -> pictures::RasterPictureInput {
        let mut rgba = Vec::with_capacity(8 * 8 * 4);
        for y in 0..8 {
            for x in 0..8 {
                rgba.extend_from_slice(&QUADRANTS[usize::from(y >= 4) * 2 + usize::from(x >= 4)]);
            }
        }
        supplied_picture(id, 8, 8, &rgba)
    }

    fn refused_picture(
        id: &str,
        refusal: pictures::PictureRefusal,
    ) -> pictures::RasterPictureInput {
        pictures::RasterPictureInput {
            id: id.to_string(),
            refused: Some(refusal),
            ..Default::default()
        }
    }

    /// The stand-in `<image>` the webview writes for a picture of `width` × `height` pixels.
    fn stand_in(id: &str, width: u32, height: u32, frame: &str) -> String {
        format!(
            r#"<image id="{id}" {frame} preserveAspectRatio="none" href="{}"/>"#,
            pictures::placeholder_href(width, height, id)
        )
    }

    fn picture_page(size: &str, body: &str) -> String {
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" {size}>{body}</svg>"#)
    }

    fn render_pictures(
        svg: &str,
        scale: u32,
        supplied: Vec<pictures::RasterPictureInput>,
    ) -> (image::RgbaImage, Vec<RasterExportWarning>) {
        let response = rasterize_svg_impl(RasterExportRequest {
            svg: svg.to_string(),
            scale: Some(f64::from(scale)),
            pictures: supplied,
            ..request(RasterExportFormat::Png)
        })
        .expect("render the picture page");
        let pixels = image::load_from_memory(&response.bytes)
            .expect("decode the exported page")
            .to_rgba8();
        (pixels, response.warnings)
    }

    #[track_caller]
    fn assert_rgba_near(pixels: &image::RgbaImage, (x, y): (u32, u32), expected: [u8; 4]) {
        let actual = pixels.get_pixel(x, y).0;
        assert!(
            actual
                .iter()
                .zip(expected)
                .all(|(actual, expected)| actual.abs_diff(expected) <= 2),
            "pixel ({x}, {y}) is {actual:?}, expected {expected:?}"
        );
    }

    #[test]
    fn supplied_pictures_land_on_their_frame_at_every_scale_and_rotation() {
        let picture = stand_in(PICTURE_ID, 8, 8, r#"x="20" y="20" width="40" height="40""#);
        let plain = picture_page(
            r#"width="100" height="100" viewBox="0 0 100 100""#,
            &format!("<g>{picture}</g>"),
        );
        // As documentStyleSvg writes it: a pt-sized root and a scale group (net scale 1 here).
        let document_style = picture_page(
            r#"width="75pt" height="75pt" viewBox="0 0 50 50""#,
            &format!(r#"<g transform="scale(0.5)">{picture}</g>"#),
        );
        // As a rotated picture is written: rotated 90° clockwise about the frame centre.
        let rotated = picture_page(
            r#"width="100" height="100""#,
            &format!(r#"<g transform="rotate(90 40 40)">{picture}</g>"#),
        );
        // Quadrant centres, with the quadrant expected there upright and rotated.
        let probes = [
            ((30, 30), 0, 2),
            ((50, 30), 1, 0),
            ((30, 50), 2, 3),
            ((50, 50), 3, 1),
        ];
        for scale in [1, 3] {
            for (svg, is_rotated) in [(&plain, false), (&document_style, false), (&rotated, true)] {
                let (pixels, warnings) =
                    render_pictures(svg, scale, vec![quadrant_picture(PICTURE_ID)]);
                assert!(warnings.is_empty(), "{warnings:?}");
                assert_eq!(pixels.dimensions(), (100 * scale, 100 * scale));
                for ((x, y), upright, turned) in probes {
                    let quadrant = if is_rotated { turned } else { upright };
                    assert_rgba_near(&pixels, (x * scale, y * scale), QUADRANTS[quadrant]);
                }
                // White just outside each edge of the 20..60 frame, picture just inside.
                assert_rgba_near(&pixels, (20 * scale - 2, 30 * scale), WHITE);
                assert_rgba_near(&pixels, (60 * scale + 1, 30 * scale), WHITE);
                assert_rgba_near(&pixels, (30 * scale, 20 * scale - 2), WHITE);
                assert_rgba_near(&pixels, (30 * scale, 60 * scale + 1), WHITE);
                let edge = QUADRANTS[if is_rotated { 2 } else { 0 }];
                assert_rgba_near(&pixels, (20 * scale + 1, 30 * scale), edge);
            }
        }
    }

    #[test]
    fn supplied_pictures_keep_their_z_order_and_the_rest_of_the_page_matches_resvg() {
        let body = format!(
            r##"<rect x="10" y="10" width="80" height="80" fill="#000000"/><g>{}</g><rect x="40" y="0" width="60" height="100" fill="#ff00ff"/><line x1="0" y1="95" x2="100" y2="95" stroke="#00ff00" stroke-width="2"/><text x="5" y="8" font-size="6">CH3</text>"##,
            stand_in(PICTURE_ID, 8, 8, r#"x="20" y="20" width="40" height="40""#)
        );
        let svg = picture_page(r#"width="100" height="100""#, &body);
        for scale in [1, 3] {
            let (pixels, warnings) =
                render_pictures(&svg, scale, vec![quadrant_picture(PICTURE_ID)]);
            assert!(warnings.is_empty(), "{warnings:?}");
            // Over the black rect drawn before it, under the magenta rect drawn after it.
            assert_rgba_near(&pixels, (30 * scale, 30 * scale), QUADRANTS[0]);
            assert_rgba_near(&pixels, (30 * scale, 50 * scale), QUADRANTS[2]);
            assert_rgba_near(&pixels, (50 * scale, 30 * scale), [255, 0, 255, 255]);
            assert_rgba_near(&pixels, (15 * scale, 15 * scale), [0, 0, 0, 255]);
            // A bare horizontal line has no fill box, and must still be stroked.
            assert_rgba_near(
                &pixels,
                (20 * scale, 94 * scale + scale / 2),
                [0, 255, 0, 255],
            );

            // Off the picture, the page is what resvg draws for the same SVG on its own.
            let (reference, _) = render_pictures(&svg, scale, Vec::new());
            let frame = (20 * scale - 1)..(60 * scale + 1);
            for (x, y, pixel) in pixels.enumerate_pixels() {
                if frame.contains(&x) && frame.contains(&y) {
                    continue;
                }
                let expected = reference.get_pixel(x, y).0;
                assert!(
                    pixel
                        .0
                        .iter()
                        .zip(expected)
                        .all(|(actual, expected)| actual.abs_diff(expected) <= 1),
                    "pixel ({x}, {y}) is {:?}; resvg alone draws {expected:?}",
                    pixel.0
                );
            }
        }
    }

    #[test]
    fn supplied_pictures_honour_group_opacity_alpha_and_slice_clipping() {
        let body = format!(
            r#"<g opacity="0.5">{}</g>{}<image id="chemdraft-raster-picture-2" x="50" y="0" width="40" height="20" preserveAspectRatio="xMidYMid slice" href="{}"/>"#,
            stand_in(PICTURE_ID, 8, 8, r#"x="0" y="0" width="40" height="40""#),
            stand_in(
                "chemdraft-raster-picture-1",
                1,
                1,
                r#"x="0" y="60" width="20" height="20""#
            ),
            pictures::placeholder_href(8, 8, "chemdraft-raster-picture-2")
        );
        let svg = picture_page(r#"width="100" height="100""#, &body);
        let (pixels, warnings) = render_pictures(
            &svg,
            1,
            vec![
                quadrant_picture(PICTURE_ID),
                supplied_picture("chemdraft-raster-picture-1", 1, 1, &[0, 0, 255, 128]),
                quadrant_picture("chemdraft-raster-picture-2"),
            ],
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        // Half-opaque red, and a half-transparent (straight alpha) blue pixel, over white.
        assert_rgba_near(&pixels, (10, 10), [255, 128, 128, 255]);
        assert_rgba_near(&pixels, (10, 70), [127, 127, 255, 255]);
        // The slice covers its 40 × 20 frame with the picture's middle rows, clipped to the frame.
        assert_rgba_near(&pixels, (55, 5), QUADRANTS[0]);
        assert_rgba_near(&pixels, (85, 15), QUADRANTS[3]);
        assert_rgba_near(&pixels, (55, 25), WHITE);
    }

    #[test]
    fn omitted_picture_warnings_name_each_reason_and_skip_drawn_pictures() {
        let id = |index: usize| format!("chemdraft-raster-picture-{index}");
        let frame = |x: u32| format!(r#"x="{x}" y="0" width="10" height="10""#);
        let body = format!(
            r##"<defs><mask id="m"><rect width="100" height="100" fill="#ffffff"/></mask><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse">{}</pattern></defs>{}{}{}{}{}<g mask="url(#m)">{}</g><rect x="50" y="50" width="10" height="10" fill="url(#p)"/><image x="80" y="80" width="10" height="10" href="data:image/jpeg;base64,/9j/4AAQ"/>"##,
            stand_in(&id(6), 8, 8, &frame(0)),
            stand_in(&id(0), 8, 8, &frame(0)),
            stand_in(&id(1), 1, 1, &frame(10)),
            stand_in(&id(2), 1, 1, &frame(20)),
            stand_in(&id(3), 1, 1, &frame(30)),
            stand_in(&id(4), 1, 1, &frame(40)),
            stand_in(&id(5), 8, 8, &frame(50)),
        );
        let svg = picture_page(r#"width="100" height="100""#, &body);
        let (pixels, warnings) = render_pictures(
            &svg,
            1,
            vec![
                quadrant_picture(&id(0)),
                refused_picture(&id(1), pictures::PictureRefusal::TooLarge),
                refused_picture(&id(2), pictures::PictureRefusal::TooLarge),
                refused_picture(&id(3), pictures::PictureRefusal::OverBudget),
                refused_picture(&id(4), pictures::PictureRefusal::DecodeFailed),
                quadrant_picture(&id(5)),
                quadrant_picture(&id(6)),
            ],
        );
        let messages: Vec<&str> = warnings
            .iter()
            .map(|warning| warning.message.as_str())
            .collect();
        assert_eq!(
            messages,
            [
                "PNG export: PNG and other bitmap pictures are not included in image exports yet; export SVG or PDF to include them.",
                "PNG export: 2 pictures larger than 16384 px on a side were not included; export SVG or PDF to include them.",
                "PNG export: 1 picture was not included because the pictures in this export exceed 256 MiB once decoded; export SVG or PDF to include it.",
                "PNG export: 1 picture could not be decoded and was not included; export SVG or PDF to include it.",
                "PNG export: 2 pictures inside a mask, filter, blend mode, pattern or marker were not included; export SVG or PDF to include them.",
            ]
        );
        assert!(warnings.iter().all(|warning| {
            warning.code == "raster_pictures_omitted" && warning.severity == "warning"
        }));
        // The drawn picture is there; the masked one is not drawn at all.
        assert_rgba_near(&pixels, (2, 2), QUADRANTS[0]);
        assert_rgba_near(&pixels, (52, 2), WHITE);

        // Stand-ins whose pixels were not sent fall back to the general warning, once.
        let (_, unsupplied) = render_pictures(&svg, 1, Vec::new());
        assert_eq!(unsupplied.len(), 1);
        assert_eq!(unsupplied[0].message, messages[0]);
    }

    #[test]
    fn supplied_picture_sizes_lengths_and_budget_are_validated_before_unpacking() {
        let picture = |id: &str, width: Option<u32>, height: Option<u32>, rgba_base64: &str| {
            pictures::RasterPictureInput {
                id: id.to_string(),
                width,
                height,
                rgba_base64: Some(rgba_base64.to_string()),
                refused: None,
            }
        };
        let refused = |id: &str| refused_picture(id, pictures::PictureRefusal::DecodeFailed);
        let second = "chemdraft-raster-picture-1";
        let full_budget = Some(8192);
        let cases = [
            (
                vec![picture(PICTURE_ID, Some(2), Some(2), "AAAA")],
                format!("picture {PICTURE_ID} does not carry 2 × 2 RGBA pixels"),
            ),
            (
                vec![picture(PICTURE_ID, Some(1), Some(1), "AAAAAAA=")],
                format!("picture {PICTURE_ID} does not carry 1 × 1 RGBA pixels"),
            ),
            (
                vec![picture(PICTURE_ID, Some(1), Some(1), "!!!!!!!!")],
                format!("picture {PICTURE_ID} is not valid base64"),
            ),
            (
                vec![picture(PICTURE_ID, Some(16385), Some(1), "")],
                format!("picture {PICTURE_ID} is 16385 × 1 px; each side must be 1 to 16384 px"),
            ),
            (
                vec![picture(PICTURE_ID, None, Some(4), "")],
                format!("picture {PICTURE_ID} is 0 × 4 px"),
            ),
            // Exactly the budget passes the size checks (and then fails on its empty payload).
            (
                vec![picture(PICTURE_ID, full_budget, full_budget, "")],
                format!("picture {PICTURE_ID} does not carry 8192 × 8192 RGBA pixels"),
            ),
            (
                vec![
                    picture(PICTURE_ID, full_budget, full_budget, ""),
                    picture(second, Some(1), Some(1), ""),
                ],
                "the pictures exceed 256 MiB of decoded pixels".to_string(),
            ),
            (
                vec![refused(PICTURE_ID), refused(PICTURE_ID)],
                format!("picture id {PICTURE_ID:?} is malformed or repeated"),
            ),
            (
                vec![refused("picture-0")],
                "picture id \"picture-0\" is malformed or repeated".to_string(),
            ),
            (
                vec![pictures::RasterPictureInput {
                    refused: Some(pictures::PictureRefusal::TooLarge),
                    ..picture(PICTURE_ID, Some(1), Some(1), "AAAA/w==")
                }],
                format!("picture {PICTURE_ID} must carry either pixels or a refusal"),
            ),
            (
                vec![pictures::RasterPictureInput {
                    id: PICTURE_ID.to_string(),
                    ..Default::default()
                }],
                format!("picture {PICTURE_ID} must carry either pixels or a refusal"),
            ),
            (
                (0..=pictures::MAX_PICTURES)
                    .map(|index| refused(&format!("chemdraft-raster-picture-{index}")))
                    .collect(),
                "1025 pictures; the limit is 1024".to_string(),
            ),
        ];
        for (supplied, detail) in cases {
            let error = rasterize_svg_impl(RasterExportRequest {
                pictures: supplied,
                ..request(RasterExportFormat::Png)
            })
            .expect_err("invalid picture data must fail the export");
            assert!(
                error.starts_with(
                    "Could not export PNG: the picture data sent for raster export is invalid ("
                ) && error.contains(&detail),
                "{error}"
            );
        }

        // The shape the webview sends; pictures without a stand-in in the SVG are not reported.
        let request: RasterExportRequest = serde_json::from_value(serde_json::json!({
            "svg": SIMPLE_SVG,
            "format": "png",
            "pictures": [
                { "id": PICTURE_ID, "width": 1, "height": 1, "rgbaBase64": "AAAA/w==" },
                { "id": "chemdraft-raster-picture-1", "refused": "tooLarge" },
                { "id": "chemdraft-raster-picture-2", "refused": "overBudget" },
                { "id": "chemdraft-raster-picture-3", "refused": "decodeFailed" }
            ]
        }))
        .expect("the webview's picture shape deserializes");
        assert_eq!(
            request
                .pictures
                .iter()
                .map(|picture| picture.refused)
                .collect::<Vec<_>>(),
            [
                None,
                Some(pictures::PictureRefusal::TooLarge),
                Some(pictures::PictureRefusal::OverBudget),
                Some(pictures::PictureRefusal::DecodeFailed)
            ]
        );
        let response = rasterize_svg_impl(request).expect("valid pictures export");
        assert!(response.warnings.is_empty());
    }

    fn warning_messages(warnings: &[RasterExportWarning]) -> Vec<&str> {
        warnings
            .iter()
            .map(|warning| warning.message.as_str())
            .collect()
    }

    #[test]
    fn supplied_pictures_are_drawn_beside_bare_lines_with_gradient_and_pattern_strokes() {
        // Horizontal and vertical lines have no fill box, so resvg::render_node cannot draw them
        // on their own; every stroke paint must still be drawn, and the picture with them.
        let defs = r##"<defs><linearGradient id="g" x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><radialGradient id="r" cx="50" cy="90" r="50" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00ffff"/><stop offset="1" stop-color="#000000"/></radialGradient><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="4" fill="#00aa00"/><line x1="0" y1="3" x2="4" y2="3" stroke="url(#g)"/></pattern></defs>"##;
        let lines = r#"<line x1="0" y1="80" x2="100" y2="80" stroke="url(#g)" stroke-width="4"/><line x1="0" y1="90" x2="100" y2="90" stroke="url(#r)" stroke-width="4"/><line x1="80" y1="0" x2="80" y2="100" stroke="url(#p)" stroke-width="4"/>"#;
        let picture = stand_in(PICTURE_ID, 8, 8, r#"x="20" y="20" width="40" height="40""#);
        for group in ["<g>", r#"<g opacity="0.5">"#] {
            let svg = picture_page(
                r#"width="100" height="100""#,
                &format!("{defs}{group}{picture}{lines}</g>"),
            );
            for scale in [1, 3] {
                let (pixels, warnings) =
                    render_pictures(&svg, scale, vec![quadrant_picture(PICTURE_ID)]);
                assert!(warnings.is_empty(), "{warnings:?}");
                assert_ne!(pixels.get_pixel(30 * scale, 30 * scale).0, WHITE);
                assert_ne!(pixels.get_pixel(50 * scale, 50 * scale).0, WHITE);

                // Off the picture, the page is what resvg draws for the same SVG on its own.
                let (reference, _) = render_pictures(&svg, scale, Vec::new());
                for (x, y) in [(50, 80), (50, 90), (80, 10)] {
                    assert_ne!(
                        reference.get_pixel(x * scale, y * scale).0,
                        WHITE,
                        "resvg draws the line at ({x}, {y})"
                    );
                }
                let frame = (20 * scale - 1)..(60 * scale + 1);
                for (x, y, pixel) in pixels.enumerate_pixels() {
                    if frame.contains(&x) && frame.contains(&y) {
                        continue;
                    }
                    let expected = reference.get_pixel(x, y).0;
                    assert!(
                        pixel
                            .0
                            .iter()
                            .zip(expected)
                            .all(|(actual, expected)| actual.abs_diff(expected) <= 1),
                        "{group} at {scale}x: pixel ({x}, {y}) is {:?}; resvg alone draws {expected:?}",
                        pixel.0
                    );
                }
            }
        }
    }

    #[test]
    fn svg_pictures_whose_ids_look_generated_are_drawn_without_a_warning() {
        let red = svg_data_uri(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>"##,
        );
        let red_picture = format!(
            r#"<image id="chemdraft-raster-picture-7" x="0" y="0" width="10" height="10" href="{red}"/>"#
        );
        let with_supplied = picture_page(
            r#"width="40" height="20""#,
            &format!(
                "{red_picture}{}",
                stand_in(PICTURE_ID, 8, 8, r#"x="20" y="0" width="20" height="20""#)
            ),
        );
        let (pixels, warnings) =
            render_pictures(&with_supplied, 1, vec![quadrant_picture(PICTURE_ID)]);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_rgba_near(&pixels, (5, 5), [255, 0, 0, 255]);
        assert_rgba_near(&pixels, (22, 2), QUADRANTS[0]);

        let alone = picture_page(r#"width="40" height="20""#, &red_picture);
        let (pixels, warnings) = render_pictures(&alone, 1, Vec::new());
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_rgba_near(&pixels, (5, 5), [255, 0, 0, 255]);
    }

    #[test]
    fn pictures_left_out_for_the_picture_count_are_reported_with_that_reason() {
        let over = |x: u32| {
            format!(
                r#"<image x="{x}" y="0" width="10" height="10" href="{}"/>"#,
                pictures::OVER_COUNT_HREF
            )
        };
        let body = format!(
            "{}{}{}",
            stand_in(PICTURE_ID, 8, 8, r#"x="0" y="0" width="10" height="10""#),
            over(10),
            over(20)
        );
        let svg = picture_page(r#"width="30" height="10""#, &body);
        let (pixels, warnings) = render_pictures(&svg, 1, vec![quadrant_picture(PICTURE_ID)]);
        assert_eq!(
            warning_messages(&warnings),
            ["PNG export: 2 pictures were not included because this export has more than 1024 pictures; export SVG or PDF to include them."]
        );
        assert_rgba_near(&pixels, (2, 2), QUADRANTS[0]);
        assert_rgba_near(&pixels, (15, 5), WHITE);

        let (_, warnings) = render_pictures(
            &picture_page(r#"width="30" height="10""#, &over(0)),
            1,
            Vec::new(),
        );
        assert_eq!(
            warning_messages(&warnings),
            ["PNG export: 1 picture was not included because this export has more than 1024 pictures; export SVG or PDF to include it."]
        );
    }

    #[test]
    fn a_picture_used_again_inside_a_mask_is_drawn_and_warns_only_for_the_masked_copy() {
        let body = format!(
            r##"<defs><mask id="m"><rect width="100" height="100" fill="#ffffff"/></mask></defs>{}<g mask="url(#m)"><use href="#{PICTURE_ID}" x="50" y="50"/></g>"##,
            stand_in(PICTURE_ID, 8, 8, r#"x="0" y="0" width="40" height="40""#)
        );
        let svg = picture_page(r#"width="100" height="100""#, &body);
        let (pixels, warnings) = render_pictures(&svg, 1, vec![quadrant_picture(PICTURE_ID)]);
        assert_eq!(
            warning_messages(&warnings),
            ["PNG export: 1 picture was included, but not its copies inside a mask, filter, blend mode or pattern; export SVG or PDF to include every copy."]
        );
        assert_rgba_near(&pixels, (10, 10), QUADRANTS[0]);
        assert_rgba_near(&pixels, (60, 60), WHITE);
    }

    #[test]
    fn copies_of_a_picture_made_by_reference_are_counted_as_left_out() {
        // usvg drops the ids of copies made through `<use>` or `<feImage>`, so they are not drawn.
        let picture = stand_in(PICTURE_ID, 8, 8, r#"x="0" y="0" width="40" height="40""#);
        for copy in [
            format!(r##"<use href="#{PICTURE_ID}" x="50" y="50"/>"##),
            format!(
                r##"<defs><filter id="f"><feImage href="#{PICTURE_ID}"/></filter></defs><rect x="50" y="50" width="40" height="40" fill="#000000" filter="url(#f)"/>"##
            ),
        ] {
            let svg = picture_page(r#"width="100" height="100""#, &format!("{picture}{copy}"));
            let (pixels, warnings) = render_pictures(&svg, 1, vec![quadrant_picture(PICTURE_ID)]);
            assert_eq!(
                warning_messages(&warnings),
                ["PNG export: 1 picture was included, but not its copies inside a mask, filter, blend mode or pattern; export SVG or PDF to include every copy."],
                "{copy}"
            );
            assert_rgba_near(&pixels, (10, 10), QUADRANTS[0]);
            assert_rgba_near(&pixels, (60, 60), WHITE);
        }
    }

    #[test]
    fn links_and_unrelated_blank_images_are_not_counted_as_copies() {
        // A link clones nothing, and a blank SVG image of a picture's size is no copy of it.
        let picture = stand_in(PICTURE_ID, 8, 8, r#"x="0" y="0" width="40" height="40""#);
        let blank =
            |href: &str| format!(r#"<image x="50" y="50" width="40" height="40" href="{href}"/>"#);
        let unmarked = blank(
            "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='8'%20height='8'/%3E",
        );
        let other_picture = blank(&pictures::placeholder_href(
            8,
            8,
            "chemdraft-raster-picture-9",
        ));
        let link = |id: &str| {
            format!(
                r##"<a href="#{id}"><rect x="50" y="0" width="10" height="10" fill="#000000"/></a>"##
            )
        };
        for body in [
            format!(r##"<a href="#{PICTURE_ID}">{picture}</a>{unmarked}"##),
            format!("{picture}{}{unmarked}{other_picture}", link(PICTURE_ID)),
            format!(r#"<g id="group">{picture}</g>{}{unmarked}"#, link("group")),
        ] {
            let svg = picture_page(r#"width="100" height="100""#, &body);
            let (pixels, warnings) = render_pictures(&svg, 1, vec![quadrant_picture(PICTURE_ID)]);
            assert!(warnings.is_empty(), "{body}: {warnings:?}");
            assert_rgba_near(&pixels, (10, 10), QUADRANTS[0]);
            assert_rgba_near(&pixels, (60, 60), WHITE);
        }
    }

    #[test]
    fn each_copy_is_blamed_only_on_the_picture_it_copies() {
        // Two pictures of the same size; only the second is copied, inside a mask.
        let second = "chemdraft-raster-picture-1";
        let body = format!(
            r##"<defs><mask id="m"><rect width="100" height="100" fill="#ffffff"/></mask></defs>{}{}<g mask="url(#m)"><use href="#{second}" x="50" y="50"/></g>"##,
            stand_in(PICTURE_ID, 8, 8, r#"x="0" y="0" width="40" height="40""#),
            stand_in(second, 8, 8, r#"x="50" y="0" width="40" height="40""#),
        );
        let svg = picture_page(r#"width="100" height="100""#, &body);
        let (pixels, warnings) = render_pictures(
            &svg,
            1,
            vec![quadrant_picture(PICTURE_ID), quadrant_picture(second)],
        );
        assert_eq!(
            warning_messages(&warnings),
            ["PNG export: 1 picture was included, but not its copies inside a mask, filter, blend mode or pattern; export SVG or PDF to include every copy."]
        );
        assert_rgba_near(&pixels, (10, 10), QUADRANTS[0]);
        assert_rgba_near(&pixels, (60, 10), QUADRANTS[0]);
        assert_rgba_near(&pixels, (60, 60), WHITE);
    }
}
