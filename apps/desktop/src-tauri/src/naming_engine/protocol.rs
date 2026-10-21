use serde::{Deserialize, Serialize};

use super::{pins, process::ProcessError};

pub const NAMING_PROTOCOL_VERSION: u32 = 1;
pub const MAX_SMILES_CHARS: usize = 5000;

/// Field names match document-workflow-core's OrthonymRawResult; no policy is applied here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawResult {
    pub name: Option<String>,
    pub tier: String,
    pub is_pin: bool,
    pub opsin: String,
    pub gate_outcome: String,
    pub limit_code: Option<String>,
    pub stereo_unexpressed: bool,
    pub source: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SidecarLine {
    Ready {
        protocol: u32,
        orthonym_version: String,
        rdkit_version: String,
        jvm: String,
    },
    Fatal {
        code: String,
        message: String,
    },
    // Fields are explicit: serde flatten would undermine deny_unknown_fields.
    Result {
        id: String,
        name: Option<String>,
        tier: String,
        is_pin: bool,
        opsin: String,
        gate_outcome: String,
        limit_code: Option<String>,
        stereo_unexpressed: bool,
        source: String,
        elapsed_ms: u64,
    },
    Error {
        id: Option<String>,
        code: String,
        message: String,
    },
}

pub fn parse_line(line: &str) -> Result<SidecarLine, ProcessError> {
    serde_json::from_str(line)
        .map_err(|error| ProcessError::Crashed(format!("Invalid naming engine response: {error}")))
}

pub fn ready(line: &str) -> Result<(), ProcessError> {
    match parse_line(line)? {
        SidecarLine::Ready {
            protocol,
            orthonym_version,
            rdkit_version,
            jvm,
        } if protocol == NAMING_PROTOCOL_VERSION
            && orthonym_version == pins::ORTHONYM_VERSION
            && !rdkit_version.is_empty()
            && jvm == "jpype" =>
        {
            Ok(())
        }
        SidecarLine::Fatal { code, message } => Err(ProcessError::Crashed(format!(
            "Naming engine fatal ({code}): {message}"
        ))),
        _ => Err(ProcessError::Crashed(
            "The naming engine did not announce protocol 1, Orthonym 1.0.8 and JPype.".into(),
        )),
    }
}

pub fn result(line: &str, expected_id: &str) -> Result<RawResult, ProcessError> {
    match parse_line(line)? {
        SidecarLine::Result {
            id,
            name,
            tier,
            is_pin,
            opsin,
            gate_outcome,
            limit_code,
            stereo_unexpressed,
            source,
            elapsed_ms,
        } if id == expected_id => Ok(RawResult {
            name,
            tier,
            is_pin,
            opsin,
            gate_outcome,
            limit_code,
            stereo_unexpressed,
            source,
            elapsed_ms,
        }),
        SidecarLine::Error { id, code, message } if id.as_deref() == Some(expected_id) => {
            match code.as_str() {
                "invalid_smiles" => Err(ProcessError::InvalidSmiles(message)),
                "namer_raised" => Err(ProcessError::NamingFailed(message)),
                _ => Err(ProcessError::Crashed(format!(
                    "Naming engine error ({code}): {message}"
                ))),
            }
        }
        SidecarLine::Fatal { code, message } => Err(ProcessError::Crashed(format!(
            "Naming engine fatal ({code}): {message}"
        ))),
        _ => Err(ProcessError::Crashed(
            "Unexpected naming engine response or mismatched request id.".into(),
        )),
    }
}

pub fn validate_smiles(smiles: &str) -> Result<(), ProcessError> {
    if smiles.is_empty()
        || smiles.chars().count() > MAX_SMILES_CHARS
        || smiles.trim() != smiles
        || smiles.chars().any(char::is_control)
    {
        return Err(ProcessError::InvalidSmiles("SMILES must contain 1–5000 characters without control characters or surrounding whitespace.".into()));
    }
    Ok(())
}

pub fn encode(id: &str, smiles: &str) -> Result<String, ProcessError> {
    validate_smiles(smiles)?;
    serde_json::to_string(&serde_json::json!({"type":"name", "id":id, "smiles":smiles}))
        .map_err(|error| ProcessError::Crashed(error.to_string()))
}
