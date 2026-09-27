use serde::{Deserialize, Serialize};

use super::pins;

pub const MAX_PROTOCOL_LINE_BYTES: usize = 16 * 1024 * 1024;
/// The most readings one request may announce. The sidecar plans at most 15 (its whole size grid,
/// plus the original size for a small image); anything far beyond that is a broken sidecar.
pub const MAX_RUNS_PLANNED: u32 = 64;

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
    /// Sent before each reading of a request, and always before that request's result or error.
    /// Added within protocol 2: the final line is unchanged, so progress is purely additive.
    Progress {
        id: String,
        stage: SidecarProgressStage,
        run: u32,
        #[serde(rename = "runsPlanned")]
        runs_planned: u32,
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
#[serde(rename_all = "camelCase")]
pub enum SidecarProgressStage {
    Reading,
}

/// A reading has started: `run` counts from 1 and `runs_planned` is the vote's current size, which
/// grows once (usually 5 to 15) when the first pass disagrees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadingProgress {
    pub run: u32,
    pub runs_planned: u32,
}

/// One line read while a request is pending: a progress report, or the request's final answer.
#[derive(Debug, PartialEq)]
pub enum RequestLine {
    Progress(ReadingProgress),
    Final(Result<RecognitionPayload, ProtocolResultError>),
}

/// Sorts a line read while `expected_id` is pending. Progress is accepted strictly: only for the
/// pending request, and only with a count that makes sense; anything else ends the request as a
/// crash, like a result for the wrong request does.
pub fn classify_for_id(message: SidecarMessage, expected_id: &str) -> RequestLine {
    match message {
        SidecarMessage::Progress {
            id,
            stage: SidecarProgressStage::Reading,
            run,
            runs_planned,
        } => {
            if id != expected_id {
                return RequestLine::Final(Err(ProtocolResultError::Crashed(format!(
                    "The OCSR sidecar reported progress for request {id} while waiting for {expected_id}."
                ))));
            }
            if run == 0 || run > runs_planned || runs_planned > MAX_RUNS_PLANNED {
                return RequestLine::Final(Err(ProtocolResultError::Crashed(format!(
                    "The OCSR sidecar reported an inconsistent progress (reading {run} of {runs_planned})."
                ))));
            }
            RequestLine::Progress(ReadingProgress { run, runs_planned })
        }
        other => RequestLine::Final(result_for_id(other, expected_id)),
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
    fn progress_is_accepted_only_for_the_pending_request_and_with_a_sane_count() {
        let line = |id: &str, run: u32, planned: u32| {
            parse_line(&format!(
                r#"{{"id":"{id}","type":"progress","stage":"reading","run":{run},"runsPlanned":{planned}}}"#
            ))
            .expect("progress JSON")
        };
        assert_eq!(
            classify_for_id(line("r1", 1, 5), "r1"),
            RequestLine::Progress(ReadingProgress {
                run: 1,
                runs_planned: 5
            })
        );
        assert_eq!(
            classify_for_id(line("r1", 6, 15), "r1"),
            RequestLine::Progress(ReadingProgress {
                run: 6,
                runs_planned: 15
            })
        );
        assert!(matches!(
            classify_for_id(line("r0", 1, 5), "r1"),
            RequestLine::Final(Err(ProtocolResultError::Crashed(message))) if message.contains("request r0")
        ));
        for (run, planned) in [(0, 5), (6, 5), (1, MAX_RUNS_PLANNED + 1)] {
            assert!(
                matches!(
                    classify_for_id(line("r1", run, planned), "r1"),
                    RequestLine::Final(Err(ProtocolResultError::Crashed(message))) if message.contains("inconsistent progress")
                ),
                "reading {run} of {planned} must be refused"
            );
        }
        // An unknown stage, or a progress line without an id, is malformed rather than ignored.
        assert!(parse_line(
            r#"{"id":"r1","type":"progress","stage":"dreaming","run":1,"runsPlanned":5}"#
        )
        .is_err());
        assert!(
            parse_line(r#"{"type":"progress","stage":"reading","run":1,"runsPlanned":5}"#).is_err()
        );
        // Progress is not a ready message, and the final line still classifies as before.
        assert!(validate_ready(line("r1", 1, 5)).is_err());
        let result = parse_line(
            r#"{"id":"r1","type":"result","smiles":"C","molfile":"m","confidence":null,"atoms":[],"bonds":[],"agreement":{"runs":1,"agreeing":1,"scalesPx":[800]},"elapsedMs":1}"#,
        )
        .expect("result JSON");
        assert!(matches!(
            classify_for_id(result, "r1"),
            RequestLine::Final(Ok(payload)) if payload.smiles == "C"
        ));
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
