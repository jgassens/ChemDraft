//! Linux only: make the native Open and Save choosers transient for the window that asked.
//!
//! tauri-plugin-dialog 2.7.1 gives `open` the calling window as its parent only on Windows and macOS
//! (`#[cfg(any(windows, target_os = "macos"))]`). It gives `save` one on every desktop, but rfd
//! 0.16's GTK backend ignores it: it builds every chooser with
//! `gtk_file_chooser_native_new(title, NULL, …)`.
//! Without WM_TRANSIENT_FOR the window manager does not keep the chooser above the document, so one
//! click on the document window buried it and the Open or Save looked as if nothing had happened.
//!
//! Neither dependency can be given a parent from outside, so `ParentedFileDialogs` wraps the
//! dialog plugin as registered: when an `open` or `save` request arrives it starts a short poll on
//! GTK's main thread, then hands the request on unchanged. Outside a sandbox GTK shows a
//! `GtkFileChooserNative` as an in-process `GtkFileChooserDialog`; the poll finds it once it is
//! shown (`gtk_native_dialog_run` dispatches timeouts in its nested loop) and makes it transient for
//! the window that asked, or for the document window when that one is hidden (palettes are hidden
//! while a file panel is up). macOS and Windows never compile the wrapper.
//!
//! Nothing GTK shows ties a chooser to the request that opened it: titles repeat, and two windows
//! can ask at overlapping times. So only one request may be parented at a time, app-wide
//! ([`ChooserSlot`]), and its poll considers only choosers created after it started. A request
//! from any window while another is in flight opens nothing and is refused with
//! [`ALREADY_OPEN`], which the frontend reports as it reports a second dialog in one window.

use std::sync::atomic::{AtomicBool, Ordering};

/// The rejection a refused request gets. The frontend matches it exactly: it is
/// `FILE_DIALOG_ALREADY_OPEN_STATUS` in `apps/desktop/src/fileDialogGuard.ts`.
const ALREADY_OPEN: &str = "A file dialog is already open";

/// Whether a dialog-plugin command opens a file chooser (`message`, `ask` and `confirm` do not).
fn opens_chooser(command: &str) -> bool {
    matches!(command, "open" | "save")
}

/// Whether GTK shows its file choosers through the desktop portal, out of process, where the poll
/// can never find them (GTK 3's `gdk_should_use_portal`: inside Flatpak, or `GTK_USE_PORTAL=1`).
/// Such requests are neither polled nor held: no in-process chooser exists to parent wrongly, and
/// holding them would refuse every other request for the whole wait.
fn gtk_uses_portal(in_flatpak: bool, gtk_use_portal: Option<&str>) -> bool {
    in_flatpak || gtk_use_portal.is_some_and(|value| value.starts_with('1'))
}

/// The one chooser request that may be parented at a time, app-wide.
struct ChooserSlot {
    busy: AtomicBool,
}

impl ChooserSlot {
    const fn new() -> Self {
        Self {
            busy: AtomicBool::new(false),
        }
    }

    /// Take the slot, or `None` while another request holds it. The slot is free again when the
    /// claim is dropped, however its poll ends (chooser closed, poll gave up, poll never started).
    fn claim(&self) -> Option<ChooserClaim<'_>> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| ChooserClaim { slot: self })
    }
}

/// Holds [`ChooserSlot`] until dropped.
struct ChooserClaim<'a> {
    slot: &'a ChooserSlot,
}

impl Drop for ChooserClaim<'_> {
    fn drop(&mut self) {
        self.slot.busy.store(false, Ordering::Release);
    }
}

/// What the poll sees of one file chooser toplevel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChooserView {
    /// Created after this request's poll started; anything older belongs to an earlier request.
    new: bool,
    has_parent: bool,
    visible: bool,
}

/// Which chooser is this request's: the only parentless chooser created since the request, once it
/// is shown. With none, or with several (one may be an earlier request's that appeared late), wait
/// rather than guess. A chooser that is not shown yet is not parented:
/// `GtkFileChooserNative` resets the transient parent when it shows the dialog.
fn pick_chooser(choosers: &[ChooserView]) -> Option<usize> {
    let mut candidates = choosers
        .iter()
        .enumerate()
        .filter(|(_, chooser)| chooser.new && !chooser.has_parent);
    match (candidates.next(), candidates.next()) {
        (Some((index, chooser)), None) if chooser.visible => Some(index),
        _ => None,
    }
}

/// How long the poll looks for its chooser. A request can wait for a free async worker on a slow
/// machine before rfd builds the chooser, so this is generous. It is also how long a request that
/// fails before showing a chooser keeps [`ChooserSlot`]: the wrapper cannot see the reply.
const CHOOSER_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// What one poll does.
#[derive(Debug, PartialEq, Eq)]
enum PollStep {
    /// Make the chooser transient for the owner, then watch it until it closes.
    Parent,
    Wait,
    /// Stop without parenting: the time is up.
    GiveUp,
}

/// Parent as soon as both the chooser and a visible owner exist; otherwise wait up to
/// [`CHOOSER_WAIT`]. Bounded by time, not by callbacks, which a busy main loop delivers late.
fn poll_step(found: bool, owner: bool, elapsed: std::time::Duration) -> PollStep {
    if found && owner {
        PollStep::Parent
    } else if elapsed < CHOOSER_WAIT {
        PollStep::Wait
    } else {
        PollStep::GiveUp
    }
}

#[cfg(target_os = "linux")]
pub(super) use linux::ParentedFileDialogs;

#[cfg(target_os = "linux")]
mod linux {
    use super::{
        gtk_uses_portal, opens_chooser, pick_chooser, poll_step, ChooserClaim, ChooserSlot,
        ChooserView, PollStep, ALREADY_OPEN,
    };
    use tauri::{
        ipc::Invoke, plugin::Plugin, webview::PageLoadPayload, AppHandle, Manager, RunEvent,
        Runtime, Webview, Window,
    };

    /// How often the poll looks for the chooser and its owner.
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

    /// Held from an `open` or `save` request until its chooser closes, or its poll gives up.
    static CHOOSER_SLOT: ChooserSlot = ChooserSlot::new();

    /// The dialog plugin as registered, with every file chooser it opens made transient for the
    /// window that asked. Everything else is passed through untouched, the request included.
    pub(crate) struct ParentedFileDialogs<P> {
        pub(crate) inner: P,
    }

    impl<R: Runtime, P: Plugin<R>> Plugin<R> for ParentedFileDialogs<P> {
        fn name(&self) -> &'static str {
            self.inner.name()
        }

        fn initialize(
            &mut self,
            app: &AppHandle<R>,
            config: serde_json::Value,
        ) -> Result<(), Box<dyn std::error::Error>> {
            self.inner.initialize(app, config)
        }

        fn initialization_script(&self) -> Option<String> {
            self.inner.initialization_script()
        }

        // `initialization_script_2` keeps its default, which reads `initialization_script` above:
        // tauri does not export its return type. `AppImageDialogs`, the plugin this wraps, keeps
        // the default as well, so its script is registered exactly as before.

        fn window_created(&mut self, window: Window<R>) {
            self.inner.window_created(window)
        }

        fn webview_created(&mut self, webview: Webview<R>) {
            self.inner.webview_created(webview)
        }

        fn on_navigation(&mut self, webview: &Webview<R>, url: &tauri::Url) -> bool {
            self.inner.on_navigation(webview, url)
        }

        fn on_page_load(&mut self, webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
            self.inner.on_page_load(webview, payload)
        }

        fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
            self.inner.on_event(app, event)
        }

        fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
            let portal = || {
                gtk_uses_portal(
                    std::path::Path::new("/.flatpak-info").exists(),
                    std::env::var("GTK_USE_PORTAL").ok().as_deref(),
                )
            };
            if opens_chooser(invoke.message.command()) && !portal() {
                let Some(claim) = CHOOSER_SLOT.claim() else {
                    // Another window's chooser is in flight: parenting both could swap them.
                    invoke.resolver.reject(ALREADY_OPEN);
                    return true;
                };
                parent_file_chooser(invoke.message.webview_ref().window(), claim);
            }
            self.inner.extend_api(invoke)
        }
    }

    /// Poll GTK's main thread for this request's chooser and make it transient for `caller`, or
    /// for the document window while `caller` is hidden; then watch it, and drop `claim` once it
    /// closes. Started before the request is handed on, so the choosers it sees first are all
    /// earlier requests'; the IPC handler already runs on the main thread, where
    /// `run_on_main_thread` runs at once. Whichever way the poll ends, or if it never starts,
    /// its closure is dropped and `claim` with it.
    fn parent_file_chooser<R: Runtime>(caller: Window<R>, claim: ChooserClaim<'static>) {
        let app = caller.app_handle().clone();
        let _ = caller.clone().run_on_main_thread(move || {
            use gtk::prelude::{Cast, GtkWindowExt, ObjectExt, WidgetExt};

            let choosers = || {
                gtk::Window::list_toplevels()
                    .into_iter()
                    .filter_map(|widget| widget.downcast::<gtk::FileChooserDialog>().ok())
                    .collect::<Vec<gtk::FileChooserDialog>>()
            };
            // Weak, so a finalized earlier chooser never matches a new one at its address.
            let earlier: Vec<gtk::glib::WeakRef<gtk::FileChooserDialog>> = choosers()
                .iter()
                .map(|chooser| chooser.downgrade())
                .collect();
            let owner = move || {
                caller
                    .gtk_window()
                    .ok()
                    .filter(|window| window.is_visible())
                    .or_else(|| {
                        app.get_webview_window(crate::MAIN_WINDOW_LABEL)
                            .and_then(|main| main.gtk_window().ok())
                            .filter(|main| main.is_visible())
                    })
            };
            let started = std::time::Instant::now();
            let mut parented: Option<gtk::glib::WeakRef<gtk::FileChooserDialog>> = None;
            let _ = gtk::glib::timeout_add_local(POLL_INTERVAL, move || {
                // Moved in so that it is dropped with this closure, when the poll ends.
                let _claim = &claim;
                if let Some(chooser) = &parented {
                    let open = chooser
                        .upgrade()
                        .is_some_and(|chooser| chooser.is_visible());
                    return if open {
                        gtk::glib::ControlFlow::Continue
                    } else {
                        gtk::glib::ControlFlow::Break
                    };
                }
                let choosers = choosers();
                let views: Vec<ChooserView> = choosers
                    .iter()
                    .map(|chooser| ChooserView {
                        new: !earlier
                            .iter()
                            .any(|old| old.upgrade().as_ref() == Some(chooser)),
                        has_parent: chooser.transient_for().is_some(),
                        visible: chooser.is_visible(),
                    })
                    .collect();
                let ours = pick_chooser(&views).map(|index| &choosers[index]);
                let parent = owner();
                match poll_step(ours.is_some(), parent.is_some(), started.elapsed()) {
                    PollStep::Parent => {
                        if let (Some(chooser), Some(parent)) = (ours, parent) {
                            chooser.set_transient_for(Some(parent.upcast_ref::<gtk::Window>()));
                            parented = Some(chooser.downgrade());
                        }
                        gtk::glib::ControlFlow::Continue
                    }
                    PollStep::Wait => gtk::glib::ControlFlow::Continue,
                    PollStep::GiveUp => gtk::glib::ControlFlow::Break,
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_open_and_save_open_a_chooser() {
        assert!(opens_chooser("open"));
        assert!(opens_chooser("save"));
        for command in ["message", "ask", "confirm", "", "Open", "save_file"] {
            assert!(!opens_chooser(command), "{command}");
        }
    }

    #[test]
    fn the_refusal_is_the_status_the_frontend_reports() {
        let guard = include_str!("../../src/fileDialogGuard.ts");
        assert!(guard.contains(&format!(
            "export const FILE_DIALOG_ALREADY_OPEN_STATUS = \"{ALREADY_OPEN}\";"
        )));
    }

    #[test]
    fn portal_choosers_are_neither_polled_nor_held() {
        assert!(gtk_uses_portal(true, None));
        assert!(gtk_uses_portal(false, Some("1")));
        assert!(!gtk_uses_portal(false, None));
        assert!(!gtk_uses_portal(false, Some("0")));
        assert!(!gtk_uses_portal(false, Some("")));
    }

    #[test]
    fn a_second_request_is_refused_while_one_is_in_flight() {
        let slot = ChooserSlot::new();
        let first = slot.claim();
        assert!(first.is_some());
        // Window B asks while window A's chooser is in flight: refused, whichever window asks.
        assert!(slot.claim().is_none());
        assert!(slot.claim().is_none());
        drop(first);
        // A's chooser closed, or its poll gave up: the next request goes through.
        let second = slot.claim();
        assert!(second.is_some());
        assert!(slot.claim().is_none());
    }

    #[test]
    fn the_slot_is_released_however_the_poll_ends() {
        let slot = ChooserSlot::new();
        // A poll that never started: its closure, and the claim in it, is dropped unrun.
        let never_run = {
            let claim = slot.claim().expect("free");
            move || drop(claim)
        };
        assert!(slot.claim().is_none());
        drop(never_run);
        assert!(slot.claim().is_some());
        // A poll that panics on the way out still drops its claim.
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _claim = slot.claim().expect("free");
            panic!("poll failed");
        }));
        assert!(panicked.is_err());
        assert!(slot.claim().is_some());
    }

    #[test]
    fn the_slot_admits_one_request_across_threads() {
        static SLOT: ChooserSlot = ChooserSlot::new();
        let barrier = std::sync::Barrier::new(8);
        let granted = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    barrier.wait();
                    if let Some(claim) = SLOT.claim() {
                        granted.fetch_add(1, Ordering::SeqCst);
                        // Hold it until every thread has tried.
                        barrier.wait();
                        drop(claim);
                    } else {
                        barrier.wait();
                    }
                });
            }
        });
        assert_eq!(granted.load(Ordering::SeqCst), 1);
        assert!(SLOT.claim().is_some());
    }

    fn view(new: bool, has_parent: bool, visible: bool) -> ChooserView {
        ChooserView {
            new,
            has_parent,
            visible,
        }
    }

    #[test]
    fn the_only_new_shown_parentless_chooser_is_parented() {
        let choosers = [
            // An earlier request's, parented to its own window.
            view(false, true, true),
            // An earlier request's that was never parented: not this request's.
            view(false, false, true),
            view(true, false, true),
        ];
        assert_eq!(pick_chooser(&choosers), Some(2));
    }

    #[test]
    fn another_request_s_chooser_is_never_taken() {
        // Window A's chooser, shown before this request and never parented (A's owner was hidden
        // until its poll gave up), is the only parentless one: the old rule parented it to B.
        assert_eq!(pick_chooser(&[view(false, false, true)]), None);
        // This request's chooser appeared beside it.
        assert_eq!(
            pick_chooser(&[view(false, false, true), view(true, false, true)]),
            Some(1)
        );
    }

    #[test]
    fn nothing_is_parented_when_unsure_or_nothing_is_shown() {
        assert_eq!(pick_chooser(&[]), None);
        // Not shown yet: GtkFileChooserNative would reset the parent when it shows it.
        assert_eq!(pick_chooser(&[view(true, false, false)]), None);
        // Already parented (a later poll of this one).
        assert_eq!(pick_chooser(&[view(true, true, true)]), None);
        // Two new parentless choosers, whatever their titles: do not guess.
        let two = [view(true, false, true), view(true, false, true)];
        assert_eq!(pick_chooser(&two), None);
        // Nor when the other one is not shown yet.
        let one_hidden = [view(true, false, true), view(true, false, false)];
        assert_eq!(pick_chooser(&one_hidden), None);
    }

    #[test]
    fn the_poll_parents_once_both_exist_and_gives_up_after_the_wait() {
        let ms = std::time::Duration::from_millis;
        assert_eq!(poll_step(false, true, ms(25)), PollStep::Wait);
        assert_eq!(poll_step(true, false, ms(25)), PollStep::Wait);
        assert_eq!(poll_step(true, true, ms(25)), PollStep::Parent);
        // A slow machine: the chooser appears long after the request.
        assert_eq!(
            poll_step(true, true, CHOOSER_WAIT - ms(1)),
            PollStep::Parent
        );
        assert_eq!(poll_step(false, true, CHOOSER_WAIT), PollStep::GiveUp);
        assert_eq!(poll_step(true, false, CHOOSER_WAIT), PollStep::GiveUp);
        // Found with an owner is parented even at the limit.
        assert_eq!(poll_step(true, true, CHOOSER_WAIT), PollStep::Parent);
    }
}
