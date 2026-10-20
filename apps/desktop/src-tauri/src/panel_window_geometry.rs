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
pub(super) fn resize_hit(x: i32, y: i32, rect: Rect, bx: i32, by: i32) -> Option<ResizeHit> {
    if x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom {
        return None;
    }
    let left = x < rect.left + bx;
    let right = x >= rect.right - bx;
    let top = y < rect.top + by;
    let bottom = y >= rect.bottom - by;
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

/// The native client excludes only the system's non-client frame. The webview fills this
/// rectangle; never apply this inset a second time to the child HWND/controller bounds.
pub(super) fn resize_client(width: i32, height: i32, bx: i32, by: i32) -> Rect {
    let bx = bx.min(width / 2).max(0);
    let by = by.min(height / 2).max(0);
    Rect {
        left: bx,
        top: by,
        right: width - bx,
        bottom: height - by,
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
    fn non_client_frame_preserves_the_requested_client_size_at_each_scale() {
        for border in [8, 12, 16, 24] {
            let client = resize_client(380 + 2 * border, 520 + 2 * border, border, border);
            assert_eq!(client.right - client.left, 380);
            assert_eq!(client.bottom - client.top, 520);
            assert_eq!(client.left, border);
            assert_eq!(client.top, border);
        }
        let maximized = resize_client(380, 520, 0, 0);
        assert_eq!(maximized.left, 0);
        assert_eq!(maximized.top, 0);
        assert_eq!(maximized.right, 380);
        assert_eq!(maximized.bottom, 520);
        assert_eq!(resize_hit(0, 0, maximized, 0, 0), None);
    }

    #[test]
    fn all_edges_and_corners_in_window_and_client_coordinates_at_multiple_dpis() {
        for (bx, by) in [(8, 8), (12, 12), (16, 16), (24, 24), (12, 8), (8, 12)] {
            // Window rectangles can start at negative coordinates on secondary monitors.
            // Native frame and hit test must agree without consuming any client pixels.
            for (left, top) in [(0, 0), (8, 0), (12, 12), (-1800, -900)] {
                let rect = Rect {
                    left,
                    top,
                    right: left + 400,
                    bottom: top + 300,
                };
                for (x, y, expected) in [
                    (0, 150, ResizeHit::Left),
                    (399, 150, ResizeHit::Right),
                    (200, 0, ResizeHit::Top),
                    (200, 299, ResizeHit::Bottom),
                    (0, 0, ResizeHit::TopLeft),
                    (399, 0, ResizeHit::TopRight),
                    (0, 299, ResizeHit::BottomLeft),
                    (399, 299, ResizeHit::BottomRight),
                ] {
                    assert_eq!(resize_hit(left + x, top + y, rect, bx, by), Some(expected));
                }
                assert_eq!(resize_hit(left + 200, top + 150, rect, bx, by), None);
                assert_eq!(resize_hit(left - 1, top + 150, rect, bx, by), None);
                let inset = resize_client(400, 300, bx, by);
                // Every non-client frame pixel hits an edge/corner; no visible client pixel does.
                for x in 0..400 {
                    for y in 0..300 {
                        let child_covers = x >= inset.left
                            && x < inset.right
                            && y >= inset.top
                            && y < inset.bottom;
                        assert_eq!(
                            resize_hit(left + x, top + y, rect, bx, by).is_none(),
                            child_covers
                        );
                    }
                }
            }
        }
        assert_eq!(
            resize_client(4, 2, 16, 16),
            Rect {
                left: 2,
                top: 1,
                right: 2,
                bottom: 1
            }
        );
    }
}
