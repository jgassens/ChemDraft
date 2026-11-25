use std::io::{Cursor, Read, Seek, Write};

use cfb::{CompoundFile, Version};

use super::{OleClass, OleError};

pub(crate) const MAX_STORAGE_BYTES: usize = 50 * 1024 * 1024;
pub(super) const MAX_DOCUMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const COMP_OBJ: &str = "\x01CompObj";
const OLE: &str = "\x01Ole";
pub(super) const DOCUMENT: &str = "ChemDraftDocument";
const COMP_OBJ_HEADER_SIZE: usize = 28;
const COMP_OBJ_BYTE_ORDER_VERSION: u32 = 0xfffe_0001;
const COMP_OBJ_OLE_VERSION: u32 = 0x0000_0a03;
const OLE_STREAM_VERSION: u32 = 0x0200_0001;
const OLE_STREAM_SIZE: usize = 20;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ObjectContents {
    pub(crate) clsid: String,
    pub(crate) prog_id: String,
    pub(crate) json: String,
}

#[cfg_attr(not(test), allow(dead_code))] // Used by the upcoming OLE clipboard producer.
pub(crate) fn write_object_storage(json: &str, class: &OleClass) -> Result<Vec<u8>, OleError> {
    let document = document_bytes(json)?;

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
        (DOCUMENT, document),
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

#[cfg_attr(not(test), allow(dead_code))] // Whole-file companion to the live IStorage adapter.
pub(crate) fn read_object_storage(bytes: &[u8]) -> Result<ObjectContents, OleError> {
    check_storage_size(bytes)?;
    let mut storage = CompoundFile::open(Cursor::new(bytes))
        .map_err(|error| OleError(format!("Invalid OLE compound file: {error}")))?;
    let clsid = *storage.root_entry().clsid();
    if clsid.is_nil() {
        return Err(OleError("OLE compound file has no root CLSID".into()));
    }

    let clsid_le = clsid.to_bytes_le();
    let clsid = format!("{{{clsid:X}}}");
    let classes = [
        OleClass::STABLE,
        OleClass::DEV,
        #[cfg(test)]
        OleClass::PROBE,
    ];
    let class = classes
        .iter()
        .find(|class| class.clsid == clsid)
        .ok_or_else(|| OleError(format!("Unknown ChemDraft storage CLSID {clsid}")))?;

    // Office may change the layout or add cache streams during save.
    let document = read_stream(&mut storage, DOCUMENT, MAX_DOCUMENT_BYTES, "25 MiB")?;
    let json = decode_document(document)?;
    let comp_obj = read_stream(&mut storage, COMP_OBJ, MAX_METADATA_BYTES, "64 KiB")?;
    let prog_id = read_prog_id(&comp_obj, clsid_le)?;
    if !prog_id.eq_ignore_ascii_case(class.prog_id) {
        return Err(OleError(format!(
            "CompObj ProgID does not match ChemDraft storage class {clsid}"
        )));
    }
    let ole = read_stream(&mut storage, OLE, MAX_METADATA_BYTES, "64 KiB")?;
    validate_embedded_ole(&ole)?;
    Ok(ObjectContents {
        clsid,
        prog_id,
        json,
    })
}

/// ChemDraft's own OLE class (stable or dev build) for `clsid`, written with or without braces, in
/// any case. Another program's class, and the nil CLSID, are `None`.
fn chemdraft_class(clsid: &str) -> Option<OleClass> {
    let bare = |text: &'static str| text.trim_start_matches('{').trim_end_matches('}');
    let clsid = clsid
        .strip_prefix('{')
        .and_then(|clsid| clsid.strip_suffix('}'))
        .unwrap_or(clsid);
    [OleClass::STABLE, OleClass::DEV]
        .into_iter()
        .find(|class| bare(class.clsid).eq_ignore_ascii_case(clsid))
}

/// The drawing in a pasted OLE object (Windows "Embedded Object" or "Embed Source", paste-back in
/// docs/architecture/office-editing.md, slice 3), read the way the server's `IPersistStorage::Load`
/// reads one: the storage class must be ChemDraft's, then `ChemDraftDocument`, at most 25 MiB, is
/// decoded by `decode_document`. `read_stream(name, limit)` reads one stream of the object's
/// storage and must refuse a stream over `limit` before copying it. Returns the class's CLSID and
/// the drawing JSON, or `None` for another program's object, whose paste falls through to the
/// other clipboard formats.
pub(crate) fn read_pasted_document<E: std::fmt::Display>(
    clsid: &str,
    read_stream: impl FnOnce(&str, usize) -> Result<Vec<u8>, E>,
) -> Result<Option<(&'static str, String)>, OleError> {
    let Some(class) = chemdraft_class(clsid) else {
        return Ok(None);
    };
    let document = read_stream(DOCUMENT, MAX_DOCUMENT_BYTES).map_err(|error| {
        OleError(format!(
            "Could not read the copied ChemDraft object: {error}"
        ))
    })?;
    Ok(Some((class.clsid, decode_document(document)?)))
}

fn validate_embedded_ole(ole: &[u8]) -> Result<(), OleError> {
    if ole.len() < OLE_STREAM_SIZE || ole[..4] != OLE_STREAM_VERSION.to_le_bytes() {
        return Err(OleError("Invalid OLEStream header in \\x01Ole".into()));
    }
    if ole[4] & 1 != 0 {
        return Err(OleError(
            "OLEStream in \\x01Ole describes a linked object".into(),
        ));
    }
    if ole[12..16] != [0; 4] {
        return Err(OleError("OLEStream Reserved1 must be zero".into()));
    }
    if ole[16..20] != [0; 4] {
        return Err(OleError(
            "Embedded OLEStream must have an empty reserved moniker".into(),
        ));
    }
    if ole.len() != OLE_STREAM_SIZE {
        return Err(OleError(
            "Unexpected trailing fields in embedded OLEStream".into(),
        ));
    }
    Ok(())
}

fn check_storage_size(bytes: &[u8]) -> Result<(), OleError> {
    if bytes.len() > MAX_STORAGE_BYTES {
        return Err(OleError("OLE compound file exceeds 50 MiB".into()));
    }
    Ok(())
}

/// The compound-file writer and COM IStorage adapter use identical native stream bytes.
pub(super) fn document_bytes(json: &str) -> Result<&[u8], OleError> {
    if json.len() > MAX_DOCUMENT_BYTES {
        return Err(OleError("ChemDraftDocument exceeds 25 MiB".into()));
    }
    validate_json(json)?;
    Ok(json.as_bytes())
}

pub(super) fn decode_document(bytes: Vec<u8>) -> Result<String, OleError> {
    let json = String::from_utf8(bytes)
        .map_err(|error| OleError(format!("ChemDraftDocument is not UTF-8: {error}")))?;
    document_bytes(&json)?;
    Ok(json)
}

fn validate_json(json: &str) -> Result<(), OleError> {
    serde_json::from_str::<serde::de::IgnoredAny>(json)
        .map(|_| ())
        .map_err(|error| OleError(format!("Invalid ChemDraftDocument JSON: {error}")))
}

fn comp_obj_stream(class: &OleClass, clsid_le: [u8; 16]) -> Result<Vec<u8>, OleError> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&COMP_OBJ_BYTE_ORDER_VERSION.to_le_bytes());
    bytes.extend_from_slice(&COMP_OBJ_OLE_VERSION.to_le_bytes());
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

fn read_prog_id(comp_obj: &[u8], root_clsid: [u8; 16]) -> Result<String, OleError> {
    let (header, mut fields) = comp_obj
        .split_at_checked(COMP_OBJ_HEADER_SIZE)
        .ok_or_else(|| OleError("Truncated CompObj header in \\x01CompObj".into()))?;
    if header[..4] != COMP_OBJ_BYTE_ORDER_VERSION.to_le_bytes() {
        return Err(OleError("Invalid CompObj byte order or version".into()));
    }
    if header[4..8] != COMP_OBJ_OLE_VERSION.to_le_bytes() {
        return Err(OleError("Unsupported CompObj OLE version".into()));
    }
    let clsid = &header[12..];
    if clsid != [0; 16] && clsid != root_clsid {
        return Err(OleError(
            "CompObj CLSID does not match the root CLSID".into(),
        ));
    }
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
    fn document_stream_helpers_preserve_text_and_reject_invalid_input() {
        let bytes = document_bytes(SMALL_JSON).unwrap();
        assert_eq!(bytes, SMALL_JSON.as_bytes());
        assert_eq!(decode_document(bytes.to_vec()).unwrap(), SMALL_JSON);
        assert!(decode_document(vec![0xff])
            .unwrap_err()
            .to_string()
            .contains("UTF-8"));
        assert!(decode_document(b"{}!".to_vec())
            .unwrap_err()
            .to_string()
            .contains("JSON"));
    }

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
        let bytes = write_object_storage(SMALL_JSON, &OleClass::PROBE).unwrap();
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
        let class = OleClass::PROBE;
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

    fn with_stream_edit(name: &str, edit: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
        let original = write_object_storage(SMALL_JSON, &OleClass::PROBE).unwrap();
        let mut storage = CompoundFile::open(Cursor::new(original)).unwrap();
        let mut bytes = read_stream(&mut storage, name, MAX_METADATA_BYTES, "64 KiB").unwrap();
        edit(&mut bytes);
        let mut stream = storage.create_stream(name).unwrap();
        stream.write_all(&bytes).unwrap();
        stream.flush().unwrap();
        drop(stream);
        storage.into_inner().into_inner()
    }

    #[test]
    fn validates_comp_obj_version_and_optional_clsid() {
        for (offset, expected) in [
            (0, "Invalid CompObj byte order or version"),
            (4, "Unsupported CompObj OLE version"),
            (12, "CompObj CLSID does not match the root CLSID"),
        ] {
            let bytes = with_stream_edit(COMP_OBJ, |stream| stream[offset] ^= 1);
            assert_eq!(
                read_object_storage(&bytes).unwrap_err().to_string(),
                expected
            );
        }
        let bytes = with_stream_edit(COMP_OBJ, |stream| stream[12..28].fill(0));
        let contents = read_object_storage(&bytes).unwrap();
        assert_eq!(contents.clsid, OleClass::PROBE.clsid);
        assert_eq!(contents.prog_id, OleClass::PROBE.prog_id);
    }

    #[test]
    fn validates_embedded_ole_stream_fields() {
        for (offset, expected) in [
            (0, "Invalid OLEStream header in \\x01Ole"),
            (4, "OLEStream in \\x01Ole describes a linked object"),
            (12, "OLEStream Reserved1 must be zero"),
            (16, "Embedded OLEStream must have an empty reserved moniker"),
        ] {
            let bytes = with_stream_edit(OLE, |stream| stream[offset] ^= 1);
            assert_eq!(
                read_object_storage(&bytes).unwrap_err().to_string(),
                expected
            );
        }
        let bytes = with_stream_edit(OLE, |stream| stream.extend_from_slice(&[0; 4]));
        assert_eq!(
            read_object_storage(&bytes).unwrap_err().to_string(),
            "Unexpected trailing fields in embedded OLEStream"
        );
    }

    #[test]
    fn rejects_cfb_sector_chain_loop() {
        let mut bytes = write_object_storage(SMALL_JSON, &OleClass::PROBE).unwrap();
        // V3 header offsets 48 and 76 hold the first directory and FAT sector IDs.
        let directory_id = u32::from_le_bytes(bytes[48..52].try_into().unwrap());
        let fat_id = u32::from_le_bytes(bytes[76..80].try_into().unwrap());
        let entry = (fat_id as usize + 1) * 512 + directory_id as usize * 4;
        assert_eq!(&bytes[entry..entry + 4], &0xffff_fffeu32.to_le_bytes());
        bytes[entry..entry + 4].copy_from_slice(&directory_id.to_le_bytes());
        let error = read_object_storage(&bytes).unwrap_err().to_string();
        assert!(
            error.contains("Directory chain includes duplicate sector index"),
            "{error}"
        );
    }

    #[test]
    fn rejects_oversized_cfb_stream_declaration() {
        let mut bytes = write_object_storage(SMALL_JSON, &OleClass::PROBE).unwrap();
        let directory_id = u32::from_le_bytes(bytes[48..52].try_into().unwrap());
        let directory = (directory_id as usize + 1) * 512;
        let document_name: Vec<u8> = DOCUMENT.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let entry = bytes[directory..directory + 512]
            .chunks_exact_mut(128)
            .find(|entry| entry.starts_with(&document_name))
            .unwrap();
        // Change the declared stream length while keeping the actual file small.
        entry[120..128].copy_from_slice(&(MAX_DOCUMENT_BYTES as u64 + 1).to_le_bytes());
        let error = read_object_storage(&bytes).unwrap_err().to_string();
        assert_eq!(error, "OLE stream \"ChemDraftDocument\" exceeds 25 MiB");
    }

    #[test]
    fn refuses_unknown_storage_class_before_reading_its_document() {
        let original = write_object_storage(SMALL_JSON, &OleClass::DEV).unwrap();
        let mut cfb = CompoundFile::open(Cursor::new(original)).unwrap();
        cfb.set_storage_clsid("/", "00000000-0000-0000-0000-000000000001".parse().unwrap())
            .unwrap();
        assert!(read_object_storage(cfb.into_inner().get_ref())
            .unwrap_err()
            .to_string()
            .contains("Unknown ChemDraft storage CLSID"));
    }

    #[test]
    fn rejects_missing_document_and_invalid_text() {
        let bytes = write_object_storage(SMALL_JSON, &OleClass::PROBE).unwrap();
        let mut storage = CompoundFile::open(Cursor::new(bytes)).unwrap();
        storage.remove_stream(DOCUMENT).unwrap();
        let missing = read_object_storage(storage.into_inner().get_ref()).unwrap_err();
        assert!(missing.to_string().contains("ChemDraftDocument"));

        let bytes = write_object_storage(SMALL_JSON, &OleClass::PROBE).unwrap();
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
        let class = OleClass::PROBE;
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

    #[test]
    fn pasted_objects_are_read_only_for_chemdraft_classes() {
        let json = r#"{"kind":"chemdraft-selection","version":1}"#;
        let lower = OleClass::DEV.clsid.to_lowercase();
        let bare = OleClass::STABLE.clsid.trim_matches(['{', '}']);
        for (clsid, expected) in [
            (OleClass::STABLE.clsid, OleClass::STABLE.clsid),
            (OleClass::DEV.clsid, OleClass::DEV.clsid),
            (lower.as_str(), OleClass::DEV.clsid),
            (bare, OleClass::STABLE.clsid),
        ] {
            let read = read_pasted_document(clsid, |name, limit| {
                assert_eq!((name, limit), (DOCUMENT, MAX_DOCUMENT_BYTES));
                Ok::<_, OleError>(json.as_bytes().to_vec())
            });
            assert_eq!(read.unwrap(), Some((expected, json.to_string())));
        }
        // Another program's object, the test-only probe class and the nil class are never read.
        for clsid in [
            OleClass::PROBE.clsid,
            "{00000000-0000-0000-0000-000000000000}",
            "{0002CE02-0000-0000-C000-000000000046}",
            "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0",
            "",
        ] {
            let read = read_pasted_document(clsid, |_, _| -> Result<Vec<u8>, OleError> {
                panic!("read the document of {clsid:?}")
            });
            assert_eq!(read.unwrap(), None);
        }
    }

    #[test]
    fn pasted_chemdraft_objects_keep_the_document_bounds() {
        let error = read_pasted_document(OleClass::STABLE.clsid, |name, limit| {
            Err(format!("Office stream {name} exceeds {limit} bytes"))
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("ChemDraftDocument exceeds 26214400 bytes"));
        for (bytes, reason) in [
            (vec![0xff, 0xfe], "UTF-8"),
            (b"not json".to_vec(), "Invalid ChemDraftDocument JSON"),
            (vec![b' '; MAX_DOCUMENT_BYTES + 1], "25 MiB"),
        ] {
            let error =
                read_pasted_document(OleClass::DEV.clsid, move |_, _| Ok::<_, OleError>(bytes))
                    .unwrap_err();
            assert!(error.to_string().contains(reason), "{error}");
        }

        // A whole stored object, through the same compound-file reader as `read_object_storage`.
        let json = r#"{"kind":"chemdraft-selection","version":1,"objects":[]}"#;
        let stored = write_object_storage(json, &OleClass::STABLE).unwrap();
        let mut file = CompoundFile::open(Cursor::new(stored)).unwrap();
        let clsid = format!("{{{:X}}}", file.root_entry().clsid());
        let read = read_pasted_document(&clsid, |name, limit| {
            read_stream(&mut file, name, limit, "25 MiB")
        })
        .unwrap();
        assert_eq!(read, Some((OleClass::STABLE.clsid, json.to_string())));
    }
}
