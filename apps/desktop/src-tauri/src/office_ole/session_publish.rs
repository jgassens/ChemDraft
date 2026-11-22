//! Windows session end for embedded Office editors, as host-neutral decisions.
//!
//! When Windows asks whether the session may end, every open editor is asked for its drawing. The
//! STA saves each collected drawing into Office as soon as it arrives. While any editor's drawing is
//! neither confirmed saved in Office nor beyond saving (Office closed the object), the session end
//! is refused with a reason, and collection and retries continue. A save failure never drops an
//! editor. If Windows ends the session anyway, every drawing still at risk has a recovery copy.
//!
//! The tracker is shared by the main thread, the IPC handlers and the STA behind one mutex. None of
//! them waits on another while holding it, and the main thread never waits on the STA.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

/// How long the STA waits before retrying a drawing Office did not take.
pub(super) const RETRY_INTERVAL: Duration = Duration::from_secs(1);
/// Longest document name carried into a shutdown reason (matches the editor URL's limit).
const MAX_REASON_NAME_CHARS: usize = 80;
/// Windows' MAX_STR_BLOCKREASON is 256 UTF-16 units including the terminator.
pub(crate) const MAX_REASON_UNITS: usize = 255;
pub(crate) const SAVING_REASON: &str = "Saving ChemDraft structures in Office documents";

pub(super) trait Drawing {
    fn json(&self) -> &str;
}

impl Drawing for super::presentation::Content {
    fn json(&self) -> &str {
        &self.json
    }
}

/// What the STA knows about one open edit session. The STA keeps it current, so the main thread
/// can name documents and find the last known drawing without asking the STA.
struct Known {
    app: String,
    document: String,
    json: Arc<str>,
}

enum Stage<T> {
    /// Asked for the renderer's drawing; none has arrived.
    Waiting,
    /// The renderer answered that it could not render or send its drawing. Its edits exist only
    /// in the renderer, so the STA has nothing newer to save: the session end stays refused and
    /// the last known drawing gets a recovery copy.
    Unsent,
    /// Collected and waiting for the STA to save it into Office.
    Ready(T),
    /// The STA is saving it now.
    Saving,
    /// Office did not take it. `content` is the drawing if the STA never installed it.
    Failed {
        content: Option<T>,
        error: String,
        retry_at: Instant,
    },
    /// Office confirmed the save, or the editor had nothing Office does not already hold.
    Saved,
    /// Office closed the object during the session end, so nothing more can be saved into it.
    /// `unsaved` means a collected drawing never reached Office; only its recovery copy remains.
    Closed { unsaved: bool },
}

impl<T> Stage<T> {
    /// A drawing that may be lost if the session ends now.
    fn at_risk(&self) -> bool {
        !matches!(self, Self::Saved | Self::Closed { unsaved: false })
    }

    /// Refuses the session end: something can still be collected or saved.
    fn blocks(&self) -> bool {
        !matches!(self, Self::Saved | Self::Closed { .. })
    }

    fn describe(&self) -> &'static str {
        match self {
            Self::Waiting => "its editor did not send its latest drawing",
            Self::Unsent => "its editor could not send its latest drawing",
            Self::Ready(_) => "its latest drawing was not saved into Office yet",
            Self::Saving => "Office had not finished saving its latest drawing",
            Self::Failed { .. } => "Office did not save its latest drawing",
            Self::Closed { .. } => "Office closed the object before its latest drawing was saved",
            Self::Saved => "saved",
        }
    }
}

/// A recovery file attempted for one drawing. `path` is `None` if writing it failed.
struct Attempt {
    path: Option<PathBuf>,
    json: Arc<str>,
}

struct Editor<T> {
    app: String,
    document: String,
    /// The newest drawing known: the STA's when the session began, then the collected one.
    json: Arc<str>,
    stage: Stage<T>,
    /// Set when the previous failure was reported, so retries log only a new error.
    reported: Option<String>,
    snapshot: Option<Attempt>,
}

impl<T> Editor<T> {
    fn name(&self) -> &str {
        display_name(&self.app, &self.document)
    }
}

/// The name a log or recovery file gives an object: its document, else its app.
pub(super) fn display_name<'a>(app: &'a str, document: &'a str) -> &'a str {
    [document, app]
        .into_iter()
        .map(str::trim)
        .find(|name| !name.is_empty())
        .unwrap_or("an Office document")
}

struct SessionEnd<T> {
    request: u32,
    stamp: String,
    editors: BTreeMap<String, Editor<T>>,
}

/// Work the STA takes out of the tracker. The request ID keeps a slow save from a cancelled
/// session end out of a later one.
pub(super) enum Job<T> {
    Install(T),
    Retry,
}

pub(super) enum Outcome<T> {
    Saved,
    Failed {
        content: Option<T>,
        error: String,
    },
    /// The STA no longer has this edit session.
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    Allow,
    Block(String),
}

impl Answer {
    pub(crate) fn blocks(&self) -> bool {
        matches!(self, Self::Block(_))
    }
}

pub(super) struct Write {
    pub editor: String,
    pub name: String,
    pub json: Arc<str>,
}

#[derive(Default)]
pub(super) struct Recovery {
    pub write: Vec<Write>,
    pub remove: Vec<(String, PathBuf)>,
}

pub(super) struct Cancelled {
    pub request: u32,
    pub recovery: Recovery,
    /// Recovery files left in place, already written.
    pub kept: Vec<PathBuf>,
}

/// A drawing at risk, for the log Windows leaves when it ends the session.
pub(crate) struct Risk {
    pub editor: String,
    pub document: String,
    pub state: &'static str,
    pub error: Option<String>,
    pub snapshot: Option<PathBuf>,
}

/// A save failure that has not been logged yet.
pub(crate) struct Failure {
    pub document: String,
    pub error: String,
}

pub(super) struct Tracker<T> {
    known: BTreeMap<String, Known>,
    session: Option<SessionEnd<T>>,
}

impl<T: Drawing> Tracker<T> {
    pub const fn new() -> Self {
        Self {
            known: BTreeMap::new(),
            session: None,
        }
    }

    // --- The STA's bookkeeping of open edit sessions.

    /// Register a new edit session. Refused (false) while a session end is pending: the editors
    /// to ask were decided when it began, so an editor registered later would be asked nothing
    /// and get no recovery copy. The caller must then tear its editor down. Registration and
    /// `begin` share this tracker's lock, so every editor is either in the session end or refused.
    pub fn opened(&mut self, editor: &str, app: &str, document: &str, json: &str) -> bool {
        if self.session.is_some() {
            return false;
        }
        self.known.insert(
            editor.to_owned(),
            Known {
                app: app.to_owned(),
                document: document.to_owned(),
                json: json.into(),
            },
        );
        true
    }

    pub fn renamed(&mut self, editor: &str, app: &str, document: &str) {
        if let Some(known) = self.known.get_mut(editor) {
            known.app = app.to_owned();
            known.document = document.to_owned();
        }
        if let Some(entry) = self.editor_mut(editor) {
            entry.app = app.to_owned();
            entry.document = document.to_owned();
        }
    }

    /// The STA installed a new drawing in this edit session's object.
    pub fn replaced(&mut self, editor: &str, json: &str) {
        if let Some(known) = self.known.get_mut(editor) {
            known.json = json.into();
        }
    }

    /// The STA removed the edit session. Returns what this did to a pending session end.
    pub fn closed(&mut self, editor: &str) -> Option<&'static str> {
        self.known.remove(editor);
        let entry = self.editor_mut(editor)?;
        let described = entry.stage.describe();
        let unsaved = match entry.stage {
            Stage::Saved | Stage::Closed { .. } => return None,
            Stage::Waiting | Stage::Unsent => false,
            Stage::Ready(_) | Stage::Saving | Stage::Failed { .. } => true,
        };
        entry.stage = Stage::Closed { unsaved };
        Some(described)
    }

    // --- The main thread's view of the session end.

    pub fn active(&self) -> bool {
        self.session.is_some()
    }

    /// Start asking every open editor for its drawing. Returns the editors to ask, or `None` if a
    /// session end is already pending (a repeated query keeps collecting into it).
    pub fn begin(&mut self, request: u32, stamp: String) -> Option<Vec<String>> {
        if self.session.is_some() {
            return None;
        }
        let editors: BTreeMap<_, _> = self
            .known
            .iter()
            .map(|(id, known)| {
                let editor = Editor {
                    app: known.app.clone(),
                    document: known.document.clone(),
                    json: known.json.clone(),
                    stage: Stage::Waiting,
                    reported: None,
                    snapshot: None,
                };
                (id.clone(), editor)
            })
            .collect();
        let ids = editors.keys().cloned().collect();
        self.session = Some(SessionEnd {
            request,
            stamp,
            editors,
        });
        Some(ids)
    }

    pub fn answer(&self) -> Answer {
        let Some(session) = &self.session else {
            return Answer::Allow;
        };
        let mut failed = session
            .editors
            .values()
            .filter(|editor| matches!(editor.stage, Stage::Failed { .. } | Stage::Unsent));
        if let Some(first) = failed.next() {
            return Answer::Block(failure_reason(first.name(), failed.count()));
        }
        if session.editors.values().any(|editor| editor.stage.blocks()) {
            Answer::Block(SAVING_REASON.into())
        } else {
            Answer::Allow
        }
    }

    /// Recovery files to write for drawings at risk and to remove for drawings now in Office.
    pub fn recovery(&self) -> Recovery {
        let mut plan = Recovery::default();
        if let Some(session) = &self.session {
            for (id, editor) in &session.editors {
                plan_editor(&mut plan, &session.stamp, id, editor);
            }
        }
        plan
    }

    pub fn wrote(&mut self, editor: &str, json: &Arc<str>, path: Option<PathBuf>) {
        if let Some(entry) = self.editor_mut(editor) {
            entry.snapshot = Some(Attempt {
                path,
                json: json.clone(),
            });
        }
    }

    pub fn removed(&mut self, editor: &str, path: &Path) {
        if let Some(entry) = self.editor_mut(editor) {
            if entry
                .snapshot
                .as_ref()
                .is_some_and(|attempt| attempt.path.as_deref() == Some(path))
            {
                entry.snapshot = None;
            }
        }
    }

    /// Windows cancelled the session end. Recovery copies of editors that are still open are
    /// removed when `remove_open` is set; a drawing Office closed keeps its copy either way.
    pub fn cancel(&mut self, remove_open: bool) -> Option<Cancelled> {
        let session = self.session.take()?;
        let mut recovery = Recovery::default();
        let mut kept = Vec::new();
        for (id, editor) in &session.editors {
            let path = editor.snapshot.as_ref().and_then(|a| a.path.clone());
            if editor.orphaned() {
                let planned = recovery.write.len();
                plan_editor(&mut recovery, &session.stamp, id, editor);
                if recovery.write.len() == planned {
                    kept.extend(path);
                }
            } else if let Some(path) = path {
                if remove_open || !editor.stage.at_risk() {
                    recovery.remove.push((id.clone(), path));
                } else {
                    kept.push(path);
                }
            }
        }
        Some(Cancelled {
            request: session.request,
            recovery,
            kept,
        })
    }

    pub fn risks(&self) -> Vec<Risk> {
        let Some(session) = &self.session else {
            return Vec::new();
        };
        session
            .editors
            .iter()
            .filter(|(_, editor)| editor.stage.at_risk())
            .map(|(id, editor)| Risk {
                editor: id.clone(),
                document: editor.name().to_owned(),
                state: editor.stage.describe(),
                error: match &editor.stage {
                    Stage::Failed { error, .. } => Some(error.clone()),
                    _ => None,
                },
                snapshot: editor.snapshot.as_ref().and_then(|a| a.path.clone()),
            })
            .collect()
    }

    // --- The renderer's replies, through IPC.

    /// Whether this request still takes the editor's answer. An editor that reported a failure
    /// may still answer later with its drawing.
    pub fn accepting(&self, request: u32, editor: &str) -> bool {
        self.session
            .as_ref()
            .filter(|session| session.request == request)
            .and_then(|session| session.editors.get(editor))
            .is_some_and(|entry| matches!(entry.stage, Stage::Waiting | Stage::Unsent))
    }

    /// The renderer could not render or send its drawing. Stop waiting on it: the editor stays
    /// at risk (refusing the session end with its document's name) and keeps a recovery copy of
    /// its last known drawing. Only a waiting editor can fail.
    pub fn unsent(&mut self, request: u32, editor: &str) -> bool {
        let waiting = self
            .session
            .as_ref()
            .filter(|session| session.request == request)
            .and_then(|session| session.editors.get(editor))
            .is_some_and(|entry| matches!(entry.stage, Stage::Waiting));
        if waiting {
            self.editor_mut(editor)
                .expect("waiting editor exists")
                .stage = Stage::Unsent;
        }
        waiting
    }

    pub fn collect(&mut self, request: u32, editor: &str, content: T) -> bool {
        if !self.accepting(request, editor) {
            return false;
        }
        let entry = self.editor_mut(editor).expect("accepting editor exists");
        entry.json = content.json().into();
        entry.stage = Stage::Ready(content);
        true
    }

    /// The renderer holds nothing Office does not already have.
    pub fn unchanged(&mut self, request: u32, editor: &str) -> bool {
        if !self.accepting(request, editor) {
            return false;
        }
        self.editor_mut(editor)
            .expect("accepting editor exists")
            .stage = Stage::Saved;
        true
    }

    /// The editor's window has gone, so no renderer will answer. Its object may still hold a
    /// drawing Office has not saved (a destroyed editor whose save failed): retry that now.
    pub fn without_renderer(&mut self, request: u32, editor: &str, now: Instant) -> bool {
        self.accepting(request, editor) && self.renderer_gone(editor, now)
    }

    /// The STA saw the editor's window destroyed while its object stayed open.
    pub fn renderer_gone(&mut self, editor: &str, now: Instant) -> bool {
        let Some(entry) = self.editor_mut(editor) else {
            return false;
        };
        if !matches!(entry.stage, Stage::Waiting | Stage::Unsent) {
            return false;
        }
        entry.stage = Stage::Failed {
            content: None,
            error: "its editor window has closed".into(),
            retry_at: now,
        };
        true
    }

    // --- The STA's saves.

    /// Drawings to save now: every collected one, and failed ones whose retry is due (all of
    /// them when `force` is set, for the STA's final teardown).
    pub fn take_jobs(&mut self, now: Instant, force: bool) -> Vec<(u32, String, Job<T>)> {
        let Some(session) = &mut self.session else {
            return Vec::new();
        };
        let mut jobs = Vec::new();
        for (id, editor) in &mut session.editors {
            let due = match &editor.stage {
                Stage::Ready(_) => true,
                Stage::Failed { retry_at, .. } => force || *retry_at <= now,
                _ => false,
            };
            if !due {
                continue;
            }
            let job = match std::mem::replace(&mut editor.stage, Stage::Saving) {
                Stage::Ready(content)
                | Stage::Failed {
                    content: Some(content),
                    ..
                } => Job::Install(content),
                _ => Job::Retry,
            };
            jobs.push((session.request, id.clone(), job));
        }
        jobs
    }

    /// Record a save's outcome. Returns a failure that has not been reported before.
    pub fn finish_job(
        &mut self,
        request: u32,
        editor: &str,
        outcome: Outcome<T>,
        now: Instant,
    ) -> Option<Failure> {
        let session = self.session.as_mut().filter(|s| s.request == request)?;
        let entry = session
            .editors
            .get_mut(editor)
            .filter(|entry| matches!(entry.stage, Stage::Saving))?;
        match outcome {
            Outcome::Saved => {
                entry.stage = Stage::Saved;
                None
            }
            Outcome::Closed => {
                entry.stage = Stage::Closed { unsaved: true };
                None
            }
            Outcome::Failed { content, error } => {
                let new = entry.reported.as_deref() != Some(error.as_str());
                entry.reported = Some(error.clone());
                entry.stage = Stage::Failed {
                    content,
                    error: error.clone(),
                    retry_at: now + RETRY_INTERVAL,
                };
                new.then(|| Failure {
                    document: entry.name().to_owned(),
                    error,
                })
            }
        }
    }

    pub fn next_retry(&self) -> Option<Instant> {
        self.session
            .as_ref()?
            .editors
            .values()
            .filter_map(|editor| match editor.stage {
                Stage::Failed { retry_at, .. } => Some(retry_at),
                _ => None,
            })
            .min()
    }

    fn editor_mut(&mut self, editor: &str) -> Option<&mut Editor<T>> {
        self.session.as_mut()?.editors.get_mut(editor)
    }
}

impl<T> Editor<T> {
    fn orphaned(&self) -> bool {
        matches!(self.stage, Stage::Closed { unsaved: true })
    }
}

/// Write a copy of an at-risk drawing unless one was already attempted for this exact drawing;
/// remove the copy of a drawing that is safe.
fn plan_editor<T>(plan: &mut Recovery, stamp: &str, id: &str, editor: &Editor<T>) {
    if editor.stage.at_risk() {
        let current = editor
            .snapshot
            .as_ref()
            .is_some_and(|attempt| Arc::ptr_eq(&attempt.json, &editor.json));
        if !current {
            plan.write.push(Write {
                editor: id.to_owned(),
                name: super::recovery::file_name(stamp, id, editor.name()),
                json: editor.json.clone(),
            });
        }
    } else if let Some(path) = editor.snapshot.as_ref().and_then(|a| a.path.as_ref()) {
        plan.remove.push((id.to_owned(), path.clone()));
    }
}

fn failure_reason(document: &str, others: usize) -> String {
    let mut name: String = document.chars().take(MAX_REASON_NAME_CHARS).collect();
    if name.len() < document.len() {
        name.push('…');
    }
    let reason = match others {
        0 => format!("Could not save the ChemDraft structure in {name}"),
        1 => format!("Could not save the ChemDraft structure in {name} and 1 other"),
        n => format!("Could not save the ChemDraft structure in {name} and {n} others"),
    };
    truncate_units(reason, MAX_REASON_UNITS)
}

fn truncate_units(text: String, limit: usize) -> String {
    let mut units = 0;
    let mut end = text.len();
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > limit {
            end = index;
            break;
        }
    }
    let mut text = text;
    text.truncate(end);
    text
}

#[cfg(test)]
impl Drawing for &'static str {
    fn json(&self) -> &str {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAMP: &str = "20261120T224719Z";

    fn tracker(editors: &[(&str, &str, &str)]) -> Tracker<&'static str> {
        let mut tracker = Tracker::new();
        for &(id, document, json) in editors {
            tracker.opened(id, "Microsoft Word", document, json);
        }
        tracker
    }

    fn saved_by_sta(tracker: &mut Tracker<&'static str>, outcome: fn(&str) -> Outcome<&str>) {
        for (request, id, job) in tracker.take_jobs(Instant::now(), false) {
            let content = match job {
                Job::Install(content) => content,
                Job::Retry => "retry",
            };
            tracker.finish_job(request, &id, outcome(content), Instant::now());
        }
    }

    #[test]
    fn session_end_allows_only_after_every_editor_is_saved_or_unchanged() {
        let mut t = tracker(&[("17", "Report.docx", "{old}"), ("18", "Slides.pptx", "{s}")]);
        assert_eq!(t.answer(), Answer::Allow);
        assert_eq!(
            t.begin(4, STAMP.into()),
            Some(vec!["17".into(), "18".into()])
        );
        assert!(t.active());
        assert_eq!(
            t.begin(5, STAMP.into()),
            None,
            "a repeated query keeps collecting"
        );
        assert_eq!(t.answer(), Answer::Block(SAVING_REASON.into()));

        assert!(!t.collect(3, "17", "{stale request}"));
        assert!(!t.collect(4, "19", "{unknown editor}"));
        assert!(t.collect(4, "17", "{new}"));
        assert!(!t.collect(4, "17", "{duplicate}"));
        assert!(!t.accepting(4, "17"));
        assert!(t.unchanged(4, "18"));
        assert!(!t.unchanged(4, "18"));
        // Collected is not saved: Office has not taken it yet.
        assert_eq!(t.answer(), Answer::Block(SAVING_REASON.into()));

        let jobs = t.take_jobs(Instant::now(), false);
        assert_eq!(jobs.len(), 1);
        assert!(matches!(&jobs[0], (4, id, Job::Install("{new}")) if id == "17"));
        assert!(
            t.take_jobs(Instant::now(), false).is_empty(),
            "saving is taken once"
        );
        assert_eq!(t.answer(), Answer::Block(SAVING_REASON.into()));
        assert!(t
            .finish_job(4, "17", Outcome::Saved, Instant::now())
            .is_none());
        assert_eq!(t.answer(), Answer::Allow);
        assert!(t.risks().is_empty());
    }

    #[test]
    fn session_end_keeps_a_failed_save_pending_and_names_its_document() {
        let mut t = tracker(&[("17", "Report.docx", "{old}"), ("18", "Notes.docx", "{n}")]);
        t.begin(9, STAMP.into());
        t.collect(9, "17", "{new}");
        t.collect(9, "18", "{n2}");
        let start = Instant::now();
        for (request, id, job) in t.take_jobs(start, false) {
            assert!(matches!(job, Job::Install(_)));
            let outcome = if id == "17" {
                Outcome::Failed {
                    content: None,
                    error: "RPC_E_CALL_REJECTED".into(),
                }
            } else {
                Outcome::Saved
            };
            let failure = t.finish_job(request, &id, outcome, start);
            assert_eq!(failure.is_some(), id == "17");
            if let Some(failure) = failure {
                assert_eq!(failure.document, "Report.docx");
                assert_eq!(failure.error, "RPC_E_CALL_REJECTED");
            }
        }
        assert_eq!(
            t.answer(),
            Answer::Block("Could not save the ChemDraft structure in Report.docx".into())
        );
        assert_eq!(t.next_retry(), Some(start + RETRY_INTERVAL));
        assert!(t.take_jobs(start, false).is_empty(), "retry waits");

        // The retry reuses the drawing the object already holds; the same error is not re-logged.
        let jobs = t.take_jobs(start + RETRY_INTERVAL, false);
        assert!(matches!(jobs.as_slice(), [(9, id, Job::Retry)] if id == "17"));
        let again = Outcome::Failed {
            content: None,
            error: "RPC_E_CALL_REJECTED".into(),
        };
        assert!(t.finish_job(9, "17", again, start).is_none());
        let risks = t.risks();
        assert_eq!(risks.len(), 1);
        assert_eq!(
            (risks[0].editor.as_str(), risks[0].document.as_str()),
            ("17", "Report.docx")
        );
        assert_eq!(risks[0].state, "Office did not save its latest drawing");
        assert_eq!(risks[0].error.as_deref(), Some("RPC_E_CALL_REJECTED"));
        assert_eq!(risks[0].snapshot, None);

        // A drawing the STA could not install comes back for the next attempt.
        let jobs = t.take_jobs(Instant::now(), true);
        assert!(matches!(jobs.as_slice(), [(9, _, Job::Retry)]));
        let busy = Outcome::Failed {
            content: Some("{new}"),
            error: "busy".into(),
        };
        assert!(t.finish_job(9, "17", busy, start).is_some());
        assert!(matches!(
            t.take_jobs(Instant::now(), true).as_slice(),
            [(9, _, Job::Install("{new}"))]
        ));
        assert!(t.finish_job(9, "17", Outcome::Saved, start).is_none());
        assert_eq!(t.answer(), Answer::Allow);
        assert_eq!(t.next_retry(), None);
    }

    #[test]
    fn session_end_reason_counts_other_failures_and_fits_windows() {
        let long = "β".repeat(300);
        let mut t = tracker(&[
            ("1", long.as_str(), "{a}"),
            ("2", "B.docx", "{b}"),
            ("3", "", "{c}"),
        ]);
        t.begin(1, STAMP.into());
        for id in ["1", "2", "3"] {
            t.collect(1, id, "{x}");
        }
        saved_by_sta(&mut t, |_| Outcome::Failed {
            content: None,
            error: "E_FAIL".into(),
        });
        let Answer::Block(reason) = t.answer() else {
            panic!("failures block");
        };
        assert!(reason.starts_with("Could not save the ChemDraft structure in βββ"));
        assert!(reason.ends_with("… and 2 others"));
        assert!(reason.encode_utf16().count() <= MAX_REASON_UNITS);
        assert_eq!(
            failure_reason("Report.docx", 1),
            "Could not save the ChemDraft structure in Report.docx and 1 other"
        );
        assert_eq!(truncate_units("ab😀c".into(), 3), "ab");
        assert_eq!(display_name("Microsoft Word", " "), "Microsoft Word");
        assert_eq!(display_name("", ""), "an Office document");
    }

    #[test]
    fn session_end_late_drawings_are_still_collected_after_a_block() {
        let mut t = tracker(&[("17", "Report.docx", "{old}")]);
        t.begin(2, STAMP.into());
        assert!(t.answer().blocks());
        // No deadline: a slow editor's drawing is accepted while Windows waits on the block.
        assert!(t.accepting(2, "17"));
        assert!(t.collect(2, "17", "{late}"));
        saved_by_sta(&mut t, |_| Outcome::Saved);
        assert!(!t.answer().blocks());
    }

    #[test]
    fn session_end_closed_objects_stop_blocking_and_keep_unsaved_drawings_for_recovery() {
        let mut t = tracker(&[
            ("1", "A.docx", "{a}"),
            ("2", "B.docx", "{b}"),
            ("3", "C", "{c}"),
        ]);
        assert_eq!(t.closed("9"), None);
        t.begin(3, STAMP.into());
        t.collect(3, "2", "{b2}");
        t.unchanged(3, "3");
        assert_eq!(
            t.closed("1"),
            Some("its editor did not send its latest drawing")
        );
        assert_eq!(
            t.closed("2"),
            Some("its latest drawing was not saved into Office yet")
        );
        assert_eq!(t.closed("3"), None);
        assert_eq!(
            t.answer(),
            Answer::Allow,
            "nothing can be saved into a closed object"
        );
        let risks = t.risks();
        assert_eq!(risks.len(), 1);
        assert_eq!(risks[0].editor, "2");
        let plan = t.recovery();
        assert_eq!(plan.write.len(), 1);
        assert_eq!(&*plan.write[0].json, "{b2}");
        assert!(plan.remove.is_empty());

        // An STA job for an object that has gone is the same as a close.
        let mut t = tracker(&[("4", "D.docx", "{d}")]);
        t.begin(4, STAMP.into());
        t.collect(4, "4", "{d2}");
        saved_by_sta(&mut t, |_| Outcome::Closed);
        assert_eq!(t.answer(), Answer::Allow);
        assert_eq!(
            t.risks()[0].state,
            Stage::<()>::Closed { unsaved: true }.describe()
        );
    }

    #[test]
    fn session_end_recovery_plans_each_at_risk_drawing_once_and_removes_saved_copies() {
        let mut t = tracker(&[("17", "Report.docx", "{old}"), ("18", "Notes.docx", "{n}")]);
        t.opened("19", "PowerPoint", "Deck.pptx", "{d}");
        t.renamed("19", "PowerPoint", "Deck 2.pptx");
        t.replaced("18", "{n-updated}");
        t.begin(5, STAMP.into());
        t.renamed("17", "Microsoft Word", "Report final.docx");
        assert!(t.unchanged(5, "19"));

        // Waiting editors are at risk: their last known drawing is what the STA last held.
        let plan = t.recovery();
        let names: Vec<_> = plan.write.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "20261120T224719Z-object-17-Report final.docx.json",
                "20261120T224719Z-object-18-Notes.docx.json"
            ]
        );
        assert_eq!(&*plan.write[1].json, "{n-updated}");
        for write in &plan.write {
            let path = PathBuf::from(format!("/r/{}", write.name));
            t.wrote(&write.editor, &write.json, Some(path));
        }
        assert!(
            t.recovery().write.is_empty(),
            "unchanged drawings are not rewritten"
        );

        // A newer collected drawing replaces the copy; a saved one removes it.
        t.collect(5, "17", "{new}");
        let plan = t.recovery();
        assert_eq!(plan.write.len(), 1);
        assert_eq!(&*plan.write[0].json, "{new}");
        t.wrote("17", &plan.write[0].json, None);
        assert!(
            t.recovery().write.is_empty(),
            "a failed write is not retried for one drawing"
        );
        assert_eq!(
            t.risks()
                .iter()
                .map(|r| r.snapshot.clone())
                .collect::<Vec<_>>(),
            [
                None,
                Some(PathBuf::from(
                    "/r/20261120T224719Z-object-18-Notes.docx.json"
                ))
            ]
        );
        assert!(t.unchanged(5, "18"));
        let plan = t.recovery();
        assert!(plan.write.is_empty());
        let removed = PathBuf::from("/r/20261120T224719Z-object-18-Notes.docx.json");
        assert_eq!(plan.remove, [("18".to_owned(), removed.clone())]);
        t.removed("18", Path::new("/r/other"));
        assert_eq!(t.recovery().remove.len(), 1);
        t.removed("18", &removed);
        assert!(t.recovery().remove.is_empty());
    }

    #[test]
    fn session_end_cancel_removes_copies_of_open_editors_but_keeps_closed_ones() {
        let mut t = tracker(&[
            ("1", "A.docx", "{a}"),
            ("2", "B.docx", "{b}"),
            ("3", "C", "{c}"),
        ]);
        assert!(t.cancel(true).is_none());
        t.begin(6, STAMP.into());
        t.collect(6, "2", "{b2}");
        for write in t.recovery().write {
            let path = PathBuf::from(format!("/r/{}", write.editor));
            t.wrote(&write.editor, &write.json, Some(path));
        }
        t.collect(6, "3", "{c2}");
        t.closed("2");
        t.closed("3");
        let cancelled = t.cancel(true).expect("pending session end");
        assert_eq!(cancelled.request, 6);
        assert!(!t.active());
        assert_eq!(t.answer(), Answer::Allow);
        // Editor 1 is still open with its drawing: its copy goes. Editor 2 closed with an
        // unsaved drawing: its copy stays. Editor 3 closed before its copy was written.
        assert_eq!(
            cancelled.recovery.remove,
            [("1".to_owned(), PathBuf::from("/r/1"))]
        );
        assert_eq!(cancelled.kept, [PathBuf::from("/r/2")]);
        assert_eq!(cancelled.recovery.write.len(), 1);
        assert_eq!(cancelled.recovery.write[0].editor, "3");
        assert_eq!(&*cancelled.recovery.write[0].json, "{c2}");

        // When Windows only stopped reporting a shutdown, every copy stays.
        let mut t = tracker(&[("1", "A.docx", "{a}")]);
        t.begin(7, STAMP.into());
        for write in t.recovery().write {
            t.wrote(&write.editor, &write.json, Some(PathBuf::from("/r/1")));
        }
        let cancelled = t.cancel(false).unwrap();
        assert!(cancelled.recovery.remove.is_empty());
        assert!(cancelled.recovery.write.is_empty());
        assert_eq!(cancelled.kept, [PathBuf::from("/r/1")]);
    }

    #[test]
    fn session_end_saves_what_an_object_holds_when_its_editor_window_is_gone() {
        let mut t = tracker(&[("17", "Report.docx", "{published}")]);
        t.begin(8, STAMP.into());
        let now = Instant::now();
        assert!(!t.without_renderer(7, "17", now));
        assert!(t.without_renderer(8, "17", now));
        assert!(!t.accepting(8, "17"));
        assert_eq!(t.next_retry(), Some(now));
        assert!(matches!(
            t.take_jobs(now, false).as_slice(),
            [(8, id, Job::Retry)] if id == "17"
        ));
        t.finish_job(8, "17", Outcome::Saved, now);
        assert_eq!(t.answer(), Answer::Allow);
        assert!(!t.renderer_gone("17", now), "only a waiting editor");

        let mut t = tracker(&[("18", "Notes.docx", "{n}")]);
        assert!(!t.renderer_gone("18", now), "no session end pending");
        t.begin(9, STAMP.into());
        assert!(t.renderer_gone("18", now));
        assert!(matches!(
            t.take_jobs(now, false).as_slice(),
            [(9, _, Job::Retry)]
        ));
    }

    /// DoVerb shows the editor's window, then registers it. A WM_QUERYENDSESSION handled in
    /// between must not leave the shown editor outside the session end.
    #[test]
    fn session_end_refuses_an_editor_that_registers_after_the_snapshot() {
        let mut t = tracker(&[("17", "Report.docx", "{old}")]);
        // The window for editor 18 is shown; the main thread begins the session end first.
        assert_eq!(t.begin(3, STAMP.into()), Some(vec!["17".into()]));
        // DoVerb's registration now loses: the caller destroys the window and fails activation.
        assert!(!t.opened("18", "Microsoft Word", "Late.docx", "{late}"));
        assert!(!t.accepting(3, "18"));
        assert!(t.recovery().write.iter().all(|write| write.editor == "17"));
        assert!(t.risks().iter().all(|risk| risk.editor == "17"));
        // Nothing of the refused editor survives into a later session end.
        t.cancel(true);
        assert_eq!(t.begin(4, STAMP.into()), Some(vec!["17".into()]));

        // Registered first, the editor is in the snapshot: it is asked and kept at risk.
        let mut t = tracker(&[("17", "Report.docx", "{old}")]);
        assert!(t.opened("18", "Microsoft Word", "Late.docx", "{late}"));
        assert_eq!(
            t.begin(5, STAMP.into()),
            Some(vec!["17".into(), "18".into()])
        );
        assert!(t.accepting(5, "18"));
        let plan = t.recovery();
        assert_eq!(
            plan.write
                .iter()
                .map(|w| w.editor.as_str())
                .collect::<Vec<_>>(),
            ["17", "18"]
        );
        assert_eq!(&*plan.write[1].json, "{late}");

        // The DoVerb source takes that decision from `opened`'s answer and tears the window down.
        let source = include_str!("server.rs");
        let verb = &source[source.find("fn DoVerb(").unwrap()..];
        let verb = &verb[..verb.find("fn EnumVerbs(").unwrap()];
        let shown = verb.find("bridge::open_window(").unwrap();
        let registered = verb.find("let registered = ").unwrap();
        let refused = verb.find("if !registered {").unwrap();
        let recorded = verb
            .find("self.session.replace(Some(id.clone()));")
            .unwrap();
        assert!(shown < registered && registered < refused && refused < recorded);
        let refusal = &verb[refused..recorded];
        assert!(refusal.contains("window.destroy()"));
        assert!(refusal.contains("OLE_E_NOTRUNNING"));
        assert_eq!(verb.matches(".opened(").count(), 1);
    }

    #[test]
    fn session_end_keeps_an_editor_that_could_not_send_its_drawing_at_risk() {
        let mut t = tracker(&[("17", "Report.docx", "{old}"), ("18", "Notes.docx", "{n}")]);
        assert!(!t.unsent(1, "17"), "no session end pending");
        t.begin(6, STAMP.into());
        assert!(!t.unsent(5, "17"), "stale request");
        assert!(!t.unsent(6, "19"), "unknown editor");
        assert!(t.unsent(6, "17"));
        assert!(!t.unsent(6, "17"), "only a waiting editor fails");
        assert!(t.unchanged(6, "18"));
        // Not waited on, still refusing with its document's name, and never saved by the STA.
        assert_eq!(
            t.answer(),
            Answer::Block("Could not save the ChemDraft structure in Report.docx".into())
        );
        assert!(t.take_jobs(Instant::now(), true).is_empty());
        assert_eq!(t.next_retry(), None);
        let risks = t.risks();
        assert_eq!(risks.len(), 1);
        assert_eq!(
            risks[0].state,
            "its editor could not send its latest drawing"
        );
        let plan = t.recovery();
        assert_eq!(plan.write.len(), 1);
        assert_eq!(plan.write[0].editor, "17");
        assert_eq!(&*plan.write[0].json, "{old}");

        // A later answer from the same editor is still taken.
        assert!(t.accepting(6, "17"));
        assert!(t.collect(6, "17", "{new}"));
        saved_by_sta(&mut t, |_| Outcome::Saved);
        assert_eq!(t.answer(), Answer::Allow);

        // Office closing the object leaves no unsaved collected drawing to keep.
        let mut t = tracker(&[("17", "Report.docx", "{old}")]);
        t.begin(7, STAMP.into());
        t.unsent(7, "17");
        assert_eq!(
            t.closed("17"),
            Some("its editor could not send its latest drawing")
        );
        assert_eq!(t.answer(), Answer::Allow);
        assert!(t.risks().is_empty());
    }

    #[test]
    fn session_end_ignores_saves_from_a_cancelled_session() {
        let mut t = tracker(&[("17", "Report.docx", "{old}")]);
        t.begin(1, STAMP.into());
        t.collect(1, "17", "{new}");
        let jobs = t.take_jobs(Instant::now(), false);
        t.cancel(true);
        t.begin(2, STAMP.into());
        for (request, id, _) in jobs {
            assert!(t
                .finish_job(request, &id, Outcome::Saved, Instant::now())
                .is_none());
        }
        assert!(
            t.accepting(2, "17"),
            "the new session still needs the drawing"
        );
        assert!(t.answer().blocks());
        assert!(t
            .finish_job(2, "17", Outcome::Saved, Instant::now())
            .is_none());
        assert!(t.answer().blocks(), "only a job the STA took can finish");
    }
}
