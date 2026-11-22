use super::super::{
    contracts::{PersistError, PersistState, Saved},
    emf::MAX_PNG_BYTES,
    storage::{
        decode_document, document_bytes, read_pasted_document, DOCUMENT, MAX_DOCUMENT_BYTES,
    },
};
use super::*;

// The default in-process OLE handler owns the Office presentation cache. Keep the source PNG
// here as well so GetData can supply the original carrier when Word repacks the storage.
const PREVIEW: &str = "ChemDraftPreview";
const EXTENT: &str = "ChemDraftExtent";

fn read_stream(storage: &IStorage, name: &str, limit: usize) -> Result<Vec<u8>> {
    let stream = unsafe {
        storage.OpenStream(
            &HSTRING::from(name),
            None,
            STGM_READ | STGM_SHARE_EXCLUSIVE,
            0,
        )
    }
    .map_err(|e| {
        Error::new(
            e.code(),
            format!("Could not open Office stream {name}: {e}"),
        )
    })?;
    let mut stat = STATSTG::default();
    unsafe {
        stream.Stat(&mut stat, STATFLAG_NONAME)?;
    }
    if stat.cbSize > limit as u64 {
        return Err(Error::new(
            STG_E_MEDIUMFULL,
            format!("Office stream {name} exceeds {limit} bytes"),
        ));
    }
    let mut bytes = vec![0; stat.cbSize as usize];
    let mut count = 0;
    unsafe {
        stream
            .Read(
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                Some(&mut count),
            )
            .ok()?;
    }
    if count as usize != bytes.len() {
        return Err(Error::new(
            STG_E_READFAULT,
            format!("Incomplete Office stream {name}"),
        ));
    }
    Ok(bytes)
}

fn optional_stream(storage: &IStorage, name: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    match read_stream(storage, name, limit) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.code() == STG_E_FILENOTFOUND => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_stream(storage: &IStorage, name: &str, bytes: &[u8]) -> Result<()> {
    let result = (|| -> Result<()> {
        let stream = unsafe {
            storage.CreateStream(
                &HSTRING::from(name),
                STGM_CREATE | STGM_WRITE | STGM_SHARE_EXCLUSIVE,
                0,
                0,
            )?
        };
        let mut written = 0;
        unsafe {
            stream
                .Write(
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    Some(&mut written),
                )
                .ok()?;
        }
        if written as usize != bytes.len() {
            return Err(STG_E_MEDIUMFULL.into());
        }
        unsafe { stream.Commit(STGC_DEFAULT) }
    })();
    result.map_err(|e| {
        Error::new(
            e.code(),
            format!("Could not write Office stream {name}: {e}"),
        )
    })
}

fn check_class(storage: &IStorage, class: GUID, allow_empty: bool) -> Result<()> {
    let found = unsafe { ReadClassStg(storage)? };
    if found == class || allow_empty && found == GUID::zeroed() {
        return Ok(());
    }
    Err(Error::new(
        OLE_E_WRONGCOMPOBJ,
        format!("Office storage CLSID {found:?} does not match ChemDraft class {class:?}"),
    ))
}

/// A copied object's drawing for paste-back ("Embedded Object" or "Embed Source",
/// `windows_clipboard`), read with `Load`'s own stream reader and decoder. `Ok(None)` when the
/// storage holds another program's object: that paste falls through to the other formats.
pub(crate) fn pasted_drawing(storage: &IStorage) -> Result<Option<(&'static str, String)>> {
    let class = unsafe { ReadClassStg(storage)? };
    read_pasted_document(&format!("{{{class:?}}}"), |name, limit| {
        read_stream(storage, name, limit)
    })
    .map_err(invalid)
}

fn state_error(error: PersistError) -> Error {
    match error {
        PersistError::AlreadyInitialized => CO_E_ALREADYINITIALIZED,
        PersistError::Unexpected => E_UNEXPECTED,
        PersistError::SaveInProgress => STG_E_CANTSAVE,
        PersistError::MissingStorage => E_INVALIDARG,
    }
    .into()
}

impl Embedded {
    fn write_class_metadata(&self, store: &IStorage) -> Result<()> {
        unsafe {
            WriteClassStg(store, &self.sta.guid)?;
            WriteFmtUserTypeStg(store, 0, &HSTRING::from(self.sta.class.user_type))
        }
    }
}

fn invalid(error: impl std::fmt::Display) -> Error {
    Error::new(STG_E_INVALIDHEADER, error.to_string())
}

impl IPersist_Impl for Embedded_Impl {
    fn GetClassID(&self) -> Result<GUID> {
        Ok(self.sta.guid)
    }
}

impl IPersistStorage_Impl for Embedded_Impl {
    fn IsDirty(&self) -> HRESULT {
        if self.dirty() {
            S_OK
        } else {
            S_FALSE
        }
    }
    fn InitNew(&self, store: Ref<IStorage>) -> Result<()> {
        let next = self.persistence.get().initialize().map_err(state_error)?;
        let store = store.ok()?;
        check_class(store, self.sta.guid, true)?;
        let blank = Content::blank().map_err(invalid)?;
        self.write_class_metadata(store)?;
        self.storage.replace(Some(store.clone()));
        self.content.replace(Rc::new(blank));
        self.extent.set(None);
        self.persistence.set(next);
        self.changed();
        Ok(())
    }
    fn Load(&self, store: Ref<IStorage>) -> Result<()> {
        let next = self.persistence.get().initialize().map_err(state_error)?;
        let store = store.ok()?;
        check_class(store, self.sta.guid, false)?;
        let json =
            decode_document(read_stream(store, DOCUMENT, MAX_DOCUMENT_BYTES)?).map_err(invalid)?;
        // Early compound files have only ChemDraftDocument. They can be opened and edited;
        // their container supplies the cached preview until the first editor update.
        let png = optional_stream(store, PREVIEW, MAX_PNG_BYTES)?;
        let content = Content::load(json, png).map_err(invalid)?;
        let extent = optional_stream(store, EXTENT, 8)?
            .map(|v| {
                let bytes: [u8; 8] = v
                    .try_into()
                    .map_err(|_| invalid("ChemDraftExtent must contain two HIMETRIC dimensions"))?;
                let size = [
                    i32::from_le_bytes(bytes[..4].try_into().unwrap()),
                    i32::from_le_bytes(bytes[4..].try_into().unwrap()),
                ];
                if size.iter().any(|&n| n <= 0) {
                    return Err(invalid("ChemDraftExtent must be positive"));
                }
                Ok(size)
            })
            .transpose()?;
        self.storage.replace(Some(store.clone()));
        self.content.replace(Rc::new(content));
        self.extent.set(extent);
        self.clean.set(self.generation.get());
        self.persistence.set(next);
        Ok(())
    }
    fn Save(&self, store: Ref<IStorage>, same: BOOL) -> Result<()> {
        let saved = Saved {
            generation: self.generation.get(),
            same_storage: same.as_bool(),
        };
        let next = self.persistence.get().save(saved).map_err(state_error)?;
        let store = store.ok()?;
        check_class(store, self.sta.guid, true)?;
        let content = self.content.borrow().clone();
        let extent = self.extent.get();
        let doc = document_bytes(&content.json).map_err(invalid)?;
        self.write_class_metadata(store)?;
        write_stream(store, DOCUMENT, doc)?;
        for (name, bytes) in [
            (
                PREVIEW,
                content.image.as_ref().map(|image| image.png.as_slice()),
            ),
            (
                EXTENT,
                extent
                    .map(|[cx, cy]| [cx.to_le_bytes(), cy.to_le_bytes()].concat())
                    .as_deref(),
            ),
        ] {
            if let Some(bytes) = bytes {
                write_stream(store, name, bytes)?;
            } else if let Err(e) = unsafe { store.DestroyElement(&HSTRING::from(name)) } {
                if e.code() != STG_E_FILENOTFOUND {
                    return Err(e);
                }
            }
        }
        // The container owns IStorage::Commit. Remain dirty during NoScribble.
        self.persistence.set(next);
        Ok(())
    }
    fn SaveCompleted(&self, new: Ref<IStorage>) -> Result<()> {
        let clean = self
            .persistence
            .get()
            .complete(!new.is_null())
            .map_err(state_error)?;
        if let Some(store) = new.as_ref() {
            check_class(store, self.sta.guid, false)?;
            self.storage.replace(Some(store.clone()));
        }
        if let Some(generation) = clean {
            self.clean.set(generation);
        }
        self.persistence.set(PersistState::Normal);
        Ok(())
    }
    fn HandsOffStorage(&self) -> Result<()> {
        let next = self.persistence.get().hands_off().map_err(state_error)?;
        self.storage.take();
        self.persistence.set(next);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_checks_class_stream_size_missing_document_and_overwrite() -> Result<()> {
        // The in-memory docfile needs no registry entries or running Office process.
        unsafe {
            OleInitialize(None)?;
        }
        let result = (|| {
            let memory = unsafe { CreateILockBytesOnHGlobal(None, true)? };
            let store = unsafe {
                StgCreateDocfileOnILockBytes(
                    &memory,
                    STGM_CREATE | STGM_SHARE_EXCLUSIVE | STGM_READWRITE,
                    0,
                )?
            };
            let class = GUID::try_from(OleClass::DEV.clsid.trim_matches(['{', '}']))?;
            check_class(&store, class, true)?;
            assert_eq!(
                check_class(&store, class, false).unwrap_err().code(),
                OLE_E_WRONGCOMPOBJ
            );
            let missing = read_stream(&store, DOCUMENT, 1024).unwrap_err();
            assert_eq!(missing.code(), STG_E_FILENOTFOUND);
            assert!(missing.message().contains(DOCUMENT));
            unsafe {
                WriteClassStg(&store, &class)?;
            }
            check_class(&store, class, false)?;
            write_stream(&store, DOCUMENT, b"123456")?;
            assert_eq!(
                read_stream(&store, DOCUMENT, 5).unwrap_err().code(),
                STG_E_MEDIUMFULL
            );
            write_stream(&store, DOCUMENT, b"{}")?;
            assert_eq!(read_stream(&store, DOCUMENT, 2)?, b"{}");
            Ok(())
        })();
        unsafe {
            OleUninitialize();
        }
        result
    }

    #[test]
    fn pasted_storage_is_read_only_for_chemdraft_classes() -> Result<()> {
        unsafe {
            OleInitialize(None)?;
        }
        let result = (|| {
            let memory = unsafe { CreateILockBytesOnHGlobal(None, true)? };
            let store = unsafe {
                StgCreateDocfileOnILockBytes(
                    &memory,
                    STGM_CREATE | STGM_SHARE_EXCLUSIVE | STGM_READWRITE,
                    0,
                )?
            };
            let json = r#"{"kind":"chemdraft-selection","version":1}"#;
            write_stream(&store, DOCUMENT, json.as_bytes())?;
            // No class, or another program's class: nothing is read and nothing fails.
            assert_eq!(pasted_drawing(&store)?, None);
            let other = GUID::try_from("0002CE02-0000-0000-C000-000000000046")?;
            unsafe {
                WriteClassStg(&store, &other)?;
            }
            assert_eq!(pasted_drawing(&store)?, None);
            for class in [OleClass::STABLE, OleClass::DEV] {
                let guid = GUID::try_from(class.clsid.trim_matches(['{', '}']))?;
                unsafe {
                    WriteClassStg(&store, &guid)?;
                }
                assert_eq!(
                    pasted_drawing(&store)?,
                    Some((class.clsid, json.to_string()))
                );
            }
            write_stream(&store, DOCUMENT, b"not json")?;
            assert_eq!(
                pasted_drawing(&store).unwrap_err().code(),
                STG_E_INVALIDHEADER
            );
            Ok(())
        })();
        unsafe {
            OleUninitialize();
        }
        result
    }
}
