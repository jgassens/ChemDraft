//! Registration is opt-in. The executable flags use HKCU; installer integration with
//! per-user and all-users scopes is a separate slice.

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

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
pub(crate) enum Scope {
    PerUser,
    #[allow(dead_code)] // Installer entry point.
    AllUsers,
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
            let hive = RegKey::predef(match scope {
                Scope::PerUser => HKEY_CURRENT_USER,
                Scope::AllUsers => HKEY_LOCAL_MACHINE,
            });
            let transaction = Transaction::new()?;
            let branches = plan(self, std::env::current_exe()?.as_os_str());
            let mut report = Vec::new();
            // CLSID is redirected on 64-bit Windows. ProgID branches may be shared between views.
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
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
                for branch in &branches {
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

    pub(crate) fn handle_cli(identifier: &str) {
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        let register = args.iter().any(|a| a == "--register-office-object");
        let unregister = args.iter().any(|a| a == "--unregister-office-object");
        if !register && !unregister {
            return;
        }
        // A packaged GUI process has no console. Reuse its invoking terminal when present.
        unsafe {
            let _ = windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
        let result = OleClass::for_identifier(identifier)
            .map_err(io::Error::other)
            .and_then(|class| {
                if args.len() != 1 {
                    return Err(io::Error::other(
                        "Use one Office registration flag by itself",
                    ));
                }
                if register {
                    class.register(Scope::PerUser)
                } else {
                    class.unregister(Scope::PerUser)
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
}
