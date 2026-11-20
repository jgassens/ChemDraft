use std::io::{Cursor, Read, Seek, Write};

use cfb::{CompoundFile, Version};

use super::OleError;

const MAX_STORAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const COMP_OBJ: &str = "\x01CompObj";
const OLE: &str = "\x01Ole";
const DOCUMENT: &str = "ChemDraftDocument";
const COMP_OBJ_HEADER_SIZE: usize = 28;
const OLE_STREAM_VERSION: u32 = 0x0200_0001;
const OLE_STREAM_SIZE: usize = 20;

pub(crate) struct OleClass {
    pub(crate) clsid: &'static str,
    pub(crate) prog_id: &'static str,
    pub(crate) user_type: &'static str,
}

impl OleClass {
    /// The unregistered measurement class. Stable and dev classes are added with the server.
    pub(crate) const fn probe() -> Self {
        Self {
            clsid: "{9555AC51-4097-416B-8588-E2BA35E8AF94}",
            prog_id: "ChemDraft.Structure.Probe",
            user_type: "ChemDraft Structure (probe)",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ObjectContents {
    pub(crate) clsid: String,
    pub(crate) prog_id: String,
    pub(crate) json: String,
}

pub(crate) fn write_object_storage(json: &str, class: &OleClass) -> Result<Vec<u8>, OleError> {
    if json.len() > MAX_DOCUMENT_BYTES {
        return Err(OleError("ChemDraftDocument exceeds 25 MiB".into()));
    }
    validate_json(json)?;

    // The Office probe uses V3 compound files with 512-byte sectors.
    let mut storage = CompoundFile::create_with_version(Version::V3, Cursor::new(Vec::new()))
        .map_err(|error| OleError(format!("Could not create OLE compound file: {error}")))?;
    let clsid = class
        .clsid
        .parse()
        .map_err(|error| OleError(format!("Invalid OLE class CLSID: {error}")))?;
    storage
        .set_storage_clsid("/", clsid)
        .map_err(|error| OleError(format!("Could not set OLE root CLSID: {error}")))?;
    if clsid.is_nil() {
        return Err(OleError("OLE class CLSID must be nonzero".into()));
    }
    let comp_obj = comp_obj_stream(class, clsid.to_bytes_le())?;
    let mut ole = [0; OLE_STREAM_SIZE];
    ole[..4].copy_from_slice(&OLE_STREAM_VERSION.to_le_bytes());
    // Flags zero denotes an embedded object. Its moniker fields are empty.
    for (name, bytes) in [
        (OLE, ole.as_slice()),
        (COMP_OBJ, &comp_obj),
        (DOCUMENT, json.as_bytes()),
    ] {
        let mut stream = storage
            .create_new_stream(name)
            .map_err(|error| OleError(format!("Could not create OLE stream {name:?}: {error}")))?;
        stream
            .write_all(bytes)
            .and_then(|()| stream.flush())
            .map_err(|error| OleError(format!("Could not write OLE stream {name:?}: {error}")))?;
    }
    let bytes = storage.into_inner().into_inner();
    check_storage_size(&bytes)?;
    Ok(bytes)
}

pub(crate) fn read_object_storage(bytes: &[u8]) -> Result<ObjectContents, OleError> {
    check_storage_size(bytes)?;
    let mut storage = CompoundFile::open(Cursor::new(bytes))
        .map_err(|error| OleError(format!("Invalid OLE compound file: {error}")))?;
    let clsid = *storage.root_entry().clsid();
    if clsid.is_nil() {
        return Err(OleError("OLE compound file has no root CLSID".into()));
    }

    // Office may change the layout or add cache streams during save.
    let document = read_stream(&mut storage, DOCUMENT, MAX_DOCUMENT_BYTES, "25 MiB")?;
    let json = String::from_utf8(document)
        .map_err(|error| OleError(format!("ChemDraftDocument is not UTF-8: {error}")))?;
    validate_json(&json)?;
    let comp_obj = read_stream(&mut storage, COMP_OBJ, MAX_METADATA_BYTES, "64 KiB")?;
    let prog_id = read_prog_id(&comp_obj)?;
    let ole = read_stream(&mut storage, OLE, MAX_METADATA_BYTES, "64 KiB")?;
    if ole.len() < OLE_STREAM_SIZE || ole[..4] != OLE_STREAM_VERSION.to_le_bytes() {
        return Err(OleError("Invalid OLEStream header in \\x01Ole".into()));
    }
    if ole[4] & 1 != 0 {
        return Err(OleError(
            "OLEStream in \\x01Ole describes a linked object".into(),
        ));
    }
    Ok(ObjectContents {
        clsid: format!("{{{clsid:X}}}"),
        prog_id,
        json,
    })
}

fn check_storage_size(bytes: &[u8]) -> Result<(), OleError> {
    if bytes.len() > MAX_STORAGE_BYTES {
        return Err(OleError("OLE compound file exceeds 50 MiB".into()));
    }
    Ok(())
}

fn validate_json(json: &str) -> Result<(), OleError> {
    serde_json::from_str::<serde::de::IgnoredAny>(json)
        .map(|_| ())
        .map_err(|error| OleError(format!("Invalid ChemDraftDocument JSON: {error}")))
}

fn comp_obj_stream(class: &OleClass, clsid_le: [u8; 16]) -> Result<Vec<u8>, OleError> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0xfffe_0001u32.to_le_bytes());
    bytes.extend_from_slice(&0x0000_0a03u32.to_le_bytes());
    bytes.extend_from_slice(&u32::MAX.to_le_bytes());
    bytes.extend_from_slice(&clsid_le);
    write_ansi_field(&mut bytes, class.user_type, "AnsiUserType")?;
    bytes.extend_from_slice(&0u32.to_le_bytes()); // No clipboard format.
    write_ansi_field(&mut bytes, class.prog_id, "ProgID")?; // MS-OLEDS Reserved1.
    bytes.extend_from_slice(&0x71b2_39f4u32.to_le_bytes()); // Unicode marker.
    bytes.extend_from_slice(&[0; 12]); // Empty Unicode fields.
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(OleError("CompObj stream exceeds 64 KiB".into()));
    }
    Ok(bytes)
}

fn write_ansi_field(bytes: &mut Vec<u8>, value: &str, field: &str) -> Result<(), OleError> {
    if value.is_empty() || !value.is_ascii() || value.as_bytes().contains(&0) {
        return Err(OleError(format!(
            "Invalid CompObj {field}: expected nonempty ASCII"
        )));
    }
    if bytes.len() + value.len() + 5 > MAX_METADATA_BYTES {
        return Err(OleError(format!(
            "CompObj {field} exceeds the metadata size limit"
        )));
    }
    bytes.extend_from_slice(&((value.len() + 1) as u32).to_le_bytes());
    bytes.extend_from_slice(value.as_bytes());
    bytes.push(0);
    Ok(())
}

fn read_stream<F: Read + Seek>(
    storage: &mut CompoundFile<F>,
    name: &str,
    max_bytes: usize,
    limit: &str,
) -> Result<Vec<u8>, OleError> {
    let mut stream = storage
        .open_stream(name)
        .map_err(|error| OleError(format!("Could not open OLE stream {name:?}: {error}")))?;
    if stream.len() > max_bytes as u64 {
        return Err(OleError(format!("OLE stream {name:?} exceeds {limit}")));
    }
    let mut bytes = vec![0; stream.len() as usize];
    stream
        .read_exact(&mut bytes)
        .map_err(|error| OleError(format!("Could not read OLE stream {name:?}: {error}")))?;
    Ok(bytes)
}

fn read_prog_id(comp_obj: &[u8]) -> Result<String, OleError> {
    let mut fields = comp_obj
        .get(COMP_OBJ_HEADER_SIZE..)
        .ok_or_else(|| OleError("Truncated CompObj header in \\x01CompObj".into()))?;
    read_ansi_field(&mut fields, "AnsiUserType")?;
    let (clipboard_format, rest) = fields
        .split_at_checked(4)
        .ok_or_else(|| OleError("Truncated CompObj clipboard format".into()))?;
    if clipboard_format != [0; 4] {
        return Err(OleError("Unsupported CompObj clipboard format".into()));
    }
    fields = rest;
    let prog_id = read_ansi_field(&mut fields, "ProgID")?;
    Ok(prog_id.to_owned())
}

fn read_ansi_field<'a>(fields: &mut &'a [u8], field: &str) -> Result<&'a str, OleError> {
    let truncated = || OleError(format!("Truncated CompObj {field}"));
    let (size, rest) = fields.split_at_checked(4).ok_or_else(truncated)?;
    let size = u32::from_le_bytes(size.try_into().unwrap()) as usize;
    let (value, rest) = rest.split_at_checked(size).ok_or_else(truncated)?;
    let bytes = value
        .strip_suffix(&[0])
        .filter(|value| !value.is_empty() && value.is_ascii() && !value.contains(&0))
        .ok_or_else(|| {
            OleError(format!(
                "Invalid CompObj {field}: expected NUL-terminated ASCII"
            ))
        })?;
    *fields = rest;
    Ok(std::str::from_utf8(bytes).expect("ASCII is UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL_JSON: &str = "{\r\n  \"text\": \"β-D-glucose, café, 🧪\"\r\n}\n";

    #[test]
    fn round_trips_utf8_json_in_mini_and_regular_streams() {
        let class = OleClass::probe();
        let large = format!(r#"{{"text":"{}"}}"#, "é".repeat(3000));
        assert!(SMALL_JSON.len() < 4096 && large.len() > 4096);
        for json in [SMALL_JSON, &large] {
            let bytes = write_object_storage(json, &class).unwrap();
            let contents = read_object_storage(&bytes).unwrap();
            assert_eq!(contents.clsid, class.clsid);
            assert_eq!(contents.prog_id, class.prog_id);
            assert_eq!(contents.json.as_bytes(), json.as_bytes());
        }
    }

    #[test]
    fn writes_probe_comp_obj_and_embedded_ole_streams() {
        let bytes = write_object_storage(SMALL_JSON, &OleClass::probe()).unwrap();
        let mut storage = CompoundFile::open(Cursor::new(&bytes)).unwrap();
        assert_eq!(storage.version(), Version::V3);
        let ole = read_stream(&mut storage, OLE, MAX_METADATA_BYTES, "64 KiB").unwrap();
        assert_eq!(
            ole,
            [1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        let comp_obj = read_stream(&mut storage, COMP_OBJ, MAX_METADATA_BYTES, "64 KiB").unwrap();
        // CompObjStream bytes from cfb-writer.mjs, with mixed-endian GUID fields.
        assert_eq!(
            comp_obj,
            b"\x01\x00\xfe\xff\x03\x0a\x00\x00\xff\xff\xff\xff\x51\xac\x55\x95\x97\x40\x6b\x41\x85\x88\xe2\xba\x35\xe8\xaf\x94\
            \x1c\x00\x00\x00ChemDraft Structure (probe)\x00\x00\x00\x00\x00\
            \x1a\x00\x00\x00ChemDraft.Structure.Probe\x00\xf4\x39\xb2\x71\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
        );
    }

    #[test]
    fn reads_repacked_storage_with_a_different_stream_order() {
        let class = OleClass::probe();
        let original = write_object_storage(SMALL_JSON, &class).unwrap();
        let mut source = CompoundFile::open(Cursor::new(&original)).unwrap();
        let mut repacked = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
        repacked
            .set_storage_clsid("/", *source.root_entry().clsid())
            .unwrap();
        repacked
            .create_stream("\x02OlePres000")
            .unwrap()
            .write_all(b"cache")
            .unwrap();
        for name in [DOCUMENT, COMP_OBJ, OLE] {
            let mut input = source.open_stream(name).unwrap();
            let mut output = repacked.create_stream(name).unwrap();
            std::io::copy(&mut input, &mut output).unwrap();
            output.flush().unwrap();
        }
        let repacked = repacked.into_inner().into_inner();
        assert_ne!(original, repacked);
        assert_eq!(
            read_object_storage(&repacked).unwrap(),
            read_object_storage(&original).unwrap()
        );
    }

    #[test]
    fn rejects_missing_document_and_invalid_text() {
        let bytes = write_object_storage(SMALL_JSON, &OleClass::probe()).unwrap();
        let mut storage = CompoundFile::open(Cursor::new(bytes)).unwrap();
        storage.remove_stream(DOCUMENT).unwrap();
        let missing = read_object_storage(storage.into_inner().get_ref()).unwrap_err();
        assert!(missing.to_string().contains("ChemDraftDocument"));

        let bytes = write_object_storage(SMALL_JSON, &OleClass::probe()).unwrap();
        let mut storage = CompoundFile::open(Cursor::new(bytes)).unwrap();
        for (document, diagnostic) in [(&b"\xff"[..], "UTF-8"), (&b"{ "[..], "JSON")] {
            let mut stream = storage.create_stream(DOCUMENT).unwrap();
            stream.write_all(document).unwrap();
            stream.flush().unwrap();
            drop(stream);
            let serialized = storage.into_inner();
            let error = read_object_storage(serialized.get_ref())
                .unwrap_err()
                .to_string();
            assert!(error.contains("ChemDraftDocument") && error.contains(diagnostic));
            storage = CompoundFile::open(serialized).unwrap();
        }
    }

    #[test]
    fn rejects_oversize_and_non_cfb_inputs() {
        let class = OleClass::probe();
        let too_large = " ".repeat(MAX_DOCUMENT_BYTES + 1);
        let error = write_object_storage(&too_large, &class).unwrap_err();
        assert!(error.to_string().contains("25 MiB"));
        let mut storage = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
        storage
            .set_storage_clsid("/", class.clsid.parse().unwrap())
            .unwrap();
        storage
            .create_stream(DOCUMENT)
            .unwrap()
            .write_all(too_large.as_bytes())
            .unwrap();
        let error = read_object_storage(storage.into_inner().get_ref()).unwrap_err();
        assert!(error.to_string().contains("25 MiB"));

        let bytes = vec![0; MAX_STORAGE_BYTES + 1];
        assert!(read_object_storage(&bytes)
            .unwrap_err()
            .to_string()
            .contains("50 MiB"));
        let mut non_cfb = [0; 1024];
        non_cfb[..6].copy_from_slice(b"%PDF-1");
        assert!(read_object_storage(&non_cfb)
            .unwrap_err()
            .to_string()
            .contains("Invalid OLE compound file"));
    }
}
