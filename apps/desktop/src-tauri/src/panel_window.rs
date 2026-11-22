//! Non-activating utilities: persistent panel activation and temporary palette input leases.

use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager};

#[path = "panel_focus_lease.rs"]
mod focus_lease;
#[path = "panel_focus_return.rs"]
mod focus_return;
#[path = "panel_window_installation.rs"]
mod installation;
#[path = "palette_key_guard.rs"]
pub(crate) mod key_guard;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaletteCommandHitBox {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    // Keep the existing IPC envelope: chooser bounds share the atomic snapshot.
    #[serde(default)]
    pub native_chooser: bool,
}

impl PaletteCommandHitBox {
    #[cfg(any(windows, test))]
    fn contains(self, x: i32, y: i32) -> bool {
        x >= self.x
            && y >= self.y
            && x < self.x.saturating_add(self.width)
            && y < self.y.saturating_add(self.height)
    }
}

#[cfg(any(windows, test))]
#[path = "palette_activation.rs"]
mod palette_activation;

#[cfg(windows)]
static PALETTE_COMMAND_HIT_BOXES: std::sync::OnceLock<Mutex<HashMap<isize, PaletteHitRegions>>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
#[derive(Default)]
struct PaletteHitRegions {
    boxes: Vec<PaletteCommandHitBox>,
    chooser_rects: Vec<PaletteCommandHitBox>,
}

#[cfg(windows)]
pub(crate) fn set_palette_command_hit_boxes(
    hwnd: isize,
    boxes: Vec<PaletteCommandHitBox>,
    chooser_rects: Vec<PaletteCommandHitBox>,
) {
    let state = PALETTE_COMMAND_HIT_BOXES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut state) = state.lock() {
        if boxes.is_empty() && chooser_rects.is_empty() {
            state.remove(&hwnd);
        } else {
            state.insert(
                hwnd,
                PaletteHitRegions {
                    boxes,
                    chooser_rects,
                },
            );
        }
    }
}

#[cfg(windows)]
fn palette_hits(hwnd: isize, point: Option<(i32, i32)>) -> (usize, usize, bool, bool) {
    PALETTE_COMMAND_HIT_BOXES
        .get()
        .and_then(|state| state.lock().ok())
        .and_then(|state| {
            state.get(&hwnd).map(|regions| {
                let hit = |rects: &[PaletteCommandHitBox]| {
                    point.is_some_and(|(x, y)| rects.iter().any(|rect| rect.contains(x, y)))
                };
                (
                    regions.boxes.len(),
                    regions.chooser_rects.len(),
                    hit(&regions.boxes),
                    hit(&regions.chooser_rects),
                )
            })
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod palette_command_hit_box_tests {
    use super::PaletteCommandHitBox;

    #[test]
    fn tagged_chooser_rects_share_the_existing_command_snapshot() {
        let old_command: PaletteCommandHitBox = serde_json::from_value(serde_json::json!({
            "x": 0, "y": 0, "width": 20, "height": 20
        }))
        .unwrap();
        assert!(!old_command.native_chooser);
        let chooser: PaletteCommandHitBox = serde_json::from_value(serde_json::json!({
            "x": 40, "y": 0, "width": 20, "height": 20, "nativeChooser": true
        }))
        .unwrap();
        assert!(chooser.native_chooser);
        assert!(chooser.contains(40, 0));
    }

    #[test]
    fn physical_client_hit_boxes_select_only_command_bounds_at_dpi_scale() {
        // Two command buttons remain eligible; the gap/input area between them is not.
        let buttons = [
            PaletteCommandHitBox {
                x: 0,
                y: 0,
                width: 60,
                height: 60,
                native_chooser: false,
            },
            PaletteCommandHitBox {
                x: 75,
                y: 0,
                width: 60,
                height: 60,
                native_chooser: false,
            },
        ];
        assert!(buttons.iter().any(|button| button.contains(59, 59)));
        assert!(!buttons.iter().any(|button| button.contains(65, 30)));
        assert!(buttons.iter().any(|button| button.contains(75, 30)));
        assert!(!buttons.iter().any(|button| button.contains(135, 30)));
    }
}
pub(crate) use installation::finish_installation;
#[cfg(target_os = "linux")]
pub(crate) use key_guard::linux::{self, set_keyboard_popover};
#[cfg(not(target_os = "linux"))]
pub(crate) fn set_keyboard_popover(_label: &str, _keyboard: bool) {}
pub(crate) use key_guard::{keeps_palette_focus, End as PointerGuardEnd};

pub(crate) fn palette_blocks_forwarded_shortcut(
    label: &str,
    key: &str,
    meta: bool,
    ctrl: bool,
    alt: bool,
) -> bool {
    #[cfg(target_os = "linux")]
    if !linux::has_confirmed_focus(label) {
        return true;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = label;
    key_guard::blocks_forwarded_shortcut(
        key_guard::blocks_document(super::MAIN_WINDOW_LABEL),
        key,
        meta,
        ctrl,
        alt,
    )
}

pub(crate) fn palette_blocks_menu(document: &str, command: &str) -> bool {
    key_guard::blocks_menu(key_guard::blocks_document(document), true, command)
}

/// Pointer observation alone does not alter window styles or input leases.
pub(crate) fn install_pointer_guard<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    key_guard::install(window)
}
#[cfg(target_os = "macos")]
#[path = "panel_focus_macos.rs"]
mod macos;

#[derive(Default)]
pub(crate) struct PanelFocusState(Mutex<HashMap<String, InputFocusState>>);

// Keep palette leases independent of the native-activation gate required by plugin panels.
enum InputFocusState {
    Palette(focus_lease::Lease),
    Panel(focus_lease::PanelActivation),
}

impl InputFocusState {
    fn new(label: &str) -> Self {
        if super::is_plugin_panel_window_label(label) {
            Self::Panel(focus_lease::PanelActivation::default())
        } else {
            Self::Palette(focus_lease::Lease::default())
        }
    }

    fn reset(&mut self) {
        match self {
            Self::Palette(lease) => lease.reset(),
            Self::Panel(panel) => panel.reset(),
        }
    }

    fn epoch(&self) -> u64 {
        match self {
            Self::Palette(lease) => lease.epoch,
            Self::Panel(panel) => panel.epoch,
        }
    }

    fn is_held(&self) -> bool {
        match self {
            Self::Palette(lease) => lease.is_held(),
            Self::Panel(panel) => panel.is_held(),
        }
    }

    fn is_current(&self, generation: u64, epoch: u64) -> bool {
        match self {
            Self::Palette(lease) => lease.is_current(generation, epoch),
            Self::Panel(panel) => panel.is_current(generation, epoch),
        }
    }

    fn acquired(&mut self, generation: u64, epoch: u64, focused: bool) -> bool {
        match self {
            Self::Palette(lease) => lease.acquired(generation, epoch, focused),
            #[cfg(target_os = "linux")]
            Self::Panel(panel) => panel.acquired_presentation(generation, epoch, focused),
            #[cfg(not(target_os = "linux"))]
            Self::Panel(panel) => panel.acquired(generation, epoch, focused),
        }
    }
}

pub(crate) fn is_active<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<bool, String> {
    if !window.is_visible().map_err(|error| error.to_string())?
        || window.is_minimized().map_err(|error| error.to_string())?
    {
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    {
        let marker =
            objc2::MainThreadMarker::new().ok_or("Panel focus requires the main thread.")?;
        if !objc2_app_kit::NSApplication::sharedApplication(marker).isActive() {
            return Ok(false);
        }
    }
    #[cfg(windows)]
    return Ok(unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow()
            == window.hwnd().map_err(|error| error.to_string())?.0
    });
    #[cfg(not(windows))]
    window.is_focused().map_err(|error| error.to_string())
}

pub(crate) fn end_pointer_guard<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    why: PointerGuardEnd,
    sequence: Option<u64>,
    before: u64,
) {
    key_guard::end(app, label, why, sequence, before);
}

/// Hiding is terminal even when a select popup already resigned key status.
/// Invalidate native acquisition and notify the still-mounted page before hiding.
pub(crate) fn end_for_hide<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    key_guard::end(app, label, PointerGuardEnd::Hide, None, 0);
    if let Some(window) = app.get_webview_window(label) {
        activation_with_reason(&window, false, "hide");
    }
}

pub(crate) fn holds_input_focus<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .is_some_and(InputFocusState::is_held)
}

/// A release is explicit: native deactivation, teardown and rejected acquisitions do not
/// ask for focus. Recheck the lease and native destination when queued work actually runs.
pub(crate) fn return_focus_after_interaction<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    requested: bool,
) -> Result<(), String> {
    let held = holds_input_focus(window);
    let log_skip = |app_active, source_focused| {
        let reason = focus_return::skip_reason(requested, held, app_active, source_focused)
            .unwrap_or("document-unavailable");
        super::palette_focus_log(format_args!(
            "hand-back label={} result=skipped reason={reason}",
            window.label()
        ));
    };
    #[cfg(windows)]
    {
        if let Some(document) = window
            .app_handle()
            .get_webview_window(super::toolset_document_label(window.label()))
        {
            if focus_return::should_return(
                requested,
                held,
                super::foreground_belongs_to_app(),
                true,
            ) {
                // The HWND pair is rechecked inside, including native chooser ownership.
                return_focus_to_document(
                    window.hwnd().map_err(|error| error.to_string())?.0,
                    &document,
                    window.label(),
                )?;
            } else {
                log_skip(super::foreground_belongs_to_app(), true);
            }
        } else {
            log_skip(super::foreground_belongs_to_app(), true);
        }
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplication, NSWindow};
        let marker =
            objc2::MainThreadMarker::new().ok_or("Panel focus requires the main thread.")?;
        let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
        let panel = unsafe { pointer.as_ref() }.ok_or("Could not access native panel window.")?;
        if focus_return::should_return(
            requested,
            held,
            NSApplication::sharedApplication(marker).isActive(),
            panel.isKeyWindow(),
        ) {
            if let Some(document) = window
                .app_handle()
                .get_webview_window(super::MAIN_WINDOW_LABEL)
            {
                // makeKeyWindow resigns the palette without activating a background app.
                super::focus_native_document_window(&document)?;
                let webview: &tauri::Webview<R> = document.as_ref();
                webview.set_focus().map_err(|error| error.to_string())?;
                super::palette_focus_log(format_args!(
                    "hand-back label={} result=returned reason=explicit-release",
                    window.label()
                ));
            } else {
                log_skip(true, true);
            }
        } else {
            log_skip(
                NSApplication::sharedApplication(marker).isActive(),
                panel.isKeyWindow(),
            );
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if focus_return::should_return(
            requested,
            held,
            super::foreground_belongs_to_app(),
            window.is_focused().unwrap_or(false),
        ) {
            super::focus_main_document_window_impl(
                window.app_handle(),
                super::MainWindowFocusMode::OnlyIfAppActive,
            )?;
            super::palette_focus_log(format_args!(
                "hand-back label={} result=returned reason=explicit-release",
                window.label()
            ));
        } else {
            log_skip(
                super::foreground_belongs_to_app(),
                window.is_focused().unwrap_or(false),
            );
        }
    }
    Ok(())
}

pub(crate) fn reset_for_webview<R: tauri::Runtime>(window: &tauri::Window<R>) {
    key_guard::end(
        window.app_handle(),
        window.label(),
        PointerGuardEnd::Destroy,
        None,
        0,
    );
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .entry(window.label().to_string())
        .or_insert_with(|| InputFocusState::new(window.label()))
        .reset();
    let _ = window.set_focusable(false);
}

#[derive(Clone, serde::Serialize)]
struct FocusEvent {
    kind: &'static str,
    generation: u64,
    reason: &'static str,
}

// Read synchronously during page registration, before any asynchronous focus IPC.
// Send as a string so JavaScript treats the native epoch as an opaque token.
pub(crate) fn page_token<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> String {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .entry(window.label().to_string())
        .or_insert_with(|| InputFocusState::new(window.label()))
        .epoch()
        .to_string()
}

pub(crate) fn request<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    generation: u64,
    page_token: &str,
    editing: bool,
    select_interaction: bool,
) -> Option<u64> {
    let state = window.state::<PanelFocusState>();
    let mut leases = state.0.lock().unwrap();
    let lease = leases
        .entry(window.label().to_string())
        .or_insert_with(|| InputFocusState::new(window.label()));
    let epoch = page_token.parse().ok()?;
    let accepted = match lease {
        #[cfg(target_os = "linux")]
        InputFocusState::Panel(panel) if editing => panel.record_request(generation, epoch, true),
        InputFocusState::Panel(panel) => panel.request(generation, epoch, editing),
        InputFocusState::Palette(lease) => {
            let accepted = lease.request(generation, epoch, editing);
            if accepted {
                lease.select_interaction =
                    cfg!(target_os = "macos") && editing && select_interaction;
            }
            accepted
        }
    };
    if !accepted {
        return None;
    }
    Some(epoch)
}

pub(crate) fn acquired<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    generation: u64,
    epoch: u64,
    focused: bool,
) -> bool {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .entry(window.label().to_string())
        .or_insert_with(|| InputFocusState::new(window.label()))
        .acquired(generation, epoch, focused)
}

pub(crate) fn is_current<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    generation: u64,
    epoch: u64,
) -> bool {
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .is_some_and(|lease| lease.is_current(generation, epoch))
}

// Windows and macOS report activation at their native hooks. GTK reports loss
// here and commits activation only when its timestamped acquisition completes.
pub(crate) fn activation<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, active: bool) {
    activation_with_reason(window, active, "window");
}

fn activation_with_reason<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    active: bool,
    reason: &'static str,
) {
    super::palette_focus_log(format_args!(
        "activation label={} active={active} reason={reason}",
        window.label()
    ));
    if !active {
        key_guard::end(
            window.app_handle(),
            window.label(),
            PointerGuardEnd::Deactivated,
            None,
            0,
        );
    }
    let (generation, preserve_select) = {
        let state = window.state::<PanelFocusState>();
        let mut leases = state.0.lock().unwrap();
        let lease = leases
            .entry(window.label().to_string())
            .or_insert_with(|| InputFocusState::new(window.label()));
        match lease {
            InputFocusState::Panel(panel) => {
                if active {
                    panel.activate();
                } else {
                    panel.deactivate();
                }
                (Some(panel.generation), false)
            }
            InputFocusState::Palette(lease) => {
                let preserve_select = !active && reason == "window" && lease.suspend_select();
                let generation = if active || preserve_select {
                    Some(lease.generation)
                } else {
                    lease.deactivate()
                };
                (generation, preserve_select)
            }
        }
    };
    if let Some(generation) = generation {
        if !active && !preserve_select {
            let _ = window.set_focusable(false);
        }
        let event = FocusEvent {
            kind: if active { "activated" } else { "deactivated" },
            generation,
            reason,
        };
        #[cfg(windows)]
        if super::toolset_window_parts(window.label()).0 != super::MAIN_WINDOW_LABEL {
            super::office_ole::toolset_events::deliver(
                window,
                "chemdraft://plugin-panel-focus",
                &serde_json::to_string(&event).unwrap(),
            );
            return;
        }
        if let Err(error) = window.emit_to(window.label(), "chemdraft://plugin-panel-focus", event)
        {
            eprintln!("Could not notify panel focus: {error}");
        }
    }
}

// Key resignation alone cannot distinguish an AppKit popup from leaving the
// palette. The native pointer monitor and app notification supply those explicit
// terminal transitions, including when the select has already lost key status.
#[cfg(target_os = "macos")]
pub(super) fn end_select_interactions<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    except: Option<&str>,
    reason: &'static str,
) {
    for (label, window) in app.webview_windows() {
        if except == Some(label.as_str()) {
            continue;
        }
        let select = app
            .state::<PanelFocusState>()
            .0
            .lock()
            .unwrap()
            .get(&label)
            .is_some_and(|state| matches!(state, InputFocusState::Palette(lease) if lease.select_interaction));
        if select {
            activation_with_reason(&window, false, reason);
        }
    }
}

pub(crate) fn forget<R: tauri::Runtime>(window: &tauri::Window<R>) {
    key_guard::end(
        window.app_handle(),
        window.label(),
        PointerGuardEnd::Destroy,
        None,
        0,
    );
    window
        .state::<PanelFocusState>()
        .0
        .lock()
        .unwrap()
        .remove(window.label());
    #[cfg(target_os = "macos")]
    macos::forget(window.label());
}

#[cfg(any(windows, test))]
#[path = "panel_window_geometry.rs"]
mod geometry;

#[cfg(any(windows, test))]
const RESIZE_ZONE_LOGICAL_PX: f64 = 6.0;
/// SetActiveWindow changes activation only within our UI thread; unlike tao's set_focus it
/// never calls SetForegroundWindow or synthesizes Alt. A late IPC is dropped in the background.
#[cfg(windows)]
pub(crate) fn focus_if_app_active(
    hwnd: windows_sys::Win32::Foundation::HWND,
    non_pointer_lease: bool,
) -> bool {
    use windows_sys::Win32::{
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        },
    };
    // windows-sys gates this user32 entry point behind the otherwise unused keyboard feature.
    #[link(name = "user32")]
    extern "system" {
        fn SetActiveWindow(
            hwnd: windows_sys::Win32::Foundation::HWND,
        ) -> windows_sys::Win32::Foundation::HWND;
    }
    unsafe {
        if focus_observer(hwnd).is_some_and(|observer| {
            let mut policy = observer.policy.get();
            // WebView2 can deliver Tab/accessibility focus inside its child
            // without sending WM_KEYDOWN to the host. Pointer acquisitions carry
            // pointer_before; a non-pointer lease must not inherit their guard.
            if non_pointer_lease {
                policy.clear_command_press();
            }
            let allowed = policy.permits_input_focus(std::time::Instant::now());
            observer.policy.set(policy);
            !allowed
        }) {
            log::debug!(target: "chemdraft::windows_activation",
                "input-focus refused hwnd={hwnd:?} reason=command-surface");
            return false;
        }
        // Preserve Tao's visible/non-minimized gate, including utility suspension for dialogs.
        if hwnd.is_null() || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return false;
        }
        let foreground = GetForegroundWindow();
        let mut process = 0;
        let known =
            !foreground.is_null() && GetWindowThreadProcessId(foreground, &mut process) != 0;
        geometry::with_owned_foreground(known.then_some(process), GetCurrentProcessId(), || {
            SetActiveWindow(hwnd);
        }) && GetForegroundWindow() == hwnd
    }
}

/// Toolbar-style hand-back, without Tao's force_window_active / synthetic Alt fallback.
/// Called when a lease ends, a non-lease pointer gesture completes or idle activation settles. Activation alone
/// is not enough: keyboard focus must also leave the panel's WebView2 child HWND.
#[cfg(windows)]
pub(crate) fn return_focus_to_document<R: tauri::Runtime>(
    panel: windows_sys::Win32::Foundation::HWND,
    document: &tauri::WebviewWindow<R>,
    label: &str,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, IsWindowVisible, SetForegroundWindow,
    };
    let owner = document.hwnd().map_err(|error| error.to_string())?.0;
    let foreground = unsafe { GetForegroundWindow() };
    // Do not take focus from another ChemDraft panel/dialog either.
    if !geometry::foreground_can_return_to_document(
        foreground as usize,
        panel as usize,
        owner as usize,
    ) {
        super::palette_focus_log(format_args!(
            "hand-back label={label} result=skipped reason=another-window-focused"
        ));
        return Ok(());
    }
    // SetActiveWindow alone can leave the palette as the foreground window after a
    // WebView2 select or Tao drag. Transfer foreground explicitly, only from our exact
    // source/document pair. Do not use Tao's force activation/synthetic Alt fallback.
    let returned = unsafe {
        super::foreground_belongs_to_app()
            && GetForegroundWindow() == foreground
            && IsWindowVisible(owner) != 0
            && IsIconic(owner) == 0
            && (foreground == owner || SetForegroundWindow(owner) != 0)
            && GetForegroundWindow() == owner
    };
    if returned {
        let webview: &tauri::Webview<R> = document.as_ref();
        webview.set_focus().map_err(|error| error.to_string())?;
    }
    super::palette_focus_log(format_args!(
        "hand-back label={label} result={} reason={}",
        if returned { "returned" } else { "skipped" },
        if returned {
            "explicit-release"
        } else {
            "foreground-changed-or-document-unavailable"
        }
    ));
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_style(
    style: objc2_app_kit::NSWindowStyleMask,
) -> objc2_app_kit::NSWindowStyleMask {
    // Resizable is a creation trait (.resizable(true)), never a late frame-view rebuild.
    style | objc2_app_kit::NSWindowStyleMask::NonactivatingPanel
}

#[cfg(target_os = "macos")]
pub(crate) fn configure_macos_style(
    current: objc2_app_kit::NSWindowStyleMask,
    apply: impl FnOnce(objc2_app_kit::NSWindowStyleMask),
) {
    let required = macos_style(current);
    if required != current {
        apply(required);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn install_input_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    key_guard::install(window)?;
    macos::observe(window)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn install_input_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    key_guard::install(window)
}

#[cfg(not(windows))]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos::install_resize_hit_test(window)?;
    install_input_focus(window)
}

#[cfg(windows)]
fn extended_style(style: isize) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    // Tao may rewrite TOOLWINDOW on show; document ownership still keeps panels off the taskbar.
    (style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize) & !(WS_EX_APPWINDOW as isize)
}

/// Focus observation is shared by resizable reports, tool palettes and colour popovers.
/// It must not depend on a resize overlay (popovers do not have one).
#[cfg(windows)]
pub(crate) fn install_input_focus<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::{
        Shell::SetWindowSubclass,
        WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE},
    };
    key_guard::install(window)?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let target = window.clone();
    let press_target = window.clone();
    let drag_target = window.clone();
    let refresh_window = window.clone();
    let data = Box::into_raw(Box::new(FocusObserver {
        label: window.label().to_owned(),
        policy: std::cell::Cell::new(palette_activation::Policy::new(window.label())),
        command_pressed: std::rc::Rc::new(move |primary| {
            // Cancel a queued editing acquisition synchronously, before WebView2 sees
            // this command press. Preserve the pending-key observer that the early
            // MA_NOACTIVATE return deliberately bypasses in the subclass chain.
            activation_with_reason(&press_target, false, "command");
            key_guard::pointer(
                press_target.app_handle(),
                primary.then_some(press_target.label()),
            );
        }),
        stable_nonclient_paint: palette_activation::is_command_surface(window.label()),
        pin_inactive: std::env::var("CHEMDRAFT_PALETTE_PIN_INACTIVE").as_deref() != Ok("0"),
        activation: std::rc::Rc::new(move |active| activation(&target, active)),
        drag_finished: std::rc::Rc::new(move || {
            // The palette's title/background press ended its lease without returning focus.
            // Hand back only after Tao's drag loop; guard any newer lease or foreground owner.
            if super::toolset_window_parts(drag_target.label())
                .1
                .starts_with("toolset-")
            {
                if let Err(error) = return_focus_after_interaction(&drag_target, true) {
                    eprintln!("Could not return palette keyboard focus after drag: {error}");
                }
            }
        }),
        refresh_hit_boxes: std::rc::Rc::new(move || {
            if super::toolset_window_parts(refresh_window.label()).0 != super::MAIN_WINDOW_LABEL {
                super::office_ole::toolset_events::deliver(
                    &refresh_window,
                    "chemdraft://palette-command-hit-boxes-refresh",
                    "null",
                );
                return;
            }
            let _ = refresh_window.emit_to(
                refresh_window.label(),
                "chemdraft://palette-command-hit-boxes-refresh",
                (),
            );
        }),
    }));
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            extended_style(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
        );
        if SetWindowSubclass(hwnd, Some(focus_subclass), 2, data as usize) == 0 {
            drop(Box::from_raw(data));
            return Err(format!(
                "Could not observe utility window focus: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

/// Called at native open AND reveal, so colour -> flyout reuse cannot keep an
/// editing acquisition alive. This is a no-op off Windows.
pub(crate) fn set_popover_content<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    kind: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let target = window.clone();
        let kind = kind.to_owned();
        super::run_on_main_thread_blocking(window, move || {
            let hwnd = target.hwnd().map_err(|error| error.to_string())?.0;
            // SAFETY: installed observer, read and updated only on this HWND's UI thread.
            if let Some(observer) = unsafe { focus_observer(hwnd) } {
                let mut policy = observer.policy.get();
                policy.set_content(&kind);
                observer.policy.set(policy);
                if !policy.permits_input_focus(std::time::Instant::now()) {
                    activation_with_reason(&target, false, "content");
                    return_focus_after_interaction(&target, true)?;
                }
            }
            Ok(())
        })?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, kind);
        Ok(())
    }
}

// The reference must not survive a callback/DefSubclassProc (WM_NCDESTROY owns it).
#[cfg(windows)]
unsafe fn focus_observer<'a>(
    hwnd: windows_sys::Win32::Foundation::HWND,
) -> Option<&'a FocusObserver> {
    let mut data = 0;
    if windows_sys::Win32::UI::Shell::GetWindowSubclass(hwnd, Some(focus_subclass), 2, &mut data)
        == 0
    {
        None
    } else {
        (data as *const FocusObserver).as_ref()
    }
}

#[cfg(windows)]
struct FocusObserver {
    label: String,
    policy: std::cell::Cell<palette_activation::Policy>,
    command_pressed: std::rc::Rc<dyn Fn(bool)>,
    stable_nonclient_paint: bool,
    pin_inactive: bool,
    activation: std::rc::Rc<dyn Fn(bool)>,
    drag_finished: std::rc::Rc<dyn Fn()>,
    refresh_hit_boxes: std::rc::Rc<dyn Fn()>,
}

#[cfg(windows)]
unsafe extern "system" fn focus_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    data: usize,
) -> isize {
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::UI::{
        Input::Pointer::{GetPointerInfo, POINTER_INFO},
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::{
            DefWindowProcW, GetCursorPos, GetMessagePos, IsIconic, HTCLIENT, WA_INACTIVE,
            WM_ACTIVATE, WM_ACTIVATEAPP, WM_EXITSIZEMOVE, WM_KEYDOWN, WM_LBUTTONDOWN,
            WM_MOUSEACTIVATE, WM_NCACTIVATE, WM_NCDESTROY, WM_POINTERACTIVATE, WM_SHOWWINDOW,
            WM_SYSKEYDOWN,
        },
    };
    if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN) {
        let observer = &*(data as *const FocusObserver);
        let mut policy = observer.policy.get();
        policy.clear_command_press();
        observer.policy.set(policy);
    }
    if matches!(message, WM_MOUSEACTIVATE | WM_POINTERACTIVATE) {
        let observer = &*(data as *const FocusObserver);
        let pointer = message == WM_POINTERACTIVATE;
        let primary = pointer || ((lparam >> 16) & 0xffff) == WM_LBUTTONDOWN as isize;
        let hit_test = if pointer {
            (wparam >> 16) & 0xffff
        } else {
            (lparam & 0xffff) as usize
        };
        // GetMessagePos can be stale: WebView2 dequeues the click in its browser
        // process and sends activation to our UI thread. Use the live cursor.
        let packed = GetMessagePos();
        let message_pos = (
            (packed as u16 as i16) as i32,
            ((packed >> 16) as u16 as i16) as i32,
        );
        let mut cursor = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        let cursor_valid = GetCursorPos(&mut cursor) != 0;
        let cursor_pos = cursor_valid.then_some((cursor.x, cursor.y));
        // Touch/pen does not necessarily move the mouse cursor. Its pointer ID
        // supplies the same physical screen coordinates for native chooser hits.
        let mut info: POINTER_INFO = std::mem::zeroed();
        let pointer_valid = pointer && GetPointerInfo((wparam & 0xffff) as u32, &mut info) != 0;
        let mut point = if pointer_valid {
            info.ptPixelLocation
        } else {
            cursor
        };
        let position_valid = if pointer { pointer_valid } else { cursor_valid };
        let client = (position_valid
            && hit_test == HTCLIENT as usize
            && ScreenToClient(hwnd, &mut point) != 0)
            .then_some((point.x, point.y));
        let (box_count, chooser_count, command_hit, chooser_hit) =
            palette_hits(hwnd as isize, client);
        let mut policy = observer.policy.get();
        let press = if pointer {
            palette_activation::Press::Pointer
        } else {
            palette_activation::Press::Mouse
        };
        let decision = policy.activate(press, command_hit, chooser_hit, std::time::Instant::now());
        observer.policy.set(policy);
        // Clone before callbacks/default processing: nested messages may destroy
        // the observer. No default chain may activate a command surface first.
        let label = observer.label.clone();
        let command_pressed = observer.command_pressed.clone();
        let result = if let Some(result) = decision {
            command_pressed(primary);
            result
        } else {
            DefSubclassProc(hwnd, message, wparam, lparam)
        };
        let message_name = if pointer {
            "WM_POINTERACTIVATE"
        } else {
            "WM_MOUSEACTIVATE"
        };
        log::debug!(target: "chemdraft::windows_activation",
            "{message_name} label={label} boxes={box_count} chooser_rects={chooser_count} GetMessagePos={message_pos:?} GetCursorPos={cursor_pos:?} client={client:?} command_hit={command_hit} chooser_hit={chooser_hit} return={result} policy={policy:?}");
        return result;
    }
    if message == WM_NCACTIVATE {
        let observer = &*(data as *const FocusObserver);
        let stable = observer.stable_nonclient_paint && IsIconic(hwnd) == 0;
        let pinned = stable && observer.pin_inactive && wparam != 0;
        let label = observer.label.clone();
        // Tao must receive the REAL activation bit: its focus state drives lease
        // bookkeeping and popover lifetime. Pin only DefWindowProc's frame state,
        // AFTER the subclass chain, and return the chain's original result.
        let result = DefSubclassProc(hwnd, message, wparam, if stable { -1 } else { lparam });
        if pinned {
            DefWindowProcW(hwnd, WM_NCACTIVATE, 0, -1);
        }
        log::debug!(target: "chemdraft::windows_activation",
            "WM_NCACTIVATE label={label} wparam={wparam} pinned={pinned}");
        return result;
    }
    // Editable controls retain native chooser activation; command surfaces were
    // handled above without forwarding WM_MOUSEACTIVATE into the default chain.
    // Observe genuine top-level loss synchronously, including during acquisition.
    // WebView2 child focus transitions are not lease boundaries.
    if message == WM_ACTIVATE || (message == WM_ACTIVATEAPP && wparam == 0) {
        let active = message == WM_ACTIVATE && (wparam & 0xffff) != WA_INACTIVE as usize;
        log::debug!(target: "chemdraft::windows_activation",
            "activation label={} message={message:#x} active={active} policy={:?}",
            (*(data as *const FocusObserver)).label,
            (*(data as *const FocusObserver)).policy.get());
        let notify = (*(data as *const FocusObserver)).activation.clone();
        notify(active);
    }
    if message == WM_NCDESTROY {
        set_palette_command_hit_boxes(hwnd as isize, Vec::new(), Vec::new());
        RemoveWindowSubclass(hwnd, Some(focus_subclass), id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(data as *mut FocusObserver));
        return result;
    }
    // Clone before invoking Tao: nested message handling can destroy the observer.
    let drag_finished = (message == WM_EXITSIZEMOVE)
        .then(|| (*(data as *const FocusObserver)).drag_finished.clone());
    if message == WM_SHOWWINDOW && wparam == 0 {
        set_palette_command_hit_boxes(hwnd as isize, Vec::new(), Vec::new());
    } else if message == WM_SHOWWINDOW && wparam != 0 {
        let refresh = (*(data as *const FocusObserver)).refresh_hit_boxes.clone();
        refresh();
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if let Some(drag_finished) = drag_finished {
        drag_finished();
    }
    result
}

#[cfg(windows)]
pub(crate) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{RemoveWindowSubclass, SetWindowSubclass};
    install_input_focus(window)?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let parent = hwnd as usize;
    let hide_panel = window.clone();
    let data = Box::into_raw(Box::new(PanelSubclass {
        will_hide: std::rc::Rc::new(move || {
            let webview: &tauri::Webview<R> = hide_panel.as_ref();
            super::panel_full_size::will_hide(&webview.window());
        }),
    }));
    unsafe {
        if SetWindowSubclass(hwnd, Some(resize_subclass), 1, data as usize) == 0 {
            drop(Box::from_raw(data));
            return Err(format!(
                "Could not install panel resize border: {}",
                std::io::Error::last_os_error()
            ));
        }
        // Keep Tao's NCCALCSIZE unchanged: Win10 MUST retain a zero top inset
        // while WS_CAPTION is present; Win11 uses its DPI-scaled one-pixel inset.
        // Adapt the existing Tauri overlay, never install a competing resize surface.
        let overlay = resize_overlay(hwnd);
        if overlay.is_null() || SetWindowSubclass(overlay, Some(overlay_subclass), 1, parent) == 0 {
            RemoveWindowSubclass(hwnd, Some(resize_subclass), 1);
            drop(Box::from_raw(data));
            return Err("Could not adapt Tauri's panel resize overlay.".into());
        }
        if let Err(error) = update_resize_overlay(hwnd) {
            RemoveWindowSubclass(overlay, Some(overlay_subclass), 1);
            RemoveWindowSubclass(hwnd, Some(resize_subclass), 1);
            drop(Box::from_raw(data));
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(windows)]
struct PanelSubclass {
    will_hide: std::rc::Rc<dyn Fn()>,
}

#[cfg(windows)]
unsafe fn resize_border(hwnd: windows_sys::Win32::Foundation::HWND) -> i32 {
    use windows_sys::Win32::UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::IsZoomed};
    if IsZoomed(hwnd) != 0 {
        return 0;
    }
    geometry::resize_border(GetDpiForWindow(hwnd))
}

#[cfg(windows)]
unsafe fn panel_content_rect(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<geometry::Rect> {
    use windows_sys::Win32::{
        Foundation::{POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::WindowsAndMessaging::GetClientRect,
    };
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    if GetClientRect(hwnd, &mut rect) == 0 || ClientToScreen(hwnd, &mut origin) == 0 {
        return None;
    }
    // The webview paints the visible border at the client edge. GetWindowRect includes
    // invisible resize margins on Windows; those must never become panel grab zones.
    Some(geometry::Rect {
        left: origin.x + rect.left,
        top: origin.y + rect.top,
        right: origin.x + rect.right,
        bottom: origin.y + rect.bottom,
    })
}

#[cfg(windows)]
unsafe fn resize_overlay(
    parent: windows_sys::Win32::Foundation::HWND,
) -> windows_sys::Win32::Foundation::HWND {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;
    let class: Vec<u16> = "TAURI_DRAG_RESIZE_BORDERS\0".encode_utf16().collect();
    let name: Vec<u16> = "TAURI_DRAG_RESIZE_WINDOW\0".encode_utf16().collect();
    FindWindowExW(parent, std::ptr::null_mut(), class.as_ptr(), name.as_ptr())
}

/// Reserve six logical pixels inside every visible edge in Tauri's existing input child.
/// Its region sits above WebView2, so the right grab zone wins over the content scrollbar.
#[cfg(windows)]
unsafe fn update_resize_overlay(
    parent: windows_sys::Win32::Foundation::HWND,
) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{HWND, RECT},
        UI::WindowsAndMessaging::GetClientRect,
    };
    // These entry points are gated behind windows-sys's otherwise unused GDI feature.
    type Region = *mut std::ffi::c_void;
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> Region;
        fn EqualRgn(first: Region, second: Region) -> i32;
        fn CombineRgn(destination: Region, first: Region, second: Region, mode: i32) -> i32;
        fn DeleteObject(object: Region) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRgn(hwnd: HWND, region: Region) -> i32;
        fn SetWindowRgn(hwnd: HWND, region: Region, redraw: i32) -> i32;
    }
    let overlay = resize_overlay(parent);
    let mut client_rect = RECT::default();
    if overlay.is_null() || GetClientRect(parent, &mut client_rect) == 0 {
        return Err("Could not measure panel resize overlay.".into());
    }
    let border = resize_border(parent);
    let width = client_rect.right - client_rect.left;
    let height = client_rect.bottom - client_rect.top;
    let cutout = geometry::overlay_cutout(
        geometry::Rect {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        },
        border,
    );
    let desired = CreateRectRgn(0, 0, width, height);
    let current = CreateRectRgn(0, 0, 0, 0);
    let interior = CreateRectRgn(cutout.left, cutout.top, cutout.right, cutout.bottom);
    if desired.is_null() || current.is_null() || interior.is_null() {
        if !desired.is_null() {
            DeleteObject(desired);
        }
        if !current.is_null() {
            DeleteObject(current);
        }
        if !interior.is_null() {
            DeleteObject(interior);
        }
        return Err("Could not allocate panel resize region.".into());
    }
    const RGN_DIFF: i32 = 4;
    let combined = CombineRgn(desired, desired, interior, RGN_DIFF);
    DeleteObject(interior);
    if combined == 0 {
        DeleteObject(desired);
        DeleteObject(current);
        return Err("Could not construct panel resize region.".into());
    }
    // SetWindowRgn sends WM_WINDOWPOSCHANGED too. Comparing first makes that nested
    // callback a no-op and avoids repainting on ordinary moves of an unchanged band.
    let unchanged = GetWindowRgn(overlay, current) != 0 && EqualRgn(current, desired) != 0;
    DeleteObject(current);
    if unchanged {
        DeleteObject(desired);
    } else if SetWindowRgn(overlay, desired, 1) == 0 {
        DeleteObject(desired);
        return Err("Could not set panel resize region.".into());
    }
    // On success Windows owns `desired`; never delete the installed region.
    Ok(())
}

#[cfg(windows)]
unsafe extern "system" fn resize_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    data: usize,
) -> isize {
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::{
            HTCLIENT, MA_ACTIVATE, SWP_HIDEWINDOW, WINDOWPOS, WM_DPICHANGED, WM_MOUSEACTIVATE,
            WM_NCDESTROY, WM_NCHITTEST, WM_SETTINGCHANGE, WM_SHOWWINDOW, WM_SIZE,
            WM_WINDOWPOSCHANGING,
        },
    };
    // This also covers core:window hide calls from the panel or document webview. Restore before
    // the native hide; no DOM cleanup or queued WindowEvent is required.
    if (message == WM_SHOWWINDOW && wparam == 0)
        || (message == WM_WINDOWPOSCHANGING
            && lparam != 0
            && (*(lparam as *const WINDOWPOS)).flags & SWP_HIDEWINDOW != 0)
    {
        let notify = (*(data as *const PanelSubclass)).will_hide.clone();
        notify();
    }
    if message == WM_MOUSEACTIVATE {
        // Explicit mouse activation does not change WS_EX_NOACTIVATE or the lifetime
        // focused(false) show mode. The click, including native resize edges, keeps focus.
        return MA_ACTIVATE as isize;
    }
    if message == WM_NCHITTEST {
        // Share the overlay's geometry and bypass Tao's broad HTTOP client strip.
        return panel_resize_hit(hwnd, lparam).map_or(HTCLIENT as isize, |hit| hit as isize);
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(resize_subclass), id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(data as *mut PanelSubclass));
        return result;
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    // Run after Tauri's WM_SIZE handler rewrites the overlay region. DPI/settings
    // changes also refresh the zone width even if the client size has not changed.
    if matches!(message, WM_SIZE | WM_DPICHANGED | WM_SETTINGCHANGE) {
        if let Err(error) = update_resize_overlay(hwnd) {
            eprintln!("{error}");
        }
    }
    result
}

/// Tauri owns this overlay's size/lifetime. Its original shadow handler returns
/// HTTOP for every pixel in SM_CYFRAME, swallowing title presses and corner directions.
/// The adapted region and hit test reserve the inner six logical pixels and delegate the
/// title interior below it to WebView2, without changing Tao's client origin.
#[cfg(windows)]
unsafe extern "system" fn overlay_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    parent: usize,
) -> isize {
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::{
            SendMessageW, HTTRANSPARENT, WM_MOUSEACTIVATE, WM_NCDESTROY, WM_NCHITTEST,
            WM_NCLBUTTONDOWN, WM_NCMBUTTONDOWN, WM_NCRBUTTONDOWN, WM_WINDOWPOSCHANGED,
        },
    };
    let parent = parent as windows_sys::Win32::Foundation::HWND;
    if message == WM_MOUSEACTIVATE {
        return SendMessageW(parent, message, wparam, lparam);
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(overlay_subclass), id);
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }
    if matches!(
        message,
        WM_NCHITTEST | WM_NCLBUTTONDOWN | WM_NCMBUTTONDOWN | WM_NCRBUTTONDOWN
    ) {
        let hit = panel_resize_hit(parent, lparam);
        if message == WM_NCHITTEST {
            return hit.map_or(HTTRANSPARENT as isize, |hit| hit as isize);
        }
        if let Some(hit) = hit {
            // Forward actual packed screen coordinates, not a pointer to POINTS.
            return SendMessageW(parent, message, hit as usize, lparam);
        }
        return 0;
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    // Tauri also resets the region outside WM_SIZE when updating shadows, and sizes
    // this child asynchronously. Catch both through its position/region notification.
    if message == WM_WINDOWPOSCHANGED {
        if let Err(error) = update_resize_overlay(parent) {
            eprintln!("{error}");
        }
    }
    result
}

#[cfg(windows)]
unsafe fn panel_resize_hit(
    hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: isize,
) -> Option<geometry::ResizeHit> {
    let rect = panel_content_rect(hwnd)?;
    geometry::resize_hit(
        (lparam as u16 as i16) as i32,
        ((lparam >> 16) as u16 as i16) as i32,
        rect,
        resize_border(hwnd),
    )
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_content_hit_test_yields_all_edges_and_corners_only() {
        for (width, height) in [(280.0, 200.0), (380.0, 520.0), (1200.0, 800.0)] {
            // The owner narrowed this to AppKit's native 2 pt band, in logical points.
            for (depth, expected) in [(0.5, true), (1.5, true), (2.5, false), (5.5, false)] {
                for (x, y) in [
                    (depth, height / 2.0),
                    (width - depth, height / 2.0),
                    (width / 2.0, depth),
                    (width / 2.0, height - depth),
                    (depth, depth),
                    (width - depth, depth),
                    (depth, height - depth),
                    (width - depth, height - depth),
                ] {
                    assert_eq!(super::macos::resize_edge(x, y, width, height), expected);
                }
            }
            for (x, y) in [
                (0.0, 0.0),
                (width / 2.0, 0.0),
                (width - 0.5, 0.0),
                (0.0, height / 2.0),
                (width - 0.5, height / 2.0),
                (0.0, height - 0.5),
                (width / 2.0, height - 0.5),
                (width - 0.5, height - 0.5),
            ] {
                assert!(super::macos::resize_edge(x, y, width, height));
            }
            for (x, y) in [
                (6.0, 6.0),
                (width - 6.5, height - 6.5),
                (6.0, height / 2.0),
                (width - 6.5, height / 2.0),
                (width / 2.0, 6.0),
                (width / 2.0, height - 6.5),
                (width / 2.0, height / 2.0),
                (-0.5, 0.0),
                (0.0, -0.5),
                (width, height / 2.0),
                (0.0, height),
            ] {
                assert!(!super::macos::resize_edge(x, y, width, height));
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_preserves_creation_traits_and_only_adds_nonactivation() {
        use objc2_app_kit::NSWindowStyleMask;
        for original in [
            NSWindowStyleMask::Borderless,
            NSWindowStyleMask::Resizable,
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
        ] {
            let style = super::macos_style(original);
            assert!(style.contains(NSWindowStyleMask::NonactivatingPanel));
            assert_eq!(
                style.contains(NSWindowStyleMask::Resizable),
                original.contains(NSWindowStyleMask::Resizable)
            );
            assert_eq!(style, original | NSWindowStyleMask::NonactivatingPanel);
            assert_eq!(super::macos_style(style), style);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_style_configuration_skips_the_setter_when_the_required_bits_are_present() {
        use objc2_app_kit::NSWindowStyleMask;
        let original = NSWindowStyleMask::Resizable | NSWindowStyleMask::Miniaturizable;
        let mut applied = None;
        super::configure_macos_style(original, |style| applied = Some(style));
        let configured = applied.expect("add nonactivation once");
        assert_eq!(configured, original | NSWindowStyleMask::NonactivatingPanel);
        super::configure_macos_style(configured, |_| panic!("must not call setStyleMask again"));
        // The function sees only the mask. A full-screen mask that already carries nonactivation
        // gets no setter call; one that lacks it gains only that bit, keeping FullScreen.
        let full_screen = original | NSWindowStyleMask::FullScreen;
        super::configure_macos_style(full_screen | NSWindowStyleMask::NonactivatingPanel, |_| {
            panic!("must not call setStyleMask on a configured full-screen mask")
        });
        let mut applied = None;
        super::configure_macos_style(full_screen, |style| applied = Some(style));
        assert_eq!(
            applied,
            Some(full_screen | NSWindowStyleMask::NonactivatingPanel)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_style_never_activates_or_creates_taskbar_entry() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };
        let style = super::extended_style(WS_EX_APPWINDOW as isize);
        assert_ne!(style & WS_EX_NOACTIVATE as isize, 0);
        assert_ne!(style & WS_EX_TOOLWINDOW as isize, 0);
        assert_eq!(style & WS_EX_APPWINDOW as isize, 0);
    }

    #[cfg(windows)]
    #[test]
    fn portable_resize_results_match_win32_hit_codes() {
        use super::geometry::ResizeHit;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
        };
        for (hit, native) in [
            (ResizeHit::Left, HTLEFT),
            (ResizeHit::Right, HTRIGHT),
            (ResizeHit::Top, HTTOP),
            (ResizeHit::Bottom, HTBOTTOM),
            (ResizeHit::TopLeft, HTTOPLEFT),
            (ResizeHit::TopRight, HTTOPRIGHT),
            (ResizeHit::BottomLeft, HTBOTTOMLEFT),
            (ResizeHit::BottomRight, HTBOTTOMRIGHT),
        ] {
            assert_eq!(hit as isize, native as isize);
        }
    }
}
