use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSWindow, NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
use std::{cell::RefCell, collections::HashMap, ptr::NonNull};

type Observers = Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>;
thread_local! {
    static OBSERVERS: RefCell<HashMap<String, Observers>> = RefCell::default();
}

pub(super) fn observe<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow;
    let panel = unsafe { pointer.as_ref() }.ok_or("Could not access native panel window.")?;
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
