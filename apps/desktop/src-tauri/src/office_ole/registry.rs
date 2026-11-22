//! Registration of ChemDraft's own OLE class (docs/architecture/office-editing.md §4).
//!
//! `--register-office-object[=per-user|all-users]` and `--unregister-office-object[=...]` write
//! or remove only this build's CLSID and ProgID keys, under `HKCU\Software\Classes` (per-user,
//! the default) or `HKLM\Software\Classes` (all-users, which needs an elevated process). The NSIS
//! installer hooks (`windows/installer-hooks.nsh`) run them for the installer's scope.

use super::OleClass;
use std::ffi::{OsStr, OsString};

struct Branch {
    root: String,
    // All entries are default REG_SZ values. An empty value denotes a marker key.
    entries: Vec<(&'static str, OsString)>,
}

fn plan(class: OleClass, exe: &OsStr) -> Vec<Branch> {
    let mut quoted = OsString::from("\"");
    quoted.push(exe);
    quoted.push("\"");
    let mut icon = quoted.clone();
    icon.push(",0");

    vec![
        Branch {
            root: format!(r"CLSID\{}", class.clsid),
            entries: vec![
                ("", class.user_type.into()),
                ("LocalServer32", quoted),
                ("ProgID", class.prog_id.into()),
                ("VersionIndependentProgID", class.independent.into()),
                ("InprocHandler32", "ole32.dll".into()),
                ("Insertable", "".into()),
                ("DefaultIcon", icon),
                ("AuxUserType", "".into()),
                (r"AuxUserType\2", class.user_type.into()),
                (r"AuxUserType\3", "ChemDraft".into()),
                // Open editing in a separate window. No in-place or activation flags.
                ("MiscStatus", "0".into()),
                ("Verb", "".into()),
                (r"Verb\0", "&Edit,0,2".into()),
                (r"Verb\1", "&Open,0,2".into()),
            ],
        },
        Branch {
            root: class.prog_id.into(),
            entries: vec![
                ("", class.user_type.into()),
                ("CLSID", class.clsid.into()),
                ("Insertable", "".into()),
            ],
        },
        Branch {
            root: class.independent.into(),
            entries: vec![
                ("", class.user_type.into()),
                ("CLSID", class.clsid.into()),
                ("CurVer", class.prog_id.into()),
            ],
        },
    ]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    PerUser,
    AllUsers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Register,
    Unregister,
}

const REGISTER_FLAG: &str = "--register-office-object";
const UNREGISTER_FLAG: &str = "--unregister-office-object";

/// The Office registration request in a process's arguments (without argv\[0\]), if any.
/// A bare flag means per-user, so earlier `--register-office-object` callers keep HKCU.
fn parse_cli(args: &[OsString]) -> Result<Option<(Action, Scope)>, String> {
    let mut request = None;
    for arg in args {
        let Some(text) = arg.to_str() else { continue };
        for (flag, action) in [
            (REGISTER_FLAG, Action::Register),
            (UNREGISTER_FLAG, Action::Unregister),
        ] {
            let Some(rest) = text.strip_prefix(flag) else {
                continue;
            };
            let scope = match rest {
                "" | "=per-user" => Scope::PerUser,
                "=all-users" => Scope::AllUsers,
                _ if rest.starts_with('=') => {
                    return Err(format!(
                        "Unknown Office registration scope in {text:?}; use {flag}=per-user or {flag}=all-users"
                    ))
                }
                _ => continue,
            };
            request = Some((action, scope));
        }
    }
    if request.is_some() && args.len() != 1 {
        return Err("Use one Office registration flag by itself".into());
    }
    Ok(request)
}

/// Whether an existing `LocalServer32` value names `exe`. Unregistering from one copy of
/// ChemDraft must never remove the registration a copy installed elsewhere has since written.
fn server_is(existing: &str, exe: &OsStr) -> bool {
    let existing = existing.trim();
    let existing = existing
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(existing);
    existing.eq_ignore_ascii_case(&exe.to_string_lossy())
}

/// What an unregister may remove, given each registry view's `LocalServer32` (64-bit view first).
/// A view whose CLSID names another executable keeps its CLSID. Windows redirects the CLSID branch
/// per view but shares the ProgID keys between them, so another executable's registration in
/// either view keeps the ProgIDs too.
fn unregister_allowance(servers: &[Option<String>], exe: &OsStr) -> (Vec<bool>, bool) {
    let owned: Vec<bool> = servers
        .iter()
        .map(|server| {
            server
                .as_deref()
                .is_none_or(|server| server_is(server, exe))
        })
        .collect();
    let prog_ids = owned.iter().all(|&owned| owned);
    (owned, prog_ids)
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{io, path::PathBuf};
    use winreg::{enums::*, transaction::Transaction, RegKey};

    fn optional<T>(result: io::Result<T>) -> io::Result<Option<T>> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    impl OleClass {
        pub(crate) fn register(self, scope: Scope) -> io::Result<()> {
            self.apply_registration(scope, true)
        }
        pub(crate) fn unregister(self, scope: Scope) -> io::Result<()> {
            self.apply_registration(scope, false)
        }

        fn apply_registration(self, scope: Scope, install: bool) -> io::Result<()> {
            if scope == Scope::AllUsers && !process_is_elevated()? {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "All-users Office registration writes HKLM and needs an elevated (administrator) process. Run it from an elevated prompt, or use the per-user flag.",
                ));
            }
            let hive = RegKey::predef(match scope {
                Scope::PerUser => HKEY_CURRENT_USER,
                Scope::AllUsers => HKEY_LOCAL_MACHINE,
            });
            let transaction = Transaction::new()?;
            let exe = std::env::current_exe()?;
            let branches = plan(self, exe.as_os_str());
            let mut report = Vec::new();
            let views = [KEY_WOW64_64KEY, KEY_WOW64_32KEY];
            // An unregister reads both views' owners before it removes anything: the ProgID keys
            // are shared, so another executable's registration in either view keeps them.
            let mut servers = Vec::new();
            if !install {
                for view in views {
                    let server = match optional(hive.open_subkey_transacted_with_flags(
                        r"Software\Classes",
                        &transaction,
                        KEY_READ | view,
                    ))? {
                        Some(classes) => optional(classes.open_subkey_transacted_with_flags(
                            format!(r"CLSID\{}\LocalServer32", self.clsid),
                            &transaction,
                            KEY_READ | view,
                        ))?
                        .map(|key| optional(key.get_value::<String, _>("")))
                        .transpose()?
                        .flatten(),
                        None => None,
                    };
                    servers.push(server);
                }
            }
            let (owned_views, owns_prog_ids) = unregister_allowance(&servers, exe.as_os_str());
            // CLSID is redirected on 64-bit Windows. ProgID branches may be shared between views.
            for (index, view) in views.into_iter().enumerate() {
                let flags = KEY_READ | KEY_WRITE | view;
                let classes = if install {
                    hive.create_subkey_transacted_with_flags(
                        r"Software\Classes",
                        &transaction,
                        flags,
                    )?
                    .0
                } else {
                    let Some(classes) = optional(hive.open_subkey_transacted_with_flags(
                        r"Software\Classes",
                        &transaction,
                        flags,
                    ))?
                    else {
                        continue;
                    };
                    classes
                };
                if !install && !owned_views[index] {
                    report.push(format!(
                        "Kept registration: LocalServer32 is {}, not this executable",
                        servers[index].as_deref().unwrap_or_default()
                    ));
                    continue;
                }
                for branch in &branches {
                    if !install && !owns_prog_ids && !branch.root.starts_with(r"CLSID\") {
                        report.push(format!(
                            "Kept shared ProgID {}: another executable owns this class's registration",
                            branch.root
                        ));
                        continue;
                    }
                    let root = PathBuf::from(&branch.root);
                    let existing = optional(classes.open_subkey_transacted_with_flags(
                        &root,
                        &transaction,
                        KEY_READ | view,
                    ))?;
                    if let Some(key) = existing {
                        // ProgID roots use their CLSID subkey. A CLSID root's default is
                        // the display name, so keep a named CLSID ownership value there.
                        let owner: Option<String> = if branch.root.starts_with(r"CLSID\") {
                            optional(key.get_value("CLSID"))?
                        } else {
                            optional(key.open_subkey_transacted_with_flags(
                                "CLSID",
                                &transaction,
                                KEY_READ | view,
                            ))?
                            .map(|key| optional(key.get_value("")))
                            .transpose()?
                            .flatten()
                        };
                        if !owner
                            .as_deref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(self.clsid))
                        {
                            if install {
                                return Err(io::Error::other(format!("Office registration conflict at {scope:?} {}: CLSID does not match {}", branch.root, self.clsid)));
                            }
                            continue;
                        }
                    } else if !install {
                        continue;
                    }
                    if install {
                        for (child, value) in &branch.entries {
                            let path = if child.is_empty() {
                                root.clone()
                            } else {
                                root.join(child)
                            };
                            let (key, _) = classes.create_subkey_transacted_with_flags(
                                &path,
                                &transaction,
                                flags,
                            )?;
                            key.set_value("", value)?;
                            if child.is_empty() && branch.root.starts_with(r"CLSID\") {
                                key.set_value("CLSID", &self.clsid)?;
                            }
                            report.push(format!(
                                "Wrote {} = {}",
                                path.display(),
                                value.to_string_lossy()
                            ));
                        }
                    } else {
                        // Delete only known entries. Preserve unrecognized children or named values.
                        for (child, _) in branch.entries.iter().rev() {
                            let path = if child.is_empty() {
                                root.clone()
                            } else {
                                root.join(child)
                            };
                            let Some(key) = optional(classes.open_subkey_transacted_with_flags(
                                &path,
                                &transaction,
                                flags,
                            ))?
                            else {
                                continue;
                            };
                            optional(key.delete_value(""))?;
                            if child.is_empty() && branch.root.starts_with(r"CLSID\") {
                                optional(key.delete_value("CLSID"))?;
                            }
                            if key.enum_keys().next().transpose()?.is_none()
                                && key.enum_values().next().transpose()?.is_none()
                            {
                                drop(key);
                                classes.delete_subkey_transacted_with_flags(
                                    &path,
                                    &transaction,
                                    view,
                                )?;
                            }
                            report.push(format!("Removed registration at {}", path.display()));
                        }
                    }
                }
            }
            transaction.commit()?;
            println!(
                "{scope:?} Office registration for {}: {} entries",
                self.clsid,
                report.len()
            );
            for line in report {
                println!("{line}");
            }
            Ok(())
        }
    }

    fn process_is_elevated() -> io::Result<bool> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: the pseudo-handle from GetCurrentProcess needs no closing; `token` is closed
        // below, and GetTokenInformation writes at most `size_of::<TOKEN_ELEVATION>()` bytes.
        unsafe {
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut returned = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );
            let error = io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            Ok(elevation.TokenIsElevated != 0)
        }
    }

    pub(crate) fn handle_cli(identifier: &str) {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        let request = parse_cli(&args);
        if matches!(request, Ok(None)) {
            return;
        }
        // A packaged GUI process has no console. Reuse its invoking terminal when present.
        unsafe {
            let _ = windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
        let result = request.map_err(io::Error::other).and_then(|request| {
            let (action, scope) = request.expect("Ok(None) returned above");
            let class = OleClass::for_identifier(identifier).map_err(io::Error::other)?;
            match action {
                Action::Register => class.register(scope),
                Action::Unregister => class.unregister(scope),
            }
        });
        if let Err(error) = result {
            eprintln!("ChemDraft Office registration failed: {error}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }
}
#[cfg(windows)]
pub(crate) use native::handle_cli;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_plans_are_disjoint_and_quote_the_executable() {
        let exe = OsStr::new(r"C:\Program Files\ChemDraft\ChemDraft.exe");
        for (identifier, class, other) in [
            ("org.chemdraft.desktop", OleClass::STABLE, OleClass::DEV),
            ("org.chemdraft.desktop.dev", OleClass::DEV, OleClass::STABLE),
        ] {
            assert_eq!(OleClass::for_identifier(identifier).unwrap(), class);
            let branches = plan(class, exe);
            assert_eq!(
                branches.iter().map(|b| b.root.as_str()).collect::<Vec<_>>(),
                [
                    format!(r"CLSID\{}", class.clsid),
                    class.prog_id.into(),
                    class.independent.into()
                ]
            );
            let get = |index: usize, key| {
                branches[index]
                    .entries
                    .iter()
                    .find(|(k, _)| *k == key)
                    .unwrap()
                    .1
                    .to_str()
                    .unwrap()
            };
            assert_eq!(
                get(0, "LocalServer32"),
                r#""C:\Program Files\ChemDraft\ChemDraft.exe""#
            );
            assert_eq!(
                get(0, "DefaultIcon"),
                r#""C:\Program Files\ChemDraft\ChemDraft.exe",0"#
            );
            assert_eq!(get(0, r"Verb\0"), "&Edit,0,2");
            assert_eq!(get(0, r"Verb\1"), "&Open,0,2");
            assert_eq!(get(0, "InprocHandler32"), "ole32.dll");
            assert_eq!(get(1, "CLSID"), class.clsid);
            assert_eq!(get(2, "CurVer"), class.prog_id);
            assert!(plan(other, exe)
                .iter()
                .all(|b| !branches.iter().any(|a| a.root == b.root)));
        }
        assert!(OleClass::for_identifier("other").is_err());
    }

    fn parse(args: &[&str]) -> Result<Option<(Action, Scope)>, String> {
        parse_cli(&args.iter().map(OsString::from).collect::<Vec<_>>())
    }

    #[test]
    fn cli_selects_action_and_scope() {
        use Action::*;
        use Scope::*;
        for (arg, expected) in [
            ("--register-office-object", (Register, PerUser)),
            ("--register-office-object=per-user", (Register, PerUser)),
            ("--register-office-object=all-users", (Register, AllUsers)),
            ("--unregister-office-object", (Unregister, PerUser)),
            ("--unregister-office-object=per-user", (Unregister, PerUser)),
            (
                "--unregister-office-object=all-users",
                (Unregister, AllUsers),
            ),
        ] {
            assert_eq!(parse(&[arg]), Ok(Some(expected)), "{arg}");
        }
        // Normal launches, document paths and COM's own flag are not registration requests.
        for args in [
            &[][..],
            &["C:\\Users\\me\\a.chemdraft"][..],
            &["-Embedding"][..],
            &["--register-office-objects"][..],
            &["--register-office-object-now"][..],
        ] {
            assert_eq!(parse(args), Ok(None), "{args:?}");
        }
        for args in [
            &["--register-office-object=machine"][..],
            &["--unregister-office-object="][..],
            &["--register-office-object=All-Users"][..],
            &["--register-office-object", "--unregister-office-object"][..],
            &["--register-office-object=all-users", "x.chemdraft"][..],
        ] {
            assert!(parse(args).is_err(), "{args:?}");
        }
        assert!(parse(&["--register-office-object=machine"])
            .unwrap_err()
            .contains("--register-office-object=all-users"));
    }

    #[test]
    fn unregistering_matches_only_this_executable() {
        let exe = OsStr::new(r"C:\Program Files\ChemDraft\ChemDraft.exe");
        assert!(server_is(
            r#""C:\Program Files\ChemDraft\ChemDraft.exe""#,
            exe
        ));
        assert!(server_is(
            r#""c:\program files\chemdraft\chemdraft.exe""#,
            exe
        ));
        assert!(server_is(r"C:\Program Files\ChemDraft\ChemDraft.exe", exe));
        assert!(!server_is(
            r#""C:\Users\me\AppData\Local\ChemDraft\ChemDraft.exe""#,
            exe
        ));
        assert!(!server_is(r#""C:\Program Files\ChemDraft\Other.exe""#, exe));
    }

    /// The 64-bit view names another ChemDraft and the 32-bit CLSID is missing. The shared ProgIDs
    /// stay; only a CLSID this executable owns may go.
    #[test]
    fn unregistering_keeps_shared_prog_ids_another_executable_owns_in_either_view() {
        let exe = OsStr::new(r"C:\Program Files\ChemDraft\ChemDraft.exe");
        let ours = Some(r#""C:\Program Files\ChemDraft\ChemDraft.exe""#.to_owned());
        let other = Some(r#""C:\Users\me\AppData\Local\ChemDraft\ChemDraft.exe""#.to_owned());
        assert_eq!(
            unregister_allowance(&[other.clone(), None], exe),
            (vec![false, true], false)
        );
        assert_eq!(
            unregister_allowance(&[None, other.clone()], exe),
            (vec![true, false], false)
        );
        assert_eq!(
            unregister_allowance(&[ours.clone(), other], exe),
            (vec![true, false], false)
        );
        assert_eq!(
            unregister_allowance(&[ours.clone(), None], exe),
            (vec![true, true], true)
        );
        assert_eq!(
            unregister_allowance(&[None, None], exe),
            (vec![true, true], true)
        );
        assert_eq!(
            unregister_allowance(&[ours.clone(), ours], exe),
            (vec![true, true], true)
        );
    }

    #[test]
    fn installer_hooks_register_after_install_and_unregister_before_removal() {
        let hook = include_str!("../../windows/installer-hooks.nsh");
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.windows.conf.json")).unwrap();
        assert_eq!(
            config["bundle"]["windows"]["nsis"]["installerHooks"],
            "./windows/installer-hooks.nsh"
        );
        let code: String = hook
            .lines()
            .map(|line| line.split(';').next().unwrap().trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let body = |name: &str| {
            let start = code
                .find(&format!("!macro {name}"))
                .unwrap_or_else(|| panic!("{name} missing"));
            let end = start + code[start..].find("!macroend").unwrap();
            code[start..end].to_string()
        };
        // Tauri's installer.nsi inserts POSTINSTALL after copying files and PREUNINSTALL before
        // deleting them; no other phase may touch registration.
        assert!(
            body("NSIS_HOOK_POSTINSTALL").contains("!insertmacro CHEMDRAFT_OFFICE_OBJECT register")
        );
        assert!(body("NSIS_HOOK_PREUNINSTALL")
            .contains("!insertmacro CHEMDRAFT_OFFICE_OBJECT unregister"));
        assert!(!body("NSIS_HOOK_POSTINSTALL").contains("unregister"));
        for phase in ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_POSTUNINSTALL"] {
            assert!(!code.contains(&format!("!macro {phase}")), "{phase}");
        }
        let run = body("CHEMDRAFT_OFFICE_OBJECT");
        assert!(run.contains(
            r#"ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --${_ACTION}-office-object=$1' $0"#
        ));
        // A failure is logged, never fatal.
        assert!(run.contains("DetailPrint"));
        for fatal in ["Abort", "Quit", "SetErrorLevel", "MessageBox"] {
            assert!(!code.contains(fatal), "{fatal}");
        }
        // Scope follows the installer's mode; the macro values are exactly the CLI's.
        let scope = body("CHEMDRAFT_OFFICE_SCOPE");
        let lines: Vec<_> = scope.lines().collect();
        let after = |condition: &str| {
            let at = lines.iter().position(|l| *l == condition).unwrap();
            lines[at + 1]
        };
        assert_eq!(
            after(r#"!if "${INSTALLMODE}" == "perMachine""#),
            r#"StrCpy ${_OUT} "all-users""#
        );
        assert_eq!(
            after(r#"${If} $MultiUser.InstallMode == "AllUsers""#),
            r#"StrCpy ${_OUT} "all-users""#
        );
        assert_eq!(after("!else"), r#"StrCpy ${_OUT} "per-user""#);
        for value in ["per-user", "all-users"] {
            let flag = format!("--register-office-object={value}");
            assert!(parse(&[&flag]).unwrap().is_some());
        }
        // The executable chooses the class; the hook code never names a class or another program's keys.
        for class in [OleClass::STABLE, OleClass::DEV] {
            for name in [class.clsid, class.prog_id, class.independent] {
                assert!(!code.contains(name), "{name}");
            }
        }
        let writes: Vec<_> = code
            .lines()
            .filter(|l| l.starts_with("WriteReg") || l.starts_with("DeleteReg"))
            .collect();
        assert_eq!(
            writes,
            [
                r#"WriteRegStr SHCTX "Software\Classes\ChemDraft Document\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'"#
            ]
        );
    }
}
