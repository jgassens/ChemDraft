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

    fn divided(position: (f64, f64), size: (f64, f64), divisor: f64) -> LogicalBounds {
        let (left, top) = (position.0 / divisor, position.1 / divisor);
        LogicalBounds {
            left,
            top,
            right: left + size.0 / divisor,
            bottom: top + size.1 / divisor,
        }
    }

    /// The work area (without taskbar, panels or Dock), divided by the monitor's own scale.
    fn logical_work_area(&self) -> LogicalBounds {
        Self::divided(self.work_position, self.work_size, self.scale())
    }

    /// The whole monitor, divided by its own scale.
    #[cfg(test)]
    fn logical_bounds(&self) -> LogicalBounds {
        Self::divided(self.position, self.size, self.scale())
    }
}

/// macOS lays every display out in one space of points, and Tauri's "physical" frames there are
/// those points times each display's own scale, so dividing a display by its own scale is what
/// puts all of them, and every window, back in that one space. Windows (and X11) lay the displays
/// out in physical pixels, so one shared divisor keeps them side by side; dividing each by its own
/// scale makes a 150% display beside a 100% one overlap it or leave a gap.
#[cfg(target_os = "macos")]
const DESKTOP_IN_POINTS: bool = true;
#[cfg(not(target_os = "macos"))]
const DESKTOP_IN_POINTS: bool = false;

/// The coordinate space a point is given in, and the monitor areas are reported in.
#[derive(Clone, Copy, Debug, PartialEq)]
enum PointSpace {
    /// ChemDraft's global logical space: each monitor divided by its own scale. One-to-one on
    /// macOS; on Windows mixed scales overlap (see `global_logical_to_physical` in lib.rs).
    Global,
    /// The calling window's own logical space, the one `window_logical_position` reports in and
    /// its client coordinates add to: its physical position divided by its scale. On Windows that
    /// is the physical desktop divided by the window's scale, so it holds every monitor without
    /// overlap; on macOS it is the shared space of points (`DESKTOP_IN_POINTS`).
    Window { scale: f64, desktop_in_points: bool },
}

impl PointSpace {
    /// What a monitor's physical geometry is divided by to land in this space.
    fn divisor(self, monitor: &MonitorGeometry) -> f64 {
        match self {
            PointSpace::Window {
                scale,
                desktop_in_points: false,
            } if scale > 0.0 => scale,
            PointSpace::Window {
                desktop_in_points: false,
                ..
            } => 1.0,
            PointSpace::Global
            | PointSpace::Window {
                desktop_in_points: true,
                ..
            } => monitor.scale(),
        }
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
    /// How many units of the reported space one logical pixel on this monitor spans: 1 in the
    /// global space and on macOS; on Windows, in a window's space, this monitor's scale over the
    /// window's (a native menu 200 px tall on a 150% monitor spans 300 units of a 100% window).
    units_per_logical_pixel: f64,
}

/// The first monitor whose whole bounds, in `space`, contain the point (x, y) given in `space`.
/// The whole bounds decide, so a point over the Dock or taskbar still finds its monitor.
fn area_containing(
    monitors: &[MonitorGeometry],
    x: f64,
    y: f64,
    space: PointSpace,
) -> Option<MonitorLogicalArea> {
    monitors
        .iter()
        .map(|monitor| {
            let divisor = space.divisor(monitor);
            MonitorLogicalArea {
                bounds: MonitorGeometry::divided(monitor.position, monitor.size, divisor),
                work_area: MonitorGeometry::divided(
                    monitor.work_position,
                    monitor.work_size,
                    divisor,
                ),
                units_per_logical_pixel: monitor.scale() / divisor,
            }
        })
        .find(|area| {
            let b = area.bounds;
            x >= b.left && x < b.right && y >= b.top && y < b.bottom
        })
}

#[cfg(test)]
fn logical_area_containing(
    monitors: &[MonitorGeometry],
    x: f64,
    y: f64,
) -> Option<MonitorLogicalArea> {
    area_containing(monitors, x, y, PointSpace::Global)
}

/// The calling window's monitor work area, in logical coordinates. `None` when there is no monitor.
#[tauri::command]
pub(crate) fn current_window_logical_work_area(
    window: tauri::WebviewWindow,
) -> Option<LogicalBounds> {
    let monitor = current_monitor(&window).ok().flatten()?;
    Some(MonitorGeometry::of(&monitor).logical_work_area())
}

/// The logical bounds and work area of the monitor under the logical point (x, y), if any. With
/// `window_space`, the point and the answer are in the calling window's own logical space (its
/// `window_logical_position` plus client coordinates), which stays one-to-one with the desktop when
/// the monitors' scales differ; otherwise in the global logical space.
#[tauri::command]
pub(crate) fn monitor_logical_bounds_at(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    window_space: Option<bool>,
) -> Option<MonitorLogicalArea> {
    let space = if window_space.unwrap_or(false) {
        PointSpace::Window {
            scale: window.scale_factor().ok()?,
            desktop_in_points: DESKTOP_IN_POINTS,
        }
    } else {
        PointSpace::Global
    };
    let monitors = available_monitors(window.app_handle()).ok()?;
    let geometry: Vec<MonitorGeometry> = monitors.iter().map(MonitorGeometry::of).collect();
    area_containing(&geometry, x, y, space)
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
                "workArea": { "left": 0.0, "top": 24.0, "right": 800.0, "bottom": 560.0 },
                "unitsPerLogicalPixel": 1.0
            })
        );
    }

    fn window_space(scale: f64, desktop_in_points: bool) -> PointSpace {
        PointSpace::Window {
            scale,
            desktop_in_points,
        }
    }

    #[test]
    fn a_windows_pointer_on_a_150_percent_monitor_beside_a_100_percent_window_finds_that_monitor() {
        // Physical desktop: a 100% 1920x1080 primary, and a 150% 3840x2160 monitor to its right.
        let monitors = [
            monitor(1.0, 0.0, 0.0, 1920.0, 1080.0),
            monitor(1.5, 1920.0, 0.0, 3840.0, 2160.0),
        ];
        // The window is on the 100% monitor, so its space is the physical desktop. The pointer is
        // low on the 150% monitor, at physical (2000, 1500).
        let space = window_space(1.0, false);
        let area = area_containing(&monitors, 2000.0, 1500.0, space).unwrap();
        assert_eq!(
            area.work_area,
            LogicalBounds {
                left: 1920.0,
                top: 36.0,
                right: 5760.0,
                bottom: 2100.0
            }
        );
        assert_eq!(area.units_per_logical_pixel, 1.5);
        // Each monitor divided by its own scale puts the 150% one at logical 1280..3840 x 0..1440,
        // which misses the pointer altogether.
        assert_eq!(logical_area_containing(&monitors, 2000.0, 1500.0), None);
        // A pointer just left of the boundary stays on the 100% monitor.
        let own = area_containing(&monitors, 1900.0, 100.0, space).unwrap();
        assert_eq!(own.bounds.right, 1920.0);
        assert_eq!(own.units_per_logical_pixel, 1.0);
    }

    #[test]
    fn a_windows_window_at_150_percent_reports_a_100_percent_neighbour_in_its_own_space() {
        let monitors = [
            monitor(1.5, 0.0, 0.0, 2880.0, 1620.0),
            monitor(1.0, 2880.0, 0.0, 1920.0, 1080.0),
        ];
        // Physical (3000, 100) is (2000, 66.7) in the 150% window's space. Each monitor divided by
        // its own scale would leave a gap there (1920..2880) and find nothing.
        let space = window_space(1.5, false);
        let area = area_containing(&monitors, 2000.0, 100.0 / 1.5, space).unwrap();
        assert_eq!((area.bounds.left, area.bounds.right), (1920.0, 3200.0));
        assert!((area.units_per_logical_pixel - 1.0 / 1.5).abs() < 1e-12);
        assert_eq!(
            logical_area_containing(&monitors, 2000.0, 100.0 / 1.5),
            None
        );
    }

    #[test]
    fn a_macos_window_space_is_the_shared_space_of_points() {
        // A 200% Retina panel (1440x900 points) and a 100% display to its right at point 1440.
        let monitors = [
            monitor(2.0, 0.0, 0.0, 2880.0, 1800.0),
            monitor(1.0, 1440.0, 0.0, 1920.0, 1080.0),
        ];
        for window_scale in [1.0, 2.0] {
            let space = window_space(window_scale, true);
            let area = area_containing(&monitors, 1500.0, 1000.0, space).unwrap();
            assert_eq!(
                area.work_area,
                LogicalBounds {
                    left: 1440.0,
                    top: 24.0,
                    right: 3360.0,
                    bottom: 1040.0
                }
            );
            assert_eq!(area.units_per_logical_pixel, 1.0);
            assert_eq!(
                Some(area),
                logical_area_containing(&monitors, 1500.0, 1000.0)
            );
        }
    }

    #[test]
    fn a_zero_window_scale_counts_as_one() {
        let monitors = [monitor(1.0, 0.0, 0.0, 800.0, 600.0)];
        let area = area_containing(&monitors, 10.0, 10.0, window_space(0.0, false)).unwrap();
        assert_eq!(area.bounds.right, 800.0);
    }
}
