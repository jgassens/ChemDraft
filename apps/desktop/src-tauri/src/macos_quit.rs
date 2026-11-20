//! AppKit's Dock/AppleScript quit reaches applicationShouldTerminate before Tao's Exit event.
//! Add only this missing optional delegate method; leave Tao's existing delegate intact.
use super::macos_single_instance::SecondaryLaunch;
use crate::shutdown::{self, QuitKind, QuitPlatform};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle,
    NSAlertThirdButtonReturn, NSApplicationTerminateReply, NSWindow,
};
use objc2_foundation::{
    NSDate, NSDefaultRunLoopMode, NSNotificationCenter, NSOperationQueue, NSRunLoop,
    NSRunLoopCommonModes, NSString, NSTimer,
};
use std::cell::RefCell;
use std::ffi::c_char;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, OnceLock,
};
use std::time::Duration;

static APP: OnceLock<(tauri::AppHandle, Option<Arc<SecondaryLaunch>>)> = OnceLock::new();

static POWER_OFF: AtomicBool = AtomicBool::new(false);
static SYSTEM_FLUSH_STARTED: AtomicBool = AtomicBool::new(false);
// AppKit dispatches Exit after the delegate returns TerminateNow. Keep the hard stop armed
// for the lifetime of the process once the OS has committed to termination.
static SYSTEM_WATCHDOG: OnceLock<mpsc::Sender<()>> = OnceLock::new();

thread_local! {
    static QUIT_SHEET: RefCell<Option<(u64, Retained<NSAlert>)>> = const { RefCell::new(None) };
}

pub fn power_off_in_progress() -> bool {
    POWER_OFF.load(Ordering::SeqCst)
}

fn workspace_will_power_off() {
    POWER_OFF.store(true, Ordering::SeqCst);
    let Some((app, secondary)) = APP.get() else {
        return;
    };
    if !super::QUIT.appkit_reply.lock().unwrap().awaiting_delivery() {
        return;
    }
    // A power-off can supersede an ordinary Dock Quit while AppKit is already waiting.
    finish_system_termination(app, secondary.clone());
    let main = MainThreadMarker::new().expect("workspace observer uses the main queue");
    objc2_app_kit::NSApplication::sharedApplication(main).replyToApplicationShouldTerminate(true);
}

fn finish_system_termination(app: &tauri::AppHandle, secondary: Option<Arc<SecondaryLaunch>>) {
    if SYSTEM_FLUSH_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // The committed system callback now owns any outstanding reply. A queued ordinary
    // reply could run in the nested WebKit pump below.
    *super::QUIT.appkit_reply.lock().unwrap() = super::AppkitReplyState::Delivered;
    let recorder = app.clone();
    let watchdog = super::flush_system_session(
        app,
        |remaining| {
            let slice = remaining.min(Duration::from_millis(5));
            let until = NSDate::dateWithTimeIntervalSinceNow(slice.as_secs_f64());
            // SAFETY: AppKit calls us on the main thread. This services WebKit IPC with
            // a short deadline, without accepting AppKit input events.
            unsafe { NSRunLoop::mainRunLoop().runMode_beforeDate(NSDefaultRunLoopMode, &until) };
            true
        },
        || {
            // SAFETY: The OS already committed to termination. Skip teardown if a nested
            // native callback stalls past the hard limit.
            unsafe { libc::_exit(0) }
        },
        move || match secondary.and_then(|launch| launch.record_interrupted_launch(&recorder, true))
        {
            Some(Err(error)) => eprintln!("Could not record document opens for relaunch: {error}"),
            Some(Ok(())) => {}
            None => {
                super::finish_exit_opens(&recorder, QuitKind::System, || {});
            }
        },
    );
    let _ = SYSTEM_WATCHDOG.set(watchdog);
}

/// Own the quit sheet so a Finder open can dismiss precisely this alert, even when another
/// sheet (such as Save As) is up later in the same quit.
pub async fn show_prompt(
    window: tauri::WebviewWindow,
    request_id: u64,
) -> Result<&'static str, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let mtm = MainThreadMarker::new().ok_or("Quit sheet needs the main thread")?;
                let raw = parent
                    .ns_window()
                    .map_err(|_| "Quit sheet has no document window")?;
                // SAFETY: Tauri returns this live webview window's NSWindow on the main thread.
                let parent = unsafe { &*raw.cast::<NSWindow>() };
                let visible = parent.isVisible() && !parent.isMiniaturized();
                if !super::acknowledge_quit_prompt(&super::QUIT, request_id, visible)
                    || QUIT_SHEET.with_borrow(Option::is_some)
                {
                    return Ok(None);
                }
                let alert = NSAlert::new(mtm);
                alert.setAlertStyle(NSAlertStyle::Warning);
                alert.setMessageText(&NSString::from_str("Save changes before quitting?"));
                alert.setInformativeText(&NSString::from_str(
                    "Your documents have unsaved changes.",
                ));
                for title in ["Save", "Don't Save", "Cancel"] {
                    alert.addButtonWithTitle(&NSString::from_str(title));
                }
                Ok(Some((parent, alert)))
            })();
            match result {
                Ok(Some((parent, alert))) => {
                    QUIT_SHEET.set(Some((request_id, alert.clone())));
                    let send = RefCell::new(Some(send));
                    let completion = block2::RcBlock::new(move |response| {
                        QUIT_SHEET.set(None);
                        if let Some(send) = send.borrow_mut().take() {
                            let choice = if response == NSAlertFirstButtonReturn {
                                "save"
                            } else if response == NSAlertSecondButtonReturn {
                                "discard"
                            } else {
                                "cancel"
                            };
                            let _ = send.send(Ok(choice));
                        }
                    });
                    alert.beginSheetModalForWindow_completionHandler(parent, Some(&completion));
                }
                Ok(None) => {
                    let _ = send.send(Ok("cancel"));
                }
                Err(error) => {
                    let _ = send.send(Err(error));
                }
            }
        })
        .map_err(|error| error.to_string())?;
    receive
        .await
        .map_err(|error| error.to_string())?
        .map_err(str::to_owned)
}

pub fn dismiss_prompt(request_id: u64) {
    let alert = QUIT_SHEET.with_borrow(|sheet| {
        sheet
            .as_ref()
            .filter(|(id, _)| *id == request_id)
            .map(|(_, alert)| alert.clone())
    });
    if let Some(alert) = alert {
        let sheet = alert.window();
        if let Some(parent) = sheet.sheetParent() {
            parent.endSheet_returnCode(&sheet, NSAlertThirdButtonReturn);
        }
    }
}

pub fn after_quit_callback(task: impl FnOnce() + 'static) {
    assert!(MainThreadMarker::new().is_some());
    let task = RefCell::new(Some(task));
    let block = block2::RcBlock::new(move |_| {
        if let Some(task) = task.take() {
            task();
        }
    });
    // SAFETY: On AppKit's main thread. The run loop retains the one-shot timer.
    // Common modes let this run after the veto, including from a nested panel loop.
    unsafe {
        let timer = NSTimer::timerWithTimeInterval_repeats_block(0.0, false, &block);
        NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
    }
}

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
    // The workspace notification also covers a power-off request without a current Apple event.
    // SAFETY: NSWorkspace owns its notification center for the life of the process and the
    // notification center keeps the registered block alive.
    unsafe {
        let workspace: *const AnyObject =
            objc2::msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
        let center: &NSNotificationCenter = objc2::msg_send![workspace, notificationCenter];
        let callback = block2::RcBlock::new(|_| workspace_will_power_off());
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(
            Some(&NSString::from_str("NSWorkspaceWillPowerOffNotification")),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &callback,
        ));
    }
    Ok(())
}

pub fn reply_to_termination<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    flow: &'static super::QuitFlow,
) {
    if let Err(error) = super::dispatch_appkit_reply_with(
        flow,
        false,
        |reply| {
            if MainThreadMarker::new().is_some() {
                after_quit_callback(move || reply());
                Ok(())
            } else {
                app.run_on_main_thread(move || reply())
            }
        },
        |reply| {
            let block = block2::RcBlock::new(move || reply());
            // SAFETY: The block captures only a Send + Sync task. Foundation copies it
            // and executes it on the main queue, independently of Tauri's event proxy.
            unsafe {
                objc2_foundation::NSOperationQueue::mainQueue().addOperationWithBlock(&block);
            }
        },
        {
            let app = app.clone();
            move || {
                let mtm =
                    MainThreadMarker::new().expect("AppKit quit reply must run on the main thread");
                if *flow.appkit_reply.lock().unwrap() != super::AppkitReplyState::Claimed {
                    return;
                }
                let application = objc2_app_kit::NSApplication::sharedApplication(mtm);
                if super::finish_exit_opens(&app, super::shutdown_kind(false), || {
                    *flow.appkit_reply.lock().unwrap() = super::AppkitReplyState::Idle;
                    application.replyToApplicationShouldTerminate(false);
                }) {
                    *flow.appkit_reply.lock().unwrap() = super::AppkitReplyState::Delivered;
                    application.replyToApplicationShouldTerminate(true);
                }
            }
        },
    ) {
        eprintln!("Could not dispatch AppKit termination reply via Tauri; queued native fallback: {error}");
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
    // SAFETY: Called by AppKit on its main thread. Foundation owns the current Apple event and
    // descriptors for this call; nil is checked before sending descriptor messages.
    let reason = unsafe {
        let manager: *const AnyObject =
            objc2::msg_send![objc2::class!(NSAppleEventManager), sharedAppleEventManager];
        let event: *const AnyObject = objc2::msg_send![manager, currentAppleEvent];
        if event.is_null() {
            0
        } else {
            let keyword = u32::from_be_bytes(*b"why?");
            let mut descriptor: *const AnyObject =
                objc2::msg_send![event, paramDescriptorForKeyword: keyword];
            if descriptor.is_null() {
                descriptor = objc2::msg_send![event, attributeDescriptorForKeyword: keyword];
            }
            if descriptor.is_null() {
                0
            } else {
                objc2::msg_send![descriptor, enumCodeValue]
            }
        }
    };
    let kind = shutdown::quit_kind(QuitPlatform::Macos, reason, power_off_in_progress(), false);
    if kind == QuitKind::System {
        POWER_OFF.store(true, Ordering::SeqCst);
        finish_system_termination(app, secondary.clone());
        return NSApplicationTerminateReply::TerminateNow;
    }
    if super::open_notice_active() {
        return NSApplicationTerminateReply::TerminateCancel;
    }
    if let Some(result) = secondary
        .as_ref()
        .and_then(|launch| launch.record_interrupted_launch(app, kind != QuitKind::User))
    {
        let proceed = shutdown::finish_opens(
            kind,
            None,
            |_| result,
            || {},
            |message| {
                super::schedule_open_notice(app, message, true, None, || {});
            },
        );
        return if proceed {
            NSApplicationTerminateReply::TerminateNow
        } else {
            NSApplicationTerminateReply::TerminateCancel
        };
    }
    let reply_pending = super::QUIT.appkit_reply.lock().unwrap().awaiting_delivery();
    match super::appkit_quit_decision(
        true,
        super::ASK_TO_SAVE_ON_QUIT.load(Ordering::SeqCst),
        super::APP_QUITTING.load(Ordering::SeqCst),
        reply_pending,
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
            super::enforce_quit_deadline(&super::QUIT, app);
            return NSApplicationTerminateReply::TerminateLater;
        }
        super::AppkitQuitDecision::TerminateNow => {}
    }
    if super::finish_exit_opens(app, kind, || {}) {
        NSApplicationTerminateReply::TerminateNow
    } else {
        NSApplicationTerminateReply::TerminateCancel
    }
}
