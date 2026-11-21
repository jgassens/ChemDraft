use tauri::{plugin, AppHandle, Manager, RunEvent, Runtime};
use zbus::{blocking::Connection, interface};

struct SingleInstance<R: Runtime>(AppHandle<R>);

struct Primary {
    connection: Connection,
    name: String,
}

#[interface(name = "org.SingleInstance.DBus")]
impl<R: Runtime> SingleInstance<R> {
    fn execute_callback(&mut self, argv: Vec<String>, cwd: String) {
        super::handle_second_launch(&self.0, argv, cwd);
    }
}

pub(super) fn init<R: Runtime>() -> plugin::TauriPlugin<R> {
    // Match Tauri's Linux service so an AppImage and a .deb can hand off to each other.
    plugin::Builder::new("single-instance")
        .setup(|app, _| {
            let name = format!("{}.SingleInstance", app.config().identifier);
            let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
            match zbus::blocking::connection::Builder::session()?
                .name(name.as_str())?
                .replace_existing_names(false)
                .allow_name_replacements(false)
                .serve_at(path.as_str(), SingleInstance(app.clone()))?
                .build()
            {
                Ok(connection) => {
                    app.manage(Primary { connection, name });
                }
                Err(zbus::Error::NameTaken) => {
                    // Forward the paths resolved against the caller's OWD at startup. Absolute
                    // paths work even when the running instance was started in another folder.
                    // The stock D-Bus protocol uses UTF-8 and expects argv[0] before the paths.
                    // A non-UTF-8 path cannot be saved back to in either instance, so it is
                    // refused here, by name and with a failing exit, never dropped silently.
                    let startup = app.state::<super::linux_startup::Startup>();
                    let (forwarded, refused) =
                        super::linux_startup::forwardable_documents(&startup.documents);
                    let argv: Vec<_> = std::iter::once("").chain(forwarded).collect();
                    Connection::session()?.call_method(
                        Some(name.as_str()),
                        path.as_str(),
                        Some("org.SingleInstance.DBus"),
                        "ExecuteCallback",
                        &(argv, ""),
                    )?;
                    let code = if refused.is_empty() {
                        0
                    } else {
                        let message = super::linux_startup::refused_documents_message(&refused);
                        eprintln!("ChemDraft: {message}");
                        show_refusal(&message);
                        1
                    };
                    app.cleanup_before_exit();
                    std::process::exit(code);
                }
                Err(error) => return Err(error.into()),
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(primary) = app.try_state::<Primary>() {
                    let _ = primary.connection.release_name(primary.name.as_str());
                }
            }
        })
        .build()
}

/// The secondary exits from plugin setup, before any ChemDraft window exists. A modal GTK dialog
/// runs its own loop on this (the main) thread, so the refusal is seen even from a file manager.
fn show_refusal(message: &str) {
    use gtk::prelude::{DialogExt, GtkWindowExt, WidgetExt};
    if !gtk::is_initialized_main_thread() {
        return;
    }
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Error,
        gtk::ButtonsType::Ok,
        message,
    );
    dialog.set_title("ChemDraft Could Not Open a Document");
    dialog.run();
    dialog.hide();
}
