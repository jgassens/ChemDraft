//! Sign-in is visible user interaction; the launcher is injectable so tests never open a terminal.
use super::{
    catalog::ToolSpec,
    env::{self, ParentEnv},
    probe::ProbePlatform,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
};
#[derive(Debug, Clone)]
pub struct TerminalCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: ParentEnv,
    pub new_console: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SignInMethod {
    #[serde(rename = "terminal.command")]
    TerminalCommand,
    #[serde(rename = "newConsole")]
    NewConsole,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInLaunch {
    pub launched: bool,
    pub method: SignInMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
pub fn spawn_terminal(command: &TerminalCommand) -> io::Result<()> {
    let mut child = Command::new(&command.program);
    child.args(&command.args).env_clear().envs(&command.env);
    #[cfg(windows)]
    if command.new_console {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE;
        child.creation_flags(CREATE_NEW_CONSOLE);
    }
    // Do not block the caller on an interactive login, but reap the terminal launcher eventually.
    let mut child = child.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub fn command_script(spec: &ToolSpec, environment: &ParentEnv) -> String {
    // Terminal.app may already be running and does not inherit /usr/bin/open's environment.
    // Reapply the allowlist in the script itself so shell API keys cannot affect sign-in.
    let mut script = "#!/bin/sh\nexec /usr/bin/env -i".to_owned();
    for (key, value) in environment {
        script.push(' ');
        script.push_str(&shell_quote(&format!("{key}={value}")));
    }
    script.push(' ');
    script.push_str(&shell_quote(&spec.program.to_string_lossy()));
    for arg in spec.login_args {
        script.push(' ');
        script.push_str(&shell_quote(arg));
    }
    script.push('\n');
    script
}
pub fn windows_login_line(spec: &ToolSpec) -> Result<String, String> {
    if spec
        .program
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
    {
        return Err("Sign-in requires a native executable, not a batch shim.".into());
    }
    let path = spec
        .program
        .to_str()
        .ok_or("Sign-in executable path is not Unicode.")?;
    // cmd expands percent and delayed-expansion variables even inside quotes. Refuse those too.
    if path.contains(['"', '&', '|', '%', '!', '^', '<', '>', '\r', '\n', '\0']) {
        return Err("Sign-in executable path contains a Windows command metacharacter.".into());
    }
    Ok(format!(
        "title ChemDraft sign-in && \"{path}\" {}",
        spec.login_args.join(" ")
    ))
}
pub fn launch_sign_in(
    platform: ProbePlatform,
    spec: &ToolSpec,
    temp: &Path,
    parent: &ParentEnv,
    managed: bool,
    spawn: impl FnOnce(&TerminalCommand) -> io::Result<()>,
) -> Result<SignInLaunch, String> {
    super::private_dir(temp).map_err(|e| e.to_string())?;
    // Deliberately use the original parent, never the run's isolated CODEX_HOME: sign-in writes
    // the user's real auth.json. The next probe/run refreshes its link (also after atomic saves).
    let environment = env::child_env(platform, parent, &spec.program, temp, managed);
    let (command, method) = match platform {
        ProbePlatform::MacOS => {
            sweep_stale_scripts(temp).map_err(|e| e.to_string())?;
            let path = temp.join(format!(
                "chemdraft-signin-{}-{}.command",
                spec.tool.as_str(),
                super::nonce()
            ));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o700);
            }
            let mut file = options.open(&path).map_err(|e| e.to_string())?;
            file.write_all(command_script(spec, &environment).as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            (
                TerminalCommand {
                    program: PathBuf::from("/usr/bin/open"),
                    args: vec![path.to_string_lossy().into_owned()],
                    env: environment,
                    new_console: false,
                },
                SignInMethod::TerminalCommand,
            )
        }
        ProbePlatform::Windows => {
            let comspec = env::get(parent, "ComSpec").unwrap_or(r"C:\Windows\System32\cmd.exe");
            (
                TerminalCommand {
                    program: PathBuf::from(comspec),
                    args: vec!["/D".into(), "/K".into(), windows_login_line(spec)?],
                    env: environment,
                    new_console: true,
                },
                SignInMethod::NewConsole,
            )
        }
    };
    spawn(&command).map_err(|e| format!("Could not open the sign-in terminal: {e}"))?;
    Ok(SignInLaunch {
        launched: true,
        method,
        detail: None,
    })
}
pub fn sweep_stale_scripts(temp: &Path) -> io::Result<()> {
    for entry in fs::read_dir(temp)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("chemdraft-signin-")
            && name.ends_with(".command")
            && entry.metadata()?.modified()?.elapsed().unwrap_or_default()
                > std::time::Duration::from_secs(24 * 60 * 60)
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}
