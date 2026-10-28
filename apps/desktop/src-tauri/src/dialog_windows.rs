//! Document-owned, modeless native dialog host. Webviews receive drafts, never document authority.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const MAX_BYTES: usize = 16 * 1024;
const MAX_PREVIEW_BYTES: usize = 5 * 1024 * 1024;
// Tauri 2.11.2 queues JSON >= 8192 bytes app-wide, outside receiver authentication.
// Measure the complete delivery after JSON escaping, well below that threshold.
const MAX_CHANNEL_BYTES: usize = 4096;
const OVERSIZED_ERROR: &str = "Dialog operation failed; error details exceeded the delivery limit.";

struct DialogKindSpec {
    maximizable: bool,
    resizable: bool,
    title: &'static str,
    size: (f64, f64),
    min_size: (f64, f64),
}
fn kind_spec(kind: &str) -> Result<DialogKindSpec, String> {
    match kind {
        "pageSize" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: false,
            title: "Custom Page Size",
            size: (420.0, 300.0),
            min_size: (360.0, 260.0),
        }),
        "arrangementSpacing" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Adjust arrangement spacing",
            size: (540.0, 600.0),
            min_size: (360.0, 260.0),
        }),
        "insertTable" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Insert Table",
            size: (480.0, 420.0),
            min_size: (420.0, 360.0),
        }),
        "export" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Export",
            size: (520.0, 620.0),
            min_size: (420.0, 360.0),
        }),
        "engineInstall" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Engine installation",
            size: (520.0, 480.0),
            min_size: (420.0, 380.0),
        }),
        "toolInstall" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Tool installation",
            size: (520.0, 460.0),
            min_size: (420.0, 380.0),
        }),
        _ => Err("Unknown dialog kind".into()),
    }
}
fn native_window_title(kind: &str, spec_title: &str, snapshot_title: &str) -> String {
    if kind == "engineInstall" || kind == "toolInstall" {
        snapshot_title.to_string()
    } else {
        format!("{spec_title} — {snapshot_title}")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Message {
    protocol_version: u32,
    owner_window_id: String,
    document_tab_id: String,
    dialog_kind: String,
    session_id: String,
    request_id: String,
    snapshot_revision: u64,
    #[serde(rename = "type")]
    message_type: String,
    data: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    title: String,
    width: f64,
    height: f64,
    unit: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Apply {
        width: f64,
        height: f64,
        unit: String,
    },
    Cancel,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InsertTableSnapshot {
    title: String,
    rows: u32,
    columns: u32,
    header_rows: u32,
    preset: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum InsertTableAction {
    Apply {
        rows: u32,
        columns: u32,
        #[serde(rename = "headerRows")]
        header_rows: u32,
        preset: String,
    },
    Cancel,
}
fn valid_table_options(rows: u32, columns: u32, header_rows: u32, preset: &str) -> bool {
    (1..=500).contains(&rows)
        && (1..=64).contains(&columns)
        && header_rows <= rows
        && matches!(preset, "three-line" | "grid")
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpacingSnapshot {
    title: String,
    min_percent: u32,
    max_percent: u32,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum SpacingAction {
    Apply { percent: u32 },
    Preview { percent: u32 },
    Cancel,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpacingPreview {
    percent: u32,
    index: usize,
    count: usize,
    chunk: String,
    error: Option<String>,
}
fn valid_percent(percent: u32) -> bool {
    (25..=150).contains(&percent)
}
fn valid_title(title: &str) -> bool {
    !title.is_empty() && title.encode_utf16().count() <= 256
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    status: String,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EngineInstallSnapshot {
    title: String,
    engine_name: String,
    plugin_name: String,
    plugin_id: String,
    disclosure: String,
    required_disk_bytes: u64,
    free_disk_bytes: u64,
    state: EngineInstallState,
    buttons: Vec<String>,
}
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
enum EngineInstallState {
    NotInstalled {},
    Installed {},
    Broken {
        detail: String,
    },
    Failed {
        message: String,
    },
    Installing {
        phase: String,
        step: u32,
        steps: u32,
        #[serde(rename = "bytesDone")]
        bytes_done: u64,
        #[serde(rename = "bytesTotal")]
        bytes_total: u64,
        estimated: bool,
    },
}
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
impl EngineInstallSnapshot {
    fn valid(&self) -> bool {
        let fields = [
            (&self.title, 256),
            (&self.engine_name, 80),
            (&self.plugin_name, 128),
            (&self.plugin_id, 256),
            (&self.disclosure, 1024),
        ];
        if fields
            .iter()
            .any(|(s, max)| s.is_empty() || !bounded_text(s, *max))
            || self.required_disk_bytes > MAX_SAFE_INTEGER
            || self.free_disk_bytes > MAX_SAFE_INTEGER
        {
            return false;
        }
        let valid_state = match &self.state {
            EngineInstallState::NotInstalled {} | EngineInstallState::Installed {} => true,
            EngineInstallState::Broken { detail } => bounded_text(detail, 1024),
            EngineInstallState::Failed { message } => bounded_text(message, 1024),
            EngineInstallState::Installing {
                phase,
                step,
                steps,
                bytes_done,
                bytes_total,
                estimated,
            } => {
                let _ = estimated;
                bounded_text(phase, 128)
                    && *step >= 1
                    && step <= steps
                    && *steps <= 32
                    && *bytes_done <= MAX_SAFE_INTEGER
                    && *bytes_total <= MAX_SAFE_INTEGER
            }
        };
        let buttons: &[&str] = match self.state {
            EngineInstallState::Installing { .. } => &["cancelInstall", "close"],
            EngineInstallState::Installed {} | EngineInstallState::Failed { .. } => &["close"],
            _ => &["install", "close"],
        };
        valid_state && self.buttons == buttons
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum EngineInstallAction {
    Install {},
    CancelInstall {},
    Close {},
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolInstallSnapshot {
    title: String,
    tool_name: String,
    publisher: String,
    version: String,
    download_host: String,
    download_bytes: u64,
    plugin_name: String,
    plugin_id: String,
    disclosure: String,
    required_disk_bytes: u64,
    free_disk_bytes: Option<u64>,
    state: ToolInstallState,
    buttons: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_present_intent")]
    intent: Option<String>,
}
// Omission is allowed, but a present intent must be a string, never null.
fn deserialize_present_intent<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
enum ToolInstallState {
    NotInstalled {},
    Consent {},
    Installed {},
    Installing {
        phase: String,
        #[serde(rename = "bytesDone")]
        bytes_done: Option<u64>,
        #[serde(rename = "bytesTotal")]
        bytes_total: Option<u64>,
    },
    Failed {
        message: String,
    },
    Broken {
        detail: String,
    },
}
impl ToolInstallSnapshot {
    fn valid(&self) -> bool {
        let fields = [
            (&self.title, 256),
            (&self.tool_name, 80),
            (&self.publisher, 80),
            (&self.version, 40),
            (&self.download_host, 128),
            (&self.plugin_name, 128),
            (&self.plugin_id, 256),
            (&self.disclosure, 1024),
        ];
        if fields
            .iter()
            .any(|(s, max)| s.is_empty() || !bounded_text(s, *max))
            || self.download_bytes > MAX_SAFE_INTEGER
            || self.required_disk_bytes > MAX_SAFE_INTEGER
            || self.free_disk_bytes.is_some_and(|n| n > MAX_SAFE_INTEGER)
            || self
                .intent
                .as_deref()
                .is_some_and(|intent| !matches!(intent, "download" | "update" | "use"))
        {
            return false;
        }
        let valid_state = match &self.state {
            ToolInstallState::NotInstalled {}
            | ToolInstallState::Consent {}
            | ToolInstallState::Installed {} => true,
            ToolInstallState::Failed { message } => bounded_text(message, 1024),
            ToolInstallState::Broken { detail } => bounded_text(detail, 1024),
            ToolInstallState::Installing {
                phase,
                bytes_done,
                bytes_total,
            } => {
                bounded_text(phase, 128)
                    && bytes_done.is_none_or(|n| n <= MAX_SAFE_INTEGER)
                    && bytes_total.is_none_or(|n| n <= MAX_SAFE_INTEGER)
            }
        };
        let buttons: &[&str] = match self.state {
            ToolInstallState::NotInstalled {}
            | ToolInstallState::Failed { .. }
            | ToolInstallState::Broken { .. } => &["install", "close"],
            ToolInstallState::Consent {} => &["allow", "close"],
            ToolInstallState::Installing { .. } => &["cancelInstall", "close"],
            ToolInstallState::Installed {} => &["close"],
        };
        valid_state && self.buttons == buttons
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum ToolInstallAction {
    Install {},
    Allow {},
    CancelInstall {},
    Close {},
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportOptions {
    format: String,
    filename: String,
    destination_path: Option<String>,
    svg: SvgOptions,
    pdf: PdfOptions,
    raster: RasterOptions,
    cdxml: CdxmlOptions,
    presentation: Option<PresentationOptions>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresentationOptions {
    width: f64,
    height: Option<f64>,
    #[serde(rename = "linked")]
    _linked: Option<bool>,
    preset: Option<String>,
    dpi: f64,
    crop: String,
    background: String,
}
impl PresentationOptions {
    fn valid(&self) -> bool {
        (1.0..=8192.0).contains(&self.width)
            && self.width.fract() == 0.0
            && self
                .height
                .is_none_or(|n| (1.0..=8192.0).contains(&n) && n.fract() == 0.0)
            && self
                .preset
                .as_ref()
                .is_none_or(|s| matches!(s.as_str(), "custom" | "slide" | "poster" | "publication"))
            && (36.0..=1200.0).contains(&self.dpi)
            && matches!(self.crop.as_str(), "page" | "content")
            && matches!(self.background.as_str(), "white" | "transparent")
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrameSize {
    width: f64,
    height: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportFrame {
    revision: Option<u64>,
    page: FrameSize,
    content: FrameSize,
}
impl ExportFrame {
    fn valid(&self) -> bool {
        self.revision
            .is_none_or(|n| n > 0 && n <= 9_007_199_254_740_991)
            && [&self.page, &self.content]
                .iter()
                .all(|s| valid_size(s.width, s.height, "css-px"))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    url: String,
    kind: String,
    width: f64,
    height: f64,
    warnings: Vec<String>,
}
impl Preview {
    fn valid(&self) -> bool {
        let prefix = if self.kind == "pdf" {
            "data:application/pdf;base64,"
        } else if self.kind == "image" && self.url.starts_with("data:image/png;base64,") {
            "data:image/png;base64,"
        } else if self.kind == "image" && self.url.starts_with("data:image/svg+xml;base64,") {
            "data:image/svg+xml;base64,"
        } else if self.kind == "image" {
            "data:image/jpeg;base64,"
        } else {
            return false;
        };
        self.url.strip_prefix(prefix).is_some_and(|s| {
            s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
        }) && (0.0..=8192.0).contains(&self.width)
            && self.width > 0.0
            && (0.0..=8192.0).contains(&self.height)
            && self.height > 0.0
            && self.warnings.len() <= 100
            && self.warnings.iter().all(|s| bounded_text(s, 2048))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrameReceipt {
    status: String,
    frame: ExportFrame,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewReceipt {
    status: String,
    preview: Preview,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SvgOptions {
    include_warnings: bool,
    include_page_guides: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PdfOptions {
    compress: bool,
    include_page_guides: bool,
    page: String,
    pdf_type: String,
    background: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RasterOptions {
    scale: f64,
    background: String,
    jpeg_quality: f64,
    max_dimension_px: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CdxmlOptions {
    creation_program: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportSnapshot {
    title: String,
    options: ExportOptions,
    frame: Option<ExportFrame>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum ExportAction {
    Export { options: ExportOptions },
    ChooseDestination { options: ExportOptions },
    Preview { options: ExportOptions },
    Cancel,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportReceipt {
    status: String,
    error: Option<String>,
    notice: Option<String>,
    destination_path: Option<String>,
    filename: Option<String>,
}
fn bounded_text(text: &str, max: usize) -> bool {
    text.encode_utf16().count() <= max && !text.contains('\0')
}
impl ExportOptions {
    fn valid(&self) -> bool {
        // Reading the bool fields documents that both values are accepted after typed decoding.
        let _ = (
            self.svg.include_warnings,
            self.svg.include_page_guides,
            self.pdf.compress,
            self.pdf.include_page_guides,
        );
        matches!(
            self.format.as_str(),
            "svg"
                | "pdf"
                | "png"
                | "jpeg"
                | "bmp"
                | "gif"
                | "tiff"
                | "eps"
                | "mol"
                | "mol-v2000"
                | "sdf"
                | "sdf-v2000"
                | "rxn"
                | "rxn-v2000"
                | "cml"
                | "smiles"
                | "connection-table"
                | "rdf"
                | "rdf-v2000"
                | "cdxml"
                | "cdx"
                | "chemdraw-stationery"
                | "chemdraw-3x"
                | "tgf"
                | "isis-skc"
                | "msi-chemnote"
                | "smd-42"
                | "3mf-display"
                | "3mf-printing"
        ) && self
            .presentation
            .as_ref()
            .is_none_or(PresentationOptions::valid)
            && bounded_text(&self.filename, 256)
            && !self.filename.trim().is_empty()
            && !self.filename.contains(['/', '\\'])
            && self
                .destination_path
                .as_ref()
                .is_none_or(|p| bounded_text(p, 1024))
            && self.pdf.page == "current"
            && self.pdf.pdf_type == "vector"
            && self.pdf.background == "white"
            && self.raster.scale.is_finite()
            && (1.0..=4.0).contains(&self.raster.scale)
            && matches!(self.raster.background.as_str(), "white" | "transparent")
            && self.raster.jpeg_quality.is_finite()
            && (1.0..=100.0).contains(&self.raster.jpeg_quality)
            && self.raster.max_dimension_px.is_finite()
            && (1.0..=8192.0).contains(&self.raster.max_dimension_px)
            && bounded_text(&self.cdxml.creation_program, 256)
    }
}
fn valid_export_optionals(data: &Value) -> bool {
    data.get("presentation").is_none_or(|p| {
        p.is_object()
            && p.get("height").is_none_or(Value::is_number)
            && p.get("linked").is_none_or(Value::is_boolean)
            && p.get("preset").is_none_or(Value::is_string)
    })
}
fn optional_string_fields(data: &Value, names: &[&str]) -> bool {
    names
        .iter()
        .all(|name| data.get(name).is_none_or(Value::is_string))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Closed {
    reason: String,
}

fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn valid_size(width: f64, height: f64, unit: &str) -> bool {
    width.is_finite()
        && height.is_finite()
        && width > 0.0
        && height > 0.0
        && width <= 100000.0
        && height <= 100000.0
        && matches!(unit, "inch" | "mm" | "css-px")
}
fn valid_reason(reason: &str) -> bool {
    matches!(
        reason,
        "apply"
            | "cancel"
            | "close"
            | "destroy"
            | "ownerTabClose"
            | "ownerClose"
            | "quit"
            | "error"
    )
}
impl Message {
    fn is_preview(&self) -> bool {
        self.dialog_kind == "export"
            && self.message_type == "result"
            && self.data["status"] == "preview"
    }
    fn validate(&self) -> Result<(), String> {
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len()
            > if self.is_preview() {
                MAX_PREVIEW_BYTES
            } else {
                MAX_BYTES
            }
            || self.protocol_version != 1
            || self.owner_window_id != super::MAIN_WINDOW_LABEL
            || kind_spec(&self.dialog_kind).is_err()
            || !token(&self.document_tab_id)
            || !token(&self.session_id)
            || !token(&self.request_id)
            || self.snapshot_revision == 0
            || self.snapshot_revision > 9_007_199_254_740_991
            || ((self.dialog_kind == "engineInstall" || self.dialog_kind == "toolInstall")
                && serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 3400)
        {
            return Err("Invalid dialog envelope or payload limit exceeded".into());
        }
        let valid = match self.message_type.as_str() {
            "snapshot" if self.dialog_kind == "insertTable" => {
                serde_json::from_value::<InsertTableSnapshot>(self.data.clone()).is_ok_and(|s| {
                    valid_title(&s.title)
                        && valid_table_options(s.rows, s.columns, s.header_rows, &s.preset)
                })
            }
            "action" if self.dialog_kind == "insertTable" => serde_json::from_value::<
                InsertTableAction,
            >(self.data.clone())
            .is_ok_and(|a| match a {
                InsertTableAction::Cancel => true,
                InsertTableAction::Apply {
                    rows,
                    columns,
                    header_rows,
                    preset,
                } => valid_table_options(rows, columns, header_rows, &preset),
            }),
            "snapshot" if self.dialog_kind == "engineInstall" => {
                serde_json::from_value::<EngineInstallSnapshot>(self.data.clone())
                    .is_ok_and(|s| s.valid())
            }
            "snapshot" if self.dialog_kind == "toolInstall" => {
                serde_json::from_value::<ToolInstallSnapshot>(self.data.clone())
                    .is_ok_and(|s| s.valid())
            }
            "action" if self.dialog_kind == "engineInstall" => {
                serde_json::from_value::<EngineInstallAction>(self.data.clone()).is_ok()
            }
            "action" if self.dialog_kind == "toolInstall" => {
                serde_json::from_value::<ToolInstallAction>(self.data.clone()).is_ok()
            }
            "result"
                if self.dialog_kind == "engineInstall" || self.dialog_kind == "toolInstall" =>
            {
                serde_json::from_value::<Receipt>(self.data.clone()).is_ok_and(|r| {
                    matches!(r.status.as_str(), "accepted" | "cancelled" | "error")
                        && optional_string_fields(&self.data, &["error"])
                        && r.error.is_none_or(|s| s.encode_utf16().count() <= 1024)
                })
            }
            "snapshot" if self.dialog_kind == "export" => {
                serde_json::from_value::<ExportSnapshot>(self.data.clone()).is_ok_and(|s| {
                    !s.title.is_empty()
                        && s.title.encode_utf16().count() <= 256
                        && s.options.valid()
                        && valid_export_optionals(&self.data["options"])
                        && s.frame.as_ref().is_none_or(ExportFrame::valid)
                        && self.data["frame"].get("revision").is_none_or(Value::is_u64)
                        && self.data.get("frame").is_none_or(Value::is_object)
                        && optional_string_fields(&self.data["options"], &["destinationPath"])
                })
            }
            "action" if self.dialog_kind == "export" => {
                serde_json::from_value::<ExportAction>(self.data.clone()).is_ok_and(|a| match a {
                    ExportAction::Cancel => true,
                    ExportAction::Export { options }
                    | ExportAction::ChooseDestination { options }
                    | ExportAction::Preview { options } => {
                        options.valid()
                            && valid_export_optionals(&self.data["options"])
                            && optional_string_fields(&self.data["options"], &["destinationPath"])
                    }
                })
            }
            "result" if self.dialog_kind == "export" && self.data["status"] == "frame" => {
                serde_json::from_value::<FrameReceipt>(self.data.clone()).is_ok_and(|r| {
                    r.status == "frame"
                        && r.frame.valid()
                        && self.data["frame"].get("revision").is_none_or(Value::is_u64)
                })
            }
            "result" if self.is_preview() => {
                serde_json::from_value::<PreviewReceipt>(self.data.clone())
                    .is_ok_and(|r| r.status == "preview" && r.preview.valid())
            }
            "result" if self.dialog_kind == "export" => {
                serde_json::from_value::<ExportReceipt>(self.data.clone()).is_ok_and(|r| {
                    matches!(
                        r.status.as_str(),
                        "accepted" | "progress" | "picked" | "exported" | "cancelled" | "error"
                    ) && optional_string_fields(
                        &self.data,
                        &["error", "notice", "destinationPath", "filename"],
                    ) && r.error.is_none_or(|s| s.encode_utf16().count() <= 2048)
                        && r.notice.is_none_or(|s| s.encode_utf16().count() <= 1024)
                        && r.destination_path.is_none_or(|s| bounded_text(&s, 1024))
                        && r.filename.is_none_or(|s| s.encode_utf16().count() <= 256)
                })
            }
            "snapshot" => {
                if self.dialog_kind == "pageSize" {
                    serde_json::from_value::<Snapshot>(self.data.clone()).is_ok_and(|s| {
                        valid_title(&s.title) && valid_size(s.width, s.height, &s.unit)
                    })
                } else {
                    serde_json::from_value::<SpacingSnapshot>(self.data.clone()).is_ok_and(|s| {
                        valid_title(&s.title)
                            && valid_percent(s.min_percent)
                            && valid_percent(s.max_percent)
                            && s.min_percent <= 100
                            && s.max_percent >= 100
                    })
                }
            }
            "action" => {
                if self.dialog_kind == "pageSize" {
                    serde_json::from_value::<Action>(self.data.clone()).is_ok_and(|a| match a {
                        Action::Cancel => true,
                        Action::Apply {
                            width,
                            height,
                            unit,
                        } => valid_size(width, height, &unit),
                    })
                } else {
                    serde_json::from_value::<SpacingAction>(self.data.clone()).is_ok_and(
                        |a| match a {
                            SpacingAction::Cancel => true,
                            SpacingAction::Apply { percent }
                            | SpacingAction::Preview { percent } => valid_percent(percent),
                        },
                    )
                }
            }
            "preview" => {
                self.dialog_kind == "arrangementSpacing"
                    && serde_json::from_value::<SpacingPreview>(self.data.clone()).is_ok_and(|p| {
                        valid_percent(p.percent)
                            && p.count > 0
                            && p.count <= 1024
                            && p.index < p.count
                            && p.chunk.len() <= 2000
                            && p.chunk.bytes().all(|c| {
                                c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')
                            })
                            && self.data.get("error").is_none_or(|e| e.is_string())
                            && p.error.is_none_or(|e| {
                                e.encode_utf16().count() <= 256
                                    && p.chunk.is_empty()
                                    && p.index == 0
                                    && p.count == 1
                            })
                    })
            }
            "request" | "ready" => self.data.as_object().is_some_and(|d| d.is_empty()),
            "result" => serde_json::from_value::<Receipt>(self.data.clone()).is_ok_and(|r| {
                matches!(
                    r.status.as_str(),
                    "accepted" | "applied" | "cancelled" | "error"
                ) && self.data.get("error").is_none_or(|e| e.is_string())
                    && r.error.is_none_or(|e| e.encode_utf16().count() <= 2048)
            }),
            "closed" => serde_json::from_value::<Closed>(self.data.clone())
                .is_ok_and(|c| valid_reason(&c.reason)),
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err("Invalid dialog kind payload".into())
        }
    }
    fn same_session(&self, other: &Self) -> bool {
        self.owner_window_id == other.owner_window_id
            && self.document_tab_id == other.document_tab_id
            && self.dialog_kind == other.dialog_kind
            && self.session_id == other.session_id
            && self.snapshot_revision == other.snapshot_revision
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Registration {
    host_id: String,
    window_label: String,
}
struct Session {
    registration: Registration,
    snapshot: Message,
    ready: bool,
    owner_channel: Option<Channel<Value>>,
    host_channel: Option<Channel<Value>>,
    terminal_request: Option<String>,
    // Request IDs are scoped to a session and bounded; a sender cannot grow this without limit.
    actions: HashMap<String, Message>,
    receipts: HashMap<String, Message>,
    transient_until: Instant,
    pending_move: Option<(Instant, SavedPosition)>,
}
#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Session>,
    next_slot: u64,
}
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

pub(crate) fn is_dialog_label(label: &str) -> bool {
    label
        .strip_prefix("dialog-main-")
        .and_then(|s| s.split_once('-'))
        .is_some_and(|(kind, slot)| {
            kind_spec(kind).is_ok()
                && !slot.is_empty()
                && slot.len() <= 20
                && slot.bytes().all(|c| c.is_ascii_digit())
        })
}
fn authorize(
    session: &Session,
    sender: &str,
    owner: bool,
    message: Option<&Message>,
) -> Result<(), String> {
    let expected = if owner {
        &session.snapshot.owner_window_id
    } else {
        &session.registration.window_label
    };
    if sender != expected || message.is_some_and(|m| !m.same_session(&session.snapshot)) {
        return Err(
            "Dialog caller, session, or revision does not match its registered native window"
                .into(),
        );
    }
    Ok(())
}
fn delivery(session: &Session, sender: &str, message: &Message) -> Result<Value, String> {
    let mut payload = json!({ "senderWindowId": sender, "windowLabel": session.registration.window_label, "message": message });
    let serialized_size = |value: &Value| {
        serde_json::to_vec(value)
            .map(|bytes| bytes.len())
            .map_err(|e| e.to_string())
    };
    if serialized_size(&payload)? > MAX_CHANNEL_BYTES
        && message.message_type == "result"
        && message.data.get("error").is_some_and(Value::is_string)
    {
        payload["message"]["data"]["error"] = json!(OVERSIZED_ERROR);
    }
    // Recheck after replacement: an oversized envelope or a future kind must fail closed.
    if serialized_size(&payload)? > MAX_CHANNEL_BYTES {
        return Err("Dialog channel delivery limit exceeded".into());
    }
    Ok(payload)
}
fn send_owner(session: &Session, sender: &str, message: &Message) -> Result<(), String> {
    session
        .owner_channel
        .as_ref()
        .ok_or("Dialog owner channel missing")?
        .send(delivery(session, sender, message)?)
        .map_err(|e| e.to_string())
}
// Tauri 2 sends JSON >=8192 bytes through an app-wide fetch queue keyed by sequential IDs.
// Keep document previews on the authenticated window's direct channel, rather than exposing
// their contents through that queue. Pack by JSON-escaped UTF-8 bytes (not character count).
const PREVIEW_CHUNK_TEXT_BYTES: usize = 7168;
const PREVIEW_CHANNEL_BYTES: usize = 8191;
fn preview_delivery_chunks(text: &str, request_id: &str) -> Vec<Value> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut encoded_bytes = 0;
    for ch in text.chars() {
        let cost = match ch {
            '\"' | '\\' | '\n' | '\r' | '\t' | '\u{0008}' | '\u{000c}' => 2,
            ch if ch <= '\u{001f}' => 6,
            ch => ch.len_utf8(),
        };
        if encoded_bytes + cost > PREVIEW_CHUNK_TEXT_BYTES {
            parts.push(std::mem::take(&mut part));
            encoded_bytes = 0;
        }
        part.push(ch);
        encoded_bytes += cost;
    }
    if !part.is_empty() {
        parts.push(part);
    }
    let total = parts.len();
    parts.into_iter().enumerate().map(|(index, text)| json!({ "previewChunk": { "requestId": request_id, "index": index, "total": total, "text": text } })).collect()
}
fn send_host(session: &Session, message: &Message) -> Result<(), String> {
    if message.is_preview() {
        let text = serde_json::to_string(&json!({ "senderWindowId": super::MAIN_WINDOW_LABEL, "windowLabel": session.registration.window_label, "message": message })).map_err(|e| e.to_string())?;
        let channel = session
            .host_channel
            .as_ref()
            .ok_or("Dialog host channel missing")?;
        // Keep each authenticated private-channel delivery below Tauri's app-wide queue threshold.
        for chunk in preview_delivery_chunks(&text, &message.request_id) {
            if serde_json::to_vec(&chunk).map_err(|e| e.to_string())?.len() > PREVIEW_CHANNEL_BYTES
            {
                return Err("Preview channel chunk limit exceeded".into());
            }
            channel.send(chunk).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    session
        .host_channel
        .as_ref()
        .ok_or("Dialog host channel missing")?
        .send(delivery(session, super::MAIN_WINDOW_LABEL, message)?)
        .map_err(|e| e.to_string())
}
/// Reserve before forwarding: request-ID dedup alone cannot prevent two distinct Apply requests.
fn reserve_action(session: &mut Session, message: &Message) -> Result<bool, String> {
    if message.dialog_kind == "arrangementSpacing" && message.data["action"] == "preview" {
        return if session.terminal_request.is_none() {
            Ok(true)
        } else {
            Err("A terminal dialog action is already pending".into())
        };
    }
    if let Some(previous) = session.actions.get(&message.request_id) {
        if previous.data != message.data {
            return Err("A dialog request ID cannot be reused for another action".into());
        }
        return Ok(false);
    }
    if message.data["action"] == "preview" {
        if session.terminal_request.is_some() {
            return Ok(false);
        }
        session.actions.retain(|_, m| m.data["action"] != "preview");
        session
            .receipts
            .retain(|id, _| session.actions.contains_key(id));
        session
            .actions
            .insert(message.request_id.clone(), message.clone());
        return Ok(true);
    }
    if message.dialog_kind == "engineInstall" || message.dialog_kind == "toolInstall" {
        let action = message.data["action"].as_str().unwrap_or_default();
        if !session.snapshot.data["buttons"]
            .as_array()
            .is_some_and(|buttons| buttons.iter().any(|button| button == action))
        {
            return Err("Engine installation action is unavailable".into());
        }
    }
    let cancelling = matches!(
        message.data["action"].as_str(),
        Some("cancel" | "cancelInstall" | "close")
    );
    // Closing must bypass pending work and the retry limit, while still reserving the session.
    if session.terminal_request.is_some() && !cancelling {
        return Err("A terminal dialog action is already pending".into());
    }
    if session.actions.len() >= 128 && !cancelling {
        return Err("Dialog action limit exceeded".into());
    }
    session.terminal_request = Some(message.request_id.clone());
    session
        .actions
        .insert(message.request_id.clone(), message.clone());
    Ok(true)
}

fn update_snapshot(session: &mut Session, message: &Message) {
    // A failed tool install offers Retry in the same window. Its previous Install
    // reservation must end before a new request ID can be accepted.
    if message.dialog_kind == "toolInstall"
        && matches!(
            message.data["state"]["status"].as_str(),
            Some("failed" | "broken")
        )
    {
        session.terminal_request = None;
    }
    session.snapshot = message.clone();
}

fn register(
    registry: &mut Registry,
    message: Message,
    quitting: bool,
) -> Result<(Registration, bool), String> {
    if quitting {
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    message.validate()?;
    if message.message_type != "snapshot" {
        return Err("A dialog opens with a snapshot".into());
    }
    if let Some(session) = registry
        .sessions
        .values()
        .find(|s| s.snapshot.same_session(&message))
    {
        return Ok((session.registration.clone(), false));
    }
    if registry.sessions.len() >= 16 {
        return Err("Too many dialog windows are open".into());
    }
    if registry.sessions.values().any(|s| {
        s.snapshot.document_tab_id == message.document_tab_id
            && s.snapshot.dialog_kind == message.dialog_kind
    }) {
        return Err("A dialog for this drawing is already open".into());
    }
    registry.next_slot += 1;
    let registration = Registration {
        host_id: format!("h{:016x}", registry.next_slot),
        window_label: format!("dialog-main-{}-{}", message.dialog_kind, registry.next_slot),
    };
    registry.sessions.insert(
        registration.host_id.clone(),
        Session {
            registration: registration.clone(),
            snapshot: message,
            ready: false,
            owner_channel: None,
            host_channel: None,
            terminal_request: None,
            actions: HashMap::new(),
            receipts: HashMap::new(),
            transient_until: Instant::now() + Duration::from_millis(500),
            pending_move: None,
        },
    );
    Ok((registration, true))
}

/// Async, serialized, worker construction. Never take WINDOW_CREATION on the event thread.
#[tauri::command]
pub(crate) async fn dialog_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    message: Message,
    channel: Channel<Value>,
) -> Result<Registration, String> {
    if window.label() != super::MAIN_WINDOW_LABEL
        || app.get_webview_window(super::MAIN_WINDOW_LABEL).is_none()
    {
        return Err("Unknown dialog owner".into());
    }
    let _creation = super::lock_window_creation()?;
    if !window.is_visible().unwrap_or(false) {
        return Err("The document window is hidden; no dialog can open".into());
    }
    let (registration, build) = register(
        &mut REGISTRY.lock().unwrap_or_else(|p| p.into_inner()),
        message.clone(),
        super::quit_in_progress(),
    )?;
    let ready = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let session = registry
            .sessions
            .get_mut(&registration.host_id)
            .ok_or("Unknown dialog host")?;
        session.owner_channel = Some(channel);
        session.ready
            && (session.snapshot.dialog_kind == "engineInstall"
                || session.snapshot.dialog_kind == "toolInstall"
                || session.terminal_request.is_none()
                || session
                    .terminal_request
                    .as_ref()
                    .and_then(|id| session.receipts.get(id))
                    .is_some_and(|r| r.data["status"] == "exported"))
    };
    if !build {
        if ready {
            if let Some(target) = app.get_webview_window(&registration.window_label) {
                super::run_on_main_thread_blocking(&window, move || show_on_main(&target))
                    .and_then(|result| result)?;
            }
        }
        return Ok(registration);
    }
    let spec = kind_spec(&message.dialog_kind)?;
    let title = message.data["title"]
        .as_str()
        .ok_or("Dialog title missing")?;
    let builder = WebviewWindowBuilder::new(
        &app,
        &registration.window_label,
        WebviewUrl::App(format!("/?window=dialog&hostId={}", registration.host_id).into()),
    )
    .title(native_window_title(&message.dialog_kind, spec.title, title))
    .inner_size(spec.size.0, spec.size.1)
    .min_inner_size(spec.min_size.0, spec.min_size.1)
    .visible(false)
    .focused(false)
    .focusable(true)
    .skip_taskbar(true)
    .shadow(true)
    .decorations(true)
    .maximizable(spec.maximizable)
    .resizable(spec.resizable)
    .minimizable(false);
    // On Windows .parent is a top-level OWNER, never a child control. macOS stays unparented.
    #[cfg(windows)]
    let builder = builder.parent(&window).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let builder = builder;
    let dialog_window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            REGISTRY
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .sessions
                .remove(&registration.host_id);
            return Err(format!(
                "Could not create native {} window: {error}",
                spec.title
            ));
        }
    };
    super::disable_default_context_menus(&dialog_window);
    // Owner close/quit does not wait on the construction lock. Discard a late build whose
    // registered session was already settled, rather than leaving an orphan hidden webview.
    if !REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .contains_key(&registration.host_id)
    {
        if let Some(window) = app.get_webview_window(&registration.window_label) {
            let _ = window.destroy();
        }
        return Err("Dialog owner closed during window creation".into());
    }
    if super::quit_in_progress() {
        close_session(&app, &registration.host_id, "quit");
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    Ok(registration)
}

#[tauri::command]
pub(crate) fn dialog_request(
    window: tauri::WebviewWindow,
    host_id: String,
    protocol_version: u32,
    request_id: String,
    channel: Channel<Value>,
) -> Result<(), String> {
    if protocol_version != 1 || !token(&request_id) || !token(&host_id) {
        return Err("Invalid dialog bootstrap request".into());
    }
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let session = registry
        .sessions
        .get_mut(&host_id)
        .ok_or("Unknown dialog host")?;
    authorize(session, window.label(), false, None)?;
    session.snapshot.validate()?;
    // This channel belongs to the actual calling dialog, not to a payload label.
    session.host_channel = Some(channel);
    send_host(session, &session.snapshot)?;
    let mut request = session.snapshot.clone();
    request.message_type = "request".into();
    request.request_id = request_id;
    request.data = json!({});
    send_owner(session, window.label(), &request)
}

#[tauri::command]
pub(crate) async fn dialog_send(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host_id: String,
    message: Message,
) -> Result<(), String> {
    message.validate()?;
    if !matches!(message.message_type.as_str(), "ready" | "action") {
        return Err("Dialog can send only ready or a typed action".into());
    }
    let _creation = super::lock_window_creation()?;
    let reveal = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let session = registry
            .sessions
            .get_mut(&host_id)
            .ok_or("Unknown dialog host")?;
        authorize(session, window.label(), false, Some(&message))?;
        let reveal = message.message_type == "ready" && !session.ready;
        if message.message_type == "action" {
            if !session.ready {
                return Err("Dialog is not ready".into());
            }
            if let Some(receipt) = session.receipts.get(&message.request_id) {
                return send_host(session, receipt);
            }
            if !reserve_action(session, &message)? {
                return Ok(());
            }
        }
        if reveal {
            session.ready = true;
        }
        // Only this Rust-validated path can write the owner's private channel.
        send_owner(session, window.label(), &message)?;
        reveal
    };
    // Deliver ready before showing so the owner's listener is authoritative even on a fast click.
    if reveal {
        let target = window.clone();
        if let Err(error) =
            super::run_on_main_thread_blocking(&window, move || reveal_on_main(&target))
                .and_then(|result| result)
        {
            eprintln!("Could not reveal native dialog: {error}");
            close_session(&app, &host_id, "error");
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn dialog_publish(
    window: tauri::WebviewWindow,
    host_id: String,
    message: Message,
) -> Result<(), String> {
    message.validate()?;
    if !matches!(
        message.message_type.as_str(),
        "snapshot" | "preview" | "result"
    ) {
        return Err("Owner can publish only snapshot, preview or result".into());
    }
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let session = registry
        .sessions
        .get_mut(&host_id)
        .ok_or("Unknown dialog host")?;
    authorize(session, window.label(), true, Some(&message))?;
    if message.message_type == "result"
        && message.dialog_kind == "export"
        && message.data["status"] == "frame"
    {
        if session.terminal_request.is_some() {
            return Ok(());
        }
        return send_host(session, &message);
    }
    if message.message_type == "result" {
        if !session.actions.contains_key(&message.request_id) {
            if message.is_preview() {
                return Ok(());
            }
            return Err("Unknown dialog action receipt".into());
        }
        if message.is_preview()
            && session
                .actions
                .get(&message.request_id)
                .is_none_or(|m| m.data["action"] != "preview")
        {
            return Err("Preview receipt does not match a preview action".into());
        }
        // Acceptance and progress never complete a receipt or release its reservation.
        if message.data["status"] == "accepted"
            || (message.dialog_kind == "export" && message.data["status"] == "progress")
        {
            return send_host(session, &message);
        }
        if let Some(previous) = session.receipts.get(&message.request_id) {
            return send_host(session, previous);
        }
        if matches!(
            message.data["status"].as_str(),
            Some("error" | "picked" | "cancelled")
        ) && session.terminal_request.as_ref() == Some(&message.request_id)
        {
            session.terminal_request = None;
        }
        session
            .receipts
            .insert(message.request_id.clone(), message.clone());
    } else if message.message_type == "snapshot" {
        update_snapshot(session, &message);
    }
    send_host(session, &message)
}

#[tauri::command]
pub(crate) async fn dialog_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host_id: String,
    reason: String,
) -> Result<(), String> {
    if !valid_reason(&reason) {
        return Err("Invalid dialog close reason".into());
    }
    {
        let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(session) = registry.sessions.get(&host_id) {
            authorize(session, window.label(), true, None)?;
        } else if window.label() != super::MAIN_WINDOW_LABEL {
            return Err("Unknown dialog owner".into());
        }
    }
    close_session(&app, &host_id, &reason);
    Ok(())
}
fn notify_closed(session: &Session, reason: &str) {
    super::UTILITY_SUSPENSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .closed(&session.registration.window_label);
    let mut closed = session.snapshot.clone();
    closed.message_type = "closed".into();
    closed.data = json!({"reason": reason});
    let _ = send_owner(session, super::MAIN_WINDOW_LABEL, &closed);
}
fn close_session<R: Runtime>(app: &tauri::AppHandle<R>, host_id: &str, reason: &str) {
    let session = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .remove(host_id);
    if let Some(mut session) = session {
        flush_position(app, &mut session);
        notify_closed(&session, reason);
        if let Some(window) = app.get_webview_window(&session.registration.window_label) {
            let _ = window.destroy();
        }
    }
}
pub(crate) fn dismiss_owned<R: Runtime>(app: &tauri::AppHandle<R>, reason: &str) {
    let sessions = std::mem::take(&mut REGISTRY.lock().unwrap_or_else(|p| p.into_inner()).sessions);
    for mut session in sessions.into_values() {
        flush_position(app, &mut session);
        notify_closed(&session, reason);
        if let Some(window) = app.get_webview_window(&session.registration.window_label) {
            let _ = window.destroy();
        }
    }
}

fn reveal_on_main<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if super::quit_in_progress() {
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    place_window(window)?;
    show_on_main(window)
}
/// Main-thread-only, after the document-owned picker has released utility suspension.
pub(crate) fn focus_export_after_picker<R: Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &str,
) -> Result<(), String> {
    if super::quit_in_progress()
        || super::utility_windows_suspended()
        || !super::foreground_belongs_to_app()
    {
        return Ok(());
    }
    let label = export_focus_label(
        &REGISTRY.lock().unwrap_or_else(|p| p.into_inner()),
        session_id,
    );
    if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
        if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true) {
            // Tauri makes the window key on macOS and activates its HWND on Windows.
            window.set_focus().map_err(|e| e.to_string())?;
            bring_to_front_on_main(&window)?;
        }
    }
    Ok(())
}

fn export_focus_label(registry: &Registry, session_id: &str) -> Option<String> {
    registry
        .sessions
        .values()
        .find(|session| {
            session.snapshot.dialog_kind == "export"
                && session.snapshot.session_id == session_id
                && session.ready
        })
        .map(|session| session.registration.window_label.clone())
}

/// Reopening focuses without replacing the draft, resizing, or moving a user-positioned dialog.
fn show_on_main<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if super::quit_in_progress() {
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    if super::utility_windows_suspended() {
        super::UTILITY_SUSPENSION
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .defer_show(window.label().into());
        return Ok(());
    }
    if window
        .app_handle()
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .is_none_or(|owner| !owner.is_visible().unwrap_or(false))
    {
        return Err("Dialog owner is hidden".into());
    }
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    configure_on_main(window)?;
    window.set_focus().map_err(|e| e.to_string())?;
    bring_to_front_on_main(window)
}
/// Called by reveal and by the existing relative-order utility restore (already on main).
pub(crate) fn configure_on_main<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;
        let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let native = unsafe { ptr.as_ref() }.ok_or("Could not access native dialog window")?;
        // AppKit children adopt the document's normal level and deactivate visibility.
        // Stay unparented, like floating toolbars; registry ownership handles dismissal.
        native.setLevel(dialog_window_level());
        // Match floating toolbars: AppKit hides on Cmd-Tab and restores the native order on
        // activation. Explicit suspension hides remain ordered out, so AppKit cannot reveal
        // a dialog over a native prompt; only the guarded shared restore may show it again.
        native.setHidesOnDeactivate(super::toolset_window_hides_on_deactivate());
        native.setCanHide(true);
        native.setIgnoresMouseEvents(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn dialog_window_level() -> objc2_app_kit::NSWindowLevel {
    super::toolset_utility_window_level()
}

/// Reveal/reopen and becoming key raise within the utility level. Restoration only configures
/// traits: raising there would discard the captured dialog/toolbar sibling order.
fn bring_to_front_on_main<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if super::utility_windows_suspended() || !window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut objc2_app_kit::NSWindow;
        let native = unsafe { ptr.as_ref() }.ok_or("Could not access native dialog window")?;
        native.orderFront(None);
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindow, GetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GW_HWNDPREV, HWND_TOP,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, WS_EX_TOPMOST,
        };
        // Both dialogs and toolbars are non-topmost document-owned windows. Insert above the
        // highest visible sibling using its predecessor, preserving the group's global position.
        let siblings: Vec<_> = window
            .app_handle()
            .webview_windows()
            .into_values()
            .filter(|sibling| {
                sibling.label() != window.label()
                    && super::is_suspended_utility_label(sibling.label())
                    && sibling.is_visible().unwrap_or(false)
                    && !sibling.is_minimized().unwrap_or(true)
            })
            .collect();
        if let Some(label) = super::utility_windows_top_to_bottom(&siblings)?.first() {
            let sibling = window
                .app_handle()
                .get_webview_window(label)
                .ok_or("Dialog stacking sibling disappeared")?;
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
            let anchor = sibling.hwnd().map_err(|e| e.to_string())?.0 as _;
            // SAFETY: live top-level HWNDs on the main thread; z-order only, no activation.
            let mut predecessor = unsafe { GetWindow(anchor, GW_HWNDPREV) };
            // Insertion after a topmost foreign window could promote this dialog to topmost.
            // Use the ordinary top of the non-topmost band in that case instead.
            if !predecessor.is_null()
                && unsafe { GetWindowLongPtrW(predecessor, GWL_EXSTYLE) } & WS_EX_TOPMOST as isize
                    != 0
            {
                predecessor = HWND_TOP;
            }
            // Null means the sibling is globally first: HWND_TOP is ordinary, never TOPMOST.
            // This path only runs for an explicitly revealed or active dialog, not restoration.
            if predecessor != hwnd
                && unsafe {
                    SetWindowPos(
                        hwnd,
                        predecessor,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER,
                    )
                } == 0
            {
                return Err(format!(
                    "Could not raise native dialog: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = window;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedPosition {
    monitor: String,
    x: f64,
    y: f64,
    offset_x: f64,
    offset_y: f64,
}
#[derive(Clone, Debug)]
struct WorkArea {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}
impl WorkArea {
    fn from_monitor(m: &tauri::Monitor) -> Self {
        let area = m.work_area();
        let scale = m.scale_factor();
        Self {
            id: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("{},{}", m.position().x, m.position().y)),
            x: f64::from(area.position.x) / scale,
            y: f64::from(area.position.y) / scale,
            width: f64::from(area.size.width) / scale,
            height: f64::from(area.size.height) / scale,
            scale,
        }
    }
    fn clamp(&self, x: f64, y: f64, width: f64, height: f64) -> (f64, f64) {
        // Keep the entire title bar reachable; also keep the whole dialog in the work area if it fits.
        (
            x.clamp(self.x, self.x + (self.width - width).max(0.0)),
            y.clamp(
                self.y,
                self.y + (self.height - height.min(self.height)).max(0.0),
            ),
        )
    }
}
fn position_for(
    saved: Option<&SavedPosition>,
    monitors: &[WorkArea],
    owner: &WorkArea,
    owner_rect: (f64, f64, f64, f64),
    size: (f64, f64),
) -> (f64, f64, f64) {
    if let Some(saved) = saved {
        if let Some(m) = monitors.iter().find(|m| m.id == saved.monitor) {
            let (x, y) = m.clamp(
                m.x + saved.offset_x * (m.width - size.0).max(0.0),
                m.y + saved.offset_y * (m.height - size.1).max(0.0),
                size.0,
                size.1,
            );
            return (x * m.scale, y * m.scale, m.scale);
        }
    }
    let (x, y, width, height) = owner_rect;
    let (x, y) = owner.clamp(
        x + (width - size.0) / 2.0,
        y + (height - size.1) / 2.0,
        size.0,
        size.1,
    );
    (x * owner.scale, y * owner.scale, owner.scale)
}
fn saved_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let folder = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(folder.join("dialog-positions.json"))
}
fn read_positions<R: Runtime>(app: &tauri::AppHandle<R>) -> HashMap<String, SavedPosition> {
    saved_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .filter(|bytes| bytes.len() <= MAX_BYTES)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn place_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let app = window.app_handle();
    let owner = app
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or("Unknown dialog owner")?;
    let monitor = owner
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Document monitor unavailable")?;
    let work = WorkArea::from_monitor(&monitor);
    let monitors: Vec<_> = owner
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(WorkArea::from_monitor)
        .collect();
    let position = owner.inner_position().map_err(|e| e.to_string())?;
    let owner_size = owner.inner_size().map_err(|e| e.to_string())?;
    let frame = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = (
        f64::from(frame.width) / scale,
        f64::from(frame.height) / scale,
    );
    let positions = read_positions(app);
    let kind = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .values()
        .find(|s| s.registration.window_label == window.label())
        .map(|s| s.snapshot.dialog_kind.clone())
        .ok_or("Unknown dialog window")?;
    let spec = kind_spec(&kind)?;
    let saved = positions.get(&kind).filter(|p| {
        [p.x, p.y, p.offset_x, p.offset_y]
            .iter()
            .all(|v| v.is_finite())
    });
    let (x, y, destination_scale) = position_for(
        saved,
        &monitors,
        &work,
        (
            f64::from(position.x) / work.scale,
            f64::from(position.y) / work.scale,
            f64::from(owner_size.width) / work.scale,
            f64::from(owner_size.height) / work.scale,
        ),
        size,
    );
    let destination = saved
        .and_then(|s| monitors.iter().find(|m| m.id == s.monitor))
        .unwrap_or(&work);
    // WM_DPICHANGED runs when moving between Windows monitors. Move first, set the desired
    // client size at the destination DPI, then clamp using the measured final outer frame.
    finish_placement(
        (x, y, destination_scale),
        spec.size,
        destination,
        |x, y| {
            window
                .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
                .map_err(|e| e.to_string())
        },
        |width, height| {
            window
                .set_size(tauri::PhysicalSize::new(width, height))
                .map_err(|e| e.to_string())
        },
        || {
            window
                .outer_size()
                .map(|s| (s.width, s.height))
                .map_err(|e| e.to_string())
        },
    )?;
    mark_transient(window.label());
    Ok(())
}
fn finish_placement(
    (x, y, scale): (f64, f64, f64),
    (client_width, client_height): (f64, f64),
    work: &WorkArea,
    mut move_to: impl FnMut(f64, f64) -> Result<(), String>,
    mut resize: impl FnMut(u32, u32) -> Result<(), String>,
    mut measure: impl FnMut() -> Result<(u32, u32), String>,
) -> Result<(), String> {
    move_to(x, y)?;
    resize(
        (client_width * scale) as u32,
        (client_height * scale) as u32,
    )?;
    let (width, height) = measure()?;
    let (x, y) = work.clamp(
        x / scale,
        y / scale,
        f64::from(width) / scale,
        f64::from(height) / scale,
    );
    move_to(x * scale, y * scale)
}
pub(crate) fn mark_transient(label: &str) {
    if let Some(session) = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .values_mut()
        .find(|s| s.registration.window_label == label)
    {
        session.transient_until = Instant::now() + Duration::from_millis(500);
    }
}
fn should_persist(
    visible: bool,
    minimized: bool,
    expanded: (bool, bool), // (maximized, fullscreen)
    quitting: bool,
    suspended: bool,
    ready: bool,
    transient: bool,
) -> bool {
    visible
        && !minimized
        && !expanded.0
        && !expanded.1
        && !quitting
        && !suspended
        && ready
        && !transient
}
fn persist_move<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let app = window.app_handle();
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let Some(session) = registry
        .sessions
        .values_mut()
        .find(|s| s.registration.window_label == window.label())
    else {
        return;
    };
    if !should_persist(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(true)
            || app
                .get_webview_window(super::MAIN_WINDOW_LABEL)
                .is_none_or(|owner| {
                    owner.is_minimized().unwrap_or(true) || !owner.is_visible().unwrap_or(false)
                }),
        (
            window.is_maximized().unwrap_or(true),
            window.is_fullscreen().unwrap_or(true),
        ),
        super::quit_in_progress(),
        super::utility_windows_suspended(),
        session.ready,
        Instant::now() < session.transient_until,
    ) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    if !super::UTILITY_SUSPENSION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .persist_move(window.label(), (position.x, position.y))
    {
        return;
    }
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let m = WorkArea::from_monitor(&monitor);
    let Ok(size) = window.outer_size() else {
        return;
    };
    let x = f64::from(position.x) / m.scale;
    let y = f64::from(position.y) / m.scale;
    let saved = SavedPosition {
        monitor: m.id,
        x,
        y,
        offset_x: ((x - m.x) / (m.width - f64::from(size.width) / m.scale).max(1.0))
            .clamp(0.0, 1.0),
        offset_y: ((y - m.y) / (m.height - f64::from(size.height) / m.scale).max(1.0))
            .clamp(0.0, 1.0),
    };
    session.pending_move = Some((Instant::now(), saved));
    drop(registry);
    let path = match saved_path(app) {
        Ok(path) => path,
        Err(_) => return,
    };
    // One process-wide worker, with at most one pending notification. No thread per Moved event.
    let _ = POSITION_WORKER.try_send(path);
}

type PositionWrites = Vec<(String, SavedPosition)>;
fn take_pending_positions(registry: &mut Registry) -> PositionWrites {
    let mut moves: Vec<_> = registry
        .sessions
        .values_mut()
        .filter_map(|s| {
            s.pending_move
                .take()
                .map(|(at, saved)| (at, s.snapshot.dialog_kind.clone(), saved))
        })
        .collect();
    // Several tabs can have the same kind open. Persist the most recent genuine move for that
    // kind, rather than letting HashMap iteration choose which position survives the burst.
    moves.sort_by_key(|(at, _, _)| *at);
    moves
        .into_iter()
        .map(|(_, kind, saved)| (kind, saved))
        .collect()
}
fn flush_pending_positions(registry: &Mutex<Registry>, write: impl FnOnce(PositionWrites)) {
    let writes = take_pending_positions(&mut registry.lock().unwrap_or_else(|p| p.into_inner()));
    write(writes);
}
static POSITION_IO: Mutex<()> = Mutex::new(());
static POSITION_WORKER: LazyLock<std::sync::mpsc::SyncSender<std::path::PathBuf>> =
    LazyLock::new(|| {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            debounce_positions(receiver, Duration::from_millis(200), |path| {
                // Serialize final close flushes with worker writes. Take the snapshot under REGISTRY,
                // then release REGISTRY before any file reads or writes.
                let _io = POSITION_IO.lock().unwrap_or_else(|p| p.into_inner());
                flush_pending_positions(&REGISTRY, |writes| write_positions(&path, writes));
            });
        });
        sender
    });
fn debounce_positions(
    receiver: std::sync::mpsc::Receiver<std::path::PathBuf>,
    delay: Duration,
    mut flush: impl FnMut(std::path::PathBuf),
) {
    while let Ok(mut path) = receiver.recv() {
        loop {
            match receiver.recv_timeout(delay) {
                Ok(next) => path = next,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    flush(path);
                    return;
                }
            }
        }
        flush(path);
    }
}
fn write_positions(path: &std::path::Path, writes: PositionWrites) {
    if writes.is_empty() {
        return;
    }
    if path
        .parent()
        .is_some_and(|parent| std::fs::create_dir_all(parent).is_err())
    {
        return;
    }
    let mut positions: HashMap<String, SavedPosition> = std::fs::read(path)
        .ok()
        .filter(|b| b.len() <= MAX_BYTES)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    positions.extend(writes);
    if let Ok(bytes) = serde_json::to_vec(&positions) {
        let _ = std::fs::write(path, bytes);
    }
}
fn flush_position<R: Runtime>(app: &tauri::AppHandle<R>, session: &mut Session) {
    if let Some((_, saved)) = session.pending_move.take() {
        let _io = POSITION_IO.lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(path) = saved_path(app) {
            write_positions(&path, vec![(session.snapshot.dialog_kind.clone(), saved)]);
        }
    }
}

/// Native close/destroy settles even if the renderer crashes or never executes cleanup.
pub(crate) fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if !is_dialog_label(window.label()) {
        return;
    }
    match event {
        WindowEvent::Focused(true) => {
            if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                let target = webview.clone();
                if let Err(error) = super::run_on_main_thread_blocking(&webview, move || {
                    bring_to_front_on_main(&target)
                })
                .and_then(|result| result)
                {
                    eprintln!("Could not raise focused native dialog: {error}");
                }
            }
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
            let key = registry
                .sessions
                .iter()
                .find(|(_, s)| s.registration.window_label == window.label())
                .map(|(k, _)| k.clone());
            let session = key.and_then(|k| registry.sessions.remove(&k));
            drop(registry);
            if let Some(mut session) = session {
                flush_position(window.app_handle(), &mut session);
                notify_closed(
                    &session,
                    if matches!(event, WindowEvent::Destroyed) {
                        "destroy"
                    } else {
                        "close"
                    },
                );
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                persist_move(&webview);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn engine_install_snapshot() -> Message {
        let mut message = snapshot();
        message.dialog_kind = "engineInstall".into();
        message.data = json!({"title":"Naming needs a local engine", "engineName":"Naming engine",
            "pluginName":"Structure names", "pluginId":"org.chemdraft.names", "disclosure":"About 100 MB to download and about 0.3 GB on disk. Runs only on this computer.",
            "requiredDiskBytes":300000000, "freeDiskBytes":1000000000,
            "state":{"status":"notInstalled"}, "buttons":["install","close"]});
        message
    }
    fn tool_install_snapshot() -> Message {
        let mut message = snapshot();
        message.dialog_kind = "toolInstall".into();
        message.data = json!({"title":"Install Claude Code", "toolName":"Claude Code", "publisher":"Anthropic", "version":"2.0.0", "downloadHost":"downloads.example.test", "downloadBytes":125000000,
            "pluginName":"ChemDraft Assistant", "pluginId":"org.chemdraft.assistant", "disclosure":"Use is subject to terms.", "requiredDiskBytes":500000000, "freeDiskBytes":2000000000,
            "state":{"status":"notInstalled"}, "buttons":["install","close"]});
        message
    }
    #[test]
    fn tool_install_accepts_each_intent() {
        for intent in ["download", "update", "use"] {
            let mut message = tool_install_snapshot();
            message.data["intent"] = json!(intent);
            assert!(message.validate().is_ok(), "intent: {intent}");
        }
    }
    #[test]
    fn tool_install_accepts_absent_intent() {
        let message = tool_install_snapshot();
        assert!(message.data.get("intent").is_none());
        assert!(message.validate().is_ok());
    }
    #[test]
    fn tool_install_rejects_invalid_intent() {
        for intent in [json!("unknown"), json!("Update"), json!(""), json!(42)] {
            let mut message = tool_install_snapshot();
            message.data["intent"] = intent.clone();
            assert!(message.validate().is_err(), "intent: {intent}");
        }
    }
    #[test]
    fn tool_install_rejects_null_intent() {
        let mut message = tool_install_snapshot();
        message.data["intent"] = Value::Null;
        assert!(message.validate().is_err());
    }
    #[test]
    fn tool_install_validates_spec_buttons_labels_and_capability_matcher() {
        let message = tool_install_snapshot();
        assert!(message.validate().is_ok());
        let spec = kind_spec("toolInstall").unwrap();
        assert!(spec.resizable);
        assert_eq!(spec.size, (520.0, 460.0));
        assert_eq!(
            native_window_title("toolInstall", spec.title, "Install Claude Code"),
            "Install Claude Code"
        );
        let mut unknown_disk_space = message.clone();
        unknown_disk_space.data["freeDiskBytes"] = Value::Null;
        assert!(unknown_disk_space.validate().is_ok());
        for action in ["install", "allow", "cancelInstall", "close"] {
            let mut valid = message.clone();
            valid.message_type = "action".into();
            valid.data = json!({"action":action});
            assert!(valid.validate().is_ok());
        }
        for (field, value) in [
            ("publisher", json!("")),
            ("version", json!("x".repeat(41))),
            ("downloadBytes", json!(-1)),
            ("freeDiskBytes", json!(-1)),
            ("freeDiskBytes", json!("unknown")),
        ] {
            let mut invalid = message.clone();
            invalid.data[field] = value;
            assert!(invalid.validate().is_err());
        }
        let mut invalid = message.clone();
        invalid.data["state"] = json!({"status":"consent","extra":true});
        assert!(invalid.validate().is_err());
        invalid = message.clone();
        invalid.data["buttons"] = json!(["allow", "install", "close"]);
        assert!(invalid.validate().is_err());
        assert!(is_dialog_label("dialog-main-toolInstall-12"));
        for label in [
            "dialog-main-toolInstall-../main",
            "dialog-main-toolInstall-",
            "dialog-main-toolInstall-12-extra",
        ] {
            assert!(!is_dialog_label(label));
        }
        let capability = include_str!("../capabilities/dialog-host.json");
        assert!(capability.contains("dialog-main-toolInstall-*"));
    }
    #[test]
    fn tool_install_shared_button_contract() {
        let rows: Vec<Value> = serde_json::from_str(include_str!(
            "../../src/dialogs/toolInstallButtonStates.json"
        ))
        .unwrap();
        for row in &rows {
            let expected = row["buttons"].as_array().unwrap();
            let mut reversed = expected.clone();
            reversed.reverse();
            let mut duplicate = expected.clone();
            duplicate.push(json!("close"));
            let candidates = rows.iter().map(|r| r["buttons"].clone()).chain([
                json!([]),
                json!(reversed),
                json!(duplicate),
                json!(["unknown"]),
            ]);
            for buttons in candidates {
                let mut message = tool_install_snapshot();
                message.data["state"] = row["state"].clone();
                message.data["buttons"] = buttons.clone();
                assert_eq!(
                    message.validate().is_ok(),
                    buttons == row["buttons"],
                    "state: {}, buttons: {buttons}",
                    row["state"]
                );
            }
        }
    }
    #[test]
    fn tool_install_failure_releases_reservation_for_retry() {
        let mut registry = Registry::default();
        let mut snapshot = tool_install_snapshot();
        let (registration, _) = register(&mut registry, snapshot.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        let mut action = snapshot.clone();
        action.message_type = "action".into();
        action.data = json!({"action":"install"});
        assert!(reserve_action(session, &action).unwrap());
        let original_action = action.clone();
        action.request_id = "retry".into();
        assert!(reserve_action(session, &action).is_err());
        snapshot.data["state"] = json!({"status":"failed","message":"Download failed"});
        assert!(snapshot.validate().is_ok());
        update_snapshot(session, &snapshot);
        assert!(reserve_action(session, &action).unwrap());
        assert!(!reserve_action(session, &original_action).unwrap());
        assert!(!reserve_action(session, &action).unwrap());
    }
    #[test]
    fn engine_install_registration_validation_ownership_and_limits() {
        let message = engine_install_snapshot();
        assert!(message.validate().is_ok());
        let spec = kind_spec("engineInstall").unwrap();
        assert!(spec.resizable);
        assert!(!spec.maximizable);
        assert_eq!(spec.size, (520.0, 480.0));
        assert_eq!(
            native_window_title("engineInstall", spec.title, "Install Naming Engine"),
            "Install Naming Engine"
        );
        assert_eq!(
            native_window_title("pageSize", "Custom Page Size", "Custom Page Size"),
            "Custom Page Size — Custom Page Size"
        );
        assert_eq!(
            native_window_title("export", "Export", "Export document"),
            "Export — Export document"
        );
        let mut registry = Registry::default();
        let (registration, build) = register(&mut registry, message.clone(), false).unwrap();
        assert!(build);
        assert!(is_dialog_label(&registration.window_label));
        assert!(!register(&mut registry, message.clone(), false).unwrap().1);
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        assert!(authorize(session, "main", true, Some(&message)).is_ok());
        assert!(authorize(session, "preferences", true, Some(&message)).is_err());
        assert!(authorize(session, &registration.window_label, false, Some(&message)).is_ok());
        assert!(authorize(session, "main", false, Some(&message)).is_err());
        assert!(
            serde_json::to_vec(&delivery(session, "main", &message).unwrap())
                .unwrap()
                .len()
                < MAX_CHANNEL_BYTES
        );
        for field in ["path", "callback", "document"] {
            let mut invalid = message.clone();
            invalid.data[field] = json!("untrusted");
            assert!(invalid.validate().is_err());
        }
        for state in [
            json!({"status":"unknown"}),
            json!({"status":"notInstalled","extra":1}),
            json!({"status":"broken","detail":null}),
        ] {
            let mut invalid = message.clone();
            invalid.data["state"] = state;
            assert!(invalid.validate().is_err());
        }
        let mut oversized = message.clone();
        oversized.data["disclosure"] = json!("\u{0001}".repeat(1024));
        assert!(oversized.validate().is_err());
        assert!(delivery(session, "main", &oversized).is_err());
        oversized.data["disclosure"] = json!("x".repeat(MAX_BYTES));
        assert!(oversized.validate().is_err());
        for number in [json!(-1), json!(1.5), json!(MAX_SAFE_INTEGER + 1)] {
            let mut invalid = message.clone();
            invalid.data["freeDiskBytes"] = number;
            assert!(invalid.validate().is_err());
        }
        for action in ["install", "cancelInstall", "close"] {
            let mut action_message = message.clone();
            action_message.message_type = "action".into();
            action_message.data = json!({"action":action});
            assert!(action_message.validate().is_ok());
            action_message.data["unknown"] = json!(true);
            assert!(action_message.validate().is_err());
        }
        for label in [
            "dialog-main-engineInstall-",
            "dialog-main-engineInstall-../",
            "dialog-other-engineInstall-1",
        ] {
            assert!(!is_dialog_label(label));
        }
    }
    #[test]
    fn engine_install_progress_is_bounded_and_cancel_bypasses_pending_install() {
        let mut registry = Registry::default();
        let mut message = engine_install_snapshot();
        let (registration, _) = register(&mut registry, message.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        message.message_type = "action".into();
        message.data = json!({"action":"install"});
        assert!(reserve_action(session, &message).unwrap());
        assert!(!reserve_action(session, &message).unwrap());
        session.snapshot.data["state"] = json!({"status":"installing", "phase":"Installing Python", "step":2,"steps":5,"bytesDone":100,"bytesTotal":200,"estimated":true});
        session.snapshot.data["buttons"] = json!(["cancelInstall", "close"]);
        assert!(session.snapshot.validate().is_ok());
        assert!(
            serde_json::to_vec(&delivery(session, "main", &session.snapshot).unwrap())
                .unwrap()
                .len()
                < MAX_CHANNEL_BYTES
        );
        for (field, value) in [
            ("step", json!(6)),
            ("estimated", json!("yes")),
            ("path", json!("/private")),
        ] {
            let mut invalid = session.snapshot.clone();
            invalid.data["state"][field] = value;
            assert!(invalid.validate().is_err());
        }
        message.request_id = "cancel-install".into();
        message.data = json!({"action":"cancelInstall"});
        assert!(reserve_action(session, &message).unwrap());
        message.request_id = "close-install".into();
        message.data = json!({"action":"close"});
        assert!(reserve_action(session, &message).unwrap());
    }
    #[test]
    fn engine_install_persists_its_kind_and_reopens_at_destination_scale() {
        let mut registry = Registry::default();
        let (registration, _) = register(&mut registry, engine_install_snapshot(), false).unwrap();
        let saved = SavedPosition {
            monitor: "other".into(),
            x: 1200.0,
            y: 20.0,
            offset_x: 0.5,
            offset_y: 0.25,
        };
        registry
            .sessions
            .get_mut(&registration.host_id)
            .unwrap()
            .pending_move = Some((Instant::now(), saved.clone()));
        let writes = take_pending_positions(&mut registry);
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "engineInstall");
        let owner = WorkArea {
            id: "owner".into(),
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
            scale: 2.0,
        };
        let other = WorkArea {
            id: "other".into(),
            x: 1000.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
            scale: 1.5,
        };
        let position = position_for(
            Some(&writes[0].1),
            &[other],
            &owner,
            (0.0, 0.0, 800.0, 600.0),
            kind_spec("engineInstall").unwrap().size,
        );
        assert_eq!(position, (1860.0, 120.0, 1.5));
        assert!(!should_persist(
            true,
            true,
            (false, false),
            false,
            false,
            true,
            false
        ));
    }
    #[test]
    fn picker_focus_targets_only_the_same_live_ready_export_session() {
        let mut registry = Registry::default();
        let mut message = snapshot();
        let old_id = message.session_id.clone();
        let (page, _) = register(&mut registry, message.clone(), false).unwrap();
        registry.sessions.get_mut(&page.host_id).unwrap().ready = true;
        assert_eq!(export_focus_label(&registry, &old_id), None);
        registry.sessions.clear();
        message.dialog_kind = "export".into();
        message.data = export_snapshot().data;
        let (export, _) = register(&mut registry, message.clone(), false).unwrap();
        assert_eq!(export_focus_label(&registry, &old_id), None);
        registry.sessions.get_mut(&export.host_id).unwrap().ready = true;
        assert_eq!(
            export_focus_label(&registry, &old_id),
            Some(export.window_label)
        );
        registry.sessions.clear();
        assert_eq!(export_focus_label(&registry, &old_id), None);
        message.session_id = "replacement-session".into();
        let (replacement, _) = register(&mut registry, message, false).unwrap();
        registry
            .sessions
            .get_mut(&replacement.host_id)
            .unwrap()
            .ready = true;
        assert_eq!(export_focus_label(&registry, &old_id), None);
    }

    #[test]
    fn every_channel_message_stays_receiver_private_at_worst_case() {
        let mut maximum = snapshot();
        maximum.document_tab_id = "t".repeat(128);
        maximum.session_id = "s".repeat(128);
        maximum.request_id = "r".repeat(128);
        maximum.snapshot_revision = 9_007_199_254_740_991;
        let mut registry = Registry {
            next_slot: u64::MAX - 1,
            ..Registry::default()
        };
        let (registration, _) = register(&mut registry, maximum.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        let deliveries = std::sync::Arc::new(Mutex::new(Vec::new()));
        let capture = || {
            let deliveries = deliveries.clone();
            Channel::new(move |body| {
                let tauri::ipc::InvokeResponseBody::Json(bytes) = body else {
                    panic!("dialog deliveries must be JSON");
                };
                assert!(bytes.len() <= MAX_CHANNEL_BYTES);
                assert!(
                    bytes.len() < 8192,
                    "must never enter the app-wide fetch queue"
                );
                deliveries.lock().unwrap().push(bytes);
                Ok(())
            })
        };
        session.owner_channel = Some(capture());
        session.host_channel = Some(capture());
        for (kind, data) in [
            (
                "snapshot",
                json!({"title":"\u{0001}".repeat(256),"width":f64::MIN_POSITIVE,"height":9.999999999999999e-100,"unit":"css-px"}),
            ),
            ("request", json!({})),
            ("ready", json!({})),
            (
                "action",
                json!({"action":"apply","width":f64::MIN_POSITIVE,"height":9.999999999999999e-100,"unit":"css-px"}),
            ),
            ("action", json!({"action":"cancel"})),
            (
                "result",
                json!({"status":"error","error":"\u{0001}".repeat(2048)}),
            ),
            (
                "result",
                json!({"status":"applied","error":"\u{0001}".repeat(2048)}),
            ),
            (
                "result",
                json!({"status":"cancelled","error":"\u{0001}".repeat(2048)}),
            ),
            ("closed", json!({"reason":"ownerTabClose"})),
        ] {
            let message = Message {
                message_type: kind.into(),
                data,
                ..maximum.clone()
            };
            message.validate().unwrap();
            if kind == "result" {
                // Allowed 2048-character errors expand to over 12 KiB in JSON.
                assert!(serde_json::to_vec(&message).unwrap().len() >= 8192);
            }
            send_owner(session, &registration.window_label, &message).unwrap();
            send_host(session, &message).unwrap();
        }
        let deliveries = deliveries.lock().unwrap();
        assert_eq!(deliveries.len(), 18);
        for bytes in deliveries.iter() {
            let payload: Value = serde_json::from_str(bytes).unwrap();
            if payload["message"]["type"] == "result" {
                assert_eq!(payload["message"]["data"]["error"], OVERSIZED_ERROR);
            }
        }
    }
    #[test]
    fn oversized_non_error_deliveries_and_envelopes_fail_closed() {
        let mut registry = Registry::default();
        let (r, _) = register(&mut registry, snapshot(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        let mut message = snapshot();
        message.data["title"] = json!("x".repeat(MAX_CHANNEL_BYTES));
        assert!(delivery(session, "main", &message).is_err());
        // Even replacing error text must not permit an oversized delivery envelope.
        session.registration.window_label = "x".repeat(MAX_CHANNEL_BYTES);
        message.message_type = "result".into();
        message.data = json!({"status":"error","error":"\u{0001}".repeat(2048)});
        assert!(delivery(session, "main", &message).is_err());
    }
    #[test]
    fn dialogs_disable_minimize_and_reopen_unminimizes_before_show_and_focus() {
        // Native builder/order contracts cannot be exercised by the headless mock runtime.
        let source = include_str!("dialog_windows.rs");
        let builder = source
            .split("let builder = WebviewWindowBuilder::new(")
            .nth(1)
            .unwrap()
            .split("let dialog_window = match builder.build()")
            .next()
            .unwrap();
        assert!(builder.contains(".minimizable(false)"));
        let reopen = source
            .split("fn show_on_main<R: Runtime>")
            .nth(1)
            .unwrap()
            .split("pub(crate) fn configure_on_main")
            .next()
            .unwrap();
        let unminimize = reopen.find("window.unminimize()").unwrap();
        let show = reopen.find("window.show()").unwrap();
        let focus = reopen.find("window.set_focus()").unwrap();
        assert!(unminimize < show && show < focus);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn dialog_level_reaches_floating_toolbars() {
        assert!(dialog_window_level() >= super::super::toolset_utility_window_level());
        assert!(dialog_window_level() > objc2_app_kit::NSNormalWindowLevel);
    }

    #[test]
    fn terminal_action_is_reserved_across_distinct_request_ids() {
        let mut registry = Registry::default();
        let (r, _) = register(&mut registry, snapshot(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        let mut action = snapshot();
        action.message_type = "action".into();
        action.data = json!({"action":"apply","width":10,"height":15,"unit":"mm"});
        assert!(reserve_action(session, &action).unwrap());
        assert!(!reserve_action(session, &action).unwrap());
        action.request_id = "second".into();
        assert!(reserve_action(session, &action).is_err());
        session.terminal_request = None; // An error result releases the reservation.
        assert!(reserve_action(session, &action).unwrap());
    }
    #[test]
    fn placement_moves_before_destination_resize_and_clamps_the_measured_outer_frame() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::new());
        let frame = RefCell::new((420, 330));
        let work = WorkArea {
            id: "high-dpi".into(),
            x: 1000.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
            scale: 2.0,
        };
        finish_placement(
            (3000.0, 1000.0, 2.0),
            (420.0, 300.0),
            &work,
            |x, y| {
                calls.borrow_mut().push(format!("move:{x},{y}"));
                if calls.borrow().len() == 1 {
                    // Simulate Windows WM_DPICHANGED rescaling the old client on the first move.
                    let old = *frame.borrow();
                    *frame.borrow_mut() = (old.0 * 2, old.1 * 2);
                }
                Ok(())
            },
            |w, h| {
                calls.borrow_mut().push(format!("size:{w},{h}"));
                *frame.borrow_mut() = (w + 32, h + 80);
                Ok(())
            },
            || {
                calls.borrow_mut().push("measure".into());
                Ok(*frame.borrow())
            },
        )
        .unwrap();
        assert_eq!(
            *calls.borrow(),
            ["move:3000,1000", "size:840,600", "measure", "move:2728,520"]
        );
        assert_eq!(*frame.borrow(), (872, 680));
    }
    #[test]
    fn persistence_worker_coalesces_a_burst_and_writes_after_registry_unlock() {
        use std::sync::mpsc;
        let (sender, receiver) = mpsc::sync_channel(1);
        let registry = std::sync::Arc::new(Mutex::new(Registry::default()));
        let (r, _) = register(&mut registry.lock().unwrap(), snapshot(), false).unwrap();
        let saved = SavedPosition {
            monitor: "display".into(),
            x: 1.0,
            y: 2.0,
            offset_x: 0.5,
            offset_y: 0.5,
        };
        let writes = std::sync::Arc::new(Mutex::new(Vec::new()));
        let worker_registry = registry.clone();
        let worker_writes = writes.clone();
        // The same worker loop used in production processes the entire movement burst.
        let worker = std::thread::spawn(move || {
            debounce_positions(receiver, Duration::from_secs(5), |_| {
                flush_pending_positions(&worker_registry, |snapshot| {
                    assert!(
                        worker_registry.try_lock().is_ok(),
                        "file IO must not hold REGISTRY"
                    );
                    worker_writes.lock().unwrap().push(snapshot);
                });
            })
        });
        for revision in 1u32..=1000 {
            registry
                .lock()
                .unwrap()
                .sessions
                .get_mut(&r.host_id)
                .unwrap()
                .pending_move = Some((
                Instant::now(),
                SavedPosition {
                    x: f64::from(revision),
                    ..saved.clone()
                },
            ));
            let _ = sender.try_send(std::path::PathBuf::from("positions.json"));
        }
        drop(sender);
        worker.join().unwrap();
        let writes = writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0][0].1.x, 1000.0);
        assert!(registry.lock().unwrap().sessions[&r.host_id]
            .pending_move
            .is_none());
    }
    #[test]
    fn a_coalesced_kind_remembers_the_latest_move_across_tabs() {
        let mut registry = Registry::default();
        let (first, _) = register(&mut registry, snapshot(), false).unwrap();
        let mut other = snapshot();
        other.document_tab_id = "tab-2".into();
        other.session_id = "session-2".into();
        let (second, _) = register(&mut registry, other, false).unwrap();
        let now = Instant::now();
        let position = SavedPosition {
            monitor: "display".into(),
            x: 1.0,
            y: 2.0,
            offset_x: 0.5,
            offset_y: 0.5,
        };
        registry
            .sessions
            .get_mut(&first.host_id)
            .unwrap()
            .pending_move = Some((now + Duration::from_millis(1), position.clone()));
        registry
            .sessions
            .get_mut(&second.host_id)
            .unwrap()
            .pending_move = Some((now, SavedPosition { x: 3.0, ..position }));
        let writes = take_pending_positions(&mut registry);
        assert_eq!(writes.last().unwrap().1.x, 1.0);
        assert!(registry.sessions.values().all(|s| s.pending_move.is_none()));
    }
    #[test]
    fn dialog_deactivation_matches_toolbars_without_an_activation_reveal() {
        let source = include_str!("dialog_windows.rs");
        let configure = source
            .split("pub(crate) fn configure_on_main")
            .nth(1)
            .unwrap()
            .split("fn dialog_window_level")
            .next()
            .unwrap();
        assert!(configure
            .contains("native.setHidesOnDeactivate(super::toolset_window_hides_on_deactivate())"));
        assert!(!configure.contains("window.show()") && !configure.contains("orderFront"));
        #[cfg(target_os = "macos")]
        assert!(super::super::toolset_window_hides_on_deactivate());
    }
    #[test]
    fn dialog_activation_during_native_box_waits_for_last_release_and_quit_clears_it() {
        for dialog in [
            "dialog-main-pageSize-1",
            "dialog-main-export-1",
            "dialog-main-insertTable-1",
        ] {
            let mut suspension = super::super::utility_suspension::UtilitySuspension::default();
            suspension.begin([(dialog.into(), true, false, true)], None);
            // Focus/activation retries query pending_restore; an open native box has no reveal.
            assert_eq!(suspension.pending_restore(), None);
            suspension.defer_show(dialog.into()); // reopen while the box is open
            assert_eq!(suspension.pending_restore(), None);
            suspension.begin([], None); // nested native box
            assert_eq!(suspension.release(false), None);
            assert_eq!(suspension.pending_restore(), None);
            assert_eq!(suspension.release(false), Some(vec![dialog.into()]));
            // Release while inactive retains the obligation for a later activation retry.
            assert_eq!(suspension.pending_restore(), Some(vec![dialog.into()]));
            suspension.begin([], None); // another box before activation
            assert_eq!(suspension.pending_restore(), None);
            assert_eq!(suspension.release(true), None);
            assert_eq!(suspension.pending_restore(), None);
            assert!(!suspension.active());
        }
    }
    #[test]
    fn dialog_uses_shared_suspension_order_and_is_never_restored_after_close_or_quit() {
        for dialog in [
            "dialog-main-pageSize-1",
            "dialog-main-export-1",
            "dialog-main-insertTable-1",
        ] {
            let toolbar = "toolset-core-main";
            assert!(super::super::is_suspended_utility_label(dialog));
            assert_eq!(
                super::super::utility_window_has_document_parent(dialog),
                cfg!(not(target_os = "macos"))
            );
            let mut suspension = super::super::utility_suspension::UtilitySuspension::default();
            suspension.begin(
                [
                    (dialog.into(), true, false, false),
                    (toolbar.into(), true, false, false),
                ],
                Some(vec![toolbar.into(), dialog.into()]),
            );
            assert!(suspension.visible(toolbar, false));
            assert_eq!(
                suspension.release(false),
                Some(vec![dialog.into(), toolbar.into()])
            );
            suspension.closed(dialog);
            assert_eq!(suspension.pending_restore(), Some(vec![toolbar.into()]));
            assert_eq!(suspension.release(true), None);
            assert_eq!(suspension.pending_restore(), None);
        }
    }
    fn snapshot() -> Message {
        serde_json::from_value(json!({"protocolVersion":1,"ownerWindowId":"main","documentTabId":"tab-1","dialogKind":"pageSize","sessionId":"session-1","requestId":"request-1","snapshotRevision":1,"type":"snapshot","data":{"title":"Drawing","width":8.5,"height":11,"unit":"inch"}})).unwrap()
    }
    #[test]
    fn spacing_preview_payloads_stay_bounded_and_do_not_reserve_save() {
        let mut message = snapshot();
        message.dialog_kind = "arrangementSpacing".into();
        message.data = json!({"title":"Drawing", "minPercent":25, "maxPercent":150});
        assert!(message.validate().is_ok());
        let mut registry = Registry::default();
        let (registration, _) = register(&mut registry, message.clone(), false).unwrap();
        assert!(is_dialog_label(&registration.window_label));
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        message.message_type = "action".into();
        message.data = json!({"action":"preview", "percent":80});
        assert!(message.validate().is_ok());
        assert!(reserve_action(session, &message).unwrap());
        assert!(session.terminal_request.is_none());
        assert!(session.actions.is_empty());
        message.request_id = "save".into();
        message.data = json!({"action":"apply", "percent":80});
        assert!(reserve_action(session, &message).unwrap());
        message.request_id = "late-preview".into();
        message.data = json!({"action":"preview", "percent":90});
        assert!(reserve_action(session, &message).is_err());
        message.message_type = "preview".into();
        message.data = json!({"percent":80, "index":0, "count":1024, "chunk":"A".repeat(2000)});
        assert!(message.validate().is_ok());
        assert!(delivery(session, "main", &message).is_ok());
        for data in [
            json!({"percent":80, "index":0, "count":1, "chunk":"A".repeat(2001)}),
            json!({"percent":80, "index":0, "count":1025, "chunk":"AA=="}),
            json!({"percent":80, "index":1, "count":1, "chunk":"AA=="}),
            json!({"percent":80, "index":0, "count":1, "chunk":"https://example.com"}),
            json!({"percent":80.5, "index":0, "count":1, "chunk":"AA=="}),
        ] {
            message.data = data;
            assert!(message.validate().is_err());
        }
    }
    #[test]
    fn spacing_has_its_own_window_size_and_page_size_cannot_send_preview() {
        let spacing = kind_spec("arrangementSpacing").unwrap();
        assert!(spacing.resizable);
        assert_eq!(spacing.size, (540.0, 600.0));
        let mut message = snapshot();
        message.message_type = "action".into();
        message.data = json!({"action":"preview", "percent":80});
        assert!(message.validate().is_err());
        message.dialog_kind = "export".into();
        assert!(message.validate().is_err());
        message.dialog_kind = "arrangementSpacing".into();
        message.message_type = "result".into();
        message.data = json!({"status":"accepted"});
        assert!(message.validate().is_ok());
        message.data = json!({"status":"exported"});
        assert!(message.validate().is_err());
        assert!(is_dialog_label("dialog-main-arrangementSpacing-12"));
        assert!(!is_dialog_label("dialog-main-arrangementSpacing-../main"));
    }
    #[test]
    fn insert_table_registers_and_validates_typed_payloads() {
        let spec = kind_spec("insertTable").unwrap();
        assert!(!spec.maximizable);
        assert!(spec.resizable);
        assert_eq!(spec.size, (480.0, 420.0));
        assert_eq!(spec.min_size, (420.0, 360.0));
        assert_eq!(
            native_window_title("insertTable", spec.title, "Drawing"),
            "Insert Table — Drawing"
        );
        let capability = include_str!("../capabilities/dialog-host.json");
        assert!(capability.contains("dialog-main-insertTable-*"));
        let mut message = snapshot();
        message.dialog_kind = "insertTable".into();
        message.data = json!({"title":"Drawing", "rows":4, "columns":3,
            "headerRows":1, "preset":"three-line"});
        assert!(message.validate().is_ok());
        let mut registry = Registry::default();
        let (registration, _) = register(&mut registry, message.clone(), false).unwrap();
        assert!(registration
            .window_label
            .starts_with("dialog-main-insertTable-"));
        assert!(is_dialog_label(&registration.window_label));
        for label in [
            "dialog-main-insertTable-",
            "dialog-main-insertTable-../main",
            "dialog-main-insertTable-12-extra",
        ] {
            assert!(!is_dialog_label(label));
        }
        for message_type in ["snapshot", "action"] {
            message.message_type = message_type.into();
            let mut data = json!({"rows":4, "columns":3, "headerRows":1, "preset":"grid"});
            if message_type == "snapshot" {
                data["title"] = json!("Drawing");
            } else {
                data["action"] = json!("apply");
            }
            message.data = data.clone();
            assert!(message.validate().is_ok());
            for (field, value) in [
                ("rows", json!(0)),
                ("rows", json!(501)),
                ("rows", json!(1.5)),
                ("rows", json!("4")),
                ("columns", json!(0)),
                ("columns", json!(65)),
                ("columns", json!(1.5)),
                ("headerRows", json!(-1)),
                ("headerRows", json!(5)),
                ("headerRows", json!(0.5)),
                ("preset", json!("unknown")),
                ("path", json!("/private")),
            ] {
                message.data = data.clone();
                message.data[field] = value;
                assert!(message.validate().is_err());
            }
            for header_rows in [0, 500] {
                message.data = data.clone();
                message.data["rows"] = json!(500);
                message.data["columns"] = json!(64);
                message.data["headerRows"] = json!(header_rows);
                assert!(message.validate().is_ok());
            }
        }
        message.data = json!({"action":"cancel"});
        assert!(message.validate().is_ok());
        message.data["rows"] = json!(4);
        assert!(message.validate().is_err());
        message.data = json!({"action":"preview", "percent":80});
        assert!(message.validate().is_err());
    }
    #[test]
    fn validates_kind_label_owner_and_payload() {
        let mut m = snapshot();
        assert!(m.validate().is_ok());
        for kind in ["export", "pageSize/../main", "unknown"] {
            m.dialog_kind = kind.into();
            assert!(m.validate().is_err());
        }
        m = snapshot();
        m.owner_window_id = "preferences".into();
        assert!(m.validate().is_err());
        m = snapshot();
        m.data["title"] = json!("x".repeat(MAX_BYTES));
        assert!(m.validate().is_err());
        m = snapshot();
        m.data["callback"] = json!("command");
        assert!(m.validate().is_err());
        m = snapshot();
        m.data["title"] = json!("😀".repeat(128));
        assert!(m.validate().is_ok());
        m.data["title"] = json!("😀".repeat(129));
        assert!(m.validate().is_err());
        m = snapshot();
        m.message_type = "result".into();
        m.data = json!({"status": "error", "error": null});
        assert!(m.validate().is_err());
        assert!(is_dialog_label("dialog-main-pageSize-12"));
        assert!(is_dialog_label("dialog-main-export-0"));
        for label in [
            "dialog-main-export-../",
            "dialog-other-pageSize-0",
            "dialog-main-pageSize-../",
            "main",
        ] {
            assert!(!is_dialog_label(label));
        }
        let mut registry = Registry::default();
        let (r, _) = register(&mut registry, snapshot(), false).unwrap();
        let s = &registry.sessions[&r.host_id];
        assert!(authorize(s, &r.window_label, false, Some(&snapshot())).is_ok());
        assert!(authorize(s, "main", false, None).is_err());
        let mut stale = snapshot();
        stale.session_id = "stale".into();
        assert!(authorize(s, &r.window_label, false, Some(&stale)).is_err());
        stale = snapshot();
        stale.snapshot_revision += 1;
        assert!(authorize(s, &r.window_label, false, Some(&stale)).is_err());
    }
    #[test]
    fn quit_refuses_and_concurrent_same_session_builds_once() {
        assert!(register(&mut Registry::default(), snapshot(), true).is_err());
        let registry = std::sync::Arc::new(Mutex::new(Registry::default()));
        let builds = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                let builds = builds.clone();
                std::thread::spawn(move || {
                    let (r, build) =
                        register(&mut registry.lock().unwrap(), snapshot(), false).unwrap();
                    if build {
                        builds.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    r.window_label
                })
            })
            .collect();
        let labels: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(labels.iter().all(|l| l == &labels[0]));
        assert_eq!(builds.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[test]
    fn geometry_centers_clamps_and_recovers_monitor_loss_using_destination_scale() {
        let owner = WorkArea {
            id: "owner".into(),
            x: 0.0,
            y: 30.0,
            width: 1000.0,
            height: 700.0,
            scale: 2.0,
        };
        let other = WorkArea {
            id: "other".into(),
            x: 1000.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
            scale: 1.5,
        };
        assert_eq!(
            position_for(
                None,
                &[],
                &owner,
                (100.0, 100.0, 800.0, 600.0),
                (420.0, 330.0)
            ),
            (580.0, 470.0, 2.0)
        );
        let saved = SavedPosition {
            monitor: "other".into(),
            x: 0.0,
            y: 0.0,
            offset_x: 2.0,
            offset_y: -1.0,
        };
        assert_eq!(
            position_for(
                Some(&saved),
                &[other],
                &owner,
                (0.0, 0.0, 800.0, 600.0),
                (420.0, 330.0)
            ),
            (2070.0, 0.0, 1.5)
        );
        assert_eq!(
            position_for(
                Some(&saved),
                &[],
                &owner,
                (900.0, 650.0, 800.0, 600.0),
                (420.0, 330.0)
            ),
            (1160.0, 800.0, 2.0)
        );
    }
    #[test]
    fn persistence_excludes_hidden_minimized_teardown_suspension_and_restore_moves() {
        assert!(should_persist(
            true,
            false,
            (false, false),
            false,
            false,
            true,
            false
        ));
        for flags in [
            (false, false, false, false, true, false),
            (true, true, false, false, true, false),
            (true, false, true, false, true, false),
            (true, false, false, true, true, false),
            (true, false, false, false, false, false),
            (true, false, false, false, true, true),
        ] {
            assert!(!should_persist(
                flags.0,
                flags.1,
                (false, false),
                flags.2,
                flags.3,
                flags.4,
                flags.5
            ));
        }
    }
    #[test]
    fn page_size_window_is_not_maximizable_or_resizable() {
        let spec = kind_spec("pageSize").unwrap();
        assert!(!spec.maximizable);
        assert!(!spec.resizable);
        assert!(kind_spec("unknown").is_err());
    }
    fn export_snapshot() -> Message {
        let mut m = snapshot();
        m.dialog_kind = "export".into();
        m.data = json!({"title":"Drawing", "options": {
            "format":"pdf", "filename":"Drawing.pdf",
            "svg":{"includeWarnings":true,"includePageGuides":false},
            "pdf":{"compress":true,"includePageGuides":false,"page":"current","pdfType":"vector","background":"white"},
            "raster":{"scale":1,"background":"white","jpegQuality":90,"maxDimensionPx":8192},
            "cdxml":{"creationProgram":"ChemDraft"}
        }});
        m
    }
    #[test]
    fn export_kind_has_resizable_client_size_and_narrow_label() {
        let spec = kind_spec("export").unwrap();
        assert_eq!(spec.size, (520.0, 620.0));
        assert_eq!(spec.min_size, (420.0, 360.0));
        assert!(spec.resizable);
        assert!(!spec.maximizable);
        assert!(is_dialog_label("dialog-main-export-1"));
        for label in [
            "dialog-main-export-",
            "dialog-main-export-../main",
            "dialog-other-export-1",
        ] {
            assert!(!is_dialog_label(label));
        }
    }
    #[test]
    fn export_validates_options_actions_receipts_and_channel_caps() {
        let snapshot = export_snapshot();
        assert!(snapshot.validate().is_ok());
        let mut registry = Registry::default();
        let (r, _) = register(&mut registry, snapshot.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        for action in ["export", "chooseDestination"] {
            let mut m = snapshot.clone();
            m.message_type = "action".into();
            m.data = json!({"action":action,"options":snapshot.data["options"]});
            assert!(m.validate().is_ok());
            assert!(
                serde_json::to_vec(&delivery(session, &r.window_label, &m).unwrap())
                    .unwrap()
                    .len()
                    <= MAX_CHANNEL_BYTES
            );
            m.data["options"]["raster"]["scale"] = json!(5);
            assert!(m.validate().is_err());
            m.data["options"] = snapshot.data["options"].clone();
            m.data["options"]["destinationPath"] = Value::Null;
            assert!(m.validate().is_err());
            m.data["options"] = snapshot.data["options"].clone();
            m.data["options"]["filename"] = json!("../Drawing.pdf");
            assert!(m.validate().is_err());
            m.data["options"] = snapshot.data["options"].clone();
            m.data["options"]["command"] = json!("document.delete");
            assert!(m.validate().is_err());
        }
        let mut m = snapshot.clone();
        m.message_type = "action".into();
        m.data = json!({"action":"apply","width":1,"height":2,"unit":"mm"});
        assert!(m.validate().is_err());
        for status in [
            "accepted",
            "progress",
            "picked",
            "exported",
            "cancelled",
            "error",
        ] {
            m.message_type = "result".into();
            m.data = json!({"status":status,"notice":"Export result"});
            assert!(m.validate().is_ok());
            assert!(delivery(session, "main", &m).is_ok());
        }
        m.data = json!({"status":"error","error":"\u{0001}".repeat(2048)});
        let bounded = delivery(session, "main", &m).unwrap();
        assert_eq!(bounded["message"]["data"]["error"], OVERSIZED_ERROR);
    }
    #[test]
    fn completed_export_allows_only_cancel_and_replays_duplicates() {
        let mut registry = Registry::default();
        let mut m = export_snapshot();
        let (r, _) = register(&mut registry, m.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        m.message_type = "action".into();
        m.data = json!({"action":"export","options":m.data["options"]});
        assert!(reserve_action(session, &m).unwrap());
        assert!(!reserve_action(session, &m).unwrap());
        let mut receipt = m.clone();
        receipt.message_type = "result".into();
        receipt.data = json!({"status":"exported","notice":"Exported PDF"});
        session.receipts.insert(m.request_id.clone(), receipt);
        m.request_id = "second-press".into();
        assert!(reserve_action(session, &m).is_err());
        m.data = json!({"action":"cancel"});
        assert!(reserve_action(session, &m).unwrap());
    }
    #[test]
    fn pending_export_allows_cancel_without_releasing_write_reservation() {
        let mut registry = Registry::default();
        let mut m = export_snapshot();
        let (r, _) = register(&mut registry, m.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        m.message_type = "action".into();
        m.data = json!({"action":"export","options":m.data["options"]});
        assert!(reserve_action(session, &m).unwrap());
        let mut cancel = m.clone();
        cancel.request_id = "cancel-pending".into();
        cancel.data = json!({"action":"cancel"});
        assert!(reserve_action(session, &cancel).unwrap());
        assert!(!reserve_action(session, &cancel).unwrap());
        m.request_id = "second-export".into();
        assert!(reserve_action(session, &m).is_err());
    }
    #[test]
    fn export_placement_resizes_at_destination_scale() {
        use std::cell::RefCell;
        let sizes = RefCell::new(Vec::new());
        let work = WorkArea {
            id: "display".into(),
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale: 1.5,
        };
        finish_placement(
            (0.0, 0.0, 1.5),
            kind_spec("export").unwrap().size,
            &work,
            |_, _| Ok(()),
            |w, h| {
                sizes.borrow_mut().push((w, h));
                Ok(())
            },
            || Ok((780, 960)),
        )
        .unwrap();
        assert_eq!(*sizes.borrow(), [(780, 930)]);
    }
    #[test]
    fn persistence_excludes_maximized_and_fullscreen_frames() {
        for expanded in [(true, false), (false, true), (true, true)] {
            assert!(!should_persist(
                true, false, expanded, false, false, true, false
            ));
        }
    }
    #[test]
    fn preview_is_bounded_typed_and_does_not_reserve_export() {
        let mut registry = Registry::default();
        let snapshot = export_snapshot();
        let (r, _) = register(&mut registry, snapshot.clone(), false).unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        let mut action = snapshot.clone();
        action.message_type = "action".into();
        action.data = json!({"action":"preview","options":snapshot.data["options"]});
        for i in 0..150 {
            action.request_id = format!("preview-{i}");
            assert!(action.validate().is_ok());
            assert!(reserve_action(session, &action).unwrap());
        }
        assert!(session.terminal_request.is_none());
        assert_eq!(session.actions.len(), 1);
        let mut result = action.clone();
        result.message_type = "result".into();
        result.data = json!({"status":"preview","preview":{"url":format!("data:image/png;base64,{}", "A".repeat(20000)),"kind":"image","width":100,"height":100,"warnings":[]}});
        assert!(result.validate().is_ok());
        result.data["preview"]["url"] = json!("https://example.com/image.png");
        assert!(result.validate().is_err());
        result.data["preview"]["url"] = json!(format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_PREVIEW_BYTES)
        ));
        assert!(result.validate().is_err());
        action.request_id = "export".into();
        action.data["action"] = json!("export");
        assert!(reserve_action(session, &action).unwrap());
    }
    #[test]
    fn validates_frame_revision_and_presentation_types() {
        let mut snapshot = export_snapshot();
        let presentation = json!({"width":600,"height":400,"linked":false,"preset":"custom","dpi":300,"crop":"content","background":"white"});
        snapshot.data["options"]["presentation"] = presentation.clone();
        assert!(snapshot.validate().is_ok());
        for value in [json!(0), json!(1.5), Value::Null] {
            snapshot.data["options"]["presentation"]["width"] = value;
            assert!(snapshot.validate().is_err());
        }
        snapshot.message_type = "result".into();
        snapshot.data = json!({"status":"frame","frame":{"page":{"width":100,"height":100},"content":{"width":80,"height":80},"revision":2}});
        assert!(snapshot.validate().is_ok());
        snapshot.data["frame"]["revision"] = Value::Null;
        assert!(snapshot.validate().is_err());
    }
    #[test]
    fn preview_chunks_remain_private_with_worst_json_escaping() {
        let text = format!(
            "{}{}{}",
            "\u{0001}".repeat(4096),
            "??".repeat(4096),
            "\\\"".repeat(4096)
        );
        let chunks = preview_delivery_chunks(&text, &"a".repeat(128));
        assert!(chunks.len() < 10);
        assert_eq!(
            preview_delivery_chunks(&"A".repeat(MAX_PREVIEW_BYTES), "preview").len(),
            MAX_PREVIEW_BYTES.div_ceil(PREVIEW_CHUNK_TEXT_BYTES)
        );
        assert!(chunks
            .iter()
            .all(|c| serde_json::to_vec(c).unwrap().len() <= PREVIEW_CHANNEL_BYTES));
        let restored: String = chunks
            .iter()
            .map(|c| c["previewChunk"]["text"].as_str().unwrap())
            .collect();
        assert_eq!(restored, text);
    }
}
