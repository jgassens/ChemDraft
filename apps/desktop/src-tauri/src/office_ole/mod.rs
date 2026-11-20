//! Platform-neutral storage and preview for ChemDraft's embedded OLE object.

// The Windows caller arrives with the COM server.
#![cfg_attr(not(test), allow(dead_code))]

pub(crate) mod emf;
pub(crate) mod storage;

#[derive(Debug)]
pub(crate) struct OleError(String);

impl std::fmt::Display for OleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for OleError {}
