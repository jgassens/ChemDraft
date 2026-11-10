//! Native palette size ownership. All window mutations run together on the UI thread.

use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{Emitter, Manager, Runtime};

use super::palette_geometry::{ContentSize, Orientation, ResizeSave, WorkArea};

pub(super) const EVENT: &str = "chemdraft://toolset-window-size";

#[derive(Default)]
pub(super) struct State(Mutex<HashMap<String, Entry>>);

struct Entry {
    content: ContentSize,
    chosen_length: Option<f64>,
    save: ResizeSave,
    monitor: Option<MonitorKey>,
    dirty: bool,
    status: Status,
}

type MonitorKey = ((i32, i32), (u32, u32), f64);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    toolset_id: String,
    orientation: Orientation,
    /// Actual, clamped inner length. `savedLength` retains the user's preference across auto-fits.
    length: f64,
    saved_length: Option<f64>,
    min_length: f64,
    max_length: f64,
    width: f64,
    height: f64,
}

pub(super) fn initialize<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    toolset_id: &str,
    content: ContentSize,
) {
    let saved = super::load_toolset_layout_state(app)
        .toolsets
        .get(toolset_id)
        .and_then(|geometry| geometry.length)
        .filter(|length| length.is_finite() && *length > 0.0);
    let limits = content.constraints(None);
    let length = limits.clamp(saved);
    let (width, height) = limits.size(length);
    app.state::<State>().0.lock().unwrap().insert(
        label.into(),
        Entry {
            content,
            chosen_length: saved,
            save: ResizeSave::default(),
            monitor: None,
            dirty: true,
            status: Status {
                toolset_id: toolset_id.into(),
                orientation: content.orientation,
                length,
                saved_length: saved,
                min_length: limits.minimum,
                max_length: limits.maximum,
                width,
                height,
            },
        },
    );
}

fn authorize<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if super::toolset_id_for_window_label(window.app_handle(), window.label()).is_some() {
        Ok(())
    } else {
        Err("Only a registered toolbar palette may report or read its size.".into())
    }
}

/// No caller-supplied window label or toolset id: a palette can affect only itself.
#[tauri::command]
pub(super) async fn report_toolset_content_size(
    window: tauri::WebviewWindow,
    size: ContentSize,
) -> Result<Status, String> {
    authorize(&window)?;
    let content = size.validate()?;
    let target = window.clone();
    super::run_on_main_thread_blocking(&window, move || {
        let webview: &tauri::Webview = target.as_ref();
        let native = webview.window();
        let changed = {
            let state = native.state::<State>();
            let mut entries = state.0.lock().unwrap();
            let entry = entries
                .get_mut(native.label())
                .ok_or("Palette size state is missing.")?;
            let changed = entry.content != content;
            entry.content = content;
            entry.dirty |= changed;
            changed
        };
        apply(&native, changed)
    })?
}

#[tauri::command]
pub(super) fn get_toolset_window_size(window: tauri::WebviewWindow) -> Result<Status, String> {
    authorize(&window)?;
    window
        .state::<State>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .map(|entry| entry.status.clone())
        .ok_or_else(|| "Palette size state is missing.".into())
}

fn monitor_key(monitor: &tauri::Monitor) -> MonitorKey {
    let area = monitor.work_area();
    (
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        monitor.scale_factor(),
    )
}

/// Reopening on another monitor (including after unplugging one) happens before show. Resolve
/// persisted logical coordinates against each destination scale, then move in physical pixels.
pub(super) fn restore<R: Runtime>(
    window: &tauri::Window<R>,
    initial_position: Option<(f64, f64)>,
) -> Result<Status, String> {
    if super::toolset_frame_is_transient(window.app_handle(), window) {
        return apply(window, false);
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let live_position = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let (x, y) = initial_position.unwrap_or((live_position.x, live_position.y));
    let monitors = window.app_handle().available_monitors().unwrap_or_default();
    let contains = |monitor: &tauri::Monitor| {
        let (position_px, size_px, scale) = monitor_key(monitor);
        WorkArea::from_physical(position_px, size_px, scale).contains(x, y)
    };
    // Logical global rectangles can overlap at mixed scales. A live window's known destination
    // wins that ambiguity; otherwise reopening can jump a palette onto the primary display.
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .filter(contains)
        .or_else(|| monitors.iter().find(|monitor| contains(monitor)).cloned())
        .or_else(|| window.app_handle().primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let (origin, size, scale) = monitor_key(&monitor);
        let area = WorkArea::from_physical(origin, size, scale);
        flush_pending(window);
        let (target, target_size) = {
            let state = window.state::<State>();
            let mut entries = state.0.lock().unwrap();
            let entry = entries
                .get_mut(window.label())
                .ok_or("Palette size state is missing.")?;
            entry.save.begin_programmatic();
            let limits = entry.content.constraints(Some(
                entry.content.orientation.length(area.width, area.height),
            ));
            let size = limits.size(limits.clamp(entry.chosen_length));
            (area.clamp_position(x, y, size), size)
        };
        let result = apply_frame(window, target, target_size, scale);
        if let Some(entry) = window
            .state::<State>()
            .0
            .lock()
            .unwrap()
            .get_mut(window.label())
        {
            entry.save.end_programmatic();
        }
        result?;
    }
    apply(window, true)
}

pub(super) fn apply<R: Runtime>(window: &tauri::Window<R>, force: bool) -> Result<Status, String> {
    let state = window.state::<State>();
    if super::toolset_frame_is_transient(window.app_handle(), window)
        || super::utility_windows_suspended()
    {
        return state
            .0
            .lock()
            .unwrap()
            .get(window.label())
            .map(|entry| entry.status.clone())
            .ok_or_else(|| "Palette size state is missing.".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let position = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.app_handle().primary_monitor().ok().flatten());
    let key = monitor.as_ref().map(monitor_key);
    let (content, chosen) = {
        let mut entries = state.0.lock().unwrap();
        let entry = entries
            .get_mut(window.label())
            .ok_or("Palette size state is missing.")?;
        if entry.save.is_programmatic() || (!force && !entry.dirty && entry.monitor == key) {
            return Ok(entry.status.clone());
        }
        (entry.content, entry.chosen_length)
    };
    // A content/monitor change must retain the last confirmed user drag, even inside the debounce
    // interval. Flush that sampled length before entering the programmatic mutation guard.
    flush_pending(window);
    let area = key.map(|(position, size, scale)| WorkArea::from_physical(position, size, scale));
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let border_width = f64::from(outer.width.saturating_sub(inner.width)) / scale;
    let border_height = f64::from(outer.height.saturating_sub(inner.height)) / scale;
    if let Some(entry) = state.0.lock().unwrap().get_mut(window.label()) {
        entry.save.begin_programmatic();
    }
    let limits = content.constraints(area.map(|area| {
        content.orientation.length(
            (area.width - border_width).max(1.0),
            (area.height - border_height).max(1.0),
        )
    }));
    let length = limits.clamp(chosen);
    let (width, height) = limits.size(length);
    let target_position = area.map(|area| {
        area.clamp_position(
            position.x,
            position.y,
            (width + border_width, height + border_height),
        )
    });
    // Clear the old limits before applying a different orientation or a smaller full-content size.
    // The programmatic guard spans synchronous native callbacks, including during a live drag.
    let result = (|| {
        window
            .set_min_size(None::<tauri::LogicalSize<f64>>)
            .map_err(|e| e.to_string())?;
        window
            .set_max_size(None::<tauri::LogicalSize<f64>>)
            .map_err(|e| e.to_string())?;
        window
            .set_min_size(Some(tauri::LogicalSize::<f64>::from(
                limits.size(limits.minimum),
            )))
            .map_err(|e| e.to_string())?;
        window
            .set_max_size(Some(tauri::LogicalSize::<f64>::from(
                limits.size(limits.maximum),
            )))
            .map_err(|e| e.to_string())?;
        super::palette_resize_native::constrain(
            window,
            content.orientation,
            limits.size(limits.minimum),
            limits.size(limits.maximum),
        )?;
        // Destination scale is also used for an unplugged monitor's restored frame.
        let destination_scale = key.map_or(scale, |(_, _, scale)| scale);
        apply_frame(
            window,
            target_position.unwrap_or((position.x, position.y)),
            (width, height),
            destination_scale,
        )?;
        Ok::<(), String>(())
    })();
    let status = {
        let mut entries = state.0.lock().unwrap();
        let entry = entries
            .get_mut(window.label())
            .ok_or("Palette size state is missing.")?;
        entry.save.end_programmatic();
        if result.is_ok() {
            entry.monitor = key;
            entry.dirty = false;
            entry.status = Status {
                toolset_id: entry.status.toolset_id.clone(),
                orientation: content.orientation,
                length,
                saved_length: chosen,
                min_length: limits.minimum,
                max_length: limits.maximum,
                width,
                height,
            };
        }
        entry.status.clone()
    };
    result?;
    window
        .emit_to(window.label(), EVENT, &status)
        .map_err(|e| e.to_string())?;
    Ok(status)
}

fn apply_frame<R: Runtime>(
    window: &tauri::Window<R>,
    position: (f64, f64),
    size: (f64, f64),
    scale: f64,
) -> Result<(), String> {
    let position = tauri::LogicalPosition::new(position.0, position.1).to_physical::<i32>(scale);
    let size = tauri::LogicalSize::new(size.0, size.1).to_physical::<u32>(scale);
    // Reuse the synchronous utility-frame helper. Pinned tao queues AppKit set_size/set_position
    // even on the UI thread; those callbacks would otherwise escape our auto-fit guard and the
    // first show could precede restoring the user's length. Windows uses normal Tauri setters.
    super::panel_full_size::apply(
        window,
        super::panel_window_frame::Placement {
            position: (position.x, position.y),
            size: (size.width, size.height),
            scale,
        },
    )
}

/// Called synchronously by native edge tracking, never by generic queued Resized events.
/// Merely moving, DPI transitions, set_size and minimizing cannot enter this save path.
pub(super) fn user_resized<R: Runtime>(window: &tauri::Window<R>) {
    let transient = super::toolset_frame_is_transient(window.app_handle(), window)
        || super::utility_windows_suspended();
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    let (generation, status) = {
        let state = window.state::<State>();
        let mut entries = state.0.lock().unwrap();
        let Some(entry) = entries.get_mut(window.label()) else {
            return;
        };
        let length = entry.content.orientation.length(size.width, size.height);
        let Some(generation) = entry.save.user_resize(length, transient) else {
            return;
        };
        entry.chosen_length = Some(length);
        entry.status.length = length;
        entry.status.saved_length = Some(length);
        entry.status.width = size.width;
        entry.status.height = size.height;
        (generation, entry.status.clone())
    };
    let _ = window.emit_to(window.label(), EVENT, status);
    let target = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let callback_window = target.clone();
        let _ = target.run_on_main_thread(move || save_user_length(&callback_window, generation));
    });
}

fn save_user_length<R: Runtime>(window: &tauri::Window<R>, generation: u64) {
    let transient = super::toolset_frame_is_transient(window.app_handle(), window)
        || super::utility_windows_suspended()
        || super::APP_QUITTING.load(super::Ordering::SeqCst);
    let pending = {
        let state = window.state::<State>();
        let mut entries = state.0.lock().unwrap();
        entries.get_mut(window.label()).and_then(|entry| {
            entry
                .save
                .take(generation, transient)
                .map(|length| (entry.status.toolset_id.clone(), length))
        })
    };
    persist_pending(window, pending);
}

pub(super) fn flush_pending<R: Runtime>(window: &tauri::Window<R>) {
    let transient = super::toolset_frame_is_transient(window.app_handle(), window)
        || super::utility_windows_suspended();
    let pending = {
        let state = window.state::<State>();
        let mut entries = state.0.lock().unwrap();
        entries.get_mut(window.label()).and_then(|entry| {
            entry
                .save
                .flush(transient)
                .map(|length| (entry.status.toolset_id.clone(), length))
        })
    };
    persist_pending(window, pending);
}

fn persist_pending<R: Runtime>(window: &tauri::Window<R>, pending: Option<(String, f64)>) {
    if let Some((id, length)) = pending {
        if let Err(error) = super::update_toolset_layout_state(window.app_handle(), |layout| {
            layout.toolsets.entry(id).or_default().length = Some(length);
        }) {
            eprintln!("Could not persist toolbar length: {error}");
        }
    }
}

pub(super) fn forget<R: Runtime>(window: &tauri::Window<R>) {
    window
        .state::<State>()
        .0
        .lock()
        .unwrap()
        .remove(window.label());
    super::palette_resize_native::forget(window.label());
}

pub(super) fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        forget(window);
        return;
    }
    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
        flush_pending(window);
    }
    if super::toolset_frame_is_transient(window.app_handle(), window)
        || super::utility_windows_suspended()
    {
        if let Some(entry) = window
            .state::<State>()
            .0
            .lock()
            .unwrap()
            .get_mut(window.label())
        {
            entry.save.cancel();
        }
        return;
    }
    if matches!(
        event,
        tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. }
    ) {
        if let Err(error) = apply(window, false) {
            eprintln!("Could not refresh toolbar size constraints: {error}");
        }
    }
}
