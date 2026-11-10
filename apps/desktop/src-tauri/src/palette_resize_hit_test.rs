//! Shared, pure toolbar edge/cursor policy. Corners and the locked axis are client hits.

use super::palette_geometry::Orientation;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Coordinates start at the top left. Leave a band-sized square inert at every corner.
pub(super) fn regions(
    orientation: Orientation,
    width: f64,
    height: f64,
    band: f64,
) -> [(Edge, Rect); 2] {
    let band = band.max(0.0).min(width / 2.0).min(height / 2.0);
    match orientation {
        Orientation::Horizontal => [
            (
                Edge::Left,
                Rect {
                    x: 0.0,
                    y: band,
                    width: band,
                    height: height - 2.0 * band,
                },
            ),
            (
                Edge::Right,
                Rect {
                    x: width - band,
                    y: band,
                    width: band,
                    height: height - 2.0 * band,
                },
            ),
        ],
        Orientation::Vertical => [
            (
                Edge::Top,
                Rect {
                    x: band,
                    y: 0.0,
                    width: width - 2.0 * band,
                    height: band,
                },
            ),
            (
                Edge::Bottom,
                Rect {
                    x: band,
                    y: height - band,
                    width: width - 2.0 * band,
                    height: band,
                },
            ),
        ],
    }
}

pub(super) fn hit_test(
    orientation: Orientation,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    band: f64,
) -> Option<Edge> {
    regions(orientation, width, height, band)
        .into_iter()
        .find_map(|(edge, rect)| {
            (x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height)
                .then_some(edge)
        })
}

#[cfg(any(windows, test))]
pub(super) fn windows_hit(edge: Option<Edge>, fallback: isize) -> isize {
    // WinUser.h hit codes, kept pure so both hosts test the Windows policy.
    match edge {
        Some(Edge::Left) => 10,
        Some(Edge::Right) => 11,
        Some(Edge::Top) => 12,
        Some(Edge::Bottom) => 15,
        None if (10..=17).contains(&fallback) => 1, // HTCLIENT; preserve HTCAPTION and other non-resize hits.
        None => fallback,
    }
}

/// AppKit screen coordinates increase upwards. Keep the opposite edge anchored and clamp length.
#[cfg(any(target_os = "macos", test))]
pub(super) fn dragged_frame(
    edge: Edge,
    frame: Rect,
    dx: f64,
    dy: f64,
    minimum: f64,
    maximum: f64,
) -> Rect {
    let mut result = frame;
    match edge {
        Edge::Left => {
            result.width = (frame.width - dx).clamp(minimum, maximum);
            result.x += frame.width - result.width;
        }
        Edge::Right => result.width = (frame.width + dx).clamp(minimum, maximum),
        Edge::Top => result.height = (frame.height + dy).clamp(minimum, maximum),
        Edge::Bottom => {
            result.height = (frame.height - dy).clamp(minimum, maximum);
            result.y += frame.height - result.height;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowed_edge_centres_resize_at_each_scale_and_orientation() {
        for scale in [1.0, 1.5, 2.0] {
            let width = 400.0 * scale;
            let height = 100.0 * scale;
            let band = 6.0 * scale;
            let points = [
                (1.0, 50.0, Edge::Left),
                (399.0, 50.0, Edge::Right),
                (200.0, 1.0, Edge::Top),
                (200.0, 99.0, Edge::Bottom),
            ];
            for orientation in [Orientation::Horizontal, Orientation::Vertical] {
                for (x, y, edge) in points {
                    let allowed = matches!(
                        (orientation, edge),
                        (Orientation::Horizontal, Edge::Left | Edge::Right)
                            | (Orientation::Vertical, Edge::Top | Edge::Bottom)
                    );
                    let hit = hit_test(orientation, x * scale, y * scale, width, height, band);
                    assert_eq!(hit, allowed.then_some(edge));
                    assert_eq!(
                        windows_hit(hit, 1),
                        if allowed {
                            windows_hit(Some(edge), 1)
                        } else {
                            1
                        }
                    );
                }
                for (x, y) in [
                    (1.0, 1.0),
                    (399.0, 1.0),
                    (1.0, 99.0),
                    (399.0, 99.0),
                    (200.0, 50.0),
                    (-1.0, 50.0),
                    (400.0, 50.0),
                    (200.0, -1.0),
                    (200.0, 100.0),
                ] {
                    assert_eq!(
                        hit_test(orientation, x * scale, y * scale, width, height, band),
                        None
                    );
                }
            }
        }
    }

    #[test]
    fn windows_suppresses_stale_corner_and_locked_hits_but_preserves_title_dragging() {
        for (edge, code) in [
            (Edge::Left, 10),
            (Edge::Right, 11),
            (Edge::Top, 12),
            (Edge::Bottom, 15),
        ] {
            assert_eq!(windows_hit(Some(edge), 1), code);
        }
        for hit in 10..=17 {
            assert_eq!(windows_hit(None, hit), 1);
        }
        for hit in [-1, 0, 1, 2, 3] {
            assert_eq!(windows_hit(None, hit), hit);
        }
        assert_eq!(windows_hit(Some(Edge::Left), 13), 10);
        assert_eq!(windows_hit(Some(Edge::Bottom), 17), 15);
    }

    #[test]
    fn drag_clamps_the_allowed_axis_and_anchors_the_opposite_edge() {
        let frame = Rect {
            x: 20.0,
            y: 30.0,
            width: 200.0,
            height: 100.0,
        };
        for edge in [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom] {
            let result = dragged_frame(edge, frame, 1000.0, 1000.0, 80.0, 300.0);
            match edge {
                Edge::Left | Edge::Right => {
                    assert_eq!((result.y, result.height), (frame.y, frame.height));
                    if edge == Edge::Left {
                        assert_eq!(
                            (result.width, result.x + result.width),
                            (80.0, frame.x + frame.width)
                        );
                    } else {
                        assert_eq!((result.width, result.x), (300.0, frame.x));
                    }
                }
                Edge::Top | Edge::Bottom => {
                    assert_eq!((result.x, result.width), (frame.x, frame.width));
                    if edge == Edge::Bottom {
                        assert_eq!(
                            (result.height, result.y + result.height),
                            (80.0, frame.y + frame.height)
                        );
                    } else {
                        assert_eq!((result.height, result.y), (300.0, frame.y));
                    }
                }
            }
        }
    }

    #[test]
    fn degenerate_windows_have_no_overlapping_resize_targets() {
        for orientation in [Orientation::Horizontal, Orientation::Vertical] {
            assert_eq!(hit_test(orientation, 1.0, 1.0, 2.0, 2.0, 6.0), None);
        }
    }

    #[test]
    fn edge_targets_and_cursor_regions_have_the_same_boundaries() {
        for orientation in [Orientation::Horizontal, Orientation::Vertical] {
            for (edge, rect) in regions(orientation, 400.0, 100.0, 2.0) {
                for (x, y) in [
                    (rect.x, rect.y),
                    (rect.x + rect.width - 0.1, rect.y + rect.height - 0.1),
                ] {
                    assert_eq!(hit_test(orientation, x, y, 400.0, 100.0, 2.0), Some(edge));
                }
                assert_eq!(
                    hit_test(
                        orientation,
                        rect.x + rect.width,
                        rect.y + rect.height,
                        400.0,
                        100.0,
                        2.0
                    ),
                    None
                );
            }
        }
    }
}
