//! Panel positions are logical offsets from an identified monitor's physical origin.

use super::ScreenRect;

pub(super) const MIN_WIDTH: f64 = 280.0;
pub(super) const MIN_HEIGHT: f64 = 200.0;

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MonitorIdentity {
    pub name: Option<String>,
    pub position: (i32, i32),
    pub size: (u32, u32),
}

#[derive(Clone, Debug)]
pub(super) struct Monitor {
    pub identity: MonitorIdentity,
    pub scale: f64,
    pub work_area: ScreenRect,
}

impl Monitor {
    pub fn from_native(monitor: &tauri::Monitor) -> Self {
        let origin = monitor.position();
        let size = monitor.size();
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        Self {
            identity: MonitorIdentity {
                name: monitor.name().cloned(),
                position: (origin.x, origin.y),
                size: (size.width, size.height),
            },
            scale,
            work_area: ScreenRect::new(
                (f64::from(area.position.x) - f64::from(origin.x)) / scale,
                (f64::from(area.position.y) - f64::from(origin.y)) / scale,
                f64::from(area.size.width) / scale,
                f64::from(area.size.height) / scale,
            ),
        }
    }

    fn valid(&self) -> bool {
        self.scale.is_finite()
            && self.scale > 0.0
            && [
                self.work_area.x,
                self.work_area.y,
                self.work_area.width,
                self.work_area.height,
            ]
            .iter()
            .all(|n| n.is_finite())
            && self.work_area.width >= MIN_WIDTH
            && self.work_area.height >= MIN_HEIGHT
            && self.identity.size.0 > 0
            && self.identity.size.1 > 0
    }
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Frame {
    pub monitor: MonitorIdentity,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Placement {
    pub position: (i32, i32),
    pub size: (u32, u32),
}

impl Placement {
    // Moving can synchronously change DPI. Convert the final size with the destination monitor,
    // then apply both operations on the UI thread without consulting a stale window scale.
    pub fn apply<E>(
        self,
        move_to: impl FnOnce((i32, i32)) -> Result<(), E>,
        resize: impl FnOnce((u32, u32)) -> Result<(), E>,
    ) -> Result<(), E> {
        move_to(self.position)?;
        resize(self.size)
    }
}

pub(super) fn default_size(width: Option<f64>, height: Option<f64>) -> (f64, f64) {
    let dimension = |value: Option<f64>, fallback: f64, minimum: f64| {
        value
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(fallback)
            .max(minimum)
    };
    (
        dimension(width, 380.0, MIN_WIDTH),
        dimension(height, 520.0, MIN_HEIGHT),
    )
}

impl Frame {
    pub fn from_physical(
        position: (i32, i32),
        size: (u32, u32),
        monitor: &Monitor,
    ) -> Option<Self> {
        if !monitor.valid() {
            return None;
        }
        let frame = Self {
            monitor: monitor.identity.clone(),
            x: (f64::from(position.0) - f64::from(monitor.identity.position.0)) / monitor.scale,
            y: (f64::from(position.1) - f64::from(monitor.identity.position.1)) / monitor.scale,
            width: f64::from(size.0) / monitor.scale,
            height: f64::from(size.1) / monitor.scale,
        };
        frame.valid().then_some(frame)
    }

    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }

    fn clamped(&self, area: ScreenRect) -> Self {
        let width = self.width.clamp(MIN_WIDTH, area.width);
        let height = self.height.clamp(MIN_HEIGHT, area.height);
        Self {
            x: self.x.clamp(area.x, area.x + area.width - width),
            y: self.y.clamp(area.y, area.y + area.height - height),
            width,
            height,
            ..self.clone()
        }
    }

    pub fn restore(&self, monitors: &[Monitor]) -> Option<Placement> {
        let monitor = self.attached_monitor(monitors)?;
        Some(self.clamped(monitor.work_area).placement(monitor))
    }

    pub fn restore_normal(&self, monitors: &[Monitor]) -> Option<Placement> {
        let monitor = self.attached_monitor(monitors)?;
        Some(self.placement(monitor))
    }

    fn attached_monitor<'a>(&self, monitors: &'a [Monitor]) -> Option<&'a Monitor> {
        if !self.valid() {
            return None;
        }
        // Name alone is not unique (and can be absent); physical bounds disambiguate it.
        let monitor = monitors
            .iter()
            .find(|m| m.identity == self.monitor && m.valid())?;
        let area = monitor.work_area;
        if self.x + self.width / 2.0 < area.x
            || self.x + self.width / 2.0 > area.x + area.width
            || self.y < area.y - 1.0
            || self.y + 22.0 > area.y + area.height
        {
            return None;
        }
        Some(monitor)
    }

    fn placement(&self, monitor: &Monitor) -> Placement {
        Placement {
            position: (
                (f64::from(monitor.identity.position.0) + self.x * monitor.scale).round() as i32,
                (f64::from(monitor.identity.position.1) + self.y * monitor.scale).round() as i32,
            ),
            size: (
                (self.width * monitor.scale).round() as u32,
                (self.height * monitor.scale).round() as u32,
            ),
        }
    }

    pub fn enlarged(
        &self,
        width: f64,
        height: f64,
        border: (f64, f64),
        monitor: &Monitor,
    ) -> Option<Placement> {
        if !self.valid()
            || !monitor.valid()
            || !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
            || !border.0.is_finite()
            || !border.1.is_finite()
        {
            return None;
        }
        let area = ScreenRect {
            width: monitor.work_area.width - border.0.max(0.0),
            height: monitor.work_area.height - border.1.max(0.0),
            ..monitor.work_area
        };
        if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
            return None;
        }
        let width = width.max(self.width).clamp(MIN_WIDTH, area.width);
        let height = height.max(self.height).clamp(MIN_HEIGHT, area.height);
        Some(
            Self {
                x: self.x + (self.width - width) / 2.0,
                y: self.y + (self.height - height) / 2.0,
                width,
                height,
                ..self.clone()
            }
            .clamped(area)
            .placement(monitor),
        )
    }

    pub fn for_save(
        self,
        minimized: bool,
        owner_minimized: bool,
        fullscreen: bool,
    ) -> Option<Self> {
        (!minimized && !owner_minimized && !fullscreen && self.valid()).then_some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn monitor(position: (i32, i32), scale: f64) -> Monitor {
        Monitor {
            identity: MonitorIdentity {
                name: Some("display".into()),
                position,
                size: (1920, 1600),
            },
            scale,
            work_area: ScreenRect::new(0.0, 25.0, 1920.0 / scale, 1600.0 / scale - 25.0),
        }
    }
    fn frame(monitor: &Monitor) -> Frame {
        Frame {
            monitor: monitor.identity.clone(),
            x: 100.0,
            y: 80.0,
            width: 600.0,
            height: 500.0,
        }
    }

    #[test]
    fn mixed_scale_frames_round_trip_without_ambiguous_absolute_logical_coordinates() {
        for origin in [(1920, 0), (-1920, -100), (0, 0)] {
            for scale in [1.0, 1.5, 2.0] {
                let m = monitor(origin, scale);
                let expected = frame(&m);
                let physical = expected.restore(std::slice::from_ref(&m)).unwrap();
                assert_eq!(
                    Frame::from_physical(physical.position, physical.size, &m),
                    Some(expected)
                );
            }
        }
        let primary = monitor((0, 0), 1.0);
        let secondary = monitor((1920, 0), 2.0);
        let saved = Frame::from_physical((2200, 160), (1200, 1000), &secondary).unwrap();
        assert_eq!(saved.x, 140.0);
        assert_eq!(
            saved.restore(&[primary, secondary]).unwrap().position,
            (2200, 160)
        );
    }

    #[test]
    fn matching_requires_name_and_physical_bounds_and_uses_current_scale() {
        let m = monitor((1920, 0), 2.0);
        let saved = frame(&m);
        let mut changed = m.clone();
        changed.identity.name = Some("other".into());
        assert_eq!(saved.restore(&[changed]), None);
        let mut changed = m.clone();
        changed.identity.size.0 += 1;
        assert_eq!(saved.restore(&[changed]), None);
        assert_eq!(saved.restore(&[monitor((0, 0), 2.0)]), None);
        assert_eq!(saved.restore(&[]), None);
        assert_eq!(
            saved.restore(&[monitor((1920, 0), 1.0)]).unwrap().position,
            (2020, 80)
        );
        let mut unnamed = m;
        unnamed.identity.name = None;
        assert!(frame(&unnamed).restore(&[unnamed]).is_some());
    }

    #[test]
    fn restore_keeps_title_strip_guard_and_clamps_size_position_and_minimum() {
        let m = monitor((1920, 0), 2.0);
        for y in [0.0, 790.0] {
            assert_eq!(
                Frame { y, ..frame(&m) }.restore(std::slice::from_ref(&m)),
                None
            );
        }
        let oversized = Frame {
            x: -100.0,
            width: 1200.0,
            height: 900.0,
            ..frame(&m)
        };
        assert_eq!(
            oversized.restore(std::slice::from_ref(&m)),
            Some(Placement {
                position: (1920, 50),
                size: (1920, 1550)
            })
        );
        let small = Frame {
            x: 900.0,
            y: 750.0,
            width: 20.0,
            height: 20.0,
            ..frame(&m)
        };
        assert_eq!(
            small.restore(&[m]),
            Some(Placement {
                position: (3280, 1200),
                size: (560, 400)
            })
        );
        assert_eq!(default_size(None, None), (380.0, 520.0));
        assert_eq!(default_size(Some(1.0), Some(1.0)), (MIN_WIDTH, MIN_HEIGHT));
        assert_eq!(default_size(Some(f64::NAN), Some(-3.0)), (380.0, 520.0));
    }

    #[test]
    fn enlargement_centres_and_clamps_including_native_borders() {
        let m = monitor((1920, 0), 2.0);
        let f = Frame {
            x: 300.0,
            y: 250.0,
            width: 300.0,
            height: 200.0,
            ..frame(&m)
        };
        assert_eq!(
            f.enlarged(500.0, 400.0, (0.0, 0.0), &m),
            Some(Placement {
                position: (2320, 300),
                size: (1000, 800)
            })
        );
        assert_eq!(
            f.enlarged(5000.0, 4000.0, (10.0, 10.0), &m),
            Some(Placement {
                position: (1920, 50),
                size: (1900, 1530)
            })
        );
        assert_eq!(
            f.enlarged(1.0, 1.0, (0.0, 0.0), &m).unwrap().size,
            (600, 400)
        );
        assert_eq!(f.enlarged(f64::NAN, 400.0, (0.0, 0.0), &m), None);
    }

    #[test]
    fn placement_moves_before_resizing_and_stops_on_failure() {
        let steps = std::cell::RefCell::new(Vec::new());
        let p = Placement {
            position: (2200, 160),
            size: (1200, 1000),
        };
        p.apply::<()>(
            |pos| {
                steps.borrow_mut().push(("move", pos));
                Ok(())
            },
            |size| {
                steps
                    .borrow_mut()
                    .push(("size", (size.0 as i32, size.1 as i32)));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            *steps.borrow(),
            vec![("move", (2200, 160)), ("size", (1200, 1000))]
        );
        assert!(p
            .apply(
                |_| Err(()),
                |_| panic!("must not resize after a failed move")
            )
            .is_err());
    }

    #[test]
    fn live_normal_restore_is_exact_even_when_the_window_extends_past_the_work_area() {
        let m = monitor((1920, 0), 2.0);
        let normal = Frame {
            x: 500.0,
            ..frame(&m)
        };
        let expected = Placement {
            position: (2920, 160),
            size: (1200, 1000),
        };
        assert_eq!(
            normal.restore_normal(std::slice::from_ref(&m)),
            Some(expected)
        );
        assert_ne!(normal.restore(&[m]), Some(expected));
    }

    #[test]
    fn invalid_and_transient_frames_are_not_saved() {
        let m = monitor((1920, 0), 2.0);
        for flags in 1..8 {
            assert_eq!(
                frame(&m).for_save(flags & 1 != 0, flags & 2 != 0, flags & 4 != 0),
                None
            );
        }
        for bad in [f64::NAN, f64::INFINITY, 0.0, -1.0] {
            let invalid = Frame {
                width: bad,
                ..frame(&m)
            };
            assert_eq!(invalid.clone().for_save(false, false, false), None);
            assert_eq!(invalid.restore(std::slice::from_ref(&m)), None);
            let mut invalid_monitor = m.clone();
            invalid_monitor.scale = bad;
            assert_eq!(
                Frame::from_physical((2200, 160), (1200, 1000), &invalid_monitor),
                None
            );
        }
    }

    #[test]
    fn monitor_relative_encoding_round_trips_independent_panel_ids() {
        let m = monitor((1920, 0), 2.0);
        let mut layout = super::super::ToolsetLayoutState::default();
        layout
            .plugin_panels
            .insert("panel.nmr.carbon".into(), frame(&m));
        let other = Frame {
            width: 400.0,
            ..frame(&m)
        };
        layout
            .plugin_panels
            .insert("panel.nmr.proton".into(), other.clone());
        let decoded: super::super::ToolsetLayoutState =
            serde_json::from_str(&serde_json::to_string(&layout).unwrap()).unwrap();
        assert_eq!(decoded.plugin_panels["panel.nmr.carbon"], frame(&m));
        assert_eq!(decoded.plugin_panels["panel.nmr.proton"], other);
    }
}
