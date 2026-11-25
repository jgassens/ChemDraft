use super::*;
use windows::Win32::{
    Graphics::Gdi::SetEnhMetaFileBits, System::Memory::*, UI::Shell::SHCreateStdEnumFmtEtc,
};

impl Embedded {
    fn formats(&self) -> [FORMATETC; 2] {
        [
            (CF_ENHMETAFILE.0, TYMED_ENHMF),
            (self.sta.png_format, TYMED_HGLOBAL),
        ]
        .map(|(cf, medium)| FORMATETC {
            cfFormat: cf,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: medium.0 as u32,
            ..Default::default()
        })
    }

    fn requested_format(&self, format: *const FORMATETC) -> Result<FORMATETC> {
        let format = unsafe { format.as_ref() }.ok_or(E_POINTER)?;
        if !format.ptd.is_null() {
            return Err(DV_E_DVTARGETDEVICE.into());
        }
        if format.dwAspect != DVASPECT_CONTENT.0 {
            return Err(DV_E_DVASPECT.into());
        }
        if format.lindex != -1 {
            return Err(DV_E_LINDEX.into());
        }
        let supported = self
            .formats()
            .into_iter()
            .find(|f| f.cfFormat == format.cfFormat)
            .ok_or(DV_E_FORMATETC)?;
        if supported.tymed & format.tymed == 0 {
            return Err(DV_E_TYMED.into());
        }
        if self.content.borrow().image.is_none() {
            return Err(OLE_E_BLANK.into());
        }
        Ok(supported)
    }
}

impl IDataObject_Impl for Embedded_Impl {
    fn GetData(&self, format: *const FORMATETC) -> Result<STGMEDIUM> {
        let supported = self.requested_format(format)?;
        let content = self.content.borrow();
        let image = content.image.as_ref().ok_or(OLE_E_BLANK)?;
        // The caller owns the returned medium through ReleaseStgMedium.
        let u = if supported.cfFormat == CF_ENHMETAFILE.0 {
            let emf = unsafe { SetEnhMetaFileBits(&image.emf) };
            if emf.is_invalid() {
                return Err(Error::from_win32());
            }
            STGMEDIUM_0 { hEnhMetaFile: emf }
        } else {
            unsafe {
                let memory = GlobalAlloc(GMEM_MOVEABLE, image.png.len())?;
                let dest = GlobalLock(memory);
                if dest.is_null() {
                    let error = Error::from_win32();
                    let _ = GlobalFree(Some(memory));
                    return Err(error);
                }
                std::ptr::copy_nonoverlapping(image.png.as_ptr(), dest.cast(), image.png.len());
                let _ = GlobalUnlock(memory);
                STGMEDIUM_0 { hGlobal: memory }
            }
        };
        Ok(STGMEDIUM {
            tymed: supported.tymed,
            u,
            ..Default::default()
        })
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        self.requested_format(format)
            .map_or_else(|e| e.code(), |_| S_OK)
    }
    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn SetData(&self, _: *const FORMATETC, _: *const STGMEDIUM, _: BOOL) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetCanonicalFormatEtc(&self, input: *const FORMATETC, out: *mut FORMATETC) -> HRESULT {
        if input.is_null() || out.is_null() {
            return E_POINTER;
        }
        unsafe {
            out.write(super::super::contracts::canonical_format(
                input.read(),
                |format| &mut format.ptd,
            ));
        }
        DATA_S_SAMEFORMATETC
    }
    fn EnumFormatEtc(&self, dir: u32) -> Result<IEnumFORMATETC> {
        if dir != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        let formats = self.formats();
        let available = if self.content.borrow().image.is_some() {
            &formats[..]
        } else {
            &[]
        };
        unsafe { SHCreateStdEnumFmtEtc(available) }
    }
    fn DAdvise(&self, format: *const FORMATETC, advf: u32, sink: Ref<IAdviseSink>) -> Result<u32> {
        if format.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe {
            self.data_advise.Advise(
                &self.to_interface::<IDataObject>(),
                format,
                advf,
                sink.ok()?,
            )
        }
    }
    fn DUnadvise(&self, cookie: u32) -> Result<()> {
        unsafe { self.data_advise.Unadvise(cookie) }
    }
    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        unsafe { self.data_advise.EnumAdvise() }
    }
}
