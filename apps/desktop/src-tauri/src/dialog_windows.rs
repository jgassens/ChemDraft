//! Document-owned, modeless native dialog host. Webviews receive drafts, never document authority.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, LazyLock, Mutex},
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
    // (clamped to the work area); larger remembered user sizes are retained unless preserving
    // the complete user frame takes precedence.
    fit_content: bool,
    // Scrollable Preferences fits on first open, then keeps the user's whole viewport frame.
    preserve_user_frame: bool,
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
            preserve_user_frame: true,
        }),
        "atomProblem" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Atom problem",
            size: (460.0, 360.0),
            min_size: (360.0, 260.0),
            fit_content: false,
            preserve_user_frame: false,
        }),
        "vibeCodeGuide" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Vibe Code Your Own Plugin",
            size: (480.0, 400.0),
            min_size: (420.0, 240.0),
            fit_content: true,
            preserve_user_frame: false,
        }),
        "structureTemplates" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Templates",
            size: (620.0, 700.0),
            min_size: (420.0, 360.0),
            fit_content: false,
            preserve_user_frame: false,
        }),
        "pageSize" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: false,
            title: "Custom Page Size",
            size: (420.0, 300.0),
            min_size: (360.0, 260.0),
            fit_content: true,
            preserve_user_frame: false,
        }),
        "arrangementSpacing" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Adjust arrangement spacing",
            size: (540.0, 600.0),
            min_size: (360.0, 260.0),
            fit_content: true,
            preserve_user_frame: false,
        }),
        "customColor" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Custom Color",
            size: (460.0, 320.0),
            min_size: (360.0, 240.0),
            fit_content: true,
            preserve_user_frame: false,
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
            preserve_user_frame: false,
        }),
        "reactionConditions" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Reaction conditions",
            size: (560.0, 620.0),
            min_size: (380.0, 420.0),
            fit_content: false,
            preserve_user_frame: false,
        }),
        "export" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Export",
            size: (520.0, 620.0),
            min_size: (420.0, 360.0),
            fit_content: true,
            preserve_user_frame: false,
        }),
        "engineInstall" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Engine installation",
            size: (520.0, 480.0),
            min_size: (420.0, 380.0),
            fit_content: true,
            preserve_user_frame: false,
        }),
        "toolInstall" => Ok(DialogKindSpec {
            maximizable: false,
            resizable: true,
            title: "Tool installation",
            size: (520.0, 460.0),
            min_size: (420.0, 380.0),
            fit_content: true,
            preserve_user_frame: false,
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
#[serde(deny_unknown_fields)]
struct CustomColorSnapshot {
    title: String,
    swatch: u8,
    slot: u8,
    color: Option<String>,
}
fn valid_custom_color(hex: &str) -> bool {
    hex.len() == 7
        && hex.starts_with('#')
        && hex.as_bytes()[1..]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum CustomColorAction {
    Apply { hex: String },
    Clear {},
    Cancel {},
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
    #[serde(default)]
    content_width: Option<f64>,
    pixel_ratio: f64,
}
/// A dialog form is far shorter than this; anything taller is not a measurement.
const CONTENT_FIT_MAX_HEIGHT: f64 = 4096.0;
const CONTENT_FIT_MAX_WIDTH: f64 = 4096.0;
/// Device pixel ratios and native scale factors outside this range are not a real display.
const CONTENT_FIT_SCALE_RANGE: std::ops::RangeInclusive<f64> = 0.5..=8.0;
impl ContentFit {
    fn from_ready(data: &Value) -> Option<Self> {
        serde_json::from_value::<Self>(data.clone())
            .ok()
            .filter(|f| {
                !data.get("contentWidth").is_some_and(Value::is_null)
                    && f.content_height.is_finite()
                    && f.content_height > 0.0
                    && f.content_height <= CONTENT_FIT_MAX_HEIGHT
                    && f.content_width.is_none_or(|width| {
                        width.is_finite() && width > 0.0 && width <= CONTENT_FIT_MAX_WIDTH
                    })
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
    fn logical_width(self) -> Option<f64> {
        self.fit
            .content_width
            .map(|width| (width * self.fit.pixel_ratio / self.scale_at_ready).ceil())
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
    fn validate(
        &self,
        documents: &super::document_windows::DocumentWindowRegistry,
    ) -> Result<(), String> {
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len()
            > if self.is_preview() {
                MAX_PREVIEW_BYTES
            } else {
                MAX_BYTES
            }
            || self.protocol_version != 1
            || registered_owner(documents, &self.owner_window_id).is_none()
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
            "snapshot" if self.dialog_kind == "customColor" => {
                self.data.get("color").is_some()
                    && serde_json::from_value::<CustomColorSnapshot>(self.data.clone()).is_ok_and(
                        |s| {
                            valid_title(&s.title)
                                && !s.title.contains('\0')
                                && (1..=4).contains(&s.swatch)
                                && (1..=2).contains(&s.slot)
                                && s.color.as_deref().is_none_or(valid_custom_color)
                        },
                    )
            }
            "action" if self.dialog_kind == "customColor" => serde_json::from_value::<
                CustomColorAction,
            >(self.data.clone())
            .is_ok_and(|a| match a {
                CustomColorAction::Apply { hex } => valid_custom_color(&hex),
                CustomColorAction::Clear {} | CustomColorAction::Cancel {} => true,
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
    content_fit: Option<MeasuredContent>,
    transient_until: Instant,
    programmatic_client: Option<(u32, u32)>,
    programmatic_position: Option<(i32, i32)>,
    pending_move: Option<(Instant, SavedPosition)>,
    last_normal: Option<NormalFrame>,
    recovery_pending: bool,
}
impl Default for PreferencesLayout {
    fn default() -> Self {
        Self {
            ready: false,
            content_fit: None,
            transient_until: Instant::now(),
            applied_position: None,
            programmatic_client: None,
            programmatic_position: None,
            pending_move: None,
            last_normal: None,
            recovery_pending: false,
        }
    }
}
impl PreferencesLayout {
    fn report_content(&mut self, measured: Option<MeasuredContent>) -> bool {
        let first_ready = !self.ready;
        self.ready = true;
        self.content_fit = measured;
        first_ready
    }

    fn record_move(&mut self, position: (i32, i32), scale: f64, saved: SavedPosition) {
        if !valid_saved_frame(&saved) {
            return;
        }
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

    fn record_frame(&mut self, normal: Option<NormalFrame>, resized: bool) {
        let Some(normal) = normal else {
            return;
        };
        let mut saved = normal.saved.clone();
        if !resized {
            saved.size = self.pending_move.as_ref().and_then(|(_, saved)| saved.size);
        }
        let physical = normal.physical;
        self.last_normal = Some(normal);
        if resized {
            self.applied_position = None;
            self.pending_move = Some((Instant::now(), saved));
        } else {
            self.record_move(physical.position, physical.scale, saved);
        }
    }
}
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn valid_owner_id(owner: &str) -> bool {
    token(owner) && (owner == "main" || owner.strip_prefix("doc-").is_some_and(|id| !id.is_empty()))
}

fn registered_owner(
    documents: &super::document_windows::DocumentWindowRegistry,
    owner: &str,
) -> Option<super::document_windows::DocumentWindow> {
    valid_owner_id(owner)
        .then(|| documents.registered_document_window(owner))
        .flatten()
}

/// Syntax classification for native styling only; never an authorization check.
pub(crate) fn dialog_label_parts(label: &str) -> Option<(&str, &str, &str)> {
    let (rest, slot) = label.strip_prefix("dialog-")?.rsplit_once('-')?;
    let (owner, kind) = rest.rsplit_once('-')?;
    (valid_owner_id(owner)
        && kind != "preferences"
        && kind_spec(kind).is_ok()
        && !slot.is_empty()
        && slot.len() <= 20
        && slot.bytes().all(|c| c.is_ascii_digit()))
    .then_some((owner, kind, slot))
}

fn parse_dialog_label<'a>(
    documents: &super::document_windows::DocumentWindowRegistry,
    label: &'a str,
) -> Option<(&'a str, &'a str, &'a str)> {
    let parts = dialog_label_parts(label)?;
    registered_owner(documents, parts.0)?;
    Some(parts)
}

pub(crate) fn is_dialog_label(label: &str) -> bool {
    label == super::PREFERENCES_WINDOW_LABEL || dialog_label_parts(label).is_some()
}

fn authorize_owner(
    documents: &super::document_windows::DocumentWindowRegistry,
    owner: &str,
    caller: &str,
) -> Result<(), String> {
    if caller != owner
        || registered_owner(documents, owner).is_none_or(|window| window.native_label != caller)
    {
        return Err("Unknown dialog owner".into());
    }
    Ok(())
}
fn authorize(
    documents: &super::document_windows::DocumentWindowRegistry,
    session: &Session,
    sender: &str,
    owner: bool,
    message: Option<&Message>,
) -> Result<(), String> {
    let registered = parse_dialog_label(documents, &session.registration.window_label);
    if registered.is_none_or(|(id, kind, _)| {
        id != session.snapshot.owner_window_id || kind != session.snapshot.dialog_kind
    }) || (if owner {
        authorize_owner(documents, &session.snapshot.owner_window_id, sender).is_err()
    } else {
        sender != session.registration.window_label
    }) || message.is_some_and(|m| !m.same_session(&session.snapshot))
    {
        return Err(
            "Dialog caller, session, or revision does not match its registered native window"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod document_registry_authorization_tests {
    use super::*;

    fn snapshot_for(owner: &str) -> Message {
        serde_json::from_value(json!({
            "protocolVersion": 1, "ownerWindowId": owner, "documentTabId": "same-tab",
            "dialogKind": "pageSize", "sessionId": "same-session", "requestId": "same-request",
            "snapshotRevision": 1, "type": "snapshot",
            "data": {"title": "Drawing", "width": 8.5, "height": 11, "unit": "inch"}
        }))
        .unwrap()
    }

    #[test]
    fn two_owners_do_not_collide_and_dismissing_a_keeps_b_and_preferences() {
        let documents = crate::document_windows::DocumentWindowRegistry::with_main();
        documents.set_ready("main");
        documents.register("doc-b", "doc-b").unwrap();
        documents.set_ready("doc-b");
        documents.mark_activated("doc-b");
        assert!(documents.set_preferences_owner("main"));
        let mut dialogs = Registry {
            preferences: Some(PreferencesLayout::default()),
            ..Registry::default()
        };
        let a = snapshot_for("main");
        let b = snapshot_for("doc-b");
        let (ra, build_a) = register(&documents, &mut dialogs, a.clone(), false).unwrap();
        let (rb, build_b) = register(&documents, &mut dialogs, b.clone(), false).unwrap();
        assert!(build_a && build_b);
        assert_ne!(ra.host_id, rb.host_id);
        assert_eq!(ra.window_label, "dialog-main-pageSize-1");
        assert_eq!(rb.window_label, "dialog-doc-b-pageSize-2");
        assert!(
            !register(&documents, &mut dialogs, a.clone(), false)
                .unwrap()
                .1
        );
        let mut duplicate = a.clone();
        duplicate.session_id = "another-session".into();
        assert!(register(&documents, &mut dialogs, duplicate, false).is_err());
        assert!(authorize_owner(&documents, "main", "doc-b").is_err());
        assert!(authorize_owner(&documents, "doc-b", "main").is_err());
        assert!(authorize_owner(&documents, "doc-b", "toolset-main").is_err());
        assert!(authorize(
            &documents,
            &dialogs.sessions[&ra.host_id],
            "doc-b",
            true,
            Some(&a)
        )
        .is_err());
        assert!(authorize(
            &documents,
            &dialogs.sessions[&rb.host_id],
            "main",
            true,
            Some(&b)
        )
        .is_err());
        assert!(authorize(
            &documents,
            &dialogs.sessions[&ra.host_id],
            &rb.window_label,
            false,
            Some(&a)
        )
        .is_err());
        assert!(authorize(
            &documents,
            &dialogs.sessions[&ra.host_id],
            "main",
            true,
            Some(&b)
        )
        .is_err());

        documents.reown_preferences(Some("main"));
        let dismissed = take_owned_sessions(&mut dialogs, "main");
        assert_eq!(dismissed.len(), 1);
        assert_eq!(dismissed[0].registration.host_id, ra.host_id);
        assert!(dialogs.preferences.is_some());
        assert_eq!(
            documents.owner_of("preferences").unwrap().window_id,
            "doc-b"
        );
        assert_eq!(dialogs.sessions.len(), 1);
        assert!(authorize(
            &documents,
            &dialogs.sessions[&rb.host_id],
            &rb.window_label,
            false,
            Some(&b)
        )
        .is_ok());
        assert!(take_owned_sessions(&mut dialogs, "main").is_empty());

        // The cap remains application-wide, rather than 16 sessions per owner.
        for index in 1..16 {
            let mut message = snapshot_for(if index % 2 == 0 { "main" } else { "doc-b" });
            message.document_tab_id = format!("tab-{index}");
            register(&documents, &mut dialogs, message, false).unwrap();
        }
        let mut overflow = snapshot_for("main");
        overflow.document_tab_id = "overflow".into();
        assert_eq!(
            register(&documents, &mut dialogs, overflow, false)
                .err()
                .as_deref(),
            Some("Too many dialog windows are open")
        );
    }

    #[test]
    fn labels_round_trip_registered_ids_and_reject_malformed_or_unregistered_owners() {
        let documents = crate::document_windows::DocumentWindowRegistry::with_main();
        documents
            .register("doc-a-1234-5678", "doc-a-1234-5678")
            .unwrap();
        let mut dialogs = Registry::default();
        for owner in ["main", "doc-a-1234-5678"] {
            let message = snapshot_for(owner);
            let (registration, _) = register(&documents, &mut dialogs, message, false).unwrap();
            let (parsed_owner, kind, slot) =
                parse_dialog_label(&documents, &registration.window_label).unwrap();
            assert_eq!(parsed_owner, owner);
            assert_eq!(kind, "pageSize");
            assert_eq!(
                format!("dialog-{parsed_owner}-{kind}-{slot}"),
                registration.window_label
            );
            assert_eq!(
                documents
                    .owner_of(&registration.window_label)
                    .unwrap()
                    .window_id,
                owner
            );
        }
        documents.register("doc-b/evil", "doc-b/evil").unwrap();
        for label in [
            "dialog-doc-missing-pageSize-1",
            "dialog-doc-b/evil-pageSize-1",
            "dialog-doc-a\\b-pageSize-1",
            "dialog-doc-a:b-pageSize-1",
            "dialog--pageSize-1",
            "dialog-toolset-main-pageSize-1",
            "dialog-main-unknown-1",
            "dialog-main-preferences-1",
            "dialog-main-pageSize-",
            "dialog-main-pageSize-../main",
            "dialog-main-pageSize-1-extra",
            "dialog-main-pageSize-123456789012345678901",
        ] {
            assert!(parse_dialog_label(&documents, label).is_none(), "{label}");
            assert!(documents.owner_of(label).is_none(), "{label}");
        }
        assert!(snapshot_for("doc-b/evil").validate(&documents).is_err());
        documents.remove("doc-a-1234-5678");
        assert!(parse_dialog_label(&documents, "dialog-doc-a-1234-5678-pageSize-2").is_none());
    }

    #[test]
    fn dialog_envelopes_and_sessions_require_a_live_registered_document() {
        let documents = crate::document_windows::DocumentWindowRegistry::default();
        let mut message: Message = serde_json::from_value(json!({
            "protocolVersion": 1, "ownerWindowId": "main", "documentTabId": "tab-1",
            "dialogKind": "pageSize", "sessionId": "session-1", "requestId": "request-1",
            "snapshotRevision": 1, "type": "snapshot",
            "data": {"title": "Drawing", "width": 8.5, "height": 11, "unit": "inch"}
        }))
        .unwrap();
        assert!(message.validate(&documents).is_err());
        documents.register("doc-other", "doc-other").unwrap();
        message.owner_window_id = "doc-other".into();
        assert!(message.validate(&documents).is_ok());
        let mut dialogs = Registry::default();
        let (registration, _) = register(&documents, &mut dialogs, message.clone(), false).unwrap();
        let session = &dialogs.sessions[&registration.host_id];
        assert!(authorize(&documents, session, "doc-other", true, Some(&message)).is_ok());
        assert!(authorize(&documents, session, "main", true, Some(&message)).is_err());
        documents.remove("doc-other");
        assert!(message.validate(&documents).is_err());
        assert!(authorize(&documents, session, "doc-other", true, Some(&message)).is_err());
    }
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
        let text = serde_json::to_string(&json!({ "senderWindowId": session.snapshot.owner_window_id, "windowLabel": session.registration.window_label, "message": message })).map_err(|e| e.to_string())?;
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
        .send(delivery(
            session,
            &session.snapshot.owner_window_id,
            message,
        )?)
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
    documents: &super::document_windows::DocumentWindowRegistry,
    registry: &mut Registry,
    message: Message,
    quitting: bool,
) -> Result<(Registration, bool), String> {
    if quitting {
        return Err(super::QUITTING_WINDOW_REFUSAL.into());
    }
    message.validate(documents)?;
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
        s.snapshot.owner_window_id == message.owner_window_id
            && s.snapshot.document_tab_id == message.document_tab_id
            && s.snapshot.dialog_kind == message.dialog_kind
    }) {
        return Err("A dialog for this drawing is already open".into());
    }
    registry.next_slot += 1;
    let registration = Registration {
        host_id: format!("h{:016x}", registry.next_slot),
        window_label: format!(
            "dialog-{}-{}-{}",
            message.owner_window_id, message.dialog_kind, registry.next_slot
        ),
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
    authorize_owner(
        &app.state::<super::document_windows::DocumentWindowRegistry>(),
        &message.owner_window_id,
        window.label(),
    )?;
    if app.get_webview_window(window.label()).is_none() {
        return Err("Unknown dialog owner".into());
    }
    let _creation = super::lock_window_creation()?;
    if !window.is_visible().unwrap_or(false) {
        return Err("The document window is hidden; no dialog can open".into());
    }
    let (registration, build) = register(
        &app.state::<super::document_windows::DocumentWindowRegistry>(),
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
    // Let the activation click reach dialog controls on macOS. Other platforms retain
    // their existing click behavior; first-mouse acceptance is an AppKit policy.
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder;
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
    authorize(
        &window.state::<super::document_windows::DocumentWindowRegistry>(),
        session,
        window.label(),
        false,
        None,
    )?;
    session
        .snapshot
        .validate(&window.state::<super::document_windows::DocumentWindowRegistry>())?;
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
    message.validate(&window.state::<super::document_windows::DocumentWindowRegistry>())?;
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
    let (reveal, refit) = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let session = registry
            .sessions
            .get_mut(&host_id)
            .ok_or("Unknown dialog host")?;
        authorize(
            &window.state::<super::document_windows::DocumentWindowRegistry>(),
            session,
            window.label(),
            false,
            Some(&message),
        )?;
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
        let refit = message.message_type == "ready"
            && session.ready
            && kind_spec(&session.snapshot.dialog_kind)?.fit_content
            && ContentFit::from_ready(&message.data).is_some();
        if reveal || refit {
            session.content_fit =
                MeasuredContent::new(ContentFit::from_ready(&message.data), scale_at_ready);
        }
        session.ready |= reveal;
        // Only this Rust-validated path can write the owner's private channel.
        // Later fit reports are host-local; replaying ready to an install owner would republish
        // its snapshot and create a content/ready feedback loop.
        if !refit {
            send_owner(session, window.label(), &message)?;
        }
        (reveal, refit)
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
    } else if refit {
        let target = window.clone();
        if let Err(error) = super::run_on_main_thread_blocking(&window, move || {
            let (kind, content_fit) = REGISTRY
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .sessions
                .values()
                .find(|s| s.registration.window_label == target.label())
                .map(|s| (s.snapshot.dialog_kind.clone(), s.content_fit))
                .ok_or("Unknown dialog window")?;
            // No reveal/focus: a status update must not activate a hidden/suspended dialog.
            place_content_window(&target, &kind, content_fit, true)
        })
        .and_then(|result| result)
        {
            if message.dialog_kind != "customColor" {
                return Err(error);
            }
            // A mode/error change already reached the form; placement must not mask validation.
            eprintln!("Could not refit custom color dialog: {error}");
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
    message.validate(&window.state::<super::document_windows::DocumentWindowRegistry>())?;
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
    authorize(
        &window.state::<super::document_windows::DocumentWindowRegistry>(),
        session,
        window.label(),
        true,
        Some(&message),
    )?;
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
            authorize(
                &window.state::<super::document_windows::DocumentWindowRegistry>(),
                session,
                window.label(),
                true,
                None,
            )?;
        } else if !super::is_document_window(&app, window.label()) {
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
    let _ = send_owner(session, &session.snapshot.owner_window_id, &closed);
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
fn take_owned_sessions(registry: &mut Registry, owner_window_id: &str) -> Vec<Session> {
    let ids: Vec<_> = registry
        .sessions
        .iter()
        .filter(|(_, session)| session.snapshot.owner_window_id == owner_window_id)
        .map(|(id, _)| id.clone())
        .collect();
    ids.into_iter()
        .filter_map(|id| registry.sessions.remove(&id))
        .collect()
}

fn dismiss_session<R: Runtime>(app: &tauri::AppHandle<R>, mut session: Session, reason: &str) {
    flush_position(app, &mut session);
    notify_closed(&session, reason);
    if let Some(window) = app.get_webview_window(&session.registration.window_label) {
        let _ = window.destroy();
    }
}

pub(crate) fn dismiss_owned<R: Runtime>(
    app: &tauri::AppHandle<R>,
    owner_window_id: &str,
    reason: &str,
) {
    // Preserve Preferences only with a ready survivor; otherwise retain last-window teardown.
    if reason != "quit" && !reown_preferences(app, Some(owner_window_id)) {
        flush_preferences(app, PreferencesClose::Close);
        if let Some(window) = app.get_webview_window(super::PREFERENCES_WINDOW_LABEL) {
            let _ = window.destroy();
        }
    }
    let sessions = take_owned_sessions(
        &mut REGISTRY.lock().unwrap_or_else(|p| p.into_inner()),
        owner_window_id,
    );
    for session in sessions {
        dismiss_session(app, session, reason);
    }
}

/// Quit retains the existing all-dialog teardown, including Preferences frame persistence.
pub(crate) fn dismiss_all<R: Runtime>(app: &tauri::AppHandle<R>, reason: &str) {
    flush_preferences(app, PreferencesClose::Close);
    if let Some(window) = app.get_webview_window(super::PREFERENCES_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    let owners: std::collections::BTreeSet<_> = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .values()
        .map(|session| session.snapshot.owner_window_id.clone())
        .collect();
    for owner in owners {
        dismiss_owned(app, &owner, reason);
    }
}

pub(crate) fn reown_preferences<R: Runtime>(
    app: &tauri::AppHandle<R>,
    closing_owner: Option<&str>,
) -> bool {
    let Some(owner) = app
        .state::<super::document_windows::DocumentWindowRegistry>()
        .reown_preferences(closing_owner)
    else {
        return false;
    };
    let Some(window) = app.get_webview_window(super::PREFERENCES_WINDOW_LABEL) else {
        return true;
    };
    #[cfg(windows)]
    {
        let app = app.clone();
        let target = window.clone();
        let result = super::run_on_main_thread_blocking(&window, move || {
            use windows_sys::Win32::{
                Foundation::{GetLastError, SetLastError},
                UI::WindowsAndMessaging::{
                    GetWindow, SetWindowLongPtrW, GWLP_HWNDPARENT, GW_OWNER,
                },
            };
            let hwnd = target.hwnd().map_err(|e| e.to_string())?.0 as _;
            let owner_hwnd = app
                .get_webview_window(&owner.native_label)
                .ok_or("Preferences owner window disappeared")?
                .hwnd()
                .map_err(|e| e.to_string())?
                .0 as isize;
            unsafe {
                if GetWindow(hwnd, GW_OWNER) as isize == owner_hwnd {
                    return Ok(());
                }
                SetLastError(0);
                if SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner_hwnd) == 0 {
                    let error = GetLastError();
                    if error != 0 {
                        return Err(format!(
                            "Could not re-own Preferences: Windows error {error}"
                        ));
                    }
                }
            }
            Ok(())
        })
        .and_then(|result| result);
        if let Err(error) = result {
            eprintln!("{error}");
        }
    }
    #[cfg(not(windows))]
    {
        // macOS dialogs remain unparented floating windows; only logical ownership changes.
        let _ = (window, owner);
    }
    true
}

pub(crate) fn prepare_preferences() {
    REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .preferences = Some(PreferencesLayout {
        applied_position: None,
        content_fit: None,
        ready: false,
        transient_until: Instant::now() + Duration::from_millis(500),
        programmatic_client: None,
        programmatic_position: None,
        pending_move: None,
        last_normal: None,
        recovery_pending: false,
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
    let reveal = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let state = registry
            .preferences
            .as_mut()
            .ok_or("Preferences is not open")?;
        state.report_content(measured)
    };
    // Preferences has a scrolling body. Subsequent observers are metadata only, including
    // reports while hidden, suspended or iconic: no placement or minimum-size setters.
    if !reveal {
        return Ok(());
    }
    let target = window.clone();
    super::run_on_main_thread_blocking(&window, move || {
        place_content_window(&target, "preferences", measured, false)?;
        show_on_main(&target)?;
        Ok(())
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
    if super::owned_document_webview(window.app_handle(), window.label())
        .is_none_or(|owner| !owner.is_visible().unwrap_or(false))
    {
        return Err("Dialog owner is hidden".into());
    }
    let preferences = window.label() == super::PREFERENCES_WINDOW_LABEL;
    if preferences {
        if let Some(state) = REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferences
            .as_mut()
        {
            state.recovery_pending = true;
        }
    } else {
        mark_transient(window.label());
    }
    window.unminimize().map_err(|e| e.to_string())?;
    if !preferences {
        let (kind, content_fit) = REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sessions
            .values()
            .find(|s| s.registration.window_label == window.label())
            .map(|s| (s.snapshot.dialog_kind.clone(), s.content_fit))
            .ok_or("Unknown dialog window")?;
        place_content_window(window, &kind, content_fit, true)?;
    }
    window.show().map_err(|e| e.to_string())?;
    if preferences {
        recover_preferences_frame(window)?;
    }
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
    // Logical client size, independent of monitor DPI; old position-only files load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<(f64, f64)>,
    monitor: String,
    x: f64,
    y: f64,
    offset_x: f64,
    offset_y: f64,
}
fn valid_client_size((width, height): (f64, f64)) -> bool {
    // 32767 is a Win32 sizing sentinel, not a usable dialog dimension. Bound stored
    // logical dimensions too, before they can be multiplied by a destination DPI.
    [width, height]
        .iter()
        .all(|value| value.is_finite() && *value > 0.0 && *value < 32767.0)
}
fn valid_saved_frame(saved: &SavedPosition) -> bool {
    [saved.x, saved.y, saved.offset_x, saved.offset_y]
        .iter()
        .all(|value| value.is_finite())
        && saved.size.is_none_or(valid_client_size)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PhysicalNormalFrame {
    position: (i32, i32),
    outer: (u32, u32),
    client: (u32, u32),
    scale: f64,
}

#[derive(Clone)]
struct NormalFrame {
    saved: SavedPosition,
    physical: PhysicalNormalFrame,
}
impl NormalFrame {
    fn validated(work: &WorkArea, physical: PhysicalNormalFrame) -> Option<Self> {
        let PhysicalNormalFrame {
            position,
            outer,
            client,
            scale,
        } = physical;
        if !scale.is_finite()
            || scale <= 0.0
            || (scale - work.scale).abs() > 0.001
            || [outer.0, outer.1, client.0, client.1]
                .iter()
                .any(|value| *value == 0 || *value == 32767)
            || client.0 > outer.0
            || client.1 > outer.1
            // Reject torn client/outer reads, including decoration-sized client remnants.
            || f64::from(outer.0 - client.0) > 256.0 * scale
            || f64::from(outer.1 - client.1) > 256.0 * scale
        {
            return None;
        }
        let x = f64::from(position.0) / scale;
        let y = f64::from(position.1) / scale;
        // Only the known parked point outside the sampled monitor is special. Negative
        // coordinates (even below -32000 on a large desktop) are otherwise legitimate.
        if position == (-32000, -32000)
            && !(x >= work.x && x < work.x + work.width && y >= work.y && y < work.y + work.height)
        {
            return None;
        }
        let work = WorkArea {
            scale,
            ..work.clone()
        };
        // This is the sole physical -> logical client conversion for a sampled frame.
        let saved = saved_frame(
            &work,
            position,
            outer,
            Some((f64::from(client.0) / scale, f64::from(client.1) / scale)),
        );
        valid_saved_frame(&saved).then_some(Self { saved, physical })
    }

    fn reachable(&self, monitors: &[WorkArea]) -> bool {
        let width = f64::from(self.physical.outer.0) / self.physical.scale;
        let height = f64::from(self.physical.outer.1) / self.physical.scale;
        monitors.iter().any(|work| {
            self.saved.x >= work.x
                && self.saved.y >= work.y
                && self.saved.x + width <= work.x + work.width
                && self.saved.y + height <= work.y + work.height
        })
    }

    fn close_frame(
        self,
        programmed_client: Option<(u32, u32)>,
        programmed_position: Option<(i32, i32)>,
    ) -> Option<SavedPosition> {
        if programmed_client == Some(self.physical.client)
            && programmed_position == Some(self.physical.position)
        {
            return None;
        }
        let mut saved = self.saved;
        if programmed_client == Some(self.physical.client) {
            saved.size = None;
        }
        Some(saved)
    }
}

#[cfg(windows)]
fn native_normal_geometry<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<PhysicalNormalFrame> {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{
                GetClientRect, GetWindow, GetWindowLongW, GetWindowPlacement, GetWindowRect,
                IsIconic, IsWindowVisible, IsZoomed, GWL_EXSTYLE, GW_OWNER, SW_HIDE, SW_SHOWNORMAL,
                WINDOWPLACEMENT, WS_EX_TOOLWINDOW,
            },
        },
    };
    let hwnd = window.hwnd().ok()?.0 as _;
    let owner = super::owned_document_webview(window.app_handle(), window.label())?;
    let owner_hwnd = owner.hwnd().ok()?.0 as _;
    // SAFETY: these handles belong to live Tauri windows; every output is initialized and sized.
    unsafe {
        let native_owner = GetWindow(hwnd, GW_OWNER);
        if IsIconic(hwnd) != 0
            || IsZoomed(hwnd) != 0
            || IsIconic(owner_hwnd) != 0
            || IsWindowVisible(owner_hwnd) == 0
            || (!native_owner.is_null()
                && (IsIconic(native_owner) != 0 || IsWindowVisible(native_owner) == 0))
        {
            return None;
        }
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        let mut outer = RECT::default();
        let mut client = RECT::default();
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetWindowPlacement(hwnd, &mut placement) == 0
            || !(placement.showCmd == SW_SHOWNORMAL as u32
                || (placement.showCmd == SW_HIDE as u32 && IsWindowVisible(hwnd) == 0))
            || GetWindowRect(hwnd, &mut outer) == 0
            || GetClientRect(hwnd, &mut client) == 0
            || GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info) == 0
        {
            return None;
        }
        let offset = if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW == 0 {
            (
                info.rcWork.left - info.rcMonitor.left,
                info.rcWork.top - info.rcMonitor.top,
            )
        } else {
            (0, 0)
        };
        // GetWindowRect is in SCREEN coordinates. Only rcNormalPosition is in workspace
        // coordinates; add its work-area inset once, never the monitor origin (see main placement).
        let normal = placement.rcNormalPosition;
        if !normal_rect_matches_live(
            (outer.left, outer.top, outer.right, outer.bottom),
            (normal.left, normal.top, normal.right, normal.bottom),
            offset,
        ) {
            // In particular, do not accept a stale live read during native restoration.
            return None;
        }
        let dimension =
            |end: i32, start: i32| u32::try_from(i64::from(end) - i64::from(start)).ok();
        let dpi = GetDpiForWindow(hwnd);
        if dpi == 0 {
            return None;
        }
        if IsIconic(hwnd) != 0
            || IsZoomed(hwnd) != 0
            || IsIconic(owner_hwnd) != 0
            || IsWindowVisible(owner_hwnd) == 0
            || (!native_owner.is_null()
                && (IsIconic(native_owner) != 0 || IsWindowVisible(native_owner) == 0))
        {
            return None;
        }
        Some(PhysicalNormalFrame {
            position: (outer.left, outer.top),
            outer: (
                dimension(outer.right, outer.left)?,
                dimension(outer.bottom, outer.top)?,
            ),
            client: (
                dimension(client.right, client.left)?,
                dimension(client.bottom, client.top)?,
            ),
            scale: f64::from(dpi) / 96.0,
        })
    }
}

#[cfg(any(windows, test))]
fn normal_rect_matches_live(
    live: (i32, i32, i32, i32),
    normal: (i32, i32, i32, i32),
    offset: (i32, i32),
) -> bool {
    [
        (live.0, normal.0, offset.0),
        (live.1, normal.1, offset.1),
        (live.2, normal.2, offset.0),
        (live.3, normal.3, offset.1),
    ]
    .iter()
    .all(|(live, normal, offset)| {
        (i64::from(*live) - i64::from(*normal) - i64::from(*offset)).abs() <= 1
    })
}

#[cfg(not(windows))]
fn native_normal_geometry<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<PhysicalNormalFrame> {
    let owner = super::owned_document_webview(window.app_handle(), window.label())?;
    if window.is_minimized().ok()?
        || window.is_maximized().ok()?
        || owner.is_minimized().ok()?
        || !owner.is_visible().ok()?
    {
        return None;
    }
    let position = window.outer_position().ok()?;
    let outer = window.outer_size().ok()?;
    let client = window.inner_size().ok()?;
    Some(PhysicalNormalFrame {
        position: (position.x, position.y),
        outer: (outer.width, outer.height),
        client: (client.width, client.height),
        scale: window.scale_factor().ok()?,
    })
}

fn sample_normal_frame<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<NormalFrame> {
    if window.is_fullscreen().ok()? {
        return None;
    }
    // Read state and geometry on both sides of the monitor lookup. A minimize, DPI change,
    // or torn sizing read must not become either placement input or pending persistence.
    let before = native_normal_geometry(window)?;
    let work = WorkArea::from_monitor(&window.current_monitor().ok()??).inset(12.0);
    let after = native_normal_geometry(window)?;
    stable_normal_frame(&work, Some(before), Some(after))
}

fn stable_normal_frame(
    work: &WorkArea,
    before: Option<PhysicalNormalFrame>,
    after: Option<PhysicalNormalFrame>,
) -> Option<NormalFrame> {
    let before = before?;
    if Some(before) != after {
        return None;
    }
    NormalFrame::validated(work, before)
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
    saved.filter(|p| valid_saved_frame(p) && monitors.iter().any(|m| m.id == p.monitor))
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
    let content = content.filter(|_| spec.fit_content);
    let content_height = content.map(|fit| fit.logical_height(1.0));
    let content_width = content.and_then(|fit| fit.logical_width());
    let remembered = remembered_client_size(saved, spec.resizable || current_frame);
    if let Some(size) = remembered.filter(|_| spec.preserve_user_frame) {
        // Preferences scrolls within the user's viewport. Raising its remembered/live
        // height to the full content height would also clamp its top to the screen edge.
        return size;
    }
    let (width, height) =
        remembered.unwrap_or((spec.size.0, content_height.unwrap_or(spec.size.1)));
    // Keep a larger user size, but a remembered/live size cannot clip newly added content.
    // The shared placement path subsequently caps this to the destination work area.
    (
        width.max(content_width.unwrap_or(1.0)),
        height.max(content_height.unwrap_or(1.0)),
    )
}
fn remembered_client_size(saved: Option<&SavedPosition>, resizable: bool) -> Option<(f64, f64)> {
    saved
        .filter(|_| resizable)?
        .size
        .filter(|size| valid_client_size(*size))
}
fn custom_color_refit_size(
    fit: MeasuredContent,
    current: (f64, f64),
    user_size: Option<(f64, f64)>,
) -> (f64, f64) {
    // Mode/error changes can remove content as well as add it. Keep a user's larger size,
    // but do not turn the previous programmatic content height into a permanent floor.
    (
        current.0.max(fit.logical_width().unwrap_or(1.0)),
        fit.logical_height(1.0)
            .max(user_size.map_or(1.0, |size| size.1)),
    )
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
            // Restore the saved outer origin, independent of the newly measured client size.
            // Reconstructing it from normalized offsets moves the window whenever content or
            // decorations change between the saved frame and the initial/re-fitted frame.
            let (x, y) = m.clamp(saved.x, saved.y, size.0, size.1);
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
    // Defence in depth for any content-fit/reveal caller: Preferences never refits after
    // ready. Only the explicit, cached off-screen recovery path may place a retained frame.
    if kind == "preferences" && current_frame {
        return Ok(());
    }
    place_content_window_from_frame(window, kind, content_fit, current_frame, None, None)
}

fn recover_preferences_frame<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<bool, String> {
    let mut retained = {
        let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let Some(state) = registry.preferences.as_ref() else {
            return Ok(true);
        };
        if !state.recovery_pending {
            return Ok(true);
        }
        state.last_normal.clone()
    };
    if retained.is_none() {
        // Initial placement may have finished before native geometry became readable. Seed
        // the cache only from a completed normal restoration, never from a hidden/iconic read.
        if !window.is_visible().unwrap_or(false) {
            return Ok(false);
        }
        let Some(normal) = sample_normal_frame(window) else {
            return Ok(false);
        };
        if let Some(state) = REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferences
            .as_mut()
        {
            state.last_normal = Some(normal.clone());
        }
        retained = Some(normal);
    }
    let monitors: Vec<_> = window
        .available_monitors()
        .map_err(|error| error.to_string())?
        .iter()
        .map(|monitor| WorkArea::from_monitor(monitor).inset(12.0))
        .collect();
    let recovered = recover_retained_frame(retained.as_ref(), &monitors, || {
        // This is reached only for an unreachable cached frame, after show/unminimize.
        // Invalid or still-restoring native geometry defers recovery to a later event.
        let Some(normal) = sample_normal_frame(window) else {
            return Ok(false);
        };
        // Native setters can synchronously dispatch move/resize events. Those events must
        // not recursively start recovery; placement's normal transient tags handle them.
        if let Some(state) = REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferences
            .as_mut()
        {
            state.recovery_pending = false;
        }
        let result = place_content_window_from_frame(
            window,
            "preferences",
            None,
            true,
            retained.as_ref(),
            Some(normal),
        );
        if result.is_err() {
            if let Some(state) = REGISTRY
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .preferences
                .as_mut()
            {
                state.recovery_pending = true;
            }
        }
        result?;
        Ok(true)
    })?;
    if recovered {
        if let Some(state) = REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .preferences
            .as_mut()
        {
            state.recovery_pending = false;
        }
    }
    Ok(recovered)
}

fn recover_retained_frame(
    retained: Option<&NormalFrame>,
    monitors: &[WorkArea],
    recover: impl FnOnce() -> Result<bool, String>,
) -> Result<bool, String> {
    if retained.is_none_or(|frame| frame.reachable(monitors)) {
        // In the common case reveal does not even sample the freshly unminimized frame.
        return Ok(true);
    }
    recover()
}

fn place_content_window_from_frame<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    kind: &str,
    content_fit: Option<MeasuredContent>,
    current_frame: bool,
    retained: Option<&NormalFrame>,
    normal: Option<NormalFrame>,
) -> Result<(), String> {
    let app = window.app_handle();
    let owner = super::owned_document_webview(app, window.label()).ok_or("Unknown dialog owner")?;
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
    let normal = normal.or_else(|| sample_normal_frame(window));
    if current_frame && normal.is_none() {
        return Ok(());
    }
    let frame = normal
        .as_ref()
        .map(|normal| normal.physical.outer)
        .unwrap_or((0, 0));
    let scale = normal
        .as_ref()
        .map_or(work.scale, |normal| normal.physical.scale);
    let positions = read_positions(app);
    let spec = kind_spec(kind)?;
    let live_frame = current_frame
        .then_some(retained.or(normal.as_ref()))
        .flatten()
        .map(|frame| &frame.saved);
    let saved = live_frame
        .or_else(|| positions.get(kind))
        .filter(|position| valid_saved_frame(position));
    let mut client_size = dialog_client_size(&spec, content_fit, saved, current_frame);
    if current_frame && kind == "customColor" {
        if let Some(fit) = content_fit {
            // A resize can still be waiting for the persistence debounce when the form reports
            // its next measurement. Consult that pending user frame before the stored one.
            let pending = REGISTRY
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .sessions
                .values()
                .find(|session| session.registration.window_label == window.label())
                .and_then(|session| session.pending_move.as_ref())
                .map(|(_, position)| position.clone());
            let user_size = remembered_client_size(pending.as_ref(), true)
                .or_else(|| remembered_client_size(positions.get(kind), true));
            client_size = custom_color_refit_size(fit, client_size, user_size);
        }
    }
    // A user size remains useful after its display is removed; its position does not.
    let saved = restorable_position(saved, &monitors);
    let client = normal
        .as_ref()
        .map_or((0, 0), |normal| normal.physical.client);
    let size = (
        client_size.0 + f64::from(frame.0.saturating_sub(client.0)) / scale,
        client_size.1 + f64::from(frame.1.saturating_sub(client.1)) / scale,
    );
    let (mut x, mut y, destination_scale) = position_for(
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
    // Content changes grow from the live origin, only moving to stay inside the work area.
    if let Some(live) = live_frame.filter(|_| saved.is_some()) {
        x = live.x * destination_scale;
        y = live.y * destination_scale;
    }
    let template_placement = (!current_frame).then_some(TemplatePlacement {
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
        content: content_fit,
        work: destination,
        spec: &spec,
        fit_content: current_frame || (spec.fit_content && content_fit.is_some()),
        template: template_placement,
    }
    .apply(
        |x, y| {
            // Tag the requested physical origin before the native call can emit Moved.
            remember_programmatic_position(window.label(), (x.round() as i32, y.round() as i32));
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
            let normal = sample_normal_frame(window)
                .ok_or("Dialog frame is not yet a stable normal frame")?;
            Ok(DialogFrame {
                outer: normal.physical.outer,
                client: normal.physical.client,
            })
        },
        |size| window.set_min_size(Some(size)).map_err(|e| e.to_string()),
    )?;
    mark_transient(window.label());
    let client = window.inner_size().map_err(|e| e.to_string())?;
    remember_programmatic_client(window.label(), (client.width, client.height));
    let position = window.outer_position().map_err(|e| e.to_string())?;
    remember_programmatic_position(window.label(), (position.x, position.y));
    if kind == "preferences" {
        if let Some(normal) = sample_normal_frame(window) {
            if let Some(state) = REGISTRY
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .preferences
                .as_mut()
            {
                state.last_normal = Some(normal);
            }
        }
    }
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
    content: Option<MeasuredContent>,
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
            let minimum = self
                .content
                .filter(|_| self.spec.fit_content && !self.spec.preserve_user_frame)
                .map_or(self.spec.min_size, |content| {
                    (
                        content.logical_width().unwrap_or(self.spec.size.0),
                        content.logical_height(1.0),
                    )
                });
            // These are logical INNER constraints on both platforms. Refresh from the latest
            // content rather than the old minimum or a larger remembered/user client size.
            // The fitted client already subtracts the destination's measured decorations.
            set_minimum(tauri::LogicalSize::new(
                minimum.0.min(f64::from(frame.client.0) / self.work.scale),
                minimum.1.min(f64::from(frame.client.1) / self.work.scale),
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
        set_tauri_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ))
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
        // A saved position still uses the shared destination/origin policy.
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
#[cfg(test)]
fn preferences_close_frame(
    work: &WorkArea,
    position: (i32, i32),
    outer: (u32, u32),
    client: (u32, u32),
    programmed_client: Option<(u32, u32)>,
    programmed_position: Option<(i32, i32)>,
) -> Option<SavedPosition> {
    NormalFrame::validated(
        work,
        PhysicalNormalFrame {
            position,
            outer,
            client,
            scale: work.scale,
        },
    )?
    .close_frame(programmed_client, programmed_position)
}
fn sample_preferences_position<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<SavedPosition> {
    let (ready, programmed_client, programmed_position) = {
        let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let state = registry.preferences.as_ref()?;
        (
            state.ready,
            state.programmatic_client,
            state.programmatic_position,
        )
    };
    let app = window.app_handle();
    if !should_persist(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(true)
            || super::owned_document_webview(app, window.label()).is_none_or(|owner| {
                owner.is_minimized().unwrap_or(true) || !owner.is_visible().unwrap_or(false)
            }),
        (
            window.is_maximized().unwrap_or(true),
            window.is_fullscreen().unwrap_or(true),
        ),
        // An explicit close captures the last live frame even after quit has begun. Events
        // from teardown still use the ordinary quit/suspension/minimized guards.
        false,
        super::utility_windows_suspended(),
        ready,
        false,
    ) {
        return None;
    }
    let normal = sample_normal_frame(window)?;
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let state = registry.preferences.as_mut()?;
    if state.recovery_pending {
        return None;
    }
    state.last_normal = Some(normal.clone());
    normal.close_frame(programmed_client, programmed_position)
}
fn persist_move<R: Runtime>(window: &tauri::WebviewWindow<R>, resized: bool) {
    let app = window.app_handle();
    // Never hold REGISTRY across native reads. Invalid samples leave all markers, the last
    // normal frame and any pending user write untouched.
    let Some(normal) = sample_normal_frame(window) else {
        return;
    };
    let PhysicalNormalFrame {
        position, client, ..
    } = normal.physical;
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let (ready, transient_until, programmatic_client, programmatic_position, pending_move) =
        if window.label() == super::PREFERENCES_WINDOW_LABEL {
            let Some(state) = registry.preferences.as_mut() else {
                return;
            };
            if state.recovery_pending {
                return;
            }
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
            || super::owned_document_webview(app, window.label()).is_none_or(|owner| {
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
    if transient_frame_event(
        Instant::now() < *transient_until,
        resized,
        *programmatic_client,
        client,
        *programmatic_position,
        position,
    ) {
        return;
    }
    *transient_until = Instant::now();
    // Retain the app's size tag across a user move so close-time capture cannot turn a
    // work-area-clamped size into a remembered user resize.
    if resized {
        *programmatic_client = None;
    }
    *programmatic_position = None;
    if !resized
        && !super::UTILITY_SUSPENSION
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .persist_move(window.label(), position)
    {
        return;
    }
    let size = if resized {
        normal.saved.size
    } else {
        pending_move.as_ref().and_then(|(_, saved)| saved.size)
    };
    let mut saved = normal.saved.clone();
    saved.size = size;
    if window.label() == super::PREFERENCES_WINDOW_LABEL {
        let state = registry
            .preferences
            .as_mut()
            .expect("Preferences state was checked above");
        state.record_frame(Some(normal), resized);
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
        if !valid_saved_frame(&saved) {
            continue;
        }
        if saved.size.is_none() {
            saved.size = remembered_client_size(positions.get(&kind), true);
        }
        positions.insert(kind, saved);
    }
}
fn write_positions(path: &std::path::Path, writes: PositionWrites) {
    if writes.is_empty() {
        return;
    }
    let mut positions: HashMap<String, SavedPosition> = std::fs::read(path)
        .ok()
        .filter(|b| b.len() <= MAX_BYTES)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    merge_positions(&mut positions, writes);
    if let Ok(contents) = serde_json::to_string(&positions) {
        // Quit can abandon the worker at its deadline. Publish only a complete replacement,
        // using the shared sibling-temp + rename helper (including Windows retry handling).
        if let Err(error) = super::write_file_atomic(path, &contents) {
            eprintln!("Could not persist dialog frames: {error}");
        }
    }
}
fn flush_position<R: Runtime>(app: &tauri::AppHandle<R>, session: &mut Session) {
    if let Some((_, saved)) = session.pending_move.take() {
        let app = app.clone();
        let kind = session.snapshot.dialog_kind.clone();
        persist_close_with(defer_quit_close_persistence(), move || {
            let _io = POSITION_IO.lock().unwrap_or_else(|p| p.into_inner());
            if let Ok(path) = saved_path(&app) {
                write_positions(&path, vec![(kind, saved)]);
            }
        });
    }
}

/// Quit can destroy dialogs on the event loop while an earlier position write is stuck.
/// Never make the event loop wait for POSITION_IO or filesystem I/O in those callbacks,
/// on either platform. The bounded quit drain waits for the registered workers instead.
fn defer_quit_close_persistence() -> bool {
    super::quit_in_progress()
}

#[derive(Default)]
struct PositionWriteTracker {
    pending: Mutex<usize>,
    finished: Condvar,
}

impl PositionWriteTracker {
    fn register(self: &Arc<Self>) -> PositionWriteGuard {
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) += 1;
        PositionWriteGuard(self.clone())
    }

    fn drain(&self) {
        let pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        drop(
            self.finished
                .wait_while(pending, |pending| *pending != 0)
                .unwrap_or_else(|p| p.into_inner()),
        );
    }
}

struct PositionWriteGuard(Arc<PositionWriteTracker>);

impl Drop for PositionWriteGuard {
    fn drop(&mut self) {
        *self.0.pending.lock().unwrap_or_else(|p| p.into_inner()) -= 1;
        self.0.finished.notify_all();
    }
}

static POSITION_WRITES: LazyLock<Arc<PositionWriteTracker>> = LazyLock::new(Default::default);

/// Called only inside the quit drain's existing timeout/deadline, never on AppKit's reply queue.
pub(crate) fn drain_pending_position_writes() {
    POSITION_WRITES.drain();
}

fn persist_close_with(defer: bool, persist: impl FnOnce() + Send + 'static) {
    persist_close_tracked_with(&POSITION_WRITES, defer, persist);
}

fn persist_close_tracked_with(
    tracker: &Arc<PositionWriteTracker>,
    defer: bool,
    persist: impl FnOnce() + Send + 'static,
) {
    // Register before spawning: a fast renderer confirmation must see even an unscheduled write.
    let pending = tracker.register();
    if defer {
        std::thread::spawn(move || {
            let _pending = pending;
            persist();
        });
    } else {
        persist();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreferencesClose {
    Close,
    Destroyed,
}

// All close paths use this transaction. Capture before destroying, without holding
// REGISTRY across native calls. A Destroyed event can only drain a previously captured frame.
fn flush_preferences_to(
    registry: &Mutex<Registry>,
    path: &std::path::Path,
    close: PreferencesClose,
    capture: impl FnOnce() -> Option<SavedPosition>,
) {
    let current = if close == PreferencesClose::Destroyed {
        None
    } else {
        capture().filter(valid_saved_frame)
    };
    // Serialize snapshot + write with the worker so immediate close/reopen sees the latest frame.
    let _io = POSITION_IO.lock().unwrap_or_else(|p| p.into_inner());
    let mut registry = registry.lock().unwrap_or_else(|p| p.into_inner());
    let pending = registry
        .preferences
        .as_mut()
        .and_then(|p| p.pending_move.take())
        .filter(|(_, saved)| valid_saved_frame(saved));
    if close == PreferencesClose::Destroyed {
        registry.preferences = None;
    }
    drop(registry);
    let saved = match (current, pending) {
        (Some(mut current), pending) => {
            if current.size.is_none() {
                current.size = pending.and_then(|(_, saved)| saved.size);
            }
            Some(current)
        }
        (None, pending) => pending.map(|(_, saved)| saved),
    };
    if let Some(saved) = saved {
        write_positions(path, vec![("preferences".into(), saved)]);
    }
}
pub(crate) fn flush_preferences<R: Runtime>(app: &tauri::AppHandle<R>, close: PreferencesClose) {
    if let Ok(path) = saved_path(app) {
        // Sample the live frame before the caller destroys the window. Only the POSITION_IO
        // wait and disk transaction move to a worker during quit.
        let current = if close == PreferencesClose::Destroyed {
            None
        } else {
            app.get_webview_window(super::PREFERENCES_WINDOW_LABEL)
                .and_then(|window| sample_preferences_position(&window))
        };
        persist_close_with(defer_quit_close_persistence(), move || {
            flush_preferences_to(&REGISTRY, &path, close, || current);
        });
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
                    if target.label() == super::PREFERENCES_WINDOW_LABEL {
                        recover_preferences_frame(&target)?;
                    }
                    bring_to_front_on_main(&target)
                })
                .and_then(|result| result)
                {
                    eprintln!("Could not raise focused native dialog: {error}");
                }
            }
        }
        WindowEvent::CloseRequested { .. } if window.label() == super::PREFERENCES_WINDOW_LABEL => {
            flush_preferences(window.app_handle(), PreferencesClose::Close);
        }
        WindowEvent::Destroyed if window.label() == super::PREFERENCES_WINDOW_LABEL => {
            flush_preferences(window.app_handle(), PreferencesClose::Destroyed);
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
                if window.label() == super::PREFERENCES_WINDOW_LABEL {
                    match recover_preferences_frame(&webview) {
                        Ok(true) => {}
                        Ok(false) => return,
                        Err(error) => {
                            eprintln!("Could not recover Preferences frame: {error}");
                            return;
                        }
                    }
                }
                persist_move(&webview, matches!(event, WindowEvent::Resized(_)));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn quit_close_persistence_never_waits_on_a_stalled_position_writer() {
        let io = std::sync::Arc::new(std::sync::Mutex::new(()));
        let held = io.lock().unwrap();
        let worker_io = io.clone();
        let (started, starting) = std::sync::mpsc::channel();
        let (finished, finishing) = std::sync::mpsc::channel();
        // Both Preferences and ordinary dialog close/destroy use this production helper.
        persist_close_with(true, move || {
            started.send(()).unwrap();
            drop(worker_io.lock().unwrap());
            finished.send(()).unwrap();
        });
        starting.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(finishing.try_recv().is_err());
        drop(held);
        finishing.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn ordinary_close_persistence_still_finishes_before_reopening() {
        use std::sync::atomic::Ordering;
        let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = finished.clone();
        persist_close_with(false, move || writer.store(true, Ordering::SeqCst));
        assert!(finished.load(Ordering::SeqCst));
    }

    #[test]
    fn quit_drain_waits_for_preferences_and_dialog_frames_after_fast_session_confirmation() {
        for platform in ["macos", "windows"] {
            let path = preferences_test_path(platform);
            let tracker = Arc::new(PositionWriteTracker::default());
            let io = Arc::new(Mutex::new(()));
            let held = io.lock().unwrap();
            let expected = preferences_native_frame(platform, 1.5, false).unwrap();
            for kind in ["preferences", "export"] {
                let path = path.clone();
                let io = io.clone();
                let saved = expected.clone();
                persist_close_tracked_with(&tracker, true, move || {
                    let _io = io.lock().unwrap();
                    write_positions(&path, vec![(kind.into(), saved)]);
                });
            }
            assert_eq!(*tracker.pending.lock().unwrap(), 2);
            let draining = tracker.clone();
            let (confirmed, confirmation) = std::sync::mpsc::channel();
            let (exited, exit) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                exited
                    .send(crate::session_coordinator::with_timeout(
                        Duration::from_secs(2),
                        move || {
                            crate::drain_quit_persistence_with(
                                || {
                                    confirmed.send(()).unwrap();
                                    Ok(())
                                },
                                || draining.drain(),
                            )
                        },
                    ))
                    .unwrap();
            });
            confirmation.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(matches!(
                exit.recv_timeout(Duration::from_millis(20)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            drop(held);
            exit.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
            worker.join().unwrap();
            let positions: HashMap<String, SavedPosition> =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(positions.len(), 2);
            for kind in ["preferences", "export"] {
                assert_eq!(
                    serde_json::to_value(&positions[kind]).unwrap(),
                    serde_json::to_value(&expected).unwrap()
                );
            }
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn clean_prompted_quit_captures_destruction_frames_before_the_only_drain() {
        for platform in ["macos", "windows"] {
            let path = preferences_test_path(platform);
            let expected = preferences_native_frame(platform, 1.5, false).unwrap();
            let mut registry = Registry::default();
            let message = snapshot();
            let owner = message.owner_window_id.clone();
            let (registration, _) =
                register(&crate::test_documents(), &mut registry, message, false).unwrap();
            registry
                .sessions
                .get_mut(&registration.host_id)
                .unwrap()
                .pending_move = Some((Instant::now(), expected.clone()));
            let tracker = Arc::new(PositionWriteTracker::default());
            // A clean document confirms without renderer dialog disposal: nothing is tracked
            // yet, so draining here (before native dismissal) would incorrectly finish at once.
            assert_eq!(*tracker.pending.lock().unwrap(), 0);
            let io = Arc::new(Mutex::new(()));
            let held = io.lock().unwrap();
            let worker_io = io.clone();
            let worker_path = path.clone();
            let (started, starting) = std::sync::mpsc::channel();
            let (finished, finishing) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result =
                    crate::session_coordinator::with_timeout(Duration::from_secs(2), move || {
                        crate::dismiss_then_drain_with(
                            || {
                                // The same removal/capture used by dismiss_all/dismiss_owned
                                // moves writes normally deferred until owner destruction earlier.
                                for mut session in take_owned_sessions(&mut registry, &owner) {
                                    let (_, saved) = session.pending_move.take().unwrap();
                                    let path = worker_path.clone();
                                    let io = worker_io.clone();
                                    let kind = session.snapshot.dialog_kind;
                                    persist_close_tracked_with(&tracker, true, move || {
                                        let _io = io.lock().unwrap();
                                        write_positions(&path, vec![(kind, saved)]);
                                    });
                                }
                                assert_eq!(*tracker.pending.lock().unwrap(), 1);
                                // Later owner destruction cannot register another final frame.
                                assert!(take_owned_sessions(&mut registry, &owner).is_empty());
                            },
                            || {
                                started.send(()).unwrap();
                                crate::drain_quit_persistence_with(|| Ok(()), || tracker.drain())
                            },
                        )
                    });
                finished.send(result).unwrap();
            });
            starting.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(matches!(
                finishing.recv_timeout(Duration::from_millis(20)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            drop(held);
            finishing
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            worker.join().unwrap();
            let positions: HashMap<String, SavedPosition> =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(positions.len(), 1);
            assert_eq!(
                serde_json::to_value(&positions["pageSize"]).unwrap(),
                serde_json::to_value(&expected).unwrap()
            );
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn quit_drain_deadline_abandons_blocked_frames_without_truncating_the_saved_file() {
        for platform in ["macos", "windows"] {
            let path = preferences_test_path(platform);
            let tracker = Arc::new(PositionWriteTracker::default());
            let io = Arc::new(Mutex::new(()));
            let held = io.lock().unwrap();
            let expected = preferences_native_frame(platform, 1.0, false).unwrap();
            write_positions(&path, vec![("preferences".into(), expected.clone())]);
            let original = std::fs::read(&path).unwrap();
            let worker_path = path.clone();
            let worker_io = io.clone();
            persist_close_tracked_with(&tracker, true, move || {
                let _io = worker_io.lock().unwrap();
                write_positions(&worker_path, vec![("export".into(), expected)]);
            });
            let draining = tracker.clone();
            let result =
                crate::session_coordinator::with_timeout(Duration::from_millis(20), move || {
                    crate::drain_quit_persistence_with(|| Ok(()), || draining.drain())
                });
            assert!(result.unwrap_err().contains("timed out"));
            assert_eq!(std::fs::read(&path).unwrap(), original);
            drop(held);
            crate::session_coordinator::with_timeout(Duration::from_secs(2), move || {
                tracker.drain();
                Ok(())
            })
            .unwrap();
            let positions: HashMap<String, SavedPosition> =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(positions.len(), 2);
            assert_eq!(
                std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
                1
            );
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn failed_session_flush_still_drains_accepted_position_writes() {
        let drained = std::cell::Cell::new(false);
        assert_eq!(
            crate::drain_quit_persistence_with(
                || Err("session disk full".into()),
                || drained.set(true),
            ),
            Err("session disk full".into())
        );
        assert!(drained.get());
    }

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
            .contains("dialog-*-reactionConditions-*"));
        let mut message = snapshot();
        message.dialog_kind = "reactionConditions".into();
        message.data = json!({"title":"Drawing","arrowId":"arrow-1","draft":draft});
        assert!(message.validate(&crate::test_documents()).is_ok());
        message.message_type = "action".into();
        message.data = json!({"action":"apply","draft":draft});
        assert!(message.validate(&crate::test_documents()).is_ok());
        message.data = json!({"action":"cancel","draft":draft});
        assert!(message.validate(&crate::test_documents()).is_err());
    }
    use super::*;

    // The native policy is shared. Pass a platform into the fixture so either test host
    // exercises both decoration models, rather than choosing with cfg! or OS detection.
    fn preferences_native_frame(
        platform: &str,
        scale: f64,
        minimized: bool,
    ) -> Option<SavedPosition> {
        if !should_persist(true, minimized, (false, false), false, false, true, false) {
            return None;
        }
        let decorations = match platform {
            "windows" => (16.0, 40.0),
            "macos" => (0.0, 28.0),
            _ => panic!("Unknown test platform"),
        };
        let work = WorkArea {
            id: "secondary".into(),
            x: -1600.0,
            y: 0.0,
            width: 1600.0,
            height: 1000.0,
            scale,
        };
        // Physical measurements from the destination monitor, including native decorations.
        let client = ((800.0 * scale) as u32, (600.0 * scale) as u32);
        Some(saved_frame(
            &work,
            ((-1400.0 * scale) as i32, (120.0 * scale) as i32),
            (
                ((800.0 + decorations.0) * scale) as u32,
                ((600.0 + decorations.1) * scale) as u32,
            ),
            Some((
                f64::from(client.0) / work.scale,
                f64::from(client.1) / work.scale,
            )),
        ))
    }

    fn preferences_test_path(platform: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir()
            .join(format!(
                "chemdraft-preferences-close-{}-{}-{platform}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ))
            .join("dialog-positions.json")
    }

    fn assert_preferences_close_reopens(platform: &str) {
        for scale in [1.0, 1.5, 2.0] {
            // A debounced worker may already have drained every event. A stale queued move
            // must also lose to the live close-time frame, including a resize with no move.
            for stale_pending in [false, true] {
                let path = preferences_test_path(platform);
                let mut stale = preferences_native_frame(platform, scale, false).unwrap();
                stale.size = Some(kind_spec("preferences").unwrap().size);
                stale.x = -1500.0;
                let registry = Mutex::new(Registry {
                    preferences: Some(PreferencesLayout {
                        applied_position: Some((0, 0)),
                        pending_move: stale_pending.then_some((Instant::now(), stale)),
                        ready: true,
                        ..PreferencesLayout::default()
                    }),
                    ..Registry::default()
                });
                flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                    assert!(
                        registry.try_lock().is_ok(),
                        "native reads cannot hold REGISTRY"
                    );
                    preferences_native_frame(platform, scale, false)
                });
                // Native destruction follows CloseRequested.
                flush_preferences_to(&registry, &path, PreferencesClose::Destroyed, || {
                    panic!("Destroyed must never query a dead native window")
                });
                assert!(registry.lock().unwrap().preferences.is_none());
                drop(registry);
                // Read disk after dropping all live state, just as an app relaunch does.
                let positions: HashMap<String, SavedPosition> =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                let saved = &positions["preferences"];
                assert_eq!(saved.size, Some((800.0, 600.0)), "{platform}");
                assert_eq!((saved.x, saved.y), (-1400.0, 120.0), "{platform}");
                let work = WorkArea {
                    id: "secondary".into(),
                    x: -1600.0,
                    y: 0.0,
                    width: 1600.0,
                    height: 1000.0,
                    scale,
                };
                let decorations = if platform == "windows" {
                    (16.0, 40.0)
                } else {
                    (0.0, 28.0)
                };
                let client = remembered_client_size(Some(saved), true).unwrap();
                let placement = position_for(
                    restorable_position(Some(saved), std::slice::from_ref(&work)),
                    std::slice::from_ref(&work),
                    &work,
                    (0.0, 0.0, 1200.0, 800.0),
                    (client.0 + decorations.0, client.1 + decorations.1),
                );
                assert!((placement.0 + 1400.0 * scale).abs() < 1e-6, "{platform}");
                assert!((placement.1 - 120.0 * scale).abs() < 1e-6, "{platform}");
                assert_eq!(placement.2, scale);
                let reopened_client = std::cell::Cell::new((0, 0));
                finish_placement(
                    (placement, client),
                    &work,
                    true,
                    None,
                    |_, _| Ok::<_, String>(()),
                    |width, height| {
                        reopened_client.set((width, height));
                        Ok(())
                    },
                    || {
                        Ok(DialogFrame {
                            client: reopened_client.get(),
                            outer: (
                                reopened_client.get().0 + (decorations.0 * scale) as u32,
                                reopened_client.get().1 + (decorations.1 * scale) as u32,
                            ),
                        })
                    },
                )
                .unwrap();
                assert_eq!(
                    reopened_client.get(),
                    ((800.0 * scale) as u32, (600.0 * scale) as u32)
                );
                std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn preferences_native_x_and_red_close_save_live_frame_before_destroy_and_relaunch() {
        for platform in ["windows", "macos"] {
            assert_preferences_close_reopens(platform);
        }
    }

    #[test]
    fn last_owner_dismissal_flushes_preferences_before_destroy() {
        for platform in ["windows", "macos"] {
            for closing in [false, true] {
                let documents = crate::document_windows::DocumentWindowRegistry::with_main();
                documents.set_ready("main");
                if closing {
                    documents.begin_closing("main");
                }
                assert!(documents.reown_preferences(Some("main")).is_none());
                let path = preferences_test_path(platform);
                let registry = Mutex::new(Registry {
                    preferences: Some(PreferencesLayout::default()),
                    ..Registry::default()
                });
                let frame = preferences_native_frame(platform, 1.5, false).unwrap();
                flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                    assert!(registry.lock().unwrap().preferences.is_some());
                    Some(frame.clone())
                });
                // The close-time frame is on disk while the native window is still alive.
                let bytes = std::fs::read(&path).unwrap();
                let positions: HashMap<String, SavedPosition> =
                    serde_json::from_slice(&bytes).unwrap();
                assert_eq!(positions["preferences"].size, frame.size);
                assert_eq!(positions["preferences"].x, frame.x);
                flush_preferences_to(&registry, &path, PreferencesClose::Destroyed, || {
                    panic!("Destroyed must never query a dead native window")
                });
                assert!(registry.lock().unwrap().preferences.is_none());
                assert_eq!(std::fs::read(&path).unwrap(), bytes);
                std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn preferences_minimized_close_and_destroy_keep_the_last_valid_frame() {
        for platform in ["windows", "macos"] {
            let path = preferences_test_path(platform);
            let valid = preferences_native_frame(platform, 1.5, false).unwrap();
            let registry = Mutex::new(Registry {
                preferences: Some(PreferencesLayout {
                    applied_position: None,
                    pending_move: Some((Instant::now(), valid.clone())),
                    ready: true,
                    ..PreferencesLayout::default()
                }),
                ..Registry::default()
            });
            flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                preferences_native_frame(platform, 1.5, true)
            });
            let bytes = std::fs::read(&path).unwrap();
            let positions: HashMap<String, SavedPosition> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(positions["preferences"].size, valid.size);
            assert_eq!(positions["preferences"].x, valid.x);
            flush_preferences_to(&registry, &path, PreferencesClose::Destroyed, || {
                panic!("Destroyed cannot sample a frame")
            });
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn legacy_preference_frames_load_and_invalid_client_sizes_are_ignored() {
        let legacy: SavedPosition = serde_json::from_value(json!({
            "monitor":"one", "x":0, "y":0, "offsetX":0.5, "offsetY":0.5
        }))
        .unwrap();
        assert_eq!(remembered_client_size(Some(&legacy), true), None);
        for size in [
            (0.0, 600.0),
            (800.0, -1.0),
            (800.0, f64::NAN),
            (f64::INFINITY, 600.0),
            (32767.0, 600.0),
            (800.0, 32767.0),
        ] {
            let invalid = SavedPosition {
                size: Some(size),
                ..legacy.clone()
            };
            assert_eq!(remembered_client_size(Some(&invalid), true), None);
        }
        let resized = SavedPosition {
            size: Some((800.0, 600.0)),
            ..legacy.clone()
        };
        let mut positions = HashMap::from([("preferences".into(), resized)]);
        merge_positions(&mut positions, vec![("preferences".into(), legacy)]);
        assert_eq!(positions["preferences"].size, Some((800.0, 600.0)));
    }

    #[test]
    fn preferences_close_preserves_user_size_after_clamping_and_captures_unqueued_resizes() {
        for platform in ["windows", "macos"] {
            for scale in [1.0, 1.5, 2.0] {
                let path = preferences_test_path(platform);
                let original = preferences_native_frame(platform, scale, false).unwrap();
                let work = WorkArea {
                    id: original.monitor.clone(),
                    x: -1600.0,
                    y: 0.0,
                    width: 1600.0,
                    height: 1000.0,
                    scale,
                };
                write_positions(&path, vec![("preferences".into(), original.clone())]);
                let registry = Mutex::new(Registry {
                    preferences: Some(PreferencesLayout::default()),
                    ..Registry::default()
                });
                let programmed = ((600.0 * scale) as u32, (400.0 * scale) as u32);
                let origin = ((-1400.0 * scale) as i32, (120.0 * scale) as i32);
                let moved = ((-1300.0 * scale) as i32, (200.0 * scale) as i32);
                let decorations = if platform == "windows" {
                    (16.0, 40.0)
                } else {
                    (0.0, 28.0)
                };
                let capture = |position, client: (u32, u32)| {
                    preferences_close_frame(
                        &work,
                        position,
                        (
                            client.0 + (decorations.0 * scale) as u32,
                            client.1 + (decorations.1 * scale) as u32,
                        ),
                        client,
                        Some(programmed),
                        Some(origin),
                    )
                };
                // The unchanged app-clamped frame must leave the user's larger size on disk.
                flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                    capture(origin, programmed)
                });
                let read = || -> SavedPosition {
                    let positions: HashMap<String, SavedPosition> =
                        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                    positions["preferences"].clone()
                };
                assert_eq!(read().size, original.size);
                // A move with no resize saves its live origin, retaining the pre-clamp size.
                flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                    capture(moved, programmed)
                });
                assert_eq!((read().x, read().y), (-1300.0, 200.0));
                assert_eq!(read().size, original.size);
                // A pending user resize must also survive a position-only live capture.
                registry
                    .lock()
                    .unwrap()
                    .preferences
                    .as_mut()
                    .unwrap()
                    .pending_move = Some((
                    Instant::now(),
                    SavedPosition {
                        size: Some((700.0, 500.0)),
                        ..original.clone()
                    },
                ));
                flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                    capture(moved, programmed)
                });
                assert_eq!(read().size, Some((700.0, 500.0)));
                // A native resize immediately before close wins even without a Resized event.
                let resized = ((650.0 * scale) as u32, (450.0 * scale) as u32);
                flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                    capture(moved, resized)
                });
                assert_eq!(read().size, Some((650.0, 450.0)));
                assert_eq!((read().x, read().y), (-1300.0, 200.0));
                std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn preferences_close_paths_flush_before_disposal_and_preferences_command_raises() {
        let source = include_str!("dialog_windows.rs");
        let events = source
            .split("pub(crate) fn on_window_event")
            .nth(1)
            .unwrap()
            .split("\n#[cfg(test)]")
            .next()
            .unwrap();
        assert!(events.contains("WindowEvent::CloseRequested { .. } if window.label() == super::PREFERENCES_WINDOW_LABEL => {\n            flush_preferences(window.app_handle(), PreferencesClose::Close);"));
        assert!(events.contains("WindowEvent::Destroyed if window.label() == super::PREFERENCES_WINDOW_LABEL => {\n            flush_preferences(window.app_handle(), PreferencesClose::Destroyed);"));
        let owner_close = source
            .split("pub(crate) fn dismiss_owned")
            .nth(1)
            .unwrap()
            .split("pub(crate) fn prepare_preferences")
            .next()
            .unwrap();
        assert!(
            owner_close
                .find("flush_preferences(app, PreferencesClose::Close)")
                .unwrap()
                < owner_close.find("window.destroy()").unwrap()
        );
        let document_dismiss = source
            .split("pub(crate) fn dismiss_owned")
            .nth(1)
            .unwrap()
            .split("pub(crate) fn dismiss_all")
            .next()
            .unwrap();
        assert!(document_dismiss.contains("reown_preferences(app, Some(owner_window_id))"));
        assert!(document_dismiss.contains("take_owned_sessions("));
        assert!(document_dismiss
            .contains("if reason != \"quit\" && !reown_preferences(app, Some(owner_window_id)) {"));
        assert!(
            document_dismiss
                .find("flush_preferences(app, PreferencesClose::Close)")
                .unwrap()
                < document_dismiss.find("window.destroy()").unwrap()
        );
        let lib = include_str!("lib.rs");
        // The Preferences command opens or raises; it no longer disposes of the window.
        let menu_open = lib
            .split("async fn toggle_preferences_window")
            .nth(1)
            .unwrap()
            .split("fn ensure_preferences_window")
            .next()
            .unwrap();
        assert!(menu_open.contains("ensure_preferences_window(&app).map(|_| ())"));
        let existing_window = lib
            .split("fn ensure_preferences_window")
            .nth(1)
            .unwrap()
            .split("let owner = app")
            .next()
            .unwrap();
        assert!(existing_window.contains("app.get_webview_window(PREFERENCES_WINDOW_LABEL)"));
        assert!(existing_window.contains("dialog_windows::show_preferences(&target)"));
        assert!(existing_window.contains("return Ok(window);"));
        for path in [menu_open, existing_window] {
            assert!(!path.contains("window.hide()"));
            assert!(!path.contains("window.close()"));
            assert!(!path.contains("window.destroy()"));
            assert!(!path.contains("flush_preferences"));
        }
        // macOS Close Window still uses CloseRequested and its native close-time flush.
        let menu_close = lib
            .split("fn close_key_window")
            .nth(1)
            .unwrap()
            .split("fn about_metadata")
            .next()
            .unwrap();
        assert!(menu_close.contains("(CloseWindowRoute::TauriClose, Some(window)) => {\n            if let Err(error) = window.close()"));
    }

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
            (-1245.0, 202.5, 1.5)
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
            (-1245.0, 202.5, 1.5)
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
            // Removing a monitor resets placement. Preferences keeps its user size;
            // nonresizable Custom Page Size uses its default without a content measurement.
            assert_eq!(
                dialog_client_size(&kind_spec(kind).unwrap(), None, Some(&missing), false),
                if kind == "preferences" {
                    (500.0, 400.0)
                } else {
                    size
                },
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
        assert!(
            include_str!("../capabilities/dialog-host.json").contains("dialog-*-vibeCodeGuide-*")
        );
        let mut message = snapshot();
        message.dialog_kind = "vibeCodeGuide".into();
        message.data = json!({"title":"Guide"});
        assert!(message.validate(&crate::test_documents()).is_ok());
        message.data = json!({"title":"x".repeat(257)});
        assert!(message.validate(&crate::test_documents()).is_err());
        message.message_type = "action".into();
        for action in ["saveStarter", "openPluginManager", "cancel"] {
            message.data = json!({"action":action});
            assert!(message.validate(&crate::test_documents()).is_ok());
        }
        message.data = json!({"action":"saveStarter","path":"/tmp/a"});
        assert!(message.validate(&crate::test_documents()).is_err());
    }
    #[test]
    fn structure_templates_registration_and_actions_are_bounded_on_all_platforms() {
        let mut message = snapshot();
        message.dialog_kind = "structureTemplates".into();
        message.data =
            json!({"title":"Drawing A","templateIds":["beta-cyclodextrin","pillar-5-arene"]});
        assert!(message.validate(&crate::test_documents()).is_ok());
        let spec = kind_spec("structureTemplates").unwrap();
        assert!(spec.resizable && !spec.maximizable);
        let mut registry = Registry::default();
        let (registration, build) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
        assert!(build);
        assert!(registration
            .window_label
            .starts_with("dialog-main-structureTemplates-"));
        assert!(is_dialog_label(&registration.window_label));
        assert!(include_str!("../capabilities/dialog-host.json")
            .contains("dialog-*-structureTemplates-*"));
        assert!(
            !register(
                &crate::test_documents(),
                &mut registry,
                message.clone(),
                false
            )
            .unwrap()
            .1
        );
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        message.message_type = "action".into();
        for data in [
            json!({"action":"insert"}),
            json!({"action":"insert","templateId":"../main"}),
            json!({"action":"insert","templateId":"beta-cyclodextrin","commandId":"document.new"}),
        ] {
            message.data = data;
            assert!(message.validate(&crate::test_documents()).is_err());
        }
        message.data = json!({"action":"insert","templateId":"unknown"});
        assert!(reserve_action(session, &message).is_err());
        message.data = json!({"action":"insert","templateId":"beta-cyclodextrin"});
        assert!(message.validate(&crate::test_documents()).is_ok());
        assert!(reserve_action(session, &message).unwrap());
        assert!(!reserve_action(session, &message).unwrap());
        message.request_id = "second-insert".into();
        assert!(reserve_action(session, &message).is_err());
        session.terminal_request = None;
        assert!(reserve_action(session, &message).unwrap());
        message.message_type = "snapshot".into();
        message.data = json!({"title":"A","templateIds":["beta-cyclodextrin","beta-cyclodextrin"]});
        assert!(message.validate(&crate::test_documents()).is_err());
        message.data = json!({"title":"A","templateIds":[],"extra":true});
        assert!(message.validate(&crate::test_documents()).is_err());
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
            assert!(
                message.validate(&crate::test_documents()).is_ok(),
                "intent: {intent}"
            );
        }
    }
    #[test]
    fn tool_install_accepts_absent_intent() {
        let message = tool_install_snapshot();
        assert!(message.data.get("intent").is_none());
        assert!(message.validate(&crate::test_documents()).is_ok());
    }
    #[test]
    fn tool_install_rejects_invalid_intent() {
        for intent in [json!("unknown"), json!("Update"), json!(""), json!(42)] {
            let mut message = tool_install_snapshot();
            message.data["intent"] = intent.clone();
            assert!(
                message.validate(&crate::test_documents()).is_err(),
                "intent: {intent}"
            );
        }
    }
    #[test]
    fn tool_install_rejects_null_intent() {
        let mut message = tool_install_snapshot();
        message.data["intent"] = Value::Null;
        assert!(message.validate(&crate::test_documents()).is_err());
    }
    #[test]
    fn tool_install_validates_spec_buttons_labels_and_capability_matcher() {
        let message = tool_install_snapshot();
        assert!(message.validate(&crate::test_documents()).is_ok());
        let spec = kind_spec("toolInstall").unwrap();
        assert!(spec.resizable);
        assert_eq!(spec.size, (520.0, 460.0));
        assert_eq!(
            native_window_title("toolInstall", spec.title, "Install Claude Code"),
            "Install Claude Code"
        );
        let mut unknown_disk_space = message.clone();
        unknown_disk_space.data["freeDiskBytes"] = Value::Null;
        assert!(unknown_disk_space
            .validate(&crate::test_documents())
            .is_ok());
        for action in ["install", "allow", "cancelInstall", "close"] {
            let mut valid = message.clone();
            valid.message_type = "action".into();
            valid.data = json!({"action":action});
            assert!(valid.validate(&crate::test_documents()).is_ok());
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
            assert!(invalid.validate(&crate::test_documents()).is_err());
        }
        let mut invalid = message.clone();
        invalid.data["state"] = json!({"status":"consent","extra":true});
        assert!(invalid.validate(&crate::test_documents()).is_err());
        invalid = message.clone();
        invalid.data["buttons"] = json!(["allow", "install", "close"]);
        assert!(invalid.validate(&crate::test_documents()).is_err());
        assert!(is_dialog_label("dialog-main-toolInstall-12"));
        for label in [
            "dialog-main-toolInstall-../main",
            "dialog-main-toolInstall-",
            "dialog-main-toolInstall-12-extra",
        ] {
            assert!(!is_dialog_label(label));
        }
        let capability = include_str!("../capabilities/dialog-host.json");
        assert!(capability.contains("dialog-*-toolInstall-*"));
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
                    message.validate(&crate::test_documents()).is_ok(),
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
        let (registration, _) = register(
            &crate::test_documents(),
            &mut registry,
            snapshot.clone(),
            false,
        )
        .unwrap();
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        let mut action = snapshot.clone();
        action.message_type = "action".into();
        action.data = json!({"action":"install"});
        assert!(reserve_action(session, &action).unwrap());
        let original_action = action.clone();
        action.request_id = "retry".into();
        assert!(reserve_action(session, &action).is_err());
        snapshot.data["state"] = json!({"status":"failed","message":"Download failed"});
        assert!(snapshot.validate(&crate::test_documents()).is_ok());
        update_snapshot(session, &snapshot);
        assert!(reserve_action(session, &action).unwrap());
        assert!(!reserve_action(session, &original_action).unwrap());
        assert!(!reserve_action(session, &action).unwrap());
    }
    #[test]
    fn engine_install_registration_validation_ownership_and_limits() {
        let message = engine_install_snapshot();
        assert!(message.validate(&crate::test_documents()).is_ok());
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
        let (registration, build) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
        assert!(build);
        assert!(is_dialog_label(&registration.window_label));
        assert!(
            !register(
                &crate::test_documents(),
                &mut registry,
                message.clone(),
                false
            )
            .unwrap()
            .1
        );
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        assert!(authorize(
            &crate::test_documents(),
            session,
            "main",
            true,
            Some(&message)
        )
        .is_ok());
        assert!(authorize(
            &crate::test_documents(),
            session,
            "preferences",
            true,
            Some(&message)
        )
        .is_err());
        assert!(authorize(
            &crate::test_documents(),
            session,
            &registration.window_label,
            false,
            Some(&message)
        )
        .is_ok());
        assert!(authorize(
            &crate::test_documents(),
            session,
            "main",
            false,
            Some(&message)
        )
        .is_err());
        assert!(
            serde_json::to_vec(&delivery(session, "main", &message).unwrap())
                .unwrap()
                .len()
                < MAX_CHANNEL_BYTES
        );
        for field in ["path", "callback", "document"] {
            let mut invalid = message.clone();
            invalid.data[field] = json!("untrusted");
            assert!(invalid.validate(&crate::test_documents()).is_err());
        }
        for state in [
            json!({"status":"unknown"}),
            json!({"status":"notInstalled","extra":1}),
            json!({"status":"broken","detail":null}),
        ] {
            let mut invalid = message.clone();
            invalid.data["state"] = state;
            assert!(invalid.validate(&crate::test_documents()).is_err());
        }
        let mut oversized = message.clone();
        oversized.data["disclosure"] = json!("\u{0001}".repeat(1024));
        assert!(oversized.validate(&crate::test_documents()).is_err());
        assert!(delivery(session, "main", &oversized).is_err());
        oversized.data["disclosure"] = json!("x".repeat(MAX_BYTES));
        assert!(oversized.validate(&crate::test_documents()).is_err());
        for number in [json!(-1), json!(1.5), json!(MAX_SAFE_INTEGER + 1)] {
            let mut invalid = message.clone();
            invalid.data["freeDiskBytes"] = number;
            assert!(invalid.validate(&crate::test_documents()).is_err());
        }
        for action in ["install", "cancelInstall", "close"] {
            let mut action_message = message.clone();
            action_message.message_type = "action".into();
            action_message.data = json!({"action":action});
            assert!(action_message.validate(&crate::test_documents()).is_ok());
            action_message.data["unknown"] = json!(true);
            assert!(action_message.validate(&crate::test_documents()).is_err());
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
        let (registration, _) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        message.message_type = "action".into();
        message.data = json!({"action":"install"});
        assert!(reserve_action(session, &message).unwrap());
        assert!(!reserve_action(session, &message).unwrap());
        session.snapshot.data["state"] = json!({"status":"installing", "phase":"Installing Python", "step":2,"steps":5,"bytesDone":100,"bytesTotal":200,"estimated":true});
        session.snapshot.data["buttons"] = json!(["cancelInstall", "close"]);
        assert!(session.snapshot.validate(&crate::test_documents()).is_ok());
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
            assert!(invalid.validate(&crate::test_documents()).is_err());
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
        let (registration, _) = register(
            &crate::test_documents(),
            &mut registry,
            engine_install_snapshot(),
            false,
        )
        .unwrap();
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
        assert_eq!(position, (1800.0, 30.0, 1.5));
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
        let (page, _) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
        registry.sessions.get_mut(&page.host_id).unwrap().ready = true;
        assert_eq!(export_focus_label(&registry, &old_id), None);
        registry.sessions.clear();
        message.dialog_kind = "export".into();
        message.data = export_snapshot().data;
        let (export, _) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
        assert_eq!(export_focus_label(&registry, &old_id), None);
        registry.sessions.get_mut(&export.host_id).unwrap().ready = true;
        assert_eq!(
            export_focus_label(&registry, &old_id),
            Some(export.window_label)
        );
        registry.sessions.clear();
        assert_eq!(export_focus_label(&registry, &old_id), None);
        message.session_id = "replacement-session".into();
        let (replacement, _) =
            register(&crate::test_documents(), &mut registry, message, false).unwrap();
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
        let (registration, _) = register(
            &crate::test_documents(),
            &mut registry,
            maximum.clone(),
            false,
        )
        .unwrap();
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
            message.validate(&crate::test_documents()).unwrap();
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
        let (r, _) = register(&crate::test_documents(), &mut registry, snapshot(), false).unwrap();
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
        let (r, _) = register(&crate::test_documents(), &mut registry, snapshot(), false).unwrap();
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
    fn template_placement_restores_saved_origin_or_centres_when_monitor_is_gone() {
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
                x: -628.0,
                y: 0.0,
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
        let (r, _) = register(
            &crate::test_documents(),
            &mut registry.lock().unwrap(),
            snapshot(),
            false,
        )
        .unwrap();
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
        let (first, _) =
            register(&crate::test_documents(), &mut registry, snapshot(), false).unwrap();
        let mut other = snapshot();
        other.document_tab_id = "tab-2".into();
        other.session_id = "session-2".into();
        let (second, _) = register(&crate::test_documents(), &mut registry, other, false).unwrap();
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
        assert!(message.validate(&crate::test_documents()).is_ok());
        let capability = include_str!("../capabilities/dialog-host.json");
        assert!(capability.contains("dialog-*-atomProblem-*"));
        let mut registry = Registry::default();
        let (registration, _) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
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
            assert!(message.validate(&crate::test_documents()).is_err());
        }
        message.data = json!({"action":"charge", "targetVersion":2});
        assert!(message.validate(&crate::test_documents()).is_ok());
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
        assert!(message.validate(&crate::test_documents()).is_ok());
        assert!(releases_action_reservation(&message));
        message.dialog_kind = "pageSize".into();
        assert!(!releases_action_reservation(&message));
    }
    #[test]
    fn spacing_preview_payloads_stay_bounded_and_do_not_reserve_save() {
        let mut message = snapshot();
        message.dialog_kind = "arrangementSpacing".into();
        message.data = json!({"title":"Drawing", "minPercent":25, "maxPercent":150});
        assert!(message.validate(&crate::test_documents()).is_ok());
        let mut registry = Registry::default();
        let (registration, _) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
        assert!(is_dialog_label(&registration.window_label));
        let session = registry.sessions.get_mut(&registration.host_id).unwrap();
        message.message_type = "action".into();
        message.data = json!({"action":"preview", "percent":80});
        assert!(message.validate(&crate::test_documents()).is_ok());
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
        assert!(message.validate(&crate::test_documents()).is_ok());
        assert!(delivery(session, "main", &message).is_ok());
        for data in [
            json!({"percent":80, "index":0, "count":1, "chunk":"A".repeat(2001)}),
            json!({"percent":80, "index":0, "count":1025, "chunk":"AA=="}),
            json!({"percent":80, "index":1, "count":1, "chunk":"AA=="}),
            json!({"percent":80, "index":0, "count":1, "chunk":"https://example.com"}),
            json!({"percent":80.5, "index":0, "count":1, "chunk":"AA=="}),
        ] {
            message.data = data;
            assert!(message.validate(&crate::test_documents()).is_err());
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
        assert!(message.validate(&crate::test_documents()).is_err());
        message.dialog_kind = "export".into();
        assert!(message.validate(&crate::test_documents()).is_err());
        message.dialog_kind = "arrangementSpacing".into();
        message.message_type = "result".into();
        message.data = json!({"status":"accepted"});
        assert!(message.validate(&crate::test_documents()).is_ok());
        message.data = json!({"status":"exported"});
        assert!(message.validate(&crate::test_documents()).is_err());
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
        fn place(dialog: &std::cell::RefCell<Self>, macos: bool, placement: DialogPlacement<'_>) {
            let work = placement.work;
            placement
                .apply(
                    |x, y| {
                        dialog.borrow_mut().calls.push("move");
                        move_dialog(
                            macos,
                            (x, y, work.scale),
                            |logical| {
                                dialog.borrow_mut().position = logical;
                                Ok(())
                            },
                            |physical| {
                                dialog.borrow_mut().position = physical.to_logical(work.scale);
                                Ok(())
                            },
                        )
                    },
                    |width, height| {
                        dialog.borrow_mut().calls.push("resize");
                        resize_dialog_client(
                            macos,
                            tauri::PhysicalSize::new(width, height),
                            work.scale,
                            |logical| {
                                dialog.borrow_mut().client = logical;
                                Ok(())
                            },
                            |physical| {
                                dialog.borrow_mut().client = physical.to_logical(work.scale);
                                Ok(())
                            },
                        )
                    },
                    || Ok(dialog.borrow().frame()),
                    |minimum| {
                        dialog.borrow_mut().calls.push("minimum");
                        dialog.borrow_mut().set_minimum(minimum);
                        Ok(())
                    },
                )
                .unwrap();
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
    fn normal_test_frame(scale: f64) -> PhysicalNormalFrame {
        PhysicalNormalFrame {
            position: ((240.0 * scale) as i32, (180.0 * scale) as i32),
            outer: ((576.0 * scale) as u32, (460.0 * scale) as u32),
            client: ((560.0 * scale) as u32, (420.0 * scale) as u32),
            scale,
        }
    }

    #[test]
    fn preferences_ready_and_reveal_preserve_user_events_close_and_owner_restore() {
        use std::cell::RefCell;
        for macos in [false, true] {
            for scale in [1.0, 1.5, 2.0] {
                let work = WorkArea {
                    id: "screen".into(),
                    x: 12.0,
                    y: 12.0,
                    width: 1176.0,
                    height: 876.0,
                    scale,
                };
                let spec = kind_spec("preferences").unwrap();
                let content = MeasuredContent::new(
                    ContentFit::from_ready(&json!({"contentHeight":2400.0,"pixelRatio":scale})),
                    Some(scale),
                );
                let initial = normal_test_frame(scale);
                let mut saved = NormalFrame::validated(&work, initial).unwrap().saved;
                let dialog = RefCell::new(SimulatedDialog {
                    scale,
                    client: tauri::LogicalSize::new(560.0, 420.0),
                    minimum: tauri::LogicalSize::new(spec.min_size.0, spec.min_size.1),
                    position: tauri::LogicalPosition::new(240.0, 180.0),
                    decoration: tauri::LogicalSize::new(
                        if macos { 0.0 } else { 16.0 },
                        if macos { 28.0 } else { 40.0 },
                    ),
                    queue: Vec::new(),
                    calls: Vec::new(),
                });
                // A new ready restores disk once; close/reopen starts a new ready lifecycle.
                for reopened in [false, true] {
                    let mut state = PreferencesLayout::default();
                    assert!(state.report_content(content));
                    SimulatedDialog::place(
                        &dialog,
                        macos,
                        DialogPlacement {
                            position: (saved.x * scale, saved.y * scale, scale),
                            client_size: dialog_client_size(&spec, content, Some(&saved), false),
                            content,
                            work: &work,
                            spec: &spec,
                            fit_content: true,
                            template: Some(TemplatePlacement {
                                saved: Some(&saved),
                                owner_rect: (0.0, 0.0, 1200.0, 900.0),
                            }),
                        },
                    );
                    if !reopened {
                        assert_eq!(
                            dialog.borrow().position,
                            tauri::LogicalPosition::new(240.0, 180.0)
                        );
                        // Genuine native move, then resize, rather than another placement call.
                        dialog.borrow_mut().position = tauri::LogicalPosition::new(300.0, 240.0);
                        let mut moved = initial;
                        moved.position = ((300.0 * scale) as i32, (240.0 * scale) as i32);
                        state.record_frame(
                            stable_normal_frame(&work, Some(moved), Some(moved)),
                            false,
                        );
                        dialog.borrow_mut().client = tauri::LogicalSize::new(620.0, 460.0);
                    }
                    let user = {
                        let native = dialog.borrow();
                        let position = native.position.to_physical::<i32>(scale);
                        let frame = native.frame();
                        PhysicalNormalFrame {
                            position: (position.x, position.y),
                            outer: frame.outer,
                            client: frame.client,
                            scale,
                        }
                    };
                    state.record_frame(stable_normal_frame(&work, Some(user), Some(user)), true);
                    dialog.borrow_mut().calls.clear();
                    for _ in 0..3 {
                        // This is the same first-ready policy used by preferences_ready.
                        // A later report must not enter placement at all, even to set minimums.
                        assert!(
                            !state.report_content(content),
                            "a later Preferences report requested placement"
                        );
                    }
                    assert!(dialog.borrow().calls.is_empty());
                    assert_eq!(state.content_fit.unwrap().logical_height(1.0), 2400.0);
                    // Owner minimize/restore and a stale read immediately after unminimize.
                    // Native state guards turn an iconic owner/dialog into no snapshot.
                    state.record_frame(stable_normal_frame(&work, None, Some(user)), true);
                    assert!(recover_retained_frame(
                        state.last_normal.as_ref(),
                        std::slice::from_ref(&work),
                        || panic!("reachable reveal sampled or reapplied the live frame"),
                    )
                    .unwrap());
                    assert!(dialog.borrow().calls.is_empty());
                    let captured = state
                        .last_normal
                        .clone()
                        .unwrap()
                        .close_frame(None, None)
                        .unwrap();
                    saved =
                        serde_json::from_slice(&serde_json::to_vec(&captured).unwrap()).unwrap();
                    assert_eq!(
                        (saved.x, saved.y, saved.size),
                        (300.0, 240.0, Some((620.0, 460.0)))
                    );
                    assert_eq!(
                        dialog.borrow().position,
                        tauri::LogicalPosition::new(300.0, 240.0)
                    );
                    assert_eq!(
                        dialog.borrow().client,
                        tauri::LogicalSize::new(620.0, 460.0)
                    );
                }
            }
        }
    }

    #[test]
    fn invalid_and_iconic_snapshots_never_replace_pending_persisted_or_retained_frames() {
        for scale in [1.0, 1.5, 2.0] {
            let work = WorkArea {
                id: "screen".into(),
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 900.0,
                scale,
            };
            let valid = normal_test_frame(scale);
            let mut state = PreferencesLayout::default();
            state.record_frame(stable_normal_frame(&work, Some(valid), Some(valid)), true);
            let expected = state.pending_move.as_ref().unwrap().1.clone();
            for invalid in [
                None, // IsIconic on either the dialog or its owner; failed native reads.
                Some(PhysicalNormalFrame {
                    position: (-32000, -32000),
                    ..valid
                }),
                Some(PhysicalNormalFrame {
                    outer: (32767, 32767),
                    client: (32767, 32767),
                    ..valid
                }),
                Some(PhysicalNormalFrame {
                    client: (0, 0),
                    ..valid
                }),
                Some(PhysicalNormalFrame {
                    client: (valid.outer.0 + 1, valid.client.1),
                    ..valid
                }),
            ] {
                let rejected = stable_normal_frame(&work, invalid, invalid);
                assert!(rejected.is_none());
                state.record_frame(rejected, true);
                assert_eq!(state.pending_move.as_ref().unwrap().1.size, expected.size);
                assert_eq!(state.last_normal.as_ref().unwrap().physical, valid);
                assert!(recover_retained_frame(
                    state.last_normal.as_ref(),
                    std::slice::from_ref(&work),
                    || panic!("invalid frame became a full-work-area placement input")
                )
                .unwrap());
            }
            // Close's invalid live capture must not win over a valid queued event or disk.
            let path = preferences_test_path("invalid-native");
            write_positions(&path, vec![("preferences".into(), expected.clone())]);
            let registry = Mutex::new(Registry {
                preferences: Some(state),
                ..Registry::default()
            });
            let invalid_saved = SavedPosition {
                size: Some((32767.0, 32767.0)),
                ..expected.clone()
            };
            flush_preferences_to(&registry, &path, PreferencesClose::Close, || {
                Some(invalid_saved.clone())
            });
            write_positions(&path, vec![("preferences".into(), invalid_saved)]);
            let positions: HashMap<String, SavedPosition> =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let saved = &positions["preferences"];
            assert_eq!(
                (saved.x, saved.y, saved.size),
                (240.0, 180.0, expected.size)
            );
            assert!(restorable_position(Some(saved), std::slice::from_ref(&work)).is_some());
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn retained_recovery_waits_for_normal_geometry_and_dpi_conversion_happens_once() {
        // A valid but stale pre-restore rectangle must also be rejected, without confusing
        // screen coordinates with WINDOWPLACEMENT's workspace coordinates on negative monitors.
        assert!(normal_rect_matches_live(
            (-1800, 180, -1224, 640),
            (-1840, 156, -1264, 616),
            (40, 24),
        ));
        assert!(!normal_rect_matches_live(
            (240, 180, 816, 640),
            (-1840, 156, -1264, 616),
            (40, 24),
        ));
        for source_scale in [1.0, 1.5, 2.0] {
            for scale in [1.0, 1.5, 2.0] {
                let work = WorkArea {
                    id: "destination".into(),
                    x: -2000.0,
                    y: 0.0,
                    width: 1600.0,
                    height: 1000.0,
                    scale,
                };
                let before = normal_test_frame(source_scale);
                let after = PhysicalNormalFrame {
                    position: ((-1800.0 * scale) as i32, (180.0 * scale) as i32),
                    ..normal_test_frame(scale)
                };
                // A torn DPI transition is never a user resize or a placement input.
                assert!(stable_normal_frame(&work, Some(before), Some(after)).is_none());
                if scale != source_scale {
                    assert!(stable_normal_frame(&work, Some(before), Some(before)).is_none());
                }
                let restored = stable_normal_frame(&work, Some(after), Some(after)).unwrap();
                assert_eq!(restored.saved.size, Some((560.0, 420.0)));
                assert_eq!((restored.saved.x, restored.saved.y), (-1800.0, 180.0));
                assert!(restored.reachable(std::slice::from_ref(&work)));
                let retained = NormalFrame::validated(
                    &WorkArea {
                        scale: source_scale,
                        ..work.clone()
                    },
                    before,
                )
                .unwrap();
                assert!(!recover_retained_frame(
                    Some(&retained),
                    std::slice::from_ref(&work),
                    || {
                        // Stale parked geometry immediately after unminimize: wait, without setters.
                        let stale = PhysicalNormalFrame {
                            position: (-32000, -32000),
                            ..after
                        };
                        Ok(stable_normal_frame(&work, Some(stale), Some(stale)).is_some())
                    }
                )
                .unwrap());
                assert!(recover_retained_frame(
                    Some(&retained),
                    std::slice::from_ref(&work),
                    || {
                        assert_eq!(restored.saved.size, retained.saved.size);
                        Ok(true)
                    }
                )
                .unwrap());
                // Negative monitor coordinates have no arbitrary minimum-value cutoff.
                let far_work = WorkArea {
                    x: -40000.0,
                    y: -40000.0,
                    width: 10000.0,
                    height: 10000.0,
                    scale: 1.0,
                    ..work.clone()
                };
                let far_frame = PhysicalNormalFrame {
                    position: (-32000, -32000),
                    ..normal_test_frame(1.0)
                };
                assert!(NormalFrame::validated(&far_work, far_frame).is_some());
            }
        }
    }

    #[test]
    fn preferences_saved_and_live_frames_survive_tall_content_and_reopen() {
        use std::cell::RefCell;
        for (macos, border, title_bar) in [(false, 16.0, 40.0), (true, 0.0, 28.0)] {
            for scale in [1.0, 1.5, 2.0] {
                let work = WorkArea {
                    id: "screen".into(),
                    x: 0.0,
                    y: 0.0,
                    width: 1200.0,
                    height: 900.0,
                    scale,
                }
                .inset(12.0);
                let spec = kind_spec("preferences").unwrap();
                let content = MeasuredContent::new(
                    ContentFit::from_ready(&json!({
                        "contentWidth": 1000.0,
                        "contentHeight": 2400.0,
                        "pixelRatio": scale
                    })),
                    Some(scale),
                );
                // First open still fits content, capped by placement to the work area.
                assert_eq!(
                    dialog_client_size(&spec, content, None, false),
                    (1000.0, 2400.0)
                );
                let mut saved = SavedPosition {
                    size: Some((560.0, 420.0)),
                    monitor: work.id.clone(),
                    x: 240.0,
                    y: 180.0,
                    offset_x: 0.0,
                    offset_y: 0.0,
                };
                let dialog = RefCell::new(SimulatedDialog {
                    scale,
                    client: tauri::LogicalSize::new(spec.size.0, spec.size.1),
                    minimum: tauri::LogicalSize::new(spec.min_size.0, spec.min_size.1),
                    position: tauri::LogicalPosition::new(0.0, 0.0),
                    decoration: tauri::LogicalSize::new(border, title_bar),
                    queue: Vec::new(),
                    calls: Vec::new(),
                });
                // Initial ready restores the saved frame; reveal, observer refits, and a
                // later close/reopen must not replace its height and clamp its top to y=12.
                for current_frame in [false, true, true, false] {
                    SimulatedDialog::place(
                        &dialog,
                        macos,
                        DialogPlacement {
                            position: (saved.x * scale, saved.y * scale, scale),
                            client_size: dialog_client_size(
                                &spec,
                                content,
                                Some(&saved),
                                current_frame,
                            ),
                            content,
                            work: &work,
                            spec: &spec,
                            fit_content: true,
                            template: (!current_frame).then_some(TemplatePlacement {
                                saved: Some(&saved),
                                owner_rect: (0.0, 0.0, 1200.0, 900.0),
                            }),
                        },
                    );
                    let native = dialog.borrow();
                    assert_eq!((native.position.x, native.position.y), (240.0, 180.0));
                    assert_eq!((native.client.width, native.client.height), (560.0, 420.0));
                    assert_eq!((native.minimum.width, native.minimum.height), spec.min_size);
                    let position = native.position.to_physical::<i32>(scale);
                    let frame = native.frame();
                    let captured = preferences_close_frame(
                        &work,
                        (position.x, position.y),
                        frame.outer,
                        frame.client,
                        None,
                        None,
                    )
                    .unwrap();
                    saved =
                        serde_json::from_slice(&serde_json::to_vec(&captured).unwrap()).unwrap();
                    assert_eq!(
                        (saved.x, saved.y, saved.size),
                        (240.0, 180.0, Some((560.0, 420.0)))
                    );
                }
                // A remembered frame outside the visible work area is still resized and clamped.
                saved.x = 1120.0;
                saved.y = 850.0;
                saved.size = Some((1600.0, 1200.0));
                SimulatedDialog::place(
                    &dialog,
                    macos,
                    DialogPlacement {
                        position: (saved.x * scale, saved.y * scale, scale),
                        client_size: dialog_client_size(&spec, content, Some(&saved), true),
                        content,
                        work: &work,
                        spec: &spec,
                        fit_content: true,
                        template: None,
                    },
                );
                let native = dialog.borrow();
                assert_eq!((native.position.x, native.position.y), (work.x, work.y));
                assert_eq!(
                    (native.client.width, native.client.height),
                    (work.width - border, work.height - title_bar)
                );
            }
        }
    }
    #[test]
    fn live_content_minimum_updates_both_axes_on_refit_and_caps_to_work_area() {
        use std::cell::RefCell;
        for (macos, scale, border, title_bar) in [
            (false, 1.0_f64, 16.0_f64, 40.0_f64),
            (false, 1.5, 16.0, 40.0),
            (true, 2.0, 0.0, 28.0),
        ] {
            for kind in [
                "preferences",
                "pageSize",
                "insertTable",
                "export",
                "arrangementSpacing",
                "engineInstall",
                "toolInstall",
                "vibeCodeGuide",
            ] {
                let work = WorkArea {
                    id: "screen".into(),
                    x: 0.0,
                    y: 0.0,
                    width: 1200.0,
                    height: 900.0,
                    scale,
                }
                .inset(12.0);
                let spec = kind_spec(kind).unwrap();
                let dialog = RefCell::new(SimulatedDialog {
                    scale,
                    client: tauri::LogicalSize::new(900.0, 700.0),
                    minimum: tauri::LogicalSize::new(spec.min_size.0, spec.min_size.1),
                    position: tauri::LogicalPosition::new(100.0, 100.0),
                    decoration: tauri::LogicalSize::new(border, title_bar),
                    queue: Vec::new(),
                    calls: Vec::new(),
                });
                // Large user sizes stay large; the live minimum follows content, including
                // removal of content. Preferences instead keeps its scrollable viewport.
                for (width, height) in [
                    (548.0_f64, 334.0_f64),
                    (600.0, 480.0),
                    (460.0, 280.0),
                    (4096.0, 4096.0),
                ] {
                    // WebView zoom differs from native DPI; measurement must convert through
                    // the native scale captured with ready, then constrain logical inner units.
                    let ratio = scale * 1.25;
                    let content = MeasuredContent::new(
                        ContentFit::from_ready(&json!({
                            "contentWidth": width / 1.25,
                            "contentHeight": height / 1.25,
                            "pixelRatio": ratio
                        })),
                        Some(scale),
                    );
                    let frame = dialog.borrow().frame();
                    let position = dialog.borrow().position.to_physical::<i32>(scale);
                    let saved = saved_frame(
                        &work,
                        (position.x, position.y),
                        frame.outer,
                        Some((dialog.borrow().client.width, dialog.borrow().client.height)),
                    );
                    SimulatedDialog::place(
                        &dialog,
                        macos,
                        DialogPlacement {
                            position: (saved.x * scale, saved.y * scale, scale),
                            client_size: dialog_client_size(&spec, content, Some(&saved), true),
                            content,
                            work: &work,
                            spec: &spec,
                            fit_content: true,
                            template: None,
                        },
                    );
                    let native = dialog.borrow();
                    assert_eq!(
                        native.minimum.width,
                        (if kind == "preferences" {
                            spec.min_size.0
                        } else {
                            width
                        })
                        .min(work.width - border),
                        "{kind}"
                    );
                    assert_eq!(
                        native.minimum.height,
                        (if kind == "preferences" {
                            spec.min_size.1
                        } else {
                            height
                        })
                        .min(work.height - title_bar),
                        "{kind}"
                    );
                    assert!(native.client.width >= native.minimum.width);
                    assert!(native.client.height >= native.minimum.height);
                }
            }
        }
    }
    #[test]
    fn page_size_outer_origin_survives_three_save_reopen_refit_cycles() {
        use std::cell::RefCell;
        for (macos, scale, border, title_bar) in [
            (false, 1.0_f64, 16.0_f64, 40.0_f64),
            (false, 1.5, 16.0, 40.0),
            (true, 2.0, 0.0, 28.0),
        ] {
            let work = WorkArea {
                id: "screen".into(),
                x: 0.0,
                y: 0.0,
                width: 2000.0,
                height: 1600.0,
                scale,
            }
            .inset(12.0);
            let spec = kind_spec("pageSize").unwrap();
            let expected = (400_i32, 965_i32);
            let old_outer = tauri::LogicalSize::new(548.0 + border, 334.0 + title_bar)
                .to_physical::<u32>(scale);
            let mut saved = saved_frame(
                &work,
                expected,
                (old_outer.width, old_outer.height),
                Some((548.0, 334.0)),
            );
            for open in 0..3 {
                // Fresh webviews initially measure at the spec's narrower width, then report
                // their fitted layout. Both passes must preserve the saved outer origin.
                let dialog = RefCell::new(SimulatedDialog {
                    scale,
                    client: tauri::LogicalSize::new(spec.size.0, spec.size.1),
                    minimum: tauri::LogicalSize::new(spec.min_size.0, spec.min_size.1),
                    position: tauri::LogicalPosition::new(0.0, 0.0),
                    decoration: tauri::LogicalSize::new(border, title_bar),
                    queue: Vec::new(),
                    calls: Vec::new(),
                });
                for (refit, height) in [(false, 432.0_f64), (true, 334.0_f64)] {
                    let content = MeasuredContent::new(
                        ContentFit::from_ready(&json!({
                            "contentWidth": 548.0,
                            "contentHeight": height,
                            "pixelRatio": scale
                        })),
                        Some(scale),
                    );
                    let client_size = dialog_client_size(&spec, content, Some(&saved), refit);
                    SimulatedDialog::place(
                        &dialog,
                        macos,
                        DialogPlacement {
                            position: (saved.x * scale, saved.y * scale, scale),
                            client_size,
                            content,
                            work: &work,
                            spec: &spec,
                            fit_content: true,
                            template: (!refit).then_some(TemplatePlacement {
                                saved: Some(&saved),
                                owner_rect: (0.0, 0.0, 1000.0, 800.0),
                            }),
                        },
                    );
                    let native = dialog.borrow();
                    let position = native.position.to_physical::<i32>(scale);
                    assert_eq!(
                        (position.x, position.y),
                        expected,
                        "{macos} {scale}x open {open}"
                    );
                    let frame = native.frame();
                    saved = saved_frame(
                        &work,
                        (position.x, position.y),
                        frame.outer,
                        Some((native.client.width, native.client.height)),
                    );
                }
            }
        }
    }
    #[test]
    fn windows_odd_physical_origin_survives_three_save_reopen_cycles() {
        for scale in [1.5_f64, 1.75_f64] {
            let work = WorkArea {
                id: "screen".into(),
                x: 0.0_f64,
                y: 0.0_f64,
                width: 2000.0_f64,
                height: 1600.0_f64,
                scale,
            };
            let expected = (61_i32, 115_i32);
            let outer = (823_u32, 561_u32);
            let mut saved = saved_frame(&work, expected, outer, None);
            for open in 0..3 {
                let position = position_for(
                    Some(&saved),
                    std::slice::from_ref(&work),
                    &work,
                    (0.0_f64, 0.0_f64, 1000.0_f64, 800.0_f64),
                    (f64::from(outer.0) / scale, f64::from(outer.1) / scale),
                );
                // 61 / 1.75 * 1.75 is just below 61: truncation loses a physical pixel.
                // Use the actual Windows move callback, not LogicalPosition::to_physical,
                // whose own rounding could conceal a regression in move_dialog.
                let mut physical = None;
                move_dialog(
                    false,
                    position,
                    |_| panic!("Windows must move in physical coordinates"),
                    |position| {
                        physical = Some((position.x, position.y));
                        Ok(())
                    },
                )
                .unwrap();
                assert_eq!(physical, Some(expected), "{scale}x open {open}");
                saved = saved_frame(&work, physical.unwrap(), outer, None);
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
                                content: Some(measured),
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
                                (f64::from(expected_client.1) / scale).min(
                                    if kind == "preferences" {
                                        spec.min_size.1
                                    } else {
                                        height
                                    }
                                ),
                                "minimum: {case}"
                            );
                            assert_eq!(
                                native.minimum.width,
                                (f64::from(expected_client.0) / scale).min(
                                    if kind == "preferences" {
                                        spec.min_size.0
                                    } else {
                                        spec.size.0
                                    }
                                ),
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
                                // Preserve the Windows physical-coordinate rounding.
                                (
                                    (expected_x * scale).round() as i32 as f64 / scale,
                                    (expected_y * scale).round() as i32 as f64 / scale,
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
    fn custom_color_refits_shrink_removed_content_but_keep_user_sizes() {
        let spec = kind_spec("customColor").unwrap();
        assert_eq!(spec.size, (460.0, 320.0));
        assert_eq!(spec.min_size, (360.0, 240.0));
        assert!(spec.fit_content);
        for scale in [1.0, 1.5, 2.0] {
            for user_size in [None, Some((600.0_f64, 500.0_f64))] {
                let mut current = user_size.unwrap_or(spec.size);
                // Hex, validation error, CMYK explanation, then Hex again.
                for height in [300.0_f64, 350.0, 390.0, 300.0] {
                    let fit = MeasuredContent::new(
                        ContentFit::from_ready(&json!({
                            "contentHeight": height,
                            "contentWidth": 460.0,
                            "pixelRatio": scale
                        })),
                        Some(scale),
                    )
                    .unwrap();
                    current = custom_color_refit_size(fit, current, user_size);
                    assert_eq!(
                        current,
                        (
                            user_size.map_or(spec.size.0, |size| size.0),
                            height.max(user_size.map_or(1.0, |size| size.1))
                        )
                    );
                }
            }
        }
    }
    #[test]
    fn content_refits_preserve_user_sizes_and_cap_to_work_area() {
        use std::cell::Cell;
        for (macos, border, title_bar) in [(true, 0, 28), (false, 16, 40)] {
            for scale in [1.0, 1.5, 2.0] {
                for kind in ["pageSize", "export"] {
                    let spec = kind_spec(kind).unwrap();
                    // Includes the old Custom Page Size 420x300 frame, a narrower but
                    // taller frame, and a wider but shorter frame. Each axis fits independently.
                    for (extra_width, user_height) in [
                        (0.0_f64, 180.0_f64),
                        (0.0, 300.0),
                        (-40.0, 800.0),
                        (80.0, 300.0),
                        (80.0, 800.0),
                    ] {
                        let work = WorkArea {
                            id: "screen".into(),
                            x: -1000.0,
                            y: 0.0,
                            width: 700.0,
                            height: 900.0,
                            scale,
                        }
                        .inset(12.0);
                        let mut saved = SavedPosition {
                            size: Some((spec.size.0 + extra_width, user_height)),
                            monitor: work.id.clone(),
                            x: -900.0,
                            y: 100.0,
                            offset_x: 0.0,
                            offset_y: 0.0,
                        };
                        // Initial full form, extra cancellation line, removed line, huge report.
                        for height in [
                            if macos { 334.0_f64 } else { 286.0_f64 },
                            358.0,
                            334.0,
                            4096.0,
                        ] {
                            let width = if height == 4096.0 {
                                4096.0
                            } else {
                                spec.size.0
                            };
                            let measured = MeasuredContent::new(
                                ContentFit::from_ready(&json!({
                                    "contentHeight": height,
                                    "contentWidth": width,
                                    "pixelRatio": scale
                                })),
                                Some(scale),
                            );
                            let desired = dialog_client_size(&spec, measured, Some(&saved), true);
                            assert_eq!(
                                desired,
                                (
                                    width.max(saved.size.unwrap().0),
                                    height.max(saved.size.unwrap().1)
                                )
                            );
                            assert!(desired.0 >= spec.size.0);
                            assert!(desired.0 >= saved.size.unwrap().0);
                            assert!(desired.1 >= height);
                            assert!(desired.1 >= saved.size.unwrap().1);
                            let initial = dialog_client_size(&spec, measured, Some(&saved), false);
                            assert!(initial.0 >= spec.size.0);
                            assert!(initial.1 >= height);
                            let client = Cell::new((1_u32, 1_u32));
                            let position = Cell::new((0.0, 0.0));
                            finish_placement(
                                ((saved.x * scale, saved.y * scale, scale), desired),
                                &work,
                                true,
                                None,
                                |x, y| {
                                    position.set((x, y));
                                    Ok(())
                                },
                                |width, height| {
                                    resize_dialog_client(
                                        macos,
                                        tauri::PhysicalSize::new(width, height),
                                        scale,
                                        |logical| {
                                            let physical = logical.to_physical::<u32>(scale);
                                            client.set((physical.width, physical.height));
                                            Ok(())
                                        },
                                        |physical| {
                                            client.set((physical.width, physical.height));
                                            Ok(())
                                        },
                                    )
                                },
                                || {
                                    Ok(DialogFrame {
                                        client: client.get(),
                                        outer: (
                                            client.get().0 + border,
                                            client.get().1 + title_bar,
                                        ),
                                    })
                                },
                            )
                            .unwrap();
                            let maximum_width = (work.width * scale) as u32 - border;
                            assert_eq!(
                                client.get().0,
                                ((desired.0 * scale).ceil() as u32).min(maximum_width)
                            );
                            let maximum = (work.height * scale) as u32 - title_bar;
                            assert_eq!(
                                client.get().1,
                                ((desired.1 * scale).ceil() as u32).min(maximum)
                            );
                            assert!(position.get().1 >= work.y * scale);
                            assert!(position.get().0 >= work.x * scale);
                            assert!(
                                position.get().0 + f64::from(client.get().0 + border)
                                    <= (work.x + work.width) * scale
                            );
                            assert!(
                                position.get().1 + f64::from(client.get().1 + title_bar)
                                    <= (work.y + work.height) * scale
                            );
                            saved.size = Some((
                                f64::from(client.get().0) / scale,
                                f64::from(client.get().1) / scale,
                            ));
                        }
                    }
                }
            }
        }
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
            let (registration, _) =
                register(&crate::test_documents(), &mut registry, snapshot(), false).unwrap();
            registry.preferences = Some(PreferencesLayout {
                applied_position: None,
                content_fit: None,
                ready: true,
                transient_until: now + Duration::from_millis(500),
                programmatic_client: Some((600, 400)),
                programmatic_position: Some((100, 200)),
                pending_move: None,
                ..PreferencesLayout::default()
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
            "customColor",
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
            json!({"contentHeight": 334, "contentWidth": 420, "pixelRatio": 2}),
        ] {
            ready.data = data;
            assert!(
                ready.validate(&crate::test_documents()).is_ok(),
                "{}",
                ready.data
            );
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
            json!({"contentHeight": 334, "contentWidth": null, "pixelRatio": 2}),
            json!({"contentHeight": 334, "contentWidth": 0, "pixelRatio": 2}),
            json!({"contentHeight": 334, "contentWidth": 4097, "pixelRatio": 2}),
        ] {
            ready.data = data;
            assert!(
                ready.validate(&crate::test_documents()).is_err(),
                "{}",
                ready.data
            );
            assert_eq!(ContentFit::from_ready(&ready.data), None);
        }
        // A request still carries nothing.
        ready.message_type = "request".into();
        ready.data = json!({"contentHeight": 263, "pixelRatio": 1});
        assert!(ready.validate(&crate::test_documents()).is_err());
        let fit = |content_height, pixel_ratio, scale| {
            MeasuredContent::new(
                Some(ContentFit {
                    content_height,
                    content_width: None,
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
        let width = MeasuredContent::new(
            ContentFit::from_ready(&json!({
                "contentHeight": 334, "contentWidth": 420, "pixelRatio": 1.875
            })),
            Some(1.5),
        )
        .unwrap();
        assert_eq!(width.logical_width(), Some(525.0));
        // Explicit caller floors are honored; production content fitting passes 1px.
        assert_eq!(fit(200.0, 1.0, 1.0).logical_height(240.0), 240.0);
        // No usable scale at measurement, or no measurement: the spec size applies.
        let measured = Some(ContentFit {
            content_height: 263.0,
            content_width: None,
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
        assert!(ready.validate(&crate::test_documents()).is_err());
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
        assert!(capability.contains("dialog-*-insertTable-*"));
        let mut message = snapshot();
        message.dialog_kind = "insertTable".into();
        message.data = json!({"title":"Drawing", "rows":4, "columns":3,
            "headerRows":1, "preset":"three-line"});
        assert!(message.validate(&crate::test_documents()).is_ok());
        let mut registry = Registry::default();
        let (registration, _) = register(
            &crate::test_documents(),
            &mut registry,
            message.clone(),
            false,
        )
        .unwrap();
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
            assert!(message.validate(&crate::test_documents()).is_ok());
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
                assert!(message.validate(&crate::test_documents()).is_err());
            }
            for header_rows in [0, 500] {
                message.data = data.clone();
                message.data["rows"] = json!(500);
                message.data["columns"] = json!(64);
                message.data["headerRows"] = json!(header_rows);
                assert!(message.validate(&crate::test_documents()).is_ok());
            }
        }
        message.data = json!({"action":"cancel"});
        assert!(message.validate(&crate::test_documents()).is_ok());
        message.data["rows"] = json!(4);
        assert!(message.validate(&crate::test_documents()).is_err());
        message.data = json!({"action":"preview", "percent":80});
        assert!(message.validate(&crate::test_documents()).is_err());
    }
    #[test]
    fn custom_color_registers_labels_and_validates_payloads() {
        let spec = kind_spec("customColor").unwrap();
        assert!(!spec.maximizable);
        assert!(spec.resizable);
        assert!(include_str!("../capabilities/dialog-host.json").contains("dialog-*-customColor-*"));
        let mut message = snapshot();
        message.dialog_kind = "customColor".into();
        message.data =
            json!({"title":"Custom Color 1, Slot 2", "swatch":1, "slot":2, "color":null});
        assert!(message.validate(&crate::test_documents()).is_ok());
        let (registration, _) = register(
            &crate::test_documents(),
            &mut Registry::default(),
            message.clone(),
            false,
        )
        .unwrap();
        assert!(registration
            .window_label
            .starts_with("dialog-main-customColor-"));
        assert!(is_dialog_label(&registration.window_label));
        assert!(!is_dialog_label("dialog-main-customColor-../main"));
        for (field, value) in [
            ("swatch", json!(5)),
            ("slot", json!(0)),
            ("color", json!("#abcd")),
            ("extra", json!(true)),
        ] {
            let mut invalid = message.clone();
            invalid.data[field] = value;
            assert!(invalid.validate(&crate::test_documents()).is_err());
        }
        message.message_type = "action".into();
        for data in [
            json!({"action":"apply", "hex":"#1f5fbf"}),
            json!({"action":"clear"}),
            json!({"action":"cancel"}),
        ] {
            message.data = data;
            assert!(message.validate(&crate::test_documents()).is_ok());
        }
        for data in [
            json!({"action":"apply", "hex":"#ABCDEF"}),
            json!({"action":"apply", "hex":"#12345678"}),
            json!({"action":"clear", "swatch":1}),
        ] {
            message.data = data;
            assert!(message.validate(&crate::test_documents()).is_err());
        }
    }
    #[test]
    fn validates_kind_label_owner_and_payload() {
        let mut m = snapshot();
        assert!(m.validate(&crate::test_documents()).is_ok());
        for kind in ["export", "pageSize/../main", "unknown"] {
            m.dialog_kind = kind.into();
            assert!(m.validate(&crate::test_documents()).is_err());
        }
        m = snapshot();
        m.owner_window_id = "preferences".into();
        assert!(m.validate(&crate::test_documents()).is_err());
        m = snapshot();
        m.data["title"] = json!("x".repeat(MAX_BYTES));
        assert!(m.validate(&crate::test_documents()).is_err());
        m = snapshot();
        m.data["callback"] = json!("command");
        assert!(m.validate(&crate::test_documents()).is_err());
        m = snapshot();
        m.data["title"] = json!("😀".repeat(128));
        assert!(m.validate(&crate::test_documents()).is_ok());
        m.data["title"] = json!("😀".repeat(129));
        assert!(m.validate(&crate::test_documents()).is_err());
        m = snapshot();
        m.message_type = "result".into();
        m.data = json!({"status": "error", "error": null});
        assert!(m.validate(&crate::test_documents()).is_err());
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
        let (r, _) = register(&crate::test_documents(), &mut registry, snapshot(), false).unwrap();
        let s = &registry.sessions[&r.host_id];
        assert!(authorize(
            &crate::test_documents(),
            s,
            &r.window_label,
            false,
            Some(&snapshot())
        )
        .is_ok());
        assert!(authorize(&crate::test_documents(), s, "main", false, None).is_err());
        let mut stale = snapshot();
        stale.session_id = "stale".into();
        assert!(authorize(
            &crate::test_documents(),
            s,
            &r.window_label,
            false,
            Some(&stale)
        )
        .is_err());
        stale = snapshot();
        stale.snapshot_revision += 1;
        assert!(authorize(
            &crate::test_documents(),
            s,
            &r.window_label,
            false,
            Some(&stale)
        )
        .is_err());
    }
    #[test]
    fn quit_refuses_and_concurrent_same_session_builds_once() {
        assert!(register(
            &crate::test_documents(),
            &mut Registry::default(),
            snapshot(),
            true
        )
        .is_err());
        let registry = std::sync::Arc::new(Mutex::new(Registry::default()));
        let builds = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                let builds = builds.clone();
                std::thread::spawn(move || {
                    let (r, build) = register(
                        &crate::test_documents(),
                        &mut registry.lock().unwrap(),
                        snapshot(),
                        false,
                    )
                    .unwrap();
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
            (1500.0, 0.0, 1.5)
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
        assert!(snapshot.validate(&crate::test_documents()).is_ok());
        let mut registry = Registry::default();
        let (r, _) = register(
            &crate::test_documents(),
            &mut registry,
            snapshot.clone(),
            false,
        )
        .unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        for action in ["export", "chooseDestination"] {
            let mut m = snapshot.clone();
            m.message_type = "action".into();
            m.data = json!({"action":action,"options":snapshot.data["options"]});
            assert!(m.validate(&crate::test_documents()).is_ok());
            assert!(
                serde_json::to_vec(&delivery(session, &r.window_label, &m).unwrap())
                    .unwrap()
                    .len()
                    <= MAX_CHANNEL_BYTES
            );
            m.data["options"]["raster"]["scale"] = json!(5);
            assert!(m.validate(&crate::test_documents()).is_err());
            m.data["options"] = snapshot.data["options"].clone();
            m.data["options"]["destinationPath"] = Value::Null;
            assert!(m.validate(&crate::test_documents()).is_err());
            m.data["options"] = snapshot.data["options"].clone();
            m.data["options"]["filename"] = json!("../Drawing.pdf");
            assert!(m.validate(&crate::test_documents()).is_err());
            m.data["options"] = snapshot.data["options"].clone();
            m.data["options"]["command"] = json!("document.delete");
            assert!(m.validate(&crate::test_documents()).is_err());
        }
        let mut m = snapshot.clone();
        m.message_type = "action".into();
        m.data = json!({"action":"apply","width":1,"height":2,"unit":"mm"});
        assert!(m.validate(&crate::test_documents()).is_err());
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
            assert!(m.validate(&crate::test_documents()).is_ok());
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
        let (r, _) = register(&crate::test_documents(), &mut registry, m.clone(), false).unwrap();
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
        let (r, _) = register(&crate::test_documents(), &mut registry, m.clone(), false).unwrap();
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
        let (r, _) = register(
            &crate::test_documents(),
            &mut registry,
            snapshot.clone(),
            false,
        )
        .unwrap();
        let session = registry.sessions.get_mut(&r.host_id).unwrap();
        let mut action = snapshot.clone();
        action.message_type = "action".into();
        action.data = json!({"action":"preview","options":snapshot.data["options"]});
        for i in 0..150 {
            action.request_id = format!("preview-{i}");
            assert!(action.validate(&crate::test_documents()).is_ok());
            assert!(reserve_action(session, &action).unwrap());
        }
        assert!(session.terminal_request.is_none());
        assert_eq!(session.actions.len(), 1);
        let mut result = action.clone();
        result.message_type = "result".into();
        result.data = json!({"status":"preview","preview":{"url":format!("data:image/png;base64,{}", "A".repeat(20000)),"kind":"image","width":100,"height":100,"warnings":[]}});
        assert!(result.validate(&crate::test_documents()).is_ok());
        result.data["preview"]["url"] = json!("https://example.com/image.png");
        assert!(result.validate(&crate::test_documents()).is_err());
        result.data["preview"]["url"] = json!(format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_PREVIEW_BYTES)
        ));
        assert!(result.validate(&crate::test_documents()).is_err());
        action.request_id = "export".into();
        action.data["action"] = json!("export");
        assert!(reserve_action(session, &action).unwrap());
    }
    #[test]
    fn validates_frame_revision_and_presentation_types() {
        let mut snapshot = export_snapshot();
        let presentation = json!({"width":600,"height":400,"linked":false,"preset":"custom","dpi":300,"crop":"content","background":"white"});
        snapshot.data["options"]["presentation"] = presentation.clone();
        assert!(snapshot.validate(&crate::test_documents()).is_ok());
        for value in [json!(0), json!(1.5), Value::Null] {
            snapshot.data["options"]["presentation"]["width"] = value;
            assert!(snapshot.validate(&crate::test_documents()).is_err());
        }
        snapshot.message_type = "result".into();
        snapshot.data = json!({"status":"frame","frame":{"page":{"width":100,"height":100},"content":{"width":80,"height":80},"revision":2}});
        assert!(snapshot.validate(&crate::test_documents()).is_ok());
        snapshot.data["frame"]["revision"] = Value::Null;
        assert!(snapshot.validate(&crate::test_documents()).is_err());
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
