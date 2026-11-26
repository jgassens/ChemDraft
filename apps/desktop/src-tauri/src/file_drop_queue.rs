//! Files dropped on the document window, held until its page drains them.
//!
//! The main window is shown whether or not its page has loaded, and a drop is a window event Rust
//! sees at once. Sent straight to the page as an event, a drop that came before the page's listener
//! was lost. So each drop is queued here, whole, as `file_drop.rs` measured it, and the page is told
//! only that the queue changed ([`DOCUMENT_FILE_DROPS_CHANGED_EVENT`]). The page subscribes first,
//! then drains with [`take_pending_document_drops`], a destructive read: every drop is handed over
//! exactly once, in the order it arrived. This is the native open queue's pattern
//! (`PendingOpenDocument` in `lib.rs`, `nativeOpenQueue.ts`).
//!
//! The queue is bounded: [`MAX_PENDING_DROPS`] drops, [`MAX_PENDING_PATHS`] paths and
//! [`MAX_PENDING_PATH_BYTES`] bytes of path text in all. A drop that does not fit is refused whole,
//! never cut down, and counted; the next drain reports the count once. Destroying the document
//! window retires everything pending, so a later window never receives an earlier window's drops.
//!
//! Queuing does not affect file access: tauri-plugin-fs adds each dropped path to its app-wide scope
//! on the drop's `RunEvent::WindowEvent`, and that grant lasts for the run, so a drained path reads
//! as a live one would.

use crate::file_drop::DocumentFileDropPayload;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

/// Tells the document window that its drop queue changed. Carries nothing: the page drains.
pub(crate) const DOCUMENT_FILE_DROPS_CHANGED_EVENT: &str =
    "chemdraft://document-file-drops-changed";

/// Drops held at once.
pub(crate) const MAX_PENDING_DROPS: usize = 16;
/// Paths held at once, across every pending drop.
pub(crate) const MAX_PENDING_PATHS: usize = 256;
/// Bytes of path text held at once, across every pending drop.
pub(crate) const MAX_PENDING_PATH_BYTES: usize = 1024 * 1024;

/// What one destructive drain hands the page.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingDocumentDrops {
    /// Every queued drop, oldest first.
    pub drops: Vec<DocumentFileDropPayload>,
    /// Drops refused whole since the last drain because the queue was full.
    pub refused_drops: u32,
}

/// Whether a drop was queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DropAdmission {
    Queued,
    /// The queue had no room for the whole drop; it was counted and not kept.
    Refused,
    /// A drop with no paths: nothing to deliver.
    Empty,
    /// A path is not valid Unicode, so it cannot be sent to the page (serde refuses it). Queued, it
    /// would make the whole drain fail after the queue was emptied and lose every drop with it; so
    /// the drop is not kept, as one whose event could not be sent was lost before.
    NotUnicode,
}

#[derive(Debug, Default)]
struct Queue {
    drops: VecDeque<DocumentFileDropPayload>,
    paths: usize,
    path_bytes: usize,
    refused_drops: u32,
}

#[derive(Debug, Default)]
pub(crate) struct PendingDocumentDropQueue {
    queue: Mutex<Queue>,
}

/// Bytes of path text in a drop, as the operating system holds them.
fn path_bytes(payload: &DocumentFileDropPayload) -> usize {
    payload
        .paths
        .iter()
        .map(|path| path.as_os_str().as_encoded_bytes().len())
        .fold(0, usize::saturating_add)
}

impl PendingDocumentDropQueue {
    /// Queues a whole drop at the back, or refuses it whole when it would pass any limit.
    pub(crate) fn record(&self, payload: DocumentFileDropPayload) -> Result<DropAdmission, String> {
        if payload.paths.is_empty() {
            return Ok(DropAdmission::Empty);
        }
        if payload.paths.iter().any(|path| path.to_str().is_none()) {
            return Ok(DropAdmission::NotUnicode);
        }
        let mut queue = self.queue.lock().map_err(|error| error.to_string())?;
        let paths = queue.paths.saturating_add(payload.paths.len());
        let path_bytes = queue.path_bytes.saturating_add(path_bytes(&payload));
        if queue.drops.len() >= MAX_PENDING_DROPS
            || paths > MAX_PENDING_PATHS
            || path_bytes > MAX_PENDING_PATH_BYTES
        {
            queue.refused_drops = queue.refused_drops.saturating_add(1);
            return Ok(DropAdmission::Refused);
        }
        queue.paths = paths;
        queue.path_bytes = path_bytes;
        queue.drops.push_back(payload);
        Ok(DropAdmission::Queued)
    }

    /// Hands over every queued drop and the refused count, and leaves the queue empty.
    pub(crate) fn drain(&self) -> Result<PendingDocumentDrops, String> {
        let mut queue = self.queue.lock().map_err(|error| error.to_string())?;
        let taken = std::mem::take(&mut *queue);
        Ok(PendingDocumentDrops {
            drops: taken.drops.into(),
            refused_drops: taken.refused_drops,
        })
    }

    /// Forgets everything pending: the window the drops were for is gone.
    pub(crate) fn retire(&self) {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *queue = Queue::default();
    }
}

/// Queues a drop measured by `file_drop.rs` and tells the document window the queue changed, also
/// when the drop was refused, so the page reports the refusal.
pub(crate) fn record_document_drop<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    payload: DocumentFileDropPayload,
) {
    use tauri::{Emitter, Manager};

    let Some(queue) = window.try_state::<PendingDocumentDropQueue>() else {
        eprintln!("The document drop queue is missing; a file drop was not delivered.");
        return;
    };
    match queue.record(payload) {
        Ok(DropAdmission::Empty) => return,
        Ok(DropAdmission::NotUnicode) => {
            eprintln!("A file drop names a path that is not valid Unicode; it was not delivered.");
            return;
        }
        Ok(DropAdmission::Queued) => {}
        Ok(DropAdmission::Refused) => {
            eprintln!("Too many file drops are waiting for the document window; one was refused.");
        }
        Err(error) => {
            eprintln!("Could not queue a file drop for the document window: {error}");
            return;
        }
    }
    if let Err(error) = window.emit_to(window.label(), DOCUMENT_FILE_DROPS_CHANGED_EVENT, ()) {
        eprintln!("Could not tell the document window about a file drop: {error}");
    }
}

/// The document window's destructive drain. No other window may take its drops: the capability
/// grants this command to `main` alone, and the label is checked again here.
#[tauri::command]
pub(crate) fn take_pending_document_drops(
    window: tauri::WebviewWindow,
    queue: tauri::State<'_, PendingDocumentDropQueue>,
) -> Result<PendingDocumentDrops, String> {
    authorize_drain(window.label())?;
    queue.drain()
}

fn authorize_drain(label: &str) -> Result<(), String> {
    if crate::is_document_window(label) {
        Ok(())
    } else {
        Err("Only the document window can take file drops.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_drop::{DropPoint, DropPositionUnits};
    use std::path::PathBuf;

    fn drop_of(paths: &[&str]) -> DocumentFileDropPayload {
        DocumentFileDropPayload {
            paths: paths.iter().map(PathBuf::from).collect(),
            position: DropPoint { x: 1.0, y: 2.0 },
            units: DropPositionUnits::Css,
            top_inset_removed: 0.0,
            scale_factor: Some(2.0),
        }
    }

    fn names(drained: &PendingDocumentDrops) -> Vec<Vec<String>> {
        drained
            .drops
            .iter()
            .map(|drop| {
                drop.paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn drops_drain_whole_in_arrival_order_and_once() {
        let queue = PendingDocumentDropQueue::default();
        assert_eq!(
            queue.record(drop_of(&["/a.png", "/b.cdxml"])),
            Ok(DropAdmission::Queued)
        );
        assert_eq!(
            queue.record(drop_of(&["/c.png"])),
            Ok(DropAdmission::Queued)
        );
        let drained = queue.drain().unwrap();
        assert_eq!(
            names(&drained),
            vec![vec!["/a.png", "/b.cdxml"], vec!["/c.png"]]
        );
        assert_eq!(drained.refused_drops, 0);
        // A destructive read: a second drain finds nothing, so no drop is delivered twice.
        assert_eq!(queue.drain().unwrap(), PendingDocumentDrops::default());
        // A drop after the drain is the next drain's, and only the next drain's.
        assert_eq!(
            queue.record(drop_of(&["/d.png"])),
            Ok(DropAdmission::Queued)
        );
        assert_eq!(names(&queue.drain().unwrap()), vec![vec!["/d.png"]]);
        assert!(queue.drain().unwrap().drops.is_empty());
    }

    #[test]
    fn a_drop_keeps_its_measured_position_scale_and_units() {
        let queue = PendingDocumentDropQueue::default();
        let windows = DocumentFileDropPayload {
            paths: vec![PathBuf::from("C:\\Pictures\\mol.png")],
            position: DropPoint { x: 450.0, y: 300.0 },
            units: DropPositionUnits::Physical,
            top_inset_removed: 0.0,
            scale_factor: Some(1.5),
        };
        let mac = DocumentFileDropPayload {
            position: DropPoint { x: 40.0, y: 100.0 },
            units: DropPositionUnits::Css,
            top_inset_removed: 28.0,
            scale_factor: Some(2.0),
            ..drop_of(&["/Users/me/mol.png"])
        };
        queue.record(windows.clone()).unwrap();
        queue.record(mac.clone()).unwrap();
        assert_eq!(queue.drain().unwrap().drops, vec![windows, mac]);
    }

    #[test]
    fn the_seventeenth_drop_is_refused_whole_and_counted() {
        let queue = PendingDocumentDropQueue::default();
        for index in 0..MAX_PENDING_DROPS {
            assert_eq!(
                queue.record(drop_of(&[&format!("/{index}.png")])),
                Ok(DropAdmission::Queued)
            );
        }
        assert_eq!(
            queue.record(drop_of(&["/late-1.png"])),
            Ok(DropAdmission::Refused)
        );
        assert_eq!(
            queue.record(drop_of(&["/late-2.png", "/late-3.png"])),
            Ok(DropAdmission::Refused)
        );
        let drained = queue.drain().unwrap();
        assert_eq!(drained.drops.len(), MAX_PENDING_DROPS);
        assert_eq!(names(&drained)[0], vec!["/0.png"]);
        assert_eq!(names(&drained)[15], vec!["/15.png"]);
        assert_eq!(drained.refused_drops, 2);
        // Reported once: the next drain starts from zero, and the queue has room again.
        assert_eq!(queue.drain().unwrap().refused_drops, 0);
        assert_eq!(
            queue.record(drop_of(&["/again.png"])),
            Ok(DropAdmission::Queued)
        );
    }

    #[test]
    fn a_drop_passing_the_path_count_is_refused_whole_not_cut_down() {
        let queue = PendingDocumentDropQueue::default();
        let first: Vec<String> = (0..200).map(|index| format!("/a{index}.png")).collect();
        let first: Vec<&str> = first.iter().map(String::as_str).collect();
        assert_eq!(queue.record(drop_of(&first)), Ok(DropAdmission::Queued));
        // 200 + 57 = 257 paths: the whole second drop is refused, none of its paths kept.
        let second: Vec<String> = (0..57).map(|index| format!("/b{index}.png")).collect();
        let second: Vec<&str> = second.iter().map(String::as_str).collect();
        assert_eq!(queue.record(drop_of(&second)), Ok(DropAdmission::Refused));
        // Exactly at the limit still fits.
        let third: Vec<String> = (0..56).map(|index| format!("/c{index}.png")).collect();
        let third: Vec<&str> = third.iter().map(String::as_str).collect();
        assert_eq!(queue.record(drop_of(&third)), Ok(DropAdmission::Queued));
        let drained = queue.drain().unwrap();
        assert_eq!(
            drained
                .drops
                .iter()
                .map(|drop| drop.paths.len())
                .collect::<Vec<_>>(),
            vec![200, 56]
        );
        assert_eq!(drained.refused_drops, 1);
        // One drop larger than the whole limit is refused even into an empty queue.
        let huge: Vec<String> = (0..=MAX_PENDING_PATHS)
            .map(|index| format!("/h{index}.png"))
            .collect();
        let huge: Vec<&str> = huge.iter().map(String::as_str).collect();
        assert_eq!(queue.record(drop_of(&huge)), Ok(DropAdmission::Refused));
        assert_eq!(
            queue.drain().unwrap(),
            PendingDocumentDrops {
                drops: Vec::new(),
                refused_drops: 1
            }
        );
    }

    #[test]
    fn a_drop_passing_the_path_bytes_is_refused_whole() {
        let queue = PendingDocumentDropQueue::default();
        let long = format!("/{}", "x".repeat(MAX_PENDING_PATH_BYTES / 2 - 1));
        assert_eq!(path_bytes(&drop_of(&[&long])), MAX_PENDING_PATH_BYTES / 2);
        assert_eq!(queue.record(drop_of(&[&long])), Ok(DropAdmission::Queued));
        assert_eq!(queue.record(drop_of(&[&long])), Ok(DropAdmission::Queued));
        // Exactly 1 MiB is held; one more byte is refused, with the short path beside it.
        assert_eq!(
            queue.record(drop_of(&["/a.png", "/"])),
            Ok(DropAdmission::Refused)
        );
        let drained = queue.drain().unwrap();
        assert_eq!(drained.drops.len(), 2);
        assert_eq!(drained.refused_drops, 1);
        // The drain freed the bytes.
        assert_eq!(
            queue.record(drop_of(&["/a.png"])),
            Ok(DropAdmission::Queued)
        );
    }

    /// A path the operating system allows that is not valid Unicode.
    #[cfg(unix)]
    fn not_unicode_path() -> PathBuf {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(std::ffi::OsStr::from_bytes(b"/Pictures/bad\xff.png"))
    }

    /// A path the operating system allows that is not valid Unicode: an unpaired surrogate.
    #[cfg(windows)]
    fn not_unicode_path() -> PathBuf {
        use std::os::windows::ffi::OsStringExt;
        PathBuf::from(std::ffi::OsString::from_wide(&[
            0x43, 0x3a, 0x5c, 0xd800, 0x2e, 0x70, 0x6e, 0x67,
        ]))
    }

    #[test]
    fn a_drop_naming_a_path_that_is_not_unicode_cannot_spoil_the_drain() {
        let queue = PendingDocumentDropQueue::default();
        assert_eq!(
            queue.record(drop_of(&["/before.png"])),
            Ok(DropAdmission::Queued)
        );
        let mut bad = drop_of(&["/fine.png"]);
        bad.paths.push(not_unicode_path());
        assert_eq!(queue.record(bad), Ok(DropAdmission::NotUnicode));
        assert_eq!(
            queue.record(drop_of(&["/after.png"])),
            Ok(DropAdmission::Queued)
        );
        // The drain still serializes, so the drops beside it reach the page.
        let drained = queue.drain().unwrap();
        assert_eq!(drained.refused_drops, 0);
        assert!(serde_json::to_value(&drained).is_ok());
        assert_eq!(
            names(&drained),
            vec![vec!["/before.png"], vec!["/after.png"]]
        );
    }

    #[test]
    fn an_empty_drop_is_neither_queued_nor_refused() {
        let queue = PendingDocumentDropQueue::default();
        assert_eq!(queue.record(drop_of(&[])), Ok(DropAdmission::Empty));
        assert_eq!(queue.drain().unwrap(), PendingDocumentDrops::default());
    }

    #[test]
    fn retiring_forgets_pending_drops_and_the_refused_count() {
        let queue = PendingDocumentDropQueue::default();
        for index in 0..=MAX_PENDING_DROPS {
            queue.record(drop_of(&[&format!("/{index}.png")])).unwrap();
        }
        queue.retire();
        assert_eq!(queue.drain().unwrap(), PendingDocumentDrops::default());
        // Every limit starts again from nothing.
        for index in 0..MAX_PENDING_DROPS {
            assert_eq!(
                queue.record(drop_of(&[&format!("/{index}.png")])),
                Ok(DropAdmission::Queued)
            );
        }
    }

    #[test]
    fn concurrent_drops_and_drains_deliver_every_drop_exactly_once() {
        let queue = std::sync::Arc::new(PendingDocumentDropQueue::default());
        let producers: Vec<_> = (0..4)
            .map(|producer| {
                let queue = queue.clone();
                std::thread::spawn(move || {
                    for index in 0..4 {
                        let path = format!("/{producer}-{index}.png");
                        assert_eq!(queue.record(drop_of(&[&path])), Ok(DropAdmission::Queued));
                    }
                })
            })
            .collect();
        let mut seen = Vec::new();
        while producers.iter().any(|producer| !producer.is_finished()) {
            seen.extend(names(&queue.drain().unwrap()).into_iter().flatten());
        }
        for producer in producers {
            producer.join().unwrap();
        }
        seen.extend(names(&queue.drain().unwrap()).into_iter().flatten());
        let mut expected: Vec<String> = (0..4)
            .flat_map(|producer| (0..4).map(move |index| format!("/{producer}-{index}.png")))
            .collect();
        seen.sort();
        expected.sort();
        assert_eq!(seen, expected);
    }

    #[test]
    fn the_drain_serializes_drops_and_the_refused_count() {
        let queue = PendingDocumentDropQueue::default();
        queue.record(drop_of(&["/Users/me/mol.png"])).unwrap();
        let json = serde_json::to_value(queue.drain().unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "drops": [{
                    "paths": ["/Users/me/mol.png"], "position": { "x": 1.0, "y": 2.0 },
                    "units": "css", "topInsetRemoved": 0.0, "scaleFactor": 2.0
                }],
                "refusedDrops": 0
            })
        );
    }

    #[test]
    fn only_the_document_window_may_drain() {
        assert!(authorize_drain("main").is_ok());
        for label in [
            "toolset-core-main",
            "toolset-popover-core-bonds",
            "preferences",
            "spin3d-debugger",
            "dialog-main-export-1",
            "plugin-panel-x",
            "file-warnings",
        ] {
            assert!(authorize_drain(label).is_err(), "{label} may drain drops");
        }
        // The capability names the document window alone, and no other capability grants it.
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/document-file-drops.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-take-pending-document-drops"])
        );
        assert!(capability.get("platforms").is_none());
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut granted = Vec::new();
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if std::fs::read_to_string(&path)
                .unwrap()
                .contains("allow-take-pending-document-drops")
            {
                granted.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
        assert_eq!(granted, vec!["document-file-drops.json"]);
        let permission = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("permissions/autogenerated/take_pending_document_drops.toml");
        assert!(permission.exists(), "build.rs must generate the permission");
    }

    /// Source text with every run of whitespace made one space, so the checks read the same on
    /// every host and checkout.
    fn squashed(source: &str) -> String {
        source.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn the_app_manages_one_queue_registers_the_drain_and_retires_it_with_the_window() {
        let lib = squashed(include_str!("lib.rs"));
        assert_eq!(
            lib.matches(".manage(file_drop_queue::PendingDocumentDropQueue::default())")
                .count(),
            1
        );
        assert_eq!(
            lib.matches("file_drop_queue::take_pending_document_drops,")
                .count(),
            1
        );
        let build = include_str!("../build.rs");
        assert!(build.contains("\"take_pending_document_drops\","));
        // The document window's own Destroyed arm, in the Builder's window-event handler, retires
        // the queue.
        let destroyed = lib
            .split(".on_window_event(|window, event| {")
            .nth(1)
            .unwrap()
            .split("if window.label() == MAIN_WINDOW_LABEL {")
            .nth(1)
            .unwrap()
            .split("WindowEvent::Destroyed => {")
            .nth(1)
            .unwrap()
            .split("WindowEvent::DragDrop(")
            .next()
            .unwrap()
            .replace(' ', "");
        assert!(destroyed
            .contains("window.state::<file_drop_queue::PendingDocumentDropQueue>().retire();"));
        // The page listens for this very notice and invokes this very command.
        let page = include_str!("../../src/imageDrop/pendingDrops.ts");
        assert!(page.contains(&format!(
            "export const DOCUMENT_FILE_DROPS_CHANGED_EVENT = \"{DOCUMENT_FILE_DROPS_CHANGED_EVENT}\";"
        )));
        assert!(page.contains("invoke(\"take_pending_document_drops\")"));
        // The page drains; no drop travels as an event of its own any more.
        assert!(!lib.contains("DOCUMENT_FILE_DROP_EVENT"));
        assert!(!include_str!("file_drop.rs").contains("DOCUMENT_FILE_DROP_EVENT"));
    }
}
