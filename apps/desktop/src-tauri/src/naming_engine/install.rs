use std::{ffi::OsString, fs, path::Path};

use super::{
    pins,
    receipt::{self, InstallReceipt},
};
use crate::local_engine::{self, EngineSpec, InstallError, InstallErrorCode, InstallPhase};
use local_engine::install::{Download, InstallContext, RunStep, RECEIPT_FILE};
use local_engine::platform::EnginePlatform;

pub struct NamingSpec;
pub type SystemInstallIo = local_engine::install::SystemInstallIo<NamingSpec>;

pub fn platform_supported(platform: &dyn EnginePlatform) -> Result<(), String> {
    match platform.uv_asset() {
        "uv-aarch64-apple-darwin.tar.gz" | "uv-x86_64-pc-windows-msvc.zip" => Ok(()),
        "uv-x86_64-apple-darwin.tar.gz" => Err("The naming engine needs a Mac with Apple silicon: RDKit 2026.3.5 has no Intel Mac wheel.".into()),
        _ => Err("The naming engine supports macOS Apple silicon and Windows x64.".into()),
    }
}

pub fn current_platform() -> Result<Box<dyn EnginePlatform>, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let platform: Box<dyn EnginePlatform> = Box::new(local_engine::platform::MacPlatform::new(
        local_engine::platform::MacArchitecture::Aarch64,
    ));
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    let platform: Box<dyn EnginePlatform> = Box::new(local_engine::platform::WindowsPlatform);
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    {
        platform_supported(platform.as_ref())?;
        Ok(platform)
    }
    #[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "windows", target_arch = "x86_64"))))]
    Err(format!("The naming engine is unavailable for {}-{}; macOS requires Apple silicon (no Intel RDKit wheel).", std::env::consts::OS, std::env::consts::ARCH))
}

pub fn centres_path(root: &Path) -> std::path::PathBuf {
    root.join("jars").join(pins::CENTRES_FILENAME)
}

pub fn verify_centres(root: &Path) -> Result<(), InstallError> {
    let path = centres_path(root);
    let file = fs::File::open(&path).map_err(NamingSpec::failed_io)?;
    let size = file.metadata().map_err(NamingSpec::failed_io)?.len();
    if size != pins::CENTRES_BYTES {
        return Err(InstallError::checksum(format!(
            "The centres jar at {} is {size} bytes; expected {}.",
            path.display(),
            pins::CENTRES_BYTES
        )));
    }
    local_engine::pins::verify_reader(file, Some(pins::CENTRES_BYTES), pins::CENTRES_SHA256)
        .map(|_| ())
        .map_err(|detail| {
            InstallError::checksum(format!(
                "The centres jar at {} failed verification: {detail}.",
                path.display()
            ))
        })
}

const LICENSE_FILES: &[(&str, &[u8])] = &[
    (
        "centres-BSD-2-Clause.txt",
        include_bytes!("../../resources/naming/licenses/centres-BSD-2-Clause.txt"),
    ),
    (
        "beam-BSD-2-Clause.txt",
        include_bytes!("../../resources/naming/licenses/beam-BSD-2-Clause.txt"),
    ),
    (
        "LGPL-2.1.txt",
        include_bytes!("../../resources/naming/licenses/LGPL-2.1.txt"),
    ),
    (
        "GPL-2.0.txt",
        include_bytes!("../../resources/naming/licenses/GPL-2.0.txt"),
    ),
    (
        "Classpath-exception.txt",
        include_bytes!("../../resources/naming/licenses/Classpath-exception.txt"),
    ),
    (
        "vecmath-COPYRIGHT.txt",
        include_bytes!("../../resources/naming/licenses/vecmath-COPYRIGHT.txt"),
    ),
    (
        "README.md",
        include_bytes!("../../resources/naming/licenses/README.md"),
    ),
];

impl EngineSpec for NamingSpec {
    type Receipt = InstallReceipt;
    const DIR_NAME: &'static str = pins::DIR_NAME;
    const LOG_PREFIX: &'static str = "[chemdraft naming]";
    const USER_AGENT: &'static str = "ChemDraft-Naming-Installer/1";
    fn python_version() -> &'static str {
        pins::PYTHON_VERSION
    }
    fn required_disk_bytes() -> u64 {
        pins::REQUIRED_DISK_BYTES
    }
    fn requirements() -> (&'static str, &'static str) {
        (
            "resources/naming/requirements.txt",
            pins::REQUIREMENTS_LOCK_SHA256,
        )
    }
    fn python_growth_bytes() -> u64 {
        75_000_000
    }
    fn packages_growth_bytes() -> u64 {
        370_000_000
    }
    fn pip_install_args() -> Vec<OsString> {
        vec!["--compile-bytecode".into()]
    }
    fn packages_label() -> &'static str {
        "Installing Orthonym dependencies"
    }
    fn packages_message() -> &'static str {
        "Installing hash-locked Orthonym dependencies and compiling bytecode."
    }
    fn installed_message() -> &'static str {
        "Orthonym is installed."
    }
    fn insufficient_disk(free: u64) -> InstallError {
        InstallError {
            code: InstallErrorCode::InsufficientDisk,
            message: format!(
                "The naming engine needs {} bytes free; {free} bytes are available.",
                pins::REQUIRED_DISK_BYTES
            ),
        }
    }
    fn cancelled() -> InstallError {
        InstallError {
            code: InstallErrorCode::Cancelled,
            message: "Naming engine installation cancelled.".into(),
        }
    }
    fn failed_io(error: std::io::Error) -> InstallError {
        InstallError::failed(format!("Naming engine file operation failed: {error}"))
    }
    fn relocation_error(error: std::io::Error) -> InstallError {
        InstallError::failed(format!(
            "Could not relocate the naming environment: {error}"
        ))
    }
    fn platform_supported(platform: &dyn EnginePlatform) -> Result<(), String> {
        platform_supported(platform)
    }
    fn before_packages(_context: &InstallContext<'_>) -> Result<(), InstallError> {
        Ok(())
    }
    fn extra_steps(context: &InstallContext<'_>) -> Result<(), InstallError> {
        fs::create_dir_all(context.root.join("jars")).map_err(Self::failed_io)?;
        context.io.download(
            Download {
                url: pins::CENTRES_URL,
                sha256: pins::CENTRES_SHA256,
                size: Some(pins::CENTRES_BYTES),
                phase: InstallPhase::DownloadingModel,
            },
            &centres_path(context.root),
            context.cancel,
            context.progress,
        )?;
        let licenses = context.root.join("LICENSES");
        fs::create_dir_all(&licenses).map_err(Self::failed_io)?;
        for (name, bytes) in LICENSE_FILES {
            fs::write(licenses.join(name), bytes).map_err(Self::failed_io)?;
        }
        // Read only the installed distribution's recorded dist-info files, never a source tree.
        let script = "import importlib.metadata as m, pathlib, shutil, sys; d=m.distribution('orthonym'); out=pathlib.Path(sys.argv[1]); files=list(d.files or []); names=('LICENSE','NOTICE'); matches={n: next((p for p in files if '.dist-info/' in str(p).replace(chr(92),'/') and p.name==n), None) for n in names}; assert all(matches.values()), 'Orthonym dist-info LICENSE or NOTICE missing'; [shutil.copyfile(d.locate_file(p), out/('orthonym-'+n)) for n,p in matches.items()]";
        context.io.run(
            context.platform,
            RunStep::Extra,
            &context.platform.venv_python(context.root),
            &[
                "-I".into(),
                "-B".into(),
                "-c".into(),
                script.into(),
                licenses.into_os_string(),
            ],
            context.environment,
            context.cancel,
            None,
        )?;
        Ok(())
    }
    fn probe_args() -> Vec<OsString> {
        local_engine::install::os_args(["-I", "-B", "-c", "import orthonym, rdkit, jpype; print(orthonym.__version__); assert orthonym.__version__ == '1.0.8', 'Unexpected Orthonym version'"])
    }
    fn verify_layout(root: &Path, platform: &dyn EnginePlatform) -> Result<(), InstallError> {
        for path in [
            platform.uv_executable(root),
            platform.venv_python(root),
            root.join("LICENSES").join("orthonym-LICENSE"),
            root.join("LICENSES").join("orthonym-NOTICE"),
        ] {
            if !path.is_file() {
                return Err(InstallError::failed(format!(
                    "Naming engine file missing: {}",
                    path.display()
                )));
            }
        }
        verify_centres(root)
    }
    fn receipt(platform: &dyn EnginePlatform, disk_bytes: u64) -> InstallReceipt {
        InstallReceipt::pinned(platform, disk_bytes)
    }
    fn read_current_receipt(path: &Path) -> Option<InstallReceipt> {
        receipt::read_receipt(path).ok()
    }
    fn matches_pins(receipt: &InstallReceipt, platform: &dyn EnginePlatform) -> bool {
        receipt.matches_pins(platform)
    }
    fn write_receipt(path: &Path, receipt: &InstallReceipt) -> Result<(), InstallError> {
        local_engine::receipt::write_receipt::<Self>(path, receipt)
    }
    fn is_restorable(root: &Path, platform: &dyn EnginePlatform) -> bool {
        receipt::read_receipt(&root.join(RECEIPT_FILE))
            .is_ok_and(|receipt| receipt.matches_pins(platform))
            && platform.uv_executable(root).is_file()
            && fs::symlink_metadata(platform.venv_python(root)).is_ok()
            && verify_centres(root).is_ok()
    }
}
