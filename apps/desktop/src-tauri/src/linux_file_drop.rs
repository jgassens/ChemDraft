//! Linux: a file dropped from the file manager soon after the pointer stopped was lost, silently.
//!
//! An XDND source drops only on a target that has accepted the drag. Nothing in wry, tao or Tauri
//! accepts; WebKitGTK does, but only after it has the file list and the page has answered
//! `dragover`. A release before that makes the source cancel: GTK sends only `drag-leave`, which wry
//! ignores while it has no file list (wry 0.55.1 `webkitgtk/drag_drop.rs`). On the Fedora KDE VM a
//! drop was lost unless the pointer was held still for 1.5-2 s.
//!
//! So this accepts (`gdk_drag_status(COPY)`) as soon as wry holds the file list: our
//! `drag-data-received` handler runs right after wry's, which has stored the paths, so the drop it
//! allows reaches wry's `drag-drop` handler with them. Later positions are answered the same way.
//! When a file drag still ends over the page without a drop, the page shows a status line
//! ([`DOCUMENT_FILE_DROP_MISSED_EVENT`]) and one line goes to stderr.

use std::time::{Duration, Instant};

/// Sent to the document window when a file drag ended over it without a drop.
pub(crate) const DOCUMENT_FILE_DROP_MISSED_EVENT: &str = "chemdraft://document-file-drop-missed";

/// Pointer events do not reach the page during a drag, so ordinary pointer input this soon after a
/// file drag left the page means the drag ended here.
const RETURN_WINDOW: Duration = Duration::from_millis(400);

/// Files from another program: a URI list, and no source widget in this process.
fn is_external_file_drag<S: AsRef<str>>(
    in_process: bool,
    targets: impl IntoIterator<Item = S>,
) -> bool {
    !in_process
        && targets
            .into_iter()
            .any(|target| target.as_ref() == "text/uri-list")
}

/// The file drag over the page; `D` identifies a drag (its `gdk::DragContext` on Linux).
struct DropWatch<D> {
    /// The file drag over the page now, and whether it has been accepted.
    over: Option<(D, bool)>,
    /// When a file drag last left the page without being dropped.
    left: Option<Instant>,
}

impl<D> Default for DropWatch<D> {
    fn default() -> Self {
        Self {
            over: None,
            left: None,
        }
    }
}

impl<D: PartialEq> DropWatch<D> {
    /// A position for `drag`; true when it is already accepted (answer this position too).
    fn position(&mut self, drag: D) -> bool {
        match &self.over {
            Some((current, accepted)) if *current == drag => *accepted,
            _ => {
                self.over = Some((drag, false));
                self.left = None;
                false
            }
        }
    }

    /// wry now holds `drag`'s file list; true when that drag is still over the page (accept it).
    fn file_list(&mut self, drag: &D) -> bool {
        match &mut self.over {
            Some((current, accepted)) if current == drag => {
                *accepted = true;
                true
            }
            _ => false,
        }
    }

    /// `for_drop`: GTK sends `drag-leave` just ahead of `drag-drop`; that leave is not a miss.
    fn leave(&mut self, drag: &D, for_drop: bool, now: Instant) {
        if matches!(&self.over, Some((current, _)) if current == drag) {
            self.over = None;
            self.left = (!for_drop).then_some(now);
        }
    }

    /// Ordinary pointer input is back on the page; true (once) when a file drag left it a moment
    /// ago, which only happens when the drag ended here without a drop.
    fn pointer_returned(&mut self, now: Instant) -> bool {
        self.left
            .take()
            .is_some_and(|left| now.saturating_duration_since(left) <= RETURN_WINDOW)
    }
}

#[cfg(target_os = "linux")]
pub(super) fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("linux-file-drop")
        .on_webview_ready(|webview| {
            if crate::is_document_window(webview.label()) {
                install(webview);
            }
        })
        .build()
}

#[cfg(target_os = "linux")]
fn install<R: tauri::Runtime>(webview: tauri::Webview<R>) {
    use gtk::{gdk, glib, prelude::*};
    use std::{cell::RefCell, rc::Rc};
    use tauri::Emitter;

    /// wry's `info` for `text/uri-list` (wry 0.55.1 `drag_drop.rs:79`).
    const WRY_URI_LIST_INFO: u32 = 2;
    fn carries_files(context: &gdk::DragContext) -> bool {
        let targets = context.list_targets();
        is_external_file_drag(
            context.drag_get_source_widget().is_some(),
            targets.iter().map(|target| target.name()),
        )
    }

    let document = webview.clone();
    if let Err(error) = webview.with_webview(move |platform| {
        let view = platform.inner();
        let watch = Rc::new(RefCell::new(DropWatch::<gdk::DragContext>::default()));
        let missed = Rc::new(move |why: &str| {
            eprintln!("ChemDraft: a dragged file was not dropped on the document window ({why})");
            if let Err(error) =
                document.emit_to(document.label(), DOCUMENT_FILE_DROP_MISSED_EVENT, ())
            {
                eprintln!("ChemDraft: could not report a missed file drop: {error}");
            }
        });

        // Connected after wry's handlers (attached when the view was built) and ahead of
        // WebKitGTK's own class handlers, which run last.
        view.connect_drag_motion({
            let watch = watch.clone();
            move |_, context, _, _, time| {
                if carries_files(context) && watch.borrow_mut().position(context.clone()) {
                    context.drag_status(gdk::DragAction::COPY, time);
                }
                false
            }
        });
        view.connect_drag_data_received({
            let watch = watch.clone();
            move |_, context, _, _, data, info, time| {
                // wry stored these paths one handler ago, so the drop this allows finds them.
                if info == WRY_URI_LIST_INFO
                    && !data.uris().is_empty()
                    && carries_files(context)
                    && watch.borrow_mut().file_list(context)
                {
                    context.drag_status(gdk::DragAction::COPY, time);
                }
            }
        });
        view.connect_drag_leave({
            let watch = watch.clone();
            move |_, context, _| {
                let for_drop = gtk::current_event()
                    .is_some_and(|event| event.event_type() == gdk::EventType::DropStart);
                watch.borrow_mut().leave(context, for_drop, Instant::now());
            }
        });
        // Runs only when wry declined the drop (it returns true when it takes one): no file list.
        view.connect_drag_drop({
            let missed = missed.clone();
            move |_, context, _, _, _| {
                if carries_files(context) {
                    missed("the drop arrived before its file list");
                }
                false
            }
        });
        let returned = Rc::new(move || {
            if watch.borrow_mut().pointer_returned(Instant::now()) {
                missed("the drag ended before ChemDraft had accepted it");
            }
        });
        view.connect_enter_notify_event({
            let returned = returned.clone();
            move |_, _| {
                returned();
                glib::Propagation::Proceed
            }
        });
        view.connect_motion_notify_event(move |_, _| {
            returned();
            glib::Propagation::Proceed
        });
    }) {
        eprintln!("ChemDraft: could not watch file drags on the document window: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{is_external_file_drag, DropWatch, DOCUMENT_FILE_DROP_MISSED_EVENT, RETURN_WINDOW};
    use std::time::{Duration, Instant};

    #[test]
    fn a_fast_drop_is_accepted_as_soon_as_the_file_list_is_here() {
        let mut watch = DropWatch::default();
        assert!(!watch.position(1), "no answer before the file list");
        assert!(
            watch.file_list(&1),
            "accepted the moment wry holds the files, not after the page"
        );
        assert!(watch.position(1), "every later position is answered");
        // The release right after: GTK's leave for the drop is not a miss.
        let now = Instant::now();
        watch.leave(&1, true, now);
        assert!(!watch.pointer_returned(now + Duration::from_millis(10)));
    }

    #[test]
    fn a_drag_is_accepted_only_while_it_is_over_the_page() {
        let mut watch = DropWatch::default();
        watch.position(1);
        watch.leave(&1, false, Instant::now());
        assert!(
            !watch.file_list(&1),
            "a file list that arrives after the drag left is not answered"
        );
        assert!(!watch.position(2), "the next drag starts unaccepted");
        assert!(
            !watch.file_list(&1),
            "nor is the previous drag's late file list"
        );
        assert!(watch.file_list(&2));
    }

    #[test]
    fn a_drag_that_ends_over_the_page_without_a_drop_is_noticed_once() {
        let start = Instant::now();
        let mut watch = DropWatch::default();
        watch.position(1);
        watch.leave(&1, false, start);
        assert!(watch.pointer_returned(start + Duration::from_millis(30)));
        assert!(
            !watch.pointer_returned(start + Duration::from_millis(40)),
            "said once"
        );
        // The drag went elsewhere and the pointer came back later.
        watch.position(3);
        watch.leave(&3, false, start);
        assert!(!watch.pointer_returned(start + RETURN_WINDOW + Duration::from_millis(1)));
        // The drag left and came back: nothing is pending while it is over the page again.
        watch.position(4);
        watch.leave(&4, false, start);
        watch.position(5);
        assert!(!watch.pointer_returned(start + Duration::from_millis(30)));
        // Another drag's leave is ignored.
        watch.leave(&4, false, start);
        assert!(!watch.pointer_returned(start + Duration::from_millis(30)));
    }

    #[test]
    fn only_file_drags_from_another_program_are_watched() {
        assert!(is_external_file_drag(
            false,
            ["text/plain", "text/uri-list"]
        ));
        assert!(
            !is_external_file_drag(true, ["text/uri-list"]),
            "a drag inside ChemDraft"
        );
        assert!(!is_external_file_drag(false, ["text/plain", "text/html"]));
        assert!(!is_external_file_drag::<&str>(false, []));
    }

    #[test]
    fn the_page_listens_for_the_same_event_name() {
        let page = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/imageDrop/dropPosition.ts"
        ));
        assert!(page.contains(&format!("= \"{DOCUMENT_FILE_DROP_MISSED_EVENT}\";")));
    }

    /// The module mirrors wry 0.55.1's drag handling (file-list info 2, paths stored before later
    /// handlers run, a taken drop returns true). Re-check `linux_file_drop.rs` when wry changes.
    #[test]
    fn wry_is_the_version_this_module_mirrors() {
        let lock: Vec<&str> = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"))
            .lines()
            .collect();
        assert!(lock
            .windows(2)
            .any(|pair| pair == ["name = \"wry\"", "version = \"0.55.1\""]));
    }
}
