//! Recovery copies of embedded Office drawings that a Windows session end put at risk, or that
//! Office did not take when their editor window closed outside one. Each file holds one editor's
//! last known drawing JSON (the selection JSON stored in `ChemDraftDocument`), named by its object
//! ID and container document. Nothing restores them automatically; the Office log
//! (`office-session-end.log`) names every file written.

use std::{
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::Mutex,
};

use super::{
    session_publish::{display_name, Answer, Drawing, Recovery, Tracker, SAVING_REASON},
    storage::MAX_DOCUMENT_BYTES,
};

/// Under the app data folder.
pub(crate) const FOLDER: &str = "office-recovery";
const MAX_NAME_CHARS: usize = 80;

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

/// The same bound as the IPC update frame's selection JSON. Written whole, then renamed into place.
fn write_file(dir: &Path, name: &str, json: &str) -> io::Result<PathBuf> {
    if json.len() > MAX_DOCUMENT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the drawing exceeds the 25 MiB ChemDraftDocument limit",
        ));
    }
    fs::create_dir_all(dir)?;
    let path = dir.join(name);
    let partial = dir.join(format!("{name}.partial"));
    let mut file = fs::File::create(&partial)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;
    drop(file);
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
    )
}

#[derive(Default)]
pub(crate) struct Report {
    pub written: Vec<(String, PathBuf)>,
    pub removed: Vec<PathBuf>,
    pub errors: Vec<String>,
}

pub(crate) struct CancelReport {
    pub request: u32,
    /// Recovery files left in place, including any written for objects Office closed.
    pub kept: Vec<PathBuf>,
    pub report: Report,
}

fn apply<T: Drawing>(
    tracker: &Mutex<Tracker<T>>,
    plan: Recovery,
    dir: Option<&Path>,
    report: &mut Report,
) {
    for write in plan.write {
        let result = dir.map_or_else(
            || {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "ChemDraft has no app data folder",
                ))
            },
            |dir| write_file(dir, &write.name, &write.json),
        );
        let path = match result {
            Ok(path) => {
                report.written.push((write.editor.clone(), path.clone()));
                Some(path)
            }
            Err(error) => {
                report.errors.push(format!(
                    "Office object {}: could not write the recovery copy {}: {error}",
                    write.editor, write.name
                ));
                None
            }
        };
        tracker
            .lock()
            .unwrap()
            .wrote(&write.editor, &write.json, path);
    }
    for (editor, path) in plan.remove {
        match fs::remove_file(&path) {
            Ok(()) => report.removed.push(path.clone()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => report.errors.push(format!(
                "Office object {editor}: could not remove the recovery copy {}: {error}",
                path.display()
            )),
        }
        // Stop tracking it either way, so a stuck file is reported once.
        tracker.lock().unwrap().removed(&editor, &path);
    }
}

/// Passes `settle` makes while the session end stays refused. A drawing that changes during them
/// keeps the session end refused, and the next settle (the session timer's) writes it.
const REFUSED_PASSES: usize = 2;
/// Most passes `settle` makes before it lets the session end. Only an editor Office closed can
/// still need a copy then, and its drawing no longer changes, so one more pass is normally enough.
const MAX_PASSES: usize = 4;

/// Bring the recovery folder in line with the tracker, then answer the session end. File I/O runs
/// outside the lock. The answer is read under the same lock as a plan with nothing left to do, so
/// `Allow` is never returned while a drawing that changed or closed during a pass (an editor's
/// reply collected after the last plan, then Office closing that object) has only an older copy.
pub(super) fn settle<T: Drawing>(
    tracker: &Mutex<Tracker<T>>,
    dir: Option<&Path>,
) -> (Answer, Report) {
    settle_observed(tracker, dir, |_| {})
}

/// `settle`, calling `after_pass` after each pass's file I/O, so a test can change the tracker
/// exactly where another thread could.
fn settle_observed<T: Drawing>(
    tracker: &Mutex<Tracker<T>>,
    dir: Option<&Path>,
    mut after_pass: impl FnMut(&Mutex<Tracker<T>>),
) -> (Answer, Report) {
    let mut report = Report::default();
    let mut passes = 0;
    loop {
        let (plan, answer) = {
            let locked = tracker.lock().unwrap();
            (locked.recovery(), locked.answer())
        };
        if plan.write.is_empty() && plan.remove.is_empty() {
            return (answer, report);
        }
        if passes >= MAX_PASSES || (passes >= REFUSED_PASSES && answer.blocks()) {
            // Still refusing is always safe: the session timer settles again.
            let answer = if answer.blocks() {
                answer
            } else {
                Answer::Block(SAVING_REASON.into())
            };
            return (answer, report);
        }
        apply(tracker, plan, dir, &mut report);
        passes += 1;
        after_pass(tracker);
    }
}

pub(super) fn cancel<T: Drawing>(
    tracker: &Mutex<Tracker<T>>,
    dir: Option<&Path>,
    remove_open: bool,
) -> Option<CancelReport> {
    let cancelled = tracker.lock().unwrap().cancel(remove_open)?;
    let mut report = Report::default();
    apply(tracker, cancelled.recovery, dir, &mut report);
    let mut kept = cancelled.kept;
    kept.extend(report.written.iter().map(|(_, path)| path.clone()));
    Some(CancelReport {
        request: cancelled.request,
        kept,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::super::session_publish::{Job, Outcome};
    use super::*;
    use chrono::TimeZone;
    use std::time::Instant;

    struct Folder(PathBuf);

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
            let mut names: Vec<_> = fs::read_dir(&self.0)
                .map(|entries| {
                    entries
                        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
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

    #[test]
    fn session_end_recovery_writes_at_risk_drawings_and_removes_them_once_saved() {
        let root = Folder::new("settle");
        let folder = Folder(root.0.join(FOLDER));
        let tracker = tracker();
        assert!(tracker.lock().unwrap().collect(4, "17", "{new}"));

        let (answer, report) = settle(&tracker, Some(&folder.0));
        assert!(answer.blocks());
        assert!(report.errors.is_empty());
        let report_names: Vec<_> = report.written.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(report_names, ["17", "18"]);
        assert_eq!(
            folder.files(),
            [
                "20261120T224719Z-object-17-Report.docx.json",
                "20261120T224719Z-object-18-Microsoft PowerPoint.json"
            ]
        );
        assert_eq!(fs::read_to_string(&report.written[0].1).unwrap(), "{new}");
        assert_eq!(fs::read_to_string(&report.written[1].1).unwrap(), "{deck}");
        let risks = tracker.lock().unwrap().risks();
        assert_eq!(risks[0].snapshot.as_ref(), Some(&report.written[0].1));

        let (_, again) = settle(&tracker, Some(&folder.0));
        assert!(again.written.is_empty() && again.removed.is_empty());

        // Office takes object 17; 18 had nothing new.
        let mut locked = tracker.lock().unwrap();
        for (request, id, job) in locked.take_jobs(Instant::now(), false) {
            assert!(matches!(job, Job::Install("{new}")));
            locked.finish_job(request, &id, Outcome::Saved, Instant::now());
        }
        assert!(locked.unchanged(4, "18"));
        drop(locked);
        let (answer, report) = settle(&tracker, Some(&folder.0));
        assert_eq!(answer, Answer::Allow);
        assert_eq!(report.removed.len(), 2);
        assert!(folder.files().is_empty());
    }

    /// Editor 18 answers after the last planned pass and Office then closes its object, while 17
    /// is saved. The session end must not be allowed until 18's copy holds the drawing collected
    /// from its editor, not the older one the first pass wrote while it was still waiting.
    #[test]
    fn session_end_recovery_keeps_a_closed_drawing_current_before_allowing() {
        let folder = Folder::new("closed-late");
        let tracker = tracker();
        let mut pass = 0;
        let (answer, report) = settle_observed(&tracker, Some(&folder.0), |tracker| {
            pass += 1;
            let mut locked = tracker.lock().unwrap();
            match pass {
                // 17 answers during the first pass's writes.
                1 => assert!(locked.collect(4, "17", "{new}")),
                // After the second pass: 18 answers, Office closes 18, and Office saves 17.
                2 => {
                    assert!(locked.collect(4, "18", "{deck, edited}"));
                    assert!(locked.closed("18").is_some());
                    for (request, id, job) in locked.take_jobs(Instant::now(), false) {
                        assert!(matches!(job, Job::Install("{new}")));
                        locked.finish_job(request, &id, Outcome::Saved, Instant::now());
                    }
                }
                _ => {}
            }
        });
        assert_eq!(answer, Answer::Allow);
        assert!(report.errors.is_empty());
        let copy = folder
            .0
            .join("20261120T224719Z-object-18-Microsoft PowerPoint.json");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "{deck, edited}");
        assert_eq!(
            folder.files(),
            ["20261120T224719Z-object-18-Microsoft PowerPoint.json"]
        );
        let risks = tracker.lock().unwrap().risks();
        assert_eq!(risks.len(), 1);
        assert_eq!(risks[0].snapshot.as_ref(), Some(&copy));
    }

    #[test]
    fn session_end_recovery_reports_write_failures_once_and_enforces_the_ipc_limit() {
        let tracker = tracker();
        let (answer, report) = settle(&tracker, None);
        assert!(answer.blocks());
        assert!(report.written.is_empty());
        assert_eq!(report.errors.len(), 2);
        assert!(report.errors[0].contains("no app data folder"));
        let (_, again) = settle(&tracker, None);
        assert!(again.errors.is_empty(), "the same drawing is not retried");

        let folder = Folder::new("limit");
        let too_large = " ".repeat(MAX_DOCUMENT_BYTES + 1);
        let error = write_file(&folder.0, "big.json", &too_large).unwrap_err();
        assert!(error.to_string().contains("25 MiB"));
        assert!(folder.files().is_empty());
        let exact = write_file(&folder.0, "ok.json", "{}").unwrap();
        assert_eq!(folder.files(), ["ok.json"]);
        assert_eq!(fs::read_to_string(exact).unwrap(), "{}");
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

    #[test]
    fn session_end_recovery_cancel_keeps_only_drawings_office_closed() {
        let folder = Folder::new("cancel");
        let tracker = tracker();
        settle(&tracker, Some(&folder.0));
        {
            let mut locked = tracker.lock().unwrap();
            assert!(locked.collect(4, "17", "{new}"));
            locked.closed("17");
        }
        let cancelled = cancel(&tracker, Some(&folder.0), true).unwrap();
        assert_eq!(cancelled.request, 4);
        assert!(cancelled.report.errors.is_empty());
        let kept = folder.0.join("20261120T224719Z-object-17-Report.docx.json");
        assert_eq!(cancelled.kept, std::slice::from_ref(&kept));
        assert_eq!(fs::read_to_string(&kept).unwrap(), "{new}");
        assert_eq!(cancelled.report.removed.len(), 1);
        assert_eq!(
            folder.files(),
            ["20261120T224719Z-object-17-Report.docx.json"]
        );
        assert!(cancel(&tracker, Some(&folder.0), true).is_none());
    }
}
