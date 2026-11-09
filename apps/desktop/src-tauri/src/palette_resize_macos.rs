//! Public AppKit edge handles: no system corner/locked-axis cursor or resize loop.

use objc2::{
    define_class, msg_send, rc::Retained, sel, ClassType, DefinedClass, MainThreadMarker,
    MainThreadOnly,
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSCursor, NSCursorFrameResizeDirections,
    NSCursorFrameResizePosition, NSEvent, NSEventMask, NSEventType, NSView, NSWindow,
    NSWindowOrderingMode,
};
use objc2_foundation::{ns_string, NSPoint, NSRect, NSSize};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

use super::super::{
    palette_geometry::Orientation,
    palette_resize_hit_test::{self as policy, Edge, Rect},
};

// Match the narrow native grab band used by ChemDraft's other AppKit utility windows.
const EDGE_BAND_PT: f64 = 2.0;

struct HandleState {
    orientation: Cell<Orientation>,
    limits: Cell<(f64, f64)>,
    resized: Box<dyn Fn()>,
    finished: Box<dyn Fn()>,
}

thread_local! {
    static HANDLES: RefCell<HashMap<String, Retained<PaletteResizeHandles>>> = RefCell::default();
}

fn resize_cursor(edge: Edge) -> Retained<NSCursor> {
    // The directional frame cursor was added in macOS 15. Retain the older cursor on older hosts.
    let modern: bool = unsafe {
        msg_send![NSCursor::class(), respondsToSelector: sel!(frameResizeCursorFromPosition:inDirections:)]
    };
    if modern {
        let position = match edge {
            Edge::Left => NSCursorFrameResizePosition::Left,
            Edge::Right => NSCursorFrameResizePosition::Right,
            Edge::Top => NSCursorFrameResizePosition::Top,
            Edge::Bottom => NSCursorFrameResizePosition::Bottom,
        };
        NSCursor::frameResizeCursorFromPosition_inDirections(
            position,
            NSCursorFrameResizeDirections::All,
        )
    } else {
        #[allow(deprecated)] // Required for macOS versions before the frame cursor API.
        match edge {
            Edge::Left | Edge::Right => NSCursor::resizeLeftRightCursor(),
            Edge::Top | Edge::Bottom => NSCursor::resizeUpDownCursor(),
        }
    }
}

define_class!(
    // A transparent sibling above WebKit. Interior, locked-edge and corner hits pass through.
    // Keep Wry's content root attached, and never change an existing AppKit object's class.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "ChemDraftPaletteResizeHandles"]
    #[ivars = HandleState]
    struct PaletteResizeHandles;

    impl PaletteResizeHandles {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let frame = self.frame();
            if self.edge_at(NSPoint::new(point.x - frame.origin.x, point.y - frame.origin.y)).is_some() {
                (self as *const Self).cast_mut().cast()
            } else {
                std::ptr::null_mut()
            }
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true // Resizing a nonactivating utility must not require focus first.
        }

        #[unsafe(method(resetCursorRects))]
        fn reset_cursor_rects(&self) {
            let (minimum, maximum) = self.ivars().limits.get();
            if minimum >= maximum { return; }
            let bounds = self.bounds();
            let orientation = self.ivars().orientation.get();
            for (edge, region) in policy::regions(orientation, bounds.size.width, bounds.size.height, EDGE_BAND_PT) {
                let cursor = resize_cursor(edge);
                self.addCursorRect_cursor(NSRect::new(
                    NSPoint::new(region.x, bounds.size.height - region.y - region.height),
                    NSSize::new(region.width, region.height),
                ), &cursor);
            }
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            let Some(edge) = self.edge_at(point) else { return; };
            let Some(window) = self.window() else { return; };
            let original = window.frame();
            let frame = Rect { x: original.origin.x, y: original.origin.y,
                width: original.size.width, height: original.size.height };
            let start = NSEvent::mouseLocation();
            // Public AppKit tracking loop: native events, no synthetic DOM events, no activation.
            // With the system resize mask disabled, no corner or locked edge can start a second loop.
            while let Some(next) = window.nextEventMatchingMask_untilDate_inMode_dequeue(
                NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
                None, ns_string!("NSEventTrackingRunLoopMode"), true,
            ) {
                let point = NSEvent::mouseLocation();
                let (minimum, maximum) = self.ivars().limits.get();
                let next_frame = policy::dragged_frame(edge, frame, point.x - start.x, point.y - start.y, minimum, maximum);
                let next_frame = NSRect::new(NSPoint::new(next_frame.x, next_frame.y), NSSize::new(next_frame.width, next_frame.height));
                if next_frame != window.frame() {
                    window.setFrame_display(next_frame, true);
                    (self.ivars().resized)();
                }
                if next.r#type() == NSEventType::LeftMouseUp { break; }
            }
            (self.ivars().finished)();
        }
    }
);

impl PaletteResizeHandles {
    fn edge_at(&self, point: NSPoint) -> Option<Edge> {
        let (minimum, maximum) = self.ivars().limits.get();
        if minimum >= maximum {
            return None;
        }
        let bounds = self.bounds();
        policy::hit_test(
            self.ivars().orientation.get(),
            point.x,
            bounds.size.height - point.y,
            bounds.size.width,
            bounds.size.height,
            EDGE_BAND_PT,
        )
    }
}

pub(super) fn install<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    orientation: Orientation,
) -> Result<(), String> {
    let mtm =
        MainThreadMarker::new().ok_or("Palette resize installation requires the main thread.")?;
    let pointer = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    // SAFETY: this live Tauri window owns the NSWindow, on the main thread.
    let native = unsafe { pointer.as_ref() }.ok_or("Could not access the palette window.")?;
    let content = native
        .contentView()
        .ok_or("Could not access the palette content view.")?;
    let target = window.clone();
    let finish_target = window.clone();
    let handles = PaletteResizeHandles::alloc(mtm).set_ivars(HandleState {
        orientation: Cell::new(orientation),
        limits: Cell::new((0.0, 0.0)), // Enabled when Rust applies the first measured constraints.
        resized: Box::new(move || {
            let webview: &tauri::Webview<R> = target.as_ref();
            super::super::palette_resize::user_resized(&webview.window());
        }),
        finished: Box::new(move || {
            let webview: &tauri::Webview<R> = finish_target.as_ref();
            super::super::palette_resize::flush_pending(&webview.window());
        }),
    });
    let handles: Retained<PaletteResizeHandles> =
        unsafe { msg_send![super(handles), initWithFrame: content.bounds()] };
    handles.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    // The builder disables system resizing at creation. Changing style masks here could rebuild
    // AppKit's frame view. Equal min/max alone cannot explicitly suppress native corner targets.
    content.addSubview_positioned_relativeTo(&handles, NSWindowOrderingMode::Above, None);
    HANDLES.with(|handles_by_label| {
        handles_by_label
            .borrow_mut()
            .insert(window.label().into(), handles)
    });
    Ok(())
}

pub(super) fn constrain<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    orientation: Orientation,
    minimum: (f64, f64),
    maximum: (f64, f64),
) -> Result<(), String> {
    let pointer = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    // SAFETY: the size owner invokes this synchronously on the window's UI thread.
    let native = unsafe { pointer.as_ref() }.ok_or("Could not access the palette window.")?;
    // Tauri/tao queues these setters on macOS; set them synchronously too, before showing a frame.
    native.setContentMinSize(NSSize::new(minimum.0, minimum.1));
    native.setContentMaxSize(NSSize::new(maximum.0, maximum.1));
    let handles = HANDLES.with(|handles| handles.borrow().get(window.label()).cloned());
    if let Some(handles) = handles {
        handles.ivars().orientation.set(orientation);
        handles.ivars().limits.set((
            orientation.length(minimum.0, minimum.1),
            orientation.length(maximum.0, maximum.1),
        ));
        native.invalidateCursorRectsForView(&handles);
    }
    Ok(())
}

pub(super) fn forget(label: &str) {
    let handles = HANDLES.with(|handles| handles.borrow_mut().remove(label));
    if let Some(handles) = handles {
        handles.removeFromSuperview();
    }
}
