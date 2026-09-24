use serde::{Deserialize, Serialize};

use super::pins;

pub const MAX_PROTOCOL_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SidecarRequest<'a> {
    Recognize {
        id: &'a str,
        #[serde(rename = "imagePath")]
        image_path: &'a str,
    },
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SidecarMessage {
    Ready {
        protocol: u32,
        #[serde(rename = "molscribeVersion")]
        molscribe_version: String,
        #[serde(rename = "torchVersion")]
        torch_version: String,
    },
    Result {
        id: String,
        smiles: String,
        molfile: String,
        confidence: Option<f64>,
        atoms: Vec<RecognizedAtom>,
        bonds: Vec<RecognizedBond>,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
    },
    Error {
        id: Option<String>,
        code: SidecarErrorCode,
        message: String,
    },
    Fatal {
        code: String,
        message: String,
    },
}

/// One atom as MolScribe drew it. `x`/`y` are fractions of the image width and height; every
/// `confidence` is MolScribe's own score or null, never a filled-in default.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedAtom {
    pub index: usize,
    pub symbol: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub confidence: Option<f64>,
}

/// `bond_type` is MolScribe's label: single, double, triple, aromatic, solid wedge, dashed wedge.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedBond {
    pub begin: usize,
    pub end: usize,
    pub bond_type: String,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SidecarErrorCode {
    InvalidImage,
    RecognitionFailed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecognitionPayload {
    pub smiles: String,
    pub molfile: String,
    pub confidence: Option<f64>,
    pub atoms: Vec<RecognizedAtom>,
    pub bonds: Vec<RecognizedBond>,
    pub elapsed_ms: u64,
}

pub fn encode_request(request: &SidecarRequest<'_>) -> Result<String, String> {
    serde_json::to_string(request)
        .map_err(|error| format!("Could not encode OCSR request: {error}"))
}

pub fn parse_line(line: &str) -> Result<SidecarMessage, String> {
    if line.len() > MAX_PROTOCOL_LINE_BYTES {
        return Err("The OCSR sidecar returned an oversized protocol line.".to_string());
    }
    serde_json::from_str(line)
        .map_err(|error| format!("The OCSR sidecar returned malformed JSON: {error}"))
}

pub fn validate_ready(message: SidecarMessage) -> Result<(), String> {
    match message {
        SidecarMessage::Ready {
            protocol,
            molscribe_version,
            torch_version,
        } if protocol == pins::PROTOCOL_VERSION => {
            if molscribe_version.is_empty() || torch_version.is_empty() {
                Err("The OCSR sidecar omitted its dependency versions.".to_string())
            } else {
                Ok(())
            }
        }
        SidecarMessage::Ready { protocol, .. } => Err(format!(
            "The OCSR sidecar uses protocol {protocol}; this build requires protocol {}.",
            pins::PROTOCOL_VERSION
        )),
        SidecarMessage::Fatal { code, message } => Err(format!(
            "The OCSR engine failed to load ({code}): {message}"
        )),
        _ => Err("The OCSR sidecar did not send its ready message.".to_string()),
    }
}

pub fn result_for_id(
    message: SidecarMessage,
    expected_id: &str,
) -> Result<RecognitionPayload, ProtocolResultError> {
    match message {
        SidecarMessage::Result {
            id,
            smiles,
            molfile,
            confidence,
            atoms,
            bonds,
            elapsed_ms,
        } if id == expected_id => Ok(RecognitionPayload {
            smiles,
            molfile,
            confidence,
            atoms,
            bonds,
            elapsed_ms,
        }),
        SidecarMessage::Error { id, code, message }
            if id.as_deref().is_none() || id.as_deref() == Some(expected_id) =>
        {
            Err(ProtocolResultError::Recognition { code, message })
        }
        SidecarMessage::Fatal { code, message } => Err(ProtocolResultError::Crashed(format!(
            "The OCSR engine stopped ({code}): {message}"
        ))),
        SidecarMessage::Result { id, .. } | SidecarMessage::Error { id: Some(id), .. } => {
            Err(ProtocolResultError::Crashed(format!(
                "The OCSR sidecar replied for request {id} while waiting for {expected_id}."
            )))
        }
        _ => Err(ProtocolResultError::Crashed(
            "The OCSR sidecar returned an unexpected protocol message.".to_string(),
        )),
    }
}

#[derive(Debug, PartialEq)]
pub enum ProtocolResultError {
    Recognition {
        code: SidecarErrorCode,
        message: String,
    },
    Crashed(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_result_and_error_lines() {
        validate_ready(
            parse_line(
                r#"{"type":"ready","protocol":1,"molscribeVersion":"commit","torchVersion":"2"}"#,
            )
            .expect("ready JSON"),
        )
        .expect("ready protocol");

        let result = parse_line(
            r#"{"id":"r1","type":"result","smiles":"C","molfile":"mol","confidence":null,"atoms":[{"index":0,"symbol":"C","x":0.1,"y":0.2,"confidence":null}],"bonds":[],"elapsedMs":12}"#,
        )
        .expect("result JSON");
        let payload = result_for_id(result, "r1").expect("matching result");
        assert_eq!(payload.smiles, "C");
        assert_eq!(payload.confidence, None);

        let error = parse_line(
            r#"{"id":"r1","type":"error","code":"invalid_image","message":"bad image"}"#,
        )
        .expect("error JSON");
        assert_eq!(
            result_for_id(error, "r1"),
            Err(ProtocolResultError::Recognition {
                code: SidecarErrorCode::InvalidImage,
                message: "bad image".to_string()
            })
        );
    }

    #[test]
    fn rejects_malformed_lines_and_wrong_protocols() {
        assert!(parse_line("not json").is_err());
        let ready = parse_line(
            r#"{"type":"ready","protocol":2,"molscribeVersion":"x","torchVersion":"y"}"#,
        )
        .expect("valid JSON");
        assert!(validate_ready(ready)
            .expect_err("protocol mismatch")
            .contains("requires"));
    }

    #[test]
    fn request_framing_is_one_json_object() {
        let encoded = encode_request(&SidecarRequest::Recognize {
            id: "r1",
            image_path: "/tmp/image.png",
        })
        .expect("encode");
        assert!(!encoded.contains('\n'));
        let value: serde_json::Value = serde_json::from_str(&encoded).expect("request JSON");
        assert_eq!(value["imagePath"], "/tmp/image.png");
    }
}
