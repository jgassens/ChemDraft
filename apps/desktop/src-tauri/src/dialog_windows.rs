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
    // Content-fit: `ready` carries the form's measured height; reveal sets the inner height to it
    // (clamped to the work area); remembered user sizes take precedence.
    fit_content: bool,
}
fn kind_spec(kind: &str) -> Result<DialogKindSpec, String> {
    match kind {
        "preferences" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Preferences",
            size: (640.0, 600.0),
            min_size: (360.0, 180.0),
            fit_content: true,
        }),
        "atomProblem" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Atom problem",
            size: (460.0, 360.0),
            min_size: (360.0, 260.0),
            fit_content: false,
        }),
        "vibeCodeGuide" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Vibe Code Your Own Plugin",
            size: (480.0, 400.0),
            min_size: (420.0, 240.0),
            fit_content: true,
        }),
        "structureTemplates" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Templates",
            size: (620.0, 700.0),
            min_size: (420.0, 360.0),
            fit_content: false,
        }),
        "pageSize" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: false,
            title: "Custom Page Size",
            size: (420.0, 300.0),
            min_size: (360.0, 260.0),
            fit_content: true,
        }),
        "arrangementSpacing" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Adjust arrangement spacing",
            size: (540.0, 600.0),
            min_size: (360.0, 260.0),
            fit_content: true,
        }),
        "insertTable" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Insert Table",
            // Height before ready, and the fallback when ready carries no usable measurement;
            // ready's measured content height replaces it.
            size: (480.0, 240.0),
            min_size: (360.0, 120.0),
            fit_content: true,
        }),
        "reactionConditions" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Reaction conditions",
            size: (560.0, 620.0),
            min_size: (380.0, 420.0),
            fit_content: false,
        }),
        "export" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Export",
            size: (520.0, 620.0),
            min_size: (420.0, 360.0),
            fit_content: true,
        }),
        "engineInstall" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Engine installation",
            size: (520.0, 480.0),
            min_size: (420.0, 380.0),
            fit_content: true,
        }),
        "toolInstall" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Tool installation",
            size: (520.0, 460.0),
            min_size: (420.0, 380.0),
            fit_content: true,
        }),
        _ => Err("Unknown dialog kind".into()),
    }
}
fn native_window_title(kind: &str, spec_title: &str, snapshot_title: &str) -> String {
    if matches!(kind, "engineInstall" | "toolInstall" | "vibeCodeGuide") {
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
struct VibeGuideSnapshot {
    title: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum VibeGuideAction {
    SaveStarter {},
    OpenPluginManager {},
    Cancel {},
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AtomProblemSnapshot {
    title: String,
    explanation: String,
    target_version: u64,
    fixes: Vec<AtomProblemFix>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AtomProblemFix {
    action: String,
    label: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum AtomProblemAction {
    Cancel,
    Hydrogens {
        #[serde(rename = "targetVersion")]
        target_version: u64,
    },
    Charge {
        #[serde(rename = "targetVersion")]
        target_version: u64,
    },
    Ignore {
        #[serde(rename = "targetVersion")]
        target_version: u64,
    },
    Restore {
        #[serde(rename = "targetVersion")]
        target_version: u64,
    },
}
fn problem_action(action: &str) -> bool {
    matches!(action, "hydrogens" | "charge" | "ignore" | "restore")
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
/// `ready` data from a content-fit form: CSS height × device pixel ratio = physical pixels.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentFit {
    content_height: f64,
    pixel_ratio: f64,
}
/// A dialog form is far shorter than this; anything taller is not a measurement.
const CONTENT_FIT_MAX_HEIGHT: f64 = 4096.0;
/// Device pixel ratios and native scale factors outside this range are not a real display.
const CONTENT_FIT_SCALE_RANGE: std::ops::RangeInclusive<f64> = 0.5..=8.0;
impl ContentFit {
    fn from_ready(data: &Value) -> Option<Self> {
        serde_json::from_value::<Self>(data.clone())
            .ok()
            .filter(|f| {
                f.content_height.is_finite()
                    && f.content_height > 0.0
                    && f.content_height <= CONTENT_FIT_MAX_HEIGHT
                    && f.pixel_ratio.is_finite()
                    && CONTENT_FIT_SCALE_RANGE.contains(&f.pixel_ratio)
            })
    }
}
/// A content-fit measurement with the window's native scale factor when `ready` (the
/// measurement) arrived. The display scale can change before reveal (a monitor change or a
/// scale setting), so the physical measurement converts through the scale it was taken at.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MeasuredContent {
    fit: ContentFit,
    scale_at_ready: f64,
}
impl MeasuredContent {
    fn new(fit: Option<ContentFit>, scale_at_ready: Option<f64>) -> Option<Self> {
        let scale_at_ready =
            scale_at_ready.filter(|s| s.is_finite() && CONTENT_FIT_SCALE_RANGE.contains(s))?;
        Some(Self {
            fit: fit?,
            scale_at_ready,
        })
    }
    /// Logical inner height: physical measurement / scale at measurement. The ratio carries
    /// WebView zoom and text scaling. Callers choose the floor; content fit uses 1px so a kind's
    /// resize minimum never adds an empty band. Placement converts it to
    /// physical pixels at the destination's scale (the scale at reveal).
    fn logical_height(self, min_height: f64) -> f64 {
        (self.fit.content_height * self.fit.pixel_ratio / self.scale_at_ready)
            .ceil()
            .max(min_height)
    }
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
    // Struct form: serde ignores deny_unknown_fields on unit variants of internally tagged enums.
    Cancel {},
}
fn valid_table_options(rows: u32, columns: u32, header_rows: u32, preset: &str) -> bool {
    (1..=500).contains(&rows)
        && (1..=64).contains(&columns)
        && header_rows <= rows
        && matches!(preset, "three-line" | "grid")
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConditionsSpan {
    text: String,
    script: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConditionsDraft {
    side: String,
    spans: Vec<ConditionsSpan>,
}
impl ConditionsDraft {
    fn valid(&self) -> bool {
        matches!(self.side.as_str(), "above" | "below")
            && self.spans.len() <= 128
            && self
                .spans
                .iter()
                .map(|span| span.text.encode_utf16().count())
                .sum::<usize>()
                <= 2000
            && self
                .spans
                .iter()
                .all(|span| matches!(span.script.as_str(), "normal" | "subscript" | "superscript"))
            && serde_json::to_vec(self).is_ok_and(|bytes| bytes.len() <= 2500)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConditionsSnapshot {
    title: String,
    arrow_id: String,
    draft: ConditionsDraft,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum ConditionsAction {
    Apply { draft: ConditionsDraft },
    Cancel {},
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpacingSnapshot {
    title: String,
    min_percent: u32,
    max_percent: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructureTemplatesSnapshot {
    title: String,
    template_ids: Vec<String>,
}
fn template_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum StructureTemplatesAction {
    Insert {
        #[serde(rename = "templateId")]
        template_id: String,
    },
    Cancel,
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
            || ((self.dialog_kind == "engineInstall"
                || self.dialog_kind == "toolInstall"
                || self.dialog_kind == "atomProblem")
                && serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 3400)
        {
            return Err("Invalid dialog envelope or payload limit exceeded".into());
        }
        let valid = match self.message_type.as_str() {
            "snapshot" if self.dialog_kind == "atomProblem" => {
                serde_json::from_value::<AtomProblemSnapshot>(self.data.clone()).is_ok_and(|s| {
                    valid_title(&s.title)
                        && !s.title.contains('\0')
                        && !s.explanation.is_empty()
                        && s.explanation.encode_utf16().count() <= 1024
                        && !s.explanation.contains('\0')
                        && (1..=9_007_199_254_740_991).contains(&s.target_version)
                        && s.fixes.len() <= 4
                        && s.fixes.iter().all(|f| {
                            problem_action(&f.action)
                                && !f.label.is_empty()
                                && f.label.encode_utf16().count() <= 128
                                && !f.label.contains('\0')
                        })
                        && s.fixes
                            .iter()
                            .map(|f| &f.action)
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            == s.fixes.len()
                })
            }
            "action" if self.dialog_kind == "atomProblem" => serde_json::from_value::<
                AtomProblemAction,
            >(self.data.clone())
            .is_ok_and(|a| match a {
                AtomProblemAction::Cancel => true,
                AtomProblemAction::Hydrogens { target_version }
                | AtomProblemAction::Charge { target_version }
                | AtomProblemAction::Ignore { target_version }
                | AtomProblemAction::Restore { target_version } => {
                    (1..=9_007_199_254_740_991).contains(&target_version)
                }
            }),
            "snapshot" if self.dialog_kind == "vibeCodeGuide" => {
                serde_json::from_value::<VibeGuideSnapshot>(self.data.clone())
                    .is_ok_and(|s| valid_title(&s.title) && !s.title.contains('\0'))
            }
            "action" if self.dialog_kind == "vibeCodeGuide" => {
                serde_json::from_value::<VibeGuideAction>(self.data.clone()).is_ok()
            }
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
                InsertTableAction::Cancel {} => true,
                InsertTableAction::Apply {
                    rows,
                    columns,
                    header_rows,
                    preset,
                } => valid_table_options(rows, columns, header_rows, &preset),
            }),
            "snapshot" if self.dialog_kind == "structureTemplates" => {
                serde_json::from_value::<StructureTemplatesSnapshot>(self.data.clone()).is_ok_and(
                    |s| {
                        valid_title(&s.title)
                            && !s.title.contains('\0')
                            && !s.template_ids.is_empty()
                            && s.template_ids.len() <= 64
                            && s.template_ids.iter().all(|id| template_id(id))
                            && s.template_ids
                                .iter()
                                .collect::<std::collections::HashSet<_>>()
                                .len()
                                == s.template_ids.len()
                    },
                )
            }
            "action" if self.dialog_kind == "structureTemplates" => serde_json::from_value::<
                StructureTemplatesAction,
            >(self.data.clone())
            .is_ok_and(|action| match action {
                StructureTemplatesAction::Cancel => true,
                StructureTemplatesAction::Insert { template_id: id } => template_id(&id),
            }),
            "result" if self.dialog_kind == "structureTemplates" => {
                serde_json::from_value::<Receipt>(self.data.clone()).is_ok_and(|r| {
                    matches!(
                        r.status.as_str(),
                        "accepted" | "inserted" | "cancelled" | "error"
                    ) && optional_string_fields(&self.data, &["error"])
                        && r.error.is_none_or(|s| s.encode_utf16().count() <= 2048)
                })
            }
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
            "snapshot" if self.dialog_kind == "reactionConditions" => {
                serde_json::from_value::<ConditionsSnapshot>(self.data.clone()).is_ok_and(|s| {
                    valid_title(&s.title)
                        && !s.arrow_id.is_empty()
                        && s.arrow_id.encode_utf16().count() <= 128
                        && s.draft.valid()
                })
            }
            "action" if self.dialog_kind == "reactionConditions" => serde_json::from_value::<
                ConditionsAction,
            >(self.data.clone())
            .is_ok_and(|action| match action {
                ConditionsAction::Apply { draft } => draft.valid(),
                ConditionsAction::Cancel {} => true,
            }),
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
            "request" => self.data.as_object().is_some_and(|d| d.is_empty()),
            "ready" => {
                self.data.as_object().is_some_and(|d| d.is_empty())
                    || ContentFit::from_ready(&self.data).is_some()
            }
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
    programmatic_client: Option<(u32, u32)>,
    programmatic_position: Option<(i32, i32)>,
    pending_move: Option<(Instant, SavedPosition)>,
    content_fit: Option<MeasuredContent>,
}
#[derive(Default)]
struct Registry {
    preferences: Option<PreferencesLayout>,
    sessions: HashMap<String, Session>,
    next_slot: u64,
}
struct PreferencesLayout {
    applied_position: Option<(i32, i32)>,
    ready: bool,
    transient_until: Instant,
    programmatic_client: Option<(u32, u32)>,
    programmatic_position: Option<(i32, i32)>,
    pending_move: Option<(Instant, SavedPosition)>,
}
impl Default for PreferencesLayout {
    fn default() -> Self {
        Self {
            ready: false,
            transient_until: Instant::now(),
            applied_position: None,
            programmatic_client: None,
            programmatic_position: None,
            pending_move: None,
        }
    }
}
impl PreferencesLayout {
    fn record_move(&mut self, position: (i32, i32), scale: f64, saved: SavedPosition) {
        // Native placement may be rounded or constrained by a few physical pixels.
        // Retain the marker through those events, but accept a user's larger move immediately.
        let tolerance = scale.ceil().max(2.0);
        if self.applied_position.is_some_and(|applied| {
            (f64::from(applied.0) - f64::from(position.0)).abs() <= tolerance
                && (f64::from(applied.1) - f64::from(position.1)).abs() <= tolerance
        }) {
            return;
        }
        self.applied_position = None;
        self.pending_move = Some((Instant::now(), saved));
    }
}
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

pub(crate) fn is_dialog_label(label: &str) -> bool {
    label == super::PREFERENCES_WINDOW_LABEL
        || label
            .strip_prefix("dialog-main-")
            .and_then(|s| s.split_once('-'))
            .is_some_and(|(kind, slot)| {
                kind != "preferences"
                    && kind_spec(kind).is_ok()
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
    if message.dialog_kind == "atomProblem"
        && message.data["action"] != "cancel"
        && (message.data["targetVersion"] != session.snapshot.data["targetVersion"]
            || !session.snapshot.data["fixes"]
                .as_array()
                .is_some_and(|fixes| {
                    fixes
                        .iter()
                        .any(|fix| fix["action"] == message.data["action"])
                }))
    {
        return Err("This atom problem changed; use the current window actions".into());
    }
    if message.dialog_kind == "structureTemplates"
        && message.data["action"] == "insert"
        && !session.snapshot.data["templateIds"]
            .as_array()
            .is_some_and(|ids| ids.contains(&message.data["templateId"]))
    {
        return Err("Unknown structure template in this dialog".into());
    }
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
fn releases_action_reservation(message: &Message) -> bool {
    (message.dialog_kind == "atomProblem" && message.data["status"] == "applied")
        || matches!(
            message.data["status"].as_str(),
            Some("error" | "picked" | "cancelled" | "inserted")
        )
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
            programmatic_client: None,
            programmatic_position: None,
            pending_move: None,
            content_fit: None,
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
                || session.snapshot.dialog_kind == "atomProblem"
                || session.snapshot.dialog_kind == "toolInstall"
                || session.snapshot.dialog_kind == "structureTemplates"
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
    // The form measured at this window's current scale; read it before taking the registry lock.
    let scale_at_ready = if message.message_type == "ready" {
        window.scale_factor().ok()
    } else {
        None
    };
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
            session.content_fit =
                MeasuredContent::new(ContentFit::from_ready(&message.data), scale_at_ready);
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
        if releases_action_reservation(&message)
            && session.terminal_request.as_ref() == Some(&message.request_id)
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
    flush_preferences(app);
    if let Some(window) = app.get_webview_window(super::PREFERENCES_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    let sessions = std::mem::take(&mut REGISTRY.lock().unwrap_or_else(|p| p.into_inner()).sessions);
    for mut session in sessions.into_values() {
        flush_position(app, &mut session);
        notify_closed(&session, reason);
        if let Some(window) = app.get_webview_window(&session.registration.window_label) {
            let _ = window.destroy();
        }
    }
}

pub(crate) fn prepare_preferences() {
    REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .preferences = Some(PreferencesLayout {
        applied_position: None,
        ready: false,
        transient_until: Instant::now() + Duration::from_millis(500),
        programmatic_client: None,
        programmatic_position: None,
        pending_move: None,
    });
}
#[tauri::command]
pub(crate) async fn preferences_ready(
    window: tauri::WebviewWindow,
    data: Value,
) -> Result<(), String> {
    if window.label() != super::PREFERENCES_WINDOW_LABEL {
        return Err("Only Preferences can report its content size".into());
    }
    let _creation = super::lock_window_creation()?;
    let measured = MeasuredContent::new(ContentFit::from_ready(&data), window.scale_factor().ok());
    if measured.is_none() && !data.as_object().is_some_and(|object| object.is_empty()) {
        return Err("Invalid Preferences content measurement".into());
    }
    {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let state = registry
            .preferences
            .as_mut()
            .ok_or("Preferences is not open")?;
        if state.ready {
            return Ok(());
        }
        state.ready = true;
    }
    let target = window.clone();
    super::run_on_main_thread_blocking(&window, move || {
        place_content_window(&target, "preferences", measured, false)?;
        show_on_main(&target)
    })
    .and_then(|result| result)
}
pub(crate) fn show_preferences<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let ready = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .preferences
        .as_ref()
        .is_some_and(|p| p.ready);
    if ready {
        // A retained Preferences window may outlive its saved display. Re-centre it over the
        // document before the shared reveal path clamps the live frame to the current screen.
        let positions = read_positions(window.app_handle());
        if let Some(saved) = positions.get("preferences") {
            let monitors: Vec<_> = window
                .available_monitors()
                .map_err(|e| e.to_string())?
                .iter()
                .map(|monitor| WorkArea::from_monitor(monitor).inset(12.0))
                .collect();
            if restorable_position(Some(saved), &monitors).is_none() {
                place_content_window(window, "preferences", None, false)?;
            }
        }
        show_on_main(window)?;
    }
    Ok(())
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
    mark_transient(window.label());
    window.unminimize().map_err(|e| e.to_string())?;
    let kind = if window.label() == super::PREFERENCES_WINDOW_LABEL {
        "preferences".to_string()
    } else {
        REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sessions
            .values()
            .find(|s| s.registration.window_label == window.label())
            .map(|s| s.snapshot.dialog_kind.clone())
            .ok_or("Unknown dialog window")?
    };
    place_content_window(window, &kind, None, true)?;
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
    super::toolset_utility_window_level("dialog")
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<(f64, f64)>, // logical client size, independent of monitor DPI
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
    fn inset(&self, margin: f64) -> Self {
        let margin = margin
            .min((self.width - 1.0).max(0.0) / 2.0)
            .min((self.height - 1.0).max(0.0) / 2.0);
        Self {
            x: self.x + margin,
            y: self.y + margin,
            width: self.width - margin * 2.0,
            height: self.height - margin * 2.0,
            ..self.clone()
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
fn restorable_position<'a>(
    saved: Option<&'a SavedPosition>,
    monitors: &[WorkArea],
) -> Option<&'a SavedPosition> {
    saved.filter(|p| {
        [p.x, p.y, p.offset_x, p.offset_y]
            .iter()
            .all(|v| v.is_finite())
            && monitors.iter().any(|m| m.id == p.monitor)
    })
}
fn saved_frame(
    work: &WorkArea,
    position: (i32, i32),
    outer: (u32, u32),
    size: Option<(f64, f64)>,
) -> SavedPosition {
    let x = f64::from(position.0) / work.scale;
    let y = f64::from(position.1) / work.scale;
    SavedPosition {
        size,
        monitor: work.id.clone(),
        x,
        y,
        offset_x: ((x - work.x) / (work.width - f64::from(outer.0) / work.scale).max(1.0))
            .clamp(0.0, 1.0),
        offset_y: ((y - work.y) / (work.height - f64::from(outer.1) / work.scale).max(1.0))
            .clamp(0.0, 1.0),
    }
}
fn dialog_client_size(
    spec: &DialogKindSpec,
    content: Option<MeasuredContent>,
    saved: Option<&SavedPosition>,
    current_frame: bool,
) -> (f64, f64) {
    remembered_client_size(saved, spec.resizable || current_frame).unwrap_or_else(|| {
        (
            spec.size.0,
            content
                .filter(|_| spec.fit_content)
                .map(|fit| fit.logical_height(1.0))
                .unwrap_or(spec.size.1),
        )
    })
}
fn remembered_client_size(saved: Option<&SavedPosition>, resizable: bool) -> Option<(f64, f64)> {
    saved.filter(|_| resizable)?.size.filter(|(width, height)| {
        width.is_finite() && height.is_finite() && *width > 0.0 && *height > 0.0
    })
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
    let (kind, content_fit) = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .values()
        .find(|s| s.registration.window_label == window.label())
        .map(|s| (s.snapshot.dialog_kind.clone(), s.content_fit))
        .ok_or("Unknown dialog window")?;
    place_content_window(window, &kind, content_fit, false)
}
fn place_content_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    kind: &str,
    content_fit: Option<MeasuredContent>,
    current_frame: bool,
) -> Result<(), String> {
    let app = window.app_handle();
    let owner = app
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or("Unknown dialog owner")?;
    let monitor = owner
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Document monitor unavailable")?;
    let work = WorkArea::from_monitor(&monitor).inset(12.0);
    let monitors: Vec<_> = owner
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|m| WorkArea::from_monitor(m).inset(12.0))
        .collect();
    let position = owner.inner_position().map_err(|e| e.to_string())?;
    let owner_size = owner.inner_size().map_err(|e| e.to_string())?;
    let frame = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let positions = read_positions(app);
    let spec = kind_spec(kind)?;
    let live_frame = if current_frame {
        let work = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|m| WorkArea::from_monitor(m).inset(12.0))
            .unwrap_or_else(|| work.clone());
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let outer = window.outer_size().map_err(|e| e.to_string())?;
        let client = window.inner_size().map_err(|e| e.to_string())?;
        Some(saved_frame(
            &work,
            (position.x, position.y),
            (outer.width, outer.height),
            Some((
                f64::from(client.width) / scale,
                f64::from(client.height) / scale,
            )),
        ))
    } else {
        None
    };
    let saved = live_frame
        .as_ref()
        .or_else(|| positions.get(kind))
        .filter(|position| {
            [position.x, position.y, position.offset_x, position.offset_y]
                .iter()
                .all(|value| value.is_finite())
        });
    let client_size = dialog_client_size(&spec, content_fit, saved, current_frame);
    // A user size remains useful after its display is removed; its position does not.
    let saved = restorable_position(saved, &monitors);
    let client = window.inner_size().map_err(|e| e.to_string())?;
    let size = (
        client_size.0 + f64::from(frame.width.saturating_sub(client.width)) / scale,
        client_size.1 + f64::from(frame.height.saturating_sub(client.height)) / scale,
    );
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
    let template_placement = Some(TemplatePlacement {
        saved,
        owner_rect: (
            f64::from(position.x) / destination.scale,
            f64::from(position.y) / destination.scale,
            f64::from(owner_size.width) / destination.scale,
            f64::from(owner_size.height) / destination.scale,
        ),
    });
    // WM_DPICHANGED runs when moving between Windows monitors. Move first, set the desired
    // client size at the destination DPI, then clamp using the measured final outer frame.
    mark_transient(window.label());
    DialogPlacement {
        position: (x, y, destination_scale),
        client_size,
        work: destination,
        spec: &spec,
        fit_content: spec.fit_content && content_fit.is_some(),
        template: template_placement,
    }
    .apply(
        |x, y| {
            // Tag the requested physical origin before the native call can emit Moved.
            remember_programmatic_position(window.label(), (x as i32, y as i32));
            move_dialog(
                cfg!(target_os = "macos"),
                (x, y, destination_scale),
                |position| {
                    #[cfg(target_os = "macos")]
                    {
                        use objc2_app_kit::{NSScreen, NSWindow};
                        let mtm = objc2::MainThreadMarker::new()
                            .ok_or("Dialog placement requires the main thread")?;
                        let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
                        // SAFETY: the live Tauri window owns this NSWindow; placement runs on main.
                        let native = unsafe { ptr.as_ref() }
                            .ok_or("Could not access native dialog window")?;
                        let primary = NSScreen::screens(mtm)
                            .firstObject()
                            .ok_or("The primary screen is unavailable")?;
                        let origin = appkit_dialog_origin(
                            position,
                            primary.frame().size.height,
                            native.frame().size.height,
                        );
                        native.setFrameOrigin(objc2_foundation::NSPoint::new(origin.x, origin.y));
                        Ok(())
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = position;
                        Err("AppKit positioning is only available on macOS".into())
                    }
                },
                |position| window.set_position(position).map_err(|e| e.to_string()),
            )
        },
        |width, height| {
            resize_dialog_client(
                cfg!(target_os = "macos"),
                tauri::PhysicalSize::new(width, height),
                destination_scale,
                |size| {
                    #[cfg(target_os = "macos")]
                    {
                        let ptr = window.ns_window().map_err(|e| e.to_string())?
                            as *mut objc2_app_kit::NSWindow;
                        let native = unsafe { ptr.as_ref() }
                            .ok_or("Could not access native dialog window")?;
                        native
                            .setContentSize(objc2_foundation::NSSize::new(size.width, size.height));
                        Ok(())
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = size;
                        Err("AppKit content sizing is only available on macOS".into())
                    }
                },
                |size| window.set_size(size).map_err(|e| e.to_string()),
            )?;
            if window.label() == super::PREFERENCES_WINDOW_LABEL {
                let position = window.outer_position().map_err(|e| e.to_string())?;
                mark_preferences_position(window.label(), (position.x, position.y));
            }
            Ok(())
        },
        || {
            let outer = window.outer_size().map_err(|e| e.to_string())?;
            let client = window.inner_size().map_err(|e| e.to_string())?;
            Ok(DialogFrame {
                outer: (outer.width, outer.height),
                client: (client.width, client.height),
            })
        },
        |size| window.set_min_size(Some(size)).map_err(|e| e.to_string()),
    )?;
    mark_transient(window.label());
    let client = window.inner_size().map_err(|e| e.to_string())?;
    remember_programmatic_client(window.label(), (client.width, client.height));
    let position = window.outer_position().map_err(|e| e.to_string())?;
    remember_programmatic_position(window.label(), (position.x, position.y));
    Ok(())
}
struct TemplatePlacement<'a> {
    saved: Option<&'a SavedPosition>,
    owner_rect: (f64, f64, f64, f64),
}
struct DialogFrame {
    outer: (u32, u32),
    client: (u32, u32),
}
struct DialogPlacement<'a> {
    position: (f64, f64, f64),
    client_size: (f64, f64),
    work: &'a WorkArea,
    spec: &'a DialogKindSpec,
    fit_content: bool,
    template: Option<TemplatePlacement<'a>>,
}
impl DialogPlacement<'_> {
    fn apply(
        self,
        move_to: impl FnMut(f64, f64) -> Result<(), String>,
        resize: impl FnMut(u32, u32) -> Result<(), String>,
        mut measure: impl FnMut() -> Result<DialogFrame, String>,
        mut set_minimum: impl FnMut(tauri::LogicalSize<f64>) -> Result<(), String>,
    ) -> Result<(), String> {
        let fits_work_area = self.template.is_some() || self.fit_content;
        if fits_work_area {
            // Small work areas may require less than the kind's usual minimum.
            set_minimum(tauri::LogicalSize::new(1.0, 1.0))?;
        }
        finish_placement(
            (self.position, self.client_size),
            self.work,
            fits_work_area,
            self.template,
            move_to,
            resize,
            &mut measure,
        )?;
        if fits_work_area {
            let frame = measure()?;
            let client_height = f64::from(frame.client.1) / self.work.scale;
            // Logical constraints rescale on Windows. Permit user sizes shorter than the content:
            // the shared form scrolls its body above a pinned footer.
            set_minimum(tauri::LogicalSize::new(
                (f64::from(frame.client.0) / self.work.scale).min(self.spec.min_size.0),
                client_height.min(self.spec.min_size.1),
            ))?;
        }
        Ok(())
    }
}
/// Tao queues macOS moves and converts physical coordinates using the *origin* scale. Complete
/// the move at the destination's logical position before any resize or backing-pixel measurement.
fn move_dialog(
    macos: bool,
    (x, y, scale): (f64, f64, f64),
    mut set_origin: impl FnMut(tauri::LogicalPosition<f64>) -> Result<(), String>,
    mut set_tauri_position: impl FnMut(tauri::PhysicalPosition<i32>) -> Result<(), String>,
) -> Result<(), String> {
    if macos {
        set_origin(tauri::LogicalPosition::new(x / scale, y / scale))
    } else {
        set_tauri_position(tauri::PhysicalPosition::new(x as i32, y as i32))
    }
}
#[cfg(any(target_os = "macos", test))]
fn appkit_dialog_origin(
    top_left: tauri::LogicalPosition<f64>,
    primary_height: f64,
    outer_height: f64,
) -> tauri::LogicalPosition<f64> {
    // AppKit's origin is bottom-left; Tauri's is top-left of the primary display. Coordinates
    // are global logical points, including negative x/y on displays left of or above primary.
    tauri::LogicalPosition::new(top_left.x, primary_height - top_left.y - outer_height)
}
/// Placement reads the resized frame immediately, before clamping and setting its minimum.
/// Tao 0.35.3 queues macOS `set_inner_size` onto GCD even on the main thread; use AppKit's
/// synchronous content setter there. Windows keeps Tauri's synchronous inner-size path.
/// AppKit adds the actual decorations; neither callback takes an outer size.
fn resize_dialog_client(
    macos: bool,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
    mut set_content_size: impl FnMut(tauri::LogicalSize<f64>) -> Result<(), String>,
    mut set_tauri_size: impl FnMut(tauri::PhysicalSize<u32>) -> Result<(), String>,
) -> Result<(), String> {
    if macos {
        set_content_size(size.to_logical(scale))
    } else {
        set_tauri_size(size)
    }
}
// All arguments/results are physical pixels. Decoration sizes are measured after the move,
// since Windows may replace them during WM_DPICHANGED.
fn fitted_template_client(client: (u32, u32), frame: (u32, u32), work: &WorkArea) -> (u32, u32) {
    let available_width = (work.width * work.scale) as u32;
    let available_height = (work.height * work.scale) as u32;
    (
        client
            .0
            .min(available_width.saturating_sub(frame.0.saturating_sub(client.0)))
            .max(1),
        client
            .1
            .min(available_height.saturating_sub(frame.1.saturating_sub(client.1)))
            .max(1),
    )
}
fn finish_placement(
    ((x, y, scale), (client_width, client_height)): ((f64, f64, f64), (f64, f64)),
    work: &WorkArea,
    fit_to_work_area: bool,
    template: Option<TemplatePlacement<'_>>,
    mut move_to: impl FnMut(f64, f64) -> Result<(), String>,
    mut resize: impl FnMut(u32, u32) -> Result<(), String>,
    mut measure: impl FnMut() -> Result<DialogFrame, String>,
) -> Result<(), String> {
    move_to(x, y)?;
    // A fitted size comes from the webview: never ask for more than the destination work area,
    // even before its decorations are measured.
    let (client_width, client_height) = if fit_to_work_area {
        (client_width.min(work.width), client_height.min(work.height))
    } else {
        (client_width, client_height)
    };
    // Round up: a fitted content height truncated at 125%/150% would lose its last pixel row.
    resize(
        (client_width * scale).ceil() as u32,
        (client_height * scale).ceil() as u32,
    )?;
    let mut frame = measure()?;
    if fit_to_work_area || template.is_some() {
        let fitted = fitted_template_client(frame.client, frame.outer, work);
        if fitted != frame.client {
            resize(fitted.0, fitted.1)?;
            frame = measure()?;
        }
    }
    if let Some(template) = template {
        // Re-centre using the final outer frame, rather than the initial monitor's frame.
        // A saved position still uses the shared per-kind destination/offset policy.
        let (x, y, _) = position_for(
            template.saved,
            std::slice::from_ref(work),
            work,
            template.owner_rect,
            (
                f64::from(frame.outer.0) / scale,
                f64::from(frame.outer.1) / scale,
            ),
        );
        return move_to(x, y);
    }
    let (x, y) = work.clamp(
        x / scale,
        y / scale,
        f64::from(frame.outer.0) / scale,
        f64::from(frame.outer.1) / scale,
    );
    move_to(x * scale, y * scale)
}
fn mark_preferences_position(label: &str, position: (i32, i32)) {
    if label == super::PREFERENCES_WINDOW_LABEL {
        if let Some(frame) = REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferences
            .as_mut()
        {
            frame.applied_position = Some(position);
        }
    }
}
pub(crate) fn mark_transient(label: &str) {
    if label == super::PREFERENCES_WINDOW_LABEL {
        if let Some(state) = REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferences
            .as_mut()
        {
            state.transient_until = Instant::now() + Duration::from_millis(500);
            state.programmatic_client = None;
            state.programmatic_position = None;
        }
        return;
    }

    if let Some(session) = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .values_mut()
        .find(|s| s.registration.window_label == label)
    {
        session.transient_until = Instant::now() + Duration::from_millis(500);
        session.programmatic_client = None;
        session.programmatic_position = None;
    }
}
fn remember_programmatic_client(label: &str, size: (u32, u32)) {
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    if label == super::PREFERENCES_WINDOW_LABEL {
        if let Some(state) = registry.preferences.as_mut() {
            state.programmatic_client = Some(size);
        }
    } else if let Some(session) = registry
        .sessions
        .values_mut()
        .find(|s| s.registration.window_label == label)
    {
        session.programmatic_client = Some(size);
    }
}
fn remember_programmatic_position(label: &str, position: (i32, i32)) {
    mark_preferences_position(label, position);
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let programmed = if label == super::PREFERENCES_WINDOW_LABEL {
        registry
            .preferences
            .as_mut()
            .map(|state| &mut state.programmatic_position)
    } else {
        registry
            .sessions
            .values_mut()
            .find(|session| session.registration.window_label == label)
            .map(|session| &mut session.programmatic_position)
    };
    if let Some(programmed) = programmed {
        *programmed = Some(position);
    }
}
fn transient_frame_event(
    transient: bool,
    resized: bool,
    programmed: Option<(u32, u32)>,
    actual: (u32, u32),
    programmed_position: Option<(i32, i32)>,
    position: (i32, i32),
) -> bool {
    // The time window alone cannot distinguish a queued app move from an immediate user drag.
    transient
        && if resized {
            programmed.is_none_or(|size| size == actual)
        } else {
            programmed_position == Some(position)
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
fn persist_move<R: Runtime>(window: &tauri::WebviewWindow<R>, resized: bool) {
    let app = window.app_handle();
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let (ready, transient_until, programmatic_client, programmatic_position, pending_move) =
        if window.label() == super::PREFERENCES_WINDOW_LABEL {
            let Some(state) = registry.preferences.as_mut() else {
                return;
            };
            (
                state.ready,
                &mut state.transient_until,
                &mut state.programmatic_client,
                &mut state.programmatic_position,
                &mut state.pending_move,
            )
        } else {
            let Some(session) = registry
                .sessions
                .values_mut()
                .find(|s| s.registration.window_label == window.label())
            else {
                return;
            };
            (
                session.ready,
                &mut session.transient_until,
                &mut session.programmatic_client,
                &mut session.programmatic_position,
                &mut session.pending_move,
            )
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
        ready,
        false,
    ) {
        return;
    }
    let Ok(client) = window.inner_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    if transient_frame_event(
        Instant::now() < *transient_until,
        resized,
        *programmatic_client,
        (client.width, client.height),
        *programmatic_position,
        (position.x, position.y),
    ) {
        return;
    }
    *transient_until = Instant::now();
    *programmatic_client = None;
    *programmatic_position = None;
    if !resized
        && !super::UTILITY_SUSPENSION
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .persist_move(window.label(), (position.x, position.y))
    {
        return;
    }
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let m = WorkArea::from_monitor(&monitor).inset(12.0);
    let Ok(outer) = window.outer_size() else {
        return;
    };
    let size = if resized {
        Some((
            f64::from(client.width) / m.scale,
            f64::from(client.height) / m.scale,
        ))
    } else {
        pending_move.as_ref().and_then(|(_, saved)| saved.size)
    };
    let saved = saved_frame(
        &m,
        (position.x, position.y),
        (outer.width, outer.height),
        size,
    );
    if window.label() == super::PREFERENCES_WINDOW_LABEL {
        let state = registry
            .preferences
            .as_mut()
            .expect("Preferences state was checked above");
        if resized {
            state.applied_position = None;
            state.pending_move = Some((Instant::now(), saved));
        } else {
            state.record_move((position.x, position.y), m.scale, saved);
        }
    } else {
        *pending_move = Some((Instant::now(), saved));
    }
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
    if let Some((at, saved)) = registry
        .preferences
        .as_mut()
        .and_then(|p| p.pending_move.take())
    {
        moves.push((at, "preferences".into(), saved));
    }
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
fn merge_positions(positions: &mut HashMap<String, SavedPosition>, writes: PositionWrites) {
    for (kind, mut saved) in writes {
        if saved.size.is_none() {
            saved.size = positions.get(&kind).and_then(|previous| previous.size);
        }
        positions.insert(kind, saved);
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
    merge_positions(&mut positions, writes);
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

pub(crate) fn flush_preferences<R: Runtime>(app: &tauri::AppHandle<R>) {
    // Serialize snapshot + write with the worker so immediate close/reopen sees the latest move.
    let _io = POSITION_IO.lock().unwrap_or_else(|p| p.into_inner());
    let pending = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .preferences
        .as_mut()
        .and_then(|p| p.pending_move.take());
    if let (Some((_, saved)), Ok(path)) = (pending, saved_path(app)) {
        write_positions(&path, vec![("preferences".into(), saved)]);
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
            if window.label() == super::PREFERENCES_WINDOW_LABEL {
                flush_preferences(window.app_handle());
                REGISTRY
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .preferences = None;
                return;
            }
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
                persist_move(&webview, matches!(event, WindowEvent::Resized(_)));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn conditions_drafts_are_typed_bounded_and_have_an_owned_dialog_kind() {
        let draft = json!({"side":"above","spans":[{"text":"K","script":"normal"},{"text":"2","script":"subscript"},{"text":"CO₃, 80 °C","script":"normal"}]});
        assert!(
            serde_json::from_value::<super::ConditionsDraft>(draft.clone())
                .unwrap()
                .valid()
        );
        for invalid in [
            json!({"side":"left","spans":[]}),
            json!({"side":"above","spans":[{"text":"x","script":"html"}]}),
            json!({"side":"above","spans":[{"text":"Δ".repeat(1400),"script":"normal"}]}),
        ] {
            assert!(!serde_json::from_value::<super::ConditionsDraft>(invalid)
                .unwrap()
                .valid());
        }
        let spec = super::kind_spec("reactionConditions").unwrap();
        assert_eq!(spec.title, "Reaction conditions");
        assert!(spec.resizable);
        assert!(!spec.fit_content);
        assert!(super::is_dialog_label("dialog-main-reactionConditions-1"));
        assert!(include_str!("../capabilities/dialog-host.json")
            .contains("dialog-main-reactionConditions-*"));
        let mut message = snapshot();
        message.dialog_kind = "reactionConditions".into();
        message.data = json!({"title":"Drawing","arrowId":"arrow-1","draft":draft});
        assert!(message.validate().is_ok());
        message.message_type = "action".into();
        message.data = json!({"action":"apply","draft":draft});
        assert!(message.validate().is_ok());
        message.data = json!({"action":"cancel","draft":draft});
        assert!(message.validate().is_err());
    }
    use super::*;
    #[test]
    fn preferences_first_open_centres_and_move_close_reopen_restores_at_destination_scale() {
        assert!(is_dialog_label(super::super::PREFERENCES_WINDOW_LABEL));
        let owner = WorkArea {
            id: "owner".into(),
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 900.0,
            scale: 2.0,
        };
        let other = WorkArea {
            id: "other".into(),
            x: -1200.0,
            y: 0.0,
            width: 1200.0,
            height: 900.0,
            scale: 1.5,
        };
        let monitors = vec![owner.clone(), other];
        let size = kind_spec("preferences").unwrap().size;
        let owner_rect = (100.0, 100.0, 900.0, 700.0);
        assert_eq!(
            position_for(None, &monitors, &owner, owner_rect, size),
            (460.0, 300.0, 2.0)
        );
        let mut registry = Registry {
            preferences: Some(PreferencesLayout {
                applied_position: None,
                pending_move: Some((
                    Instant::now(),
                    SavedPosition {
                        size: None,
                        monitor: "other".into(),
                        x: -830.0,
                        y: 135.0,
                        offset_x: 0.5,
                        offset_y: 0.25,
                    },
                )),
                ..PreferencesLayout::default()
            }),
            ..Registry::default()
        };
        let writes = take_pending_positions(&mut registry);
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "preferences");
        assert!(take_pending_positions(&mut registry).is_empty());
        let saved = restorable_position(Some(&writes[0].1), &monitors);
        assert_eq!(
            position_for(saved, &monitors, &owner, owner_rect, size),
            (-1380.0, 112.5, 1.5)
        );
        // Close flushing writes the same format read by every shared-host dialog.
        let bytes =
            serde_json::to_vec(&HashMap::from([(writes[0].0.clone(), writes[0].1.clone())]))
                .unwrap();
        let positions: HashMap<String, SavedPosition> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            position_for(
                restorable_position(positions.get("preferences"), &monitors),
                &monitors,
                &owner,
                owner_rect,
                size
            ),
            (-1380.0, 112.5, 1.5)
        );
    }
    #[test]
    fn offscreen_page_size_and_preferences_clamp_but_removed_monitor_centres() {
        let owner = WorkArea {
            id: "owner".into(),
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 900.0,
            scale: 1.0,
        };
        let monitors = vec![owner.clone()];
        for (kind, size) in [
            ("pageSize", kind_spec("pageSize").unwrap().size),
            ("preferences", kind_spec("preferences").unwrap().size),
        ] {
            let saved = SavedPosition {
                size: None,
                monitor: "owner".into(),
                x: -16000.0,
                y: 16000.0,
                offset_x: -2.0,
                offset_y: 2.0,
            };
            let restorable = restorable_position(Some(&saved), &monitors);
            assert!(restorable.is_some(), "{kind}");
            assert_eq!(
                position_for(
                    restorable,
                    &monitors,
                    &owner,
                    (100.0, 100.0, 900.0, 700.0),
                    size
                ),
                (0.0, 900.0 - size.1, 1.0),
                "{kind}"
            );
            let missing = SavedPosition {
                size: Some((500.0, 400.0)),
                monitor: "removed".into(),
                ..saved.clone()
            };
            // Removing a monitor resets placement, while the user's client size still wins
            // over the kind's default and a fresh content measurement.
            assert_eq!(
                dialog_client_size(&kind_spec(kind).unwrap(), None, Some(&missing), false),
                (500.0, 400.0),
                "{kind}"
            );
            assert!(restorable_position(Some(&missing), &monitors).is_none());
            assert_eq!(
                position_for(
                    restorable_position(Some(&missing), &monitors),
                    &monitors,
                    &owner,
                    (100.0, 100.0, 900.0, 700.0),
                    size
                ),
                (
                    100.0 + (900.0 - size.0) / 2.0,
                    100.0 + (700.0 - size.1) / 2.0,
                    1.0
                ),
                "{kind}"
            );
            let invalid = SavedPosition {
                offset_x: f64::NAN,
                ..saved
            };
            assert!(restorable_position(Some(&invalid), &monitors).is_none());
        }
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
    fn preferences_user_move_immediately_after_restore_is_pending_for_close_flush() {
        let restored = SavedPosition {
            size: Some((640.0, 420.0)),
            monitor: "owner".into(),
            x: 320.0,
            y: 270.0,
            offset_x: 0.5,
            offset_y: 0.5,
        };
        let mut registry = Registry {
            preferences: Some(PreferencesLayout {
                applied_position: Some((320, 270)),
                pending_move: None,
                ..PreferencesLayout::default()
            }),
            ..Registry::default()
        };
        let frame = registry.preferences.as_mut().unwrap();
        frame.record_move((321, 271), 1.0, restored.clone());
        assert!(frame.pending_move.is_none());
        assert_eq!(frame.applied_position, Some((320, 270)));
        // No sleep or timer expiry: the very next event is a genuine user drag.
        frame.record_move(
            (360, 310),
            1.0,
            SavedPosition {
                x: 360.0,
                y: 310.0,
                ..restored
            },
        );
        assert!(frame.applied_position.is_none());
        let writes = take_pending_positions(&mut registry);
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "preferences");
        assert_eq!((writes[0].1.x, writes[0].1.y), (360.0, 310.0));
        assert_eq!(writes[0].1.size, Some((640.0, 420.0)));
        assert!(take_pending_positions(&mut registry).is_empty());
    }
    #[test]
    fn preferences_placement_tolerance_scales_and_retains_original_marker() {
        let saved = SavedPosition {
            size: None,
            monitor: "owner".into(),
            x: 320.0,
            y: 270.0,
            offset_x: 0.5,
            offset_y: 0.5,
        };
        for (scale, tolerance) in [(1.0, 2), (1.5, 2), (2.5, 3), (4.0, 4)] {
            let mut frame = PreferencesLayout {
                applied_position: Some((320, 270)),
                pending_move: None,
                ..PreferencesLayout::default()
            };
            for delta in [1, -1, tolerance, -tolerance] {
                frame.record_move((320 + delta, 270 - delta), scale, saved.clone());
                assert!(frame.pending_move.is_none());
                assert_eq!(frame.applied_position, Some((320, 270)));
            }
            frame.record_move((320 + tolerance + 1, 270), scale, saved.clone());
            assert!(frame.pending_move.is_some());
            assert!(frame.applied_position.is_none());
        }
    }
    #[test]
    fn vibe_code_guide_kind_and_messages_are_bounded() {
        let spec = kind_spec("vibeCodeGuide").unwrap();
        assert!(spec.resizable && !spec.maximizable);
        assert_eq!(
            native_window_title("vibeCodeGuide", spec.title, spec.title),
            spec.title
        );
        assert!(is_dialog_label("dialog-main-vibeCodeGuide-1"));
        assert!(!is_dialog_label("dialog-main-vibeCodeGuide-../main"));
        assert!(include_str!("../capabilities/dialog-host.json")
            .contains("dialog-main-vibeCodeGuide-*"));
        let mut message = snapshot();
        message.dialog_kind = "vibeCodeGuide".into();
        message.data = json!({"title":"Guide"});
        assert!(message.validate().is_ok());
        message.data = json!({"title":"x".repeat(257)});
        assert!(message.validate().is_err());
        message.message_type = "action".into();
        for action in ["saveStarter", "openPluginManager", "cancel"] {
            message.data = json!({"action":action});
            assert!(message.validate().is_ok());
        }
        message.data = json!({"action":"saveStarter","path":"/tmp/a"});
        assert!(message.validate().is_err());
    }
    #[test]
    fn structure_templates_registration_and_actions_are_bounded_on_all_platforms() {
        let mut message = snapshot();
        message.dialog_kind = "structureTemplates".into();
        message.data =
            json!({"title":"Drawing A","templateIds":["beta-cyclodextrin","pillar-5-arene"]});
        assert!(message.validate().is_ok());
        let spec = kind_spec("structureTemplates").unwrap();
        assert!(spec.resizable && !spec.maximizable);
        let mut registry = Registry::default();
        let (registration, build) = register(&mut registry, message.clone(), false).unwrap();
        assert!(build);
        assert!(registration
            .window_label
            .starts_with("dialog-main-structureTemplates-"));
        assert!(is_dialog_label(&registration.window_label));
        assert!(include_str!("../capabilities/dialog-host.json")
            .contains("dialog-main-structureTemplates-*"));
        assert!(!register(&mut registry, message.clone(), false).unwrap().1);
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        message.message_type = "action".into();
        for data in [
            json!({"action":"insert"}),
            json!({"action":"insert","templateId":"../main"}),
            json!({"action":"insert","templateId":"beta-cyclodextrin","commandId":"document.new"}),
        ] {
            message.data = data;
            assert!(message.validate().is_err());
        }
        message.data = json!({"action":"insert","templateId":"unknown"});
        assert!(reserve_action(session, &message).is_err());
        message.data = json!({"action":"insert","templateId":"beta-cyclodextrin"});
        assert!(message.validate().is_ok());
        assert!(reserve_action(session, &message).unwrap());
        assert!(!reserve_action(session, &message).unwrap());
        message.request_id = "second-insert".into();
        assert!(reserve_action(session, &message).is_err());
        session.terminal_request = None;
        assert!(reserve_action(session, &message).unwrap());
        message.message_type = "snapshot".into();
        message.data = json!({"title":"A","templateIds":["beta-cyclodextrin","beta-cyclodextrin"]});
        assert!(message.validate().is_err());
        message.data = json!({"title":"A","templateIds":[],"extra":true});
        assert!(message.validate().is_err());
    }
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
            size: None,
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
        assert!(
            dialog_window_level()
                >= super::super::toolset_utility_window_level("toolset-core-main")
        );
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
    fn template_placement_fits_oversized_frames_at_destination_dpi_and_negative_origins() {
        use std::cell::RefCell;
        // Physical monitor origin, scale, work area in logical units. The first case is
        // smaller than both the picker's default size and its normal minimum height.
        for (origin, scale, area, expected_client, expected_position) in [
            ((0.0, 24.0), 1.0, (500.0, 300.0), (484, 260), (0.0, 24.0)),
            (
                (2880.0, 0.0),
                1.5,
                (1000.0, 900.0),
                (930, 1050),
                (3037.0, 10.0),
            ),
            (
                (-1600.0, -900.0),
                2.0,
                (800.0, 700.0),
                (1240, 1360),
                (-1388.0, -900.0),
            ),
        ] {
            let work = WorkArea {
                id: "destination".into(),
                x: origin.0 / scale,
                y: origin.1 / scale,
                width: area.0,
                height: area.1,
                scale,
            };
            let owner_rect = (work.x + 20.0, work.y + 20.0, 800.0, 700.0);
            let client = RefCell::new((0, 0));
            let position = RefCell::new((0.0, 0.0));
            finish_placement(
                (
                    (origin.0, origin.1, scale),
                    kind_spec("structureTemplates").unwrap().size,
                ),
                &work,
                false,
                Some(TemplatePlacement {
                    saved: None,
                    owner_rect,
                }),
                |x, y| {
                    *position.borrow_mut() = (x, y);
                    Ok(())
                },
                |w, h| {
                    *client.borrow_mut() = (w, h);
                    Ok(())
                },
                || {
                    let (w, h) = *client.borrow();
                    Ok(DialogFrame {
                        outer: (w + 16, h + 40),
                        client: (w, h),
                    })
                },
            )
            .unwrap();
            assert_eq!(*client.borrow(), expected_client);
            assert!((position.borrow().0 - expected_position.0).abs() < 0.001);
            assert!((position.borrow().1 - expected_position.1).abs() < 0.001);
            let (x, y) = *position.borrow();
            let (w, h) = *client.borrow();
            assert!(x >= origin.0 && y >= origin.1);
            assert!(x + f64::from(w + 16) <= origin.0 + area.0 * scale);
            assert!(y + f64::from(h + 40) <= origin.1 + area.1 * scale);
        }
    }
    #[test]
    fn template_placement_restores_saved_offsets_or_centres_when_monitor_is_gone() {
        use std::cell::RefCell;
        let work = WorkArea {
            id: "secondary".into(),
            x: -800.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
            scale: 2.0,
        };
        for (monitor, expected_position) in [
            ("secondary", (-1256.0, 0.0)),
            ("disconnected", (-1488.0, 0.0)),
        ] {
            let saved = SavedPosition {
                size: None,
                monitor: monitor.into(),
                x: 9999.0,
                y: 9999.0,
                offset_x: 1.0,
                offset_y: 0.5,
            };
            let client = RefCell::new((0, 0));
            let moves = RefCell::new(Vec::new());
            let sizes = RefCell::new(Vec::new());
            finish_placement(
                (
                    (-1600.0, 0.0, work.scale),
                    kind_spec("structureTemplates").unwrap().size,
                ),
                &work,
                false,
                Some(TemplatePlacement {
                    saved: Some(&saved),
                    owner_rect: (-780.0, 20.0, 700.0, 500.0),
                }),
                |x, y| {
                    moves.borrow_mut().push((x, y));
                    Ok(())
                },
                |w, h| {
                    *client.borrow_mut() = (w, h);
                    sizes.borrow_mut().push((w, h));
                    Ok(())
                },
                || {
                    let (w, h) = *client.borrow();
                    Ok(DialogFrame {
                        outer: (w + 16, h + 40),
                        client: (w, h),
                    })
                },
            )
            .unwrap();
            assert_eq!(*sizes.borrow(), [(1240, 1400), (1240, 1160)]);
            assert_eq!(*moves.borrow(), [(-1600.0, 0.0), expected_position]);
        }
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
            ((3000.0, 1000.0, 2.0), (420.0, 300.0)),
            &work,
            false,
            None,
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
                let (w, h) = *frame.borrow();
                Ok(DialogFrame {
                    outer: (w, h),
                    client: (w - 32, h - 80),
                })
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
            size: None,
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
            size: None,
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
            "dialog-main-atomProblem-1",
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
    fn atom_problem_uses_the_modeless_host_and_restricts_actions_to_the_current_target() {
        let spec = kind_spec("atomProblem").unwrap();
        assert!(spec.resizable);
        assert!(!spec.maximizable);
        let mut message = snapshot();
        message.dialog_kind = "atomProblem".into();
        message.data = json!({"title":"Drawing", "explanation":"N has charge 0, expected 1 for valence 4.",
            "targetVersion":1, "fixes":[{"action":"charge", "label":"Set formal charge to +1"}, {"action":"ignore", "label":"Ignore warning"}]});
        assert!(message.validate().is_ok());
        let capability = include_str!("../capabilities/dialog-host.json");
        assert!(capability.contains("dialog-main-atomProblem-*"));
        let mut registry = Registry::default();
        let (registration, _) = register(&mut registry, message.clone(), false).unwrap();
        assert!(is_dialog_label(&registration.window_label));
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        assert!(delivery(session, "main", &message).is_ok());
        for data in [
            json!({"action":"deleteBond", "targetVersion":1}),
            json!({"action":"charge", "targetVersion":0}),
            json!({"action":"charge", "targetVersion":1, "charge":2}),
        ] {
            message.message_type = "action".into();
            message.data = data;
            assert!(message.validate().is_err());
        }
        message.data = json!({"action":"charge", "targetVersion":2});
        assert!(message.validate().is_ok());
        assert!(reserve_action(session, &message).is_err());
        message.data = json!({"action":"hydrogens", "targetVersion":1});
        assert!(reserve_action(session, &message).is_err());
        message.data = json!({"action":"charge", "targetVersion":1});
        assert!(reserve_action(session, &message).unwrap());
        assert!(!reserve_action(session, &message).unwrap());
        message.request_id = "other".into();
        assert!(reserve_action(session, &message).is_err());
        message.message_type = "result".into();
        message.data = json!({"status":"accepted"});
        assert!(!releases_action_reservation(&message));
        message.data = json!({"status":"applied"});
        assert!(message.validate().is_ok());
        assert!(releases_action_reservation(&message));
        message.dialog_kind = "pageSize".into();
        assert!(!releases_action_reservation(&message));
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
    // The queued operations capture logical sizes/positions at call time, just as Tao does.
    // Minimum updates are synchronous and can enlarge the current frame (Tao set_min_inner_size).
    // Draining the queue is essential: stale reads alone do not prove a persistent size error.
    enum QueuedDialogOperation {
        Move(tauri::LogicalPosition<f64>),
        Resize(tauri::LogicalSize<f64>),
    }
    struct SimulatedDialog {
        scale: f64,
        client: tauri::LogicalSize<f64>,
        minimum: tauri::LogicalSize<f64>,
        position: tauri::LogicalPosition<f64>,
        decoration: tauri::LogicalSize<f64>,
        queue: Vec<QueuedDialogOperation>,
        calls: Vec<&'static str>,
    }
    impl SimulatedDialog {
        fn frame(&self) -> DialogFrame {
            let client = self.client.to_physical::<u32>(self.scale);
            let outer = tauri::LogicalSize::new(
                self.client.width + self.decoration.width,
                self.client.height + self.decoration.height,
            )
            .to_physical::<u32>(self.scale);
            DialogFrame {
                client: (client.width, client.height),
                outer: (outer.width, outer.height),
            }
        }
        fn apply(&mut self, operation: QueuedDialogOperation, work: &WorkArea) {
            match operation {
                QueuedDialogOperation::Move(position) => {
                    self.position = position;
                    // Our destination is isolated from the origin monitor. An incorrect Tao
                    // conversion may miss it; it must not magically acquire destination scale.
                    if position.x >= work.x && position.x < work.x + work.width {
                        self.scale = work.scale;
                    }
                }
                QueuedDialogOperation::Resize(size) => self.client = size,
            }
        }
        fn set_minimum(&mut self, size: tauri::LogicalSize<f64>) {
            self.minimum = size;
            self.client.width = self.client.width.max(size.width);
            self.client.height = self.client.height.max(size.height);
        }
        fn drain(&mut self, work: &WorkArea) {
            for operation in std::mem::take(&mut self.queue) {
                self.apply(operation, work);
            }
        }
    }
    #[test]
    fn dialog_placement_and_minimum_have_correct_final_sizes_on_both_platforms() {
        use std::cell::RefCell;

        for (platform, macos, title_bar, border) in
            [("macos", true, 32.0, 0.0), ("windows", false, 40.0, 16.0)]
        {
            for (origin_scale, scale) in [
                (2.0, 1.0),
                (1.0, 2.0),
                (1.0, 1.0),
                (1.25, 1.25),
                (1.5, 1.5),
                (2.0, 2.0),
            ] {
                for (remembered, small) in
                    [(false, false), (false, true), (true, false), (true, true)]
                {
                    for kind in [
                        "preferences",
                        "vibeCodeGuide",
                        "insertTable",
                        "export",
                        "pageSize",
                        "arrangementSpacing",
                        "engineInstall",
                        "toolInstall",
                    ] {
                        let spec = kind_spec(kind).unwrap();
                        let work = WorkArea {
                            id: "destination".into(),
                            // Exercise negative global coordinates and a secondary display.
                            x: -2000.0,
                            y: -300.0,
                            width: if small { 450.0 } else { 1600.0 },
                            height: if small { 300.0 } else { 1000.0 },
                            scale,
                        };
                        let saved = remembered.then_some(SavedPosition {
                            size: Some((900.0, 1200.0)),
                            monitor: work.id.clone(),
                            x: work.x,
                            y: work.y,
                            offset_x: 0.9,
                            offset_y: 0.9,
                        });
                        let dialog = RefCell::new(SimulatedDialog {
                            scale: origin_scale,
                            client: tauri::LogicalSize::new(spec.size.0, spec.size.1),
                            minimum: tauri::LogicalSize::new(spec.min_size.0, spec.min_size.1),
                            position: tauri::LogicalPosition::new(100.0, 100.0),
                            decoration: tauri::LogicalSize::new(border, title_bar),
                            queue: Vec::new(),
                            calls: Vec::new(),
                        });
                        // Repeated content measurements must also reset the previous minimum.
                        for height in [180.0, 432.0, 517.0, 4096.0, 400.0] {
                            let measured = MeasuredContent::new(
                                ContentFit::from_ready(
                                    &json!({"contentHeight": height, "pixelRatio": origin_scale}),
                                ),
                                Some(origin_scale),
                            )
                            .unwrap();
                            let (client_width, client_height) =
                                dialog_client_size(&spec, Some(measured), saved.as_ref(), false);
                            let position = position_for(
                                saved.as_ref(),
                                std::slice::from_ref(&work),
                                &work,
                                (work.x, work.y, work.width, work.height),
                                (client_width + border, client_height + title_bar),
                            );
                            DialogPlacement {
                                position,
                                client_size: (client_width, client_height),
                                work: &work,
                                spec: &spec,
                                fit_content: true,
                                template: None,
                            }
                            .apply(
                                |x, y| {
                                    move_dialog(
                                        macos,
                                        (x, y, scale),
                                        |top_left| {
                                            let mut native = dialog.borrow_mut();
                                            native.calls.push("appkit move");
                                            // Use the production flipped-Y conversion, then
                                            // read back in Tauri coordinates as a real frame does.
                                            let outer_height = native.client.height + title_bar;
                                            let origin = appkit_dialog_origin(
                                                top_left,
                                                1080.0,
                                                outer_height,
                                            );
                                            native.apply(
                                                QueuedDialogOperation::Move(
                                                    tauri::LogicalPosition::new(
                                                        origin.x,
                                                        1080.0 - origin.y - outer_height,
                                                    ),
                                                ),
                                                &work,
                                            );
                                            Ok(())
                                        },
                                        |physical| {
                                            let mut native = dialog.borrow_mut();
                                            native.calls.push("tauri move");
                                            let operation =
                                                QueuedDialogOperation::Move(physical.to_logical(
                                                    if macos { native.scale } else { scale },
                                                ));
                                            if macos {
                                                native.queue.push(operation);
                                            } else {
                                                native.apply(operation, &work);
                                            }
                                            Ok(())
                                        },
                                    )
                                },
                                |width, height| {
                                    resize_dialog_client(
                                        macos,
                                        tauri::PhysicalSize::new(width, height),
                                        scale,
                                        |logical| {
                                            let mut native = dialog.borrow_mut();
                                            native.calls.push("appkit resize");
                                            native.apply(
                                                QueuedDialogOperation::Resize(logical),
                                                &work,
                                            );
                                            Ok(())
                                        },
                                        |physical| {
                                            let mut native = dialog.borrow_mut();
                                            native.calls.push("tauri resize");
                                            let operation = QueuedDialogOperation::Resize(
                                                physical.to_logical(native.scale),
                                            );
                                            if macos {
                                                native.queue.push(operation);
                                            } else {
                                                native.apply(operation, &work);
                                            }
                                            Ok(())
                                        },
                                    )
                                },
                                || Ok(dialog.borrow().frame()),
                                |size| {
                                    dialog.borrow_mut().set_minimum(size);
                                    Ok(())
                                },
                            )
                            .unwrap();
                            let mut native = dialog.borrow_mut();
                            native.drain(&work);
                            let frame = native.frame();
                            let expected_client = (
                                ((client_width * scale).ceil() as u32)
                                    .min((work.width * scale) as u32 - (border * scale) as u32),
                                ((client_height * scale).ceil() as u32)
                                    .min((work.height * scale) as u32 - (title_bar * scale) as u32),
                            );
                            let expected_outer = (
                                expected_client.0 + (border * scale) as u32,
                                expected_client.1 + (title_bar * scale) as u32,
                            );
                            let case = format!("{platform} {kind} {origin_scale}x->{scale}x remembered={remembered} small={small} height={height}");
                            assert_eq!(
                                (frame.client, frame.outer),
                                (expected_client, expected_outer),
                                "final client/outer: {case}"
                            );
                            assert_eq!(
                                native.minimum.height,
                                (f64::from(expected_client.1) / scale).min(spec.min_size.1),
                                "minimum: {case}"
                            );
                            assert_eq!(
                                native.minimum.width,
                                (f64::from(expected_client.0) / scale).min(spec.min_size.0),
                                "minimum width: {case}"
                            );
                            assert_eq!(native.scale, scale, "destination scale: {case}");
                            let (expected_x, expected_y) = work.clamp(
                                position.0 / scale,
                                position.1 / scale,
                                f64::from(expected_outer.0) / scale,
                                f64::from(expected_outer.1) / scale,
                            );
                            let expected_position = if macos {
                                (expected_x, expected_y)
                            } else {
                                // Preserve the Windows physical-coordinate truncation.
                                (
                                    (expected_x * scale) as i32 as f64 / scale,
                                    (expected_y * scale) as i32 as f64 / scale,
                                )
                            };
                            assert!(
                                (native.position.x - expected_position.0).abs() < 1e-9
                                    && (native.position.y - expected_position.1).abs() < 1e-9,
                                "final position: {case}"
                            );
                            assert!(
                                native.calls.iter().all(|call| call.starts_with(if macos {
                                    "appkit"
                                } else {
                                    "tauri"
                                })),
                                "native path: {case}"
                            );
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn saved_frames_use_logical_client_sizes_and_destination_dpi() {
        for scale in [1.0, 1.5, 2.0] {
            let work = WorkArea {
                id: "secondary".into(),
                x: -2000.0,
                y: -300.0,
                width: 1200.0,
                height: 800.0,
                scale,
            }
            .inset(12.0);
            let saved = saved_frame(
                &work,
                ((-1900.0 * scale) as i32, (-200.0 * scale) as i32),
                ((600.0 * scale) as u32, (400.0 * scale) as u32),
                Some((584.0, 360.0)),
            );
            assert_eq!(
                remembered_client_size(Some(&saved), true),
                Some((584.0, 360.0))
            );
            let position = position_for(
                Some(&saved),
                std::slice::from_ref(&work),
                &work,
                (0.0, 0.0, 1000.0, 700.0),
                (600.0, 400.0),
            );
            assert!((position.0 + 1900.0 * scale).abs() < 0.001);
            assert!((position.1 + 200.0 * scale).abs() < 0.001);
            assert_eq!(position.2, scale);
            assert_eq!((work.width, work.height), (1176.0, 776.0));
        }
    }
    #[test]
    fn legacy_frames_and_invalid_sizes_fall_back_to_content_without_a_height_floor() {
        let legacy: SavedPosition = serde_json::from_value(json!({
            "monitor":"one", "x":0, "y":0, "offsetX":0.5, "offsetY":0.5
        }))
        .unwrap();
        assert_eq!(legacy.size, None);
        let measured = MeasuredContent::new(
            ContentFit::from_ready(&json!({"contentHeight":180,"pixelRatio":1})),
            Some(1.0),
        );
        let spec = kind_spec("insertTable").unwrap();
        assert_eq!(
            dialog_client_size(&spec, measured, Some(&legacy), false),
            (480.0, 180.0)
        );
        for size in [
            (0.0, 300.0),
            (500.0, f64::NAN),
            (f64::INFINITY, 300.0),
            (500.0, -1.0),
        ] {
            let saved = SavedPosition {
                size: Some(size),
                ..legacy.clone()
            };
            assert_eq!(
                dialog_client_size(&spec, measured, Some(&saved), false),
                (480.0, 180.0)
            );
        }
        let saved = SavedPosition {
            size: Some((600.0, 200.0)),
            ..legacy
        };
        assert_eq!(
            dialog_client_size(&spec, measured, Some(&saved), false),
            (600.0, 200.0)
        );
        let page = kind_spec("pageSize").unwrap();
        assert_eq!(
            dialog_client_size(&page, measured, Some(&saved), false),
            (420.0, 180.0)
        );
        // Retained, nonresizable dialogs still keep their already fitted live client.
        assert_eq!(
            dialog_client_size(&page, None, Some(&saved), true),
            (600.0, 200.0)
        );
    }
    #[test]
    fn immediate_user_resizes_are_saved_but_programmatic_frames_are_not() {
        let event = |transient, resized, programmed, actual| {
            transient_frame_event(
                transient,
                resized,
                programmed,
                actual,
                Some((100, 200)),
                (100, 200),
            )
        };
        assert!(event(true, true, None, (600, 400)));
        assert!(event(true, true, Some((600, 400)), (600, 400)));
        assert!(event(true, false, Some((600, 400)), (620, 420)));
        assert!(!event(true, true, Some((600, 400)), (620, 420)));
        assert!(!event(false, true, Some((600, 400)), (600, 400)));
    }
    #[test]
    fn immediate_user_move_then_close_keeps_the_new_position() {
        let now = Instant::now();
        let work = WorkArea {
            id: "display".into(),
            x: 0.0,
            y: 0.0,
            width: 1600.0,
            height: 1000.0,
            scale: 1.0,
        };
        let original = saved_frame(&work, (100, 200), (616, 440), Some((600.0, 400.0)));
        for preferences in [false, true] {
            let mut registry = Registry::default();
            let (registration, _) = register(&mut registry, snapshot(), false).unwrap();
            registry.preferences = Some(PreferencesLayout {
                applied_position: None,
                ready: true,
                transient_until: now + Duration::from_millis(500),
                programmatic_client: Some((600, 400)),
                programmatic_position: Some((100, 200)),
                pending_move: None,
            });
            let session = registry.sessions.get_mut(&registration.host_id).unwrap();
            session.transient_until = now + Duration::from_millis(500);
            session.programmatic_client = Some((600, 400));
            session.programmatic_position = Some((100, 200));
            let (until, client, position, pending) = if preferences {
                let state = registry.preferences.as_mut().unwrap();
                (
                    state.transient_until,
                    state.programmatic_client,
                    state.programmatic_position,
                    &mut state.pending_move,
                )
            } else {
                (
                    session.transient_until,
                    session.programmatic_client,
                    session.programmatic_position,
                    &mut session.pending_move,
                )
            };
            // A Moved event arrives one millisecond after reveal, with the same client size.
            if !transient_frame_event(
                now + Duration::from_millis(1) < until,
                false,
                client,
                (600, 400),
                position,
                (300, 350),
            ) {
                *pending = Some((now, saved_frame(&work, (300, 350), (616, 440), None)));
            }
            // Close drains the pending event before the debounced worker can run, without
            // recapturing a non-resize event that could overwrite a remembered user size.
            let (kind, pending) = if preferences {
                (
                    "preferences".to_string(),
                    registry.preferences.take().unwrap().pending_move,
                )
            } else {
                let session = registry.sessions.remove(&registration.host_id).unwrap();
                (session.snapshot.dialog_kind, session.pending_move)
            };
            let mut positions = HashMap::from([(kind.clone(), original.clone())]);
            let writes = pending
                .map(|(_, saved)| (kind.clone(), saved))
                .into_iter()
                .collect();
            merge_positions(&mut positions, writes);
            let saved = &positions[&kind];
            assert_eq!((saved.x, saved.y), (300.0, 350.0));
            assert_eq!(saved.size, original.size);
            let reopened = position_for(
                Some(saved),
                std::slice::from_ref(&work),
                &work,
                (0.0, 0.0, 1000.0, 700.0),
                (616.0, 440.0),
            );
            assert!((reopened.0 - 300.0).abs() < 0.001);
            assert!((reopened.1 - 350.0).abs() < 0.001);
            assert_eq!(reopened.2, 1.0);
        }
    }
    #[test]
    fn app_initiated_transient_move_is_ignored() {
        assert!(transient_frame_event(
            true,
            false,
            Some((600, 400)),
            (600, 400),
            Some((100, 200)),
            (100, 200),
        ));
        // An untagged move is never ignored just because it occurred during the time window.
        assert!(!transient_frame_event(
            true,
            false,
            None,
            (600, 400),
            None,
            (300, 350),
        ));
        assert!(!transient_frame_event(
            false,
            false,
            Some((600, 400)),
            (600, 400),
            Some((100, 200)),
            (100, 200),
        ));
    }
    #[test]
    fn moves_preserve_the_last_user_size_across_coalesced_and_separate_writes() {
        let original = SavedPosition {
            size: None,
            monitor: "one".into(),
            x: 10.0,
            y: 20.0,
            offset_x: 0.0,
            offset_y: 0.0,
        };
        let mut positions = HashMap::new();
        merge_positions(&mut positions, vec![("export".into(), original.clone())]);
        assert_eq!(positions["export"].size, None);
        let resized = SavedPosition {
            size: Some((600.0, 800.0)),
            ..original.clone()
        };
        let moved = SavedPosition {
            x: 100.0,
            ..original.clone()
        };
        merge_positions(
            &mut positions,
            vec![("export".into(), resized), ("export".into(), moved.clone())],
        );
        assert_eq!(positions["export"].size, Some((600.0, 800.0)));
        assert_eq!(positions["export"].x, 100.0);
        merge_positions(&mut positions, vec![("export".into(), moved)]);
        assert_eq!(positions["export"].size, Some((600.0, 800.0)));
        let resized = SavedPosition {
            size: Some((500.0, 300.0)),
            ..original
        };
        merge_positions(&mut positions, vec![("export".into(), resized)]);
        assert_eq!(positions["export"].size, Some((500.0, 300.0)));
    }
    #[test]
    fn work_area_margin_handles_even_tiny_screens() {
        let work = WorkArea {
            id: "tiny".into(),
            x: 0.0,
            y: 20.0,
            width: 10.0,
            height: 6.0,
            scale: 2.0,
        }
        .inset(12.0);
        assert!(work.width >= 1.0 && work.height >= 1.0);
        assert_eq!(work.clamp(-50.0, -50.0, 600.0, 800.0), (work.x, work.y));
    }
    #[test]
    fn content_fit_dialogs_fit_their_windows_to_the_measured_content() {
        for kind in [
            "vibeCodeGuide",
            "structureTemplates",
            "pageSize",
            "arrangementSpacing",
            "insertTable",
            "export",
            "engineInstall",
            "toolInstall",
        ] {
            assert_eq!(
                kind_spec(kind).unwrap().fit_content,
                kind != "structureTemplates"
            );
        }
    }
    #[test]
    fn ready_content_fit_is_typed_bounded_and_converted_through_the_pixel_ratio() {
        let mut ready = snapshot();
        ready.dialog_kind = "insertTable".into();
        ready.message_type = "ready".into();
        for data in [
            json!({}),
            json!({"contentHeight": 263, "pixelRatio": 2}),
            json!({"contentHeight": 262.5, "pixelRatio": 1.25}),
            json!({"contentHeight": 4096, "pixelRatio": 8}),
            json!({"contentHeight": 263, "pixelRatio": 0.5}),
        ] {
            ready.data = data;
            assert!(ready.validate().is_ok(), "{}", ready.data);
        }
        for data in [
            json!({"contentHeight": 263}),
            json!({"contentHeight": 0, "pixelRatio": 1}),
            json!({"contentHeight": -5, "pixelRatio": 1}),
            json!({"contentHeight": 4097, "pixelRatio": 1}),
            json!({"contentHeight": 16384, "pixelRatio": 16}),
            json!({"contentHeight": 1e308, "pixelRatio": 1}),
            json!({"contentHeight": 263, "pixelRatio": 0}),
            json!({"contentHeight": 263, "pixelRatio": 0.49}),
            json!({"contentHeight": 263, "pixelRatio": 8.01}),
            json!({"contentHeight": 263, "pixelRatio": 17}),
            json!({"contentHeight": "263", "pixelRatio": 1}),
            json!({"contentHeight": 263, "pixelRatio": 1, "width": 480}),
        ] {
            ready.data = data;
            assert!(ready.validate().is_err(), "{}", ready.data);
            assert_eq!(ContentFit::from_ready(&ready.data), None);
        }
        // A request still carries nothing.
        ready.message_type = "request".into();
        ready.data = json!({"contentHeight": 263, "pixelRatio": 1});
        assert!(ready.validate().is_err());
        let fit = |content_height, pixel_ratio, scale| {
            MeasuredContent::new(
                Some(ContentFit {
                    content_height,
                    pixel_ratio,
                }),
                Some(scale),
            )
            .unwrap()
        };
        // Same scale: CSS px are logical px. Retina and 150% monitors measure the same content.
        assert_eq!(fit(263.0, 1.0, 1.0).logical_height(240.0), 263.0);
        assert_eq!(fit(263.0, 2.0, 2.0).logical_height(240.0), 263.0);
        assert_eq!(fit(263.0, 1.5, 1.5).logical_height(240.0), 263.0);
        // WebView zoom or larger text (ratio above the monitor scale) grows the window.
        assert_eq!(fit(263.0, 1.25, 1.0).logical_height(240.0), 329.0);
        assert_eq!(fit(263.0, 1.875, 1.5).logical_height(240.0), 329.0);
        // Explicit caller floors are honored; production content fitting passes 1px.
        assert_eq!(fit(200.0, 1.0, 1.0).logical_height(240.0), 240.0);
        // No usable scale at measurement, or no measurement: the spec size applies.
        let measured = Some(ContentFit {
            content_height: 263.0,
            pixel_ratio: 2.0,
        });
        for scale in [
            None,
            Some(0.0),
            Some(0.25),
            Some(9.0),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert_eq!(MeasuredContent::new(measured, scale), None, "{scale:?}");
        }
        assert_eq!(MeasuredContent::new(None, Some(2.0)), None);
    }
    #[test]
    fn content_fit_converts_through_the_scale_at_measurement_not_at_reveal() {
        use std::cell::RefCell;
        // Measured on a 2x display (263 CSS px = 526 physical), revealed after the display
        // changed to 1x, 1.5x or stayed 2x: the logical height is the same 263 every time ...
        let measured = MeasuredContent::new(
            ContentFit::from_ready(&json!({"contentHeight": 263, "pixelRatio": 2})),
            Some(2.0),
        )
        .unwrap();
        assert_eq!(measured.logical_height(240.0), 263.0);
        // ... where converting with the reveal scale would have doubled it at 1x.
        assert_eq!(
            measured.fit.content_height * measured.fit.pixel_ratio,
            526.0
        );
        // Measured at 1x, revealed at 2x: still 263 logical, not 131.5 (collapsed to the floor).
        let measured_1x = MeasuredContent::new(
            ContentFit::from_ready(&json!({"contentHeight": 263, "pixelRatio": 1})),
            Some(1.0),
        )
        .unwrap();
        assert_eq!(measured_1x.logical_height(240.0), 263.0);
        // The physical client is the logical height at the destination (reveal) scale.
        for (reveal_scale, physical) in [(1.0, 263u32), (1.5, 395), (2.0, 526)] {
            let work = WorkArea {
                id: "display".into(),
                x: 0.0,
                y: 0.0,
                width: 1600.0,
                height: 1000.0,
                scale: reveal_scale,
            };
            let client = RefCell::new((0u32, 0u32));
            finish_placement(
                (
                    (100.0 * reveal_scale, 100.0 * reveal_scale, reveal_scale),
                    (480.0, measured.logical_height(240.0)),
                ),
                &work,
                true,
                None,
                |_, _| Ok(()),
                |w, h| {
                    *client.borrow_mut() = (w, h);
                    Ok(())
                },
                || {
                    let (w, h) = *client.borrow();
                    Ok(DialogFrame {
                        outer: (w, h + (28.0 * reveal_scale) as u32),
                        client: (w, h),
                    })
                },
            )
            .unwrap();
            assert_eq!(client.borrow().1, physical, "{reveal_scale}");
        }
    }
    #[test]
    fn absurd_content_fit_never_reaches_a_native_resize() {
        use std::cell::RefCell;
        // A buggy or hostile webview: rejected on the wire, and no measurement survives.
        let mut ready = snapshot();
        ready.dialog_kind = "insertTable".into();
        ready.message_type = "ready".into();
        ready.data = json!({"contentHeight": 16384, "pixelRatio": 16});
        assert!(ready.validate().is_err());
        assert_eq!(
            MeasuredContent::new(ContentFit::from_ready(&ready.data), Some(2.0)),
            None
        );
        // Even the largest accepted measurement, at the smallest accepted scale, and any height
        // that got this far, is bounded by the destination work area on the very first resize.
        let largest = MeasuredContent::new(
            ContentFit::from_ready(&json!({"contentHeight": 4096, "pixelRatio": 8})),
            Some(0.5),
        )
        .unwrap();
        for (scale, height) in [
            (2.0, largest.logical_height(240.0)),
            (1.0, 262144.0),
            (1.5, f64::MAX),
        ] {
            let work = WorkArea {
                id: "display".into(),
                x: 0.0,
                y: 25.0,
                width: 1440.0,
                height: 875.0,
                scale,
            };
            let resizes = RefCell::new(Vec::<(u32, u32)>::new());
            finish_placement(
                ((0.0, 25.0 * scale, scale), (480.0, height)),
                &work,
                true,
                None,
                |_, _| Ok(()),
                |w, h| {
                    resizes.borrow_mut().push((w, h));
                    Ok(())
                },
                || {
                    let (w, h) = *resizes.borrow().last().unwrap();
                    Ok(DialogFrame {
                        outer: (w, h + (28.0 * scale) as u32),
                        client: (w, h),
                    })
                },
            )
            .unwrap();
            let resizes = resizes.borrow();
            assert!(!resizes.is_empty());
            for &(w, h) in resizes.iter() {
                assert!(f64::from(w) <= (1440.0 * scale).ceil(), "{scale}: {w}");
                assert!(
                    f64::from(h) <= (875.0 * scale).ceil(),
                    "{scale} {height}: {h}"
                );
            }
            // And the final frame fits the work area.
            let (_, h) = *resizes.last().unwrap();
            assert!(f64::from(h) + f64::from((28.0 * scale) as u32) <= 875.0 * scale);
        }
    }
    #[test]
    fn fitted_dialog_client_is_never_shorter_than_its_content_unless_the_work_area_is() {
        use std::cell::RefCell;
        for (scale, content, area_height) in [
            (1.0, 263.0, 1000.0),
            (1.25, 263.0, 1000.0),
            (1.5, 263.0, 1000.0),
            (2.0, 263.0, 1000.0),
            (1.25, 329.0, 1000.0),
            (1.5, 600.0, 400.0),
        ] {
            let work = WorkArea {
                id: "display".into(),
                x: 0.0,
                y: 0.0,
                width: 1600.0,
                height: area_height,
                scale,
            };
            let client = RefCell::new((0u32, 0u32));
            let position = RefCell::new((0.0, 0.0));
            finish_placement(
                ((100.0 * scale, 900.0 * scale, scale), (480.0, content)),
                &work,
                true,
                None,
                |x, y| {
                    *position.borrow_mut() = (x, y);
                    Ok(())
                },
                |w, h| {
                    *client.borrow_mut() = (w, h);
                    Ok(())
                },
                || {
                    let (w, h) = *client.borrow();
                    let decorations = (2.0 * scale) as u32;
                    let title_bar = (28.0 * scale) as u32;
                    Ok(DialogFrame {
                        outer: (w + decorations, h + title_bar),
                        client: (w, h),
                    })
                },
            )
            .unwrap();
            let (w, h) = *client.borrow();
            let title_bar = f64::from((28.0 * scale) as u32);
            assert!(f64::from(w) >= 480.0 * scale);
            if content * scale + title_bar <= area_height * scale {
                // The window holds all of the content: the buttons are never cut off.
                assert!(f64::from(h) >= content * scale, "{scale} {content}: {h}");
                // And no more than a rounding pixel: no empty band below the buttons.
                assert!(
                    f64::from(h) < content * scale + 1.0,
                    "{scale} {content}: {h}"
                );
            } else {
                // Clamped to the screen, with the whole frame inside the work area.
                assert_eq!(f64::from(h) + title_bar, (area_height * scale).floor());
            }
            let (_, y) = *position.borrow();
            assert!(y >= 0.0);
            assert!(y + f64::from(h) + title_bar <= area_height * scale + 0.001);
        }
    }
    #[test]
    fn insert_table_registers_and_validates_typed_payloads() {
        let spec = kind_spec("insertTable").unwrap();
        assert!(!spec.maximizable);
        assert!(spec.resizable);
        assert_eq!(spec.size, (480.0, 240.0));
        assert_eq!(spec.min_size, (360.0, 120.0));
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
            size: None,
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
            ((0.0, 0.0, 1.5), kind_spec("export").unwrap().size),
            &work,
            false,
            None,
            |_, _| Ok(()),
            |w, h| {
                sizes.borrow_mut().push((w, h));
                Ok(())
            },
            || {
                Ok(DialogFrame {
                    outer: (780, 960),
                    client: (780, 930),
                })
            },
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
