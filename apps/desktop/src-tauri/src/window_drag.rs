/// The invoking window is supplied by Tauri, never by a caller-provided label.
pub(crate) fn start(window: &tauri::WebviewWindow, grab_x: f64, grab_y: f64) -> Result<(), String> {
    compensate_before_drag(window, grab_x, grab_y)?;
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg(windows)]
fn compensate_before_drag(
    window: &tauri::WebviewWindow,
    grab_x: f64,
    grab_y: f64,
) -> Result<(), String> {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::GetAsyncKeyState,
        WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON},
    };
    // SAFETY: SM_SWAPBUTTON is a valid system metric and this call has no pointer arguments.
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) != 0 };
    // SAFETY: GetAsyncKeyState accepts the virtual-key code and has no pointer arguments. Its high bit
    // reports whether the button is held NOW, unlike the message-queue state from GetKeyState.
    let button_down = unsafe { GetAsyncKeyState(primary_button_vkey(swapped)) < 0 };
    if !button_down {
        return Ok(());
    }
    let cursor = window
        .cursor_position()
        .map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let inner = window.inner_position().map_err(|error| error.to_string())?;
    let (dx, dy) = compensation_delta(
        (grab_x, grab_y),
        scale,
        (cursor.x, cursor.y),
        (inner.x, inner.y),
    );
    if dx != 0 || dy != 0 {
        let outer = window.outer_position().map_err(|error| error.to_string())?;
        // Preserve the inner/outer frame offset. tao's set_position uses SWP_NOACTIVATE |
        // SWP_NOSIZE | SWP_NOZORDER: this neither focuses nor raises nor resizes the window.
        window
            .set_position(tauri::PhysicalPosition::new(
                outer.x.saturating_add(dx),
                outer.y.saturating_add(dy),
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn compensate_before_drag(
    _window: &tauri::WebviewWindow,
    _grab_x: f64,
    _grab_y: f64,
) -> Result<(), String> {
    // macOS: tao 0.35.3 src/platform_impl/macos/window.rs::drag_window reads NSApp.currentEvent.
    // If its type equals 0x15, tao substitutes a LeftMouseDown synthesized from mouseLocation
    // and the current event's modifiers, timestamp and window number. It passes that event to
    // performWindowDragWithEvent. Leave macOS behavior as it was before this change; whether
    // its drag anchor loses early motion is unmeasured.
    // Other platforms retain their existing native drag behavior as well.
    Ok(())
}

/// GetAsyncKeyState reports physical buttons; select the one mapped to the logical primary button.
#[cfg(any(windows, test))]
fn primary_button_vkey(swapped: bool) -> i32 {
    if swapped {
        0x02 // VK_RBUTTON
    } else {
        0x01 // VK_LBUTTON
    }
}

/// Physical motion since the press, using client CSS coordinates and the window's own scale.
/// Reject the entire correction if stale/untrusted coordinates imply an implausible jump.
#[cfg(any(windows, test))]
fn compensation_delta(
    grab: (f64, f64),
    scale: f64,
    cursor: (f64, f64),
    inner: (i32, i32),
) -> (i32, i32) {
    const MAX_DELTA: f64 = 300.0;
    let dx = cursor.0 - grab.0 * scale - f64::from(inner.0);
    let dy = cursor.1 - grab.1 * scale - f64::from(inner.1);
    if !scale.is_finite()
        || scale <= 0.0
        || !dx.is_finite()
        || !dy.is_finite()
        || dx.abs() > MAX_DELTA
        || dy.abs() > MAX_DELTA
    {
        return (0, 0);
    }
    (dx.round() as i32, dy.round() as i32)
}

#[cfg(test)]
mod tests {
    use super::{compensation_delta, primary_button_vkey};

    #[test]
    fn primary_button_honors_swapped_buttons() {
        assert_eq!(primary_button_vkey(false), 0x01); // VK_LBUTTON
        assert_eq!(primary_button_vkey(true), 0x02); // VK_RBUTTON
    }

    #[test]
    fn recovers_motion_at_each_scale_using_the_client_origin() {
        // Negative monitor origin and a frame offset: screenX * DPR cannot substitute for clientX.
        for scale in [1.0, 1.5, 2.0] {
            let grab = (42.0, 12.0);
            let inner = (-1600, 250);
            let press = (
                f64::from(inner.0) + grab.0 * scale,
                f64::from(inner.1) + grab.1 * scale,
            );
            assert_eq!(compensation_delta(grab, scale, press, inner), (0, 0));
            assert_eq!(
                compensation_delta(grab, scale, (press.0 + 15.0, press.1 - 5.0), inner),
                (15, -5)
            );
            assert_eq!(
                compensation_delta(grab, scale, (press.0 + 301.0, press.1), inner),
                (0, 0)
            );
            assert_eq!(
                compensation_delta(grab, scale, (press.0, press.1 - 301.0), inner),
                (0, 0)
            );
        }
    }

    #[test]
    fn rejects_invalid_coordinates_and_scales() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                compensation_delta((0.0, 0.0), scale, (0.0, 0.0), (0, 0)),
                (0, 0)
            );
        }
        assert_eq!(
            compensation_delta((f64::NAN, 0.0), 1.0, (0.0, 0.0), (0, 0)),
            (0, 0)
        );
        assert_eq!(
            compensation_delta((0.0, 0.0), 1.0, (f64::INFINITY, 0.0), (0, 0)),
            (0, 0)
        );
    }
}
