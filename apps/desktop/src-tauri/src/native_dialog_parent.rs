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

/// rfd's title for a chooser the request did not title: "Open File", "Select Folder", "Save File".
const OPEN_FILE_TITLE: &str = "Open File";
const SELECT_FOLDER_TITLE: &str = "Select Folder";
const SAVE_FILE_TITLE: &str = "Save File";

/// The title GTK will show on the chooser for one dialog-plugin request, or `None` when the
/// command does not open a chooser. `args` is the request's JSON body (`{ "options": { … } }`).
fn expected_chooser_title(command: &str, args: &serde_json::Value) -> Option<String> {
    let options = args.get("options");
    let title = options
        .and_then(|options| options.get("title"))
        .and_then(serde_json::Value::as_str);
    let directory = options
        .and_then(|options| options.get("directory"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let untitled = match command {
        "open" if directory => SELECT_FOLDER_TITLE,
        "open" => OPEN_FILE_TITLE,
        "save" => SAVE_FILE_TITLE,
        _ => return None,
    };
    Some(title.unwrap_or(untitled).to_owned())
}

/// What the poll sees of one file chooser toplevel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChooserView<'a> {
    title: Option<&'a str>,
    has_parent: bool,
    visible: bool,
}

/// Which chooser to parent: a shown, still parentless one titled as this request's; failing that,
/// the only shown parentless chooser (in case GTK titles it differently). With several parentless
/// choosers and none titled as this request's, wait rather than guess. A chooser that is not shown
/// yet is skipped: `GtkFileChooserNative` resets the transient parent when it shows the dialog.
fn pick_chooser(choosers: &[ChooserView<'_>], expected_title: &str) -> Option<usize> {
    let open: Vec<usize> = choosers
        .iter()
        .enumerate()
        .filter(|(_, chooser)| chooser.visible && !chooser.has_parent)
        .map(|(index, _)| index)
        .collect();
    open.iter()
        .copied()
        .find(|&index| choosers[index].title == Some(expected_title))
        .or(match open.as_slice() {
            [only] => Some(*only),
            _ => None,
        })
}

/// How long the poll looks for its chooser. A request can wait for a free async worker on a slow
/// machine before rfd builds the chooser, so this is generous; a portal chooser (sandboxed GTK,
/// GTK_USE_PORTAL) is out of process and never found, and the poll simply ends.
const CHOOSER_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// What one poll does.
#[derive(Debug, PartialEq, Eq)]
enum PollStep {
    /// Make the chooser transient for the owner, and stop.
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
    use super::{expected_chooser_title, pick_chooser, poll_step, ChooserView, PollStep};
    use tauri::{
        ipc::{Invoke, InvokeBody},
        plugin::Plugin,
        webview::PageLoadPayload,
        AppHandle, Manager, RunEvent, Runtime, Webview, Window,
    };

    /// How often the poll looks for the chooser and its owner.
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

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
            if let InvokeBody::Json(args) = invoke.message.payload() {
                if let Some(title) = expected_chooser_title(invoke.message.command(), args) {
                    parent_file_chooser(invoke.message.webview_ref().window(), title);
                }
            }
            self.inner.extend_api(invoke)
        }
    }

    /// Poll GTK's main thread for this request's chooser and make it transient for `caller`, or
    /// for the document window while `caller` is hidden. Started before the request is handed on,
    /// so it is in place before rfd builds the chooser; the IPC handler already runs on the main
    /// thread, where `run_on_main_thread` runs at once.
    fn parent_file_chooser<R: Runtime>(caller: Window<R>, expected_title: String) {
        let app = caller.app_handle().clone();
        let _ = caller.clone().run_on_main_thread(move || {
            use gtk::prelude::{Cast, GtkWindowExt, WidgetExt};

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
            let _ = gtk::glib::timeout_add_local(POLL_INTERVAL, move || {
                let choosers: Vec<gtk::FileChooserDialog> = gtk::Window::list_toplevels()
                    .into_iter()
                    .filter_map(|widget| widget.downcast::<gtk::FileChooserDialog>().ok())
                    .collect();
                let titles: Vec<Option<gtk::glib::GString>> =
                    choosers.iter().map(|chooser| chooser.title()).collect();
                let views: Vec<ChooserView<'_>> = choosers
                    .iter()
                    .zip(&titles)
                    .map(|(chooser, title)| ChooserView {
                        title: title.as_deref(),
                        has_parent: chooser.transient_for().is_some(),
                        visible: chooser.is_visible(),
                    })
                    .collect();
                let ours = pick_chooser(&views, &expected_title).map(|index| &choosers[index]);
                let parent = owner();
                match poll_step(ours.is_some(), parent.is_some(), started.elapsed()) {
                    PollStep::Parent => {
                        if let (Some(chooser), Some(parent)) = (ours, parent) {
                            chooser.set_transient_for(Some(parent.upcast_ref::<gtk::Window>()));
                        }
                        gtk::glib::ControlFlow::Break
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
    use serde_json::json;

    #[test]
    fn open_and_save_requests_expect_their_chooser_title() {
        let titled = json!({ "options": { "title": "Open Structure" } });
        assert_eq!(
            expected_chooser_title("open", &titled).as_deref(),
            Some("Open Structure")
        );
        assert_eq!(
            expected_chooser_title("save", &json!({ "options": { "title": "Export PDF" } }))
                .as_deref(),
            Some("Export PDF")
        );
        // Untitled requests show rfd's own titles.
        assert_eq!(
            expected_chooser_title("open", &json!({ "options": {} })).as_deref(),
            Some("Open File")
        );
        assert_eq!(
            expected_chooser_title("open", &json!({ "options": { "directory": true } })).as_deref(),
            Some("Select Folder")
        );
        assert_eq!(
            expected_chooser_title("save", &json!({ "options": { "title": null } })).as_deref(),
            Some("Save File")
        );
        assert_eq!(
            expected_chooser_title("save", &json!({})).as_deref(),
            Some("Save File")
        );
    }

    #[test]
    fn only_open_and_save_start_a_poll() {
        let args = json!({ "options": { "title": "Notice" }, "message": "Saved" });
        for command in ["message", "ask", "confirm", "", "Open", "save_file"] {
            assert_eq!(expected_chooser_title(command, &args), None, "{command}");
        }
    }

    fn view(title: Option<&str>, has_parent: bool, visible: bool) -> ChooserView<'_> {
        ChooserView {
            title,
            has_parent,
            visible,
        }
    }

    #[test]
    fn a_shown_parentless_chooser_with_this_title_is_parented() {
        let choosers = [
            view(Some("Save As"), true, true),
            view(Some("Save As"), false, false),
            view(Some("Open"), false, true),
            view(Some("Save As"), false, true),
        ];
        assert_eq!(pick_chooser(&choosers, "Save As"), Some(3));
    }

    #[test]
    fn the_only_shown_parentless_chooser_is_parented_whatever_its_title() {
        let choosers = [
            view(Some("Save As"), true, true),
            view(Some("Other"), false, true),
        ];
        assert_eq!(pick_chooser(&choosers, "Save As"), Some(1));
        assert_eq!(
            pick_chooser(&[view(None, false, true)], "Save File"),
            Some(0)
        );
    }

    #[test]
    fn nothing_is_parented_when_unsure_or_nothing_is_shown() {
        assert_eq!(pick_chooser(&[], "Save As"), None);
        // Not shown yet: GtkFileChooserNative would reset the parent when it shows it.
        assert_eq!(
            pick_chooser(&[view(Some("Save As"), false, false)], "Save As"),
            None
        );
        // Already parented (another request's poll, or a later poll of this one).
        assert_eq!(
            pick_chooser(&[view(Some("Save As"), true, true)], "Save As"),
            None
        );
        // Two parentless choosers, neither titled as this request's: do not guess.
        let two = [view(Some("A"), false, true), view(Some("B"), false, true)];
        assert_eq!(pick_chooser(&two, "Save As"), None);
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
