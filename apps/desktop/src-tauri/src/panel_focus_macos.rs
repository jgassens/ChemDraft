use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    sel, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSApplication, NSApplicationDidUnhideNotification, NSApplicationWillHideNotification,
    NSAutoresizingMaskOptions, NSEvent, NSEventMask, NSView, NSWindow,
    NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification, NSWindowOrderingMode,
    NSWindowStyleMask, NSWindowWillCloseNotification,
};
use objc2_foundation::{
    ns_string, NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSPoint, NSString,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, Ordering},
        Once,
    },
};

// Packaged macOS 26: native resizing works ~1.5 pt inside all edges and corners,
// and ~3.3 pt inside right/bottom, but not left/top; ~5 pt works nowhere.
// Use about 2 pt, below the first failing probe on the narrowest edges, rather than
// intercepting a 6 pt strip where AppKit cannot resize and the page gets no hit.
// Both the overlay and activation monitor use this band through resize_edge.
const MAC_NATIVE_RESIZE_BAND_PT: f64 = 2.0;

#[derive(Default)]
struct Observers {
    notifications: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    clicks: Option<Retained<AnyObject>>,
    visibility: Option<VisibilityObservation>,
}

impl Drop for Observers {
    fn drop(&mut self) {
        // WillClose is synchronous, unlike Tauri's queued Destroyed fallback. Remove native
        // registrations before releasing callbacks and their captured window handles.
        if let Some(monitor) = self.clicks.take() {
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
        self.visibility.take();
        let center = NSNotificationCenter::defaultCenter();
        for token in self.notifications.drain(..) {
            unsafe { center.removeObserver((*token).as_ref()) };
        }
    }
}

thread_local! {
    static OBSERVERS: RefCell<HashMap<String, Observers>> = RefCell::default();
}

// NSKeyValueObserving.h: deliver the old and new values (NSKeyValueChangeOldKey/NewKey) in the
// change dictionary, after the change.
const NS_KEY_VALUE_OBSERVING_OPTION_NEW: usize = 0x01;
const NS_KEY_VALUE_OBSERVING_OPTION_OLD: usize = 0x02;

// Hiding the app (Cmd+H) orders every panel out but keeps enlarged panels enlarged, so the
// visibility backstop stands aside from the app's will-hide until it unhides.
static APP_HIDDEN: AtomicBool = AtomicBool::new(false);

fn observe_app_hide_once() {
    static REGISTERED: Once = Once::new();
    REGISTERED.call_once(|| {
        let center = NSNotificationCenter::defaultCenter();
        for (name, hidden) in unsafe {
            [
                (NSApplicationWillHideNotification, true),
                (NSApplicationDidUnhideNotification, false),
            ]
        } {
            let callback = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
                APP_HIDDEN.store(hidden, Ordering::SeqCst);
            });
            // Process-lifetime observers, like the document's own app-hide observer.
            std::mem::forget(unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &callback)
            });
        }
    });
}

/// A BOOL value from a key-value change dictionary; `None` when absent or not a number.
fn change_flag(change: &AnyObject, key: &NSString) -> Option<bool> {
    let value: Option<Retained<AnyObject>> = unsafe { msg_send![change, objectForKey: key] };
    value
        .filter(|value| unsafe { msg_send![&**value, respondsToSelector: sel!(boolValue)] })
        .map(|value| unsafe { msg_send![&value, boolValue] })
}

define_class!(
    // Our own observer is allocated with its final class. KVO alone manages the observed
    // window's class; never replace the class of an AppKit or WebKit object.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ChemDraftPanelVisibilityObserver"]
    #[ivars = Box<dyn Fn()>]
    struct PanelVisibilityObserver;

    impl PanelVisibilityObserver {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        unsafe fn observe_visibility(
            &self,
            _key: &NSString,
            _object: &AnyObject,
            change: &AnyObject,
            _context: *mut c_void,
        ) {
            // AppKit does not document `visible` as observable, so a re-order may notify too.
            // Act only on a real visible -> hidden change, never while the panel stays visible.
            if change_flag(change, ns_string!("old")) == Some(true)
                && change_flag(change, ns_string!("new")) == Some(false)
            {
                (self.ivars())();
            }
        }
    }
);

struct VisibilityObservation {
    window: Retained<NSWindow>,
    observer: Retained<PanelVisibilityObserver>,
}

impl Drop for VisibilityObservation {
    fn drop(&mut self) {
        // Retaining the window guarantees removal precedes deallocation.
        unsafe {
            let _: () = msg_send![&self.window,
                removeObserver: &*self.observer,
                forKeyPath: ns_string!("visible"),
                context: std::ptr::null_mut::<c_void>()
            ];
        }
    }
}

fn observe_panel<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    panel: &NSWindow,
    tokens: &mut Observers,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Panel observation requires the main thread.")?;
    observe_app_hide_once();
    let target = window.clone();
    let observer = PanelVisibilityObserver::alloc(mtm).set_ivars(Box::new(move || {
        // A backstop only: ChemDraft's own hide paths restore first (panel_full_size::before_hide).
        // For any other hide, restore an enlarged panel once it is really hidden.
        let webview: &tauri::Webview<R> = target.as_ref();
        let window = webview.window();
        if !APP_HIDDEN.load(Ordering::SeqCst)
            && !target.is_visible().unwrap_or(true)
            && super::super::panel_full_size::is_enlarged(&window)
        {
            super::super::panel_full_size::will_hide(&window);
        }
    }));
    let observer: Retained<PanelVisibilityObserver> = unsafe { msg_send![super(observer), init] };
    unsafe {
        let _: () = msg_send![panel,
            addObserver: &*observer,
            forKeyPath: ns_string!("visible"),
            options: NS_KEY_VALUE_OBSERVING_OPTION_OLD | NS_KEY_VALUE_OBSERVING_OPTION_NEW,
            context: std::ptr::null_mut::<c_void>()
        ];
    }
    tokens.visibility = Some(VisibilityObservation {
        window: panel.retain(),
        observer,
    });

    let target = window.clone();
    let number = panel.windowNumber();
    let callback = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
        let native = unsafe { event.as_ref() };
        // Runs before webview dispatch, only for this window's native mouse-downs.
        // Pass the original event through. Resize presses keep AppKit's non-activating path.
        // Never take key status from an app-modal session (an alert or open panel), where the panel's
        // sendEvent: never ran before this monitor replaced it.
        let outside_modal = MainThreadMarker::new().is_some_and(|mtm| {
            NSApplication::sharedApplication(mtm)
                .modalWindow()
                .is_none()
        });
        if native.windowNumber() == number
            && outside_modal
            && target.is_visible().unwrap_or(false)
            && !target.is_minimized().unwrap_or(true)
        {
            if let Ok(pointer) = target.ns_window() {
                let panel = unsafe { &*(pointer as *const NSWindow) };
                let resizing = panel.contentView().is_some_and(|content| {
                    let point = content.convertPoint_fromView(native.locationInWindow(), None);
                    let bounds = content.bounds();
                    resize_enabled(panel.styleMask())
                        && resize_edge(
                            point.x - bounds.origin.x,
                            point.y - bounds.origin.y,
                            bounds.size.width,
                            bounds.size.height,
                        )
                });
                if !resizing {
                    let _ = target.set_focusable(true);
                    panel.makeKeyWindow();
                }
            }
        }
        event.as_ptr()
    });
    tokens.clicks = Some(
        unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseDown
                    | NSEventMask::RightMouseDown
                    | NSEventMask::OtherMouseDown,
                &callback,
            )
        }
        .ok_or("Could not observe panel pointer activation.")?,
    );
    Ok(())
}

pub(super) fn resize_edge(x: f64, y: f64, width: f64, height: f64) -> bool {
    let edge = MAC_NATIVE_RESIZE_BAND_PT;
    x >= 0.0
        && y >= 0.0
        && x < width
        && y < height
        && (x < edge || y < edge || x >= width - edge || y >= height - edge)
}

fn resize_enabled(style: NSWindowStyleMask) -> bool {
    style.contains(NSWindowStyleMask::Resizable) && !style.contains(NSWindowStyleMask::FullScreen)
}

define_class!(
    // A transparent sibling of the WKWebView, inside Wry's existing content root.
    // Never detach that root: doing so moves WebKit through a nil window and changes
    // the contentView that tao reads for native handles and resize notifications.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "ChemDraftPanelResizeOverlay"]
    struct PanelResizeOverlay;

    impl PanelResizeOverlay {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let frame = self.frame();
            let Some(panel) = self.window() else {
                return std::ptr::null_mut();
            };
            if resize_enabled(panel.styleMask())
                && resize_edge(
                    point.x - frame.origin.x,
                    point.y - frame.origin.y,
                    frame.size.width,
                    frame.size.height,
                )
            {
                // Return the same native frame hit as a content root yielding its border.
                // Returning nil here would let the WKWebView sibling swallow the edge.
                // AppKit retains its resize cursors, resize loop and first-responder policy.
                // SAFETY: the retained window keeps its frame view alive during hit testing.
                return panel
                    .contentView()
                    .and_then(|content| unsafe { content.superview() })
                    .map_or(std::ptr::null_mut(), |frame| {
                        Retained::as_ptr(&frame).cast_mut()
                    });
            }
            // The overlay never takes an interior hit or becomes first responder.
            std::ptr::null_mut()
        }
    }
);

pub(super) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let mtm =
        MainThreadMarker::new().ok_or("Panel resize installation requires the main thread.")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let panel = unsafe { pointer.as_ref() }.ok_or("Could not access native panel window.")?;
    let content = panel
        .contentView()
        .ok_or("Could not access panel content view.")?;
    if content
        .subviews()
        .iter()
        .any(|view| view.isKindOfClass(PanelResizeOverlay::class()))
    {
        return Ok(());
    }
    // SAFETY: the live panel owns the frame view; this main-thread setup cannot outlive it.
    if unsafe { content.superview() }.is_none() {
        return Err("Could not access panel frame view for native resizing.".into());
    }
    let overlay = PanelResizeOverlay::alloc(mtm).set_ivars(());
    let overlay: Retained<PanelResizeOverlay> =
        unsafe { msg_send![super(overlay), initWithFrame: content.bounds()] };
    let autoresize =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;
    overlay.setAutoresizingMask(autoresize);
    content.addSubview_positioned_relativeTo(&overlay, NSWindowOrderingMode::Above, None);
    log_view_hierarchy(window.label(), panel);
    Ok(())
}

fn find_webview(view: &NSView) -> Option<Retained<NSView>> {
    if view.isKindOfClass(objc2_web_kit::WKWebView::class()) {
        return Some(view.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| find_webview(&child))
}

fn log_view_hierarchy(label: &str, panel: &NSWindow) {
    // Inspect the tree directly: Tauri's with_webview calls Wry's ns_window(), which
    // unwraps WKWebView.window() and would panic in the detached-view case we need to log.
    // A missing WKWebView is explicit (false / None), never a fabricated zero-size frame.
    let content = panel.contentView();
    let view = content.as_ref().and_then(|content| find_webview(content));
    let class = content.as_ref().map_or("<none>".into(), |content| {
        content.class().name().to_string_lossy()
    });
    let descendant = view.as_ref().is_some_and(|view| {
        content
            .as_ref()
            .is_some_and(|content| view.isDescendantOf(content))
    });
    super::super::palette_focus_log(format_args!(
        "panel-view label={} content_class={} content_frame={:?} wk_descendant={} \
         wk_frame={:?} wk_hidden={:?} wk_in_window={} style_mask={:#x}",
        label,
        class,
        content.as_ref().map(|content| content.frame()),
        descendant,
        view.as_ref().map(|view| view.frame()),
        view.as_ref().map(|view| view.isHidden()),
        view.as_ref()
            .and_then(|view| view.window())
            .is_some_and(|window| std::ptr::eq(&*window, panel)),
        panel.styleMask().bits(),
    ));
}

pub(super) fn observe<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    MainThreadMarker::new().ok_or("Panel observation requires the main thread.")?;
    forget(window.label());
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let panel = unsafe { pointer.as_ref() }.ok_or("Could not access native panel window.")?;
    let center = NSNotificationCenter::defaultCenter();
    let mut tokens = Observers::default();
    // Palette fields retain guarded input leases; only plugin panels get click activation
    // and full-size restoration before native hides.
    if super::super::is_plugin_panel_window_label(window.label()) {
        observe_panel(window, panel, &mut tokens)?;
    }
    for (name, active) in unsafe {
        [
            (NSWindowDidBecomeKeyNotification, true),
            (NSWindowDidResignKeyNotification, false),
        ]
    } {
        let target = window.clone();
        let callback = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            super::activation(&target, active);
        });
        // Immediate delivery tags the lease before any queued IPC or focus operation.
        tokens.notifications.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(panel),
                None,
                &callback,
            )
        });
    }
    let target = window.clone();
    let label = window.label().to_string();
    let callback = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
        if super::super::is_plugin_panel_window_label(&label) {
            let webview: &tauri::Webview<R> = target.as_ref();
            super::super::panel_full_size::will_hide(&webview.window());
        }
        forget(&label);
    });
    tokens.notifications.push(unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillCloseNotification),
            Some(panel),
            None,
            &callback,
        )
    });
    OBSERVERS.with(|observers| observers.borrow_mut().insert(window.label().into(), tokens));
    Ok(())
}

pub(super) fn forget(label: &str) {
    // Drop outside the map's borrow: AppKit removal may invoke native callbacks.
    let tokens = OBSERVERS.with(|observers| observers.borrow_mut().remove(label));
    drop(tokens);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_resize_band_covers_edges_and_corners_without_swallowing_page_hits() {
        let width = 400.0;
        let height = 300.0;
        for (inset, in_band) in [(1.5, true), (2.5, false), (5.0, false)] {
            for (x, y) in [
                (inset, height / 2.0),
                (width - inset, height / 2.0),
                (width / 2.0, inset),
                (width / 2.0, height - inset),
                (inset, inset),
                (width - inset, inset),
                (inset, height - inset),
                (width - inset, height - inset),
            ] {
                assert_eq!(resize_edge(x, y, width, height), in_band, "({x}, {y})");
            }
        }
    }

    #[test]
    fn native_resize_requires_resizable_and_not_full_screen() {
        for base in [
            NSWindowStyleMask::Borderless,
            NSWindowStyleMask::NonactivatingPanel,
        ] {
            assert!(!resize_enabled(base));
            assert!(resize_enabled(base | NSWindowStyleMask::Resizable));
            assert!(!resize_enabled(
                base | NSWindowStyleMask::Resizable | NSWindowStyleMask::FullScreen
            ));
        }
    }
}
