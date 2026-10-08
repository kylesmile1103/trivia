//! Import bookkeeping for inserted and removed components.
//!
//! Imports are derived from references, and only for names the op touched: an insert adds
//! (or merges) the specifiers its snippet needs; a remove drops a specifier only when the
//! removed subtree held that name's last reference. Unrelated unused imports are never pruned.
//!
//! Style follows the file: new specifiers go into an existing value import from the same
//! module, however the file spells it ([`same_module`]), alphabetically when its list is
//! sorted (case-insensitively or not, else appended;
//! one per line in multi-line lists, keeping trailing commas). New declarations copy the last
//! import's quotes and semicolon and go on their own line after it.

use std::collections::{BTreeMap, BTreeSet};

use oxc_allocator::Allocator;
use oxc_ast::Comment;
use oxc_ast::ast::{
    Declaration, ExportDefaultDeclarationKind, ImportDeclaration, ImportDeclarationSpecifier, JSXAttributeValue,
    Program, Statement, StringLiteral,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, Result};
use crate::text::{self, Edit};
use crate::{ops, parse};

/// `import { name } from "source"`, or `import name from "source"` when `default`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSpec {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub default: bool,
}

impl ImportSpec {
    /// The declaration this spec asks for, as source text (for messages).
    pub(crate) fn declaration(&self) -> String {
        if self.default {
            format!("import {} from \"{}\"", self.name, self.source)
        } else {
            format!("import {{ {} }} from \"{}\"", self.name, self.source)
        }
    }
}

/// Refuse malformed specs and specs that contradict each other (one name, two imports).
pub(crate) fn validate_specs(specs: &[ImportSpec]) -> Result<()> {
    for (i, spec) in specs.iter().enumerate() {
        if !is_identifier(&spec.name) || spec.source.is_empty() {
            return Err(EngineError::InvalidOp(format!("invalid import {{ {} }} from `{}`", spec.name, spec.source)));
        }
        if let Some(other) = specs[..i].iter().find(|s| s.name == spec.name && *s != spec) {
            return Err(EngineError::InvalidOp(format!(
                "conflicting imports for `{}`: from `{}` and from `{}`",
                spec.name, other.source, spec.source
            )));
        }
    }
    Ok(())
}

/// Whether the module specifiers `a` and `b`, both written in the file at `importer` (its
/// project-relative path, as in locators), name the same module.
///
/// No module is resolved and nothing is read from disk: two specifiers are the same module
/// when they are equal, or when both name a path inside the project and the paths match
/// after normalization (see [`module_path`]): `../components/ui/button` written in
/// `src/pages/Page.tsx`, `@/components/ui/button.tsx` and `./components/ui/button/index`
/// written in `src/App.tsx` all name `src/components/ui/button`. Bare package specifiers
/// (`@mui/material`, `react`) match only when they are spelled exactly the same.
pub fn same_module(importer: &str, a: &str, b: &str) -> bool {
    a == b || module_path(importer, a).is_some_and(|path| module_path(importer, b) == Some(path))
}

/// The extensions an import may name its module by (TypeScript resolves `./x.js` to `x.ts`).
const MODULE_EXTENSIONS: [&str; 5] = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

/// The project path a specifier written in the file at `importer` names, without its
/// extension or a trailing `/index`: a relative specifier (`./`, `../`, `.`, `..`) resolved
/// against the importing file's directory, or `@/…` and `~/…`, which name `src/…`. That alias
/// is the convention of shadcn's `components.json` (`"@/components"` with tsconfig paths
/// `"@/*": ["./src/*"]`); a project that maps it elsewhere can only lose reuse (its other
/// spellings are refused as different modules), never get a wrong match against a real
/// `src/` path. `None` for bare specifiers (packages, `src/…` via `baseUrl`, absolute paths)
/// and for paths that climb out of the project.
fn module_path(importer: &str, source: &str) -> Option<String> {
    let (mut path, rest) = if let Some(rest) = source.strip_prefix("@/").or_else(|| source.strip_prefix("~/")) {
        (vec!["src"], rest)
    } else if matches!(source, "." | "..") || source.starts_with("./") || source.starts_with("../") {
        let mut dir = Vec::new();
        push_segments(&mut dir, importer)?;
        dir.pop(); // the importing file itself
        (dir, source)
    } else {
        return None;
    };
    push_segments(&mut path, rest)?;
    if let Some(last) = path.last_mut()
        && let Some(stem) = MODULE_EXTENSIONS.iter().find_map(|ext| last.strip_suffix(ext)).filter(|s| !s.is_empty())
    {
        *last = stem;
    }
    if path.last() == Some(&"index") {
        path.pop();
    }
    Some(path.join("/"))
}

/// Append the `/`-separated segments of `path` to `out`, applying `.` and `..` (and skipping
/// empty segments). `None` when a `..` would climb above the start.
fn push_segments<'s>(out: &mut Vec<&'s str>, path: &'s str) -> Option<()> {
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            segment => out.push(segment),
        }
    }
    Some(())
}

/// Edits that make every name in `needed` resolvable, using `specs` for the missing ones.
/// `file` is the project-relative path of the file `src` is (relative import specifiers are
/// read against it).
///
/// A spec whose name is already bound at module level adds nothing, but only when that
/// binding is the import the spec asks for (a value import of the same name, or the default
/// export, from the same module — however that module is spelled, see [`same_module`]):
/// otherwise the code would silently use some other component (`import { Button } from
/// "@mui/material"`, a local `function Button`), so it is refused (`unsupported`). A name
/// bound only as a type (`import type { X }`, `type X = …`) cannot be rendered or passed as a
/// value, and the engine will not rewrite that declaration, so it is refused.
///
/// Missing specifiers join the file's value import of the same module (keeping the file's
/// spelling of it), or a new declaration per module.
pub fn ensure_imports(
    src: &str,
    file: &str,
    program: &Program<'_>,
    specs: &[ImportSpec],
    needed: &[String],
) -> Result<Vec<Edit>> {
    validate_specs(specs)?;
    let semantic = SemanticBuilder::new().build(program).semantic;
    let scoping = semantic.scoping();
    let bound = |name: &str| scoping.get_root_binding(name.into()).is_some();

    let names = needed.iter().map(String::as_str).chain(specs.iter().map(|s| s.name.as_str()));
    for name in names {
        if let Some(id) = scoping.get_root_binding(name.into())
            && !scoping.symbol_flags(id).is_value()
        {
            return Err(EngineError::Unsupported(format!(
                "`{name}` is only a type in this file (`import type` or a type declaration), so it cannot be \
                 used as a value; import it as a value first"
            )));
        }
    }
    for name in needed {
        if !bound(name) && !specs.iter().any(|s| &s.name == name) {
            return Err(EngineError::UnresolvedComponent(name.clone()));
        }
    }

    let imports: Vec<&ImportDeclaration<'_>> = program
        .body
        .iter()
        .filter_map(|s| match s {
            Statement::ImportDeclaration(d) => Some(&**d),
            _ => None,
        })
        .collect();

    for spec in specs {
        if let Some(id) = scoping.get_root_binding(spec.name.as_str().into()) {
            let line = text::line_col(src, scoping.symbol_span(id).start).0;
            check_bound_as(file, &imports, spec, line)?;
        }
    }

    // Group the specifiers that are actually missing by module, keeping first-seen order
    // (and the first spelling).
    let mut groups: Vec<Group<'_>> = Vec::new();
    let mut seen = BTreeSet::new();
    for spec in specs.iter().filter(|s| !bound(&s.name)) {
        if !seen.insert(spec.name.as_str()) {
            continue;
        }
        let index = match groups.iter().position(|g| same_module(file, g.source, &spec.source)) {
            Some(i) => i,
            None => {
                groups.push(Group { source: &spec.source, default: None, named: Vec::new() });
                groups.len() - 1
            }
        };
        let group = &mut groups[index];
        if spec.default {
            if let Some(other) = group.default {
                return Err(EngineError::InvalidOp(format!(
                    "two default imports from `{}`: `{other}` and `{}`",
                    spec.source, spec.name
                )));
            }
            group.default = Some(&spec.name);
        } else {
            group.named.push(&spec.name);
        }
    }

    let mut edits = Vec::new();
    let mut new_decls: Vec<Group<'_>> = Vec::new();
    for group in groups {
        // The declaration spelled exactly like the spec first, else any of the same module.
        let values = || imports.iter().filter(|d| d.import_kind.is_value());
        let target = values()
            .find(|d| d.source.value.as_str() == group.source)
            .or_else(|| values().find(|d| same_module(file, d.source.value.as_str(), group.source)));
        let Some(decl) = target else {
            new_decls.push(group);
            continue;
        };
        let mut left = Group { source: group.source, default: None, named: Vec::new() };
        if !group.named.is_empty() {
            match merge_named(src, &program.comments, decl, &group.named) {
                Some(merge) => edits.extend(merge),
                None => left.named = group.named,
            }
        }
        if let Some(name) = group.default {
            match merge_default(src, decl, name) {
                Some(edit) => edits.push(edit),
                None => left.default = Some(name),
            }
        }
        if left.default.is_some() || !left.named.is_empty() {
            new_decls.push(left);
        }
    }

    if !new_decls.is_empty() {
        edits.push(new_declarations(src, program, &imports, &new_decls));
    }
    Ok(edits)
}

/// Accept a spec whose name the file at `file` already binds (declared on `line`) only when
/// that binding is the declaration the spec asks for.
fn check_bound_as(file: &str, imports: &[&ImportDeclaration<'_>], spec: &ImportSpec, line: u32) -> Result<()> {
    let name = spec.name.as_str();
    let found = imports.iter().find_map(|decl| {
        decl.specifiers.iter().flatten().find(|s| s.name().as_str() == name).map(|s| (decl, s))
    });
    let Some((decl, specifier)) = found else {
        return Err(EngineError::Unsupported(format!(
            "`{name}` is already declared in this file (line {line}), so `{}` cannot be added; rename that \
             declaration first",
            spec.declaration()
        )));
    };
    let source = decl.source.value.as_str();
    let (matches, existing) = match specifier {
        ImportDeclarationSpecifier::ImportSpecifier(s) => {
            let imported = s.imported.name();
            let imported = imported.as_str();
            let wanted = if spec.default { "default" } else { name };
            let clause = if imported == name { name.to_string() } else { format!("{imported} as {name}") };
            (imported == wanted && s.import_kind.is_value(), format!("import {{ {clause} }} from \"{source}\""))
        }
        ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
            (spec.default, format!("import {name} from \"{source}\""))
        }
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
            (false, format!("import * as {name} from \"{source}\""))
        }
    };
    if matches && same_module(file, source, &spec.source) && decl.import_kind.is_value() {
        return Ok(());
    }
    Err(EngineError::Unsupported(format!(
        "`{name}` is already bound in this file by `{existing}` (line {line}), not by `{}`, so the new element \
         would use that binding instead; rename or remove it first (if it is the same component, insert \
         without an import for `{name}`)",
        spec.declaration()
    )))
}

/// [`text::line_content_end`] of the line holding `pos`, but past any comment that starts on
/// that line and ends on a later one: text appended to `import { A } from "a" /* the a\n
/// component */` goes after the comment, never into it.
fn line_end_past_comments(src: &str, comments: &[Comment], pos: u32) -> u32 {
    let mut at = text::line_content_end(src, pos);
    while let Some(comment) = comments.iter().find(|c| c.span.start >= pos && c.span.start < at && c.span.end > at) {
        at = text::line_content_end(src, comment.span.end);
    }
    at
}

/// Missing specifiers from one module.
struct Group<'s> {
    source: &'s str,
    default: Option<&'s str>,
    named: Vec<&'s str>,
}

/// `import { A } from "x"` → `import D, { A } from "x"` (also before `* as NS`). `None` when
/// the declaration already has a default import or has no specifier list to extend.
fn merge_default(src: &str, decl: &ImportDeclaration<'_>, name: &str) -> Option<Edit> {
    let specifiers = decl.specifiers.as_ref()?;
    let at = match specifiers.first()? {
        ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => return None,
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => s.span.start,
        ImportDeclarationSpecifier::ImportSpecifier(s) => {
            decl.span.start + src[decl.span.start as usize..s.span.start as usize].rfind('{')? as u32
        }
    };
    Some(Edit::insert(at, format!("{name}, ")))
}

/// Add named specifiers to an existing declaration. `None` when the declaration's shape
/// (side-effect, namespace, empty braces) makes a separate declaration cleaner.
fn merge_named(src: &str, comments: &[Comment], decl: &ImportDeclaration<'_>, names: &[&str]) -> Option<Vec<Edit>> {
    let specifiers = decl.specifiers.as_ref()?;
    let mut named: Vec<(String, Span)> = Vec::new();
    let mut default_span = None;
    for s in specifiers {
        match s {
            ImportDeclarationSpecifier::ImportSpecifier(s) => named.push((s.imported.name().to_string(), s.span)),
            ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => default_span = Some(s.span),
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => return None,
        }
    }
    if named.is_empty() {
        let default_span = default_span?;
        return Some(vec![Edit::insert(default_span.end, format!(", {{ {} }}", names.join(", ")))]);
    }

    let nl = text::newline(src);
    let multiline = text::starts_line(src, named[0].1.start);
    let order = SortOrder::of(named.iter().map(|(n, _)| n.as_str()));
    let mut sorted_names: Vec<&str> = names.to_vec();
    sorted_names.sort_by(|a, b| order.unwrap_or(SortOrder::CaseSensitive).cmp(a, b));

    // Bucket new names by the existing specifier they go before (`len` = append).
    let mut buckets: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
    for name in sorted_names {
        let pos = match order {
            Some(order) => named.iter().position(|(n, _)| order.cmp(n, name).is_gt()).unwrap_or(named.len()),
            None => named.len(),
        };
        buckets.entry(pos).or_default().push(name);
    }
    let mut edits = Vec::new();
    for (pos, names) in buckets {
        if pos < named.len() {
            let at = named[pos].1.start;
            let sep = if multiline { format!(",{nl}{}", text::line_indent(src, at)) } else { ", ".to_string() };
            edits.push(Edit::insert(at, names.iter().map(|n| format!("{n}{sep}")).collect::<String>()));
            continue;
        }
        let last = named[named.len() - 1].1;
        let indent = text::line_indent(src, last.start);
        let after = &src[last.end as usize..];
        let closes_on_same_line = after.find('}').is_some_and(|p| !after[..p].contains('\n'));
        if multiline && !closes_on_same_line {
            // One per line, after the line of the last specifier (and its trailing comment).
            let line_end = line_end_past_comments(src, comments, last.end);
            if after.trim_start_matches([' ', '\t']).starts_with(',') {
                edits.push(Edit::insert(line_end, names.iter().map(|n| format!("{nl}{indent}{n},")).collect::<String>()));
            } else {
                edits.push(Edit::insert(last.end, ","));
                let lines: Vec<String> = names.iter().map(|n| format!("{nl}{indent}{n}")).collect();
                edits.push(Edit::insert(line_end, lines.join(",")));
            }
        } else {
            let sep = if multiline { format!(",{nl}{indent}") } else { ", ".to_string() };
            edits.push(Edit::insert(last.end, names.iter().map(|n| format!("{sep}{n}")).collect::<String>()));
        }
    }
    Some(edits)
}

/// How an existing specifier list is sorted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SortOrder {
    /// `cva, VariantProps` (TypeScript's organize-imports, Biome, …).
    CaseInsensitive,
    /// `Button, buttonVariants` by code point.
    CaseSensitive,
}

impl SortOrder {
    /// The order `names` follow, preferring case-insensitive when both fit; `None` if unsorted.
    fn of<'n>(names: impl Iterator<Item = &'n str> + Clone) -> Option<Self> {
        let names: Vec<&str> = names.collect();
        [Self::CaseInsensitive, Self::CaseSensitive]
            .into_iter()
            .find(|order| names.windows(2).all(|w| !order.cmp(w[0], w[1]).is_gt()))
    }

    fn cmp(self, a: &str, b: &str) -> std::cmp::Ordering {
        match self {
            Self::CaseInsensitive => a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)),
            Self::CaseSensitive => a.cmp(b),
        }
    }
}

/// One edit inserting new declarations after the last import (or before the first statement).
fn new_declarations(src: &str, program: &Program<'_>, imports: &[&ImportDeclaration<'_>], decls: &[Group<'_>]) -> Edit {
    let nl = text::newline(src);
    let (quote, semi) = match imports.last() {
        Some(last) => {
            let q = src.as_bytes()[last.source.span.start as usize] as char;
            (q, src[..last.span.end as usize].ends_with(';'))
        }
        None => (first_quote(src, program).unwrap_or('"'), uses_semicolons(src, program)),
    };
    let semi = if semi { ";" } else { "" };
    let lines: Vec<String> = decls
        .iter()
        .map(|group| {
            let mut clause = Vec::new();
            if let Some(d) = group.default {
                clause.push(d.to_string());
            }
            if !group.named.is_empty() {
                clause.push(format!("{{ {} }}", group.named.join(", ")));
            }
            format!("import {} from {quote}{}{quote}{semi}", clause.join(", "), group.source)
        })
        .collect();
    match imports.last() {
        // After the last import's line (before its terminator, so CRLF pairs stay intact and a
        // trailing comment stays where it was).
        Some(last) => Edit::insert(
            line_end_past_comments(src, &program.comments, last.span.end),
            format!("{nl}{}", lines.join(nl)),
        ),
        None => {
            let at = program.body.first().map_or_else(
                || program.directives.last().map_or(0, |d| line_end_past_comments(src, &program.comments, d.span.end)),
                |s| leading_comments_start(src, program, s.span().start),
            );
            let after = if program.body.is_empty() { "" } else { &format!("{nl}{nl}") as &str };
            let before = if at > 0 && program.body.is_empty() { format!("{nl}{nl}") } else { String::new() };
            Edit::insert(at, format!("{before}{}{after}", lines.join(nl)))
        }
    }
}

/// Start of the comment lines directly above `pos` (no blank line between), so imports
/// inserted there do not separate a statement from its doc comment. A file header that is
/// followed by a blank line is not attached and stays above the imports, and so does a tool
/// directive (`// @ts-nocheck`, `/* eslint-disable */`, `/** @jsxImportSource x */`, …):
/// several of those only work in the file's leading comments.
fn leading_comments_start(src: &str, program: &Program<'_>, pos: u32) -> u32 {
    const DIRECTIVES: [&str; 9] =
        ["@ts-", "eslint", "@jsx", "@flow", "prettier-ignore", "biome-ignore", "oxlint", "@license", "@vitest-"];
    let mut at = pos;
    for comment in program.comments.iter().rev().filter(|c| c.span.end <= pos) {
        let gap = &src[comment.span.end as usize..at as usize];
        let body = &src[comment.span.start as usize..comment.span.end as usize];
        if !gap.trim().is_empty()
            || gap.matches('\n').count() > 1
            || !text::starts_line(src, comment.span.start)
            || DIRECTIVES.iter().any(|d| body.contains(d))
        {
            break;
        }
        at = comment.span.start;
    }
    at
}

/// The quote of the file's first directive or (non-JSX) string literal.
fn first_quote(src: &str, program: &Program<'_>) -> Option<char> {
    struct First(Option<Span>);
    impl<'a> Visit<'a> for First {
        fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
            self.0.get_or_insert(it.span);
        }
        fn visit_jsx_attribute_value(&mut self, it: &JSXAttributeValue<'a>) {
            // JSX attribute quotes are a separate style (`jsxSingleQuote`).
            if !matches!(it, JSXAttributeValue::StringLiteral(_)) {
                walk::walk_jsx_attribute_value(self, it);
            }
        }
    }
    let span = match program.directives.first() {
        Some(d) => d.span,
        None => {
            let mut first = First(None);
            first.visit_program(program);
            first.0?
        }
    };
    match src.as_bytes()[span.start as usize] {
        b'\'' => Some('\''),
        b'"' => Some('"'),
        _ => None,
    }
}

/// Whether most top-level statements that can end with `;` do (directives, variable and
/// type-alias declarations, expression statements, `export { … }`, `export default <expr>`).
fn uses_semicolons(src: &str, program: &Program<'_>) -> bool {
    let terminable = |s: &&Statement<'_>| match s {
        Statement::VariableDeclaration(_)
        | Statement::ExpressionStatement(_)
        | Statement::TSTypeAliasDeclaration(_)
        | Statement::ExportNamedDeclaration(_)
        | Statement::ExportFromDeclaration(_)
        | Statement::ExportAllDeclaration(_) => true,
        Statement::ExportDeclaration(e) => {
            matches!(e.declaration, Declaration::VariableDeclaration(_) | Declaration::TSTypeAliasDeclaration(_))
        }
        Statement::ExportDefaultDeclaration(e) => !matches!(
            e.declaration,
            ExportDefaultDeclarationKind::FunctionDeclaration(_)
                | ExportDefaultDeclarationKind::ClassDeclaration(_)
                | ExportDefaultDeclarationKind::TSInterfaceDeclaration(_)
        ),
        _ => false,
    };
    let spans = program.directives.iter().map(|d| d.span).chain(program.body.iter().filter(terminable).map(GetSpan::span));
    let (mut with, mut without) = (0usize, 0usize);
    for span in spans {
        if src[..span.end as usize].ends_with(';') {
            with += 1;
        } else {
            without += 1;
        }
    }
    with > without
}

/// Resolved reference count of every import binding, by local name.
pub fn import_reference_counts(program: &Program<'_>) -> BTreeMap<String, usize> {
    let semantic = SemanticBuilder::new().build(program).semantic;
    let scoping = semantic.scoping();
    let mut out = BTreeMap::new();
    for spec in import_specifiers(program) {
        let local = spec.name();
        if let Some(id) = scoping.get_root_binding(local) {
            out.insert(local.to_string(), scoping.get_resolved_reference_ids(id).len());
        }
    }
    out
}

fn import_specifiers<'p, 'a>(program: &'p Program<'a>) -> impl Iterator<Item = &'p ImportDeclarationSpecifier<'a>> {
    program.body.iter().filter_map(|s| match s {
        Statement::ImportDeclaration(d) => d.specifiers.as_ref(),
        _ => None,
    }).flatten()
}

/// After an edit, drop the import specifiers that lost their last reference: names that had
/// references `before` (see [`import_reference_counts`]) and have none in `code`. Imports
/// that were already unused before the edit are not touched.
pub fn prune_dropped(code: &str, file: &str, before: &BTreeMap<String, usize>) -> Result<String> {
    let names: BTreeSet<String> = before.iter().filter(|(_, n)| **n > 0).map(|(name, _)| name.clone()).collect();
    prune_unused(code, file, &names)
}

/// Drop import specifiers for `names` that no longer have any reference in `code`.
pub fn prune_unused(code: &str, file: &str, names: &BTreeSet<String>) -> Result<String> {
    if names.is_empty() {
        return Ok(code.to_string());
    }
    let alloc = Allocator::default();
    let program = parse(&alloc, code, file).map_err(|e| EngineError::InvalidResult(e.to_string()))?;
    let semantic = SemanticBuilder::new().build(&program).semantic;
    let scoping = semantic.scoping();
    let unused = |local: &str| {
        names.contains(local)
            && scoping
                .get_root_binding(local.into())
                .is_some_and(|id| scoping.get_resolved_reference_ids(id).is_empty())
    };

    let decls: Vec<&ImportDeclaration<'_>> = program
        .body
        .iter()
        .filter_map(|s| match s {
            Statement::ImportDeclaration(d) => Some(&**d),
            _ => None,
        })
        .collect();
    let mut plans: Vec<(&ImportDeclaration<'_>, Vec<Spec>, Vec<bool>)> = Vec::new();
    for decl in &decls {
        let Some(specifiers) = &decl.specifiers else { continue };
        let specs: Vec<Spec> = specifiers
            .iter()
            .map(|s| Spec {
                span: s.span(),
                kind: match s {
                    ImportDeclarationSpecifier::ImportSpecifier(_) => SpecKind::Named,
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => SpecKind::Default,
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => SpecKind::Namespace,
                },
            })
            .collect();
        let remove: Vec<bool> = specifiers.iter().map(|s| unused(s.name().as_str())).collect();
        if remove.iter().any(|&r| r) {
            plans.push((decl, specs, remove));
        }
    }
    let whole = plans.iter().filter(|(_, _, remove)| remove.iter().all(|&r| r)).count();
    let none_left = whole == decls.len();

    let mut edits = Vec::new();
    for (decl, specs, remove) in &plans {
        if remove.iter().all(|&r| r) {
            let (start, end) = declaration_removal(code, decl.span, none_left);
            edits.push(Edit::delete(start, end));
        } else {
            edits.extend(specifier_removals(code, specs, remove));
        }
    }
    if edits.is_empty() {
        return Ok(code.to_string());
    }
    Ok(text::apply_edits(code, &edits)?.0)
}

/// The range deleting a whole import declaration. When it leaves two blank lines in a row,
/// or a blank line where no imports remain (`none_left`), the blank line after it goes too,
/// so pruning the import an insert added restores the file it was added to.
fn declaration_removal(code: &str, span: Span, none_left: bool) -> (u32, u32) {
    let (start, mut end) = ops::removal_range(code, span);
    let whole_lines = end as usize == code.len() || code[..end as usize].ends_with('\n');
    if whole_lines {
        let before = &code[..start as usize];
        let preceded_by_blank = start == 0 || before.ends_with("\n\n") || before.ends_with("\r\n\r\n");
        let rest = &code[end as usize..];
        let blank_after = if rest.starts_with("\r\n") { 2 } else if rest.starts_with('\n') { 1 } else { 0 };
        if blank_after > 0 && (none_left || preceded_by_blank) {
            end += blank_after;
        }
    }
    (start, end)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpecKind {
    Named,
    Default,
    Namespace,
}

#[derive(Debug, Clone, Copy)]
struct Spec {
    span: Span,
    kind: SpecKind,
}

/// Deletions for a subset of a declaration's specifiers (at least one kept), merging runs
/// of adjacent named specifiers so ranges never overlap.
fn specifier_removals(code: &str, specs: &[Spec], remove: &[bool]) -> Vec<Edit> {
    let named: Vec<usize> = (0..specs.len()).filter(|&i| specs[i].kind == SpecKind::Named).collect();
    let head = specs.iter().position(|s| s.kind == SpecKind::Default);
    let mut edits = Vec::new();

    // `import D, { A } from` / `import D, * as NS from`: the default comes first.
    if let Some(d) = head.filter(|&d| remove[d])
        && let Some(next) = specs.get(d + 1)
    {
        // Up to the `{` of the named list, or the `*` of the namespace import.
        let between = &code[specs[d].span.end as usize..next.span.start as usize];
        let cut = specs[d].span.end + between.find('{').unwrap_or(between.len()) as u32;
        edits.push(Edit::delete(specs[d].span.start, cut));
    }
    if let Some(ns) = specs.iter().position(|s| s.kind == SpecKind::Namespace).filter(|&n| remove[n])
        && let Some(d) = head
    {
        // `import D, * as NS from` → `import D from`.
        edits.push(Edit::delete(specs[d].span.end, specs[ns].span.end));
    }

    let mut k = 0;
    while k < named.len() {
        if !remove[named[k]] {
            k += 1;
            continue;
        }
        let run_start = k;
        while k < named.len() && remove[named[k]] {
            k += 1;
        }
        let (first, last) = (specs[named[run_start]].span, specs[named[k - 1]].span);
        let prev = run_start.checked_sub(1).map(|p| specs[named[p]].span);
        let next = named.get(k).map(|&i| specs[i].span);
        let (start, end) = match (prev, next) {
            (None, None) => {
                // Every named specifier goes but a default stays: drop `, { … }`.
                let keep_end = head.map_or(first.start, |d| specs[d].span.end);
                let close = code[last.end as usize..].find('}').map_or(last.end, |p| last.end + p as u32 + 1);
                (keep_end, close)
            }
            _ => run_removal(code, first, last, prev, next),
        };
        edits.push(Edit::delete(start, end));
    }
    edits
}

/// The range removing the named specifiers `first..=last` together with one separating
/// comma, keeping the list's layout (`  Switch,` lines go whole) and never deleting a comment:
/// `  Beta, // why` leaves `  // why`; `{ A, /* a */ B }` without `B` is `{ A, /* a */ }`.
fn run_removal(code: &str, first: Span, last: Span, prev: Option<Span>, next: Option<Span>) -> (u32, u32) {
    let only_commas_and_space = |a: u32, b: u32| code[a as usize..b as usize].chars().all(|c| c.is_whitespace() || c == ',');
    let after = &code[last.end as usize..];
    let comma_end = after
        .trim_start_matches([' ', '\t'])
        .strip_prefix(',')
        .map(|rest| last.end + (after.len() - rest.len()) as u32);
    let run_end = comma_end.unwrap_or(last.end);
    let own_lines = text::starts_line(code, first.start) && text::ends_line(code, run_end);
    let whole_lines = || (text::line_start(code, first.start), (text::line_end(code, run_end) + 1).min(code.len() as u32));
    match next {
        Some(_) if own_lines => whole_lines(),
        Some(next) if only_commas_and_space(last.end, next.start) => (first.start, next.start),
        // A comment follows the comma: keep it, drop only the specifiers and the comma.
        Some(_) => (first.start, text::skip_spaces(code, run_end)),
        None => {
            let prev = prev.expect("a run without a next specifier has a previous one");
            if only_commas_and_space(prev.end, first.start) {
                // `A, B` → `A` (and `A,\n  B,\n}` → `A,\n}`): the comma before goes with it.
                (prev.end, last.end)
            } else if own_lines {
                whole_lines()
            } else {
                (code[..first.start as usize].trim_end_matches([' ', '\t']).len() as u32, run_end)
            }
        }
    }
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_order_detection() {
        assert_eq!(SortOrder::of(["cva", "VariantProps"].into_iter()), Some(SortOrder::CaseInsensitive));
        assert_eq!(SortOrder::of(["Button", "buttonVariants"].into_iter()), Some(SortOrder::CaseInsensitive));
        assert_eq!(SortOrder::of(["B", "a"].into_iter()), Some(SortOrder::CaseSensitive));
        assert_eq!(SortOrder::of(["ChevronDownIcon", "CheckIcon", "ChevronUpIcon"].into_iter()), None);
        assert_eq!(SortOrder::of(["Only"].into_iter()), Some(SortOrder::CaseInsensitive));
    }

    #[test]
    fn module_paths_normalize_relative_alias_extension_and_index_spellings() {
        let page = "src/pages/Page.tsx";
        for spelling in [
            "@/components/ui/button",
            "~/components/ui/button",
            "@/components/ui/button.tsx",
            "@/components/ui/button/index",
            "@/components/ui/button/index.js",
            "@/components/ui/button/",
            "../components/ui/button",
            "../components/ui/button.ts",
            "../components/ui/button.jsx",
            "../components/ui/button.mjs",
            "./../components//ui/./button",
            "../../src/components/ui/button",
        ] {
            assert_eq!(module_path(page, spelling).as_deref(), Some("src/components/ui/button"), "{spelling}");
        }
        let app = |spelling| module_path("src/App.tsx", spelling);
        assert_eq!(app("./components/ui/button/index").as_deref(), Some("src/components/ui/button"));
        assert_eq!(app(".").as_deref(), Some("src"));
        assert_eq!(app("./index.tsx").as_deref(), Some("src"));
        assert_eq!(app("..").as_deref(), Some(""));
        assert_eq!(app("@/").as_deref(), Some("src"));
        // Only the known extensions go; `react-query.gen` is a name, not an extension.
        assert_eq!(module_path(page, "@/api/react-query.gen").as_deref(), Some("src/api/react-query.gen"));
        assert_eq!(module_path(page, "../api/react-query.gen.ts").as_deref(), Some("src/api/react-query.gen"));
        assert_eq!(module_path(page, "@/x.css").as_deref(), Some("src/x.css"));
        assert_eq!(module_path(page, "@/x.d.ts").as_deref(), Some("src/x.d"));
        assert_eq!(module_path(page, "@/.ts").as_deref(), Some("src/.ts"));
        // Bare specifiers and paths that leave the project have none.
        let bare = ["react", "@mui/material", "@components/ui/button", "components/ui/button", "/src/x", "~", "@"];
        for bare in bare.into_iter().chain(["../../../x"]) {
            assert_eq!(module_path(page, bare), None, "{bare}");
        }
    }

    #[test]
    fn same_module_compares_paths_and_bare_names_exactly() {
        let page = "src/pages/Page.tsx";
        assert!(same_module(page, "@/components/ui/button", "../components/ui/button/index.tsx"));
        assert!(same_module(page, "@mui/material", "@mui/material"));
        assert!(same_module(page, "../../../x", "../../../x"), "the same text is the same module");
        assert!(!same_module(page, "@mui/material", "@mui/material/index"));
        assert!(!same_module(page, "@/components/ui/button", "./components/ui/button"));
        assert!(!same_module(page, "@/components/ui/button", "components/ui/button"));
        assert!(!same_module(page, "@/components/ui/button", "@/components/ui/Button"));
        assert!(!same_module(page, "../../../x", "../../../x/index"), "outside the project: text only");
        assert!(!same_module("src/a/b.tsx", "./x", "../x"));
    }
}
