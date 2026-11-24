mod arming;
mod catalog;
mod command_line;
mod consent;
mod dialogs;
pub(crate) mod endpoint;
mod identity;
mod picker;
mod runner;
mod temp_files;
mod wire;

#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows_process;
#[cfg(test)]
mod wire_tests;

pub(crate) use dialogs::{Action as DialogAction, KIND as DIALOG_KIND};
pub(crate) use endpoint::{arm_native_menu, cleanup, State};

fn plugin_id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && !id.ends_with('.')
        && !id.contains("..")
        && !temp_files::reserved_name(id)
        && id
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'.' | b'_' | b'-'))
}
