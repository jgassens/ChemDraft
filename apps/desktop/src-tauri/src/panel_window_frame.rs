//! Persisted panel frames use logical outer positions and inner sizes, like the document window.

use super::ScreenRect;

pub(super) const MIN_WIDTH: f64 = 280.0;
pub(super) const MIN_HEIGHT: f64 = 200.0;

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
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
    pub(super) fn from_physical(
        position: (i32, i32),
        size: (u32, u32),
        scale: f64,
    ) -> Option<Self> {
        if !scale.is_finite() || scale <= 0.0 {
            return None;
        }
        let frame = Self {
            x: position.0 as f64 / scale,
            y: position.1 as f64 / scale,
            width: size.0 as f64 / scale,
            height: size.1 as f64 / scale,
        };
        frame.valid().then_some(frame)
    }

    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }

    pub(super) fn restore(self, monitors: &[ScreenRect]) -> Option<Self> {
        if !self.valid() {
            return None;
        }
        // Require the title strip on an attached work area before clamping. A detached display
        // must use the ordinary first-open placement, rather than pinning to an unrelated corner.
        let area = monitors.iter().find(|area| {
            area.width.is_finite()
                && area.height.is_finite()
                && area.width >= MIN_WIDTH
                && area.height >= MIN_HEIGHT
                && self.x + self.width / 2.0 >= area.x
                && self.x + self.width / 2.0 <= area.x + area.width
                && self.y >= area.y - 1.0
                && self.y + 22.0 <= area.y + area.height
        })?;
        let width = self.width.clamp(MIN_WIDTH, area.width);
        let height = self.height.clamp(MIN_HEIGHT, area.height);
        Some(Self {
            x: self.x.clamp(area.x, area.x + area.width - width),
            y: self.y.clamp(area.y, area.y + area.height - height),
            width,
            height,
        })
    }

    pub(super) fn for_save(
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

    fn frame() -> Frame {
        Frame {
            x: -1200.0,
            y: 80.0,
            width: 900.0,
            height: 700.0,
        }
    }

    #[test]
    fn panel_frame_restores_only_on_attached_monitors() {
        let secondary = ScreenRect::new(-1440.0, 25.0, 1440.0, 875.0);
        let primary = ScreenRect::new(0.0, 25.0, 1920.0, 1055.0);
        assert_eq!(frame().restore(&[primary, secondary]), Some(frame()));
        assert_eq!(frame().restore(&[primary]), None);
        assert_eq!(frame().restore(&[]), None);
        assert_eq!(Frame { y: 0.0, ..frame() }.restore(&[secondary]), None);
        assert_eq!(
            Frame {
                y: 890.0,
                ..frame()
            }
            .restore(&[secondary]),
            None
        );
    }

    #[test]
    fn panel_frame_clamps_size_and_position_without_losing_the_minimum() {
        let area = ScreenRect::new(0.0, 25.0, 800.0, 575.0);
        let oversized = Frame {
            x: -100.0,
            y: 50.0,
            width: 1000.0,
            height: 900.0,
        };
        assert_eq!(
            oversized.restore(&[area]),
            Some(Frame {
                x: 0.0,
                y: 25.0,
                width: 800.0,
                height: 575.0,
            })
        );
        let small = Frame {
            x: 750.0,
            y: 570.0,
            width: 20.0,
            height: 20.0,
        };
        assert_eq!(
            small.restore(&[area]),
            Some(Frame {
                x: 520.0,
                y: 400.0,
                width: MIN_WIDTH,
                height: MIN_HEIGHT,
            })
        );
        assert_eq!(default_size(Some(640.0), Some(480.0)), (640.0, 480.0));
        assert_eq!(default_size(None, None), (380.0, 520.0));
        assert_eq!(default_size(Some(1.0), Some(1.0)), (MIN_WIDTH, MIN_HEIGHT));
        assert_eq!(default_size(Some(f64::NAN), Some(-3.0)), (380.0, 520.0));
    }

    #[test]
    fn panel_frame_rejects_invalid_or_transient_frames() {
        let area = ScreenRect::new(-1440.0, 25.0, 1440.0, 875.0);
        assert_eq!(frame().for_save(false, false, false), Some(frame()));
        for state in 1..8 {
            assert_eq!(
                frame().for_save(state & 1 != 0, state & 2 != 0, state & 4 != 0),
                None
            );
        }
        for invalid in [
            Frame {
                x: f64::NAN,
                ..frame()
            },
            Frame {
                y: f64::INFINITY,
                ..frame()
            },
            Frame {
                width: 0.0,
                ..frame()
            },
            Frame {
                height: -1.0,
                ..frame()
            },
        ] {
            assert_eq!(invalid.for_save(false, false, false), None);
            assert_eq!(invalid.restore(&[area]), None);
        }
    }

    #[test]
    fn panel_frame_physical_geometry_is_saved_in_logical_units() {
        for scale in [1.0, 1.5, 2.0] {
            assert_eq!(
                Frame::from_physical(
                    ((-1200.0 * scale) as i32, (80.0 * scale) as i32),
                    ((900.0 * scale) as u32, (700.0 * scale) as u32),
                    scale,
                ),
                Some(frame())
            );
        }
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(Frame::from_physical((0, 0), (380, 520), scale), None);
        }
    }

    #[test]
    fn panel_frame_encoding_round_trips_independent_panel_ids_and_older_layouts() {
        let mut layout = super::super::ToolsetLayoutState::default();
        layout
            .plugin_panels
            .insert("panel.nmr.carbon".into(), frame());
        let other = Frame {
            width: 600.0,
            ..frame()
        };
        layout
            .plugin_panels
            .insert("panel.nmr.proton".into(), other);
        let encoded = serde_json::to_string(&layout).unwrap();
        let decoded: super::super::ToolsetLayoutState = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.plugin_panels["panel.nmr.carbon"], frame());
        assert_eq!(decoded.plugin_panels["panel.nmr.proton"], other);
        let old: super::super::ToolsetLayoutState = serde_json::from_str(
            r#"{"version":1,"toolsets":{},"mainWindow":{"x":1,"y":2,"width":800,"height":600}}"#,
        )
        .unwrap();
        assert!(old.plugin_panels.is_empty());
        assert_eq!(old.main_window.unwrap().x, 1.0);
    }
}
