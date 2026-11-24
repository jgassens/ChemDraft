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

    #[cfg(any(target_os = "linux", test))]
    fn palette_monitor(
        &self,
        settings: crate::linux_content_scale::X11PaletteScale,
    ) -> crate::linux_content_scale::PaletteMonitor {
        let rect = |b: LogicalBounds| {
            crate::ScreenRect::new(b.left, b.top, b.right - b.left, b.bottom - b.top)
        };
        settings.monitor(
            self.scale(),
            rect(self.logical_bounds()),
            rect(self.logical_work_area()),
        )
    }
}

#[cfg(target_os = "linux")]
pub(super) fn palette_monitor(
    monitor: &Monitor,
    settings: crate::linux_content_scale::X11PaletteScale,
) -> crate::linux_content_scale::PaletteMonitor {
    MonitorGeometry::of(monitor).palette_monitor(settings)
}

/// The logical bounds of the first monitor that contains the logical point (x, y).
fn logical_bounds_containing(
    monitors: &[MonitorGeometry],
    x: f64,
    y: f64,
) -> Option<LogicalBounds> {
    monitors
        .iter()
        .map(MonitorGeometry::logical_bounds)
        .find(|b| x >= b.left && x < b.right && y >= b.top && y < b.bottom)
}

#[derive(Serialize)]
pub(crate) struct WorkArea {
    #[serde(flatten)]
    bounds: LogicalBounds,
    #[serde(rename = "x11ContentScale", skip_serializing_if = "Option::is_none")]
    x11_content_scale: Option<f64>,
}

#[cfg(any(target_os = "linux", test))]
impl WorkArea {
    fn for_palette(monitor: crate::linux_content_scale::PaletteMonitor) -> Self {
        let (area, x11_content_scale) = monitor.css_work_area();
        Self {
            bounds: LogicalBounds {
                left: area.x,
                top: area.y,
                right: area.x + area.width,
                bottom: area.y + area.height,
            },
            x11_content_scale,
        }
    }
}

/// The calling monitor's usable bounds. A content-fit palette on X11 lays out its body in
/// CSS pixels, including its scrollbars, before sending the measured CSS size back to Rust.
#[tauri::command]
pub(crate) fn current_window_logical_work_area(
    window: tauri::WebviewWindow,
    content_fit: Option<bool>,
) -> Option<WorkArea> {
    let monitor = current_monitor(&window).ok().flatten()?;
    let geometry = MonitorGeometry::of(&monitor);
    #[cfg(target_os = "linux")]
    if content_fit == Some(true) {
        let settings = crate::linux_content_scale::X11PaletteScale::read(window.app_handle());
        return Some(WorkArea::for_palette(geometry.palette_monitor(settings)));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = content_fit;
    Some(WorkArea {
        bounds: geometry.logical_work_area(),
        x11_content_scale: None,
    })
}

/// The logical bounds of the monitor under the logical point (x, y), if any.
#[tauri::command]
pub(crate) fn monitor_logical_bounds_at(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Option<LogicalBounds> {
    let monitors = available_monitors(window.app_handle()).ok()?;
    let geometry: Vec<MonitorGeometry> = monitors.iter().map(MonitorGeometry::of).collect();
    logical_bounds_containing(&geometry, x, y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux_content_scale::{X11DisplayMetrics, X11PaletteScale};

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

    // Raw settings and physical Tauri monitor fields enter the same fit, title recovery, and
    // page work-area paths as the commands. No viewport or precomputed scale enters these tests.
    fn desktop(
        server: &str,
        dpi: i32,
        session: &str,
        desktop: &str,
        kwinrc: &str,
        root_size: (i32, i32),
    ) -> X11PaletteScale {
        if server == "Wayland" {
            return X11PaletteScale::IDENTITY;
        }
        X11PaletteScale::from_settings(
            X11DisplayMetrics {
                gdk_scale: 1,
                xft_dpi: dpi,
                unscaled_dpi: None,
                root_size,
            },
            |key| match key {
                "XDG_SESSION_TYPE" => Some(session.into()),
                "XDG_CURRENT_DESKTOP" => Some(desktop.into()),
                "WAYLAND_DISPLAY" => Some("wayland-0".into()),
                _ => None,
            },
            || server == "Xwayland",
            || Some(kwinrc.into()),
        )
    }

    #[test]
    fn x11_palette_fit_uses_gtk_xft_dpi_and_gdk_scale_once_each() {
        for (gdk, dpi, unscaled_dpi, gdk_size, reported_scale) in [
            (1, 96, None, (607, 253), None),
            (1, 120, None, (759, 317), Some(1.25)),
            (1, 144, None, (911, 380), Some(1.5)),
            (1, 192, None, (1214, 506), Some(2.0)),
            (2, 96, Some(96), (607, 253), None),
            (2, 192, Some(96), (607, 253), None),
            (2, 192, None, (1214, 506), Some(4.0)),
            (2, 144, Some(144), (911, 380), Some(3.0)),
            (2, 288, Some(144), (911, 380), Some(3.0)),
        ] {
            let scale = f64::from(gdk);
            let settings = X11PaletteScale::from_settings(
                X11DisplayMetrics {
                    gdk_scale: gdk,
                    xft_dpi: dpi * 1024,
                    unscaled_dpi: unscaled_dpi.map(|dpi| dpi * 1024),
                    root_size: (1920, 1200),
                },
                |_| None,
                || false,
                || None,
            );
            if reported_scale.is_none() {
                assert_eq!(settings.content_size((607.25, 253.25)), (607.25, 253.25));
            }
            let monitor = MonitorGeometry {
                scale,
                position: (0.0, 0.0),
                size: (1920.0 * scale, 1200.0 * scale),
                work_position: (0.0, 0.0),
                work_size: (1920.0 * scale, 1080.0 * scale),
            }
            .palette_monitor(settings);
            let fit = |size| monitor.fit((20, 50), size, scale, || vec![monitor]);
            let gdk = gdk as u32;
            assert_eq!(
                fit((607.0, 253.0)).size,
                (gdk_size.0 * gdk, gdk_size.1 * gdk)
            );
            let main = fit((2400.0, 1400.0));
            assert_eq!(main.size, (1920 * gdk, 1080 * gdk));
            assert_eq!(main.position.0, 0);
            let page = serde_json::to_value(WorkArea::for_palette(monitor)).unwrap();
            let css_to_x = reported_scale.unwrap_or(scale);
            assert_eq!(page["right"].as_f64().unwrap() * css_to_x, 1920.0 * scale);
            assert_eq!(page["bottom"].as_f64().unwrap() * css_to_x, 1080.0 * scale);
            assert_eq!(
                page.get("x11ContentScale")
                    .and_then(serde_json::Value::as_f64),
                reported_scale
            );
        }
    }

    #[test]
    fn fractional_fit_keeps_title_recovery_in_the_converted_work_area() {
        let settings = desktop(
            "Xwayland",
            147456,
            "wayland",
            "KDE",
            "[Xwayland]\nScale=1.5",
            (1680, 1050),
        );
        let monitor = MonitorGeometry {
            scale: 1.0,
            position: (0.0, 0.0),
            size: (1680.0, 1050.0),
            work_position: (0.0, 90.0),
            work_size: (1120.0, 610.0),
        }
        .palette_monitor(settings);
        let fit = monitor.fit((100, 95), (607.0, 253.0), 1.0, || vec![monitor]);
        assert_eq!(fit.position, (100, 135));
        assert_eq!(fit.size, (911, 380));
        let main = monitor.fit((100, 135), (1311.0, 85.0), 1.0, || vec![monitor]);
        assert_eq!(main.position, (0, 135));
        assert_eq!(main.size, (1680, 128));
        assert_eq!(
            monitor.css_work_area().0,
            crate::ScreenRect::new(0.0, 90.0, 1120.0, 610.0)
        );
    }

    #[test]
    fn fractional_fit_recovers_a_reachable_title_on_a_two_monitor_root() {
        let settings = desktop(
            "Xwayland",
            144 * 1024,
            "wayland",
            "KDE",
            "[Xwayland]\nScale=1.5",
            (3360, 1050),
        );
        let left = MonitorGeometry {
            scale: 1.0,
            position: (0.0, 0.0),
            size: (1680.0, 1050.0),
            work_position: (0.0, 90.0),
            work_size: (1120.0, 610.0),
        }
        .palette_monitor(settings);
        assert_eq!(left.area, crate::ScreenRect::new(0.0, 90.0, 1120.0, 610.0));
        let right = MonitorGeometry {
            scale: 1.0,
            position: (1680.0, 0.0),
            size: (1680.0, 1050.0),
            work_position: (1680.0, 0.0),
            work_size: (1680.0, 984.0),
        }
        .palette_monitor(settings);
        let fit = left.fit((1700, 95), (607.0, 253.0), 1.0, || vec![left, right]);
        assert_eq!(fit.position, (1700, 95));
    }

    #[test]
    fn plasma_150_percent_work_area_expands_with_a_bottom_or_right_panel() {
        let settings = desktop(
            "Xwayland",
            144 * 1024,
            "wayland",
            "KDE",
            "[Xwayland]\nScale=1.5",
            (1680, 1050),
        );
        for (work_size, expected) in [
            ((1120.0, 656.0), (1680.0, 984.0)), // bottom panel
            ((1076.0, 700.0), (1614.0, 1050.0)), // right panel
            ((1121.0, 656.0), (1680.0, 984.0)), // right edge rounds 1.5 px beyond root
            ((1122.0, 656.0), (1122.0, 656.0)), // right edge is beyond tolerance
            ((1118.0, 656.0), (1118.0, 656.0)), // neither edge is within tolerance
            ((1120.0, 702.0), (1120.0, 702.0)), // bottom edge overshoots despite matching right edge
        ] {
            let monitor = MonitorGeometry {
                scale: 1.0,
                position: (0.0, 0.0),
                size: (1680.0, 1050.0),
                work_position: (0.0, 0.0),
                work_size,
            }
            .palette_monitor(settings);
            assert_eq!((monitor.area.width, monitor.area.height), expected);
        }
    }

    #[test]
    fn ambiguous_105_percent_work_area_preserves_right_and_bottom_panels() {
        // The same 1600x1000 rectangle could be the whole logical screen, or an X screen
        // minus an 80px right panel and a 50px bottom panel. Geometry alone is ambiguous.
        let geometry = MonitorGeometry {
            scale: 1.0,
            position: (0.0, 0.0),
            size: (1680.0, 1050.0),
            work_position: (0.0, 0.0),
            work_size: (1600.0, 1000.0),
        };
        let dpi = 103219; // round(96 * 1.05 * 1024)
        let settings = desktop(
            "Xwayland",
            dpi,
            "wayland",
            "KDE",
            "[Xwayland]\nScale=1.05",
            (1680, 1050),
        );
        let monitor = geometry.palette_monitor(settings);
        assert_eq!(
            monitor.area,
            crate::ScreenRect::new(0.0, 0.0, 1600.0, 1000.0)
        );
        let fit = monitor.fit((0, 0), (2000.0, 1500.0), 1.0, || vec![monitor]);
        assert_eq!(fit.size, (1600, 1000));
    }

    #[test]
    fn logical_work_area_expands_only_on_matching_kwin_xwayland() {
        let geometry = MonitorGeometry {
            scale: 1.0,
            position: (0.0, 0.0),
            size: (1680.0, 1050.0),
            work_position: (0.0, 0.0),
            work_size: (1120.0, 700.0),
        };
        let kwinrc = "[Xwayland]\nScale=1.5";
        for (server, session, de, config, expected) in [
            ("Xwayland", "x11", "KDE", kwinrc, (1120, 700)), // WAYLAND_DISPLAY is also set
            ("Xorg", "wayland", "KDE", kwinrc, (1120, 700)), // nested or remote Xorg
            ("Wayland", "wayland", "KDE", kwinrc, (1120, 700)),
            ("Xwayland", "wayland", "GNOME", kwinrc, (1120, 700)),
            (
                "Xwayland",
                "wayland",
                "KDE",
                "[Wayland]\nScale=1.5",
                (1120, 700),
            ),
            (
                "Xwayland",
                "wayland",
                "KDE",
                "[Xwayland]\nScale=1.25",
                (1120, 700),
            ),
            ("Xwayland", "wayland", "KDE", kwinrc, (1680, 1050)),
        ] {
            let settings = desktop(server, 144 * 1024, session, de, config, (1680, 1050));
            let monitor = geometry.palette_monitor(settings);
            assert_eq!(
                monitor
                    .fit((0, 0), (2000.0, 1500.0), 1.0, || vec![monitor])
                    .size,
                expected
            );
            let small = monitor.fit((0, 0), (60.0, 60.0), 1.0, || vec![monitor]);
            assert_eq!(
                small.size,
                if server != "Wayland" {
                    (90, 90)
                } else {
                    (60, 60)
                }
            );
        }
        let settings = desktop("Xwayland", 144 * 1024, "wayland", "KDE", kwinrc, (1680, 1050));
        let geometry = MonitorGeometry {
            work_size: (1600.0, 1000.0),
            ..geometry
        };
        let area = geometry.palette_monitor(settings).area;
        assert_eq!((area.width, area.height), geometry.work_size);
    }

    #[test]
    fn unset_and_base_dpi_preserve_fractional_opening_dimensions() {
        let size = (607.25, 253.25);
        for (dpi, expected) in [(144 * 1024, (911.0, 380.0)), (-1, size), (96 * 1024, size)] {
            assert_eq!(
                desktop(
                    "Xwayland",
                    dpi,
                    "wayland",
                    "KDE",
                    "[Xwayland]\nScale=1.5",
                    (1680, 1050),
                )
                .content_size(size),
                expected
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
        let right = logical_bounds_containing(&monitors, 2000.0, 100.0).unwrap();
        assert_eq!(
            (right.left, right.right, right.bottom),
            (1920.0, 4480.0, 1440.0)
        );
        let left = logical_bounds_containing(&monitors, 0.0, 0.0).unwrap();
        assert_eq!(left.right, 1920.0);
        // Right and bottom edges belong to the next monitor, as in the frontend's old check.
        assert_eq!(
            logical_bounds_containing(&monitors, 1920.0, 10.0)
                .unwrap()
                .left,
            1920.0
        );
        assert_eq!(logical_bounds_containing(&monitors, 9000.0, 0.0), None);
        assert_eq!(logical_bounds_containing(&[], 0.0, 0.0), None);
    }
}
