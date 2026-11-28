//! Monitor lookups that are safe from any thread.
//!
//! Tauri builds each `tauri::Monitor` on the thread that asks for it, and on Linux that reads the
//! monitor's work area from the X server (`gdk_monitor_get_workarea`, an `XGetWindowProperty`).
//! GTK and Xlib belong to the main thread. From an async command (a tokio worker) the read races
//! the main loop's own X requests, and with libX11 older than 1.8 (Ubuntu 22.04) the app aborts
//! with "[xcb] Unknown request in queue while dequeuing" a moment after its palettes open.
//!
//! Two guards:
//! - [`init_xlib_threads`] makes Xlib itself thread-safe, as libX11 1.8 and later do on their own.
//! - Every monitor lookup goes through this module, which runs it on the main thread on Linux.
//!   Other platforms call Tauri directly, as before. `clippy.toml` (`disallowed-methods`) keeps
//!   direct calls out of the rest of the crate.
//!
//! The webview's own `currentMonitor()`/`availableMonitors()` run as async plugin commands, so the
//! frontend asks [`current_window_logical_work_area`] and [`monitor_logical_bounds_at`] instead.

use serde::Serialize;
use tauri::{AppHandle, Manager, Monitor, Runtime};

/// Make Xlib safe to call from more than one thread. Must run before any other Xlib call, so
/// `run()` calls it first. libX11 1.8 and later do this by themselves; calling it again is a no-op.
#[cfg(target_os = "linux")]
pub(crate) fn init_xlib_threads() {
    #[link(name = "X11")]
    extern "C" {
        fn XInitThreads() -> std::os::raw::c_int;
    }
    // SAFETY: XInitThreads takes no arguments and only sets up Xlib's internal locks. It runs
    // before GTK opens a display, as Xlib requires.
    if unsafe { XInitThreads() } == 0 {
        eprintln!("ChemDraft: XInitThreads failed; X11 calls from worker threads are not safe");
    }
}

/// Run `query` on the main thread and wait for its answer. Runs it in place when already there
/// (setup, sync commands, event handlers), so a main-thread caller cannot deadlock on itself.
#[cfg(target_os = "linux")]
fn on_main_thread<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    query: impl FnOnce() -> tauri::Result<T> + Send + 'static,
) -> tauri::Result<T> {
    if gtk::is_initialized_main_thread() {
        return query();
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(query());
    })?;
    // When the event loop has stopped, the task is dropped unrun, which drops the sender.
    receiver
        .recv()
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?
}

#[cfg(not(target_os = "linux"))]
fn on_main_thread<R: Runtime, T: Send + 'static>(
    _app: &AppHandle<R>,
    query: impl FnOnce() -> tauri::Result<T> + Send + 'static,
) -> tauri::Result<T> {
    query()
}

/// A window whose current monitor can be asked for.
pub(crate) trait MonitorWindow<R: Runtime>: Manager<R> + Clone + Send + 'static {
    fn current_monitor_in_place(&self) -> tauri::Result<Option<Monitor>>;
}

impl<R: Runtime> MonitorWindow<R> for tauri::Window<R> {
    #[allow(clippy::disallowed_methods)]
    fn current_monitor_in_place(&self) -> tauri::Result<Option<Monitor>> {
        self.current_monitor()
    }
}

impl<R: Runtime> MonitorWindow<R> for tauri::WebviewWindow<R> {
    #[allow(clippy::disallowed_methods)]
    fn current_monitor_in_place(&self) -> tauri::Result<Option<Monitor>> {
        self.current_monitor()
    }
}

/// Every attached monitor.
#[allow(clippy::disallowed_methods)]
pub(crate) fn available_monitors<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Vec<Monitor>> {
    let handle = app.clone();
    on_main_thread(app, move || handle.available_monitors())
}

/// The system's primary monitor.
#[allow(clippy::disallowed_methods)]
pub(crate) fn primary_monitor<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<Monitor>> {
    let handle = app.clone();
    on_main_thread(app, move || handle.primary_monitor())
}

/// The monitor `window` is on.
pub(crate) fn current_monitor<R: Runtime, W: MonitorWindow<R>>(
    window: &W,
) -> tauri::Result<Option<Monitor>> {
    let window_on_main = window.clone();
    on_main_thread(window.app_handle(), move || {
        window_on_main.current_monitor_in_place()
    })
}

/// A rectangle in global logical (scale-independent) coordinates, as the frontend uses them.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(crate) struct LogicalBounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

/// The parts of a `tauri::Monitor` the bounds below use, so they can be tested without one.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MonitorGeometry {
    scale: f64,
    position: (f64, f64),
    size: (f64, f64),
    work_position: (f64, f64),
    work_size: (f64, f64),
}

impl MonitorGeometry {
    fn of(monitor: &Monitor) -> Self {
        let area = monitor.work_area();
        Self {
            scale: monitor.scale_factor(),
            position: (monitor.position().x as f64, monitor.position().y as f64),
            size: (monitor.size().width as f64, monitor.size().height as f64),
            work_position: (area.position.x as f64, area.position.y as f64),
            work_size: (area.size.width as f64, area.size.height as f64),
        }
    }

    fn scale(&self) -> f64 {
        if self.scale > 0.0 {
            self.scale
        } else {
            1.0
        }
    }

    fn logical(&self, position: (f64, f64), size: (f64, f64)) -> LogicalBounds {
        let scale = self.scale();
        let (left, top) = (position.0 / scale, position.1 / scale);
        LogicalBounds {
            left,
            top,
            right: left + size.0 / scale,
            bottom: top + size.1 / scale,
        }
    }

    /// The work area (without taskbar, panels or Dock), divided by the monitor's own scale.
    fn logical_work_area(&self) -> LogicalBounds {
        self.logical(self.work_position, self.work_size)
    }

    /// The whole monitor, divided by its own scale.
    fn logical_bounds(&self) -> LogicalBounds {
        self.logical(self.position, self.size)
    }
}

/// The monitor under a point: its whole bounds (the same four fields as before, at the top level,
/// so callers that clamp to the full monitor keep working) and its work area, which leaves out the
/// Dock and menu bar on macOS and the taskbar on Windows. Both come from the same `tauri::Monitor`
/// on every platform, so neither side needs platform code here.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonitorLogicalArea {
    #[serde(flatten)]
    bounds: LogicalBounds,
    work_area: LogicalBounds,
}

/// The first monitor whose whole bounds contain the logical point (x, y). The whole bounds decide,
/// so a point over the Dock or taskbar still finds its monitor.
fn logical_area_containing(
    monitors: &[MonitorGeometry],
    x: f64,
    y: f64,
) -> Option<MonitorLogicalArea> {
    monitors
        .iter()
        .map(|monitor| MonitorLogicalArea {
            bounds: monitor.logical_bounds(),
            work_area: monitor.logical_work_area(),
        })
        .find(|area| {
            let b = area.bounds;
            x >= b.left && x < b.right && y >= b.top && y < b.bottom
        })
}

/// The calling window's monitor work area, in logical coordinates. `None` when there is no monitor.
#[tauri::command]
pub(crate) fn current_window_logical_work_area(
    window: tauri::WebviewWindow,
) -> Option<LogicalBounds> {
    let monitor = current_monitor(&window).ok().flatten()?;
    Some(MonitorGeometry::of(&monitor).logical_work_area())
}

/// The logical bounds and work area of the monitor under the logical point (x, y), if any.
#[tauri::command]
pub(crate) fn monitor_logical_bounds_at(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Option<MonitorLogicalArea> {
    let monitors = available_monitors(window.app_handle()).ok()?;
    let geometry: Vec<MonitorGeometry> = monitors.iter().map(MonitorGeometry::of).collect();
    logical_area_containing(&geometry, x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(scale: f64, x: f64, y: f64, width: f64, height: f64) -> MonitorGeometry {
        MonitorGeometry {
            scale,
            position: (x, y),
            size: (width, height),
            work_position: (x, y + 24.0 * scale),
            work_size: (width, height - 64.0 * scale),
        }
    }

    #[test]
    fn work_area_uses_the_monitor_scale() {
        for scale in [1.0, 1.5, 2.0] {
            let left_screen = monitor(scale, -1920.0 * scale, 0.0, 1920.0 * scale, 1080.0 * scale);
            assert_eq!(
                left_screen.logical_work_area(),
                LogicalBounds {
                    left: -1920.0,
                    top: 24.0,
                    right: 0.0,
                    bottom: 1040.0
                }
            );
        }
    }

    #[test]
    fn a_zero_scale_counts_as_one() {
        let broken = monitor(0.0, 0.0, 0.0, 800.0, 600.0);
        assert_eq!(broken.logical_bounds().right, 800.0);
    }

    #[test]
    fn finds_the_monitor_under_a_point() {
        let monitors = [
            monitor(1.0, 0.0, 0.0, 1920.0, 1080.0),
            monitor(2.0, 3840.0, 0.0, 5120.0, 2880.0),
        ];
        let right = logical_area_containing(&monitors, 2000.0, 100.0)
            .unwrap()
            .bounds;
        assert_eq!(
            (right.left, right.right, right.bottom),
            (1920.0, 4480.0, 1440.0)
        );
        let left = logical_area_containing(&monitors, 0.0, 0.0).unwrap().bounds;
        assert_eq!(left.right, 1920.0);
        // Right and bottom edges belong to the next monitor, as in the frontend's old check.
        assert_eq!(
            logical_area_containing(&monitors, 1920.0, 10.0)
                .unwrap()
                .bounds
                .left,
            1920.0
        );
        assert_eq!(logical_area_containing(&monitors, 9000.0, 0.0), None);
        assert_eq!(logical_area_containing(&[], 0.0, 0.0), None);
    }

    #[test]
    fn the_monitor_under_a_point_reports_its_work_area_in_its_own_scale() {
        let monitors = [
            monitor(1.0, 0.0, 0.0, 1920.0, 1080.0),
            monitor(2.0, 3840.0, 0.0, 5120.0, 2880.0),
        ];
        // A point over the second monitor's Dock/taskbar strip still finds that monitor.
        let area = logical_area_containing(&monitors, 2000.0, 1430.0).unwrap();
        assert_eq!(
            area.work_area,
            LogicalBounds {
                left: 1920.0,
                top: 24.0,
                right: 4480.0,
                bottom: 1400.0
            }
        );
        assert_eq!(area.bounds.bottom, 1440.0);
    }

    #[test]
    fn the_monitor_area_keeps_the_bounds_at_the_top_level_and_adds_the_work_area() {
        let area =
            logical_area_containing(&[monitor(1.0, 0.0, 0.0, 800.0, 600.0)], 1.0, 1.0).unwrap();
        assert_eq!(
            serde_json::to_value(area).unwrap(),
            serde_json::json!({
                "left": 0.0, "top": 0.0, "right": 800.0, "bottom": 600.0,
                "workArea": { "left": 0.0, "top": 24.0, "right": 800.0, "bottom": 560.0 }
            })
        );
    }
}
