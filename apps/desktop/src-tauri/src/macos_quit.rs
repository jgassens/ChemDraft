//! AppKit's Dock/AppleScript quit reaches applicationShouldTerminate before Tao's Exit event.
//! Add only this missing optional delegate method; leave Tao's existing delegate intact.
use super::macos_single_instance::SecondaryLaunch;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle,
    NSAlertThirdButtonReturn, NSApplicationTerminateReply, NSWindow,
};
use objc2_foundation::NSString;
use std::cell::RefCell;
use std::ffi::c_char;
use std::sync::{Arc, OnceLock};

static APP: OnceLock<(tauri::AppHandle, Option<Arc<SecondaryLaunch>>)> = OnceLock::new();

thread_local! {
    static QUIT_SHEET: RefCell<Option<(u64, Retained<NSAlert>)>> = const { RefCell::new(None) };
    static RECORD_ERROR_ALERTS: RefCell<RecordErrorAlerts> = RefCell::default();
}

#[derive(Default)]
struct RecordErrorAlerts {
    pending: usize,
    exits: Vec<Box<dyn FnOnce()>>,
}

impl RecordErrorAlerts {
    fn defer_exit(&mut self, exit: impl FnOnce() + 'static) -> bool {
        if self.pending == 0 {
            return false;
        }
        self.exits.push(Box::new(exit));
        true
    }

    fn finish_alert(&mut self) -> Vec<Box<dyn FnOnce()>> {
        self.pending -= 1;
        if self.pending == 0 {
            std::mem::take(&mut self.exits)
        } else {
            Vec::new()
        }
    }
}

pub fn defer_exit_for_record_alert(exit: impl FnOnce() + 'static) -> bool {
    RECORD_ERROR_ALERTS.with_borrow_mut(|alerts| alerts.defer_exit(exit))
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

pub fn report_record_error(error: &str) {
    let message = format!("Could not record document opens for relaunch: {error}");
    eprintln!("{message}");
    RECORD_ERROR_ALERTS.with_borrow_mut(|alerts| alerts.pending += 1);
    let alert = block2::RcBlock::new(move |_| {
        super::macos_single_instance::show_launch_error(&Default::default(), &message);
        for exit in RECORD_ERROR_ALERTS.with_borrow_mut(RecordErrorAlerts::finish_alert) {
            exit();
        }
    });
    // A timer runs outside Tao's event callback, where a modal alert could deadlock.
    unsafe {
        objc2_foundation::NSTimer::scheduledTimerWithTimeInterval_repeats_block(0.0, false, &alert)
    };
}

fn deliver_after_record_alerts(reply: super::AppkitReplyTask) {
    let deferred = reply.clone();
    if !defer_exit_for_record_alert(move || deferred()) {
        reply();
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
                deliver_after_record_alerts(reply);
                Ok(())
            } else {
                app.run_on_main_thread(move || deliver_after_record_alerts(reply))
            }
        },
        |reply| {
            let block = block2::RcBlock::new(move || deliver_after_record_alerts(reply.clone()));
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
                super::persist_macos_opens_before_exit(&app);
                objc2_app_kit::NSApplication::sharedApplication(mtm)
                    .replyToApplicationShouldTerminate(true);
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
    if let Some(result) = secondary
        .as_ref()
        .and_then(|launch| launch.record_interrupted_launch(app))
    {
        if let Err(error) = result {
            super::macos_single_instance::show_launch_error(
                &Default::default(),
                &format!("Could not record document opens for relaunch: {error}"),
            );
        }
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
    if RECORD_ERROR_ALERTS.with_borrow(|alerts| alerts.pending != 0) {
        *super::QUIT.appkit_reply.lock().unwrap() = super::AppkitReplyState::Claimed;
        reply_to_termination(app, &super::QUIT);
        return NSApplicationTerminateReply::TerminateLater;
    }
    super::persist_macos_opens_before_exit(app);
    NSApplicationTerminateReply::TerminateNow
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[test]
    fn macos_open_quit_defers_exit_until_the_record_error_alert_finishes() {
        let mut alerts = RecordErrorAlerts {
            pending: 2,
            ..Default::default()
        };
        let exited = Rc::new(Cell::new(false));
        assert!(alerts.defer_exit({
            let exited = exited.clone();
            move || exited.set(true)
        }));
        assert!(alerts.finish_alert().is_empty());
        assert!(!exited.get());
        for exit in alerts.finish_alert() {
            exit();
        }
        assert!(exited.get());
        assert!(!alerts.defer_exit(|| panic!("exit no longer needs deferral")));
    }
}
