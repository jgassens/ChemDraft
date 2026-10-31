use std::io::{Cursor, Read};
use std::sync::{Arc, Mutex};

use image::{codecs::jpeg::JpegEncoder, ColorType, DynamicImage, ImageEncoder, ImageFormat};
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

/// Export SVGs may embed data URLs, but must never read files from the host.
fn export_svg_options<'a>() -> usvg::Options<'a> {
    usvg::Options {
        fontdb: shared_fontdb(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    }
}

#[derive(Default)]
struct PictureBudget {
    decoded_bytes: u64,
    error: Option<String>,
}

/// Validate at the href resolver, before usvg can discard an unreadable image and before
/// resvg can allocate its source bitmap. The same budget spans all nested SVGs and feImages.
fn bounded_export_svg(
    data: &[u8],
    format: RasterExportFormat,
    budget: &Mutex<PictureBudget>,
    picture: &str,
    depth: usize,
) -> Result<usvg::Tree, String> {
    let fail = |reason| format!("Could not export {}: {picture} {reason}", format.label());
    let mut uncompressed = Vec::new();
    let data = if data.starts_with(&[0x1f, 0x8b]) {
        // usvg also accepts SVGZ data URLs. Do not let gzip bypass the SVG input bound.
        flate2::read::GzDecoder::new(data)
            .take(MAX_SVG_BYTES as u64 + 1)
            .read_to_end(&mut uncompressed)
            .map_err(|_| fail("has unreadable compressed SVG data."))?;
        if uncompressed.len() > MAX_SVG_BYTES {
            return Err(fail("exceeds the SVG input size limit."));
        }
        &uncompressed
    } else {
        data
    };
    let text = std::str::from_utf8(data).map_err(|_| fail("has unreadable SVG data."))?;
    let doc = usvg::roxmltree::Document::parse_with_options(
        text,
        usvg::roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|error| format!("Could not parse SVG for raster export: {error}"))?;
    let mut options = export_svg_options();
    options.image_href_resolver.resolve_data = Box::new(|mime, data, _| {
        if budget.lock().expect("picture budget lock").error.is_some() {
            return None;
        }
        match bounded_export_image(mime, data, &doc, format, budget, picture, depth) {
            Ok(kind) => kind,
            Err(error) => {
                budget
                    .lock()
                    .expect("picture budget lock")
                    .error
                    .get_or_insert(error);
                None
            }
        }
    });
    let tree = usvg::Tree::from_xmltree(&doc, &options);
    // A resolver returns Option, so propagate its first refusal explicitly rather than
    // exporting a drawing with the offending picture silently omitted.
    if let Some(error) = &budget.lock().expect("picture budget lock").error {
        return Err(error.clone());
    }
    tree.map_err(|error| format!("Could not parse SVG for raster export: {error}"))
}

fn bounded_export_image(
    mime: &str,
    data: Arc<Vec<u8>>,
    doc: &usvg::roxmltree::Document<'_>,
    format: RasterExportFormat,
    budget: &Mutex<PictureBudget>,
    picture: &str,
    depth: usize,
) -> Result<Option<usvg::ImageKind>, String> {
    // Mirror usvg's MIME handling, including magic sniffing for text/plain data URLs.
    let kind = match mime {
        "image/png" => usvg::ImageKind::PNG(data),
        "image/jpg" | "image/jpeg" => usvg::ImageKind::JPEG(data),
        "image/gif" => usvg::ImageKind::GIF(data),
        "image/webp" => usvg::ImageKind::WEBP(data),
        "text/plain" if data.starts_with(b"\x89PNG\r\n\x1a\n") => usvg::ImageKind::PNG(data),
        "text/plain" if data.starts_with(b"\xff\xd8") => usvg::ImageKind::JPEG(data),
        "text/plain" if data.starts_with(b"GIF8") => usvg::ImageKind::GIF(data),
        "text/plain" if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") => {
            usvg::ImageKind::WEBP(data)
        }
        "image/svg+xml" | "text/plain" => {
            let picture = picture_source_label(doc, &data, picture);
            if depth >= MAX_PICTURE_SVG_DEPTH {
                return Err(format!(
                    "Could not export {}: {picture} exceeds the nested SVG picture limit of {MAX_PICTURE_SVG_DEPTH} levels.",
                    format.label()
                ));
            }
            return bounded_export_svg(&data, format, budget, &picture, depth + 1)
                .map(|tree| Some(usvg::ImageKind::SVG(tree)));
        }
        _ => return Ok(None),
    };
    let check = || -> Result<(), String> {
        let (width, height) = raster_source_dimensions(&kind)
            .filter(|&(width, height)| width > 0 && height > 0)
            .ok_or(
                "has an unreadable raster image header; source dimensions could not be checked.",
            )?;
        if width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
            return Err(format!(
                "is {width} x {height} pixels; the limit is {MAX_IMAGE_SIDE} pixels on a side."
            ));
        }
        let decoded_bytes = u64::from(width) * u64::from(height) * 4;
        if decoded_bytes > MAX_DECODED_BYTES {
            return Err(format!(
                "is {width} x {height} pixels and exceeds the {} MiB decoded picture limit.",
                MAX_DECODED_BYTES / (1024 * 1024)
            ));
        }
        let mut budget = budget.lock().expect("picture budget lock");
        if decoded_bytes > MAX_DECODED_BYTES - budget.decoded_bytes {
            return Err(format!(
                "would exceed the {} MiB total decoded picture limit.",
                MAX_DECODED_BYTES / (1024 * 1024)
            ));
        }
        budget.decoded_bytes += decoded_bytes;
        Ok(())
    };
    check().map_err(|reason| {
        let data = match &kind {
            usvg::ImageKind::PNG(data)
            | usvg::ImageKind::JPEG(data)
            | usvg::ImageKind::GIF(data)
            | usvg::ImageKind::WEBP(data) => data,
            usvg::ImageKind::SVG(_) => unreachable!(),
        };
        let picture = picture_source_label(doc, data, picture);
        format!("Could not export {}: {picture} {reason}", format.label())
    })?;
    Ok(Some(kind))
}

/// Diagnostic lookup only: image resolution and validation use usvg's decoded bytes above.
/// Match decoded hrefs so percent encoding, xlink:href and unpadded base64 retain object IDs.
fn picture_source_label(
    doc: &usvg::roxmltree::Document<'_>,
    data: &[u8],
    fallback: &str,
) -> String {
    for node in doc
        .descendants()
        .filter(|node| node.is_element() && matches!(node.tag_name().name(), "image" | "feImage"))
    {
        let Some(id) = node
            .ancestors()
            .filter(|ancestor| ancestor.has_tag_name("g"))
            .find_map(|ancestor| ancestor.attribute("data-object-id"))
        else {
            continue;
        };
        for attr in node.attributes().filter(|attr| attr.name() == "href") {
            if diagnostic_data_url_bytes(attr.value()).as_deref() == Some(data) {
                return format!("picture {id}");
            }
        }
    }
    fallback.to_string()
}

fn diagnostic_data_url_bytes(href: &str) -> Option<Vec<u8>> {
    let href: String = href
        .trim_matches(|ch| ch <= ' ')
        .chars()
        .filter(|ch| !matches!(ch, '\t' | '\n' | '\r'))
        .take_while(|ch| *ch != '#')
        .collect();
    if !href.get(..5)?.eq_ignore_ascii_case("data:") {
        return None;
    }
    let (header, body) = href[5..].split_once(',')?;
    let bytes = body.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let Some(pair) = bytes.get(index + 1..index + 3) {
                if let (Some(high), Some(low)) = (
                    (pair[0] as char).to_digit(16),
                    (pair[1] as char).to_digit(16),
                ) {
                    decoded.push((high * 16 + low) as u8);
                    index += 3;
                    continue;
                }
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    if header
        .rsplit_once(';')
        .is_some_and(|(_, suffix)| suffix.trim().eq_ignore_ascii_case("base64"))
    {
        decoded.retain(|byte| !byte.is_ascii_whitespace());
        let engine = base64::engine::general_purpose::GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            base64::engine::general_purpose::GeneralPurposeConfig::new()
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
                .with_decode_allow_trailing_bits(true),
        );
        base64::Engine::decode(&engine, decoded).ok()
    } else {
        Some(decoded)
    }
}

/// Header reads only: never instantiate an image decoder or allocate a pixel buffer here.
fn raster_source_dimensions(kind: &usvg::ImageKind) -> Option<(u32, u32)> {
    match kind {
        usvg::ImageKind::PNG(data) => {
            let header = data.get(..33)?;
            if &header[..16] != b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR" {
                return None;
            }
            Some((
                u32::from_be_bytes(header[16..20].try_into().ok()?),
                u32::from_be_bytes(header[20..24].try_into().ok()?),
            ))
        }
        usvg::ImageKind::JPEG(data) => jpeg_source_dimensions(data),
        usvg::ImageKind::GIF(data) => gif_source_dimensions(data),
        usvg::ImageKind::WEBP(data) => webp_source_dimensions(data),
        usvg::ImageKind::SVG(_) => None,
    }
}

fn gif_source_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let header = data.get(..13)?;
    if !matches!(&header[..6], b"GIF87a" | b"GIF89a") {
        return None;
    }
    let width = u32::from(u16::from_le_bytes(header[6..8].try_into().ok()?));
    let height = u32::from(u16::from_le_bytes(header[8..10].try_into().ok()?));
    if width == 0 || height == 0 {
        return None;
    }
    if width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
        return Some((width, height));
    }
    let mut index = 13usize;
    if header[10] & 0x80 != 0 {
        index += 3 * (1usize << ((header[10] & 7) + 1));
    }
    loop {
        match *data.get(index)? {
            0x2c => {
                // resvg decodes the first frame, and gif does not require it to fit the
                // logical screen. Account for that frame's dimensions too, without LZW.
                let frame = data.get(index..index.checked_add(10)?)?;
                let frame_width = u32::from(u16::from_le_bytes(frame[5..7].try_into().ok()?));
                let frame_height = u32::from(u16::from_le_bytes(frame[7..9].try_into().ok()?));
                if frame_width == 0 || frame_height == 0 {
                    return None;
                }
                return Some((width.max(frame_width), height.max(frame_height)));
            }
            0x21 => {
                index = index.checked_add(2)?; // extension introducer and label
                loop {
                    let length = usize::from(*data.get(index)?);
                    index = index.checked_add(1)?;
                    data.get(index..index.checked_add(length)?)?;
                    index += length;
                    if length == 0 {
                        break;
                    }
                }
            }
            _ => return None,
        }
    }
}

fn jpeg_source_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if !data.starts_with(b"\xff\xd8") {
        return None;
    }
    let mut index = 2usize;
    loop {
        if *data.get(index)? != 0xff {
            return None;
        }
        while *data.get(index)? == 0xff {
            index += 1;
        }
        let marker = *data.get(index)?;
        index += 1;
        if matches!(marker, 0x00 | 0xd8..=0xda) {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = usize::from(u16::from_be_bytes(
            data.get(index..index.checked_add(2)?)?.try_into().ok()?,
        ));
        if length < 2 {
            return None;
        }
        let segment = data.get(index..index.checked_add(length)?)?;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let header = segment.get(..8)?;
            return Some((
                u32::from(u16::from_be_bytes(header[5..7].try_into().ok()?)),
                u32::from(u16::from_be_bytes(header[3..5].try_into().ok()?)),
            ));
        }
        index += length;
    }
}

fn webp_source_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let header = data.get(..20)?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
        return None;
    }
    let length = u32::from_le_bytes(header[16..20].try_into().ok()?) as usize;
    let end = 20usize.checked_add(length)?;
    let chunk = data.get(20..end)?;
    let mut dimensions = webp_chunk_dimensions(&header[12..16], chunk)?;
    if &header[12..16] == b"VP8X" {
        // A malformed extended WebP can declare a small canvas but contain a much larger
        // VP8 source. image-webp decodes that source before checking it against the canvas.
        webp_extend_dimensions(
            data.get(end.checked_add(length & 1)?..)?,
            &mut dimensions,
            true,
        )?;
    }
    Some(dimensions)
}

fn webp_uint24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn webp_extend_dimensions(
    mut chunks: &[u8],
    dimensions: &mut (u32, u32),
    allow_animation: bool,
) -> Option<()> {
    while !chunks.is_empty() {
        let header = chunks.get(..8)?;
        let length = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
        let end = 8usize.checked_add(length)?;
        let chunk = chunks.get(8..end)?;
        match &header[..4] {
            b"VP8 " | b"VP8L" => {
                let (width, height) = webp_chunk_dimensions(&header[..4], chunk)?;
                dimensions.0 = dimensions.0.max(width);
                dimensions.1 = dimensions.1.max(height);
            }
            b"ANMF" => {
                if !allow_animation {
                    return None;
                }
                let frame = chunk.get(..16)?;
                dimensions.0 = dimensions.0.max(webp_uint24(&frame[6..9]) + 1);
                dimensions.1 = dimensions.1.max(webp_uint24(&frame[9..12]) + 1);
                webp_extend_dimensions(&chunk[16..], dimensions, false)?;
            }
            _ => {}
        }
        chunks = chunks.get(end.checked_add(length & 1)?..)?;
    }
    Some(())
}

fn webp_chunk_dimensions(tag: &[u8], chunk: &[u8]) -> Option<(u32, u32)> {
    match tag {
        b"VP8 " => {
            let frame = chunk.get(..10)?;
            if frame[0] & 1 != 0 || &frame[3..6] != b"\x9d\x01\x2a" {
                return None;
            }
            Some((
                u32::from(u16::from_le_bytes(frame[6..8].try_into().ok()?) & 0x3fff),
                u32::from(u16::from_le_bytes(frame[8..10].try_into().ok()?) & 0x3fff),
            ))
        }
        b"VP8L" => {
            let frame = chunk.get(..5)?;
            let bits = u32::from_le_bytes(frame[1..5].try_into().ok()?);
            if frame[0] != 0x2f || bits >> 29 != 0 {
                return None;
            }
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8X" => {
            let frame = chunk.get(..10)?;
            Some((
                webp_uint24(&frame[4..7]) + 1,
                webp_uint24(&frame[7..10]) + 1,
            ))
        }
        _ => None,
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
        "a picture",
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
        let mut options = export_svg_options();
        options.resources_dir = Some(directory.clone());
        let absolute = image_path.to_string_lossy().replace('\\', "/");
        for href in [
            format!("file:///{absolute}"),
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

    fn png_with_declared_dimensions(width: u32, height: u32) -> Vec<u8> {
        // Preserve real PNG chunks, including IDAT, while changing IHDR and its CRC. Its
        // tiny compressed scanlines cannot fill the declared bitmap, but tiny-skia would
        // allocate that entire bitmap BEFORE discovering the short image data.
        let mut png = diagnostic_data_url_bytes(&red_png_data_url()).expect("PNG data URL");
        png[16..20].copy_from_slice(&width.to_be_bytes());
        png[20..24].copy_from_slice(&height.to_be_bytes());
        let crc = png_crc32(&png[12..29]);
        png[29..33].copy_from_slice(&crc.to_be_bytes());
        assert!(
            png.len() < 1024,
            "fixtures must never allocate large rasters"
        );
        png
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
                format!("Could not export {}: picture g12 is 65536 x 65536 pixels; the limit is 16384 pixels on a side.", format.label())
            );
        }
    }

    #[test]
    fn refuses_nested_svg_and_svgz_source_bombs() {
        let png = data_url("image/png", &png_with_declared_dimensions(65_536, 65_536));
        // The inner image has no object ID: retain the enclosing outer picture's ID.
        let nested = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="{png}" width="64" height="64"/></svg>"#
        );
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gzip, nested.as_bytes()).expect("gzip nested SVG");
        let svgz = gzip.finish().expect("finish SVGZ");
        for payload in [nested.as_bytes(), svgz.as_slice()] {
            let error = rasterize_svg_impl(RasterExportRequest {
                svg: picture_svg(&data_url("image/svg+xml", payload)),
                ..request(RasterExportFormat::Png)
            })
            .expect_err("refuse a nested source bitmap bomb");
            assert_eq!(error, "Could not export PNG: picture g12 is 65536 x 65536 pixels; the limit is 16384 pixels on a side.");
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
        assert_eq!(error, "Could not export PNG: picture g12 is 16384 x 16384 pixels and exceeds the 256 MiB decoded picture limit.");
    }

    #[test]
    fn refuses_total_decoded_budget_overflow_across_nested_pictures() {
        let png = data_url("image/png", &png_with_declared_dimensions(4096, 6144));
        // Each source is 96 MiB. Two are in the outer SVG and the third is nested.
        let nested = picture_svg(&png);
        let nested = data_url("image/svg+xml", nested.as_bytes());
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="{png}" width="8" height="8"/><image href="{png}" width="8" height="8"/><g data-object-id="g12"><image href="{nested}" width="8" height="8"/></g></svg>"#
        );
        let error = rasterize_svg_impl(RasterExportRequest {
            svg,
            ..request(RasterExportFormat::Png)
        })
        .expect_err("three individually permitted sources exceed the shared budget");
        assert_eq!(error, "Could not export PNG: picture g12 would exceed the 256 MiB total decoded picture limit.");
    }

    #[test]
    fn permits_the_exact_decoded_budget_without_decoding_pixels() {
        let budget = Mutex::new(PictureBudget::default());
        let png = data_url("image/png", &png_with_declared_dimensions(8192, 8192));
        bounded_export_svg(
            picture_svg(&png).as_bytes(),
            RasterExportFormat::Png,
            &budget,
            "a picture",
            0,
        )
        .expect("256 MiB is permitted; only parse the header in this test");
        assert_eq!(budget.lock().unwrap().decoded_bytes, MAX_DECODED_BYTES);
    }

    #[test]
    fn refuses_unreadable_headers_instead_of_silently_omitting_pictures() {
        for mime in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            let error = rasterize_svg_impl(RasterExportRequest {
                svg: picture_svg(&data_url(mime, b"truncated header")),
                ..request(RasterExportFormat::Png)
            })
            .expect_err("unreadable raster headers must fail closed");
            assert_eq!(error, "Could not export PNG: picture g12 has an unreadable raster image header; source dimensions could not be checked.");
        }
    }

    #[test]
    fn refuses_source_bombs_with_text_plain_mime_and_without_an_object_id() {
        let png = png_with_declared_dimensions(65_536, 65_536);
        let svg = picture_svg(&data_url("text/plain", &png)).replace("data-object-id=\"g12\"", "");
        let error = rasterize_svg_impl(RasterExportRequest {
            svg,
            ..request(RasterExportFormat::Png)
        })
        .expect_err("MIME sniffing must use the same bounds");
        assert_eq!(error, "Could not export PNG: a picture is 65536 x 65536 pixels; the limit is 16384 pixels on a side.");
    }

    #[test]
    fn source_refusals_preserve_ids_for_percent_encoded_xlink_hrefs() {
        let png = png_with_declared_dimensions(65_536, 65_536);
        let encoded: String = png.iter().map(|byte| format!("%{byte:02X}")).collect();
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><g data-object-id="g12"><image xlink:href="data:image/png,{encoded}" width="64" height="64"/></g></svg>"#
        );
        let error = rasterize_svg_impl(RasterExportRequest {
            svg,
            ..request(RasterExportFormat::Png)
        })
        .expect_err("percent-encoded raster sources must also be bounded");
        assert_eq!(error, "Could not export PNG: picture g12 is 65536 x 65536 pixels; the limit is 16384 pixels on a side.");
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
        assert_eq!(error, "Could not export PNG: a picture is 65536 x 65536 pixels; the limit is 16384 pixels on a side.");
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
            "Could not export PNG: picture g12 exceeds the nested SVG picture limit of 8 levels."
        );
    }

    #[test]
    fn raster_headers_are_read_without_a_pixel_decoder() {
        // SOI, APP0 (empty), SOF2: a progressive JPEG source header only.
        let jpeg = b"\xff\xd8\xff\xe0\0\x02\xff\xc2\0\x0b\x08\0\x10\0\x20\x01\x01\x11\0";
        assert_eq!(jpeg_source_dimensions(jpeg), Some((32, 16)));
        assert_eq!(jpeg_source_dimensions(&jpeg[..jpeg.len() - 1]), None);

        // GIF logical screen plus a comment extension and the first image descriptor.
        let gif = b"GIF89a\x20\0\x10\0\0\0\0\x21\xfe\x01x\0\x2c\0\0\0\0\x20\0\x10\0\0";
        assert_eq!(gif_source_dimensions(gif), Some((32, 16)));
        let mut oversized_frame = gif.to_vec();
        let length = oversized_frame.len();
        oversized_frame[length - 5..length - 3].copy_from_slice(&32_768u16.to_le_bytes());
        assert_eq!(gif_source_dimensions(&oversized_frame), Some((32_768, 16)));

        let webp = |tag: &[u8; 4], payload: &[u8]| {
            let mut bytes = b"RIFF".to_vec();
            bytes.extend_from_slice(&(12 + payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(b"WEBP");
            bytes.extend_from_slice(tag);
            bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(payload);
            bytes
        };
        for bytes in [
            webp(b"VP8 ", b"\0\0\0\x9d\x01\x2a\x20\0\x10\0"),
            webp(b"VP8L", &[0x2f, 0x1f, 0xc0, 0x03, 0]),
            webp(b"VP8X", &[0, 0, 0, 0, 31, 0, 0, 15, 0, 0]),
        ] {
            assert_eq!(webp_source_dimensions(&bytes), Some((32, 16)));
            assert_eq!(webp_source_dimensions(&bytes[..bytes.len() - 1]), None);
        }

        let mut extended = webp(b"VP8X", &[0, 0, 0, 0, 31, 0, 0, 15, 0, 0]);
        let source = webp(b"VP8 ", b"\0\0\0\x9d\x01\x2a\xff\x3f\xff\x3f");
        extended.extend_from_slice(&source[12..]);
        let riff_length = (extended.len() - 8) as u32;
        extended[4..8].copy_from_slice(&riff_length.to_le_bytes());
        assert_eq!(webp_source_dimensions(&extended), Some((16_383, 16_383)));
        let error = rasterize_svg_impl(RasterExportRequest {
            svg: picture_svg(&data_url("image/webp", &extended)),
            ..request(RasterExportFormat::Png)
        })
        .expect_err("a small WebP canvas must not hide an oversized VP8 source");
        assert_eq!(error, "Could not export PNG: picture g12 is 16383 x 16383 pixels and exceeds the 256 MiB decoded picture limit.");
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
