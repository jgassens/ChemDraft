use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSEvent, NSEventMask, NSView, NSWindow,
    NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification, NSWindowStyleMask,
    NSWindowWillCloseNotification,
};
use objc2_foundation::{
    ns_string, NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSPoint, NSString,
};
use std::{cell::RefCell, collections::HashMap, ffi::c_void, ptr::NonNull};

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

define_class!(
    // Our own observer is allocated with its final class. KVO alone manages the observed
    // window's class; never replace the class of an AppKit or WebKit object.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
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
            let prior: Option<Retained<AnyObject>> = unsafe {
                msg_send![change, objectForKey: ns_string!("notificationIsPrior")]
            };
            if prior.is_some_and(|value| unsafe { msg_send![&value, boolValue] }) {
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
    let target = window.clone();
    let observer = PanelVisibilityObserver::alloc(mtm).set_ivars(Box::new(move || {
        // Prior notification: restore before orderOut: detaches the child window.
        // Ignore shows (the old value is then false).
        if target.is_visible().unwrap_or(false) {
            let webview: &tauri::Webview<R> = target.as_ref();
            super::super::panel_full_size::will_hide(&webview.window());
        }
    }));
    let observer: Retained<PanelVisibilityObserver> = unsafe { msg_send![super(observer), init] };
    unsafe {
        let _: () = msg_send![panel,
            addObserver: &*observer,
            forKeyPath: ns_string!("visible"),
            options: 8usize, // NSKeyValueObservingOptionPrior
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
        // Pass the original event through, including native resize presses.
        if native.windowNumber() == number
            && target.is_visible().unwrap_or(false)
            && !target.is_minimized().unwrap_or(true)
        {
            let _ = target.set_focusable(true);
            if let Ok(pointer) = target.ns_window() {
                unsafe { &*(pointer as *const NSWindow) }.makeKeyWindow();
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
    let edge = super::RESIZE_ZONE_LOGICAL_PX;
    x >= 0.0
        && y >= 0.0
        && x < width
        && y < height
        && (x < edge || y < edge || x >= width - edge || y >= height - edge)
}

define_class!(
    // A new container, not a replacement class for Wry's live content view. Wry's view,
    // tracking areas and handlers remain intact as an autoresizing child.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    struct PanelResizeContainer;

    impl PanelResizeContainer {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let frame = self.frame();
            if self.window().is_some_and(|panel| {
                let style = panel.styleMask();
                style.contains(NSWindowStyleMask::Resizable)
                    && !style.contains(NSWindowStyleMask::FullScreen)
            }) && resize_edge(
                point.x - frame.origin.x,
                point.y - frame.origin.y,
                frame.size.width,
                frame.size.height,
            ) {
                // NSThemeFrame supplies native cursors and its non-activating resize loop
                // when the content root yields the border, including descendants.
                return std::ptr::null_mut();
            }
            unsafe { msg_send![super(self), hitTest: point] }
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
    if content.isKindOfClass(PanelResizeContainer::class()) {
        return Ok(());
    }
    let container = PanelResizeContainer::alloc(mtm).set_ivars(());
    let container: Retained<PanelResizeContainer> =
        unsafe { msg_send![super(container), initWithFrame: content.frame()] };
    let autoresize =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;
    container.setAutoresizingMask(autoresize);
    content.setAutoresizingMask(autoresize);
    // Supported reparenting with every original class intact. Retain content across
    // setContentView; WebKit can pair its window KVO removal/registration normally.
    panel.setContentView(Some(&container));
    content.setFrame(container.bounds());
    container.addSubview(&content);
    Ok(())
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
