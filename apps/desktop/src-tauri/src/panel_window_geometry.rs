//! Physical-pixel geometry for the panel's inner resize zones and existing Tauri overlay.

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

pub(super) fn resize_border(dpi: u32) -> i32 {
    (super::RESIZE_ZONE_LOGICAL_PX * f64::from(dpi) / 96.0).round() as i32
}

/// `rect` is the visible content boundary, never the outer invisible window frame.
/// It and the point must use the same origin (screen, window, or client).
pub(super) fn resize_hit(x: i32, y: i32, rect: Rect, border: i32) -> Option<ResizeHit> {
    if x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom {
        return None;
    }
    let left = x < rect.left + border;
    let right = x >= rect.right - border;
    let top = y < rect.top + border;
    let bottom = y >= rect.bottom - border;
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

/// Interior cut out of the input overlay, leaving every edge above WebView2.
pub(super) fn overlay_cutout(client: Rect, border: i32) -> Rect {
    let left = (client.left + border).min(client.right);
    let top = (client.top + border).min(client.bottom);
    Rect {
        left,
        top,
        right: (client.right - border).max(left),
        bottom: (client.bottom - border).max(top),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_logical_pixels_inside_every_edge_and_corner_at_each_dpi() {
        for (dpi, expected_border) in [(96, 6), (144, 9), (192, 12)] {
            let border = resize_border(dpi);
            assert_eq!(border, expected_border);
            let rect = Rect {
                left: -1800,
                top: -900,
                right: -1400,
                bottom: -600,
            };
            for depth in 0..border {
                for (x, y, expected) in [
                    (rect.left + depth, -750, ResizeHit::Left),
                    (rect.right - 1 - depth, -750, ResizeHit::Right),
                    (-1600, rect.top + depth, ResizeHit::Top),
                    (-1600, rect.bottom - 1 - depth, ResizeHit::Bottom),
                ] {
                    assert_eq!(resize_hit(x, y, rect, border), Some(expected), "dpi={dpi}");
                }
                for other in 0..border {
                    for (x, y, expected) in [
                        (rect.left + depth, rect.top + other, ResizeHit::TopLeft),
                        (
                            rect.right - 1 - depth,
                            rect.top + other,
                            ResizeHit::TopRight,
                        ),
                        (
                            rect.left + depth,
                            rect.bottom - 1 - other,
                            ResizeHit::BottomLeft,
                        ),
                        (
                            rect.right - 1 - depth,
                            rect.bottom - 1 - other,
                            ResizeHit::BottomRight,
                        ),
                    ] {
                        assert_eq!(resize_hit(x, y, rect, border), Some(expected), "dpi={dpi}");
                    }
                }
            }
            for (x, y) in [
                (rect.left + border, -750),
                (rect.right - border - 1, -750),
                (-1600, rect.top + border),
                (-1600, rect.bottom - border - 1),
                (rect.left + border, rect.top + border),
                (rect.right - border - 1, rect.bottom - border - 1),
            ] {
                assert_eq!(resize_hit(x, y, rect, border), None, "dpi={dpi}");
            }
        }
    }

    #[test]
    fn invisible_windows_frame_never_resizes_and_overlay_wins_every_inner_pixel() {
        for (dpi, frame, win11_top) in [(96, 8, 1), (144, 12, 2), (192, 16, 2)] {
            let border = resize_border(dpi);
            let window = Rect {
                left: -700,
                top: -300,
                right: -300,
                bottom: 0,
            };
            // Tao's Win10/11 client origins are unchanged, including shadowless windows.
            for (left, top, right, bottom) in [
                (frame, 0, frame, frame),
                (frame, win11_top, frame, frame),
                (0, 0, 0, 0),
            ] {
                let client = Rect {
                    left: window.left + left,
                    top: window.top + top,
                    right: window.right - right,
                    bottom: window.bottom - bottom,
                };
                let local = Rect {
                    left: 0,
                    top: 0,
                    right: client.right - client.left,
                    bottom: client.bottom - client.top,
                };
                let cutout = overlay_cutout(local, border);
                assert_eq!(cutout.left, border);
                assert_eq!(cutout.top, border);
                assert_eq!(local.right - cutout.right, border);
                assert_eq!(local.bottom - cutout.bottom, border);
                // Outside pixels never resize. Inside, every grab zone belongs to the
                // overlay, including the right edge above WebView2's scrollbar.
                for y in window.top - 1..=window.bottom {
                    for x in window.left - 1..=window.right {
                        let in_client = x >= client.left
                            && x < client.right
                            && y >= client.top
                            && y < client.bottom;
                        let local_x = x - client.left;
                        let local_y = y - client.top;
                        let in_overlay = in_client
                            && (local_x < cutout.left
                                || local_x >= cutout.right
                                || local_y < cutout.top
                                || local_y >= cutout.bottom);
                        assert_eq!(
                            in_overlay,
                            resize_hit(x, y, client, border).is_some(),
                            "dpi={dpi}, client={client:?}, x={x}, y={y}"
                        );
                    }
                }
                // The title below the top zone still reaches DOM title dragging.
                for y in border..28 * dpi as i32 / 96 {
                    assert_eq!(
                        resize_hit(client.left + border, client.top + y, client, border),
                        None
                    );
                    assert_eq!(
                        resize_hit(client.right - border - 1, client.top + y, client, border),
                        None
                    );
                }
            }
        }
    }

    #[test]
    fn overlay_clamps_to_client_and_maximized_windows_have_no_grip() {
        let rect = Rect {
            left: 0,
            top: 0,
            right: 400,
            bottom: 300,
        };
        assert_eq!(overlay_cutout(rect, 0), rect);
        let empty = Rect {
            right: 0,
            bottom: 0,
            ..rect
        };
        assert_eq!(overlay_cutout(empty, 12), empty);
        let short = Rect { bottom: 3, ..rect };
        let cutout = overlay_cutout(short, 12);
        assert_eq!(cutout.top, 3);
        assert_eq!(cutout.bottom, 3);
        for (x, y) in [(0, 0), (200, 0), (399, 0), (0, 150), (399, 299)] {
            assert_eq!(resize_hit(x, y, rect, 0), None);
        }
    }
}
