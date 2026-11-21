//! Out-of-process, open-editing OLE server. The only cross-thread values are messages, application
//! handles and owned selection/preview bytes. All interface pointers, including the editor's strong
//! reference to its object, live and die on the message-pumping STA.

mod data;
mod persist;

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    ffi::c_void,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager};
use tokio::sync::mpsc as work_queue;
use windows::{
    core::{
        implement, w, ComObject, Error, IUnknown, IUnknownImpl, Interface, Ref, Result, BOOL, GUID,
        HRESULT, HSTRING, PCWSTR, PWSTR,
    },
    Win32::{
        Foundation::*,
        Graphics::Gdi::LOGPALETTE,
        System::{
            Com::{StructuredStorage::*, *},
            DataExchange::RegisterClipboardFormatW,
            Ole::*,
            Threading::{CreateEventW, SetEvent, INFINITE},
        },
        UI::{Shell::SHStrDupW, WindowsAndMessaging::*},
    },
};

use super::{
    bridge,
    contracts::{editor_verb, CloseDecision, CloseOption, EditorVerb, PersistState},
    presentation::Content,
    OleClass,
};

const MAX_PENDING_WORK: usize = 16;
const MAX_PENDING_UPDATES: usize = 4;

pub(super) enum Action {
    Connect(Channel<bridge::CloseRequest>),
    Update {
        content: Content,
        _permit: UpdatePermit,
    },
    Close {
        save_changes: Option<bool>,
        request_id: Option<u32>,
    },
    PrepareQuit,
}

type WorkResult = std::result::Result<Option<bridge::Open>, String>;

struct Work {
    id: String,
    action: Action,
    reply: tokio::sync::oneshot::Sender<WorkResult>,
}

#[derive(Default)]
pub(super) struct WindowSignals {
    close: AtomicBool,
    destroyed: AtomicBool,
}

impl WindowSignals {
    pub(super) fn request_close(&self) {
        self.close.store(true, Ordering::Release);
    }

    pub(super) fn destroyed(&self) {
        self.destroyed.store(true, Ordering::Release);
    }
}

struct Control {
    wake: OwnedHandle,
    stop: AtomicBool,
    resume: AtomicBool,
    quitting: AtomicBool,
}

impl Control {
    fn signal(&self) {
        if let Err(error) = unsafe { SetEvent(HANDLE(self.wake.as_raw_handle())) } {
            eprintln!("Could not wake Office STA: {error}");
        }
    }
}

pub(crate) struct Server {
    queue: work_queue::Sender<Work>,
    control: Arc<Control>,
    updates: Arc<Mutex<HashSet<String>>>,
    stopped: Mutex<mpsc::Receiver<()>>,
}

pub(super) struct UpdatePermit {
    updates: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for UpdatePermit {
    fn drop(&mut self) {
        self.updates.lock().unwrap().remove(&self.id);
    }
}

impl Server {
    pub(super) fn begin_update(&self, id: &str) -> std::result::Result<UpdatePermit, String> {
        let mut updates = self.updates.lock().unwrap();
        if updates.contains(id) {
            return Err("This Office editor already has an update in progress".into());
        }
        if updates.len() >= MAX_PENDING_UPDATES {
            return Err("Office editors are busy. Try updating again.".into());
        }
        updates.insert(id.to_owned());
        Ok(UpdatePermit {
            updates: self.updates.clone(),
            id: id.to_owned(),
        })
    }

    pub(super) async fn request(&self, id: String, action: Action) -> WorkResult {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.queue
            .send(Work { id, action, reply })
            .await
            .map_err(|_| "Office object STA has exited".to_owned())?;
        self.wake();
        result
            .await
            .map_err(|_| "Office object STA exited before replying".to_owned())?
    }

    pub(super) fn wake(&self) {
        self.control.signal();
    }

    pub(super) fn resume(&self) {
        self.control.resume.store(true, Ordering::Release);
        self.wake();
    }

    pub(crate) fn begin_quit(&self) -> bool {
        !self.control.quitting.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn cancel_quit(&self) {
        self.control.quitting.store(false, Ordering::Release);
    }

    pub(crate) async fn prepare_quit(&self) -> std::result::Result<(), String> {
        self.request(String::new(), Action::PrepareQuit)
            .await
            .map(drop)
    }

    pub(crate) fn shutdown(&self) {
        self.control.stop.store(true, Ordering::Release);
        self.wake();
        if let Ok(stopped) = self.stopped.lock() {
            if stopped.recv_timeout(Duration::from_secs(2)).is_err() {
                eprintln!("Office STA did not acknowledge shutdown within two seconds");
            }
        }
    }
}

pub(crate) fn embedding_arg(arg: &str) -> bool {
    arg.eq_ignore_ascii_case("-Embedding") || arg.eq_ignore_ascii_case("-Automation")
}

pub(crate) fn start(
    app: &tauri::AppHandle,
    automation: Arc<AtomicBool>,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let class = OleClass::for_identifier(&app.config().identifier)?;
    let (queue, messages) = work_queue::channel(MAX_PENDING_WORK);
    let (ready, started) = mpsc::sync_channel(1);
    let (done, stopped) = mpsc::channel();
    // A signaled kernel event survives nested COM message pumps, which may consume thread messages.
    let control = Arc::new(Control {
        wake: unsafe { OwnedHandle::from_raw_handle(CreateEventW(None, false, false, None)?.0) },
        stop: AtomicBool::new(false),
        resume: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
    });
    let sta_control = control.clone();
    let flag = automation;
    let handle = app.clone();
    std::thread::Builder::new()
        .name("ChemDraft Office STA".into())
        .spawn(move || {
            let result = unsafe { OleInitialize(None) };
            if let Err(error) = result {
                let _ = ready.send(Err(error));
                return;
            }
            let result = serve(handle, flag, class, messages, sta_control, &ready);
            if let Err(error) = result {
                eprintln!("ChemDraft Office STA: {error}");
                let _ = ready.try_send(Err(error));
            }
            unsafe { OleUninitialize() };
            let _ = done.send(());
        })?;
    started.recv_timeout(Duration::from_secs(10))??;
    app.manage(Server {
        queue,
        control,
        updates: Default::default(),
        stopped: Mutex::new(stopped),
    });
    Ok(())
}

struct Apartment {
    app: tauri::AppHandle,
    automation: Arc<AtomicBool>,
    class: OleClass,
    guid: GUID,
    png_format: u16,
    document_lock: Cell<bool>,
    activation: Arc<AtomicU64>,
    editors: RefCell<HashMap<String, ComObject<Embedded>>>,
    queue: RefCell<work_queue::Receiver<Work>>,
    control: Arc<Control>,
    waiting_for_editor: Cell<bool>,
}

impl Apartment {
    fn add_process_ref(&self) {
        self.activation.fetch_add(1, Ordering::AcqRel);
        unsafe { CoAddRefServerProcess() };
    }

    fn hold_document_lock(&self) {
        if !self.document_lock.replace(true) {
            self.add_process_ref();
        }
    }

    fn release_process(&self) {
        if unsafe { CoReleaseServerProcess() } != 0 {
            return;
        }
        // The zero transition suspends all factories. Ordinary ChemDraft must continue
        // accepting activations, even after the last container releases its object.
        if self.automation.load(Ordering::Acquire) {
            let app = self.app.clone();
            let flag = self.automation.clone();
            let activation = self.activation.clone();
            let released = activation.load(Ordering::Acquire);
            let _ = self.app.run_on_main_thread(move || {
                if flag.load(Ordering::Acquire) && released == activation.load(Ordering::Acquire) {
                    app.exit(0);
                }
            });
        } else if let Err(error) = unsafe { CoResumeClassObjects() } {
            eprintln!("Could not resume Office class factory: {error}");
        }
    }

    fn editors(&self) -> Vec<ComObject<Embedded>> {
        let editors = self.editors.borrow();
        let mut ids = editors.keys().collect::<Vec<_>>();
        ids.sort_unstable();
        ids.into_iter().map(|id| editors[id].clone()).collect()
    }

    fn dispatch(&self, id: &str, action: Action) -> Result<Option<bridge::Open>> {
        if matches!(action, Action::PrepareQuit) {
            if self.waiting_for_editor.get() {
                return Err(OLE_E_PROMPTSAVECANCELLED.into());
            }
            for object in self.editors() {
                object.close_with_option(CloseOption::PromptSave)?;
            }
            return Ok(None);
        }
        // A nested callback can remove the edit session while SaveObject or an advise sink runs.
        let object = self
            .editors
            .borrow()
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new(OLE_E_NOCONNECTION, "Office editor has closed"))?;
        match action {
            Action::Connect(channel) => {
                let (container_app, container_document) = object.host.borrow().clone();
                if object.channel.replace(Some(channel)).is_some() {
                    // A reload supersedes the close response from the previous renderer.
                    object.close_request.set(None);
                }
                Ok(Some(bridge::Open {
                    object_id: id.to_owned(),
                    json: object.content.borrow().json.clone(),
                    container_app,
                    container_document,
                }))
            }
            Action::Update { content, _permit } => {
                object.content.replace(Rc::new(content));
                object.published.set(true);
                object.changed();
                unsafe {
                    object.data_advise.SendOnDataChange(
                        &object.to_interface::<IDataObject>(),
                        None,
                        0,
                    )?;
                }
                object.save_to_client()?;
                Ok(None)
            }
            Action::Close {
                save_changes,
                request_id,
            } => {
                if request_id.is_some() && object.close_request.get() != request_id {
                    return Err(Error::new(
                        E_UNEXPECTED,
                        "The Office close request has expired",
                    ));
                }
                let result = if let Some(save) = save_changes {
                    object.finish(save, true)
                } else {
                    Ok(())
                };
                if request_id.is_some() || save_changes.is_some() {
                    object.close_request.set(None);
                }
                result.map(|()| None)
            }
            Action::PrepareQuit => unreachable!(),
        }
    }

    fn drain(&self) {
        if self.control.resume.swap(false, Ordering::AcqRel) {
            self.hold_document_lock();
            if let Err(error) = unsafe { CoResumeClassObjects() } {
                eprintln!("Could not resume Office class factory: {error}");
            }
        }
        // Let COM traffic and window destruction run even when an editor floods IPC.
        for _ in 0..MAX_PENDING_WORK {
            let work = self.queue.borrow_mut().try_recv();
            let Ok(work) = work else {
                break;
            };
            let result = self.dispatch(&work.id, work.action);
            let _ = work.reply.send(result.map_err(|e| e.to_string()));
        }
        for object in self.editors() {
            object.handle_window_signals();
        }
    }

    /// Also used inside IOleObject::Close. COM remains on this STA, including Update and
    /// the container's reentrant Save/SaveCompleted calls while waiting for the renderer.
    fn pump(&self, timeout: u32) -> bool {
        let mut msg = MSG::default();
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    self.control.stop.store(true, Ordering::Release);
                    return false;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if MsgWaitForMultipleObjectsEx(
                Some(&[HANDLE(self.control.wake.as_raw_handle())]),
                timeout,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            ) == WAIT_FAILED
            {
                eprintln!("Office STA message wait failed: {}", Error::from_win32());
                return false;
            }
        }
        !self.control.stop.load(Ordering::Acquire)
    }
}

fn serve(
    app: tauri::AppHandle,
    automation: Arc<AtomicBool>,
    class: OleClass,
    queue: work_queue::Receiver<Work>,
    control: Arc<Control>,
    ready: &mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    let guid = GUID::try_from(class.clsid.trim_matches(['{', '}']))?;
    let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) } as u16;
    if png_format == 0 {
        return Err(Error::from_win32());
    }
    let sta = Rc::new(Apartment {
        app,
        automation,
        class,
        guid,
        png_format,
        document_lock: Cell::new(false),
        activation: Default::default(),
        editors: RefCell::new(HashMap::new()),
        queue: RefCell::new(queue),
        control,
        waiting_for_editor: Cell::new(false),
    });
    if !sta.automation.load(Ordering::Acquire) {
        // A normal document window keeps the factory continuously registered after the last object.
        sta.hold_document_lock();
    }
    let factory: IClassFactory = Factory {
        sta: sta.clone(),
        locks: Cell::new(0),
    }
    .into();
    let mut msg = MSG::default();
    unsafe {
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let cookie =
            CoRegisterClassObject(&guid, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE)?;
        if ready.send(Ok(())).is_ok() {
            while !sta.control.stop.load(Ordering::Acquire) {
                sta.drain();
                if sta.control.stop.load(Ordering::Acquire) || !sta.pump(INFINITE) {
                    break;
                }
            }
        }
        let revoked = CoRevokeClassObject(cookie);
        // Normal app quit has already completed each editor's close. On a forced teardown,
        // retry accepted renderer content before releasing the last STA references.
        for object in sta.editors() {
            if let Err(error) = object.finish(object.published.get(), false) {
                eprintln!("Could not save Office editor during shutdown: {error}");
            }
        }
        sta.editors.borrow_mut().clear();
        revoked?;
    }
    Ok(())
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.document_lock.get() {
            unsafe { CoReleaseServerProcess() };
        }
    }
}

// The macro defaults to agile marshaling. Both factory and object are STA-affine.
#[implement(IClassFactory, Agile = false)]
struct Factory {
    sta: Rc<Apartment>,
    locks: Cell<u32>,
}

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        out: *mut *mut c_void,
    ) -> Result<()> {
        if out.is_null() || iid.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *out = std::ptr::null_mut() };
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let object: IOleObject = Embedded::new(self.sta.clone())?.into();
        unsafe { object.query(iid, out).ok() }
    }
    fn LockServer(&self, lock: BOOL) -> Result<()> {
        if lock.as_bool() {
            self.locks
                .set(self.locks.get().checked_add(1).ok_or(E_UNEXPECTED)?);
            self.sta.add_process_ref();
        } else {
            self.locks
                .set(self.locks.get().checked_sub(1).ok_or(E_UNEXPECTED)?);
            self.sta.release_process();
        }
        Ok(())
    }
}

#[implement(IOleObject, IDataObject, IPersistStorage, Agile = false)]
struct Embedded {
    sta: Rc<Apartment>,
    host: RefCell<(String, String)>,
    site: RefCell<Option<IOleClientSite>>,
    storage: RefCell<Option<IStorage>>,
    content: RefCell<Rc<Content>>,
    extent: Cell<Option<[i32; 2]>>,
    generation: Cell<u64>,
    clean: Cell<u64>,
    persistence: Cell<PersistState>,
    session: RefCell<Option<String>>,
    signals: RefCell<Option<Arc<WindowSignals>>>,
    channel: RefCell<Option<Channel<bridge::CloseRequest>>>,
    close_request: Cell<Option<u32>>,
    native_close: Cell<bool>,
    published: Cell<bool>,
    saving_to_client: Cell<bool>,
    closing: Cell<bool>,
    closed: Cell<bool>,
    ole_advise: IOleAdviseHolder,
    data_advise: IDataAdviseHolder,
}

impl Embedded {
    fn new(sta: Rc<Apartment>) -> Result<Self> {
        let content = Content::blank().map_err(|error| Error::new(E_FAIL, error.to_string()))?;
        let ole_advise = unsafe { CreateOleAdviseHolder()? };
        let data_advise = unsafe { CreateDataAdviseHolder()? };
        sta.add_process_ref();
        Ok(Self {
            sta,
            host: Default::default(),
            site: Default::default(),
            storage: Default::default(),
            content: RefCell::new(Rc::new(content)),
            extent: Cell::new(None),
            generation: Cell::new(0),
            clean: Cell::new(0),
            persistence: Cell::new(PersistState::Uninitialized),
            session: Default::default(),
            signals: Default::default(),
            channel: Default::default(),
            close_request: Cell::new(None),
            native_close: Cell::new(false),
            published: Cell::new(false),
            saving_to_client: Cell::new(false),
            closing: Cell::new(false),
            closed: Cell::new(false),
            ole_advise,
            data_advise,
        })
    }
    fn changed(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
    }
    fn dirty(&self) -> bool {
        self.generation.get() != self.clean.get()
    }

    fn save_to_client(&self) -> Result<()> {
        // A container may call back into Save/SaveCompleted/Close during SaveObject.
        let site = self.site.borrow().clone().ok_or_else(|| {
            Error::new(
                OLE_E_NOCONNECTION,
                "Office object has no client site for SaveObject",
            )
        })?;
        if self.saving_to_client.replace(true) {
            return Err(Error::new(
                STG_E_CANTSAVE,
                "Office is already saving the structure",
            ));
        }
        let result = unsafe {
            site.SaveObject()
                .and_then(|()| self.ole_advise.SendOnSave())
        };
        self.saving_to_client.set(false);
        result?;
        if self.dirty() {
            return Err(Error::new(
                STG_E_CANTSAVE,
                "Office did not confirm saving the structure",
            ));
        }
        Ok(())
    }
}

impl Embedded_Impl {
    fn handle_window_signals(&self) {
        let signals = self.signals.borrow().clone();
        let Some(signals) = signals else { return };
        if signals.destroyed.load(Ordering::Acquire) {
            self.signals.take();
            self.channel.take();
            self.close_request.set(None);
            self.native_close.set(false);
            if let Err(error) = self.finish(self.published.get(), false) {
                // Keep the object and its latest published content available for retry.
                eprintln!("Could not save the destroyed Office editor: {error}");
            }
        } else {
            if signals.close.swap(false, Ordering::AcqRel) && self.close_request.get().is_none() {
                self.native_close.set(true);
            }
            if self.native_close.get() && self.close_request.get().is_none() {
                if let Some(channel) = self.channel.borrow().as_ref() {
                    self.native_close.set(false);
                    if let Err(error) = channel.send(bridge::CloseRequest {
                        request_id: None,
                        prompt: true,
                        unsaved: self.published.get() && self.dirty(),
                    }) {
                        eprintln!("Could not ask the Office editor to close: {error}");
                    }
                }
            }
        }
    }

    fn close_with_option(&self, option: CloseOption) -> Result<()> {
        if self.closed.get() || self.closing.get() || self.saving_to_client.get() {
            return Ok(());
        }
        let visible = self.signals.borrow().is_some();
        match option.decision(visible, self.dirty()) {
            CloseDecision::Finish { save } => self.finish(save, true),
            CloseDecision::AskEditor { prompt } => self.wait_for_editor_close(prompt),
        }
    }

    fn wait_for_editor_close(&self, prompt: bool) -> Result<()> {
        if self.sta.waiting_for_editor.replace(true) {
            return Err(OLE_E_PROMPTSAVECANCELLED.into());
        }
        static NEXT_CLOSE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let request_id = NEXT_CLOSE.fetch_add(1, Ordering::Relaxed);
        self.close_request.set(Some(request_id));
        if prompt {
            if let Some(id) = self.session.borrow().clone() {
                let app = self.sta.app.clone();
                let _ = self.sta.app.run_on_main_thread(move || {
                    if let Some(window) = app.get_webview_window(&format!("office-object-{id}")) {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }
        }
        let result = (|| {
            let connect_deadline = Instant::now() + Duration::from_secs(10);
            let mut sent = false;
            while !self.closed.get() && self.close_request.get() == Some(request_id) {
                self.sta.drain();
                if self.closed.get() || self.close_request.get().is_none() {
                    break;
                }
                if !sent {
                    if let Some(channel) = self.channel.borrow().as_ref() {
                        channel
                            .send(bridge::CloseRequest {
                                request_id: Some(request_id),
                                prompt,
                                unsaved: self.published.get() && self.dirty(),
                            })
                            .map_err(|e| Error::new(E_FAIL, e.to_string()))?;
                        sent = true;
                    } else if Instant::now() >= connect_deadline {
                        return Err(Error::new(
                            OLE_E_PROMPTSAVECANCELLED,
                            "Office editor is still opening",
                        ));
                    }
                }
                if self.sta.control.stop.load(Ordering::Acquire)
                    || !self.sta.pump(if sent { INFINITE } else { 100 })
                {
                    break;
                }
            }
            if self.closed.get() {
                Ok(())
            } else {
                Err(OLE_E_PROMPTSAVECANCELLED.into())
            }
        })();
        self.close_request.set(None);
        self.sta.waiting_for_editor.set(false);
        result
    }

    fn finish(&self, save: bool, destroy: bool) -> Result<()> {
        if self.closed.get() || self.closing.replace(true) {
            return Ok(());
        }
        let result = (|| {
            if save && self.dirty() {
                self.save_to_client()?;
            }
            self.closed.set(true);
            if let Some(id) = self.session.take() {
                self.sta.editors.borrow_mut().remove(&id);
                if destroy {
                    let app = self.sta.app.clone();
                    if let Err(error) = self.sta.app.run_on_main_thread(move || {
                        if let Some(window) = app.get_webview_window(&format!("office-object-{id}"))
                        {
                            if let Err(error) = window.destroy() {
                                eprintln!("Could not close Office editor: {error}");
                            }
                        }
                    }) {
                        eprintln!("Could not schedule Office editor destruction: {error}");
                    }
                }
            }
            self.signals.take();
            self.channel.take();
            let site = self.site.take();
            if let Some(site) = site {
                unsafe {
                    let _ = site.OnShowWindow(false);
                }
            }
            let data = self.to_interface::<IDataObject>();
            let object = self.to_interface::<IOleObject>();
            // Advise callbacks can release Office's last reference or call Close again.
            unsafe {
                let data_changed =
                    self.data_advise
                        .SendOnDataChange(&data, None, ADVF_DATAONSTOP.0 as u32);
                let closed = self.ole_advise.SendOnClose();
                let disconnected = CoDisconnectObject(&object, None);
                for error in [data_changed, closed, disconnected]
                    .into_iter()
                    .filter_map(Result::err)
                {
                    eprintln!("Could not notify an Office connection of closure: {error}");
                }
            }
            Ok(())
        })();
        self.closing.set(false);
        result
    }
}

impl Drop for Embedded {
    fn drop(&mut self) {
        self.sta.release_process();
    }
}

impl IOleObject_Impl for Embedded_Impl {
    fn SetClientSite(&self, site: Ref<IOleClientSite>) -> Result<()> {
        self.site.replace(site.cloned());
        Ok(())
    }
    fn GetClientSite(&self) -> Result<IOleClientSite> {
        self.site.borrow().clone().ok_or_else(|| E_FAIL.into())
    }
    fn SetHostNames(&self, app: &PCWSTR, doc: &PCWSTR) -> Result<()> {
        let name = |s: &PCWSTR| {
            if s.is_null() {
                Ok(String::new())
            } else {
                unsafe { s.to_string() }
                    .map_err(|_| Error::new(E_INVALIDARG, "Invalid UTF-16 Office host name"))
            }
        };
        self.host.replace((name(app)?, name(doc)?));
        Ok(())
    }
    fn Close(&self, option: &OLECLOSE) -> Result<()> {
        // A sink may release the container's last reference during OnClose.
        let _keep_alive = self.to_object();
        let option = match *option {
            OLECLOSE_SAVEIFDIRTY => CloseOption::SaveIfDirty,
            OLECLOSE_NOSAVE => CloseOption::NoSave,
            OLECLOSE_PROMPTSAVE => CloseOption::PromptSave,
            _ => return Err(E_INVALIDARG.into()),
        };
        self.close_with_option(option)
    }
    fn DoVerb(
        &self,
        verb: i32,
        _: *const MSG,
        site: Ref<IOleClientSite>,
        _: i32,
        _: HWND,
        _: *const RECT,
    ) -> Result<()> {
        let verb = editor_verb(verb);
        if verb == EditorVerb::Unsupported {
            return Err(E_NOTIMPL.into());
        }
        if self.closed.get()
            || self.closing.get()
            || self.close_request.get().is_some()
            || self.sta.control.quitting.load(Ordering::Acquire)
        {
            return Err(OLE_E_NOTRUNNING.into());
        }
        if let Some(site) = site.cloned() {
            self.site.replace(Some(site));
        }
        static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
        let signals = self.signals.borrow().clone();
        let was_open = signals.is_some();
        let signals = signals.unwrap_or_default();
        let previous = self.session.borrow().clone();
        let id = if was_open {
            previous.clone().ok_or(E_UNEXPECTED)?
        } else {
            NEXT_SESSION.fetch_add(1, Ordering::Relaxed).to_string()
        };
        let mut title = format!("ChemDraft Structure in {}", self.host.borrow().1);
        if let Some(label) = option_env!("CHEMDRAFT_WORKTREE_LABEL")
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            title.push_str(" — ");
            title.push_str(label);
        }
        bridge::open_window(&self.sta.app, &id, title, was_open, signals.clone())
            .map_err(|e| Error::new(E_FAIL, e))?;
        if !was_open {
            self.session.replace(Some(id.clone()));
            self.signals.replace(Some(signals));
            {
                let mut editors = self.sta.editors.borrow_mut();
                if let Some(previous) = previous {
                    // A destroyed renderer with a failed save retained this object for retry.
                    // Its old window label must never address the new edit session.
                    editors.remove(&previous);
                }
                editors.insert(id, self.to_object());
            }
            if let Some(site) = self.site.borrow().clone() {
                unsafe {
                    let _ = site.OnShowWindow(true);
                }
            }
        }
        if verb == EditorVerb::FallbackToPrimary {
            // The generated COM thunk forwards the HRESULT carried by Err, including success codes.
            Err(Error::from_hresult(OLEOBJ_S_INVALIDVERB))
        } else {
            Ok(())
        }
    }
    fn EnumVerbs(&self) -> Result<IEnumOLEVERB> {
        unsafe { OleRegEnumVerbs(&self.sta.guid) }
    }
    fn GetUserClassID(&self) -> Result<GUID> {
        Ok(self.sta.guid)
    }
    fn GetUserType(&self, form: &USERCLASSTYPE) -> Result<PWSTR> {
        if *form == USERCLASSTYPE_FULL {
            unsafe { SHStrDupW(&HSTRING::from(self.sta.class.user_type)) }
        } else {
            unsafe { OleRegGetUserType(&self.sta.guid, *form) }
        }
    }
    fn GetMiscStatus(&self, aspect: DVASPECT) -> Result<OLEMISC> {
        content_aspect(aspect)?;
        Ok(OLEMISC(0))
    }
    fn SetExtent(&self, aspect: DVASPECT, size: *const SIZE) -> Result<()> {
        content_aspect(aspect)?;
        let size = unsafe { size.as_ref() }.ok_or(E_POINTER)?;
        if size.cx <= 0 || size.cy <= 0 {
            return Err(E_INVALIDARG.into());
        }
        if self.extent.replace(Some([size.cx, size.cy])) != Some([size.cx, size.cy]) {
            self.changed();
        }
        Ok(())
    }
    fn GetExtent(&self, aspect: DVASPECT) -> Result<SIZE> {
        content_aspect(aspect)?;
        let [cx, cy] = self
            .extent
            .get()
            .or_else(|| self.content.borrow().image.as_ref().map(|i| i.extent))
            .ok_or(OLE_E_BLANK)?;
        Ok(SIZE { cx, cy })
    }
    fn Advise(&self, sink: Ref<IAdviseSink>) -> Result<u32> {
        unsafe { self.ole_advise.Advise(sink.ok()?) }
    }
    fn Unadvise(&self, cookie: u32) -> Result<()> {
        unsafe { self.ole_advise.Unadvise(cookie) }
    }
    fn EnumAdvise(&self) -> Result<IEnumSTATDATA> {
        unsafe { self.ole_advise.EnumAdvise() }
    }
    fn Update(&self) -> Result<()> {
        Ok(())
    }
    fn IsUpToDate(&self) -> Result<()> {
        Ok(())
    }
    fn SetMoniker(&self, _: &OLEWHICHMK, _: Ref<IMoniker>) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetMoniker(&self, _: &OLEGETMONIKER, _: &OLEWHICHMK) -> Result<IMoniker> {
        Err(E_NOTIMPL.into())
    }
    fn InitFromData(&self, _: Ref<IDataObject>, _: BOOL, _: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetClipboardData(&self, _: u32) -> Result<IDataObject> {
        Ok(self.to_interface())
    }
    fn SetColorScheme(&self, _: *const LOGPALETTE) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
}

fn content_aspect(aspect: DVASPECT) -> Result<()> {
    if aspect != DVASPECT_CONTENT {
        return Err(DV_E_DVASPECT.into());
    }
    Ok(())
}
