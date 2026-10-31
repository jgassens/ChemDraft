use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, ClassBuilder, ProtocolObject, Sel},
    sel,
};
use objc2_app_kit::{
    NSView, NSWindow, NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification,
    NSWindowStyleMask,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect};
use std::{cell::RefCell, collections::HashMap, ptr::NonNull, rc::Rc};

type Observers = Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>;
type HideCallback = (String, Rc<dyn Fn()>);
thread_local! {
    static OBSERVERS: RefCell<HashMap<String, Observers>> = RefCell::default();
    static HIDE_CALLBACKS: RefCell<HashMap<usize, HideCallback>> = RefCell::default();
}

unsafe extern "C-unwind" fn panel_order_out(panel: &AnyObject, _: Sel, sender: *mut AnyObject) {
    let callback = HIDE_CALLBACKS.with(|callbacks| {
        callbacks
            .borrow()
            .get(&(panel as *const AnyObject as usize))
            .map(|(_, callback)| callback.clone())
    });
    if let Some(callback) = callback {
        callback();
    }
    let superclass = AnyClass::get(c"ChemDraftRestorablePanelWindow")
        .and_then(AnyClass::superclass)
        .expect("panel window superclass");
    unsafe {
        let _: () = msg_send![super(panel, superclass), orderOut: sender];
    }
}

fn install_hide_hook<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    panel: &NSWindow,
) -> Result<(), String> {
    let object: &AnyObject = panel;
    let name = c"ChemDraftRestorablePanelWindow";
    if object.class().name() != name {
        let original = object.class();
        let class = if let Some(class) = AnyClass::get(name) {
            if class.superclass() != Some(original) {
                return Err("Panel window class changed during hide installation.".into());
            }
            class
        } else {
            let mut builder =
                ClassBuilder::new(name, original).ok_or("Could not create panel hide hook.")?;
            unsafe {
                builder.add_method(
                    sel!(orderOut:),
                    panel_order_out as unsafe extern "C-unwind" fn(_, _, _),
                );
            }
            builder.register()
        };
        unsafe {
            AnyObject::set_class(object, class);
        }
    }
    let target = window.clone();
    HIDE_CALLBACKS.with(|callbacks| {
        callbacks.borrow_mut().insert(
            object as *const AnyObject as usize,
            (
                window.label().into(),
                Rc::new(move || {
                    let webview: &tauri::Webview<R> = target.as_ref();
                    super::super::panel_full_size::will_hide(&webview.window());
                }),
            ),
        )
    });
    Ok(())
}

pub(super) fn resize_edge(x: f64, y: f64, width: f64, height: f64) -> bool {
    const EDGE: f64 = 5.0;
    x >= 0.0
        && y >= 0.0
        && x < width
        && y < height
        && (x < EDGE || y < EDGE || x >= width - EDGE || y >= height - EDGE)
}

unsafe extern "C-unwind" fn content_hit_test(
    view: &AnyObject,
    _: Sel,
    point: NSPoint,
) -> *mut NSView {
    let frame: NSRect = unsafe { msg_send![view, frame] };
    let panel: Option<Retained<NSWindow>> = unsafe { msg_send![view, window] };
    if panel.is_some_and(|panel| {
        let style = panel.styleMask();
        style.contains(NSWindowStyleMask::Resizable)
            && !style.contains(NSWindowStyleMask::FullScreen)
    }) && resize_edge(
        point.x - frame.origin.x,
        point.y - frame.origin.y,
        frame.size.width,
        frame.size.height,
    ) {
        return std::ptr::null_mut();
    }
    let superclass = AnyClass::get(c"ChemDraftResizablePanelContentView")
        .and_then(AnyClass::superclass)
        .expect("panel content superclass");
    unsafe { msg_send![super(view, superclass), hitTest: point] }
}

pub(super) fn install_resize_hit_test<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    objc2::MainThreadMarker::new().ok_or("Panel resize installation requires the main thread.")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let panel = unsafe { pointer.as_ref() }.ok_or("Could not access native panel window.")?;
    panel.setStyleMask(super::macos_style(panel.styleMask()));
    let content = panel
        .contentView()
        .ok_or("Could not access panel content view.")?;
    let object: &AnyObject = &content;
    let class_name = c"ChemDraftResizablePanelContentView";
    if object.class().name() == class_name {
        return Ok(());
    }
    let original = object.class();
    let class = if let Some(class) = AnyClass::get(class_name) {
        if class.superclass() != Some(original) {
            return Err("Panel content view class changed during resize installation.".into());
        }
        class
    } else {
        let mut builder = ClassBuilder::new(class_name, original)
            .ok_or("Could not create panel content hit test.")?;
        unsafe {
            builder.add_method(
                sel!(hitTest:),
                content_hit_test as unsafe extern "C-unwind" fn(_, _, _) -> _,
            );
        }
        builder.register()
    };
    // AppKit's NSThemeFrame tracks native edge/corner resizing when its content's hitTest:
    // returns nil. A full-window WKWebView otherwise claims those mouse-downs. Exclude only a
    // thin logical-point band at the content root, including its webview descendants; AppKit
    // keeps its native cursors, minimum-size constraint and non-activating resize loop.
    // Subclass only this content instance (no ivars added), preserving Tauri's view and handlers.
    unsafe {
        AnyObject::set_class(object, class);
    }
    Ok(())
}

pub(super) fn observe<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let panel = unsafe { pointer.as_ref() }.ok_or("Could not access native panel window.")?;
    install_hide_hook(window, panel)?;
    let center = NSNotificationCenter::defaultCenter();
    let mut tokens = Vec::new();
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
        // Immediate delivery on the posting (main) thread tags the lease at the native
        // transition, before a subsequent makeKeyWindow or IPC completion can run.
        tokens.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(panel),
                None,
                &callback,
            )
        });
    }
    OBSERVERS.with(|observers| {
        observers
            .borrow_mut()
            .insert(window.label().to_string(), tokens)
    });
    Ok(())
}

pub(super) fn forget(label: &str) {
    HIDE_CALLBACKS.with(|callbacks| {
        callbacks
            .borrow_mut()
            .retain(|_, (owner, _)| owner != label)
    });
    OBSERVERS.with(|observers| {
        if let Some(tokens) = observers.borrow_mut().remove(label) {
            let center = NSNotificationCenter::defaultCenter();
            for token in tokens {
                unsafe {
                    center.removeObserver((*token).as_ref());
                }
            }
        }
    });
}
