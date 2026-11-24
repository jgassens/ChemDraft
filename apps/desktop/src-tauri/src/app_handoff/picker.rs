use super::{command_line::Platform, identity};
use std::path::PathBuf;
use tauri::WebviewWindow;

pub(super) async fn pick(
    window: &WebviewWindow,
    platform: Platform,
    purpose: String,
) -> Result<Option<PathBuf>, String> {
    let picked = platform_pick(window, purpose).await?;
    if picked
        .as_ref()
        .is_some_and(|path| !identity::valid_pick(platform, path))
    {
        return Err(match platform {
            Platform::Mac => "Choose the destination's .app bundle.",
            Platform::Windows => "Choose the destination's .exe file in its install folder. Shortcuts and scripts are unsupported.",
        }.into());
    }
    Ok(picked)
}

#[cfg(target_os = "macos")]
async fn platform_pick(window: &WebviewWindow, purpose: String) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title(picker_title(&purpose))
        .set_directory("/Applications")
        .add_filter("Applications", &["app"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await
        .map_err(|_| "The app picker closed unexpectedly.")?
        .map(|path| {
            path.into_path()
                .map_err(|_| "Choose a local .app bundle.".to_owned())
        })
        .transpose()
}

#[cfg(windows)]
async fn platform_pick(window: &WebviewWindow, purpose: String) -> Result<Option<PathBuf>, String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, ptr};
    use windows_sys::Win32::UI::{
        Controls::Dialogs::*,
        Shell::{SHGetFolderPathW, CSIDL_PROGRAMS},
    };
    let owner = window.clone();
    crate::run_on_main_thread_blocking(window, move || {
        let mut directory = [0u16; 260];
        let mut file = vec![0u16; 32768];
        let filter: Vec<u16> = "Applications (*.exe)\0*.exe\0\0".encode_utf16().collect();
        let title: Vec<u16> = picker_title(&purpose)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let hwnd = owner
            .hwnd()
            .map_err(|_| "The native app picker has no document owner.")?
            .0;
        // OFN_NODEREFERENCELINKS preserves the picked .lnk, which the host rejects after the picker.
        unsafe {
            let directory_ok = SHGetFolderPathW(
                hwnd.cast(),
                CSIDL_PROGRAMS as i32,
                ptr::null_mut(),
                0,
                directory.as_mut_ptr(),
            ) >= 0;
            let mut dialog = OPENFILENAMEW {
                lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
                hwndOwner: hwnd.cast(),
                lpstrFilter: filter.as_ptr(),
                lpstrFile: file.as_mut_ptr(),
                nMaxFile: file.len() as u32,
                lpstrInitialDir: if directory_ok {
                    directory.as_ptr()
                } else {
                    ptr::null()
                },
                lpstrTitle: title.as_ptr(),
                Flags: OFN_EXPLORER
                    | OFN_FILEMUSTEXIST
                    | OFN_PATHMUSTEXIST
                    | OFN_NOCHANGEDIR
                    | OFN_NODEREFERENCELINKS,
                ..Default::default()
            };
            if GetOpenFileNameW(&mut dialog) == 0 {
                return if CommDlgExtendedError() == 0 {
                    Ok(None)
                } else {
                    Err("The native app picker could not open.".into())
                };
            }
        }
        let end = file
            .iter()
            .position(|ch| *ch == 0)
            .ok_or("The app picker returned an invalid path.")?;
        Ok(Some(PathBuf::from(OsString::from_wide(&file[..end]))))
    })?
}

#[cfg(any(target_os = "macos", windows))]
fn picker_title(purpose: &str) -> String {
    if purpose.is_empty() {
        "Choose an app".into()
    } else {
        format!("Choose an app — {purpose}")
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn platform_pick(
    _window: &WebviewWindow,
    _purpose: String,
) -> Result<Option<PathBuf>, String> {
    Err("The handoff app picker is available on macOS and Windows.".into())
}
