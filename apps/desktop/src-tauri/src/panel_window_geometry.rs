//! Physical-pixel geometry for the panel's resize hit test and existing Tauri overlay.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(isize)]
pub(super) enum ResizeHit {
    Left = 10,
    Right = 11,
    Top = 12,
    TopLeft = 13,
    TopRight = 14,
    Bottom = 15,
    BottomLeft = 16,
    BottomRight = 17,
}

/// `rect` and the point must use the same origin (screen, window, or client).
pub(super) fn resize_hit(x: i32, y: i32, rect: Rect, bx: i32, by: i32) -> Option<ResizeHit> {
    if x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom {
        return None;
    }
    let left = x < rect.left + bx;
    let right = x >= rect.right - bx;
    let top = y < rect.top + by;
    let bottom = y >= rect.bottom - by;
    // Wider corner targets stay entirely within the system-height top band.
    if top && x < rect.left + 2 * bx {
        return Some(ResizeHit::TopLeft);
    }
    if top && x >= rect.right - 2 * bx {
        return Some(ResizeHit::TopRight);
    }
    match (left, right, top, bottom) {
        (true, _, true, _) => Some(ResizeHit::TopLeft),
        (_, true, true, _) => Some(ResizeHit::TopRight),
        (true, _, _, true) => Some(ResizeHit::BottomLeft),
        (_, true, _, true) => Some(ResizeHit::BottomRight),
        (true, _, _, _) => Some(ResizeHit::Left),
        (_, true, _, _) => Some(ResizeHit::Right),
        (_, _, true, _) => Some(ResizeHit::Top),
        (_, _, _, true) => Some(ResizeHit::Bottom),
        _ => None,
    }
}

/// The overlay starts at Tao's unchanged client origin: zero top inset on Windows 10,
/// one scaled pixel on Windows 11. Cover only the client part of the system resize
/// border; the parent handles the non-client part. A zero border disables resizing.
pub(super) fn top_overlay_rect(width: i32, height: i32, client_top: i32, border: i32) -> Rect {
    Rect {
        left: 0,
        top: 0,
        right: width.max(0),
        bottom: (border - client_top.max(0)).clamp(0, height.max(0)),
    }
}

/// Missing foreground information fails closed; a delayed IPC cannot activate another process.
pub(super) fn with_owned_foreground(
    foreground_process: Option<u32>,
    our_process: u32,
    focus: impl FnOnce(),
) -> bool {
    if foreground_process != Some(our_process) {
        return false;
    }
    focus();
    true
}

/// A hand-back must not interrupt another panel/dialog, even within our own process.
pub(super) fn foreground_can_return_to_document(
    foreground: usize,
    panel: usize,
    document: usize,
) -> bool {
    foreground != 0 && (foreground == panel || foreground == document)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_hand_back_requires_our_foreground_and_the_same_document_group() {
        for (foreground, process, expected) in [
            (10, Some(7), true),  // panel
            (20, Some(7), true),  // document already active; restore its webview focus
            (30, Some(7), false), // another ChemDraft dialog/panel
            (30, Some(42), false),
            (10, Some(42), false), // process check is independent of the target check
            (10, None, false),
            (0, None, false),
        ] {
            let mut returned = false;
            if foreground_can_return_to_document(foreground, 10, 20) {
                with_owned_foreground(process, 7, || returned = true);
            }
            assert_eq!(
                returned, expected,
                "foreground={foreground}, process={process:?}"
            );
        }
    }

    #[test]
    fn background_and_missing_foreground_drop_focus_requests() {
        for foreground in [None, Some(42)] {
            assert!(!with_owned_foreground(foreground, 7, || panic!(
                "must not activate"
            )));
        }
        let mut focused = false;
        assert!(with_owned_foreground(Some(7), 7, || focused = true));
        assert!(focused);
    }

    #[test]
    fn windows_10_and_11_system_top_border_and_title_at_each_dpi() {
        // Representative per-DPI system metrics, not rounded DIP * a base metric:
        // 150% must yield 12 physical pixels, not 16.
        for (dpi, frame, padding, win11_inset) in [(96, 4, 4, 1), (144, 6, 6, 2), (192, 8, 8, 2)] {
            let border = frame + padding;
            // Tao keeps WS_CAPTION on both. Never change these client origins.
            for (windows, client_top) in [("10", 0), ("11", win11_inset)] {
                let rect = Rect {
                    left: -1800,
                    top: -900,
                    right: -1400,
                    bottom: -600,
                };
                let overlay = top_overlay_rect(400 - 2 * border, 300, client_top, border);
                assert_eq!(overlay.bottom + client_top, border);
                assert_eq!(overlay.right, 400 - 2 * border);
                // Every physical pixel through the whole top band is reachable:
                // non-client pixels by the parent, client pixels by the SAME overlay.
                // Test both sides of each widened top-corner boundary too.
                for y in 0..border {
                    for (x, expected) in [
                        (rect.left, ResizeHit::TopLeft),
                        (rect.left + 2 * border - 1, ResizeHit::TopLeft),
                        (rect.left + 2 * border, ResizeHit::Top),
                        (-1600, ResizeHit::Top),
                        (rect.right - 2 * border - 1, ResizeHit::Top),
                        (rect.right - 2 * border, ResizeHit::TopRight),
                        (rect.right - 1, ResizeHit::TopRight),
                    ] {
                        assert_eq!(
                            resize_hit(x, rect.top + y, rect, border, border),
                            Some(expected),
                            "Windows {windows}, dpi={dpi}, x={x}, y={y}"
                        );
                    }
                    if y >= client_top {
                        assert!(y - client_top < overlay.bottom);
                    }
                }
                // The first pixel below the band and the remaining title strip pass
                // through to the DOM, including below the widened corner targets.
                for y in border..(28 * dpi / 96) {
                    assert!(y - client_top >= overlay.bottom);
                    for x in [rect.left + border, -1600, rect.right - border - 1] {
                        assert_eq!(resize_hit(x, rect.top + y, rect, border, border), None);
                    }
                    assert_eq!(
                        resize_hit(rect.left, rect.top + y, rect, border, border),
                        Some(ResizeHit::Left)
                    );
                    assert_eq!(
                        resize_hit(rect.right - 1, rect.top + y, rect, border, border),
                        Some(ResizeHit::Right)
                    );
                }
                // Native side/bottom shadow borders retain their directions.
                for (x, y, hit) in [
                    (-1800, -601, ResizeHit::BottomLeft),
                    (-1401, -601, ResizeHit::BottomRight),
                    (-1800, -750, ResizeHit::Left),
                    (-1401, -750, ResizeHit::Right),
                    (-1600, -601, ResizeHit::Bottom),
                ] {
                    assert_eq!(resize_hit(x, y, rect, border, border), Some(hit));
                }
                for (x, y) in [(-1801, -900), (-1600, -901), (-1400, -900), (-1600, -600)] {
                    assert_eq!(resize_hit(x, y, rect, border, border), None);
                }
            }
        }
    }

    #[test]
    fn overlay_clamps_to_client_and_maximized_windows_have_no_grip() {
        for client_top in [0, 1, 2] {
            assert_eq!(top_overlay_rect(400, 300, client_top, 0).bottom, 0);
            assert_eq!(top_overlay_rect(400, 3, client_top, 16).bottom, 3);
        }
        assert_eq!(top_overlay_rect(400, 300, 20, 16).bottom, 0);
        assert_eq!(top_overlay_rect(0, 0, 0, 16).right, 0);
        assert_eq!(top_overlay_rect(0, 0, 0, 16).bottom, 0);
        let rect = Rect {
            left: 0,
            top: 0,
            right: 400,
            bottom: 300,
        };
        for (x, y) in [(0, 0), (200, 0), (399, 0), (0, 150), (399, 299)] {
            assert_eq!(resize_hit(x, y, rect, 0, 0), None);
        }
    }
}
