//! Keep a new window hidden until its page has painted, so the native surface is never seen
//! before the page's first frame (a dark or blank WebView2 rectangle on Windows).
//!
//! Generic: nothing here knows what kind of window it is handling. A caller
//!
//! 1. passes its builder through [`hidden_until_first_paint`] (hidden, with a first-frame
//!    background) and builds it,
//! 2. calls [`arm_first_paint_fallback_with`] on the built
//!    window in the same main-thread turn as the build,
//! 3. and lets the page call `ackFirstPaint()` (`src/firstPaint.ts`), which invokes
//!    [`window_first_paint`].
//!
//! Whichever comes first, the page's acknowledgement or the fallback timer, shows the window;
//! later ones do nothing. The window is shown with `show()` only, never focused: a window built
//! `focused(false)` keeps that on its first show (tao shows it with `SW_SHOWNOACTIVATE` on
//! Windows), so palettes and popovers never take focus or activate. A caller that does want focus
//! (an editor the user just opened) takes it in its own `after_show` hook.
//!
//! macOS: tao's `show()` is `makeKeyAndOrderFront`, so a window revealed here becomes key there.
//! A macOS utility that must not take key status keeps its own non-activating reveal (such as
//! `restore_utility_window` in `lib.rs`) rather than this one.
//!
//! Each window that uses this needs `allow-window-first-paint` in its capability.

use std::any::Any;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::window::Color;
use tauri::{Manager, Runtime, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// The one builder step: hidden, with `background` as the first frame (the window and the
/// webview). Every other setting the caller made (focus, owner or parent, taskbar, position,
/// size, decorations) is left exactly as it was.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows Office editor uses it so far
pub fn hidden_until_first_paint<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    background: Color,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .visible(false)
        .background_color(first_frame_background(background))
}

/// What the window layer and the webview receive as the first frame.
///
/// Windows: tao fills the client area with it on `WM_ERASEBKGND` (ignoring alpha) and wry hands it
/// to WebView2 as the controller's `DefaultBackgroundColor`, which accepts only alpha 0
/// (transparent) or opaque and treats anything in between as opaque. Say so explicitly, so the
/// window layer and the webview agree. Elsewhere the color passes through unchanged (on macOS only
/// the window layer uses it; WKWebView has no default background to set).
fn first_frame_background(color: Color) -> Color {
    #[cfg(windows)]
    {
        let Color(red, green, blue, alpha) = color;
        if alpha != 0 {
            return Color(red, green, blue, 0xff);
        }
        color
    }
    #[cfg(not(windows))]
    {
        color
    }
}

/// Registers a window built with [`hidden_until_first_paint`] as waiting for its first paint and
/// shows it after `timeout` if the page has not acknowledged by then. Call it on the main thread,
/// in the same turn as `build()`, so the page cannot acknowledge before the window is registered.
///
/// Two hooks run once, on the main thread, at the reveal:
/// `before_show` may decline it (the window stays hidden and its error goes to `after_show`), and
/// `after_show` receives the result of `show()`. Neither runs if the window is destroyed first;
/// both are dropped then.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn arm_first_paint_fallback_with<R: Runtime>(
    window: &WebviewWindow<R>,
    timeout: Duration,
    before_show: impl FnOnce(&WebviewWindow<R>) -> Result<(), String> + Send + 'static,
    after_show: impl FnOnce(&WebviewWindow<R>, Result<(), String>) + Send + 'static,
) {
    let generation = arm(window, Hooks::new(before_show, after_show));
    let label = window.label().to_owned();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            forget(&label, generation);
        }
    });
    let fallback = window.clone();
    schedule(timeout, move || {
        let target = fallback.clone();
        let _ = fallback.run_on_main_thread(move || {
            reveal(&target, Some(generation));
        });
    });
}

/// Shows `window` now if it is still waiting for its first paint, running its hooks. Returns
/// whether this call showed it; `false` (and nothing done) when it was already shown or was never
/// armed. Main thread.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn show_after_first_paint<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    reveal(window, None)
}

/// The page has painted: shows the window that sent this, and only that window (there is no label
/// argument). Idempotent: once the window has been shown, by this or by the fallback, it does
/// nothing, and a window that was never armed is never shown by it.
#[tauri::command]
pub fn window_first_paint(window: WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            show_after_first_paint(&target);
        })
        .map_err(|error| error.to_string())
}

/// The part of a window this module touches, so the reveal logic is testable without a runtime.
trait PaintedWindow: 'static {
    fn label(&self) -> &str;
    fn show(&self) -> Result<(), String>;
}

impl<R: Runtime> PaintedWindow for WebviewWindow<R> {
    fn label(&self) -> &str {
        WebviewWindow::label(self)
    }

    fn show(&self) -> Result<(), String> {
        WebviewWindow::show(self).map_err(|error| error.to_string())
    }
}

type BeforeShow<W> = Box<dyn FnOnce(&W) -> Result<(), String> + Send>;
type AfterShow<W> = Box<dyn FnOnce(&W, Result<(), String>) + Send>;

struct Hooks<W> {
    before_show: BeforeShow<W>,
    after_show: AfterShow<W>,
}

impl<W> Hooks<W> {
    fn new(
        before_show: impl FnOnce(&W) -> Result<(), String> + Send + 'static,
        after_show: impl FnOnce(&W, Result<(), String>) + Send + 'static,
    ) -> Self {
        Self {
            before_show: Box::new(before_show),
            after_show: Box::new(after_show),
        }
    }
}

/// A waiting window. `generation` tells a re-created window with the same label apart from the
/// one a stale fallback timer or `Destroyed` event belongs to.
struct Waiting {
    generation: u64,
    hooks: Box<dyn Any + Send>,
}

static WAITING: Mutex<BTreeMap<String, Waiting>> = Mutex::new(BTreeMap::new());
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn waiting() -> MutexGuard<'static, BTreeMap<String, Waiting>> {
    WAITING.lock().unwrap_or_else(PoisonError::into_inner)
}

fn arm<W: PaintedWindow>(window: &W, hooks: Hooks<W>) -> u64 {
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let replaced = waiting().insert(
        window.label().to_owned(),
        Waiting {
            generation,
            hooks: Box::new(hooks),
        },
    );
    drop(replaced); // outside the lock: dropping hooks may drop what they captured
    generation
}

/// Removes the entry for `label` if it is still the one armed as `generation`.
fn forget(label: &str, generation: u64) {
    let removed = {
        let mut waiting = waiting();
        match waiting.get(label) {
            Some(entry) if entry.generation == generation => waiting.remove(label),
            _ => None,
        }
    };
    drop(removed);
}

/// The one reveal: takes the window's entry (only if `generation` matches, when given), then runs
/// `before_show`, `show()` and `after_show` with the lock released. At most once per arm.
fn reveal<W: PaintedWindow>(window: &W, generation: Option<u64>) -> bool {
    let taken = {
        let mut waiting = waiting();
        match waiting.get(window.label()) {
            Some(entry) if generation.is_none_or(|g| g == entry.generation) => {
                waiting.remove(window.label())
            }
            _ => None,
        }
    };
    let Some(Ok(hooks)) = taken.map(|entry| entry.hooks.downcast::<Hooks<W>>()) else {
        return false;
    };
    let Hooks {
        before_show,
        after_show,
    } = *hooks;
    let result = before_show(window).and_then(|()| window.show());
    after_show(window, result);
    true
}

fn schedule(timeout: Duration, fire: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        fire();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// A window that counts its shows. Labels are unique per test: the registry is process-wide.
    struct Fake {
        label: String,
        shows: Arc<AtomicUsize>,
    }

    impl Fake {
        fn new(label: &str) -> Self {
            Self {
                label: format!("first-paint-test-{label}"),
                shows: Arc::default(),
            }
        }
        fn shows(&self) -> usize {
            self.shows.load(Ordering::SeqCst)
        }
    }

    impl PaintedWindow for Fake {
        fn label(&self) -> &str {
            &self.label
        }
        fn show(&self) -> Result<(), String> {
            self.shows.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn plain() -> Hooks<Fake> {
        Hooks::new(|_| Ok(()), |_, _| {})
    }

    /// Function body from `source`, from `signature` to its closing brace at column 0.
    fn body<'a>(source: &'a str, signature: &str) -> &'a str {
        let start = source
            .find(signature)
            .unwrap_or_else(|| panic!("{signature}"));
        let rest = &source[start..];
        &rest[..rest.find("\n}\n").unwrap()]
    }

    fn code_only(source: &str) -> String {
        source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn method_calls(code: &str) -> Vec<&str> {
        code.match_indices('.')
            .filter_map(|(index, _)| {
                let rest = &code[index + 1..];
                let name = &rest[..rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .unwrap_or(rest.len())];
                (!name.is_empty() && rest[name.len()..].starts_with('(')).then_some(name)
            })
            .collect()
    }

    #[test]
    fn first_paint_builder_step_only_hides_and_sets_the_background() {
        let source = include_str!("first_paint.rs");
        let step = code_only(body(source, "pub fn hidden_until_first_paint<"));
        let step = &step[step.find("{\n").unwrap()..];
        // Focus, owner/parent, taskbar and every other caller setting pass through untouched.
        assert_eq!(method_calls(step), ["visible", "background_color"]);
        assert!(step.contains(".visible(false)"));
        assert!(step.contains(".background_color(first_frame_background(background))"));
    }

    #[test]
    fn first_paint_never_focuses_and_shows_only_through_one_reveal() {
        let source = include_str!("first_paint.rs");
        let code = code_only(&source[..source.find("#[cfg(test)]\nmod tests").unwrap()]);
        for forbidden in [
            "set_focus(",
            ".focused(",
            "skip_taskbar",
            ".parent(",
            ".owner(",
            "set_always_on_top",
            "unminimize(",
        ] {
            assert!(
                !code.contains(forbidden),
                "first_paint.rs calls {forbidden}"
            );
        }
        // The command takes the invoking window and nothing else: no label to aim it elsewhere.
        let command = body(source, "pub fn window_first_paint(");
        assert!(command.starts_with("pub fn window_first_paint(window: WebviewWindow) ->"));
        assert!(command.contains("show_after_first_paint(&target);"));
        assert!(!command.contains("get_webview_window"));
        assert!(!code.contains("get_webview_window"));
        // The only `show()` is the reveal's own.
        assert_eq!(code.matches("window.show()").count(), 1);
        assert!(body(source, "fn reveal<").contains("window.show()"));
    }

    #[test]
    fn first_paint_reveal_shows_only_the_calling_window_once() {
        let calling = Fake::new("calling");
        let other = Fake::new("other");
        arm(&calling, plain());
        arm(&other, plain());
        assert!(reveal(&calling, None));
        assert_eq!((calling.shows(), other.shows()), (1, 0));
        // Idempotent: a second acknowledgement, and the fallback after it, do nothing.
        assert!(!reveal(&calling, None));
        assert_eq!(calling.shows(), 1);
        assert!(reveal(&other, None));
        assert_eq!((calling.shows(), other.shows()), (1, 1));
        // A window that was never armed (hidden on purpose, say) is never shown by it.
        let unarmed = Fake::new("unarmed");
        assert!(!reveal(&unarmed, None));
        assert_eq!(unarmed.shows(), 0);
    }

    #[test]
    fn first_paint_fallback_shows_a_window_the_page_never_acknowledged() {
        let window = Arc::new(Fake::new("fallback"));
        let generation = arm(&*window, plain());
        let (fired, done) = std::sync::mpsc::channel();
        let target = Arc::clone(&window);
        schedule(Duration::from_millis(20), move || {
            fired.send(reveal(&*target, Some(generation))).unwrap();
        });
        assert_eq!(done.recv_timeout(Duration::from_secs(5)), Ok(true));
        assert_eq!(window.shows(), 1);
        assert!(!reveal(&*window, None), "the page's late acknowledgement");
        assert_eq!(window.shows(), 1);
    }

    #[test]
    fn first_paint_fallback_is_a_no_op_once_shown_or_for_a_recreated_window() {
        let window = Fake::new("stale");
        let first = arm(&window, plain());
        assert!(reveal(&window, None));
        assert!(
            !reveal(&window, Some(first)),
            "fallback after the page acknowledged"
        );
        // The same label re-created: the old window's timer and Destroyed event leave it alone.
        let second = arm(&window, plain());
        assert!(!reveal(&window, Some(first)));
        forget(&window.label, first);
        assert_eq!(window.shows(), 1);
        assert!(reveal(&window, Some(second)));
        assert_eq!(window.shows(), 2);
    }

    #[test]
    fn first_paint_hooks_run_once_around_the_show_and_may_decline_it() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let window = Fake::new("hooks");
        let (before, after) = (Arc::clone(&calls), Arc::clone(&calls));
        arm(
            &window,
            Hooks::new(
                move |w: &Fake| {
                    before.lock().unwrap().push(format!("before {}", w.shows()));
                    Ok(())
                },
                move |w: &Fake, result| {
                    after
                        .lock()
                        .unwrap()
                        .push(format!("after {} {result:?}", w.shows()));
                },
            ),
        );
        assert!(reveal(&window, None));
        assert!(!reveal(&window, None));
        assert_eq!(*calls.lock().unwrap(), ["before 0", "after 1 Ok(())"]);

        let declined = Fake::new("declined");
        let (sent, result) = std::sync::mpsc::channel();
        arm(
            &declined,
            Hooks::new(
                |_| Err("closing".into()),
                move |_, outcome| sent.send(outcome).unwrap(),
            ),
        );
        assert!(reveal(&declined, None));
        assert_eq!(result.recv(), Ok(Err("closing".to_string())));
        assert_eq!(declined.shows(), 0);
    }

    #[test]
    fn first_paint_destroyed_window_drops_its_hooks_unrun() {
        let window = Fake::new("destroyed");
        let (sent, result) = std::sync::mpsc::channel::<Result<(), String>>();
        let generation = arm(
            &window,
            Hooks::new(|_| Ok(()), move |_, outcome| sent.send(outcome).unwrap()),
        );
        forget(&window.label, generation);
        assert!(result.recv().is_err(), "hooks dropped without running");
        assert!(!reveal(&window, None));
        assert_eq!(window.shows(), 0);
    }

    #[test]
    fn first_paint_background_is_opaque_on_windows_and_unchanged_elsewhere() {
        let translucent = Color(1, 2, 3, 0x80);
        let transparent = Color(1, 2, 3, 0);
        assert_eq!(first_frame_background(transparent), transparent);
        if cfg!(windows) {
            assert_eq!(first_frame_background(translucent), Color(1, 2, 3, 0xff));
        } else {
            assert_eq!(first_frame_background(translucent), translucent);
        }
    }

    #[test]
    fn first_paint_command_is_registered_permitted_and_granted_only_to_the_office_editor() {
        let lib = include_str!("lib.rs");
        let handler = &lib[lib.find("generate_handler![").unwrap()..];
        let handler = &handler[..handler.find("\n        ])").unwrap()];
        assert!(handler.contains("\n            first_paint::window_first_paint,\n"));
        assert!(include_str!("../build.rs").contains("\"window_first_paint\","));
        let permission = include_str!("../permissions/autogenerated/window_first_paint.toml");
        assert!(permission.contains("identifier = \"allow-window-first-paint\""));
        assert!(permission.contains("commands.allow = [\"window_first_paint\"]"));

        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut holders = Vec::new();
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "json") {
                let text = std::fs::read_to_string(&path).unwrap();
                let json: serde_json::Value = serde_json::from_str(&text).unwrap();
                let grants = json["permissions"].as_array().unwrap().iter().any(|p| {
                    p.as_str().or_else(|| p["identifier"].as_str())
                        == Some("allow-window-first-paint")
                });
                if grants {
                    holders.push((
                        json["identifier"].as_str().unwrap().to_owned(),
                        json["windows"].clone(),
                    ));
                }
            }
        }
        assert_eq!(
            holders,
            [(
                "office-object".to_owned(),
                serde_json::json!(["office-object-*"])
            )]
        );
    }
}
