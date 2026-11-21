//! Reads the command list out of `lib.rs`'s `generate_handler![...]`, for the tests that check
//! every registered command has its generated permission and only its intended capability grant.
//!
//! The list is bracket-matched, so an attribute inside it (`#[cfg(target_os = "macos")]`) does not
//! end it early, and attributes are dropped from the result. Anything other than one command path
//! per line, an attribute line, a blank line or a `//` comment fails the parse rather than being
//! skipped, so a command can never drop out of these checks unnoticed.

/// Every command registered in `lib_source`'s `generate_handler!`, as written (`module::command`
/// or a bare `command`), in order. Panics if the list cannot be read.
pub(crate) fn registered_commands(lib_source: &str) -> Vec<&str> {
    const OPEN: &str = "generate_handler![";
    let start = lib_source.find(OPEN).expect("generate_handler! invocation") + OPEN.len();
    let body = &lib_source[start..];
    let mut depth = 1usize;
    let mut end = None;
    let mut in_comment = false;
    for (index, character) in body.char_indices() {
        match character {
            '\n' => in_comment = false,
            _ if in_comment => {}
            '/' if body[index..].starts_with("//") => in_comment = true,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(index);
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &body[..end.expect("generate_handler! close")];

    let mut commands = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if line.starts_with("#[") && line.ends_with(']') {
            continue;
        }
        let command = line.strip_suffix(',').unwrap_or(line);
        let is_path = !command.is_empty()
            && command.split("::").all(|part| {
                !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            });
        assert!(
            is_path,
            "unexpected line in generate_handler!: `{line}`; put one command path per line"
        );
        commands.push(command);
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::registered_commands;

    #[test]
    fn reads_past_attributes_and_comments_and_drops_them() {
        let source = "let x = [1];\n.invoke_handler(tauri::generate_handler![\n    first,\n    \
                      #[cfg(target_os = \"macos\")]\n    office::second,\n    // not [a] command\n\n    \
                      #[cfg(all(windows, not(test)))]\n    nested::path::third\n])\nlet y = [2];";
        assert_eq!(
            registered_commands(source),
            ["first", "office::second", "nested::path::third"]
        );
    }

    #[test]
    #[should_panic(expected = "unexpected line")]
    fn refuses_a_line_it_cannot_read() {
        registered_commands("generate_handler![\n    first, second,\n]");
    }

    #[test]
    #[should_panic(expected = "generate_handler! close")]
    fn refuses_an_unclosed_list() {
        registered_commands("generate_handler![\n    first,\n    #[cfg(test)]\n");
    }

    #[test]
    fn reads_the_real_list_including_the_platform_specific_commands() {
        let commands = registered_commands(include_str!("lib.rs"));
        assert!(commands.len() > 100, "{commands:?}");
        for command in [
            "office_addin::office_addin_install",
            "office_addin::office_addin_remove",
            "office_ole::bridge::office_object_connect",
            "first_paint::window_first_paint",
            "fonts::list_system_fonts",
        ] {
            assert!(commands.contains(&command), "{command} missing");
        }
    }
}
