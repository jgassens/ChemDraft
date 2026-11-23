//! AppKit gets the first chance at key equivalents, before the Preferences webview.
#[cfg(target_os = "macos")]
mod macos {
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu, NSMenuItem};
    use objc2_foundation::NSString;
    use std::cell::{Cell, RefCell};

    type SavedKey = (
        Retained<NSMenuItem>,
        Retained<NSString>,
        NSEventModifierFlags,
    );

    thread_local! {
        static RECORDING: Cell<bool> = const { Cell::new(false) };
        static SAVED: RefCell<Vec<SavedKey>> = const { RefCell::new(Vec::new()) };
    }

    fn suppress(menu: &NSMenu, saved: &mut Vec<SavedKey>, empty: &NSString) {
        for item in menu.itemArray().to_vec() {
            if let Some(submenu) = item.submenu() {
                suppress(&submenu, saved, empty);
            }
            let key = item.keyEquivalent();
            if !key.is_empty() {
                let modifiers = item.keyEquivalentModifierMask();
                item.setKeyEquivalent(empty);
                saved.push((item, key, modifiers));
            }
        }
    }

    pub(super) fn set_recording(recording: bool) {
        RECORDING.set(recording);
        refresh();
    }

    pub(super) fn refresh() {
        let Some(main) = MainThreadMarker::new() else {
            return;
        };
        SAVED.with_borrow_mut(|saved| {
            for (item, key, modifiers) in saved.drain(..) {
                item.setKeyEquivalent(&key);
                item.setKeyEquivalentModifierMask(modifiers);
            }
            if RECORDING.get() {
                if let Some(menu) = NSApplication::sharedApplication(main).mainMenu() {
                    suppress(&menu, saved, &NSString::from_str(""));
                }
            }
        });
    }
}

pub(crate) fn set_recording(recording: bool) {
    #[cfg(target_os = "macos")]
    macos::set_recording(recording);
    #[cfg(not(target_os = "macos"))]
    let _ = recording; // Only the document window has a native menu off macOS.
}

#[cfg(target_os = "macos")]
pub(crate) fn refresh() {
    macos::refresh();
}
