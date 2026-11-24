use super::{
    temp_files,
    wire::{id, optional, Extension},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Platform {
    Mac,
    Windows,
}

impl Platform {
    pub(super) fn current() -> Result<Self, String> {
        if cfg!(target_os = "macos") {
            Ok(Self::Mac)
        } else if cfg!(windows) {
            Ok(Self::Windows)
        } else {
            Err("App handoff is available on macOS and Windows.".into())
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pipeline {
    pub id: String,
    tool: Tool,
    pub tested_versions: Vec<String>,
    pub steps: Vec<Step>,
    pub combinations: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Tool {
    macos: String,
    windows: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Step {
    pub id: String,
    args: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional"
    )]
    input: Option<StepInput>,
    pub timeout_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StepInput {
    extension: Extension,
}

#[derive(Debug)]
pub(super) struct RenderedStep {
    pub args: Vec<OsString>,
    pub output: Option<PathBuf>,
    pub reads_previous: bool,
}

enum Arg<'a> {
    Literal(&'a str),
    Placeholder(&'a str, &'a str),
}

fn argument(text: &str) -> Result<Arg<'_>, String> {
    if text.contains('\0') {
        return Err("A companion argument contains NUL.".into());
    }
    let Some((prefix, rest)) = text.split_once('{') else {
        return if text.contains('}') {
            Err("Invalid companion placeholder.".into())
        } else {
            Ok(Arg::Literal(text))
        };
    };
    let name = rest
        .strip_suffix('}')
        .ok_or("A companion placeholder must end its argument.")?;
    if name.is_empty()
        || name.contains(['{', '}'])
        || (!prefix.is_empty()
            && !prefix.strip_suffix('=').is_some_and(|key| {
                !key.is_empty()
                    && key
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-' | b'.'))
            }))
    {
        return Err(
            "A companion placeholder needs a whole argument or a fixed key= prefix.".into(),
        );
    }
    Ok(Arg::Placeholder(prefix, name))
}

fn parameter(name: &str) -> bool {
    name.starts_with(|ch: char| ch.is_ascii_alphabetic() || ch == '_')
        && name != "__proto__"
        && name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
}

fn literal_value(value: &str) -> bool {
    value.len() <= 32
        && value.starts_with(|ch: char| ch.is_ascii_alphanumeric() || ch == '_')
        && !value.contains("..")
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'.' | b'+' | b'-'))
}

impl Pipeline {
    pub(super) fn tool_path(&self, platform: Platform) -> Result<PathBuf, String> {
        let (path, separators) = match platform {
            Platform::Mac => (&self.tool.macos, &['/'][..]),
            Platform::Windows => (&self.tool.windows, &['/', '\\'][..]),
        };
        let mut result = PathBuf::new();
        for part in path.split(separators) {
            if part.is_empty()
                || matches!(part, "." | "..")
                || part.chars().any(temp_files::unsafe_name_char)
                || (platform == Platform::Windows
                    && (part.ends_with(['.', ' ']) || temp_files::reserved_name(part)))
            {
                return Err(
                    "A companion tool must use a safe relative path inside the app.".into(),
                );
            }
            result.push(part);
        }
        if platform == Platform::Windows
            && !result
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("exe"))
        {
            return Err("A Windows companion tool must be a native .exe.".into());
        }
        Ok(result)
    }

    pub(super) fn input_extension(&self) -> Option<Extension> {
        self.steps
            .iter()
            .find_map(|step| step.input.as_ref().map(|input| input.extension))
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        self.tool_path(Platform::Mac)?;
        self.tool_path(Platform::Windows)?;
        if !id(&self.id)
            || self.tested_versions.is_empty()
            || self.tested_versions.iter().any(|version| {
                version.is_empty()
                    || version.len() > 80
                    || !version.bytes().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'+' | b'_')
                    })
            })
        {
            return Err("A companion pipeline needs an ID and explicit tested versions.".into());
        }
        if self.steps.first().is_none_or(|step| {
            step.id != "preflight"
                || step.args != ["capabilities", "--json"]
                || step.input.is_some()
        }) {
            return Err(
                "A companion pipeline must begin with preflight capabilities --json.".into(),
            );
        }
        if self
            .steps
            .iter()
            .filter(|step| step.input.is_some())
            .count()
            > 1
            || self.combinations.is_empty()
        {
            return Err(
                "A companion pipeline needs declared combinations and at most one input file."
                    .into(),
            );
        }
        let mut ids = BTreeSet::new();
        let mut time = 0;
        for step in &self.steps {
            if !id(&step.id) || !ids.insert(&step.id) || !(1..=300).contains(&step.timeout_seconds)
            {
                return Err(
                    "A companion step needs a unique ID and a timeout of 1 to 300 seconds.".into(),
                );
            }
            time += step.timeout_seconds;
        }
        if time > 600 {
            return Err("Companion timeouts exceed 600 seconds for the pipeline.".into());
        }
        for (combo, values) in &self.combinations {
            if !id(combo) {
                return Err("Invalid companion combination ID.".into());
            }
            for (name, value) in values {
                if name == "rebuildAs" {
                    if value == combo || !self.combinations.contains_key(value) {
                        return Err("A rebuild must name another declared combination.".into());
                    }
                } else if !parameter(name) || !literal_value(value) {
                    return Err(
                        "A companion parameter must be a safe single value of up to 32 characters."
                            .into(),
                    );
                }
            }
            let mut previous = None;
            let mut previous_id = "";
            for step in &self.steps {
                let rendered = self.render(
                    step,
                    combo,
                    Path::new("handoff"),
                    "cdx_input",
                    previous.as_deref(),
                )?;
                if step.args.first().is_some_and(|arg| arg == "inspect")
                    && (!rendered.reads_previous
                        || previous_id != "build"
                        || step.args.get(1).is_none_or(|arg| arg != "{previousOutput}"))
                {
                    return Err(
                        "Inspect requires the declared file from the preceding build step.".into(),
                    );
                }
                previous = rendered.output;
                previous_id = &step.id;
            }
        }
        Ok(())
    }

    pub(super) fn render(
        &self,
        step: &Step,
        combination: &str,
        directory: &Path,
        stem: &str,
        previous: Option<&Path>,
    ) -> Result<RenderedStep, String> {
        let values = self
            .combinations
            .get(combination)
            .ok_or("Choose a declared companion combination.")?;
        let mut rendered = RenderedStep {
            args: Vec::new(),
            output: None,
            reads_previous: false,
        };
        for text in &step.args {
            let (prefix, name) = match argument(text)? {
                Arg::Literal(literal) => {
                    rendered.args.push(literal.into());
                    continue;
                }
                Arg::Placeholder(prefix, name) => (prefix, name),
            };
            let mut arg = OsString::from(prefix);
            match name {
                "inputDir" | "inputStem" if self.input_extension().is_some() => {
                    if name == "inputDir" {
                        arg.push(directory);
                    } else {
                        arg.push(stem);
                    }
                }
                "previousOutput" => {
                    arg.push(
                        previous.ok_or(
                            "The preceding companion step did not declare an output file.",
                        )?,
                    );
                    rendered.reads_previous = true;
                }
                _ if name.starts_with("outputFile:") => {
                    let ext: Extension = serde_json::from_value(name["outputFile:".len()..].into())
                        .map_err(|_| "A companion output extension is not allowed.")?;
                    let path = directory.join(format!("output-{}.{}", step.id, ext.as_str()));
                    if rendered.output.as_ref().is_some_and(|old| old != &path) {
                        return Err("A companion step can declare only one output file.".into());
                    }
                    arg.push(&path);
                    rendered.output = Some(path);
                }
                _ if name.starts_with("combination.") => {
                    let key = &name["combination.".len()..];
                    let value = values
                        .get(key)
                        .filter(|value| {
                            key != "rebuildAs" && parameter(key) && literal_value(value)
                        })
                        .ok_or(
                            "The companion placeholder needs a declared, safe combination value.",
                        )?;
                    arg.push(value);
                }
                _ => {
                    return Err(
                        "An app companion argument contains an undeclared placeholder.".into(),
                    )
                }
            }
            rendered.args.push(arg);
        }
        Ok(rendered)
    }

    pub(super) fn digest(&self) -> String {
        let mut canonical = serde_json::to_value(self).expect("serializable pipeline");
        canonical.sort_all_objects();
        format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()))
    }

    pub(super) fn describe(&self, platform: Platform) -> Result<String, String> {
        let path = self.tool_path(platform)?;
        let tool = path
            .file_name()
            .ok_or("The companion tool is missing.")?
            .to_string_lossy();
        Ok(self
            .steps
            .iter()
            .map(|step| format!("{tool} {}", step.args.join(" ")))
            .collect::<Vec<_>>()
            .join("\n"))
    }
}

pub(super) fn open_command(
    platform: Platform,
    app: &Path,
    executable: &Path,
    file: &Path,
) -> (PathBuf, Vec<OsString>) {
    match platform {
        Platform::Mac => (
            PathBuf::from("/usr/bin/open"),
            vec!["-a".into(), app.into(), "--".into(), file.into()],
        ),
        Platform::Windows => (executable.to_owned(), vec![file.into()]),
    }
}
