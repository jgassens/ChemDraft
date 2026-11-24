//! WebKitGTK measures palette content in CSS pixels. On X11, normalize GTK's Xft DPI to
//! GDK logical pixels before Tauri applies the monitor's integer scale.
//! Neither conversion depends on the current window size.

use super::{panel_window_frame::Placement, ScreenRect};

#[derive(Clone, Copy)]
pub(super) struct X11PaletteScale {
    css_to_gdk: f64,
    kwin_geometry: Option<(f64, (i32, i32))>,
}

pub(super) struct X11DisplayMetrics {
    pub(super) gdk_scale: i32,
    pub(super) xft_dpi: i32,
    pub(super) unscaled_dpi: Option<i32>,
    pub(super) root_size: (i32, i32),
}

impl X11PaletteScale {
    pub(super) const IDENTITY: Self = Self {
        css_to_gdk: 1.0,
        kwin_geometry: None,
    };

    #[cfg(target_os = "linux")]
    pub(super) fn read<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Self {
        // Creation can run on a worker. Both GDK display and GtkSettings belong to the UI thread.
        super::run_on_main_thread_blocking(app, Self::from_gtk).unwrap_or(Self::IDENTITY)
    }

    #[cfg(target_os = "linux")]
    fn from_gtk() -> Self {
        use gtk::{gdk::prelude::DisplayExtManual, prelude::GtkSettingsExt};
        let Some(display) =
            gtk::gdk::Display::default().filter(|display| display.backend().is_x11())
        else {
            return Self::IDENTITY;
        };
        let screen = display.default_screen();
        let Some(root) = screen.root_window() else {
            return Self::IDENTITY;
        };
        let gdk_scale = root.scale_factor();
        Self::from_settings(
            X11DisplayMetrics {
                gdk_scale,
                xft_dpi: gtk::Settings::default().map_or(-1, |settings| settings.gtk_xft_dpi()),
                unscaled_dpi: (gdk_scale > 1).then(|| unscaled_dpi(&screen)).flatten(),
                // GDK exposes the X root bounds in the same logical grid as its monitors.
                root_size: (root.width(), root.height()),
            },
            |key| std::env::var(key).ok(),
            || is_xwayland(&display),
            || {
                let config = std::env::var_os("XDG_CONFIG_HOME")
                    .filter(|dir| !dir.is_empty())
                    .map(std::path::PathBuf::from)
                    .or_else(|| dirs::home_dir().map(|home| home.join(".config")))?;
                std::fs::read_to_string(config.join("kwinrc")).ok()
            },
        )
    }

    pub(super) fn from_settings(
        metrics: X11DisplayMetrics,
        env: impl Fn(&str) -> Option<String>,
        is_xwayland: impl FnOnce() -> bool,
        kwinrc: impl FnOnce() -> Option<String>,
    ) -> Self {
        const BASE_DPI: i32 = 96 * 1024;
        if metrics.xft_dpi <= 0 {
            return Self::IDENTITY;
        }
        // For integer-scaled GDK, use the explicit unscaled DPI when GTK supplies it.
        // Without that setting, the Xft DPI alone cannot tell us whether it includes GDK scale.
        let dpi = metrics
            .unscaled_dpi
            .filter(|&unscaled| metrics.gdk_scale > 1 && unscaled > 0)
            .unwrap_or(metrics.xft_dpi);
        let css_to_gdk = f64::from(dpi) / f64::from(BASE_DPI);
        if css_to_gdk == 1.0 {
            return Self::IDENTITY;
        }
        let plasma_wayland = env("XDG_SESSION_TYPE").as_deref() == Some("wayland")
            && env("XDG_CURRENT_DESKTOP").is_some_and(|desktop| {
                desktop
                    .split(':')
                    .any(|name| name.eq_ignore_ascii_case("KDE"))
            });
        let kwin_scale = if plasma_wayland && is_xwayland() {
            kwinrc().as_deref().and_then(kwinrc_xwayland_scale)
        } else {
            None
        };
        Self {
            css_to_gdk,
            kwin_geometry: kwin_scale.map(|scale| (scale, metrics.root_size)),
        }
    }

    pub(super) fn content_size(self, size: (f64, f64)) -> (f64, f64) {
        if self.css_to_gdk == 1.0 {
            return size;
        }
        (
            (size.0 * self.css_to_gdk).ceil(),
            (size.1 * self.css_to_gdk).ceil(),
        )
    }

    pub(super) fn monitor(
        self,
        gdk: f64,
        bounds: ScreenRect,
        work_area: ScreenRect,
    ) -> PaletteMonitor {
        // KWin's Scale is in X pixels per compositor logical pixel. Allow Xft DPI to have
        // been rounded to the nearest whole DPI. Without agreement keep every panel reservation.
        let css_to_x = self.css_to_gdk * gdk;
        let area = match self.kwin_geometry {
            Some((scale, root)) if scale > 1.0 && (css_to_x - scale).abs() <= gdk / 192.0 => {
                kwin_work_area(work_area, bounds, root, scale)
            }
            _ => work_area,
        };
        PaletteMonitor {
            settings: self,
            gdk,
            area,
        }
    }
}

#[cfg(target_os = "linux")]
fn unscaled_dpi(screen: &gtk::gdk::Screen) -> Option<i32> {
    use gtk::glib::translate::{ToGlibPtr, ToGlibPtrMut};
    let mut value = gtk::glib::Value::from(0i32);
    // SAFETY: the X11 screen and the initialized integer GValue live through the read.
    let found = unsafe {
        gtk::gdk::ffi::gdk_screen_get_setting(
            screen.to_glib_none().0,
            c"gdk-unscaled-dpi".as_ptr(),
            value.to_glib_none_mut().0,
        )
    };
    (found != 0).then(|| value.get::<i32>().ok()).flatten()
}

/// The session can export a remote or nested X server. Check the XWAYLAND extension
/// on GDK's actual connection before interpreting that server's work area as KWin's.
#[cfg(target_os = "linux")]
fn is_xwayland(display: &gtk::gdk::Display) -> bool {
    use gtk::glib::translate::ToGlibPtr;
    use std::ffi::{c_char, c_int, c_void};
    #[link(name = "X11")]
    unsafe extern "C" {
        fn XQueryExtension(
            display: *mut c_void,
            name: *const c_char,
            opcode: *mut c_int,
            event: *mut c_int,
            error: *mut c_int,
        ) -> c_int;
    }
    #[link(name = "gdk-3")]
    unsafe extern "C" {
        fn gdk_x11_display_get_xdisplay(display: *mut gtk::gdk::ffi::GdkDisplay) -> *mut c_void;
    }
    let (mut opcode, mut event, mut error) = (0, 0, 0);
    // SAFETY: read() supplies a live X11 GdkDisplay on the GTK thread. XQueryExtension
    // borrows its X connection and writes the three C integers for the duration of the call.
    unsafe {
        let xdisplay = gdk_x11_display_get_xdisplay(display.to_glib_none().0);
        !xdisplay.is_null()
            && XQueryExtension(
                xdisplay,
                c"XWAYLAND".as_ptr(),
                &mut opcode,
                &mut event,
                &mut error,
            ) != 0
    }
}

fn kwinrc_xwayland_scale(kwinrc: &str) -> Option<f64> {
    let mut in_section = false;
    for line in kwinrc.lines().map(str::trim) {
        if line.starts_with('[') {
            in_section = line == "[Xwayland]";
        } else if in_section {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "Scale" {
                    return value.trim().parse().ok();
                }
            }
        }
    }
    None
}

/// KWin can publish _NET_WORKAREA in compositor logical coordinates on a physical X screen.
/// On a monitor that fills the X root, look for a far edge near the scaled root edge on at
/// least one axis. A panel can inset the other edge.
/// Require a gap of at least 10% on both axes so ordinary edge panels at small scale changes
/// stay reserved. Preserve the published area when the geometry is ambiguous.
fn kwin_work_area(
    work: ScreenRect,
    monitor: ScreenRect,
    root_size: (i32, i32),
    scale: f64,
) -> ScreenRect {
    let (root_width, root_height) = (f64::from(root_size.0), f64::from(root_size.1));
    let (right, bottom) = (work.x + work.width, work.y + work.height);
    if monitor != ScreenRect::new(0.0, 0.0, root_width, root_height)
        || right > root_width * 0.9
        || bottom > root_height * 0.9
    {
        return work;
    }
    // Allow one logical pixel of rounding and preserve the near-edge panel offsets.
    let tolerance = scale.ceil();
    let (left, top) = (work.x * scale, work.y * scale);
    let (right, bottom) = (right * scale, bottom * scale);
    if left < -tolerance
        || top < -tolerance
        || right > root_width + tolerance
        || bottom > root_height + tolerance
        || (right < root_width - tolerance && bottom < root_height - tolerance)
    {
        return work;
    }
    let (left, top) = (left.max(0.0), top.max(0.0));
    let (right, bottom) = (right.min(root_width), bottom.min(root_height));
    ScreenRect::new(left, top, right - left, bottom - top)
}

#[derive(Clone, Copy)]
pub(super) struct PaletteMonitor {
    settings: X11PaletteScale,
    gdk: f64,
    pub(super) area: ScreenRect,
}

impl PaletteMonitor {
    /// Bounds used to lay out the palette body in the page. Include the physical scale in
    /// its fit key: changing both desktop scale and _NET_WORKAREA can leave CSS bounds equal.
    pub(super) fn css_work_area(self) -> (ScreenRect, Option<f64>) {
        let scale = self.settings.css_to_gdk;
        (
            ScreenRect::new(
                self.area.x / scale,
                self.area.y / scale,
                self.area.width / scale,
                self.area.height / scale,
            ),
            (scale != 1.0).then_some(scale * self.gdk),
        )
    }

    pub(super) fn fit(
        self,
        source: (i32, i32),
        css_size: (f64, f64),
        window_scale: f64,
        monitors: impl FnOnce() -> Vec<Self>,
    ) -> Placement {
        let size = self.settings.content_size(css_size);
        let mut placement =
            super::content_placement_with_width_cap(source, size, self.gdk, self.area, true);
        // If only the body was on this monitor, preserve a title reachable on any attached
        // monitor. A width-capped toolbar must start at the work area's left edge.
        if placement.position != source
            && size.0 <= self.area.width
            && monitors().iter().any(|monitor| {
                let relative_scale = window_scale / monitor.gdk;
                monitor.area.contains_title_strip_at_scale(
                    f64::from(source.0) / monitor.gdk,
                    f64::from(source.1) / monitor.gdk,
                    size.0 * relative_scale,
                    super::TOOLSET_TITLE_HEIGHT * relative_scale,
                    relative_scale,
                )
            })
        {
            placement.position = source;
        }
        placement
    }
}

#[cfg(test)]
#[test]
fn x11_dpi_scale_is_continuous_around_192_dpi() {
    for dpi in [191, 192, 193] {
        for (gdk_scale, unscaled_dpi, expected_dpi) in
            [(1, None, dpi), (2, None, dpi), (2, Some(96), 96)]
        {
            let settings = X11PaletteScale::from_settings(
                X11DisplayMetrics {
                    gdk_scale,
                    xft_dpi: dpi * 1024,
                    unscaled_dpi: unscaled_dpi.map(|dpi| dpi * 1024),
                    root_size: (1680, 1050),
                },
                |_| None,
                || false,
                || None,
            );
            assert_eq!(
                settings.css_to_gdk,
                f64::from(expected_dpi) / 96.0,
                "Xft DPI {dpi}, GDK scale {gdk_scale}, unscaled DPI {unscaled_dpi:?}"
            );
        }
    }
}

/// Exercise the same GTK property and backend lookup as a live resize. Ordinary unit tests
/// also cover the fit on headless hosts, including KWin's two possible work-area units.
#[cfg(all(test, target_os = "linux"))]
#[test]
#[ignore = "requires an X11 display, e.g. GDK_BACKEND=x11 xvfb-run -a cargo test x11_gtk_palette_fit -- --ignored"]
fn x11_gtk_palette_fit() {
    use gtk::{gdk::prelude::DisplayExtManual, prelude::GtkSettingsExt};
    gtk::init().expect("GTK initialization requires a display");
    assert!(gtk::gdk::Display::default().unwrap().backend().is_x11());
    let gtk = gtk::Settings::default().unwrap();
    let original = gtk.gtk_xft_dpi();
    let area = ScreenRect::new(0.0, 0.0, 1680.0, 1050.0);
    for (dpi, expected) in [
        (96, (607, 253)),
        (120, (759, 317)),
        (144, (911, 380)),
        (192, (1214, 506)),
        (96, (607, 253)),
    ] {
        gtk.set_gtk_xft_dpi(dpi * 1024);
        let monitor = X11PaletteScale::from_gtk().monitor(1.0, area, area);
        assert_eq!(
            monitor.fit((0, 0), (607.0, 253.0), 1.0, Vec::new).size,
            expected
        );
    }
    gtk.set_gtk_xft_dpi(original);
}
