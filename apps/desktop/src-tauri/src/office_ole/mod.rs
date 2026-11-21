//! ChemDraft's local OLE classes. Only the selection streams and preview need a host-neutral codec.

pub(crate) mod bridge;
#[cfg(any(windows, test))]
mod contracts;
#[cfg(any(windows, test))]
pub(crate) mod emf;
pub(crate) mod launch;
#[cfg(any(windows, test))]
mod presentation;
#[cfg(any(windows, test))]
pub(crate) mod recovery;
#[cfg(any(windows, test))]
pub(crate) mod registry;
#[cfg(windows)]
pub(crate) mod server;
#[cfg(any(windows, test))]
pub(crate) mod session_publish;
#[cfg(any(windows, test))]
pub(crate) mod storage;
pub(crate) mod toolset_events;

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OleClass {
    clsid: &'static str,
    prog_id: &'static str,
    independent: &'static str,
    user_type: &'static str,
}

#[cfg(any(windows, test))]
impl OleClass {
    const STABLE: Self = Self {
        clsid: "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}",
        prog_id: "ChemDraft.Structure.1",
        independent: "ChemDraft.Structure",
        user_type: "ChemDraft Structure",
    };
    const DEV: Self = Self {
        clsid: "{8D23DEDA-8B23-4D62-BEEC-6C6168D48BB4}",
        prog_id: "ChemDraft.DevStructure.1",
        independent: "ChemDraft.DevStructure",
        user_type: "ChemDraft (dev) Structure",
    };
    #[cfg(test)]
    const PROBE: Self = Self {
        clsid: "{9555AC51-4097-416B-8588-E2BA35E8AF94}",
        prog_id: "ChemDraft.Structure.Probe",
        independent: "ChemDraft.Structure.Probe",
        user_type: "ChemDraft Structure (probe)",
    };

    #[cfg(test)]
    pub(crate) const fn probe() -> Self {
        Self::PROBE
    }

    // desktop-tauri.mjs resolves CHEMDRAFT_STABLE_BUILD at packaging time. Never consult a
    // runtime environment variable to choose a registry namespace.
    fn for_identifier(identifier: &str) -> Result<Self, OleError> {
        match identifier {
            "org.chemdraft.desktop" => Ok(Self::STABLE),
            "org.chemdraft.desktop.dev" => Ok(Self::DEV),
            _ => Err(OleError(format!(
                "No Office class for bundle {identifier:?}"
            ))),
        }
    }
}

#[derive(Debug)]
#[cfg(any(windows, test))]
pub(crate) struct OleError(String);

#[cfg(any(windows, test))]
impl std::fmt::Display for OleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(any(windows, test))]
impl std::error::Error for OleError {}
