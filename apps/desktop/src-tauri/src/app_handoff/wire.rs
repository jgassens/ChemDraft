use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

pub(super) const INPUT_BYTES: usize = 1024 * 1024;
pub(super) const SEND_BYTES: usize = 5 * INPUT_BYTES;
pub(super) const STDERR_BYTES: usize = 256 * 1024;
pub(super) const STDERR_TAIL_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Extension {
    Xyz,
    Cif,
    Mol,
    Sdf,
    Pdb,
    Smi,
    Csv,
    Json,
    Txt,
}

impl Extension {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Xyz => "xyz",
            Self::Cif => "cif",
            Self::Mol => "mol",
            Self::Sdf => "sdf",
            Self::Pdb => "pdb",
            Self::Smi => "smi",
            Self::Csv => "csv",
            Self::Json => "json",
            Self::Txt => "txt",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Call {
    invocation: super::arming::MenuInvocation,
    method: Method,
    request: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Method {
    ChooseApp,
    Status,
    SendFile,
    RunCompanion,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChooseRequest {
    pub purpose: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StatusRequest {
    pub app_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendRequest {
    pub app_id: String,
    pub file_name: String,
    pub extension: Extension,
    pub text: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    pub warnings: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Input {
    pub extension: Extension,
    pub text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RunRequest {
    pub app_id: String,
    pub pipeline: String,
    pub combination: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    pub input: Option<Input>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    pub open_output: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    pub warnings: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    pub retry: Option<Retry>,
}

/// API 0.1.29: alternative inputs, tried in order after a completed attempt whose report meets
/// `when`. Each text has the first input's extension and limits.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Retry {
    pub inputs: Vec<String>,
    pub when: RetryCondition,
}

/// Holds when step `step` reports exactly one row labelled `label` whose value is a finite
/// number other than `not_equal`. See `retry::reading` for the lookup.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetryCondition {
    pub step: String,
    pub label: String,
    pub not_equal: f64,
}

pub(super) fn optional<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(de).map(Some)
}

#[derive(Debug)]
pub(super) enum Request {
    Choose(ChooseRequest),
    Status(StatusRequest),
    Send(SendRequest),
    Run(RunRequest),
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "Invalid app handoff request fields.".into())
}

pub(super) fn id(value: &str) -> bool {
    value.starts_with(|ch: char| ch.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
}

impl Call {
    pub(super) fn parse(value: Value) -> Result<(super::arming::MenuInvocation, Request), String> {
        let Self {
            invocation,
            method,
            request,
        } = decode(value)?;
        let request = match method {
            Method::ChooseApp => {
                let request: ChooseRequest = decode(request)?;
                if request.purpose.chars().count() > 200 || request.purpose.contains('\0') {
                    return Err("The app picker purpose must fit 200 characters.".into());
                }
                Request::Choose(request)
            }
            Method::Status => {
                let request: StatusRequest = decode(request)?;
                check_app_id(&request.app_id)?;
                Request::Status(request)
            }
            Method::SendFile => {
                let request: SendRequest = decode(request)?;
                check_app_id(&request.app_id)?;
                if request.text.len() > SEND_BYTES {
                    return Err("The handoff file exceeds 5 MiB.".into());
                }
                check_warnings(request.warnings.as_deref())?;
                Request::Send(request)
            }
            Method::RunCompanion => {
                let request: RunRequest = decode(request)?;
                check_app_id(&request.app_id)?;
                if !id(&request.pipeline) || !id(&request.combination) {
                    return Err(
                        "A companion pipeline and combination must use declared IDs.".into(),
                    );
                }
                if request
                    .input
                    .as_ref()
                    .is_some_and(|input| input.extension != Extension::Xyz)
                {
                    return Err("Companion confirmation supports only XYZ input.".into());
                }
                if request
                    .input
                    .as_ref()
                    .is_some_and(|input| input.text.len() > INPUT_BYTES)
                {
                    return Err("The companion input exceeds 1 MiB.".into());
                }
                check_warnings(request.warnings.as_deref())?;
                if let Some(retry) = &request.retry {
                    super::retry::check_request(retry, request.input.as_ref())?;
                }
                Request::Run(request)
            }
        };
        Ok((invocation, request))
    }
}

pub(super) const WARNING_CHARS: usize = 300;

fn check_warnings(warnings: Option<&[String]>) -> Result<(), String> {
    if warnings.is_some_and(|lines| {
        lines.len() > 20
            || lines.iter().any(|line| {
                line.chars().take(WARNING_CHARS + 1).count() > WARNING_CHARS || line.contains('\0')
            })
    }) {
        return Err("Handoff warnings allow 20 lines of up to 300 characters each.".into());
    }
    Ok(())
}

fn check_app_id(value: &str) -> Result<(), String> {
    if value.len() == 32 && value.bytes().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("The app ID must come from the ChemDraft app picker.".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChosenApp {
    pub app_id: String,
    pub display_name: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(super) enum ChooseResult {
    Chosen { app: ChosenApp },
    Cancelled,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StatusResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum SendCode {
    AppMissing,
    AppChanged,
    LaunchFailed,
    WriteFailed,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(super) enum SendResult {
    Sent,
    Declined,
    Failed { code: SendCode, message: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum RunCode {
    AppMissing,
    AppChanged,
    ToolMissing,
    BadParam,
    VersionUntested,
    Timeout,
    ExitNonzero,
    BadOutput,
    WriteFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Diagnostic {
    pub step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StepResult {
    pub id: String,
    pub json: Value,
}

/// Present only for a request with `retry`. Variant 0 is `input`; variant n is `retry.inputs[n - 1]`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Sequence {
    pub attempts: usize,
    pub variant: usize,
}

impl Sequence {
    pub(super) fn after(attempts: usize) -> Self {
        Self {
            attempts,
            variant: attempts.saturating_sub(1),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(super) enum RunResult {
    Done {
        steps: Vec<StepResult>,
        opened: bool,
        #[serde(flatten, skip_serializing_if = "Option::is_none")]
        sequence: Option<Sequence>,
    },
    Declined,
    Failed {
        code: RunCode,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostic: Option<Diagnostic>,
        #[serde(flatten, skip_serializing_if = "Option::is_none")]
        sequence: Option<Sequence>,
    },
}

pub(super) fn encode(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "Could not encode the app handoff result.".into())
}
