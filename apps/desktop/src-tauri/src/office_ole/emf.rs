use std::io::{Cursor, Read};

use flate2::Crc;
use image::{codecs::png::PngDecoder, DynamicImage, ImageDecoder, ImageError, Limits};

use super::OleError;

pub(super) const MAX_PNG_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 8000;
const DEFAULT_DPI: u32 = 96;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

const EMR_HEADER: u32 = 1;
const EMR_EOF: u32 = 14;
const EMR_COMMENT: u32 = 70;
const EMR_STRETCHDIBITS: u32 = 81;
const EMF_PLUS_HEADER: u16 = 0x4001;
const EMF_PLUS_EOF: u16 = 0x4002;
const EMF_PLUS_OBJECT: u16 = 0x4008;
const EMF_PLUS_DRAW_IMAGE: u16 = 0x401a;
const GRAPHICS_VERSION: u32 = 0xdbc0_1002;

const HEADER_SIZE: usize = 108;
const COMMENT_HEADER_SIZE: usize = 16;
const PLUS_HEADER_SIZE: usize = 12;
const DIB_OFFSET: usize = 120;
const EOF_SIZE: usize = 20;

/// Write an EMF+ dual preview with the original carrier PNG and a GDI fallback.
#[cfg_attr(not(test), allow(dead_code))] // Standalone preview writer for the clipboard producer.
pub(crate) fn preview_emf(png: &[u8]) -> Result<Vec<u8>, OleError> {
    Ok(preview_with_extent(png, None)?.0)
}

pub(super) fn preview_with_extent(
    png: &[u8],
    selection: Option<&str>,
) -> Result<(Vec<u8>, [i32; 2]), OleError> {
    if png.len() > MAX_PNG_BYTES {
        return Err(OleError("Preview PNG exceeds 25 MiB".into()));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    let decoder =
        PngDecoder::with_limits(Cursor::new(png), limits).map_err(|error| match error {
            ImageError::Limits(ref limit)
                if limit.kind() == image::error::LimitErrorKind::DimensionError =>
            {
                OleError("Preview PNG exceeds 8000 pixels on a side".into())
            }
            _ => decode_error(error),
        })?;
    let (width, height) = decoder.dimensions();
    let dpi = png_dpi(png, selection)?;
    let micrometers = [
        device_micrometers(width, dpi[0])?,
        device_micrometers(height, dpi[1])?,
    ];
    let pixels = DynamicImage::from_decoder(decoder)
        .map_err(decode_error)?
        .into_rgba8();
    let width = width as i32;
    let height = height as i32;

    let object_size = PLUS_HEADER_SIZE + 28 + png.len().next_multiple_of(4);
    let picture_size =
        COMMENT_HEADER_SIZE + PLUS_HEADER_SIZE + 16 + object_size + PLUS_HEADER_SIZE + 40;
    let dib_size = DIB_OFFSET + pixels.as_raw().len();
    let plus_eof_size = COMMENT_HEADER_SIZE + PLUS_HEADER_SIZE;
    let total_size = HEADER_SIZE + picture_size + dib_size + plus_eof_size + EOF_SIZE;
    let mut emf = Vec::with_capacity(total_size);

    let header = emr(&mut emf, EMR_HEADER, HEADER_SIZE);
    put(header, 16, (width - 1).to_le_bytes());
    put(header, 20, (height - 1).to_le_bytes());
    let extent = micrometers.map(|um| (um + 5) / 10); // HIMETRIC, shared with IOleObject.
    put(header, 32, extent[0].to_le_bytes());
    put(header, 36, extent[1].to_le_bytes());
    put(header, 40, *b" EMF");
    put(header, 44, 0x0001_0000u32.to_le_bytes()); // EMF version.
    put(header, 48, (total_size as u32).to_le_bytes());
    put(header, 52, 5u32.to_le_bytes()); // EMR record count.
    put(header, 56, 1u16.to_le_bytes()); // Reserved handle table slot.
    put(header, 72, width.to_le_bytes());
    put(header, 76, height.to_le_bytes());
    put(
        header,
        80,
        ((micrometers[0] + 500) / 1000).max(1).to_le_bytes(),
    );
    put(
        header,
        84,
        ((micrometers[1] + 500) / 1000).max(1).to_le_bytes(),
    );
    put(header, 100, micrometers[0].to_le_bytes());
    put(header, 104, micrometers[1].to_le_bytes());

    let picture = plus_comment(&mut emf, picture_size);
    write_picture(picture, png, object_size, width, height, dpi);
    write_dib(
        emr(&mut emf, EMR_STRETCHDIBITS, dib_size),
        width,
        height,
        pixels.as_raw(),
    );

    // GDI+ requires its EOF comment immediately before the outer EMR_EOF.
    plus_record(plus_comment(&mut emf, plus_eof_size), EMF_PLUS_EOF, 0);
    let eof = emr(&mut emf, EMR_EOF, EOF_SIZE);
    put(eof, 12, 16u32.to_le_bytes()); // Offset of the empty palette.
    put(eof, 16, (EOF_SIZE as u32).to_le_bytes());
    Ok((emf, extent))
}

fn decode_error(error: ImageError) -> OleError {
    OleError(format!("Could not decode preview PNG: {error}"))
}

// The image decoder exposes pixels but does not expose pHYs. Walk the chunk boundaries
// through IEND so the carrier preserved in the EMF+ record is complete.
fn png_dpi(png: &[u8], selection: Option<&str>) -> Result<[u32; 2], OleError> {
    let mut chunks = png
        .strip_prefix(PNG_SIGNATURE)
        .ok_or_else(|| OleError("Invalid preview PNG signature".into()))?;
    let mut dpi = None;
    let mut saw_idat = false;
    let mut saw_selection = false;
    while let Some((header, remaining)) = chunks.split_at_checked(8) {
        let size = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let kind = &header[4..8];
        let Some((data, crc_and_chunks)) = remaining.split_at_checked(size) else {
            break;
        };
        let Some((stored_crc, next)) = crc_and_chunks.split_at_checked(4) else {
            break;
        };
        let mut crc = Crc::new();
        crc.update(kind);
        crc.update(data);
        if stored_crc != crc.sum().to_be_bytes() {
            let name = String::from_utf8_lossy(kind);
            return Err(OleError(format!("Invalid preview PNG {name} checksum")));
        }

        if let Some(json) = selection {
            if matches!(kind, b"iTXt" | b"zTXt") {
                if let Some(text) = data.strip_prefix(b"application/x-chemdraft-selection+json\0") {
                    if saw_selection || !carrier_matches(kind, text, json)? {
                        return Err(OleError(
                            "Preview PNG selection differs from ChemDraftDocument or occurs twice"
                                .into(),
                        ));
                    }
                    saw_selection = true;
                }
            }
        }
        match kind {
            b"pHYs" => {
                if data.len() != 9 || dpi.is_some() || saw_idat || data[8] > 1 {
                    return Err(OleError("Invalid preview PNG pHYs chunk".into()));
                }
                let axis_dpi = |bytes: &[u8]| {
                    let pixels_per_meter = u32::from_be_bytes(bytes.try_into().unwrap());
                    // Round metric densities to whole DPI, as in the Office probe.
                    let dpi = (u64::from(pixels_per_meter) * 254 + 5000) / 10000;
                    if data[8] == 1 && dpi > 0 {
                        dpi as u32
                    } else {
                        DEFAULT_DPI
                    }
                };
                dpi = Some([axis_dpi(&data[..4]), axis_dpi(&data[4..8])]);
            }
            b"IDAT" => saw_idat = true,
            b"acTL" | b"fcTL" | b"fdAT" => {
                return Err(OleError(
                    "Animated PNGs are unsupported for OLE previews".into(),
                ));
            }
            b"IEND" => {
                if !data.is_empty() || next.iter().any(|&byte| byte != 0) {
                    return Err(OleError(
                        "Invalid preview PNG IEND or trailing bytes".into(),
                    ));
                }
                if selection.is_some() && !saw_selection {
                    return Err(OleError(
                        "Preview PNG is missing the ChemDraft selection carrier".into(),
                    ));
                }
                return Ok(dpi.unwrap_or([DEFAULT_DPI; 2]));
            }
            _ => {}
        }
        chunks = next;
    }
    Err(OleError(
        "Truncated preview PNG or missing IEND chunk".into(),
    ))
}

fn carrier_matches(kind: &[u8], text: &[u8], json: &str) -> Result<bool, OleError> {
    let invalid = || OleError("Malformed ChemDraft PNG text chunk".into());
    let (compressed, data) = if kind == b"zTXt" {
        (true, text.strip_prefix(&[0]).ok_or_else(invalid)?)
    } else {
        let (flags, fields) = text.split_at_checked(2).ok_or_else(invalid)?;
        if flags[0] > 1 || flags[1] != 0 {
            return Err(invalid());
        }
        let mut fields = fields.splitn(3, |&byte| byte == 0);
        (flags[0] != 0, fields.nth(2).ok_or_else(invalid)?)
    };
    if !compressed {
        return Ok(data == json.as_bytes());
    }
    // Compare a chunk at a time and stop at the caller's already bounded document size.
    let mut reader = flate2::read::ZlibDecoder::new(data);
    let mut buffer = [0; 8192];
    let mut remaining = json.as_bytes();
    loop {
        let count = reader.read(&mut buffer).map_err(|_| invalid())?;
        if count == 0 {
            return Ok(remaining.is_empty());
        }
        let Some(rest) = remaining.strip_prefix(&buffer[..count]) else {
            return Ok(false);
        };
        remaining = rest;
    }
}

fn device_micrometers(pixels: u32, dpi: u32) -> Result<i32, OleError> {
    let micrometers = (u64::from(pixels) * 25400 + u64::from(dpi) / 2) / u64::from(dpi);
    if micrometers < 10 {
        return Err(OleError(
            "Preview PNG DPI is too high for the EMF frame".into(),
        ));
    }
    // At the pixel limit and one DPI this is at most 203,200,000 micrometers.
    Ok(micrometers as i32)
}

fn write_picture(
    picture: &mut [u8],
    png: &[u8],
    object_size: usize,
    width: i32,
    height: i32,
    dpi: [u32; 2],
) {
    let (header, rest) = picture.split_at_mut(PLUS_HEADER_SIZE + 16);
    let (image, draw) = rest.split_at_mut(object_size);

    let header = plus_record(header, EMF_PLUS_HEADER, 1); // Dual mode.
    put(header, 0, GRAPHICS_VERSION.to_le_bytes());
    put(header, 4, 1u32.to_le_bytes()); // Display device.
    put(header, 8, dpi[0].to_le_bytes());
    put(header, 12, dpi[1].to_le_bytes());

    let image = plus_record(image, EMF_PLUS_OBJECT, 0x0500); // Image object 0.
    put(image, 0, GRAPHICS_VERSION.to_le_bytes());
    put(image, 4, 1u32.to_le_bytes()); // ImageDataTypeBitmap.
    put(image, 24, 1u32.to_le_bytes()); // BitmapDataTypeCompressed.
    image[28..28 + png.len()].copy_from_slice(png);

    let draw = plus_record(draw, EMF_PLUS_DRAW_IMAGE, 0); // RectF, image object 0.
    put(draw, 0, u32::MAX.to_le_bytes()); // Default image attributes.
    put(draw, 4, 2u32.to_le_bytes()); // Source UnitPixel.
    put(draw, 16, (width as f32).to_le_bytes());
    put(draw, 20, (height as f32).to_le_bytes());
    put(draw, 32, (width as f32).to_le_bytes());
    put(draw, 36, (height as f32).to_le_bytes());
}

fn write_dib(dib: &mut [u8], width: i32, height: i32, rgba: &[u8]) {
    let pixel_bytes = (rgba.len() as u32).to_le_bytes();
    put(dib, 16, (width - 1).to_le_bytes());
    put(dib, 20, (height - 1).to_le_bytes());
    put(dib, 40, width.to_le_bytes()); // Source dimensions.
    put(dib, 44, height.to_le_bytes());
    put(dib, 48, 80u32.to_le_bytes()); // BITMAPINFO offset and size.
    put(dib, 52, 40u32.to_le_bytes());
    put(dib, 56, (DIB_OFFSET as u32).to_le_bytes());
    put(dib, 60, pixel_bytes);
    put(dib, 68, 0x00cc_0020u32.to_le_bytes()); // SRCCOPY.
    put(dib, 72, width.to_le_bytes()); // Destination dimensions.
    put(dib, 76, height.to_le_bytes());
    put(dib, 80, 40u32.to_le_bytes()); // BITMAPINFOHEADER size.
    put(dib, 84, width.to_le_bytes());
    put(dib, 88, (-height).to_le_bytes()); // Top-down.
    put(dib, 92, 1u16.to_le_bytes()); // Planes.
    put(dib, 94, 32u16.to_le_bytes()); // BGRX, BI_RGB.
    put(dib, 100, pixel_bytes);

    // BI_RGB ignores alpha. Composite onto the same white background as the probe.
    for (source, dest) in rgba
        .chunks_exact(4)
        .zip(dib[DIB_OFFSET..].chunks_exact_mut(4))
    {
        let alpha = u16::from(source[3]);
        for (channel, output) in source[..3].iter().rev().zip(dest.iter_mut()) {
            *output = 255 - (((255 - u16::from(*channel)) * alpha + 127) / 255) as u8;
        }
    }
}

fn emr(emf: &mut Vec<u8>, kind: u32, size: usize) -> &mut [u8] {
    let start = emf.len();
    emf.resize(start + size, 0);
    let record = &mut emf[start..];
    put(record, 0, kind.to_le_bytes());
    put(record, 4, (size as u32).to_le_bytes());
    record
}

fn plus_comment(emf: &mut Vec<u8>, size: usize) -> &mut [u8] {
    let comment = emr(emf, EMR_COMMENT, size);
    put(comment, 8, ((size - 12) as u32).to_le_bytes());
    put(comment, 12, *b"EMF+");
    &mut comment[COMMENT_HEADER_SIZE..]
}

fn plus_record(record: &mut [u8], kind: u16, flags: u16) -> &mut [u8] {
    let size = record.len() as u32;
    put(record, 0, kind.to_le_bytes());
    put(record, 2, flags.to_le_bytes());
    put(record, 4, size.to_le_bytes());
    // GDI+ rejects a record when DataSize excludes its alignment padding.
    put(record, 8, (size - PLUS_HEADER_SIZE as u32).to_le_bytes());
    &mut record[PLUS_HEADER_SIZE..]
}

fn put<const N: usize>(bytes: &mut [u8], offset: usize, value: [u8; N]) {
    bytes[offset..offset + N].copy_from_slice(&value);
}

#[cfg(test)]
mod tests {
    use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};

    use super::*;

    const CARRIER: &[u8] =
        include_bytes!("../../../../../packages/fixtures/office/carriers/png-itxt.png");
    const CARRIER_384_DPI: &[u8] =
        include_bytes!("../../../../../packages/fixtures/office/carriers/png-ztxt-384dpi.png");

    fn u16_at(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
    }

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn records(mut bytes: &[u8], minimum_size: usize) -> Vec<&[u8]> {
        let mut records = Vec::new();
        while !bytes.is_empty() {
            assert!(bytes.len() >= minimum_size);
            let size = u32_at(bytes, 4) as usize;
            assert!(size >= minimum_size && size <= bytes.len());
            assert_eq!(size % 4, 0);
            let (record, rest) = bytes.split_at(size);
            records.push(record);
            bytes = rest;
        }
        records
    }

    fn plus_records(comment: &[u8]) -> Vec<&[u8]> {
        assert_eq!(u32_at(comment, 0), 70);
        assert_eq!(u32_at(comment, 8) as usize, comment.len() - 12);
        assert_eq!(&comment[12..16], b"EMF+");
        let records = records(&comment[16..], 12);
        for record in &records {
            assert_eq!(u32_at(record, 8) as usize, record.len() - 12);
        }
        records
    }

    #[test]
    fn fixture_matches_spike_record_layout() {
        let emf = preview_emf(CARRIER).unwrap();
        let records = records(&emf, 8);
        let layout: Vec<_> = records.iter().map(|r| (u32_at(r, 0), r.len())).collect();
        // Golden type/length pairs from emf-writer.mjs for png-itxt.png at 96 DPI.
        assert_eq!(
            layout,
            [(1, 108), (70, 19924), (81, 1610520), (70, 28), (14, 20)]
        );
        let [header, picture, dib, plus_eof, eof] = records.as_slice() else {
            panic!("expected five EMF records");
        };
        assert_eq!(u32_at(header, 48) as usize, emf.len());
        assert_eq!(u32_at(header, 52), 5);
        assert_eq!([u32_at(header, 16), u32_at(header, 20)], [599, 670]);
        assert_eq!([u32_at(header, 32), u32_at(header, 36)], [15875, 17754]);
        assert_eq!(u32_at(dib, 60) as usize, dib.len() - 120);
        assert_eq!(u32_at(eof, 16) as usize, eof.len());

        let plus_layout = |comment: &[u8]| {
            plus_records(comment)
                .iter()
                .map(|r| (u16_at(r, 0), u16_at(r, 2), r.len(), u32_at(r, 8)))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            plus_layout(picture),
            [
                (0x4001, 1, 28, 16),
                (0x4008, 0x0500, 19828, 19816),
                (0x401a, 0, 52, 40)
            ]
        );
        assert_eq!(plus_layout(plus_eof), [(0x4002, 0, 12, 0)]);
        let plus = plus_records(picture);
        assert_eq!([u32_at(plus[0], 20), u32_at(plus[0], 24)], [96, 96]);
        assert_eq!(u32_at(plus[2], 12), u32::MAX);
        assert_eq!(u32_at(plus[2], 16), 2);
        assert_eq!(u32_at(plus[2], 44), 600f32.to_bits());
        assert_eq!(u32_at(plus[2], 48), 671f32.to_bits());
    }

    #[test]
    fn keeps_original_carriers_and_uses_384_dpi_for_the_frame() {
        for (png, dpi) in [(CARRIER, 96), (CARRIER_384_DPI, 384)] {
            let emf = preview_emf(png).unwrap();
            let records = records(&emf, 8);
            let plus = plus_records(records[1]);
            assert_eq!([u32_at(plus[0], 20), u32_at(plus[0], 24)], [dpi, dpi]);
            let object = plus[1];
            assert_eq!(u32_at(object, 36), 1);
            assert_eq!(&object[40..40 + png.len()], png);
            let padding = png.len().next_multiple_of(4) - png.len();
            assert_eq!(&object[40 + png.len()..], &[0; 3][..padding]);
            if dpi == 384 {
                assert_eq!(
                    [u32_at(records[0], 32), u32_at(records[0], 36)],
                    [3969, 4438]
                );
            }
        }
    }

    #[test]
    fn writes_top_down_32_bit_dib_in_bgrx_on_white() {
        let pixels = [
            19, 230, 8, 255, 56, 22, 90, 0, 16, 42, 90, 128, 3, 7, 11, 255, 0, 0, 0, 255, 24, 96,
            128, 255,
        ];
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&pixels, 3, 2, ExtendedColorType::Rgba8)
            .unwrap();
        let emf = preview_emf(&png).unwrap();
        let dib = records(&emf, 8)[2];
        assert_eq!(u32_at(dib, 0), 81);
        assert_eq!(u32_at(dib, 48), 80);
        assert_eq!(u32_at(dib, 56), 120);
        assert_eq!(u32_at(dib, 60), 24);
        assert_eq!(u32_at(dib, 68), 0x00cc_0020);
        assert_eq!(u32_at(dib, 84), 3);
        assert_eq!(u32_at(dib, 88) as i32, -2);
        assert_eq!(u16_at(dib, 92), 1);
        assert_eq!(u16_at(dib, 94), 32);
        assert_eq!(u32_at(dib, 96), 0);
        assert_eq!(
            &dib[120..],
            [
                8, 230, 19, 0, 255, 255, 255, 0, 172, 148, 135, 0, 11, 7, 3, 0, 0, 0, 0, 0, 128,
                96, 24, 0,
            ]
        );
    }

    #[test]
    fn rejects_oversize_and_truncated_pngs() {
        let too_large = vec![0; MAX_PNG_BYTES + 1];
        assert!(preview_emf(&too_large)
            .unwrap_err()
            .to_string()
            .contains("25 MiB"));
        let mut too_wide = Vec::new();
        let width = MAX_IMAGE_SIDE + 1;
        PngEncoder::new(&mut too_wide)
            .write_image(&vec![0; width as usize], width, 1, ExtendedColorType::L8)
            .unwrap();
        assert!(preview_emf(&too_wide)
            .unwrap_err()
            .to_string()
            .contains("8000"));
        let truncated = &CARRIER[..CARRIER.len() - 1];
        assert!(preview_emf(truncated)
            .unwrap_err()
            .to_string()
            .contains("IEND"));
    }
}
