//! Recovery copies of embedded Office drawings that a Windows session end put at risk, or that
//! Office did not take when their editor window closed outside one. Each file holds one editor's
//! last known drawing JSON (the selection JSON stored in `ChemDraftDocument`), named by its object
//! ID and container document. Nothing restores them automatically; the Office log
//! (`office-session-end.log`) names every file written.
//!
//! During a session end one [`Writer`] thread does every disk operation, never the thread that
//! answers Windows. Whenever the tracker changes it takes the tracker's plan as owned snapshots
//! (each drawing is an `Arc<str>`), writes each copy atomically (`.partial`, sync, rename) and
//! records it in the tracker only once it is durable, so a copy that is queued or still being
//! written keeps the session end refused. It also appends the Office log while a session end is
//! pending. Its state machine ([`RecoveryWrite`]) mirrors `FlushWrite` on the session-flush side
//! (`shutdown.rs`), and a committed session end's watchdog waits for it before it ends the process.

use std::{
    collections::VecDeque,
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, PoisonError},
    time::Duration,
};

use super::{
    session_publish::{
        display_name, Answer, Cancelled, Drawing, Recovery, Tracker, Write, SAVING_REASON,
    },
    storage::MAX_DOCUMENT_BYTES,
};

/// Under the app data folder.
pub(crate) const FOLDER: &str = "office-recovery";
/// Under the app log folder.
pub(crate) const LOG: &str = "office-session-end.log";
const MAX_NAME_CHARS: usize = 80;
/// Bytes of recovery copies one session end may write: two drawings at the IPC limit. A drawing
/// past it gets no copy (logged like a failed write), which bounds the disk I/O a shutdown waits on.
pub(crate) const BUDGET_BYTES: usize = 2 * MAX_DOCUMENT_BYTES;
/// Longest ChemDraft refuses one Windows session end. Past it the session end is always allowed,
/// even while a drawing is unsaved in Office or its newest recovery copy is not written yet.
pub(crate) const SESSION_END_LIMIT: Duration = Duration::from_secs(30);
/// While a session end is pending the writer re-reads the tracker this often, even unwoken.
const POLL: Duration = Duration::from_millis(250);

/// The session end's UTC start, shared by its files so a later session end never overwrites them.
pub(crate) fn stamp(now: chrono::DateTime<chrono::Utc>) -> String {
    now.format("%Y%m%dT%H%M%SZ").to_string()
}

pub(super) fn file_name(stamp: &str, object: &str, document: &str) -> String {
    let object: String = object
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(20)
        .collect();
    let document: String = document
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    // Windows drops trailing dots and spaces from file names.
    let document = document.trim().trim_end_matches(['.', ' ']);
    let document = if document.is_empty() {
        "Office document"
    } else {
        document
    };
    format!("{stamp}-object-{object}-{document}.json")
}

/// The same bound as the IPC update frame's selection JSON.
fn check_size(json: &str) -> io::Result<()> {
    if json.len() > MAX_DOCUMENT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the drawing exceeds the 25 MiB ChemDraftDocument limit",
        ));
    }
    Ok(())
}

/// Written whole and synced, then renamed into place; `publishing` runs just before the rename.
fn write_file(
    dir: &Path,
    name: &str,
    json: &str,
    publishing: &mut dyn FnMut(),
) -> io::Result<PathBuf> {
    check_size(json)?;
    fs::create_dir_all(dir)?;
    let path = dir.join(name);
    let partial = dir.join(format!("{name}.partial"));
    let mut file = fs::File::create(&partial)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;
    drop(file);
    publishing();
    fs::rename(&partial, &path)?;
    Ok(path)
}

/// A recovery copy of a drawing Office did not take when its editor window closed outside a
/// Windows session end, where nothing retries the save. Named like a session end's copies.
pub(super) fn write_unsaved(
    dir: &Path,
    stamp: &str,
    object: &str,
    app: &str,
    document: &str,
    json: &str,
) -> io::Result<PathBuf> {
    write_file(
        dir,
        &file_name(stamp, object, display_name(app, document)),
        json,
        &mut || {},
    )
}

/// The session end's answer: the tracker's, but refused with the generic reason while a recovery
/// copy it needs is not durable yet. Both are read under one lock, so `Allow` never races a drawing
/// that changed or closed after the writer's last pass.
pub(super) fn answer<T: Drawing>(tracker: &Tracker<T>) -> Answer {
    let answer = tracker.answer();
    if answer.blocks() || !tracker.recovery_pending() {
        answer
    } else {
        Answer::Block(SAVING_REASON.into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Allow,
    Block(String),
    /// Refused for `SESSION_END_LIMIT` already, so allowed anyway. Carries the overridden reason.
    Overdue(String),
}

/// Refusal has a bound: once `elapsed` (since the session end began) reaches `SESSION_END_LIMIT`
/// the session end is always allowed.
pub(crate) fn decide(answer: Answer, elapsed: Duration) -> Decision {
    match answer {
        Answer::Allow => Decision::Allow,
        Answer::Block(reason) if elapsed >= SESSION_END_LIMIT => Decision::Overdue(reason),
        Answer::Block(reason) => Decision::Block(reason),
    }
}

/// The writer's disk operations. Tests substitute one that stops inside a write.
pub(super) trait Files {
    fn write(
        &mut self,
        dir: &Path,
        name: &str,
        json: &str,
        publishing: &mut dyn FnMut(),
    ) -> io::Result<PathBuf>;
    fn remove(&mut self, path: &Path) -> io::Result<()>;
    fn append(&mut self, log: &Path, entries: &str) -> io::Result<()>;
}

pub(super) struct Disk;

impl Files for Disk {
    fn write(
        &mut self,
        dir: &Path,
        name: &str,
        json: &str,
        publishing: &mut dyn FnMut(),
    ) -> io::Result<PathBuf> {
        write_file(dir, name, json, publishing)
    }

    fn remove(&mut self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn append(&mut self, log: &Path, entries: &str) -> io::Result<()> {
        if let Some(directory) = log.parent() {
            fs::create_dir_all(directory)?;
        }
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)?
            .write_all(entries.as_bytes())
    }
}

/// The writer's progress, named after `FlushWrite` on the session-flush side. Durable completion
/// is tracked apart from it, in the tracker: a copy counts only once `Tracker::wrote` records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryWrite {
    /// Nothing queued and nothing in flight.
    Idle,
    /// Work arrived, or the writer is between two operations of one pass.
    Queued,
    /// Writing and syncing a `.partial` copy, removing a stale copy, or appending to the log.
    Writing,
    /// Renaming a synced `.partial` copy into place.
    Publishing,
}

impl RecoveryWrite {
    /// Like `FlushWrite::grace_can_end_quit`: only now may the watchdog end the process.
    pub(crate) fn watchdog_can_exit(self) -> bool {
        self == Self::Idle
    }
}

struct State {
    stage: RecoveryWrite,
    /// A wake arrived while the writer was busy: read the tracker again before going idle.
    again: bool,
    /// A session end was pending at the end of the last pass, so the writer polls the tracker.
    active: bool,
    /// Set once a committed session end saw the writer idle: nothing new starts after it.
    closed: bool,
    stopped: bool,
    /// Bytes started for copies of one session end, by its request.
    spent: (u32, usize),
    cancelled: VecDeque<Cancelled>,
    /// Office log entries, each ending in a newline, for the writer to append.
    entries: String,
    /// Copies written for a session end that was cancelled while they were in flight, so the
    /// tracker never recorded them. Its cancellation decides whether each stays.
    late: Vec<(u32, String, PathBuf)>,
}

pub(crate) struct Writer {
    state: Mutex<State>,
    changed: Condvar,
    /// The recovery folder, or why there is none.
    dir: Result<PathBuf, String>,
    /// The Office log, if the app has a log folder.
    log: Option<PathBuf>,
    budget: usize,
}

impl Writer {
    pub(crate) fn new(dir: Result<PathBuf, String>, log: Option<PathBuf>) -> Self {
        Self {
            state: Mutex::new(State {
                stage: RecoveryWrite::Idle,
                again: false,
                active: false,
                closed: false,
                stopped: false,
                spent: (0, 0),
                cancelled: VecDeque::new(),
                entries: String::new(),
                late: Vec::new(),
            }),
            changed: Condvar::new(),
            dir,
            log,
            budget: BUDGET_BYTES,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn queue(&self, state: &mut State) {
        if state.stage == RecoveryWrite::Idle {
            state.stage = RecoveryWrite::Queued;
        } else {
            state.again = true;
        }
        self.changed.notify_all();
    }

    /// The tracker changed: start (or repeat) a pass. Never waits for the disk.
    pub(crate) fn wake(&self) {
        let mut state = self.lock();
        self.queue(&mut state);
    }

    /// Append an entry to the Office log on the writer thread. Returns it if the writer is closed.
    pub(crate) fn log(&self, entry: String) -> Result<(), String> {
        let mut state = self.lock();
        if state.closed || state.stopped {
            return Err(entry);
        }
        state.entries.push_str(&entry);
        self.queue(&mut state);
        Ok(())
    }

    /// Apply a cancelled session end's plan, after any copy still in flight for it.
    pub(super) fn cancel(&self, cancelled: Cancelled) {
        let mut state = self.lock();
        state.cancelled.push_back(cancelled);
        self.queue(&mut state);
    }

    #[cfg(test)]
    pub(crate) fn stage(&self) -> RecoveryWrite {
        self.lock().stage
    }

    /// True if nothing is queued or in flight and the tracker has nothing `pending`; with
    /// `close`, nothing new starts afterwards. If the tracker has work the writer missed, it is
    /// queued. Never waits for the disk.
    fn settled(&self, pending: bool, close: bool) -> bool {
        let mut state = self.lock();
        if state.closed || state.stopped {
            return true;
        }
        if !state.stage.watchdog_can_exit() {
            return false;
        }
        if pending {
            self.queue(&mut state);
            return false;
        }
        state.closed |= close;
        true
    }

    /// Every copy the tracker needs is durable (or failed) and nothing is in flight.
    pub(crate) fn idle(&self, pending: bool) -> bool {
        self.settled(pending, false)
    }

    /// `idle`, and then nothing new starts: a committed session end's last step, so the process
    /// can end without cutting a copy short. The message thread pumps between calls.
    pub(crate) fn try_close(&self, pending: bool) -> bool {
        self.settled(pending, true)
    }

    /// The watchdog's side of `try_close`: waits for what is queued or in flight (a session end
    /// writes at most `BUDGET_BYTES`), then closes. `pending` reads the tracker.
    pub(crate) fn close_when_idle(&self, mut pending: impl FnMut() -> bool) {
        loop {
            let pending = pending();
            if self.try_close(pending) {
                return;
            }
            let state = self.lock();
            if !state.stopped && !state.stage.watchdog_can_exit() {
                drop(
                    self.changed
                        .wait_timeout(state, POLL)
                        .unwrap_or_else(PoisonError::into_inner),
                );
            }
        }
    }

    pub(crate) fn stop(&self) {
        self.lock().stopped = true;
        self.changed.notify_all();
    }

    fn set_stage(&self, stage: RecoveryWrite) {
        self.lock().stage = stage;
    }

    /// Mark an operation in flight, unless the writer is closed.
    fn begin(&self) -> bool {
        let mut state = self.lock();
        if state.closed || state.stopped {
            return false;
        }
        state.stage = RecoveryWrite::Writing;
        true
    }

    /// Queue a log entry from the writer itself; the pass appends it.
    fn note(&self, message: std::fmt::Arguments<'_>) {
        eprintln!("ChemDraft: {message}");
        let entry = format!("{} {message}\n", chrono::Utc::now().to_rfc3339());
        self.lock().entries.push_str(&entry);
    }

    /// Wait for a wake, or poll while a session end is pending. False once stopped.
    fn next_round(&self) -> bool {
        let mut state = self.lock();
        loop {
            if state.stopped {
                return false;
            }
            if state.closed {
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
                continue;
            }
            if state.stage == RecoveryWrite::Queued {
                state.again = false;
                return true;
            }
            if state.active {
                let (next, waited) = self
                    .changed
                    .wait_timeout(state, POLL)
                    .unwrap_or_else(PoisonError::into_inner);
                state = next;
                if waited.timed_out() && state.stage == RecoveryWrite::Idle {
                    state.stage = RecoveryWrite::Queued;
                }
            } else {
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        }
    }

    /// Releases the lock before the cancellation is applied.
    fn next_cancelled(&self) -> Option<Cancelled> {
        self.lock().cancelled.pop_front()
    }

    /// One pass: cancelled session ends in order, then the pending one's plan until nothing is
    /// left, then the log. A plan always shrinks (every copy attempted is recorded, written or
    /// failed, and the budget caps the bytes), so the pass ends.
    fn round<T: Drawing>(&self, tracker: &Mutex<Tracker<T>>, files: &mut impl Files) {
        loop {
            while let Some(cancelled) = self.next_cancelled() {
                self.apply_cancelled(cancelled, files);
            }
            let (plan, active) = {
                let tracker = tracker.lock().unwrap_or_else(PoisonError::into_inner);
                (tracker.recovery(), tracker.active())
            };
            let worked = !plan.is_empty();
            self.apply(plan, tracker, files);
            self.append_log(files);
            let mut state = self.lock();
            state.active = active;
            let more =
                state.again || worked || !state.cancelled.is_empty() || !state.entries.is_empty();
            if state.closed || state.stopped || !more {
                state.stage = RecoveryWrite::Idle;
                self.changed.notify_all();
                return;
            }
            state.again = false;
        }
    }

    /// One copy, within its session end's byte budget. `None` once the writer is closed.
    fn write_copy(
        &self,
        request: u32,
        write: &Write,
        files: &mut impl Files,
    ) -> Option<Result<PathBuf, String>> {
        let dir = {
            let mut state = self.lock();
            if state.closed || state.stopped {
                return None;
            }
            if let Err(error) = check_size(&write.json) {
                return Some(Err(error.to_string()));
            }
            let dir = match &self.dir {
                Ok(dir) => dir,
                Err(error) => return Some(Err(error.clone())),
            };
            if state.spent.0 != request {
                state.spent = (request, 0);
            }
            if state.spent.1.saturating_add(write.json.len()) > self.budget {
                return Some(Err(format!(
                    "this session end's recovery copies reached ChemDraft's {} MiB limit",
                    self.budget >> 20
                )));
            }
            state.spent.1 += write.json.len();
            state.stage = RecoveryWrite::Writing;
            dir
        };
        let result = files.write(dir, &write.name, &write.json, &mut || {
            self.set_stage(RecoveryWrite::Publishing);
        });
        self.set_stage(RecoveryWrite::Queued);
        Some(result.map_err(|error| error.to_string()))
    }

    fn remove(&self, editor: &str, path: &Path, files: &mut impl Files) -> Option<bool> {
        if !self.begin() {
            return None;
        }
        let result = files.remove(path);
        self.set_stage(RecoveryWrite::Queued);
        Some(match result {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => {
                self.note(format_args!(
                    "Office object {editor}: could not remove the recovery copy {}: {error}",
                    path.display()
                ));
                false
            }
        })
    }

    /// The pending session end's plan. Stops if that session end was cancelled meanwhile.
    fn apply<T: Drawing>(
        &self,
        plan: Recovery,
        tracker: &Mutex<Tracker<T>>,
        files: &mut impl Files,
    ) {
        let request = plan.request;
        let lock = move || tracker.lock().unwrap_or_else(PoisonError::into_inner);
        for write in plan.write {
            if lock().request() != Some(request) {
                return;
            }
            let Some(result) = self.write_copy(request, &write, files) else {
                return;
            };
            let path = match result {
                Ok(path) => {
                    self.note(format_args!("Office object {}: its drawing is not saved in Office yet; wrote its last known drawing to {}. Nothing restores this copy automatically.", write.editor, path.display()));
                    Some(path)
                }
                Err(error) => {
                    self.note(format_args!(
                        "Office object {}: could not write the recovery copy {}: {error}",
                        write.editor, write.name
                    ));
                    None
                }
            };
            let recorded = lock().wrote(request, &write.editor, &write.json, path.clone());
            if let (false, Some(path)) = (recorded, path) {
                self.lock().late.push((request, write.editor, path));
            }
        }
        for (editor, path) in plan.remove {
            if lock().request() != Some(request) {
                return;
            }
            let Some(removed) = self.remove(&editor, &path, files) else {
                return;
            };
            if removed {
                self.note(format_args!(
                    "Removed the recovery copy {}: Office has the drawing.",
                    path.display()
                ));
            }
            // Stop tracking it either way, so a stuck file is reported once.
            lock().removed(request, &editor, &path);
        }
    }

    fn apply_cancelled(&self, cancelled: Cancelled, files: &mut impl Files) {
        let request = cancelled.request;
        let mut kept = cancelled.kept;
        for write in &cancelled.recovery.write {
            match self.write_copy(request, write, files) {
                None => return,
                Some(Ok(path)) => kept.push(path),
                Some(Err(error)) => self.note(format_args!(
                    "Office object {}: could not write the recovery copy {}: {error}",
                    write.editor, write.name
                )),
            }
        }
        let mut remove = cancelled.recovery.remove;
        let late = {
            let mut state = self.lock();
            let (late, other) = std::mem::take(&mut state.late)
                .into_iter()
                .partition::<Vec<_>, _>(|(late, ..)| *late == request);
            state.late = other;
            late
        };
        for (_, editor, path) in late {
            if cancelled.discard.contains(&editor) {
                remove.push((editor, path));
            } else if !kept.contains(&path) {
                kept.push(path);
            }
        }
        for (editor, path) in remove {
            if self.remove(&editor, &path, files).is_none() {
                return;
            }
        }
        for path in kept {
            self.note(format_args!(
                "The Windows session end was cancelled; kept the recovery copy {}.",
                path.display()
            ));
        }
    }

    fn append_log(&self, files: &mut impl Files) {
        let entries = {
            let mut state = self.lock();
            if state.entries.is_empty() || state.closed || state.stopped {
                return;
            }
            state.stage = RecoveryWrite::Writing;
            std::mem::take(&mut state.entries)
        };
        if let Some(log) = &self.log {
            if let Err(error) = files.append(log, &entries) {
                eprintln!("ChemDraft: could not write the Office session-end log: {error}");
            }
        }
        self.set_stage(RecoveryWrite::Queued);
    }
}

/// Marks the writer stopped however its thread ends, so a watchdog never waits on a dead writer.
struct Stopping<'a>(&'a Writer);

impl Drop for Stopping<'_> {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// The writer thread: one pass per wake (and per `POLL` while a session end is pending) until
/// `stop`.
pub(super) fn run<T: Drawing>(
    writer: &Writer,
    tracker: &Mutex<Tracker<T>>,
    files: &mut impl Files,
) {
    let _stopping = Stopping(writer);
    while writer.next_round() {
        writer.round(tracker, files);
    }
}

#[cfg(test)]
mod tests {
    use super::super::session_publish::{Job, Outcome};
    use super::*;
    use chrono::TimeZone;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        thread,
        time::Instant,
    };

    struct Folder(PathBuf);

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    impl Folder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "chemdraft-office-recovery-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            Self(path)
        }

        fn files(&self) -> Vec<String> {
            names(&self.0)
        }

        /// A writer whose copies go to `<folder>/office-recovery` and log to `<folder>/logs`.
        fn writer(&self) -> Writer {
            Writer::new(Ok(self.copies()), Some(self.0.join("logs").join(LOG)))
        }

        fn copies(&self) -> PathBuf {
            self.0.join(FOLDER)
        }

        fn copy_names(&self) -> Vec<String> {
            names(&self.copies())
        }

        fn log(&self) -> String {
            fs::read_to_string(self.0.join("logs").join(LOG)).unwrap_or_default()
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tracker() -> Mutex<Tracker<&'static str>> {
        let mut tracker = Tracker::new();
        tracker.opened("17", "Microsoft Word", "Report.docx", "{old}");
        tracker.opened("18", "Microsoft PowerPoint", "", "{deck}");
        tracker.begin(4, "20261120T224719Z".into());
        Mutex::new(tracker)
    }

    fn answer_of(tracker: &Mutex<Tracker<&'static str>>) -> Answer {
        answer(&tracker.lock().unwrap())
    }

    /// Office saves every collected drawing.
    fn office_saves(tracker: &Mutex<Tracker<&'static str>>) {
        let mut locked = tracker.lock().unwrap();
        for (request, id, _) in locked.take_jobs(Instant::now(), false) {
            locked.finish_job(request, &id, Outcome::Saved, Instant::now());
        }
    }

    /// Disk files that stop inside each copy until the test lets it finish.
    struct Gated {
        entered: mpsc::Sender<String>,
        proceed: mpsc::Receiver<()>,
    }

    impl Files for Gated {
        fn write(
            &mut self,
            dir: &Path,
            name: &str,
            json: &str,
            publishing: &mut dyn FnMut(),
        ) -> io::Result<PathBuf> {
            self.entered.send(name.to_owned()).unwrap();
            self.proceed.recv().unwrap();
            Disk.write(dir, name, json, publishing)
        }

        fn remove(&mut self, path: &Path) -> io::Result<()> {
            Disk.remove(path)
        }

        fn append(&mut self, log: &Path, entries: &str) -> io::Result<()> {
            Disk.append(log, entries)
        }
    }

    fn gated() -> (Gated, mpsc::Receiver<String>, mpsc::Sender<()>) {
        let (entered, writes) = mpsc::channel();
        let (release, proceed) = mpsc::channel();
        (Gated { entered, proceed }, writes, release)
    }

    #[test]
    fn session_end_recovery_names_files_by_stamp_object_and_document() {
        let start = chrono::Utc
            .with_ymd_and_hms(2026, 11, 20, 22, 47, 19)
            .unwrap();
        assert_eq!(stamp(start), "20261120T224719Z");
        assert_eq!(
            file_name("S", "17", r"C:\Docs\Report?.docx. "),
            "S-object-17-C__Docs_Report_.docx.json"
        );
        assert_eq!(
            file_name("S", "1/7", " "),
            "S-object-17-Office document.json"
        );
        let long = file_name("S", "1", &"a".repeat(500));
        assert_eq!(
            long.len(),
            "S-object-1-".len() + MAX_NAME_CHARS + ".json".len()
        );
    }

    /// The session end may end only after the closed drawing's copy is durable: queued and in
    /// flight both refuse it. The watchdog of a committed session end waits for the in-flight
    /// copy before it may end the process, and then nothing new starts.
    #[test]
    fn a_closed_drawing_is_refused_until_its_copy_is_durable_and_the_watchdog_waits() {
        let folder = Folder::new("in-flight");
        let tracker = tracker();
        {
            let mut locked = tracker.lock().unwrap();
            assert!(locked.collect(4, "17", "{new}"));
            assert!(locked.closed("17").is_some());
            assert!(locked.unchanged(4, "18"));
            assert_eq!(locked.answer(), Answer::Allow, "nothing left for Office");
        }
        // Queued: refused although the tracker alone would allow it.
        assert_eq!(answer_of(&tracker), Answer::Block(SAVING_REASON.into()));

        let writer = folder.writer();
        let (mut files, writes, release) = gated();
        let watchdog_done = AtomicBool::new(false);
        thread::scope(|scope| {
            scope.spawn(|| run(&writer, &tracker, &mut files));
            writer.wake();
            assert_eq!(
                writes.recv().unwrap(),
                "20261120T224719Z-object-17-Report.docx.json"
            );
            // In flight: still refused, and nothing durable yet.
            assert_eq!(writer.stage(), RecoveryWrite::Writing);
            assert!(answer_of(&tracker).blocks());
            assert!(!tracker.lock().unwrap().risks()[0].current);
            assert!(!writer.idle(tracker.lock().unwrap().recovery_pending()));
            assert!(!writer.try_close(false), "never closes mid-write");

            // The committed session end's watchdog fires now, and must wait for the copy.
            let (_disarm, watchdog) = mpsc::channel::<()>();
            scope.spawn(|| {
                crate::windows_session_end::watch_flush(watchdog, Duration::ZERO, || {
                    writer.close_when_idle(|| tracker.lock().unwrap().recovery_pending());
                    watchdog_done.store(true, Ordering::SeqCst);
                });
            });
            thread::sleep(Duration::from_millis(150));
            assert!(
                !watchdog_done.load(Ordering::SeqCst),
                "the watchdog must not end the process during a write"
            );
            assert_eq!(writer.stage(), RecoveryWrite::Writing);

            release.send(()).unwrap();
            while !watchdog_done.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
            // Durable and closed: the session end may end, and a later change starts nothing.
            assert_eq!(answer_of(&tracker), Answer::Allow);
            assert!(writer.try_close(true));
            assert!(writer.log("late entry\n".into()).is_err());
            writer.wake();
            assert!(writes.try_recv().is_err());
            writer.stop();
        });

        let copy = folder
            .copies()
            .join("20261120T224719Z-object-17-Report.docx.json");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "{new}");
        let risks = tracker.lock().unwrap().risks();
        assert_eq!(risks.len(), 1);
        assert_eq!(risks[0].snapshot.as_ref(), Some(&copy));
        assert!(risks[0].current);
        assert!(folder.log().contains("wrote its last known drawing to"));
        assert_eq!(
            folder.copy_names(),
            ["20261120T224719Z-object-17-Report.docx.json"]
        );
    }

    #[test]
    fn session_end_recovery_writes_at_risk_drawings_and_removes_them_once_saved() {
        let folder = Folder::new("settle");
        let writer = folder.writer();
        let tracker = tracker();
        assert!(tracker.lock().unwrap().collect(4, "17", "{new}"));

        writer.round(&tracker, &mut Disk);
        assert_eq!(writer.stage(), RecoveryWrite::Idle);
        assert!(answer_of(&tracker).blocks(), "Office has not saved them");
        assert!(!tracker.lock().unwrap().recovery_pending());
        assert_eq!(
            folder.copy_names(),
            [
                "20261120T224719Z-object-17-Report.docx.json",
                "20261120T224719Z-object-18-Microsoft PowerPoint.json"
            ]
        );
        let risks = tracker.lock().unwrap().risks();
        assert_eq!(
            fs::read_to_string(risks[0].snapshot.as_ref().unwrap()).unwrap(),
            "{new}"
        );
        assert_eq!(
            fs::read_to_string(risks[1].snapshot.as_ref().unwrap()).unwrap(),
            "{deck}"
        );
        assert!(risks.iter().all(|risk| risk.current));
        let log = folder.log();
        assert_eq!(log.matches("wrote its last known drawing").count(), 2);

        writer.round(&tracker, &mut Disk);
        assert_eq!(folder.log(), log, "unchanged drawings are not rewritten");

        // Office takes object 17; 18 had nothing new.
        {
            let mut locked = tracker.lock().unwrap();
            for (request, id, job) in locked.take_jobs(Instant::now(), false) {
                assert!(matches!(job, Job::Install("{new}")));
                locked.finish_job(request, &id, Outcome::Saved, Instant::now());
            }
            assert!(locked.unchanged(4, "18"));
        }
        assert!(
            answer_of(&tracker).blocks(),
            "the stale copies are not removed yet"
        );
        writer.round(&tracker, &mut Disk);
        assert_eq!(answer_of(&tracker), Answer::Allow);
        assert!(folder.copy_names().is_empty());
        assert_eq!(folder.log().matches("Office has the drawing").count(), 2);
    }

    /// Editor 18 answers after its first copy was written and Office then closes its object,
    /// while 17 is saved. The session end must stay refused until 18's copy holds the drawing
    /// collected from its editor, not the older one written while it was still waiting.
    #[test]
    fn session_end_recovery_keeps_a_closed_drawing_current_before_allowing() {
        let folder = Folder::new("closed-late");
        let writer = folder.writer();
        let tracker = tracker();
        writer.round(&tracker, &mut Disk);
        {
            let mut locked = tracker.lock().unwrap();
            assert!(locked.collect(4, "17", "{new}"));
            assert!(locked.collect(4, "18", "{deck, edited}"));
            assert!(locked.closed("18").is_some());
        }
        office_saves(&tracker);
        assert_eq!(tracker.lock().unwrap().answer(), Answer::Allow);
        assert_eq!(answer_of(&tracker), Answer::Block(SAVING_REASON.into()));
        assert!(!tracker.lock().unwrap().risks()[0].current);

        writer.round(&tracker, &mut Disk);
        assert_eq!(answer_of(&tracker), Answer::Allow);
        let copy = folder
            .copies()
            .join("20261120T224719Z-object-18-Microsoft PowerPoint.json");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "{deck, edited}");
        assert_eq!(
            folder.copy_names(),
            ["20261120T224719Z-object-18-Microsoft PowerPoint.json"]
        );
        let risks = tracker.lock().unwrap().risks();
        assert_eq!(risks.len(), 1);
        assert_eq!(risks[0].snapshot.as_ref(), Some(&copy));
        assert!(risks[0].current);
    }

    #[test]
    fn session_end_recovery_reports_write_failures_once_and_enforces_the_ipc_limit() {
        let folder = Folder::new("failures");
        let writer = Writer::new(
            Err("ChemDraft has no app data folder".into()),
            Some(folder.0.join(LOG)),
        );
        let tracker = tracker();
        writer.round(&tracker, &mut Disk);
        assert!(answer_of(&tracker).blocks());
        assert!(!tracker.lock().unwrap().recovery_pending());
        let log = fs::read_to_string(folder.0.join(LOG)).unwrap();
        assert_eq!(log.matches("no app data folder").count(), 2);
        writer.round(&tracker, &mut Disk);
        assert_eq!(
            fs::read_to_string(folder.0.join(LOG)).unwrap(),
            log,
            "the same drawing is not retried"
        );

        let limit = Folder::new("limit");
        let too_large = " ".repeat(MAX_DOCUMENT_BYTES + 1);
        let error = write_file(&limit.0, "big.json", &too_large, &mut || {}).unwrap_err();
        assert!(error.to_string().contains("25 MiB"));
        assert!(limit.files().is_empty());
        let mut published = false;
        let exact = write_file(&limit.0, "ok.json", "{}", &mut || published = true).unwrap();
        assert!(published);
        assert_eq!(limit.files(), ["ok.json"]);
        assert_eq!(fs::read_to_string(exact).unwrap(), "{}");
    }

    /// Past the budget a drawing gets no copy, logged like a failed write, so the session end is
    /// not refused waiting for it. Each session end has its own budget.
    #[test]
    fn session_end_recovery_stops_writing_at_the_byte_budget() {
        let folder = Folder::new("budget");
        let mut writer = folder.writer();
        writer.budget = 10;
        let tracker = tracker(); // {old} is 5 bytes and {deck} 6.
        writer.round(&tracker, &mut Disk);
        assert_eq!(
            folder.copy_names(),
            ["20261120T224719Z-object-17-Report.docx.json"]
        );
        assert!(!tracker.lock().unwrap().recovery_pending());
        assert!(folder
            .log()
            .contains("could not write the recovery copy 20261120T224719Z-object-18-Microsoft PowerPoint.json: this session end's recovery copies reached"));
        let risks = tracker.lock().unwrap().risks();
        assert!(risks[0].current && !risks[1].current);

        let cancelled = tracker.lock().unwrap().cancel(true).unwrap();
        writer.cancel(cancelled);
        writer.round(&tracker, &mut Disk);
        assert!(folder.copy_names().is_empty());
        tracker.lock().unwrap().begin(5, "20261121T080000Z".into());
        writer.round(&tracker, &mut Disk);
        assert_eq!(
            folder.copy_names(),
            ["20261121T080000Z-object-17-Report.docx.json"],
            "a new session end starts a new budget"
        );
    }

    #[test]
    fn session_end_recovery_cancel_keeps_only_drawings_office_closed() {
        let folder = Folder::new("cancel");
        let writer = folder.writer();
        let tracker = tracker();
        writer.round(&tracker, &mut Disk);
        {
            let mut locked = tracker.lock().unwrap();
            assert!(locked.collect(4, "17", "{new}"));
            locked.closed("17");
        }
        let cancelled = tracker.lock().unwrap().cancel(true).unwrap();
        assert_eq!(cancelled.request, 4);
        assert!(tracker.lock().unwrap().cancel(true).is_none());
        writer.cancel(cancelled);
        writer.round(&tracker, &mut Disk);
        let kept = folder
            .copies()
            .join("20261120T224719Z-object-17-Report.docx.json");
        assert_eq!(fs::read_to_string(&kept).unwrap(), "{new}");
        assert_eq!(
            folder.copy_names(),
            ["20261120T224719Z-object-17-Report.docx.json"]
        );
        let log = folder.log();
        assert!(log.contains(&format!(
            "The Windows session end was cancelled; kept the recovery copy {}.",
            kept.display()
        )));
        assert_eq!(log.matches("kept the recovery copy").count(), 1);
    }

    /// A copy still being written when Windows cancels the session end was never recorded, so
    /// the cancellation's plan does not know it. It is removed or kept as a recorded one would be.
    #[test]
    fn a_copy_in_flight_when_the_session_end_is_cancelled_follows_the_cancellation() {
        for (remove_open, survives) in [(true, false), (false, true)] {
            let folder = Folder::new(&format!("cancel-in-flight-{remove_open}"));
            let writer = folder.writer();
            let tracker: Mutex<Tracker<&'static str>> = Mutex::new(Tracker::new());
            tracker
                .lock()
                .unwrap()
                .opened("17", "Microsoft Word", "Report.docx", "{old}");
            tracker.lock().unwrap().begin(4, "20261120T224719Z".into());
            let (mut files, writes, release) = gated();
            thread::scope(|scope| {
                scope.spawn(|| run(&writer, &tracker, &mut files));
                writer.wake();
                writes.recv().unwrap();
                let cancelled = tracker.lock().unwrap().cancel(remove_open).unwrap();
                writer.cancel(cancelled);
                release.send(()).unwrap();
                while !writer.idle(false) {
                    thread::sleep(Duration::from_millis(5));
                }
                writer.stop();
            });
            let left = folder.copy_names();
            assert_eq!(left.len(), usize::from(survives), "{remove_open}: {left:?}");
            assert_eq!(
                folder.log().contains("kept the recovery copy"),
                survives,
                "{remove_open}"
            );
        }
    }

    /// The committed session end's last step: it closes only once idle, and a missed wake is
    /// caught by reading the tracker.
    #[test]
    fn closing_waits_for_queued_work_and_then_starts_nothing() {
        let folder = Folder::new("close");
        let writer = folder.writer();
        let tracker = tracker();
        assert!(!writer.try_close(true), "the tracker has copies to write");
        assert_eq!(writer.stage(), RecoveryWrite::Queued);
        writer.round(&tracker, &mut Disk);
        assert!(writer.idle(false));
        assert!(writer.try_close(false));

        assert!(tracker.lock().unwrap().collect(4, "17", "{new}"));
        writer.wake();
        writer.round(&tracker, &mut Disk);
        let copy = folder
            .copies()
            .join("20261120T224719Z-object-17-Report.docx.json");
        assert_eq!(
            fs::read_to_string(copy).unwrap(),
            "{old}",
            "nothing starts once closed"
        );
    }

    #[test]
    fn the_session_end_is_refused_only_within_the_time_limit() {
        let saving = Answer::Block(SAVING_REASON.into());
        let limit = SESSION_END_LIMIT;
        assert_eq!(decide(Answer::Allow, Duration::ZERO), Decision::Allow);
        assert_eq!(decide(Answer::Allow, limit * 2), Decision::Allow);
        assert_eq!(
            decide(saving.clone(), limit - Duration::from_millis(1)),
            Decision::Block(SAVING_REASON.into())
        );
        assert_eq!(
            decide(saving.clone(), limit),
            Decision::Overdue(SAVING_REASON.into())
        );
        assert_eq!(
            decide(saving, limit * 10),
            Decision::Overdue(SAVING_REASON.into())
        );
    }

    #[test]
    fn an_unsaved_drawing_from_a_closed_editor_gets_a_durable_copy() {
        let folder = Folder::new("unsaved");
        let path = write_unsaved(
            &folder.0,
            "20261121T101500Z",
            "23",
            "Microsoft Word",
            "Report.docx",
            "{latest}",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{latest}");
        // Without a document name the app names the file, as for a session end's copies.
        write_unsaved(
            &folder.0,
            "20261121T101500Z",
            "24",
            "Microsoft PowerPoint",
            " ",
            "{deck}",
        )
        .unwrap();
        assert_eq!(
            folder.files(),
            [
                "20261121T101500Z-object-23-Report.docx.json",
                "20261121T101500Z-object-24-Microsoft PowerPoint.json"
            ]
        );
        assert!(write_unsaved(
            &folder.0,
            "S",
            "25",
            "Word",
            "Big.docx",
            &" ".repeat(MAX_DOCUMENT_BYTES + 1)
        )
        .is_err());
    }
}
