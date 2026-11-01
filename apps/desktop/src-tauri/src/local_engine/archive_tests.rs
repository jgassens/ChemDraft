use super::file_ops::FileOps;
use super::install::{extract_single_entry_with_ops, ArchiveKind};
use std::{fs, io::Write, path::PathBuf};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "chemdraft-archives-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// A streaming writer: bit 3 is set, local sizes are zero, and a descriptor follows deflated data.
pub(crate) fn descriptor_zip(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
    let mut zip = Vec::new();
    let mut directory = Vec::new();
    for &(name, body, mode) in entries {
        let offset = zip.len() as u32;
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(body).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut crc = flate2::Crc::new();
        crc.update(body);
        let mut local = vec![0; 30];
        local[..4].copy_from_slice(&0x04034b50_u32.to_le_bytes());
        local[4..6].copy_from_slice(&20_u16.to_le_bytes());
        local[6..8].copy_from_slice(&8_u16.to_le_bytes());
        local[8..10].copy_from_slice(&8_u16.to_le_bytes());
        local[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend(local);
        zip.extend(name.as_bytes());
        zip.extend(&compressed);
        for value in [
            0x08074b50,
            crc.sum(),
            compressed.len() as u32,
            body.len() as u32,
        ] {
            zip.extend(value.to_le_bytes());
        }
        let mut central = vec![0; 46];
        central[..4].copy_from_slice(&0x02014b50_u32.to_le_bytes());
        central[4..6].copy_from_slice(&0x0314_u16.to_le_bytes());
        central[6..8].copy_from_slice(&20_u16.to_le_bytes());
        central[8..10].copy_from_slice(&8_u16.to_le_bytes());
        central[10..12].copy_from_slice(&8_u16.to_le_bytes());
        central[16..20].copy_from_slice(&crc.sum().to_le_bytes());
        central[20..24].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
        central[24..28].copy_from_slice(&(body.len() as u32).to_le_bytes());
        central[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
        central[38..42].copy_from_slice(&(mode << 16).to_le_bytes());
        central[42..46].copy_from_slice(&offset.to_le_bytes());
        directory.extend(central);
        directory.extend(name.as_bytes());
    }
    let offset = zip.len() as u32;
    let size = directory.len() as u32;
    zip.extend(directory);
    let mut eocd = vec![0; 22];
    eocd[..4].copy_from_slice(&0x06054b50_u32.to_le_bytes());
    eocd[8..10].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    eocd[10..12].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    eocd[12..16].copy_from_slice(&size.to_le_bytes());
    eocd[16..20].copy_from_slice(&offset.to_le_bytes());
    zip.extend(eocd);
    zip
}

#[test]
fn deflated_data_descriptor_extracts_using_central_sizes() {
    let temp = Temp::new();
    let archive = temp.0.join("test.zip");
    fs::write(
        &archive,
        descriptor_zip(&[("codex.exe", b"executable payload", 0o100755)]),
    )
    .unwrap();
    let output = temp.0.join("binary");
    extract_single_entry_with_ops(
        &archive,
        ArchiveKind::Zip,
        "codex.exe",
        &output,
        FileOps::for_tests(),
    )
    .unwrap();
    assert_eq!(fs::read(output).unwrap(), b"executable payload");
}

#[test]
fn zip_tree_preserves_names_and_rejects_unsafe_entries() {
    let temp = Temp::new();
    let archive = temp.0.join("test.zip");
    let output = temp.0.join("tree");
    fs::create_dir(&output).unwrap();
    fs::write(
        &archive,
        descriptor_zip(&[
            ("codex.exe", b"main", 0o100755),
            ("codex-resources/", b"", 0o040755),
            ("codex-resources/runner.exe", b"helper", 0o100755),
        ]),
    )
    .unwrap();
    extract_single_entry_with_ops(
        &archive,
        ArchiveKind::ZipTree,
        "codex.exe",
        &output,
        FileOps::for_tests(),
    )
    .unwrap();
    assert_eq!(
        fs::read(output.join("codex-resources/runner.exe")).unwrap(),
        b"helper"
    );
    for name in [
        "../escape",
        "/absolute",
        "C:/drive",
        "dir\\..\\escape",
        "dir/../../escape",
        "dir/.. /escape",
        "NUL.txt",
    ] {
        fs::write(&archive, descriptor_zip(&[(name, b"bad", 0o100755)])).unwrap();
        assert!(
            extract_single_entry_with_ops(
                &archive,
                ArchiveKind::ZipTree,
                name,
                &output,
                FileOps::for_tests()
            )
            .is_err(),
            "{name}"
        );
    }
    fs::write(&archive, descriptor_zip(&[("link", b"target", 0o120777)])).unwrap();
    assert!(extract_single_entry_with_ops(
        &archive,
        ArchiveKind::ZipTree,
        "link",
        &output,
        FileOps::for_tests()
    )
    .is_err());
    fs::write(
        &archive,
        descriptor_zip(&vec![("entry", b"".as_slice(), 0o100644); 501]),
    )
    .unwrap();
    let error = extract_single_entry_with_ops(
        &archive,
        ArchiveKind::ZipTree,
        "entry",
        &output,
        FileOps::for_tests(),
    )
    .unwrap_err();
    assert!(error.message.contains("500"));

    let mut oversized = descriptor_zip(&[("large", b"payload", 0o100644)]);
    let eocd = oversized.len() - 22;
    let central = u32::from_le_bytes(oversized[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    oversized[central + 24..central + 28].copy_from_slice(&0x80000001_u32.to_le_bytes());
    fs::write(&archive, oversized).unwrap();
    let error = extract_single_entry_with_ops(
        &archive,
        ArchiveKind::ZipTree,
        "large",
        &output,
        FileOps::for_tests(),
    )
    .unwrap_err();
    assert!(error.message.contains("2 GiB"));
    assert!(!output.join("large").exists());
}

#[test]
fn ustar_and_gnu_tar_gz_regular_file_extracts() {
    for magic in [b"ustar\0".as_slice(), b"ustar ".as_slice()] {
        let temp = Temp::new();
        let mut tar = vec![0; 2048];
        tar[..5].copy_from_slice(b"codex");
        tar[100..108].copy_from_slice(b"0000755\0");
        tar[124..136].copy_from_slice(b"00000000007\0");
        tar[156] = b'0';
        tar[257..263].copy_from_slice(magic);
        tar[263..265].copy_from_slice(if magic == b"ustar\0" { b"00" } else { b" \0" });
        tar[148..156].fill(b' ');
        let sum: u32 = tar[..512].iter().map(|&b| b as u32).sum();
        tar[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        tar[512..519].copy_from_slice(b"payload");
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&tar).unwrap();
        let archive = temp.0.join("test.tar.gz");
        fs::write(&archive, gzip.finish().unwrap()).unwrap();
        let output = temp.0.join("binary");
        extract_single_entry_with_ops(
            &archive,
            ArchiveKind::TarGz,
            "codex",
            &output,
            FileOps::for_tests(),
        )
        .unwrap();
        assert_eq!(fs::read(output).unwrap(), b"payload");
    }
}
