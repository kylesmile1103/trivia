//! Shared helpers for the engine's integration tests: fixtures, formatting variants, node
//! enumeration (through the same `JsxTable` the engine resolves locators with) and readable
//! byte-level diffs.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use oxc_allocator::Allocator;
use oxc_ast::ast::{ImportDeclarationSpecifier, Statement};
use trivia_oxc_engine::locator::JsxTable;
use trivia_oxc_engine::{ImportSpec, Op, Outcome, apply_op, parse};

pub struct Fixture {
    /// Project-relative path, as it appears in locators.
    pub file: String,
    pub src: String,
    /// `<name>` or `<name>[<variant>]`, for failure messages.
    pub label: String,
}

pub fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

pub fn read_fixture(rel: &str) -> String {
    let path = fixture_dir().join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Dashboard, every shadcn component copied from the playground, and the hand-written cases.
pub fn fixtures() -> Vec<Fixture> {
    let mut out = vec![Fixture {
        file: "src/pages/Dashboard.tsx".into(),
        src: read_fixture("Dashboard.tsx"),
        label: "Dashboard".into(),
    }];
    for (dir, prefix) in [("ui", "src/components/ui"), ("hand", "src/hand")] {
        let mut names: Vec<String> = fs::read_dir(fixture_dir().join(dir))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".tsx"))
            .collect();
        names.sort();
        for name in names {
            out.push(Fixture {
                file: format!("{prefix}/{name}"),
                src: read_fixture(&format!("{dir}/{name}")),
                label: format!("{dir}/{name}"),
            });
        }
    }
    out
}

/// Each fixture as written plus CRLF, tab-indented and 4-space-indented copies.
pub fn fixture_variants() -> Vec<Fixture> {
    let mut out = Vec::new();
    for fx in fixtures() {
        let variants = [
            ("crlf", to_crlf(&fx.src)),
            ("tabs", reindent_leading(&fx.src, "\t")),
            ("4sp", reindent_leading(&fx.src, "    ")),
        ];
        for (name, src) in variants {
            out.push(Fixture { file: fx.file.clone(), src, label: format!("{}[{name}]", fx.label) });
        }
        out.push(fx);
    }
    out
}

pub fn to_crlf(src: &str) -> String {
    src.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// Replace every leading two-space indentation step with `unit`.
pub fn reindent_leading(src: &str, unit: &str) -> String {
    src.split_inclusive('\n')
        .map(|line| {
            let spaces = line.len() - line.trim_start_matches(' ').len();
            format!("{}{}{}", unit.repeat(spaces / 2), " ".repeat(spaces % 2), &line[spaces..])
        })
        .collect()
}

pub fn table(src: &str, file: &str) -> JsxTable {
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file).unwrap_or_else(|e| panic!("{file} must parse: {e}\n{src}"));
    JsxTable::build(&program)
}

pub fn loc(t: &JsxTable, idx: usize, file: &str) -> String {
    t.locator(idx, file).to_string()
}

/// Index of the node a locator string resolves to.
pub fn resolve(t: &JsxTable, locator: &str) -> usize {
    t.resolve(&trivia_oxc_engine::Locator::parse(locator).unwrap()).unwrap()
}

/// Locator of the first node named `name` (in source order).
pub fn locator_of(src: &str, file: &str, name: &str) -> String {
    let t = table(src, file);
    let idx = t
        .nodes
        .iter()
        .position(|n| n.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no <{name}> in {file}"));
    loc(&t, idx, file)
}

/// Locator of the `nth` (0-based) node named `name`.
pub fn nth_locator_of(src: &str, file: &str, name: &str, nth: usize) -> String {
    let t = table(src, file);
    let idx = t
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.name.as_deref() == Some(name))
        .nth(nth)
        .unwrap_or_else(|| panic!("no <{name}> #{nth} in {file}"))
        .0;
    loc(&t, idx, file)
}

/// Apply and unwrap, with the op and source in the panic message.
pub fn apply(src: &str, file: &str, op: &Op) -> Outcome {
    apply_op(src, file, op).unwrap_or_else(|e| panic!("{op:?} failed: {e} [{}]\n{src}", e.code()))
}

/// The error code of a failing op (panics when it succeeds).
pub fn error_code(src: &str, file: &str, op: &Op) -> &'static str {
    match apply_op(src, file, op) {
        Ok(out) => panic!("{op:?} should fail but produced:\n{}", out.code),
        Err(e) => e.code(),
    }
}

pub fn spec(name: &str, source: &str) -> ImportSpec {
    ImportSpec { name: name.into(), source: source.into(), default: false }
}

pub fn default_spec(name: &str, source: &str) -> ImportSpec {
    ImportSpec { name: name.into(), source: source.into(), default: true }
}

/// Source of the first value import with named specifiers (`import { A } from "<here>"`).
pub fn first_named_import_source(src: &str, file: &str) -> Option<String> {
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file).unwrap();
    program.body.iter().find_map(|s| match s {
        Statement::ImportDeclaration(d)
            if d.import_kind.is_value()
                && d.specifiers.as_ref().is_some_and(|list| {
                    list.iter().any(|s| matches!(s, ImportDeclarationSpecifier::ImportSpecifier(_)))
                }) =>
        {
            Some(d.source.value.to_string())
        }
        _ => None,
    })
}

/// How the file binds `name` at module level: `None` when it does not, `Some(true)` for an
/// import, `Some(false)` for a declaration in the file.
pub fn root_binding(src: &str, file: &str, name: &str) -> Option<bool> {
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file).unwrap();
    let semantic = oxc_semantic::SemanticBuilder::new().build(&program).semantic;
    let scoping = semantic.scoping();
    let id = scoping.get_root_binding(name.into())?;
    Some(scoping.symbol_flags(id).contains(oxc_syntax::symbol::SymbolFlags::Import))
}

/// Local names of every import specifier in the file.
pub fn import_locals(src: &str, file: &str) -> std::collections::BTreeSet<String> {
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file).unwrap();
    program
        .body
        .iter()
        .filter_map(|s| match s {
            Statement::ImportDeclaration(d) => d.specifiers.as_ref(),
            _ => None,
        })
        .flatten()
        .map(|s| s.name().to_string())
        .collect()
}

/// Panic with the first differing line (escaped, so `\r` and tabs are visible).
#[track_caller]
pub fn assert_text_eq(actual: &str, expected: &str, context: &str) {
    if actual == expected {
        return;
    }
    let at = actual.bytes().zip(expected.bytes()).position(|(a, b)| a != b).unwrap_or(actual.len().min(expected.len()));
    let line = expected[..at.min(expected.len())].matches('\n').count() + 1;
    let show = |s: &str| {
        let start = s[..at.min(s.len())].rfind('\n').map_or(0, |i| i + 1);
        let window: String = s[start..].chars().take(160).collect();
        format!("{window:?}")
    };
    panic!(
        "{context}: texts differ at byte {at} (line {line}); lengths {} vs {}\n  actual:   {}\n  expected: {}\n--- actual ---\n{actual}",
        actual.len(),
        expected.len(),
        show(actual),
        show(expected),
    );
}

/// The line breaks in `code` (an edit of `original`) all match `original`'s: no `\r\r`
/// anywhere; in a CRLF file no bare `\n` or `\r`; in a file without `\r`, none added.
#[track_caller]
pub fn assert_consistent_line_endings(original: &str, code: &str, context: &str) {
    assert!(!code.contains("\r\r"), "{context}: `\\r\\r` in the output:\n{code:?}");
    if original.contains("\r\n") {
        let bytes = code.as_bytes();
        let bare_lf = code.match_indices('\n').find(|(i, _)| *i == 0 || bytes[i - 1] != b'\r');
        let bare_cr = code.match_indices('\r').find(|(i, _)| bytes.get(i + 1) != Some(&b'\n'));
        assert!(
            bare_lf.is_none() && bare_cr.is_none(),
            "{context}: bare LF/CR in a CRLF file at byte {:?}:\n{code:?}",
            bare_lf.or(bare_cr).map(|(i, _)| i)
        );
    } else if !original.contains('\r') {
        assert!(!code.contains('\r'), "{context}: `\\r` written into an LF file:\n{code:?}");
    }
}

/// Counts what a property sweep did, so a vacuous sweep (everything skipped) fails loudly.
#[derive(Default)]
pub struct Tally {
    pub ok: usize,
    pub skipped: BTreeMap<String, usize>,
}

impl Tally {
    pub fn skip(&mut self, reason: impl Into<String>) {
        *self.skipped.entry(reason.into()).or_default() += 1;
    }

    /// Print the tally (visible with `--nocapture`) and require at least `min_ok` checks.
    pub fn finish(&self, what: &str, min_ok: usize) {
        eprintln!("{what}: {} checked", self.ok);
        for (reason, n) in &self.skipped {
            eprintln!("  skipped {n:>5}  {reason}");
        }
        assert!(self.ok >= min_ok, "{what}: only {} checks ran (expected at least {min_ok})", self.ok);
    }
}

/// Leading whitespace of the line containing byte `pos`.
pub fn indent_at(src: &str, pos: usize) -> &str {
    let start = src[..pos].rfind('\n').map_or(0, |i| i + 1);
    let rest = &src[start..];
    &rest[..rest.len() - rest.trim_start_matches([' ', '\t']).len()]
}

pub fn newline_of(src: &str) -> &'static str {
    if src.contains("\r\n") { "\r\n" } else { "\n" }
}
