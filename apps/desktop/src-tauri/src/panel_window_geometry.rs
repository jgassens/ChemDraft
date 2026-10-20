//! Physical-pixel geometry shared by the non-client frame and its resize hit test.

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
pub(super) fn resize_hit(
    x: i32,
    y: i32,
    rect: Rect,
    bx: i32,
    by: i32,
    top_height: i32,
) -> Option<ResizeHit> {
    if x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom {
        return None;
    }
    let left = x < rect.left + bx;
    let right = x >= rect.right - bx;
    let top = y < rect.top + top_height;
    let bottom = y >= rect.bottom - by;
    // Full-height native side corners plus wider corner targets in the thin overlay grip.
    // The title interior remains client space; only pixels on a resize edge participate.
    if (left && y < rect.top + by) || (top && x < rect.left + 2 * bx) {
        return Some(ResizeHit::TopLeft);
    }
    if (right && y < rect.top + by) || (top && x >= rect.right - 2 * bx) {
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

/// Tao's actual client origin is authoritative: 0 top inset on Windows 10, one scaled
/// pixel on Windows 11. Include just one DIP of client edge, not Tauri's whole SM_CYFRAME
/// title strip. Maximized windows have no resize grip.
pub(super) fn top_resize_height(client_top: i32, dpi: u32, border: i32) -> i32 {
    if border == 0 {
        return 0;
    }
    client_top.max(0) + ((dpi as f64 / 96.0).round() as i32).max(1)
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
    fn windows_10_and_11_title_interior_passes_through_at_each_dpi() {
        for dpi in [96, 120, 144, 192, 288] {
            let dip = (dpi as f64 / 96.0).round() as i32;
            let border = 8 * dip;
            // Tao keeps WS_CAPTION on both, but only Win11 permits a positive top inset.
            for client_top in [0, dip] {
                let top = top_resize_height(client_top, dpi, border);
                let rect = Rect {
                    left: -1800,
                    top: -900,
                    right: -1400,
                    bottom: -600,
                };
                assert_eq!(top, client_top + dip);
                assert_eq!(
                    resize_hit(-1600, -900 + client_top, rect, border, border, top),
                    Some(ResizeHit::Top)
                );
                // Sol's reproduction: the rest of the first SM_CYFRAME pixels used to resize.
                for y in (client_top + dip)..(client_top + 4 * dip) {
                    assert_eq!(resize_hit(-1600, -900 + y, rect, border, border, top), None);
                }
                for (x, y, hit) in [
                    (-1800, -900, ResizeHit::TopLeft),
                    (-1401, -900, ResizeHit::TopRight),
                    (-1800, -900 + border / 2, ResizeHit::TopLeft),
                    (-1401, -900 + border / 2, ResizeHit::TopRight),
                    (-1800 + border, -900 + client_top, ResizeHit::TopLeft),
                    (-1401 - border, -900 + client_top, ResizeHit::TopRight),
                    (-1800, -601, ResizeHit::BottomLeft),
                    (-1401, -601, ResizeHit::BottomRight),
                    (-1800, -750, ResizeHit::Left),
                    (-1401, -750, ResizeHit::Right),
                    (-1600, -601, ResizeHit::Bottom),
                ] {
                    assert_eq!(resize_hit(x, y, rect, border, border, top), Some(hit));
                }
                assert_eq!(resize_hit(-1801, -900, rect, border, border, top), None);
            }
            assert_eq!(top_resize_height(0, dpi, 0), 0);
        }
    }
}
