//! AppKit's Dock/AppleScript quit reaches applicationShouldTerminate before Tao's Exit event.
//! Add only this missing optional delegate method; leave Tao's existing delegate intact.
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::MainThreadMarker;
use objc2_app_kit::NSApplicationTerminateReply;
use std::ffi::c_char;
use std::sync::OnceLock;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

#[link(name = "objc")]
unsafe extern "C" {
    fn object_getClass(object: *const AnyObject) -> *const AnyClass;
    fn class_addMethod(
        class: *const AnyClass,
        selector: Sel,
        implementation: unsafe extern "C" fn(),
        types: *const c_char,
    ) -> Bool;
}

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let mtm =
        MainThreadMarker::new().ok_or("Quit delegate must be installed on the main thread")?;
    let application = objc2_app_kit::NSApplication::sharedApplication(mtm);
    // SAFETY: AppKit owns the delegate for the event loop's lifetime. Installation runs once,
    // on the main thread, and adds a method with AppKit's NSUInteger/object ABI (64-bit macOS).
    unsafe {
        let delegate: *const AnyObject = objc2::msg_send![&application, delegate];
        if delegate.is_null() {
            return Err("AppKit has no application delegate".into());
        }
        APP.set(app.clone())
            .map_err(|_| "Quit delegate already installed")?;
        let implementation = std::mem::transmute::<
            unsafe extern "C" fn(&AnyObject, Sel, *const AnyObject) -> NSApplicationTerminateReply,
            unsafe extern "C" fn(),
        >(should_terminate);
        if !class_addMethod(
            object_getClass(delegate),
            objc2::sel!(applicationShouldTerminate:),
            implementation,
            c"Q@:@".as_ptr(),
        )
        .as_bool()
        {
            return Err("AppKit delegate already implements applicationShouldTerminate:".into());
        }
    }
    Ok(())
}

unsafe extern "C" fn should_terminate(
    _: &AnyObject,
    _: Sel,
    _: *const AnyObject,
) -> NSApplicationTerminateReply {
    // SAFETY: Called by AppKit on its main thread. Foundation owns the current Apple event and
    // descriptors for this call; nil is checked before sending descriptor messages.
    let reason = unsafe {
        let manager: *const AnyObject =
            objc2::msg_send![objc2::class!(NSAppleEventManager), sharedAppleEventManager];
        let event: *const AnyObject = objc2::msg_send![manager, currentAppleEvent];
        if event.is_null() {
            0
        } else {
            let descriptor: *const AnyObject = objc2::msg_send![event, attributeDescriptorForKeyword: u32::from_be_bytes(*b"why?")];
            if descriptor.is_null() {
                0
            } else {
                objc2::msg_send![descriptor, enumCodeValue]
            }
        }
    };
    if super::should_prompt_appkit_quit(
        true, // Every ordinary quit flushes all document windows, even with save prompts disabled.
        super::APP_QUITTING.load(std::sync::atomic::Ordering::SeqCst),
        reason,
    ) {
        if let Some(app) = APP.get() {
            super::request_quit(app);
            return NSApplicationTerminateReply::TerminateCancel; // Return to the event loop while the user chooses.
        }
    }
    NSApplicationTerminateReply::TerminateNow // Preference off, decided exit, or system termination.
}
