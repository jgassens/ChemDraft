//! Native palette sizing. Only a completed native resize gesture may write a frame.
//! Programmatic layout and scale events never infer user intent from WindowEvent::Resized.

use std::{collections::HashMap, sync::LazyLock, sync::Mutex};
use tauri::{Emitter, Manager, Runtime};

use super::panel_window_frame::{Frame, Monitor};

pub(super) const EVENT: &str = "chemdraft://toolbar-user-size";

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub(super) struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SizeEvent {
    toolset_id: String,
    size: Option<Size>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Mode {
    Off,
    Horizontal,
    Both,
}

#[cfg(any(target_os = "macos", windows, test))]
pub(super) fn permits_edge(mode: Option<Mode>, horizontal_edge: bool, vertical_edge: bool) -> bool {
    match mode.unwrap_or(Mode::Both) {
        Mode::Off => false,
        Mode::Horizontal => horizontal_edge,
        Mode::Both => horizontal_edge || vertical_edge,
    }
}

struct Session {
    native: usize,
    minimum: (f64, f64),
    horizontal: bool,
    installed: bool,
    user_size: Option<Size>,
    gesture: Option<(Frame, f64)>,
}

impl Session {
    fn allows_content_fit(&self, enabled: bool) -> bool {
        !enabled || (self.user_size.is_none() && self.gesture.is_none())
    }

    fn take_user_resize(
        &mut self,
        end: Option<(Frame, f64)>,
        enabled: bool,
        ready: bool,
    ) -> Option<Frame> {
        let start = self.gesture.take()?;
        let end = end?;
        (enabled && ready && completed_resize(&start, &end)).then_some(end.0)
    }
}

#[derive(Clone, Copy)]
struct SaveConditions {
    visible: bool,
    minimized: bool,
    owner_ready: bool,
    expanded: bool,
    suspended: bool,
    quitting: bool,
}

impl SaveConditions {
    fn permits(self) -> bool {
        self.visible
            && !self.minimized
            && self.owner_ready
            && !self.expanded
            && !self.suspended
            && !self.quitting
    }
}

#[derive(Default)]
struct Registry {
    enabled: bool,
    sessions: HashMap<String, Session>,
}

impl Registry {
    fn set_enabled(&mut self, enabled: bool) -> bool {
        if self.enabled == enabled {
            return false;
        }
        self.enabled = enabled;
        for session in self.sessions.values_mut() {
            session.gesture = None;
        }
        true
    }
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

pub(super) fn minimum(width: f64, height: f64) -> Result<(f64, f64), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Toolbar minimum dimensions must be positive finite logical pixels.".into());
    }
    Ok((width.max(96.0), height.max(56.0)))
}

pub(super) fn palette_id<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<String, String> {
    super::toolset_id_for_window_label(window.app_handle(), window.label())
        .ok_or_else(|| "Only a registered toolbar palette may control its size.".into())
}

pub(super) fn authorize_preference<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    if window.label() == super::MAIN_WINDOW_LABEL
        || window.label() == super::PREFERENCES_WINDOW_LABEL
        || palette_id(window).is_ok()
    {
        Ok(())
    } else {
        Err("Only Preferences, the document, or a toolbar may set toolbar resizing.".into())
    }
}

#[cfg(target_os = "macos")]
fn native_id<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<usize, String> {
    window
        .ns_window()
        .map(|p| p as usize)
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn native_id<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<usize, String> {
    window
        .hwnd()
        .map(|p| p.0 as usize)
        .map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn native_id<R: Runtime>(_window: &tauri::WebviewWindow<R>) -> Result<usize, String> {
    Ok(0)
}

// None means an ordinary plugin panel: preserve its existing all-edge policy.
#[cfg(any(target_os = "macos", windows, test))]
pub(super) fn mode(native: usize) -> Option<Mode> {
    let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    let session = registry.sessions.values().find(|s| s.native == native)?;
    Some(if !registry.enabled {
        Mode::Off
    } else if session.horizontal {
        Mode::Horizontal
    } else {
        Mode::Both
    })
}

pub(super) fn user_size<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<Option<Size>, String> {
    palette_id(window)?;
    let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    Ok(if registry.enabled {
        registry
            .sessions
            .get(window.label())
            .and_then(|s| s.user_size)
    } else {
        None
    })
}

fn notify<R: Runtime>(window: &tauri::WebviewWindow<R>, id: &str) {
    let _ = window.emit_to(
        window.label(),
        EVENT,
        SizeEvent {
            toolset_id: id.into(),
            size: user_size(window).ok().flatten(),
        },
    );
}

pub(super) fn set_enabled<R: Runtime>(
    caller: &tauri::WebviewWindow<R>,
    enabled: bool,
) -> Result<(), String> {
    {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        if !registry.set_enabled(enabled) {
            return Ok(());
        }
    }
    let app = caller.app_handle();
    let entries = app
        .state::<super::ToolsetWindowDirectory>()
        .labels
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    for (label, id) in entries {
        if let Some(window) = app.get_webview_window(&label) {
            configure(&window, &id, None, true)?;
        }
    }
    // Disabling deliberately never touches the saved frames.
    Ok(())
}

pub(super) fn configure<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    id: &str,
    requested_minimum: Option<(f64, f64)>,
    restore: bool,
) -> Result<(), String> {
    let target = window.clone();
    let id = id.to_string();
    super::run_on_main_thread_blocking(window, move || {
        configure_on_main(&target, &id, requested_minimum, restore)
    })?
}

fn configure_on_main<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    id: &str,
    requested_minimum: Option<(f64, f64)>,
    restore: bool,
) -> Result<(), String> {
    let native = native_id(window)?;
    let (enabled, installed) = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let enabled = registry.enabled;
        let session = registry
            .sessions
            .entry(window.label().into())
            .or_insert(Session {
                native,
                minimum: (96.0, 56.0),
                horizontal: id == "core.main",
                installed: false,
                user_size: None,
                gesture: None,
            });
        if let Some(minimum) = requested_minimum {
            session.minimum = minimum;
        }
        // Reconfiguration is programmatic, even if it interrupts a native drag.
        session.gesture = None;
        (enabled, session.installed)
    };
    if enabled {
        limits(window)?;
        if !installed {
            super::panel_window::install_resize_hit_test(window)?;
            REGISTRY
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .sessions
                .get_mut(window.label())
                .unwrap()
                .installed = true;
        }
        if restore && !super::utility_windows_suspended() && !super::quit_in_progress() {
            if let Some(frame) = super::load_toolset_layout_state(window.app_handle())
                .toolsets
                .get(id)
                .and_then(|s| s.frame.clone())
            {
                apply_frame(window, &frame)?;
            }
        }
    } else if installed {
        window
            .set_min_size(Some(tauri::LogicalSize::new(96.0, 56.0)))
            .map_err(|e| e.to_string())?;
        window
            .set_max_size(None::<tauri::LogicalSize<f64>>)
            .map_err(|e| e.to_string())?;
    }
    if installed || enabled {
        super::panel_window::refresh_resize_hit_test(window)?;
    }
    notify(window, id);
    Ok(())
}

fn size_limits(
    minimum: (f64, f64),
    area: super::ScreenRect,
    height: f64,
    horizontal: bool,
) -> (Size, Size) {
    let min = (minimum.0.min(area.width), minimum.1.min(area.height));
    let fixed = height.clamp(min.1, area.height);
    (
        Size {
            width: min.0,
            height: if horizontal { fixed } else { min.1 },
        },
        Size {
            width: area.width,
            height: if horizontal { fixed } else { area.height },
        },
    )
}

fn limits<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let m = Monitor::from_native(&monitor);
    let (minimum, horizontal) = {
        let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let Some(session) = registry.sessions.get(window.label()) else {
            return Ok(());
        };
        (session.minimum, session.horizontal)
    };
    let height = f64::from(window.inner_size().map_err(|e| e.to_string())?.height) / m.scale;
    let (minimum, maximum) = size_limits(minimum, m.work_area, height, horizontal);
    window
        .set_min_size(Some(tauri::LogicalSize::new(minimum.width, minimum.height)))
        .map_err(|e| e.to_string())?;
    window
        .set_max_size(Some(tauri::LogicalSize::new(maximum.width, maximum.height)))
        .map_err(|e| e.to_string())
}

fn apply_frame<R: Runtime>(window: &tauri::WebviewWindow<R>, frame: &Frame) -> Result<(), String> {
    let monitors: Vec<_> = window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(Monitor::from_native)
        .collect();
    let (minimum, horizontal) = {
        let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let session = &registry.sessions[window.label()];
        (session.minimum, session.horizontal)
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let height = f64::from(window.inner_size().map_err(|e| e.to_string())?.height) / scale;
    if let Some(placement) = frame.restore_toolbar(&monitors, minimum, horizontal.then_some(height))
    {
        cancel(window.label());
        // Clear stale source-monitor constraints before applying a destination-scale frame.
        window
            .set_max_size(None::<tauri::LogicalSize<f64>>)
            .map_err(|e| e.to_string())?;
        window
            .set_min_size(Some(tauri::LogicalSize::new(1.0, 1.0)))
            .map_err(|e| e.to_string())?;
        let webview: &tauri::Webview<R> = window.as_ref();
        super::panel_full_size::apply(&webview.window(), placement)?;
        limits(window)?;
        let size = Size {
            width: f64::from(placement.size.0) / placement.scale,
            height: f64::from(placement.size.1) / placement.scale,
        };
        REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sessions
            .get_mut(window.label())
            .unwrap()
            .user_size = Some(size);
    }
    Ok(())
}

fn live_frame<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<(Frame, f64)> {
    let monitor = Monitor::from_native(&window.current_monitor().ok()??);
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some((
        Frame::from_physical((pos.x, pos.y), (size.width, size.height), &monitor)?,
        monitor.scale,
    ))
}

fn can_save<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let owner_ready = window
        .app_handle()
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .is_some_and(|owner| {
            owner.is_visible().unwrap_or(false) && !owner.is_minimized().unwrap_or(true)
        });
    SaveConditions {
        visible: window.is_visible().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(true),
        owner_ready,
        expanded: window.is_maximized().unwrap_or(true) || window.is_fullscreen().unwrap_or(true),
        suspended: super::utility_windows_suspended(),
        quitting: super::quit_in_progress(),
    }
    .permits()
}

pub(super) fn cancel(label: &str) {
    if let Some(session) = REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .get_mut(label)
    {
        session.gesture = None;
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn begin<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if palette_id(window).is_err() || !can_save(window) {
        return;
    }
    if !REGISTRY.lock().unwrap_or_else(|p| p.into_inner()).enabled {
        return;
    }
    if let Err(error) = limits(window) {
        eprintln!("Could not set toolbar resize limits: {error}");
        return;
    }
    let sample = live_frame(window);
    let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
    if registry.enabled {
        if let Some(session) = registry.sessions.get_mut(window.label()) {
            session.gesture = sample;
        }
    }
}

fn completed_resize(start: &(Frame, f64), end: &(Frame, f64)) -> bool {
    start.1 == end.1
        && ((start.0.width - end.0.width).abs() > 0.5
            || (start.0.height - end.0.height).abs() > 0.5)
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn end<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(id) = palette_id(window) else {
        return;
    };
    let ready = can_save(window);
    let live = live_frame(window);
    let frame = {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let enabled = registry.enabled;
        registry
            .sessions
            .get_mut(window.label())
            .and_then(|session| session.take_user_resize(live, enabled, ready))
    };
    let Some(frame) = frame else {
        return;
    };
    let size = Size {
        width: frame.width,
        height: frame.height,
    };
    let result = super::update_toolset_layout_state(window.app_handle(), |state| {
        state.toolsets.entry(id.clone()).or_default().frame = Some(frame);
    });
    if let Err(error) = result {
        eprintln!("Could not save toolbar size {id}: {error}");
        return;
    }
    REGISTRY
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .sessions
        .get_mut(window.label())
        .unwrap()
        .user_size = Some(size);
    notify(window, &id);
}

pub(super) fn window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        REGISTRY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sessions
            .remove(window.label());
    } else if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. }) {
        cancel(window.label());
    }
    if matches!(
        event,
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
    ) && !super::utility_windows_suspended()
        && !super::quit_in_progress()
    {
        if let Some(target) = window.app_handle().get_webview_window(window.label()) {
            if !can_save(&target) {
                cancel(window.label());
                return;
            }
            if REGISTRY.lock().unwrap_or_else(|p| p.into_inner()).enabled {
                if let Err(error) = limits(&target) {
                    eprintln!("Could not refresh toolbar limits: {error}");
                }
            }
        }
    }
}

fn fit_position(
    position: super::ToolsetWindowPosition,
    monitor: &Monitor,
    width: f64,
    height: f64,
) -> super::ToolsetWindowPosition {
    let left = f64::from(monitor.identity.position.0) / monitor.scale + monitor.work_area.x;
    let top = f64::from(monitor.identity.position.1) / monitor.scale + monitor.work_area.y;
    super::ToolsetWindowPosition {
        x: position
            .x
            .min(left + monitor.work_area.width - width)
            .max(left),
        y: position
            .y
            .min(top + monitor.work_area.height - height)
            .max(top),
    }
}

fn fit_dimensions(width: f64, height: f64, monitor: Option<&Monitor>, enabled: bool) -> Size {
    Size {
        width: if enabled {
            monitor.map_or(width, |m| width.min(m.work_area.width))
        } else {
            width
        },
        height: monitor.map_or(height, |m| height.min(m.work_area.height)),
    }
}

fn fit_needs_move(
    resized: Option<super::ToolsetWindowPosition>,
    target: &super::ToolsetWindowPosition,
) -> bool {
    resized.is_none_or(|p| p.x != target.x || p.y != target.y)
}

pub(super) fn fit<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Toolbar fit dimensions must be positive finite logical pixels.".into());
    }
    let (enabled, horizontal) = {
        let registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        let session = registry.sessions.get(window.label());
        if session.is_some_and(|s| !s.allows_content_fit(registry.enabled)) {
            return Ok(());
        }
        (registry.enabled, session.is_some_and(|s| s.horizontal))
    };
    if enabled && !can_save(window) {
        return Ok(());
    }
    cancel(window.label());
    if enabled && horizontal {
        // A content fit establishes Main's one-row height before any user width is saved.
        window
            .set_min_size(Some(tauri::LogicalSize::new(96.0, 56.0)))
            .map_err(|e| e.to_string())?;
        window
            .set_max_size(None::<tauri::LogicalSize<f64>>)
            .map_err(|e| e.to_string())?;
    }
    // Keep the existing top-left/content-fit behavior, using the destination work area.
    let position = super::current_toolset_window_position(window);
    let m = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .map(|m| Monitor::from_native(&m));
    let Size { width, height } = fit_dimensions(width, height, m.as_ref(), enabled);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    if let Some(position) = position {
        let target = if let Some(m) = m {
            fit_position(position, &m, width, height)
        } else {
            position
        };
        let resized = super::current_toolset_window_position(window);
        if fit_needs_move(resized, &target) {
            super::set_window_global_logical_position(window, target.x, target.y)?;
        }
    }
    if enabled {
        limits(window)?;
    }
    Ok(())
}

pub(super) fn reset<R: Runtime>(caller: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if super::utility_windows_suspended() || super::quit_in_progress() {
        return Err(
            "Toolbar sizes cannot be reset while utilities are suspended or quitting.".into(),
        );
    }
    super::update_toolset_layout_state(caller.app_handle(), clear_frames)?;
    {
        let mut registry = REGISTRY.lock().unwrap_or_else(|p| p.into_inner());
        for session in registry.sessions.values_mut() {
            session.gesture = None;
            session.user_size = None;
        }
    }
    let entries = caller
        .state::<super::ToolsetWindowDirectory>()
        .labels
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    for (label, id) in entries {
        if let Some(window) = caller.app_handle().get_webview_window(&label) {
            notify(&window, &id);
        }
    }
    Ok(())
}

fn clear_frames(state: &mut super::ToolsetLayoutState) {
    for toolset in state.toolsets.values_mut() {
        toolset.frame = None;
    }
}

#[cfg(test)]
mod tests {
    use super::super::panel_window_frame::MonitorIdentity;
    use super::super::{PersistedToolsetState, ScreenRect, ToolsetLayoutState};
    use super::*;

    fn monitor(origin: (i32, i32), scale: f64) -> Monitor {
        Monitor {
            identity: MonitorIdentity {
                name: Some(format!("display-{}", origin.0)),
                position: origin,
                size: (1920, 1600),
            },
            scale,
            work_area: ScreenRect::new(0.0, 25.0, 1920.0 / scale, 1600.0 / scale - 25.0),
        }
    }

    fn frame(m: &Monitor) -> Frame {
        Frame {
            monitor: m.identity.clone(),
            x: 100.0,
            y: 80.0,
            width: 180.0,
            height: 120.0,
        }
    }

    fn session() -> Session {
        Session {
            native: 1,
            minimum: (96.0, 56.0),
            horizontal: false,
            installed: false,
            user_size: None,
            gesture: None,
        }
    }

    fn ready() -> SaveConditions {
        SaveConditions {
            visible: true,
            minimized: false,
            owner_ready: true,
            expanded: false,
            suspended: false,
            quitting: false,
        }
    }

    #[test]
    fn toolbar_frames_round_trip_at_both_scales_across_monitors() {
        for origin in [(0, 0), (1920, -100), (-1920, 100)] {
            for scale in [1.0, 2.0] {
                let m = monitor(origin, scale);
                let saved = frame(&m);
                let placement = saved
                    .restore_toolbar(&[monitor((3840, 0), 1.0), m.clone()], (96.0, 56.0), None)
                    .unwrap();
                assert_eq!(placement.scale, scale);
                assert_eq!(
                    Frame::from_physical(placement.position, placement.size, &m),
                    Some(saved)
                );
            }
        }
        let original = monitor((1920, 0), 2.0);
        let saved = frame(&original);
        let destination = Monitor {
            scale: 1.0,
            ..original
        };
        let placement = saved
            .restore_toolbar(&[destination], (96.0, 56.0), None)
            .unwrap();
        assert_eq!(placement.size, (180, 120));
        assert_eq!(placement.position, (2020, 80));
    }

    #[test]
    fn missing_monitor_and_oversize_frames_clamp_to_the_destination_work_area() {
        let removed = monitor((-3840, 0), 1.0);
        let destination = monitor((1920, 0), 2.0);
        let saved = Frame {
            x: -2000.0,
            y: 3000.0,
            width: 5000.0,
            height: 4000.0,
            ..frame(&removed)
        };
        let p = saved
            .restore_toolbar(&[destination], (96.0, 56.0), None)
            .unwrap();
        assert_eq!(p.position, (1920, 50));
        assert_eq!(p.size, (1920, 1550));
        assert_eq!(p.scale, 2.0);
        assert!(saved.restore_toolbar(&[], (96.0, 56.0), None).is_none());
    }

    #[test]
    fn toolbar_minimum_combines_the_native_floor_and_tool_cell_and_title() {
        assert_eq!(minimum(32.0, 48.0).unwrap(), (96.0, 56.0));
        assert_eq!(minimum(120.0, 80.0).unwrap(), (120.0, 80.0));
        for bad in [f64::NAN, f64::INFINITY, 0.0, -1.0] {
            assert!(minimum(bad, 80.0).is_err());
            assert!(minimum(120.0, bad).is_err());
        }
        let m = monitor((0, 0), 2.0);
        let tiny = Frame {
            width: 1.0,
            height: 1.0,
            ..frame(&m)
        };
        assert_eq!(
            tiny.restore_toolbar(std::slice::from_ref(&m), (120.0, 80.0), None)
                .unwrap()
                .size,
            (240, 160)
        );
        // The work area always wins over an impossible requested minimum.
        assert_eq!(
            tiny.restore_toolbar(&[m], (5000.0, 5000.0), None)
                .unwrap()
                .size,
            (1920, 1550)
        );
    }

    #[test]
    fn native_limits_cap_both_axes_and_pin_main_height() {
        let area = super::super::ScreenRect::new(0.0, 25.0, 960.0, 775.0);
        let (min, max) = size_limits((120.0, 80.0), area, 60.0, false);
        assert_eq!(
            min,
            Size {
                width: 120.0,
                height: 80.0
            }
        );
        assert_eq!(
            max,
            Size {
                width: 960.0,
                height: 775.0
            }
        );
        let (min, max) = size_limits((96.0, 56.0), area, 60.0, true);
        assert_eq!(
            min,
            Size {
                width: 96.0,
                height: 60.0
            }
        );
        assert_eq!(
            max,
            Size {
                width: 960.0,
                height: 60.0
            }
        );
        let (min, max) = size_limits((5000.0, 5000.0), area, 60.0, false);
        assert_eq!(min, max);
    }

    #[test]
    fn main_hit_policy_has_only_horizontal_edges_and_preference_off_has_none() {
        for horizontal in [true, false] {
            for vertical in [true, false] {
                assert!(!permits_edge(Some(Mode::Off), horizontal, vertical));
                assert_eq!(
                    permits_edge(Some(Mode::Horizontal), horizontal, vertical),
                    horizontal
                );
                assert_eq!(
                    permits_edge(Some(Mode::Both), horizontal, vertical),
                    horizontal || vertical
                );
                // An ordinary plugin panel keeps its existing all-edge hit test.
                assert_eq!(
                    permits_edge(None, horizontal, vertical),
                    horizontal || vertical
                );
            }
        }
    }

    #[test]
    fn main_restores_width_but_keeps_its_current_one_row_height() {
        let m = monitor((0, 0), 2.0);
        let saved = Frame {
            width: 700.0,
            height: 500.0,
            ..frame(&m)
        };
        let p = saved
            .restore_toolbar(&[m], (96.0, 56.0), Some(60.0))
            .unwrap();
        assert_eq!(p.size, (1400, 120));
    }

    #[test]
    fn only_a_completed_user_resize_can_produce_a_frame_to_save() {
        let start = (frame(&monitor((0, 0), 1.0)), 1.0);
        let end = (
            Frame {
                width: 250.0,
                ..start.0.clone()
            },
            1.0,
        );
        let mut state = session();
        assert!(state.allows_content_fit(true));
        state.user_size = Some(Size {
            width: 180.0,
            height: 120.0,
        });
        assert!(!state.allows_content_fit(true));
        assert!(state.allows_content_fit(false));
        state.user_size = None;
        // A programmatic fit has no native gesture token.
        assert!(state
            .take_user_resize(Some(end.clone()), true, true)
            .is_none());
        state.gesture = Some(start.clone());
        assert!(!state.allows_content_fit(true));
        assert_eq!(
            state.take_user_resize(Some(end.clone()), true, true),
            Some(end.0.clone())
        );
        // The gesture token is consumed; queued resize notifications cannot save again.
        assert!(state
            .take_user_resize(Some(end.clone()), true, true)
            .is_none());
        state.gesture = Some(start.clone());
        let moved = (
            Frame {
                x: 200.0,
                ..start.0.clone()
            },
            1.0,
        );
        assert!(state.take_user_resize(Some(moved), true, true).is_none());
        // A scale change during a native gesture invalidates its result.
        state.gesture = Some(start.clone());
        assert!(state
            .take_user_resize(Some((end.0.clone(), 2.0)), true, true)
            .is_none());
        // Cancelled, missing-native-frame and preference-off paths fail closed.
        state.gesture = Some(start.clone());
        assert!(state.take_user_resize(None, true, true).is_none());
        state.gesture = Some(start);
        assert!(state.take_user_resize(Some(end), false, true).is_none());
    }

    #[test]
    fn minimized_owner_suspension_quit_and_hidden_or_expanded_windows_never_save() {
        let blocked = [
            SaveConditions {
                minimized: true,
                ..ready()
            },
            SaveConditions {
                owner_ready: false,
                ..ready()
            },
            SaveConditions {
                suspended: true,
                ..ready()
            },
            SaveConditions {
                quitting: true,
                ..ready()
            },
            SaveConditions {
                visible: false,
                ..ready()
            },
            SaveConditions {
                expanded: true,
                ..ready()
            },
        ];
        for conditions in blocked {
            assert!(!conditions.permits());
            let mut state = session();
            let start = frame(&monitor((0, 0), 1.0));
            state.gesture = Some((start.clone(), 1.0));
            assert!(state
                .take_user_resize(
                    Some((
                        Frame {
                            width: 250.0,
                            ..start
                        },
                        1.0
                    )),
                    true,
                    conditions.permits(),
                )
                .is_none());
        }
    }

    #[test]
    fn preference_off_retains_frames_and_reset_removes_only_frames() {
        let saved = frame(&monitor((0, 0), 1.0));
        let mut layout = ToolsetLayoutState::default();
        layout.toolsets.insert(
            "core.main".into(),
            PersistedToolsetState {
                x: Some(12.0),
                y: Some(34.0),
                frame: Some(saved.clone()),
            },
        );
        layout
            .plugin_panels
            .insert("panel.example".into(), saved.clone());
        let original = serde_json::to_string(&layout).unwrap();
        let mut registry = Registry::default();
        let mut palette = session();
        palette.user_size = Some(Size {
            width: 180.0,
            height: 120.0,
        });
        palette.gesture = Some((saved.clone(), 1.0));
        registry
            .sessions
            .insert("toolset-core-main".into(), palette);
        assert!(registry.set_enabled(true));
        assert!(registry.set_enabled(false));
        assert!(!registry.set_enabled(false));
        assert!(registry.sessions["toolset-core-main"].gesture.is_none());
        assert!(registry.sessions["toolset-core-main"].user_size.is_some());
        assert_eq!(serde_json::to_string(&layout).unwrap(), original);
        let decoded: ToolsetLayoutState = serde_json::from_str(&original).unwrap();
        assert_eq!(decoded.toolsets["core.main"].frame, Some(saved.clone()));
        clear_frames(&mut layout);
        assert!(layout.toolsets["core.main"].frame.is_none());
        assert_eq!(layout.toolsets["core.main"].x, Some(12.0));
        assert_eq!(layout.toolsets["core.main"].y, Some(34.0));
        assert_eq!(layout.plugin_panels["panel.example"], saved);
        assert!(!serde_json::to_string(&layout)
            .unwrap()
            .contains("\"frame\""));
    }

    // Frozen 1.2 reader definitions, copied before adding PersistedToolsetState::frame.
    // Also checked against tag v1.1.1: its two readers have these same fields and are
    // tolerant too. Neither level uses deny_unknown_fields. Do not add new fields here.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Toolset12 {
        x: Option<f64>,
        y: Option<f64>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Layout12 {
        version: u32,
        toolsets: HashMap<String, Toolset12>,
        #[serde(default)]
        main_window: Option<super::super::MainWindowGeometry>,
        #[serde(default)]
        plugin_panels: HashMap<String, Frame>,
    }

    #[test]
    fn toolbar_state_written_with_frames_is_accepted_by_the_frozen_12_reader() {
        let mut layout = ToolsetLayoutState::default();
        layout.toolsets.insert(
            "core.main".into(),
            PersistedToolsetState {
                x: Some(12.0),
                y: Some(34.0),
                frame: Some(frame(&monitor((1920, 0), 2.0))),
            },
        );
        let json = serde_json::to_string_pretty(&layout).unwrap();
        assert!(json.contains("\"frame\""));
        let old: Layout12 = serde_json::from_str(&json).unwrap();
        assert_eq!(old.version, 1);
        assert_eq!(old.toolsets["core.main"].x, Some(12.0));
        assert_eq!(old.toolsets["core.main"].y, Some(34.0));
        assert!(old.main_window.is_none());
        assert!(old.plugin_panels.is_empty());
    }

    #[test]
    fn content_fit_preserves_the_old_whole_window_work_area_clamp_at_both_scales() {
        for scale in [1.0, 2.0] {
            let m = Monitor {
                work_area: ScreenRect::new(0.0, 24.0, 1920.0, 1016.0),
                ..monitor((0, 0), scale)
            };
            let size = fit_dimensions(553.0, 1214.0, Some(&m), false);
            assert_eq!(
                size,
                Size {
                    width: 553.0,
                    height: 1016.0
                }
            );
            let p = fit_position(
                super::super::ToolsetWindowPosition {
                    x: 1500.0,
                    y: 700.0,
                },
                &m,
                size.width,
                size.height,
            );
            assert_eq!((p.x, p.y), (1367.0, 24.0));
            let p = fit_position(
                super::super::ToolsetWindowPosition { x: 100.0, y: 100.0 },
                &m,
                520.0,
                600.0,
            );
            assert_eq!((p.x, p.y), (100.0, 100.0));
            assert!(fit_needs_move(
                Some(super::super::ToolsetWindowPosition {
                    x: 100.0,
                    y: -200.0
                }),
                &p
            ));
            assert!(!fit_needs_move(
                Some(super::super::ToolsetWindowPosition { x: 100.0, y: 100.0 }),
                &p
            ));
        }
    }
}
