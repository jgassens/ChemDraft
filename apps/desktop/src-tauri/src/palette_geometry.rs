//! Pure logical-pixel constraints and backwards-compatible palette geometry.

#[derive(Clone, Default, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PersistedGeometry {
    // Visibility belongs to TypeScript. Old records' `visible` field is ignored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Orientation {
    Horizontal,
    #[default]
    Vertical,
}

impl Orientation {
    pub fn length(self, width: f64, height: f64) -> f64 {
        match self {
            Self::Horizontal => width,
            Self::Vertical => height,
        }
    }

    pub fn size(self, length: f64, across: f64) -> (f64, f64) {
        match self {
            Self::Horizontal => (length, across),
            Self::Vertical => (across, length),
        }
    }
}

/// Natural *inner* size, including the webview's title strip, borders and padding.
/// `minLength` includes the overflow control and at least one item (96 px fallback).
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ContentSize {
    pub orientation: Orientation,
    pub width: f64,
    pub height: f64,
    pub min_length: Option<f64>,
}

impl ContentSize {
    pub fn validate(self) -> Result<Self, String> {
        if ![self.width, self.height]
            .into_iter()
            .all(|n| n.is_finite() && n > 0.0)
            || self.min_length.is_some_and(|n| !n.is_finite() || n <= 0.0)
        {
            return Err(
                "Palette content dimensions must be finite, positive logical pixels.".into(),
            );
        }
        Ok(self)
    }

    pub fn constraints(self, work_length: Option<f64>) -> Constraints {
        let full = self.orientation.length(self.width, self.height);
        let maximum = work_length
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(full)
            .min(full);
        Constraints {
            orientation: self.orientation,
            across: self.orientation.length(self.height, self.width),
            minimum: self.min_length.unwrap_or(96.0).min(maximum),
            maximum,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Constraints {
    pub orientation: Orientation,
    pub across: f64,
    pub minimum: f64,
    pub maximum: f64,
}

impl Constraints {
    pub fn clamp(self, length: Option<f64>) -> f64 {
        length
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(self.maximum)
            .clamp(self.minimum, self.maximum)
    }

    pub fn size(self, length: f64) -> (f64, f64) {
        self.orientation.size(self.clamp(Some(length)), self.across)
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WorkArea {
    /// Convert using the destination monitor's scale, never the moving window's scale.
    pub fn from_physical(position: (i32, i32), size: (u32, u32), scale: f64) -> Self {
        Self {
            x: f64::from(position.0) / scale,
            y: f64::from(position.1) / scale,
            width: f64::from(size.0) / scale,
            height: f64::from(size.1) / scale,
        }
    }

    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    pub fn clamp_position(self, x: f64, y: f64, size: (f64, f64)) -> (f64, f64) {
        (
            x.min(self.x + self.width - size.0).max(self.x),
            y.min(self.y + self.height - size.1).max(self.y),
        )
    }
}

/// A native-confirmed resize is debounced. Any auto-fit/scale change cancels pending saves;
/// programmatic callbacks during an actual edge drag are excluded by the nesting guard.
#[derive(Default)]
pub(super) struct ResizeSave {
    generation: u64,
    programmatic: bool,
    pending: Option<f64>,
}

impl ResizeSave {
    pub fn is_programmatic(&self) -> bool {
        self.programmatic
    }

    pub fn begin_programmatic(&mut self) {
        self.cancel();
        self.programmatic = true;
    }

    pub fn end_programmatic(&mut self) {
        self.programmatic = false;
    }

    pub fn cancel(&mut self) {
        self.generation += 1;
        self.pending = None;
    }

    pub fn user_resize(&mut self, length: f64, transient: bool) -> Option<u64> {
        if self.programmatic || transient || !length.is_finite() || length <= 0.0 {
            return None;
        }
        self.generation += 1;
        self.pending = Some(length);
        Some(self.generation)
    }

    pub fn take(&mut self, generation: u64, transient: bool) -> Option<f64> {
        if generation != self.generation || transient || self.programmatic {
            return None;
        }
        self.pending.take()
    }

    pub fn flush(&mut self, transient: bool) -> Option<f64> {
        if transient || self.programmatic {
            return None;
        }
        let length = self.pending.take();
        self.generation += 1;
        length
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content(orientation: Orientation) -> ContentSize {
        let (width, height) = orientation.size(600.0, 56.0);
        ContentSize {
            orientation,
            width,
            height,
            min_length: Some(100.0),
        }
    }

    #[test]
    fn horizontal_and_vertical_lock_across_and_cap_at_content() {
        for orientation in [Orientation::Horizontal, Orientation::Vertical] {
            let limits = content(orientation).constraints(None);
            assert_eq!(limits.size(20.0), orientation.size(100.0, 56.0));
            assert_eq!(limits.size(900.0), orientation.size(600.0, 56.0));
            assert_eq!(limits.size(300.0), orientation.size(300.0, 56.0));
            assert_eq!(limits.clamp(None), 600.0);
        }
    }

    #[test]
    fn work_area_and_shortened_content_clamp_saved_length() {
        for orientation in [Orientation::Horizontal, Orientation::Vertical] {
            let natural = content(orientation);
            assert_eq!(natural.constraints(Some(400.0)).clamp(Some(900.0)), 400.0);
            assert_eq!(natural.constraints(None).clamp(Some(900.0)), 600.0);
            // A tiny monitor or fewer than one full item must never invert min/max.
            let limits = natural.constraints(Some(40.0));
            assert_eq!(limits.minimum, 40.0);
            assert_eq!(limits.maximum, 40.0);
        }
        let mut natural = content(Orientation::Horizontal);
        natural.min_length = None;
        assert_eq!(natural.constraints(None).minimum, 96.0);
    }

    #[test]
    fn restore_uses_destination_scale_and_work_area_including_negative_origins() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let area = WorkArea::from_physical((-2400, 60), (2400, 1440), scale);
            let limits = content(Orientation::Vertical).constraints(Some(area.height));
            let size = limits.size(1200.0);
            let (x, y) = area.clamp_position(-9000.0, 9000.0, size);
            assert_eq!(x, -2400.0 / scale);
            assert_eq!(y, area.y + area.height - size.1);
            assert!(area.contains(x, y));
            assert_eq!(size.1, 600.0);
        }
        let area = WorkArea::from_physical((1920, 0), (1920, 1080), 2.0);
        assert_eq!(
            content(Orientation::Vertical)
                .constraints(Some(area.height))
                .clamp(Some(800.0)),
            540.0
        );
        assert_eq!(
            area.clamp_position(9000.0, 9000.0, (56.0, 540.0)),
            (1864.0, 0.0)
        );
    }

    #[test]
    fn geometry_round_trip_keeps_length_and_legacy_records_load() {
        let geometry = PersistedGeometry {
            x: Some(-120.5),
            y: Some(44.0),
            length: Some(220.25),
        };
        let json = serde_json::to_string(&geometry).unwrap();
        assert_eq!(
            serde_json::from_str::<PersistedGeometry>(&json).unwrap(),
            geometry
        );
        let old: PersistedGeometry =
            serde_json::from_str(r#"{"x":12,"y":34,"visible":true}"#).unwrap();
        assert_eq!(
            old,
            PersistedGeometry {
                x: Some(12.0),
                y: Some(34.0),
                length: None
            }
        );
        assert!(!serde_json::to_string(&old).unwrap().contains("length"));
    }

    #[test]
    fn auto_fit_minimize_and_stale_debounce_never_save() {
        let mut save = ResizeSave::default();
        let first = save.user_resize(300.0, false).unwrap();
        let last = save.user_resize(250.0, false).unwrap();
        assert_eq!(save.take(first, false), None);
        assert_eq!(save.take(last, false), Some(250.0));
        assert_eq!(save.take(last, false), None);
        assert_eq!(save.user_resize(10.0, true), None);
        let pending = save.user_resize(220.0, false).unwrap();
        save.begin_programmatic();
        assert_eq!(save.user_resize(600.0, false), None);
        save.end_programmatic();
        assert_eq!(save.take(pending, false), None);
        let pending = save.user_resize(180.0, false).unwrap();
        assert_eq!(save.take(pending, true), None);
        save.cancel();
        assert_eq!(save.take(pending, false), None);
        let pending = save.user_resize(200.0, false).unwrap();
        assert_eq!(save.flush(false), Some(200.0));
        assert_eq!(save.take(pending, false), None);
        let pending = save.user_resize(190.0, false).unwrap();
        assert_eq!(save.flush(true), None);
        assert_eq!(save.take(pending, false), Some(190.0));
    }

    #[test]
    fn layout_file_round_trip_preserves_lengths_per_toolset_and_old_records() {
        let json = r#"{"version":1,"toolsets":{"core.main":{"x":10,"y":20,"length":321.5},"core.art":{"x":30,"y":40,"visible":true}}}"#;
        let layout: super::super::ToolsetLayoutState = serde_json::from_str(json).unwrap();
        assert_eq!(layout.toolsets["core.main"].length, Some(321.5));
        assert_eq!(layout.toolsets["core.art"].length, None);
        let encoded = serde_json::to_string(&layout).unwrap();
        let loaded: super::super::ToolsetLayoutState = serde_json::from_str(&encoded).unwrap();
        assert_eq!(loaded.toolsets, layout.toolsets);
    }

    #[test]
    fn measurement_permissions_are_scoped_to_palettes_and_registered_commands() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/palette-size.json")).unwrap();
        assert_eq!(
            capability["windows"],
            serde_json::json!(["toolset-core-*", "toolset-plugin-*", "toolset-user-*"])
        );
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "allow-report-toolset-content-size",
                "allow-get-toolset-window-size"
            ])
        );
        for command in ["report_toolset_content_size", "get_toolset_window_size"] {
            assert!(include_str!("../build.rs").contains(command));
            assert!(!include_str!("../capabilities/default.json").contains(command));
        }
    }

    #[test]
    fn invalid_reports_are_rejected_and_invalid_saved_lengths_use_full_content() {
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut natural = content(Orientation::Horizontal);
            natural.width = invalid;
            assert!(natural.validate().is_err());
            natural = content(Orientation::Vertical);
            natural.min_length = Some(invalid);
            assert!(natural.validate().is_err());
            assert_eq!(
                content(Orientation::Horizontal)
                    .constraints(None)
                    .clamp(Some(invalid)),
                600.0
            );
        }
    }
}
