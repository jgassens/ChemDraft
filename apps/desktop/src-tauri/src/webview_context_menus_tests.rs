//! Source guards run on either host: WebView2 itself cannot be exercised by macOS cargo tests.
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::Path,
};

// Read balanced token trees, not lines: indentation and nested functions/impls/closures do not
// change the scan boundary. Comments and literals are opaque. Unknown result flows fail closed;
// this is a source policy guard, with Rust's type checker still responsible for actual types.
#[derive(Debug)]
struct Token {
    text: String,
    children: Vec<Token>,
    line: usize,
    offset: usize,
}

fn tokens(source: &str) -> Vec<Token> {
    fn read(source: &[u8], position: &mut usize, line: &mut usize, close: u8) -> Vec<Token> {
        let mut result = Vec::new();
        while *position < source.len() {
            let start = *position;
            let byte = source[start];
            if byte == close {
                *position += 1;
                break;
            }
            if byte.is_ascii_whitespace() {
                *line += usize::from(byte == b'\n');
                *position += 1;
                continue;
            }
            if source[start..].starts_with(b"//") {
                while *position < source.len() && source[*position] != b'\n' {
                    *position += 1;
                }
                continue;
            }
            if source[start..].starts_with(b"/*") {
                *position += 2;
                let mut depth = 1;
                while depth > 0 && *position < source.len() {
                    if source[*position..].starts_with(b"/*") {
                        depth += 1;
                        *position += 2;
                    } else if source[*position..].starts_with(b"*/") {
                        depth -= 1;
                        *position += 2;
                    } else {
                        *line += usize::from(source[*position] == b'\n');
                        *position += 1;
                    }
                }
                continue;
            }
            let token_line = *line;
            if let Some(end) = match byte {
                b'(' => Some(b')'),
                b'[' => Some(b']'),
                b'{' => Some(b'}'),
                _ => None,
            } {
                *position += 1;
                result.push(Token {
                    text: (byte as char).to_string(),
                    children: read(source, position, line, end),
                    line: token_line,
                    offset: start,
                });
                continue;
            }
            // Raw and byte strings must not expose fixture builders or helper calls as code.
            let raw_start = start + usize::from(byte == b'b');
            let mut quote = raw_start + 1;
            if source.get(raw_start) == Some(&b'r') {
                while source.get(quote) == Some(&b'#') {
                    quote += 1;
                }
            }
            if source.get(raw_start) == Some(&b'r') && source.get(quote) == Some(&b'"') {
                let hashes = quote - raw_start - 1;
                *position = quote + 1;
                while *position < source.len() {
                    if source[*position] == b'"'
                        && source.get(*position + 1..*position + 1 + hashes)
                            == Some(&source[raw_start + 1..quote])
                    {
                        *position += 1 + hashes;
                        break;
                    }
                    *line += usize::from(source[*position] == b'\n');
                    *position += 1;
                }
            } else if byte == b'"'
                || (byte == b'\''
                    && (source.get(start + 2) == Some(&b'\'')
                        || source.get(start + 1) == Some(&b'\\')))
            {
                *position += 1;
                while *position < source.len() {
                    let current = source[*position];
                    *position += 1;
                    *line += usize::from(current == b'\n');
                    if current == b'\\' {
                        *position = (*position + 1).min(source.len());
                    } else if current == byte {
                        break;
                    }
                }
            } else if byte.is_ascii_alphanumeric() || byte == b'_' {
                *position += 1;
                while source
                    .get(*position)
                    .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                {
                    *position += 1;
                }
            } else {
                *position += 1;
            }
            result.push(Token {
                text: String::from_utf8_lossy(&source[start..*position]).into(),
                children: Vec::new(),
                line: token_line,
                offset: start,
            });
        }
        result
    }
    read(source.as_bytes(), &mut 0, &mut 1, 0)
}

fn is(tokens: &[Token], expected: &[&str]) -> bool {
    tokens.len() >= expected.len()
        && tokens
            .iter()
            .zip(expected)
            .all(|(token, text)| token.text == *text)
}

fn constructor(tokens: &[Token]) -> Option<usize> {
    let name = tokens.first()?.text.as_str();
    if !["WebviewWindowBuilder", "WebviewWindow", "WebviewBuilder"].contains(&name)
        || !is(&tokens[1..], &[":", ":"])
    {
        return None;
    }
    let mut method = 3;
    // Also cover explicitly parameterized paths, e.g. WebviewWindow::<R>::builder(...).
    if tokens.get(method)?.text == "<" {
        let mut depth = 0;
        loop {
            match tokens.get(method)?.text.as_str() {
                "<" => depth += 1,
                ">" => depth -= 1,
                _ => {}
            }
            method += 1;
            if depth == 0 {
                break;
            }
        }
        if !is(&tokens[method..], &[":", ":"]) {
            return None;
        }
        method += 2;
    }
    let valid = if name == "WebviewWindow" {
        tokens.get(method)?.text == "builder"
    } else {
        ["new", "from_config"].contains(&tokens.get(method)?.text.as_str())
    };
    (valid && tokens.get(method + 1)?.text == "(").then_some(method + 1)
}

#[derive(Default, Clone)]
struct Value {
    builders: BTreeSet<usize>,
    windows: BTreeSet<usize>,
    // Config selectors, e.g. .find(|config| config.label == "inspector").
    labels: BTreeSet<String>,
}

impl Value {
    fn merge(&mut self, other: Self) {
        self.builders.extend(other.builders);
        self.windows.extend(other.windows);
        self.labels.extend(other.labels);
    }
    fn built(mut self) -> Self {
        self.windows.append(&mut self.builders);
        self
    }
}

struct Site {
    line: usize,
    covered: bool,
    labels: BTreeSet<String>,
}

#[derive(Default)]
struct Guard {
    sites: Vec<Site>,
    ids: HashMap<usize, usize>,
}

type Bindings = HashMap<String, Value>;

impl Guard {
    fn collect(&mut self, tokens: &[Token]) {
        for (index, token) in tokens.iter().enumerate() {
            if constructor(&tokens[index..]).is_some()
                || is(&tokens[index..], &[".", "add_child", "("])
            {
                self.ids.insert(token.offset, self.sites.len());
                self.sites.push(Site {
                    line: token.line,
                    covered: false,
                    labels: BTreeSet::new(),
                });
            }
            self.collect(&token.children);
        }
    }

    fn site(&mut self, token: &Token, labels: BTreeSet<String>) -> Value {
        let id = self.ids[&token.offset];
        self.sites[id].labels.extend(labels);
        Value {
            builders: BTreeSet::from([id]),
            ..Value::default()
        }
    }

    fn arguments(&mut self, tokens: &[Token], bindings: &Bindings) -> Vec<Value> {
        tokens
            .split(|token| token.text == ",")
            .filter(|argument| !argument.is_empty())
            .map(|argument| self.expression(argument, bindings))
            .collect()
    }

    fn expression(&mut self, tokens: &[Token], bindings: &Bindings) -> Value {
        let mut value = Value::default();
        let mut index = 0;
        while index < tokens.len() {
            let rest = &tokens[index..];
            let token = &rest[0];
            if token.text == "fn" {
                if let Some(body) = rest.iter().find(|token| token.text == "{") {
                    // Named functions cannot capture locals, and a parameter with the same name
                    // as an outer window is a different value. Keep constants' label metadata.
                    let mut local = bindings.clone();
                    for value in local.values_mut() {
                        value.builders.clear();
                        value.windows.clear();
                    }
                    self.block(&body.children, local);
                    return Value::default();
                }
            }
            if token.text == "|" {
                if let Some(end) = rest[1..].iter().position(|token| token.text == "|") {
                    let mut local = bindings.clone();
                    for parameter in rest[1..end + 1].split(|token| token.text == ",") {
                        if let Some(name) = parameter
                            .iter()
                            .find(|token| token.text != "mut" && token.text != "&")
                        {
                            local.remove(&name.text);
                        }
                    }
                    self.expression(&rest[end + 2..], &local);
                    return Value::default(); // A closure value is not its returned window.
                }
            }
            if let Some(arguments_index) = constructor(rest) {
                let arguments = &rest[arguments_index].children;
                let values = self.arguments(arguments, bindings);
                let labels = values.get(1).map(|v| v.labels.clone()).unwrap_or_default();
                value = self.site(token, labels);
                index += arguments_index + 1;
                continue;
            }
            if is(rest, &["disable_default_context_menus", "("]) {
                for argument in self.arguments(&rest[1].children, bindings) {
                    for id in argument.windows {
                        self.sites[id].covered = true;
                    }
                }
                value = Value::default();
                index += 2;
                continue;
            }
            if rest.len() >= 3 && token.text == "." && rest[2].text == "(" {
                let arguments = self.arguments(&rest[2].children, bindings);
                match rest[1].text.as_str() {
                    "build" => value = value.built(),
                    "add_child" => {
                        // Even an externally supplied builder creates a webview. A helper on the
                        // parent must never count as configuring the newly added child.
                        value = arguments.into_iter().next().unwrap_or_default();
                        value.merge(self.site(token, BTreeSet::new()));
                        value = value.built();
                    }
                    "find" => value
                        .labels
                        .extend(config_selector_labels(&rest[2].children)),
                    "clone" | "as_ref" | "map_err" | "unwrap" | "expect" => {}
                    _ if !value.builders.is_empty() => {} // Builder modifiers retain the builder.
                    _ => value = Value::default(),
                }
                index += 3;
                continue;
            }
            if token.text == "match" {
                if let Some(body) = rest.iter().position(|t| t.text == "{") {
                    value = self.expression(&rest[1..body], bindings);
                    self.block(&rest[body].children, bindings.clone());
                    index += body + 1;
                    continue;
                }
            }
            if token.text == "{" {
                value = self.block(&token.children, bindings.clone());
            } else if token.text == "(" {
                value = self.expression(&token.children, bindings);
            } else if rest.get(1).is_some_and(|t| t.text == "(") {
                // Only the repo's known builder wrapper carries the result. An arbitrary call
                // might return a different window: inspecting its args must not credit that one.
                value = Value::default();
                for argument in self.arguments(&rest[1].children, bindings) {
                    if token.text == "utility_window_builder" {
                        value.merge(argument);
                    }
                }
                index += 2;
                continue;
            } else if let Some(bound) = bindings.get(&token.text) {
                value = bound.clone();
            } else if let Ok(label) = serde_json::from_str::<String>(&token.text) {
                value.labels.insert(label);
            }
            index += 1;
        }
        value
    }

    fn statement(&mut self, tokens: &[Token], bindings: &mut Bindings) -> Value {
        let start = tokens
            .iter()
            .position(|token| token.text != "#" && token.text != "[")
            .unwrap_or(tokens.len());
        let tokens = &tokens[start..];
        let binding = if is(tokens, &["let", "mut"]) {
            tokens.get(2)
        } else if is(tokens, &["let"]) || is(tokens, &["const"]) {
            tokens.get(1)
        } else if tokens.get(1).is_some_and(|t| t.text == "=") {
            tokens.first()
        } else {
            None
        };
        if let Some(name) = binding {
            if let Some(equal) = tokens.iter().position(|token| token.text == "=") {
                let value = self.expression(&tokens[equal + 1..], bindings);
                bindings.insert(name.text.clone(), value.clone());
                return value;
            }
        }
        self.expression(tokens, bindings)
    }

    fn block(&mut self, tokens: &[Token], mut bindings: Bindings) -> Value {
        let mut start = 0;
        let mut value = Value::default();
        for (index, token) in tokens.iter().enumerate() {
            let prefix = &tokens[start..index];
            let control_block = token.text == "{"
                && (!prefix.iter().any(|token| token.text == "=")
                    || ["if", "while", "for"]
                        .iter()
                        .any(|word| is(prefix, &[*word])));
            if token.text == ";" || control_block {
                let end = index + usize::from(control_block);
                value = self.statement(&tokens[start..end], &mut bindings);
                start = index + 1;
            }
        }
        if start < tokens.len() {
            value = self.statement(&tokens[start..], &mut bindings);
        }
        value
    }

    fn scan(source: &str) -> Self {
        let mut guard = Self::default();
        let tokens = tokens(source);
        // Discovery is independent of flow analysis. Unsupported expressions/macros cannot hide
        // a creation site by taking an expression path the flow walker does not understand.
        guard.collect(&tokens);
        guard.block(&tokens, Bindings::new());
        guard
    }

    fn uncovered(&self) -> Vec<usize> {
        self.sites
            .iter()
            .filter(|site| !site.covered)
            .map(|site| site.line)
            .collect()
    }
}

fn config_selector_labels(tokens: &[Token]) -> BTreeSet<String> {
    tokens
        .windows(4)
        .filter_map(|part| {
            if is(part, &["label", "=", "="]) {
                serde_json::from_str::<String>(&part[3].text).ok()
            } else {
                None
            }
        })
        .collect()
}

fn check_source_tree(directory: &Path) -> Vec<Site> {
    let mut sites = Vec::new();
    for entry in fs::read_dir(directory).expect("read native source directory") {
        let path = entry.expect("native source entry").path();
        if path.is_dir() {
            sites.extend(check_source_tree(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let source = fs::read_to_string(&path).expect("read native source file");
            let guard = Guard::scan(&source);
            assert!(guard.uncovered().is_empty(),
                "{}: creation sites at lines {:?} must apply disable_default_context_menus to their result",
                path.display(), guard.uncovered());
            sites.extend(guard.sites);
        }
    }
    sites
}

// Auto-created config windows bypass Rust builders. Only main has the setup configuration path;
// other declarations must opt out of auto-creation AND have a covered, label-matched code creator.
fn uncovered_config_windows(config: &str, sites: &[Site], main_configured: bool) -> Vec<String> {
    let config: serde_json::Value = serde_json::from_str(config).expect("valid Tauri JSON config");
    config
        .pointer("/app/windows")
        .and_then(|windows| windows.as_array())
        .into_iter()
        .flatten()
        .filter_map(|window| {
            let label = window["label"].as_str().unwrap_or("main");
            let auto_created = window["create"].as_bool().unwrap_or(true);
            let covered = if auto_created {
                label == "main" && main_configured
            } else {
                sites
                    .iter()
                    .any(|site| site.covered && site.labels.contains(label))
            };
            (!covered).then(|| label.to_string())
        })
        .collect()
}

fn function_body<'a>(tokens: &'a [Token], name: &str) -> Option<&'a [Token]> {
    for (index, token) in tokens.iter().enumerate() {
        if is(&tokens[index..], &["fn", name]) {
            return tokens[index + 2..]
                .iter()
                .find(|token| token.text == "{")
                .map(|token| token.children.as_slice());
        }
        if let Some(body) = function_body(&token.children, name) {
            return Some(body);
        }
    }
    None
}

fn contains_call(tokens: &[Token], name: &str, argument: &[&str]) -> bool {
    tokens.iter().enumerate().any(|(index, token)| {
        (is(&tokens[index..], &[name, "("])
            && is(&tokens[index + 1].children, argument)
            && tokens[index + 1].children.len() == argument.len())
            || contains_call(&token.children, name, argument)
    })
}

fn setup_configures_main(tokens: &[Token]) -> bool {
    tokens.iter().enumerate().any(|(index, token)| {
        (is(&tokens[index..], &[".", "setup", "("])
            && contains_call(
                &tokens[index + 2].children,
                "ensure_main_window_visible",
                &["app"],
            ))
            || setup_configures_main(&token.children)
    })
}

fn is_windows_configure_attribute(token: &Token) -> bool {
    if token.text != "[" || !is(&token.children, &["cfg", "("]) {
        return false;
    }
    let cfg = &token.children[1].children;
    is(cfg, &["windows"])
        || (is(cfg, &["not", "("]) && is(&cfg[1].children, &["target_os", "=", "\"macos\""]))
}

fn main_is_configured(source: &str) -> bool {
    let tokens = tokens(source);
    // Inspect both cfg implementations rather than relying on their order in lib.rs.
    let configure = tokens.windows(2).enumerate().any(|(index, part)| {
        is(part, &["fn", "configure_document_webview"])
            && index >= 2
            && tokens[index - 2].text == "#"
            && is_windows_configure_attribute(&tokens[index - 1])
            && tokens[index + 2..]
                .iter()
                .find(|t| t.text == "{")
                .is_some_and(|body| {
                    contains_call(&body.children, "disable_default_context_menus", &["window"])
                })
    });
    let reveal = function_body(&tokens, "ensure_main_window_visible").is_some_and(|body| {
        contains_call(body, "get_webview_window", &["MAIN_WINDOW_LABEL"])
            && contains_call(body, "configure_document_webview", &["&", "window"])
    });
    let setup = setup_configures_main(&tokens);
    let label = tokens.windows(7).any(|part| {
        is(
            part,
            &[
                "const",
                "MAIN_WINDOW_LABEL",
                ":",
                "&",
                "str",
                "=",
                "\"main\"",
            ],
        )
    });
    configure && reveal && setup && label
}

#[test]
fn every_webview_creation_disables_default_context_menus() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sites = check_source_tree(&root.join("src"));
    assert!(sites.len() >= 9, "expected all nine existing builder paths");
    let main_configured = main_is_configured(include_str!("lib.rs"));
    assert!(
        main_configured,
        "setup must configure the resolved main webview"
    );
    let mut configs = 0;
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "tauri.conf.json" || (name.starts_with("tauri.") && name.ends_with(".conf.json"))
        {
            configs += 1;
            let source = fs::read_to_string(&path).unwrap();
            assert!(
                uncovered_config_windows(&source, &sites, main_configured).is_empty(),
                "{}: uncovered config windows {:?}",
                path.display(),
                uncovered_config_windows(&source, &sites, main_configured)
            );
        }
    }
    assert!(configs >= 2, "check base and platform Tauri configs");
}

#[test]
fn guard_follows_each_creation_form_and_its_result() {
    for expression in [
        "WebviewWindowBuilder::new(app, label, url).build()?",
        "WebviewWindowBuilder::from_config(app, config)?.build()?",
        "tauri::WebviewWindow::builder(app, label, url).build()?",
        "tauri::WebviewWindow::<R>::builder(app, label, url).build()?",
        "WebviewWindowBuilder::<R>::new(app, label, url).build()?",
        "parent.add_child(WebviewBuilder::new(label, url), pos, size)?",
        "parent.add_child(WebviewBuilder::from_config(config)?, pos, size)?",
    ] {
        for wrapper in [
            "fn create()",
            "impl Windows { fn create()",
            "fn outer() { let create = ||",
        ] {
            let close = if wrapper == "fn create()" { "}" } else { "} }" };
            let missing = format!("{wrapper} {{\n    let created = {expression};\n{close}");
            let guard = Guard::scan(&missing);
            assert!(!guard.sites.is_empty(), "missed {missing}");
            assert!(!guard.uncovered().is_empty(), "accepted {missing}");
            let wrong = format!("{wrapper} {{ let created = {expression}; disable_default_context_menus(&other); {close}");
            assert!(
                !Guard::scan(&wrong).uncovered().is_empty(),
                "accepted wrong window: {wrong}"
            );
            let covered = format!("{wrapper} {{ let created = {expression}; disable_default_context_menus(&created); {close}");
            assert!(
                Guard::scan(&covered).uncovered().is_empty(),
                "rejected {covered}"
            );
        }
    }
}

#[test]
fn guard_tracks_split_builders_aliases_wrappers_and_inline_results() {
    for source in [
        "fn create() { let builder = WebviewWindowBuilder::new(app, label, url); let builder = builder.title(title); let window = builder.build()?; let alias = window.clone(); disable_default_context_menus(&alias); }",
        "fn create() { let builder = WebviewWindow::builder(app, label, url); let window = match builder.build() { Ok(w) => w, Err(e) => return Err(e) }; disable_default_context_menus(&window); }",
        "fn create() { let builder = WebviewBuilder::new(label, url); let child = parent.add_child(builder, pos, size)?; disable_default_context_menus(&child); }",
        "fn create() { disable_default_context_menus(&WebviewWindow::builder(app, label, url).build()?); }",
        "fn create() { let window = utility_window_builder(WebviewWindowBuilder::new(app, label, url), app).build()?; disable_default_context_menus(&window); }",
    ] {
        let guard = Guard::scan(source);
        assert!(!guard.sites.is_empty());
        assert!(guard.uncovered().is_empty(), "rejected {source}");
    }
}

#[test]
fn guard_does_not_credit_another_window_scope_or_a_builder() {
    for source in [
        "fn first() { let window = WebviewWindowBuilder::new(app, label, url).build()?; } fn second() { disable_default_context_menus(&window); }",
        "impl Windows { fn first() { let w = WebviewWindow::builder(app, label, url).build()?; } fn second() { disable_default_context_menus(&w); } }",
        "fn create() { let first = WebviewWindow::builder(app, a, url).build()?; let second = WebviewWindow::builder(app, b, url).build()?; disable_default_context_menus(&second); }",
        "fn create() { let builder = WebviewWindowBuilder::new(app, label, url); disable_default_context_menus(&builder); let w = builder.build()?; }",
        "fn create() { let child = parent.add_child(builder, pos, size)?; disable_default_context_menus(&parent); }",
        "fn create() { let w = WebviewWindow::builder(app, label, url).build()?; { let w = other; disable_default_context_menus(&w); } }",
        "fn create() { let build = || { let window = WebviewWindow::builder(app, label, url).build()?; }; disable_default_context_menus(&window); }",
        "fn create() { let w = WebviewWindow::builder(app, label, url).build()?; let other = w.get_webview_window(label).unwrap(); disable_default_context_menus(&other); }",
        "fn create() { let w = different_window(WebviewWindow::builder(app, label, url).build()?); disable_default_context_menus(&w); }",
        "fn create() { let windows = vec![WebviewWindow::builder(app, label, url).build()?]; }",
        "fn create() { let w = WebviewWindow::builder(app, label, url).build()?; fn other(w: WebviewWindow) { disable_default_context_menus(&w); } }",
        "fn create() { let w = WebviewWindow::builder(app, label, url).build()?; let other = |w| { disable_default_context_menus(&w); }; }",
    ] {
        assert!(!Guard::scan(source).uncovered().is_empty(), "accepted {source}");
    }
}

#[test]
fn guard_ignores_comments_and_literals() {
    let source = r###"
        // WebviewWindow::builder(app, label, url).build();
        /* nested /* comment */ WebviewBuilder::new(label, url); */
        const FAKE: &str = "WebviewWindowBuilder::new(app, label, url)";
        const RAW: &str = r##"WebviewWindow::builder(app, label, url)"##;
        fn create() {
            let window = WebviewWindow::builder(app, label, url).build()?;
            let fake = "disable_default_context_menus(&window)";
            // disable_default_context_menus(&window);
        }
    "###;
    let guard = Guard::scan(source);
    assert_eq!(guard.sites.len(), 1);
    assert_eq!(guard.uncovered().len(), 1);
}

#[test]
fn config_windows_require_setup_or_a_covered_manual_creator() {
    let source = r#"fn create() {
        let config = app.config().app.windows.iter().find(|config| config.label == "manual").unwrap();
        let window = WebviewWindowBuilder::from_config(app, config)?.build()?;
        disable_default_context_menus(&window);
    }"#;
    let sites = Guard::scan(source).sites;
    let config = r#"{"app":{"windows":[{"label":"main"},{"label":"automatic"},{"label":"manual","create":false},{"label":"forgotten","create":false}]}}"#;
    assert_eq!(
        uncovered_config_windows(config, &sites, true),
        ["automatic", "forgotten"]
    );
    assert_eq!(
        uncovered_config_windows(config, &sites, false),
        ["main", "automatic", "forgotten"]
    );
    assert_eq!(
        uncovered_config_windows(config, &[], true),
        ["automatic", "manual", "forgotten"]
    );
    let missing = Guard::scan(&source.replace("disable_default_context_menus(&window);", ""));
    assert!(uncovered_config_windows(config, &missing.sites, true).contains(&"manual".into()));
    assert!(uncovered_config_windows(r#"{"app":{"windows":[{}]}}"#, &sites, true).is_empty());
    assert!(uncovered_config_windows(r#"{"bundle":{}}"#, &sites, false).is_empty());
    let auto = r#"{"app":{"windows":[{"label":"manual"}]}}"#;
    assert_eq!(uncovered_config_windows(auto, &sites, true), ["manual"]);
    let named = Guard::scan(
        r#"const MAIN_WINDOW_LABEL: &str = "main";
        fn create() { let window = WebviewWindow::builder(app, MAIN_WINDOW_LABEL, url).build()?;
        disable_default_context_menus(&window); }"#,
    );
    assert!(uncovered_config_windows(
        r#"{"app":{"windows":[{"label":"main","create":false}]}}"#,
        &named.sites,
        false
    )
    .is_empty());
}

#[test]
fn main_exemption_requires_the_setup_configuration_chain() {
    let source = include_str!("lib.rs");
    assert!(main_is_configured(source));
    for removed in [
        "ensure_main_window_visible(app)",
        "configure_document_webview(&window)",
        "disable_default_context_menus(window)",
        "get_webview_window(MAIN_WINDOW_LABEL)",
        "const MAIN_WINDOW_LABEL: &str = \"main\"",
        "#[cfg(not(target_os = \"macos\"))]\nfn configure_document_webview",
    ] {
        assert!(
            !main_is_configured(&source.replace(removed, "missing")),
            "credited missing {removed}"
        );
    }
}
