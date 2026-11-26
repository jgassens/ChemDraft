//! Logical-to-physical rounding for content-fit palette windows on Linux (GitHub #304).
//!
//! The palette webview measures its content in CSS pixels and rounds up, then Rust turns that
//! logical size into the physical size it sets. Tauri's `to_physical::<u32>` rounds to the nearest
//! pixel, so at a fractional scale the window could come out a fraction of a CSS pixel shorter or
//! narrower than the content (82 CSS px at 1.25 is 102.5 -> 103, fine, but 81 is 101.25 -> 101,
//! 80.8 CSS px). A webview a fraction short of its content shows a scrollbar. Linux sizes palettes
//! with [`physical_size_covering`] and pins GTK's min = max size hints with
//! [`logical_extent_covering`], so the window always covers the content it was asked to fit.
//!
//! Nothing here shrinks or scales a palette: a fixed toolbar always keeps its natural size.

/// Rounding slack for a product that should be a whole number of pixels: binary floating point can
/// land a hair above it (1243.33.. * 1.5 is 1864.99..), which must not round up a whole extra pixel.
const PIXEL_ROUNDING_EPSILON: f64 = 1e-6;

/// The smallest whole number of physical pixels that covers `logical` CSS pixels at `scale`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn physical_extent_covering(logical: f64, scale: f64) -> u32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    if !logical.is_finite() || logical <= 0.0 {
        return 0;
    }
    let physical = (logical * scale - PIXEL_ROUNDING_EPSILON).ceil().max(1.0);
    if physical >= f64::from(u32::MAX) {
        u32::MAX
    } else {
        physical as u32
    }
}

/// [`physical_extent_covering`] for a width and a height.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn physical_size_covering(logical: (f64, f64), scale: f64) -> (u32, u32) {
    (
        physical_extent_covering(logical.0, scale),
        physical_extent_covering(logical.1, scale),
    )
}

/// The smallest whole number of GTK (logical) units that covers `physical` pixels at GTK's window
/// `scale`. GTK3 scales are whole numbers, so this only differs from rounding at scale 3 and up
/// (1966 / 3 = 655.33 rounds to 655, 1965 pixels: one short).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn logical_extent_covering(physical: u32, scale: f64) -> i32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let logical = (f64::from(physical) / scale - PIXEL_ROUNDING_EPSILON)
        .ceil()
        .max(1.0);
    if logical >= f64::from(i32::MAX) {
        i32::MAX
    } else {
        logical as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CSS size the webview gets back from a physical extent at `scale`.
    fn css(physical: u32, scale: f64) -> f64 {
        f64::from(physical) / scale
    }

    #[test]
    fn a_fitted_window_always_covers_its_content_at_fractional_scales() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 3.0] {
            for logical in 1..=2000 {
                let logical = f64::from(logical);
                let physical = physical_extent_covering(logical, scale);
                // Never short of the content, and never a whole pixel over it.
                assert!(
                    css(physical, scale) + 1e-9 >= logical,
                    "{logical} CSS px at {scale} became {physical} px, {} CSS px",
                    css(physical, scale)
                );
                assert!(
                    f64::from(physical) < logical * scale + 1.0,
                    "{logical} at {scale}"
                );
            }
        }
    }

    #[test]
    fn rounding_to_nearest_would_leave_the_window_short_where_covering_does_not() {
        // The case behind the scrollbar: 81 CSS px at 1.25 is 101.25 physical px.
        let rounded = tauri::LogicalSize::new(81.0, 81.0).to_physical::<u32>(1.25);
        assert_eq!(rounded.height, 101);
        assert!(css(rounded.height, 1.25) < 81.0);
        assert_eq!(physical_extent_covering(81.0, 1.25), 102);
    }

    #[test]
    fn whole_products_are_not_rounded_up_by_floating_point_noise() {
        // 150%: the Main toolbar's natural width and a 1280-px work area (1920 physical).
        assert_eq!(physical_extent_covering(1311.0, 1.5), 1967);
        assert_eq!(physical_extent_covering(1280.0, 1.5), 1920);
        assert_eq!(physical_extent_covering(81.0, 1.5), 122);
        assert_eq!(physical_extent_covering(80.0, 1.5), 120);
        // 1865 physical px at 1.5 is 1243.33.. CSS px: back to exactly 1865, not 1866.
        assert_eq!(physical_extent_covering(1865.0 / 1.5, 1.5), 1865);
        assert_eq!(physical_extent_covering(1243.0 + 1.0 / 3.0, 1.5), 1865);
        assert_eq!(physical_size_covering((1311.0, 81.0), 1.5), (1967, 122));
        assert_eq!(physical_size_covering((60.0, 54.0), 1.0), (60, 54));
    }

    #[test]
    fn degenerate_inputs_stay_finite() {
        assert_eq!(physical_extent_covering(0.0, 1.5), 0);
        assert_eq!(physical_extent_covering(-4.0, 1.5), 0);
        assert_eq!(physical_extent_covering(f64::NAN, 1.5), 0);
        assert_eq!(physical_extent_covering(10.0, 0.0), 10);
        assert_eq!(physical_extent_covering(10.0, f64::NAN), 10);
        assert_eq!(physical_extent_covering(f64::MAX, 2.0), u32::MAX);
        assert_eq!(logical_extent_covering(10, 0.0), 10);
        assert_eq!(logical_extent_covering(10, f64::NAN), 10);
    }

    #[test]
    fn gtk_size_hints_cover_the_physical_frame() {
        for scale in [1.0, 2.0, 3.0] {
            for physical in 1..=3000u32 {
                let logical = logical_extent_covering(physical, scale);
                assert!(f64::from(logical) * scale >= f64::from(physical));
                assert!(f64::from(logical - 1) * scale < f64::from(physical));
            }
        }
        // Rounding would give 655 GTK units (1965 px) for a 1966-px frame at scale 3.
        assert_eq!(logical_extent_covering(1966, 3.0), 656);
        assert_eq!(logical_extent_covering(1966, 2.0), 983);
        assert_eq!(logical_extent_covering(1967, 1.0), 1967);
        assert_eq!(logical_extent_covering(1967, 2.0), 984);
    }
}
