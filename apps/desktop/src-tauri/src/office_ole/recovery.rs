//! Recovery copies of embedded Office drawings that a Windows session end put at risk, or that
//! Office did not take when their editor window closed outside one. Each file holds one editor's
//! last known drawing JSON (the selection JSON stored in `ChemDraftDocument`), named by its object
//! ID and container document. Nothing restores them automatically; the Office log
//! (`office-session-end.log`) names every file written.
//!
//! One [`Writer`] thread writes the recovery copies and log, leaving the Office STA and the
//! thread that answers Windows free. Whenever the tracker changes it takes its plan as owned snapshots
//! (each drawing is an `Arc<str>`), writes each copy atomically (`.partial`, sync, rename) and
//! records it in the tracker only once it is durable, so a copy that is queued or still being
//! written keeps the session end refused. It also appends the Office log while a session end is
//! pending. Its state machine ([`RecoveryWrite`]) mirrors `FlushWrite` on the session-flush side
//! (`shutdown.rs`). A committed session end waits for it only until fixed deadlines: a disk that
//! never returns is abandoned ([`Writer::abandon`]), its unfinished `.partial` is never renamed
//! over the last good copy, and the next start removes it ([`remove_stale_partials`]).

use std::{
    collections::VecDeque,
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Condvar, Mutex, OnceLock, PoisonError,
    },
    time::{Duration, Instant, SystemTime},
};

use super::{
    session_publish::{Answer, Cancelled, Drawing, Recovery, Tracker, Write, SAVING_REASON},
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
/// Why a copy finished after its committed session end's deadline was not published.
const ABANDONED: &str =
    "ChemDraft stopped waiting for it when Windows ended the session, so the previous copy is kept";

/// Keep the UTC timestamp readable and distinguish copies even when the clock repeats.
pub(super) fn copy_namespace(now: chrono::DateTime<chrono::Utc>) -> String {
    static RUN: OnceLock<u64> = OnceLock::new();
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let run = RUN.get_or_init(|| {
        let mut bytes = [0; 8];
        match getrandom::fill(&mut bytes) {
            Ok(()) => u64::from_ne_bytes(bytes),
            Err(_) => u64::from(std::process::id()),
        }
    });
    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("{}-{run:016x}-{sequence:x}", now.format("%Y%m%dT%H%M%SZ"))
}

pub(super) fn file_name(namespace: &str, object: &str, document: &str) -> String {
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
    format!("{namespace}-object-{object}-{document}.json")
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

/// Written whole and synced, then renamed into place. `publishing` runs just before the rename and
/// may refuse it: the copy is then removed, and the file it would have replaced is left as it was.
fn write_file(
    dir: &Path,
    name: &str,
    json: &str,
    publishing: &mut dyn FnMut() -> bool,
) -> io::Result<PathBuf> {
    check_size(json)?;
    fs::create_dir_all(dir)?;
    let path = dir.join(name);
    let partial = dir.join(format!("{name}.partial"));
    let mut file = fs::File::create(&partial)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if !publishing() {
        let _ = fs::remove_file(&partial);
        return Err(io::Error::other(ABANDONED));
    }
    fs::rename(&partial, &path)?;
    Ok(path)
}

/// Remove the `.partial` copies in `dir` last written before `before` (when this run's writer was
/// made): writes an earlier run abandoned at a stuck disk, or that failed. Nothing reads them; the
/// published copies beside them are untouched. Returns what was removed.
pub(super) fn remove_stale_partials(dir: &Path, before: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let stale = path
            .extension()
            .is_some_and(|extension| extension == "partial")
            && entry.metadata().is_ok_and(|metadata| {
                metadata.is_file() && metadata.modified().is_ok_and(|written| written < before)
            });
        if !stale {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed.push(path),
            Err(error) => eprintln!(
                "ChemDraft: could not remove the unfinished recovery copy {}: {error}",
                path.display()
            ),
        }
    }
    removed
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
    /// Like `write_file`: `publishing` may refuse the rename.
    fn write(
        &mut self,
        dir: &Path,
        name: &str,
        json: &str,
        publishing: &mut dyn FnMut() -> bool,
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
        publishing: &mut dyn FnMut() -> bool,
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
    /// Like `FlushWrite::grace_can_end_quit`: only now may the watchdog end the process before its
    /// deadline. At the deadline it ends it anyway (`Writer::close_by`).
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
    /// Set once a committed session end saw the writer idle, or abandoned it: nothing new starts
    /// after it, and nothing in flight is published.
    closed: bool,
    /// A committed session end's deadline passed with the writer still busy: its disk may never
    /// return, so nothing may be handed back to be written on another thread.
    abandoned: bool,
    stopped: bool,
    /// Bytes started for copies of one session end, by its request.
    spent: (u32, usize),
    cancelled: VecDeque<Cancelled>,
    unsaved: VecDeque<Unsaved>,
    /// Bytes of destroyed-editor drawings queued or being written.
    unsaved_bytes: usize,
    /// Office log entries, each ending in a newline, for the writer to append.
    entries: String,
    /// Copies written for a session end that was cancelled while they were in flight, so the
    /// tracker never recorded them. Its cancellation decides whether each stays.
    late: Vec<(u32, String, PathBuf)>,
}

struct Unsaved {
    name: String,
    json: String,
    context: String,
}

pub(crate) struct Writer {
    state: Mutex<State>,
    changed: Condvar,
    /// The recovery folder, or why there is none.
    dir: Result<PathBuf, String>,
    /// The Office log, if the app has a log folder.
    log: Option<PathBuf>,
    budget: usize,
    /// Older `.partial` copies are from an earlier run (`remove_stale_partials`).
    started: SystemTime,
}

impl Writer {
    pub(crate) fn new(dir: Result<PathBuf, String>, log: Option<PathBuf>) -> Self {
        Self {
            state: Mutex::new(State {
                stage: RecoveryWrite::Idle,
                again: false,
                active: false,
                closed: false,
                abandoned: false,
                stopped: false,
                spent: (0, 0),
                cancelled: VecDeque::new(),
                unsaved: VecDeque::new(),
                unsaved_bytes: 0,
                entries: String::new(),
                late: Vec::new(),
            }),
            changed: Condvar::new(),
            dir,
            log,
            budget: BUDGET_BYTES,
            started: SystemTime::now(),
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
        if !state.closed && !state.stopped {
            self.queue(&mut state);
        }
    }

    /// Append an entry to the Office log on the writer thread. Returns it if the writer is closed,
    /// for the caller to write. Once the writer was abandoned the entry is dropped instead (the
    /// caller has printed it): the disk may be stuck, and the caller must not wait on it.
    pub(crate) fn log(&self, entry: String) -> Result<(), String> {
        let mut state = self.lock();
        if state.abandoned {
            return Ok(());
        }
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
        if !state.closed && !state.stopped {
            state.cancelled.push_back(cancelled);
            self.queue(&mut state);
        }
    }

    /// Own a destroyed editor's drawing through the write result, within the outstanding budget.
    pub(super) fn queue_unsaved(
        &self,
        editor: &str,
        document: &str,
        json: String,
        context: &str,
    ) -> Result<(), String> {
        check_size(&json).map_err(|error| error.to_string())?;
        let name = file_name(&copy_namespace(chrono::Utc::now()), editor, document);
        let mut state = self.lock();
        if state.closed || state.stopped {
            return Err("the Office recovery writer is closed".into());
        }
        if state.unsaved_bytes.saturating_add(json.len()) > self.budget {
            return Err(format!(
                "the queued Office recovery copies reached ChemDraft's {} MiB limit",
                self.budget >> 20
            ));
        }
        state.unsaved_bytes += json.len();
        state.unsaved.push_back(Unsaved {
            name,
            json,
            context: context.to_owned(),
        });
        self.queue(&mut state);
        Ok(())
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
    fn try_close<T: Drawing>(&self, tracker: &Mutex<Tracker<T>>) -> bool {
        let mut tracker = tracker.lock().unwrap_or_else(PoisonError::into_inner);
        if !self.settled(tracker.recovery_pending(), true) {
            return false;
        }
        tracker.seal();
        true
    }

    /// Close now, even mid-write: a committed session end's deadline passed. Nothing new starts, a
    /// copy still in flight is never renamed into place (`publish`), so the last good copy stays,
    /// and its `.partial` is removed when the write returns or at the next start.
    fn abandon<T: Drawing>(&self, tracker: &Mutex<Tracker<T>>) {
        // Both close paths acquire the tracker before the writer. The writer never holds its
        // state lock while acquiring the tracker or doing disk I/O.
        let mut tracker = tracker.lock().unwrap_or_else(PoisonError::into_inner);
        tracker.seal();
        let mut state = self.lock();
        state.closed = true;
        state.abandoned = true;
        self.changed.notify_all();
    }

    /// The watchdog's side of `try_close`, bounded: waits for what is queued or in flight until
    /// `deadline` on `clock`, then abandons it, so a write that never returns cannot hold the
    /// process. True if the writer settled in time.
    pub(super) fn close_by<T: Drawing>(
        &self,
        tracker: &Mutex<Tracker<T>>,
        deadline: Instant,
        clock: impl Fn() -> Instant,
    ) -> bool {
        loop {
            if self.try_close(tracker) {
                return true;
            }
            let left = deadline.saturating_duration_since(clock());
            if left.is_zero() {
                self.abandon(tracker);
                return false;
            }
            let state = self.lock();
            if !state.stopped && !state.closed && !state.stage.watchdog_can_exit() {
                drop(
                    self.changed
                        .wait_timeout(state, left.min(POLL))
                        .unwrap_or_else(PoisonError::into_inner),
                );
            }
        }
    }

    /// A committed session end's last step on the thread answering Windows, bounded whatever the
    /// disk does. `wait(deadline, done)` pumps until `done` or `deadline`. It waits for every
    /// queued copy until `copies_by`, runs `log` (what is still at risk), then waits for the writer
    /// to append that and closes it, until `close_by`. A writer still busy is abandoned. True if
    /// it settled in time.
    pub(super) fn close_committed<T: Drawing>(
        &self,
        tracker: &Mutex<Tracker<T>>,
        copies_by: Instant,
        close_by: Instant,
        mut wait: impl FnMut(Instant, &mut dyn FnMut() -> bool) -> bool,
        log: impl FnOnce(),
    ) -> bool {
        wait(copies_by, &mut || {
            self.idle(
                tracker
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .recovery_pending(),
            )
        });
        log();
        if wait(close_by, &mut || self.try_close(tracker)) {
            return true;
        }
        self.abandon(tracker);
        false
    }

    pub(crate) fn stop(&self) {
        self.lock().stopped = true;
        self.changed.notify_all();
    }

    fn set_stage(&self, stage: RecoveryWrite) {
        self.lock().stage = stage;
    }

    /// Just before a synced copy is renamed into place. Refused once the writer is closed, which
    /// mid-write means abandoned: a copy finished after its deadline never replaces the last good
    /// one. A rename already under way completes; it replaces one whole copy with another.
    fn publish(&self) -> bool {
        let mut state = self.lock();
        if state.closed || state.stopped {
            return false;
        }
        state.stage = RecoveryWrite::Publishing;
        true
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

    /// Report a recovery outcome and queue the log entry without touching the Office log file.
    pub(super) fn note(&self, message: std::fmt::Arguments<'_>) {
        eprintln!("ChemDraft: {message}");
        let entry = format!("{} {message}\n", chrono::Utc::now().to_rfc3339());
        let _ = self.log(entry);
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

    /// Drain cancellations, the pending session plan, the log and destroyed-editor copies.
    /// Check for session work between destroyed-editor copies.
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
            self.write_next_unsaved(files);
            let mut state = self.lock();
            state.active = active;
            let more = state.again
                || worked
                || !state.cancelled.is_empty()
                || !state.entries.is_empty()
                || !state.unsaved.is_empty();
            if state.closed || state.stopped || !more {
                state.stage = RecoveryWrite::Idle;
                self.changed.notify_all();
                return;
            }
            state.again = false;
        }
    }

    fn write_next_unsaved(&self, files: &mut impl Files) {
        let job = {
            let mut state = self.lock();
            if state.closed || state.stopped {
                return;
            }
            let Some(job) = state.unsaved.pop_front() else {
                return;
            };
            state.stage = RecoveryWrite::Writing;
            job
        };
        let result = self.dir.as_ref().map_err(String::clone).and_then(|dir| {
            files
                .write(dir, &job.name, &job.json, &mut || self.publish())
                .map_err(|error| error.to_string())
        });
        match result {
            Ok(path) => self.note(format_args!(
                "{}; wrote its last drawing to {}. Nothing restores this copy automatically.",
                job.context,
                path.display()
            )),
            Err(error) => self.note(format_args!(
                "{}, and could not write a recovery copy: {error}.",
                job.context
            )),
        }
        let bytes = job.json.len();
        drop(job);
        let mut state = self.lock();
        state.unsaved_bytes -= bytes;
        state.stage = RecoveryWrite::Queued;
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
        let result = files.write(dir, &write.name, &write.json, &mut || self.publish());
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

/// The writer thread: removes copies an earlier run left unfinished, then one pass per wake (and
/// per `POLL` while a session end is pending) until `stop`.
pub(super) fn run<T: Drawing>(
    writer: &Writer,
    tracker: &Mutex<Tracker<T>>,
    files: &mut impl Files,
) {
    let _stopping = Stopping(writer);
    if let Ok(dir) = &writer.dir {
        let removed = remove_stale_partials(dir, writer.started).len();
        if removed > 0 {
            eprintln!("ChemDraft: removed {removed} unfinished Office recovery copies");
        }
    }
    while writer.next_round() {
        writer.round(tracker, files);
    }
}

#[cfg(test)]
mod tests {
    use super::super::session_publish::{Job, Outcome};
    use super::*;
    use crate::windows_session_end::{
        wait_until, watch_flush, CLOSE_LIMIT, EXIT_LIMIT, RECOVERY_LIMIT,
    };
    use chrono::TimeZone;
    use std::{
        sync::{
            atomic::{AtomicBool, AtomicU32, Ordering},
            mpsc,
        },
        thread,
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
            publishing: &mut dyn FnMut() -> bool,
        ) -> io::Result<PathBuf> {
            let _ = self.entered.send(name.to_owned());
            self.proceed.recv().map_err(io::Error::other)?;
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

    // Owned inside the scoped closure, so unwinding stops and releases the writer before joining.
    struct ReleaseWriter<'a> {
        writer: &'a Writer,
        release: mpsc::Sender<()>,
    }

    impl Drop for ReleaseWriter<'_> {
        fn drop(&mut self) {
            self.writer.stop();
            let _ = self.release.send(());
        }
    }

    #[test]
    fn a_failed_gated_assertion_releases_the_writer_before_joining() {
        let folder = Folder::new("gated-unwind");
        let writer = folder.writer();
        let tracker = tracker();
        let (mut files, writes, release) = gated();
        let rescue = release.clone();
        thread::scope(|scope| {
            let worker = scope.spawn(|| run(&writer, &tracker, &mut files));
            let result = std::panic::catch_unwind(|| {
                let _gate = ReleaseWriter {
                    writer: &writer,
                    release,
                };
                writer.wake();
                assert!(writes.recv_timeout(Duration::from_secs(5)).is_ok());
                panic!("simulated assertion failure inside the gate");
            });
            let stopped = wait_until(
                Instant::now() + Duration::from_secs(5),
                Instant::now,
                || worker.is_finished(),
                || thread::sleep(Duration::from_millis(5)),
            );
            if !stopped {
                writer.stop();
                let _ = rescue.send(());
            }
            let panic = result.expect_err("the test assertion should unwind");
            assert_eq!(
                panic.downcast_ref::<&str>().copied(),
                Some("simulated assertion failure inside the gate")
            );
            assert!(stopped);
        });
    }

    /// A disk that hangs inside each copy: half the drawing reaches its `.partial`, and the write
    /// never returns.
    struct Stuck {
        entered: mpsc::Sender<String>,
    }

    impl Files for Stuck {
        fn write(
            &mut self,
            dir: &Path,
            name: &str,
            json: &str,
            _publishing: &mut dyn FnMut() -> bool,
        ) -> io::Result<PathBuf> {
            fs::create_dir_all(dir)?;
            let half = &json.as_bytes()[..json.len() / 2];
            fs::write(dir.join(format!("{name}.partial")), half)?;
            self.entered.send(name.to_owned()).unwrap();
            loop {
                thread::park();
            }
        }

        fn remove(&mut self, path: &Path) -> io::Result<()> {
            Disk.remove(path)
        }

        fn append(&mut self, log: &Path, entries: &str) -> io::Result<()> {
            Disk.append(log, entries)
        }
    }

    /// A clock that moves on by `step` each time it is read, so a deadline passes after a few
    /// readings without the test waiting for it.
    struct Clock {
        base: Instant,
        step: Duration,
        reads: AtomicU32,
    }

    impl Clock {
        fn new(step: Duration) -> Self {
            Self {
                base: Instant::now(),
                step,
                reads: AtomicU32::new(0),
            }
        }

        fn now(&self) -> Instant {
            self.base + self.step * self.reads.fetch_add(1, Ordering::SeqCst)
        }

        /// The last reading, without moving on.
        fn last(&self) -> Instant {
            let reads = self.reads.load(Ordering::SeqCst);
            self.base + self.step * reads.saturating_sub(1)
        }
    }

    const COPY_17: &str = "20261120T224719Z-object-17-Report.docx.json";
    const COPY_18: &str = "20261120T224719Z-object-18-Microsoft PowerPoint.json";

    /// A committed session end whose disk hangs: both drawings have a published copy, then object
    /// 17 gets a newer drawing and Office closes it, and the write of its new copy never returns.
    /// The writer thread is left blocked for good, so the writer and tracker are leaked.
    struct StuckSessionEnd {
        folder: Folder,
        writer: &'static Writer,
        tracker: &'static Mutex<Tracker<&'static str>>,
        published: Vec<u8>,
    }

    impl StuckSessionEnd {
        fn new(name: &str) -> Self {
            let folder = Folder::new(name);
            let writer: &'static Writer = Box::leak(Box::new(folder.writer()));
            let tracker: &'static Mutex<_> = Box::leak(Box::new(tracker()));
            writer.round(tracker, &mut Disk);
            let published = fs::read(folder.copies().join(COPY_17)).unwrap();
            assert_eq!(published, b"{old}");
            {
                let mut locked = tracker.lock().unwrap();
                assert!(locked.collect(4, "17", "{new}"));
                assert!(locked.closed("17").is_some());
            }
            let (entered, writes) = mpsc::channel();
            thread::spawn(move || run(writer, tracker, &mut Stuck { entered }));
            writer.wake();
            assert_eq!(writes.recv().unwrap(), COPY_17);
            assert_eq!(writer.stage(), RecoveryWrite::Writing);
            assert!(answer_of(tracker).blocks(), "the new copy is not durable");
            Self {
                folder,
                writer,
                tracker,
                published,
            }
        }

        /// The last good copy is byte-identical, the abandoned write was never renamed over it,
        /// and the next start removes the unfinished copy and nothing else.
        fn assert_last_good_copy_kept(&self) {
            let copies = self.folder.copies();
            let partial = copies.join(format!("{COPY_17}.partial"));
            assert_eq!(fs::read(copies.join(COPY_17)).unwrap(), self.published);
            assert_eq!(fs::read(&partial).unwrap(), b"{n", "never published");
            assert!(!self.tracker.lock().unwrap().risks()[0].current);
            // The next start's writer is made after this run ended.
            let next_start = SystemTime::now() + Duration::from_secs(1);
            assert_eq!(remove_stale_partials(&copies, next_start), [partial]);
            assert_eq!(self.folder.copy_names(), [COPY_17, COPY_18]);
            assert_eq!(fs::read(copies.join(COPY_17)).unwrap(), self.published);
        }
    }

    #[test]
    fn session_end_recovery_names_files_by_stamp_object_and_document() {
        let start = chrono::Utc
            .with_ymd_and_hms(2026, 11, 20, 22, 47, 19)
            .unwrap();
        assert!(copy_namespace(start).starts_with("20261120T224719Z-"));
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

    #[test]
    fn a_second_session_in_the_same_second_keeps_the_previous_copy() {
        let folder = Folder::new("same-second");
        let writer = folder.writer();
        let tracker = Mutex::new(Tracker::new());
        let start = chrono::Utc
            .with_ymd_and_hms(2026, 11, 20, 22, 47, 19)
            .unwrap();
        {
            let mut locked = tracker.lock().unwrap();
            locked.opened("17", "Microsoft Word", "Report.docx", "{old}");
            locked.begin(4, copy_namespace(start)).unwrap();
        }
        writer.round(&tracker, &mut Disk);
        let first = tracker.lock().unwrap().risks()[0].snapshot.clone().unwrap();
        {
            let mut locked = tracker.lock().unwrap();
            writer.cancel(locked.cancel(false).unwrap());
            locked.begin(5, copy_namespace(start)).unwrap();
        }
        writer.round(&tracker, &mut Disk);
        let second = tracker.lock().unwrap().risks()[0].snapshot.clone().unwrap();
        assert!(tracker.lock().unwrap().collect(5, "17", "{new}"));
        writer.round(&tracker, &mut Disk);
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(&first).unwrap(), "{old}");
        assert_eq!(fs::read_to_string(&second).unwrap(), "{new}");
        assert_eq!(
            tracker.lock().unwrap().risks()[0].snapshot.as_ref(),
            Some(&second)
        );
        assert_eq!(folder.copy_names().len(), 2);
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
            let gate = ReleaseWriter {
                writer: &writer,
                release,
            };
            writer.wake();
            assert_eq!(
                writes.recv_timeout(Duration::from_secs(5)).unwrap(),
                "20261120T224719Z-object-17-Report.docx.json"
            );
            // In flight: still refused, and nothing durable yet.
            assert_eq!(writer.stage(), RecoveryWrite::Writing);
            assert!(answer_of(&tracker).blocks());
            assert!(!tracker.lock().unwrap().risks()[0].current);
            assert!(!writer.idle(tracker.lock().unwrap().recovery_pending()));
            assert!(!writer.try_close(&tracker), "never closes mid-write");

            // The committed session end's watchdog fires now, and must wait for the copy.
            let (_disarm, watchdog) = mpsc::channel::<()>();
            let watchdog_done = &watchdog_done;
            let writer = &writer;
            let tracker = &tracker;
            let watched = scope.spawn(move || {
                crate::windows_session_end::watch_flush(watchdog, Duration::ZERO, || {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    assert!(writer.close_by(tracker, deadline, Instant::now));
                    watchdog_done.store(true, Ordering::SeqCst);
                });
            });
            thread::sleep(Duration::from_millis(150));
            assert!(
                !watchdog_done.load(Ordering::SeqCst),
                "the watchdog must not end the process during a write"
            );
            assert_eq!(writer.stage(), RecoveryWrite::Writing);

            gate.release.send(()).unwrap();
            watched.join().unwrap();
            assert!(watchdog_done.load(Ordering::SeqCst));
            // Durable and closed: the session end may end, and a later change starts nothing.
            assert_eq!(answer_of(tracker), Answer::Allow);
            assert!(writer.try_close(tracker));
            assert!(writer.log("late entry\n".into()).is_err());
            writer.wake();
            assert!(writes.try_recv().is_err());
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

    /// The thread answering a committed session end stops waiting for a write that never returns
    /// at its deadline, logs what is at risk and closes the writer anyway, so the message returns
    /// and the process can end.
    #[test]
    fn a_committed_flush_stops_waiting_for_a_recovery_write_that_never_returns() {
        let stuck = StuckSessionEnd::new("stuck-flush");
        let clock = Clock::new(Duration::from_millis(100));
        let start = clock.base;
        let real = Instant::now();
        let mut logged = false;
        let settled = stuck.writer.close_committed(
            stuck.tracker,
            start + RECOVERY_LIMIT,
            start + CLOSE_LIMIT,
            |deadline, done| {
                wait_until(
                    deadline,
                    || clock.now(),
                    done,
                    || thread::sleep(Duration::from_millis(1)),
                )
            },
            || logged = true,
        );
        assert!(!settled, "the write never returned");
        assert!(
            logged,
            "what is at risk is logged before the writer is closed"
        );
        let gave_up = clock.last();
        assert!(
            gave_up >= start + CLOSE_LIMIT,
            "it waits through the close interval after the copy deadline"
        );
        assert!(
            gave_up < start + CLOSE_LIMIT + clock.step,
            "and not past it"
        );
        assert!(real.elapsed() < Duration::from_secs(5));
        // Closed: nothing new starts, and a late log entry is not handed back to be written on
        // the thread answering Windows, which would then wait on the stuck disk itself.
        assert!(!stuck.tracker.lock().unwrap().collect(4, "18", "{late}"));
        assert!(stuck.writer.idle(true) && stuck.writer.try_close(stuck.tracker));
        assert_eq!(stuck.writer.log("late entry\n".into()), Ok(()));
        assert_eq!(stuck.writer.stage(), RecoveryWrite::Writing, "still stuck");
        stuck.assert_last_good_copy_kept();
    }

    #[test]
    fn the_risk_log_flushes_when_the_disk_returns_during_the_close_interval() {
        let folder = Folder::new("close-interval");
        let writer = folder.writer();
        let tracker = tracker();
        assert!(tracker.lock().unwrap().unchanged(4, "18"));
        let (mut files, writes, release) = gated();
        thread::scope(|scope| {
            scope.spawn(|| run(&writer, &tracker, &mut files));
            let gate = ReleaseWriter {
                writer: &writer,
                release,
            };
            writer.wake();
            assert_eq!(
                writes.recv_timeout(Duration::from_secs(5)).unwrap(),
                COPY_17
            );
            let clock = Clock::new(RECOVERY_LIMIT);
            let start = clock.base;
            let close_by = start + CLOSE_LIMIT;
            assert!(writer.close_committed(
                &tracker,
                start + RECOVERY_LIMIT,
                close_by,
                |deadline, done| {
                    if deadline == close_by {
                        gate.release.send(()).unwrap();
                        // Hold the simulated clock within the final interval while the real
                        // writer drains the copy and log.
                        return wait_until(
                            Instant::now() + Duration::from_secs(5),
                            Instant::now,
                            done,
                            || thread::sleep(Duration::from_millis(5)),
                        );
                    }
                    wait_until(deadline, || clock.now(), done, || {})
                },
                || writer
                    .log("the drawing was still at risk\n".into())
                    .unwrap(),
            ));
        });
        assert!(folder.log().contains("the drawing was still at risk"));
    }

    /// The watchdog fires while the thread answering Windows is stuck elsewhere. It waits for a
    /// write that never returns only until its own deadline, then reaches the process exit.
    #[test]
    fn the_watchdog_ends_the_process_by_its_deadline_while_a_recovery_write_never_returns() {
        let stuck = StuckSessionEnd::new("stuck-watchdog");
        let clock = Clock::new(Duration::from_secs(2));
        let start = clock.base;
        let real = Instant::now();
        let exited = Mutex::new(None);
        let (_disarm, watchdog) = mpsc::channel::<()>();
        watch_flush(watchdog, Duration::ZERO, || {
            let settled = stuck
                .writer
                .close_by(stuck.tracker, start + EXIT_LIMIT, || clock.now());
            // force_exit
            *exited.lock().unwrap() = Some((settled, clock.last()));
        });
        let (settled, at) = exited
            .into_inner()
            .unwrap()
            .expect("the watchdog must reach the exit");
        assert!(!settled, "the write never returned");
        assert!(at >= start + EXIT_LIMIT, "it waits until its deadline");
        assert!(at < start + EXIT_LIMIT + clock.step, "and not past it");
        assert!(real.elapsed() < Duration::from_secs(5));
        assert!(!stuck.tracker.lock().unwrap().collect(4, "18", "{late}"));
        assert!(stuck.writer.try_close(stuck.tracker), "nothing new starts");
        assert_eq!(stuck.writer.stage(), RecoveryWrite::Writing, "still stuck");
        stuck.assert_last_good_copy_kept();
    }

    /// A write that returns after its deadline passed is not renamed into place: the last good
    /// copy stays and the unfinished one is removed.
    #[test]
    fn a_recovery_write_that_returns_after_it_was_abandoned_is_never_published() {
        let folder = Folder::new("late-write");
        let writer = folder.writer();
        let tracker = tracker();
        writer.round(&tracker, &mut Disk);
        {
            let mut locked = tracker.lock().unwrap();
            assert!(locked.collect(4, "17", "{new}"));
            assert!(locked.closed("17").is_some());
        }
        let (mut files, writes, release) = gated();
        thread::scope(|scope| {
            scope.spawn(|| run(&writer, &tracker, &mut files));
            let gate = ReleaseWriter {
                writer: &writer,
                release,
            };
            writer.wake();
            assert_eq!(
                writes.recv_timeout(Duration::from_secs(5)).unwrap(),
                COPY_17
            );
            assert!(!writer.close_by(&tracker, Instant::now(), Instant::now));
            gate.release.send(()).unwrap();
            assert!(wait_until(
                Instant::now() + Duration::from_secs(5),
                Instant::now,
                || writer.stage() == RecoveryWrite::Idle,
                || thread::sleep(Duration::from_millis(5)),
            ));
        });
        let copy = folder.copies().join(COPY_17);
        assert_eq!(fs::read_to_string(&copy).unwrap(), "{old}");
        assert_eq!(
            folder.copy_names(),
            [COPY_17, COPY_18],
            "no .partial is left"
        );
        assert!(!tracker.lock().unwrap().risks()[0].current);
    }

    #[test]
    fn the_next_start_removes_only_unfinished_copies_from_an_earlier_run() {
        let folder = Folder::new("stale-partials");
        fs::create_dir_all(folder.0.join("folder.partial")).unwrap();
        for name in ["a.json", "a.json.partial", "notes.txt"] {
            fs::write(folder.0.join(name), name).unwrap();
        }
        assert!(
            remove_stale_partials(&folder.0, SystemTime::UNIX_EPOCH).is_empty(),
            "written by this run"
        );
        let later = SystemTime::now() + Duration::from_secs(1);
        assert_eq!(
            remove_stale_partials(&folder.0, later),
            [folder.0.join("a.json.partial")]
        );
        assert_eq!(folder.files(), ["a.json", "folder.partial", "notes.txt"]);
        assert!(remove_stale_partials(&folder.0.join("missing"), later).is_empty());
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
        let error = write_file(&limit.0, "big.json", &too_large, &mut || true).unwrap_err();
        assert!(error.to_string().contains("25 MiB"));
        assert!(limit.files().is_empty());
        let mut published = false;
        let exact = write_file(&limit.0, "ok.json", "{}", &mut || {
            published = true;
            true
        })
        .unwrap();
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
                let gate = ReleaseWriter {
                    writer: &writer,
                    release,
                };
                writer.wake();
                writes.recv_timeout(Duration::from_secs(5)).unwrap();
                let cancelled = tracker.lock().unwrap().cancel(remove_open).unwrap();
                writer.cancel(cancelled);
                gate.release.send(()).unwrap();
                assert!(wait_until(
                    Instant::now() + Duration::from_secs(5),
                    Instant::now,
                    || writer.idle(false),
                    || thread::sleep(Duration::from_millis(5)),
                ));
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

    #[test]
    fn closing_accounts_for_publications_that_won_the_race_and_rejects_later_ones() {
        let folder = Folder::new("close");
        let writer = folder.writer();
        let tracker = tracker();
        // Both fallbacks are durable and the writer is idle.
        writer.round(&tracker, &mut Disk);
        // A renderer accepted just before close can be between collecting and sending its wake.
        assert!(tracker.lock().unwrap().collect(4, "17", "{new}"));
        assert!(!writer.try_close(&tracker));
        assert_eq!(writer.stage(), RecoveryWrite::Queued);
        writer.round(&tracker, &mut Disk);
        assert!(tracker.lock().unwrap().unsent(4, "18"));
        assert!(writer.try_close(&tracker));
        let mut locked = tracker.lock().unwrap();
        assert!(!locked.accepting(4, "18"));
        assert!(!locked.collect(4, "18", "{late}"));
        assert!(!locked.unchanged(4, "18"));
        assert!(!locked.replaced("18", "{interactive}"));
        assert!(!locked.recovery_pending());
        assert_eq!(
            fs::read_to_string(folder.copies().join(COPY_17)).unwrap(),
            "{new}"
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
    fn destroyed_editor_copies_keep_their_bytes_until_written_and_drain_at_exit() {
        let folder = Folder::new("unsaved");
        let mut writer = folder.writer();
        writer.budget = 6;
        let tracker = Mutex::new(Tracker::<&str>::new());
        let (mut files, writes, release) = gated();
        thread::scope(|scope| {
            scope.spawn(|| run(&writer, &tracker, &mut files));
            let gate = ReleaseWriter {
                writer: &writer,
                release,
            };
            writer
                .queue_unsaved("23", "Report.docx", "{a}".into(), "Office refused A")
                .unwrap();
            let first = writes.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(first.ends_with("-object-23-Report.docx.json"));
            assert!(!folder.copies().join(&first).exists());
            writer
                .queue_unsaved("24", "Slides.pptx", "{b}".into(), "Office refused B")
                .unwrap();
            assert!(writer
                .queue_unsaved("25", "Notes.docx", "{c}".into(), "Office refused C")
                .is_err());
            assert!(
                !writer.try_close(&tracker),
                "ordinary exit must wait for the pending copy"
            );
            gate.release.send(()).unwrap();
            let second = writes.recv_timeout(Duration::from_secs(5)).unwrap();
            gate.release.send(()).unwrap();
            assert!(writer.close_by(
                &tracker,
                Instant::now() + Duration::from_secs(5),
                Instant::now
            ));
            for (name, drawing) in [(first, "{a}"), (second, "{b}")] {
                assert_eq!(
                    fs::read_to_string(folder.copies().join(name)).unwrap(),
                    drawing
                );
            }
        });
        let log = folder.log();
        assert!(log.contains("Office refused A; wrote its last drawing"));
        assert!(log.contains("Office refused B; wrote its last drawing"));
    }

    #[test]
    fn the_destroyed_editor_copy_reports_a_write_failure_and_releases_its_budget() {
        let folder = Folder::new("unsaved-failure");
        let mut writer = folder.writer();
        writer.dir = Err("no recovery folder".into());
        writer.budget = 3;
        let tracker = Mutex::new(Tracker::<&str>::new());
        for _ in 0..2 {
            writer
                .queue_unsaved("23", "Report.docx", "{a}".into(), "Office refused A")
                .unwrap();
            writer.round(&tracker, &mut Disk);
        }
        assert_eq!(
            folder
                .log()
                .matches("could not write a recovery copy: no recovery folder")
                .count(),
            2
        );
        assert!(writer
            .queue_unsaved(
                "23",
                "Big.docx",
                " ".repeat(MAX_DOCUMENT_BYTES + 1),
                "Office refused"
            )
            .unwrap_err()
            .contains("25 MiB"));
    }
}
