use serde::Deserialize;

use super::{emf::preview_with_extent, storage::document_bytes, OleError};

pub(super) const EMPTY: &str = r#"{"kind":"chemdraft-selection","version":1,"objects":[],"selectionIds":[],"bounds":{"x":0,"y":0,"width":0,"height":0}}"#;

pub(super) struct Image {
    pub png: Vec<u8>,
    pub emf: Vec<u8>,
    pub extent: [i32; 2],
}

pub(super) struct Content {
    pub json: String,
    pub image: Option<Image>,
}

impl Content {
    pub fn load(json: String, png: Option<Vec<u8>>) -> Result<Self, OleError> {
        #[derive(Deserialize)]
        struct Header {
            kind: String,
            version: u32,
        }
        document_bytes(&json)?;
        let header: Header = serde_json::from_str(&json)
            .map_err(|e| OleError(format!("Invalid ChemDraftDocument selection header: {e}")))?;
        if header.kind != "chemdraft-selection" || header.version != 1 {
            return Err(OleError(
                "Unsupported ChemDraftDocument selection kind or version".into(),
            ));
        }
        let image = png
            .map(|png| {
                let (emf, extent) = preview_with_extent(&png, Some(&json))?;
                Ok::<_, OleError>(Image { png, emf, extent })
            })
            .transpose()?;
        Ok(Self { json, image })
    }

    pub fn blank() -> Result<Self, OleError> {
        use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&[255; 96 * 96], 96, 96, ExtendedColorType::L8)
            .map_err(|e| OleError(format!("Could not create empty Office preview: {e}")))?;
        let iend = png.split_off(png.len() - 12);
        let mut chunk = b"iTXtapplication/x-chemdraft-selection+json\0\0\0\0\0".to_vec();
        chunk.extend_from_slice(EMPTY.as_bytes());
        png.extend_from_slice(&((chunk.len() - 4) as u32).to_be_bytes());
        let mut crc = flate2::Crc::new();
        crc.update(&chunk);
        png.extend(chunk);
        png.extend(crc.sum().to_be_bytes());
        png.extend(iend);
        Self::load(EMPTY.into(), Some(png))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_stream_and_preview_have_one_selection_and_extent() {
        let blank = Content::blank().unwrap();
        let image = blank.image.unwrap();
        assert_eq!(image.extent, [2540, 2540]); // 96 px at 96 DPI = one inch in HIMETRIC.
        assert_eq!(
            i32::from_le_bytes(image.emf[32..36].try_into().unwrap()),
            image.extent[0]
        );
        assert_eq!(
            Content::load(EMPTY.into(), Some(image.png.clone()))
                .unwrap()
                .json,
            EMPTY
        );
        assert!(Content::load(format!("{EMPTY} "), Some(image.png)).is_err());
        assert!(Content::load("{}".into(), None).is_err());
        assert!(Content::load(EMPTY.replace("\"version\":1", "\"version\":2"), None).is_err());
        assert!(Content::load(EMPTY.into(), None).unwrap().image.is_none());
    }
}
