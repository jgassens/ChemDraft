//! AppKit's Dock/AppleScript quit reaches applicationShouldTerminate before Tao's Exit event.
//! Add only this missing optional delegate method; leave Tao's existing delegate intact.
use super::macos_single_instance::{renderer_exiting, SecondaryLaunch};
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::MainThreadMarker;
use objc2_app_kit::NSApplicationTerminateReply;
use std::ffi::c_char;
use std::sync::{Arc, OnceLock};

static APP: OnceLock<(tauri::AppHandle, Option<Arc<SecondaryLaunch>>)> = OnceLock::new();

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

pub fn install(
    app: &tauri::AppHandle,
    secondary: Option<Arc<SecondaryLaunch>>,
) -> Result<(), String> {
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
        APP.set((app.clone(), secondary))
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

pub fn reply_to_termination<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    flow: &'static super::QuitFlow,
) {
    let report_app = app.clone();
    let queue_native_reply = |reply: super::AppkitReplyTask| {
        let block = block2::RcBlock::new(move || reply());
        // SAFETY: Foundation copies the sendable block and runs it on the main queue.
        unsafe {
            objc2_foundation::NSOperationQueue::mainQueue().addOperationWithBlock(&block);
        }
    };
    if let Err(error) = super::dispatch_appkit_reply_with(
        flow,
        false,
        // The quit reply can show an open alert. Run it outside Tao's callback.
        |reply| app.run_on_main_thread(move || queue_native_reply(reply)),
        queue_native_reply,
        move || {
            let mtm =
                MainThreadMarker::new().expect("AppKit quit reply must run on the main thread");
            renderer_exiting(&report_app);
            objc2_app_kit::NSApplication::sharedApplication(mtm)
                .replyToApplicationShouldTerminate(true);
        },
    ) {
        eprintln!("Could not dispatch AppKit termination reply via Tauri; queued native fallback: {error}");
    }
}

pub fn report_interrupted_opens(app: &tauri::AppHandle) {
    if !APP
        .get()
        .and_then(|(_, secondary)| secondary.as_deref())
        .is_some_and(SecondaryLaunch::interrupt_for_exit)
    {
        renderer_exiting(app);
    }
}

unsafe extern "C" fn should_terminate(
    _: &AnyObject,
    _: Sel,
    _: *const AnyObject,
) -> NSApplicationTerminateReply {
    let Some((app, secondary)) = APP.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    if secondary
        .as_ref()
        .is_some_and(|launch| launch.interrupt_for_exit())
    {
        return NSApplicationTerminateReply::TerminateNow;
    }
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
    let reply_pending = super::QUIT.appkit_reply.lock().unwrap().awaiting_delivery();
    match super::appkit_quit_decision(
        cfg!(target_os = "macos"),
        super::ASK_TO_SAVE_ON_QUIT.load(std::sync::atomic::Ordering::SeqCst),
        super::APP_QUITTING.load(std::sync::atomic::Ordering::SeqCst),
        reply_pending,
        reason,
    ) {
        super::AppkitQuitDecision::Prompt => {
            super::request_quit(app);
            return NSApplicationTerminateReply::TerminateCancel;
        }
        super::AppkitQuitDecision::DeferReply => {
            if super::request_appkit_quit_with(&super::QUIT, app) {
                return NSApplicationTerminateReply::TerminateLater;
            }
        }
        super::AppkitQuitDecision::WaitForReply => {
            return NSApplicationTerminateReply::TerminateLater;
        }
        super::AppkitQuitDecision::TerminateNow => {}
    }
    renderer_exiting(app);
    NSApplicationTerminateReply::TerminateNow
}
