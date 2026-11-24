use super::{
    command_line::{self, Pipeline, Platform},
    temp_files,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Identity {
    pub main: ExecutableIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub companion: Option<ExecutableIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bundle_id: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecutableIdentity {
    path: PathBuf,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signing_identity: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

impl ExecutableIdentity {
    fn measure(path: PathBuf) -> io::Result<Self> {
        let mut hash = Sha256::new();
        io::copy(&mut File::open(&path)?, &mut hash)?;
        let signing_identity = signature(&path)?;
        Ok(Self {
            path,
            sha256: format!("{:x}", hash.finalize()),
            signing_identity,
            extra: BTreeMap::new(),
        })
    }

    fn matches(&self, other: &Self) -> bool {
        self.path == other.path
            && self.sha256 == other.sha256
            && self.signing_identity == other.signing_identity
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error {
    Missing,
    Changed,
    ToolMissing,
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Self::Missing => "The chosen app is missing. Choose it again.",
            Self::Changed => "The chosen app or its companion changed. Choose the app again.",
            Self::ToolMissing => {
                "The declared companion executable is missing or leaves the app folder."
            }
        }
    }
}

pub(super) struct App {
    pub path: PathBuf,
    pub name: String,
    pub identity: Identity,
}

fn extension_is(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(expected))
}

pub(super) fn valid_pick(platform: Platform, path: &Path) -> bool {
    extension_is(
        path,
        match platform {
            Platform::Mac => "app",
            Platform::Windows => "exe",
        },
    )
}

impl App {
    pub(super) fn read(
        platform: Platform,
        path: &Path,
        pipeline: Option<&Pipeline>,
    ) -> Result<Self, Error> {
        if !valid_pick(platform, path) {
            return Err(Error::Changed);
        }
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Error::Missing
            } else {
                Error::Changed
            }
        })?;
        if temp_files::reparse(&metadata) {
            return Err(Error::Changed);
        }
        let path = path.canonicalize().map_err(|_| Error::Changed)?;
        if !valid_pick(platform, &path) {
            return Err(Error::Changed);
        }
        let (main, root, bundle_id) = match platform {
            Platform::Mac if metadata.is_dir() => {
                let plist = temp_files::plain_path(
                    &path,
                    Path::new("Contents").join("Info.plist").as_path(),
                    false,
                )
                .map_err(|_| Error::Changed)?;
                let executable = plist_key(&plist, "CFBundleExecutable").ok_or(Error::Changed)?;
                if executable.is_empty()
                    || executable.chars().any(temp_files::unsafe_name_char)
                    || matches!(executable.as_str(), "." | "..")
                {
                    return Err(Error::Changed);
                }
                let main = temp_files::plain_path(
                    &path,
                    &Path::new("Contents").join("MacOS").join(executable),
                    false,
                )
                .map_err(|_| Error::Changed)?;
                (
                    main,
                    path.as_path(),
                    plist_key(&plist, "CFBundleIdentifier"),
                )
            }
            Platform::Windows if metadata.is_file() => {
                (path.clone(), path.parent().ok_or(Error::Changed)?, None)
            }
            _ => return Err(Error::Changed),
        };
        let main = ExecutableIdentity::measure(main).map_err(|_| Error::Changed)?;
        let companion = pipeline
            .map(|pipeline| {
                let relative = pipeline
                    .tool_path(platform)
                    .map_err(|_| Error::ToolMissing)?;
                let tool = temp_files::plain_path(root, &relative, false)
                    .map_err(|_| Error::ToolMissing)?;
                ExecutableIdentity::measure(tool).map_err(|_| Error::ToolMissing)
            })
            .transpose()?;
        let name = path
            .file_stem()
            .ok_or(Error::Changed)?
            .to_string_lossy()
            .into_owned();
        Ok(Self {
            path,
            name,
            identity: Identity {
                main,
                companion,
                bundle_id,
                extra: BTreeMap::new(),
            },
        })
    }

    pub(super) fn verify(
        &self,
        platform: Platform,
        pipeline: Option<&Pipeline>,
    ) -> Result<Self, Error> {
        let current = Self::read(platform, &self.path, pipeline).map_err(|error| {
            if error == Error::ToolMissing && self.identity.companion.is_some() {
                Error::Changed
            } else {
                error
            }
        })?;
        if self.path != current.path || !self.identity.matches(&current.identity) {
            return Err(Error::Changed);
        }
        Ok(current)
    }

    pub(super) fn tool(&self) -> Option<&Path> {
        self.identity
            .companion
            .as_ref()
            .map(|companion| companion.path.as_path())
    }

    pub(super) fn open(&self, platform: Platform, file: &Path) -> io::Result<()> {
        let (program, args) =
            command_line::open_command(platform, &self.path, &self.identity.main.path, file);
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{
                CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
            };
            command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
        }
        if platform == Platform::Mac {
            // open exits after submitting the LaunchServices request. The GUI app has
            // its own lifetime, so checking this receipt does not wait on or own it.
            return if command.status()?.success() {
                Ok(())
            } else {
                Err(io::Error::other(
                    "LaunchServices rejected the handoff file.",
                ))
            };
        }
        // On Windows the process is the GUI app itself. Drop the detached process handle.
        command.spawn()?;
        Ok(())
    }
}

impl Identity {
    pub(super) fn main_matches(&self, other: &Self) -> bool {
        self.main.matches(&other.main) && self.bundle_id == other.bundle_id
    }

    pub(super) fn matches(&self, other: &Self) -> bool {
        self.main_matches(other)
            && match (&self.companion, &other.companion) {
                (Some(first), Some(second)) => first.matches(second),
                (None, None) => true,
                _ => false,
            }
    }
}

#[cfg(target_os = "macos")]
fn plist_key(path: &Path, key: &str) -> Option<String> {
    // PlistBuddy reads XML and binary plists on the app's macOS 11 minimum.
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", &format!("Print :{key}")])
        .arg(path)
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_owned()
    })
}

#[cfg(not(target_os = "macos"))]
fn plist_key(_path: &Path, _key: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn signature(path: &Path) -> io::Result<Option<String>> {
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=4"])
        .arg(path)
        .env_clear()
        .stdin(Stdio::null())
        .output()?;
    let details = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        if details.contains("is not signed at all") {
            return Ok(None);
        }
        return Err(io::Error::other(
            "Could not inspect the app's macOS signature.",
        ));
    }
    if let Some(team) = details
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .filter(|team| *team != "not set" && !team.is_empty())
    {
        return Ok(Some(format!("team:{team}")));
    }
    details
        .lines()
        .find_map(|line| line.strip_prefix("CDHash="))
        .map(|hash| Some(format!("cdhash:{hash}")))
        .ok_or_else(|| io::Error::other("The app's signature has no code directory hash."))
}

#[cfg(windows)]
fn signature(path: &Path) -> io::Result<Option<String>> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::TRUST_E_NOSIGNATURE,
        Security::{
            Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE},
            WinTrust::*,
        },
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // The provider state and its certificate pointers are valid until WTD_STATEACTION_CLOSE.
    unsafe {
        let status = WinVerifyTrust(
            ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
        let publisher = (|| {
            if status == TRUST_E_NOSIGNATURE {
                return Ok(None);
            }
            let state = WTHelperProvDataFromStateData(data.hWVTStateData);
            if !state.is_null() {
                let signer = WTHelperGetProvSignerFromChain(state, 0, 0, 0);
                if !signer.is_null() {
                    let certificate = WTHelperGetProvCertFromChain(signer, 0);
                    if let Some(certificate) = certificate
                        .as_ref()
                        .filter(|certificate| !certificate.pCert.is_null())
                    {
                        let len = CertGetNameStringW(
                            certificate.pCert,
                            CERT_NAME_SIMPLE_DISPLAY_TYPE,
                            0,
                            ptr::null(),
                            ptr::null_mut(),
                            0,
                        );
                        if len > 1 {
                            let mut name = vec![0u16; len as usize];
                            if CertGetNameStringW(
                                certificate.pCert,
                                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                                0,
                                ptr::null(),
                                name.as_mut_ptr(),
                                len,
                            ) == len
                            {
                                return Ok(Some(String::from_utf16_lossy(&name[..name.len() - 1])));
                            }
                        }
                    }
                }
            }
            Err(io::Error::other(
                "Could not read the executable's Authenticode publisher.",
            ))
        })();
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(
            ptr::null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
        publisher
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn signature(_path: &Path) -> io::Result<Option<String>> {
    Ok(None)
}
