//! Out-of-process, open-editing OLE server. The only cross-thread values are messages, application
//! handles and owned selection/preview bytes. All interface pointers, including the editor's strong
//! reference to its object, live and die on the message-pumping STA.

mod data;
mod persist;

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::c_void,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
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

use super::{bridge, presentation::Content, OleClass};

pub(super) enum Action {
    Ready,
    Update(Content),
    Close(bool),
    Destroyed,
    Stop,
    Resume,
}
struct Work {
    id: String,
    action: Action,
    reply: Option<tokio::sync::oneshot::Sender<std::result::Result<(), String>>>,
}

pub(crate) struct Server {
    queue: mpsc::Sender<Work>,
    wake: Arc<OwnedHandle>,
    stopped: Mutex<mpsc::Receiver<()>>,
}

impl Server {
    fn send(&self, work: Work) -> std::result::Result<(), String> {
        self.queue
            .send(work)
            .map_err(|_| "Office object STA has exited".to_string())?;
        unsafe { SetEvent(HANDLE(self.wake.as_raw_handle())) }.map_err(|e| e.to_string())
    }

    pub(super) async fn request(
        &self,
        id: String,
        action: Action,
    ) -> std::result::Result<(), String> {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.send(Work {
            id,
            action,
            reply: Some(reply),
        })?;
        result
            .await
            .map_err(|_| "Office object STA exited before replying".to_owned())?
    }

    pub(super) fn post(&self, id: &str, action: Action) {
        if let Err(error) = self.send(Work {
            id: id.into(),
            action,
            reply: None,
        }) {
            eprintln!("Could not reach Office object STA: {error}");
        }
    }

    pub(super) fn resume(&self) {
        self.post("", Action::Resume);
    }

    pub(crate) fn shutdown(&self) {
        self.post("", Action::Stop);
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
    let (queue, messages) = mpsc::channel();
    let (ready, started) = mpsc::sync_channel(1);
    let (done, stopped) = mpsc::channel();
    // A signaled kernel event survives nested COM message pumps, which may consume thread messages.
    let wake = Arc::new(unsafe {
        OwnedHandle::from_raw_handle(CreateEventW(None, false, false, None)?.0)
    });
    let wake_sta = wake.clone();
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
            let result = serve(handle, flag, class, messages, &wake_sta, &ready);
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
        wake,
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

    fn dispatch(&self, id: &str, action: Action) -> Result<()> {
        if matches!(action, Action::Resume) {
            self.hold_document_lock();
            return unsafe { CoResumeClassObjects() };
        }
        // Take a local COM reference before calling the client. A nested Close may remove the
        // editor from the map while SaveObject or an advise sink is on the stack.
        let object = self.editors.borrow().get(id).cloned();
        let Some(object) = object else {
            return match action {
                Action::Destroyed => Ok(()), // The close command already released this session.
                _ => Err(Error::new(OLE_E_NOCONNECTION, "Office editor has closed")),
            };
        };
        match action {
            Action::Ready => {
                let (container_app, container_document) = object.host.borrow().clone();
                let open = bridge::Open {
                    object_id: id.to_owned(),
                    json: object.content.borrow().json.clone(),
                    container_app,
                    container_document,
                };
                let app = self.app.clone();
                self.app
                    .run_on_main_thread(move || {
                        if let Err(e) = app.emit_to(
                            format!("office-object-{}", open.object_id),
                            "office-object://open",
                            open,
                        ) {
                            eprintln!(
                                "Could not send the Office object selection to its editor: {e}"
                            );
                        }
                    })
                    .map_err(|e| Error::new(E_FAIL, e.to_string()))
            }
            Action::Update(content) => {
                object.content.replace(Rc::new(content));
                object.changed();
                unsafe {
                    object.data_advise.SendOnDataChange(
                        &object.to_interface::<IDataObject>(),
                        None,
                        0,
                    )?;
                }
                object.save_to_client()
            }
            Action::Destroyed => object.finish(false, false),
            Action::Close(save) => object.finish(save, true),
            Action::Resume | Action::Stop => unreachable!(),
        }
    }

    fn handle(&self, work: Work) {
        let result = self.dispatch(&work.id, work.action);
        if let Some(reply) = work.reply {
            let _ = reply.send(result.map_err(|e| e.to_string()));
        } else if let Err(e) = result {
            eprintln!("Office editor: {e}");
        }
    }
}

fn serve(
    app: tauri::AppHandle,
    automation: Arc<AtomicBool>,
    class: OleClass,
    queue: mpsc::Receiver<Work>,
    wake: &OwnedHandle,
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
            'pump: loop {
                while let Ok(work) = queue.try_recv() {
                    if matches!(work.action, Action::Stop) {
                        break 'pump;
                    }
                    sta.handle(work);
                }
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    if msg.message == WM_QUIT {
                        break 'pump;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                if MsgWaitForMultipleObjectsEx(
                    Some(&[HANDLE(wake.as_raw_handle())]),
                    INFINITE,
                    QS_ALLINPUT,
                    MWMO_INPUTAVAILABLE,
                ) == WAIT_FAILED
                {
                    eprintln!("Office STA message wait failed: {}", Error::from_win32());
                    break;
                }
            }
        }
        CoRevokeClassObject(cookie)?;
    }
    let editors = sta.editors.take();
    drop(editors);
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
    saving: Cell<Option<(u64, bool)>>,
    session: RefCell<Option<String>>,
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
            saving: Cell::new(None),
            session: Default::default(),
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
        unsafe {
            site.SaveObject()?;
            self.ole_advise.SendOnSave()
        }
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
                    self.sta
                        .app
                        .run_on_main_thread(move || {
                            if let Some(window) =
                                app.get_webview_window(&format!("office-object-{id}"))
                            {
                                if let Err(e) = window.destroy() {
                                    eprintln!("Could not close Office editor: {e}");
                                }
                            }
                        })
                        .map_err(|e| Error::new(E_FAIL, e.to_string()))?;
                }
            }
            let site = self.site.take();
            if let Some(site) = site {
                unsafe {
                    let _ = site.OnShowWindow(false);
                }
            }
            unsafe { self.ole_advise.SendOnClose() }
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
        self.finish(*option != OLECLOSE_NOSAVE, true)
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
        if !bridge::opens_editor(verb) {
            return Err(OLEOBJ_E_INVALIDVERB.into());
        }
        if self.closing.get() {
            return Err(OLE_E_NOTRUNNING.into());
        }
        if let Some(site) = site.cloned() {
            self.site.replace(Some(site));
        }
        static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
        let existing = self.session.borrow().clone();
        let was_open = existing.is_some();
        let id =
            existing.unwrap_or_else(|| NEXT_SESSION.fetch_add(1, Ordering::Relaxed).to_string());
        self.session.replace(Some(id.clone()));
        self.sta
            .editors
            .borrow_mut()
            .insert(id.clone(), self.to_object());
        self.closed.set(false);
        let mut title = format!("ChemDraft Structure in {}", self.host.borrow().1);
        if let Some(label) = option_env!("CHEMDRAFT_WORKTREE_LABEL")
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            title.push_str(" — ");
            title.push_str(label);
        }
        if let Err(e) = bridge::open_window(&self.sta.app, &id, title, was_open) {
            if !was_open {
                self.sta.editors.borrow_mut().remove(&id);
                self.session.take();
            }
            return Err(Error::new(E_FAIL, e));
        }
        let site = self.site.borrow().clone();
        if let Some(site) = site {
            unsafe {
                let _ = site.OnShowWindow(true);
            }
        }
        Ok(())
    }
    fn EnumVerbs(&self) -> Result<IEnumOLEVERB> {
        unsafe { OleRegEnumVerbs(&self.sta.guid) }
    }
    fn GetUserClassID(&self) -> Result<GUID> {
        Ok(self.sta.guid)
    }
    fn GetUserType(&self, _: &USERCLASSTYPE) -> Result<PWSTR> {
        unsafe { SHStrDupW(&HSTRING::from(self.sta.class.user_type)) }
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
