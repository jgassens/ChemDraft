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
        agreement: RecognitionAgreement,
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

/// How far the sidecar's runs agreed. The image is recognized at several sizes (`scales_px`, the
/// longer side in pixels, one per run) and the answers compared by canonical SMILES; `agreeing`
/// counts the runs, the returned one included, that gave the returned answer, and `invalid_runs`
/// the runs whose answer did not parse (or that raised), which never win. `invalid_runs` was added
/// within protocol 2, so a sidecar that omits it is read as reporting none.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionAgreement {
    pub runs: u32,
    pub agreeing: u32,
    #[serde(default)]
    pub invalid_runs: u32,
    pub scales_px: Vec<u32>,
}

impl RecognitionAgreement {
    fn validate(&self) -> Result<(), String> {
        if self.runs == 0
            || self.agreeing == 0
            || u64::from(self.agreeing) + u64::from(self.invalid_runs) > u64::from(self.runs)
            || self.scales_px.len() != self.runs as usize
        {
            return Err(format!(
                "The OCSR sidecar reported an inconsistent agreement ({} of {} runs, {} invalid, {} sizes).",
                self.agreeing,
                self.runs,
                self.invalid_runs,
                self.scales_px.len()
            ));
        }
        Ok(())
    }
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
    pub agreement: RecognitionAgreement,
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
            agreement,
            elapsed_ms,
        } if id == expected_id => {
            agreement.validate().map_err(ProtocolResultError::Crashed)?;
            Ok(RecognitionPayload {
                smiles,
                molfile,
                confidence,
                atoms,
                bonds,
                agreement,
                elapsed_ms,
            })
        }
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
                r#"{"type":"ready","protocol":2,"molscribeVersion":"commit","torchVersion":"2"}"#,
            )
            .expect("ready JSON"),
        )
        .expect("ready protocol");

        let result = parse_line(
            r#"{"id":"r1","type":"result","smiles":"C","molfile":"mol","confidence":null,"atoms":[{"index":0,"symbol":"C","x":0.1,"y":0.2,"confidence":null}],"bonds":[],"agreement":{"runs":3,"agreeing":2,"scalesPx":[800,1000,1200]},"elapsedMs":12}"#,
        )
        .expect("result JSON");
        let payload = result_for_id(result, "r1").expect("matching result");
        assert_eq!(payload.smiles, "C");
        assert_eq!(payload.confidence, None);
        assert_eq!(
            payload.agreement,
            RecognitionAgreement {
                runs: 3,
                agreeing: 2,
                invalid_runs: 0,
                scales_px: vec![800, 1000, 1200]
            }
        );

        // The current sidecar reports invalid runs; an older protocol-2 sidecar omitted them (above).
        let result = parse_line(
            r#"{"id":"r2","type":"result","smiles":"C","molfile":"mol","confidence":0.4,"atoms":[],"bonds":[],"agreement":{"runs":5,"agreeing":2,"invalidRuns":3,"scalesPx":[800,900,1000,1100,1200]},"elapsedMs":12}"#,
        )
        .expect("result JSON");
        assert_eq!(
            result_for_id(result, "r2")
                .expect("matching result")
                .agreement,
            RecognitionAgreement {
                runs: 5,
                agreeing: 2,
                invalid_runs: 3,
                scales_px: vec![800, 900, 1000, 1100, 1200]
            }
        );

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
        for old_or_new in [1, 3] {
            let ready = parse_line(&format!(
                r#"{{"type":"ready","protocol":{old_or_new},"molscribeVersion":"x","torchVersion":"y"}}"#
            ))
            .expect("valid JSON");
            assert!(validate_ready(ready)
                .expect_err("protocol mismatch")
                .contains("requires"));
        }
    }

    #[test]
    fn a_result_must_carry_a_consistent_agreement() {
        // Protocol 1 results (no agreement) are refused outright.
        assert!(parse_line(
            r#"{"id":"r1","type":"result","smiles":"C","molfile":"m","confidence":0.5,"atoms":[],"bonds":[],"elapsedMs":1}"#
        )
        .is_err());
        // Unknown agreement fields are refused, not ignored.
        assert!(parse_line(
            r#"{"id":"r1","type":"result","smiles":"C","molfile":"m","confidence":0.5,"atoms":[],"bonds":[],"agreement":{"runs":1,"agreeing":1,"scalesPx":[800],"majority":true},"elapsedMs":1}"#
        )
        .is_err());
        for agreement in [
            r#"{"runs":0,"agreeing":0,"scalesPx":[]}"#,
            r#"{"runs":3,"agreeing":4,"scalesPx":[800,1000,1200]}"#,
            r#"{"runs":3,"agreeing":0,"scalesPx":[800,1000,1200]}"#,
            r#"{"runs":3,"agreeing":3,"scalesPx":[800,1000]}"#,
            // Agreeing and invalid runs are disjoint, so together they cannot exceed the runs.
            r#"{"runs":3,"agreeing":2,"invalidRuns":2,"scalesPx":[800,1000,1200]}"#,
            r#"{"runs":3,"agreeing":1,"invalidRuns":4294967295,"scalesPx":[800,1000,1200]}"#,
        ] {
            let message = parse_line(&format!(
                r#"{{"id":"r1","type":"result","smiles":"C","molfile":"m","confidence":0.5,"atoms":[],"bonds":[],"agreement":{agreement},"elapsedMs":1}}"#
            ))
            .expect("valid JSON");
            assert!(
                matches!(
                    result_for_id(message, "r1"),
                    Err(ProtocolResultError::Crashed(message)) if message.contains("inconsistent agreement")
                ),
                "{agreement} must be refused"
            );
        }
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
