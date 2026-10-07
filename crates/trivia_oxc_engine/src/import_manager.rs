//! Import bookkeeping for inserted and removed components.
//!
//! Imports are derived from references, and only for names the op touched: an insert adds
//! (or merges) the specifiers its snippet needs; a remove drops a specifier only when the
//! removed subtree held that name's last reference. Unrelated unused imports are never pruned.

use std::collections::{BTreeMap, BTreeSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{ImportDeclaration, ImportDeclarationSpecifier, Program, Statement};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, Result};
use crate::text::{self, Edit};
use crate::{mutator, parse};

/// `import { name } from "source"`, or `import name from "source"` when `default`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSpec {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub default: bool,
}

/// Edits that make every name in `needed` resolvable, using `specs` for the missing ones.
pub fn ensure_imports(src: &str, program: &Program<'_>, specs: &[ImportSpec], needed: &[String]) -> Result<Vec<Edit>> {
    let semantic = SemanticBuilder::new().build(program).semantic;
    let scoping = semantic.scoping();
    let bound = |name: &str| scoping.get_root_binding(name.into()).is_some();

    for name in needed {
        if !bound(name) && !specs.iter().any(|s| &s.name == name) {
            return Err(EngineError::UnresolvedComponent(name.clone()));
        }
    }
    for spec in specs {
        if !is_identifier(&spec.name) || spec.source.is_empty() {
            return Err(EngineError::InvalidOp(format!("invalid import {{ {} }} from `{}`", spec.name, spec.source)));
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

    // Group the specifiers that are actually missing by source, keeping first-seen order.
    let mut by_source: Vec<(String, Vec<&ImportSpec>)> = Vec::new();
    let mut seen = BTreeSet::new();
    for spec in specs.iter().filter(|s| !bound(&s.name)) {
        if !seen.insert(spec.name.clone()) {
            continue;
        }
        match by_source.iter_mut().find(|(src, _)| *src == spec.source) {
            Some((_, list)) => list.push(spec),
            None => by_source.push((spec.source.clone(), vec![spec])),
        }
    }

    let mut edits = Vec::new();
    let mut new_decls: Vec<(String, Option<String>, Vec<String>)> = Vec::new();
    for (source, list) in by_source {
        let default = list.iter().find(|s| s.default).map(|s| s.name.clone());
        let named: Vec<String> = list.iter().filter(|s| !s.default).map(|s| s.name.clone()).collect();
        let target = imports.iter().find(|d| d.source.value.as_str() == source && d.import_kind.is_value());
        match (target, default.is_none()) {
            (Some(decl), true) if !named.is_empty() => match merge_named(src, decl, &named) {
                Some(merge) => edits.extend(merge),
                None => new_decls.push((source, None, named)),
            },
            _ => new_decls.push((source, default, named)),
        }
    }

    if !new_decls.is_empty() {
        edits.push(new_declarations(src, program, &imports, &new_decls));
    }
    Ok(edits)
}

/// Add named specifiers to an existing declaration. `None` when the declaration's shape
/// (side-effect, namespace, empty braces) makes a separate declaration cleaner.
fn merge_named(src: &str, decl: &ImportDeclaration<'_>, names: &[String]) -> Option<Vec<Edit>> {
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
    let sorted = named.windows(2).all(|w| w[0].0 <= w[1].0);
    let mut sorted_names: Vec<&String> = names.iter().collect();
    sorted_names.sort();

    // Bucket new names by the existing specifier they go before (`len` = append).
    let mut buckets: BTreeMap<usize, Vec<&String>> = BTreeMap::new();
    for name in sorted_names {
        let pos = if sorted { named.iter().position(|(n, _)| n.as_str() > name.as_str()).unwrap_or(named.len()) } else { named.len() };
        buckets.entry(pos).or_default().push(name);
    }
    let edits = buckets
        .into_iter()
        .map(|(pos, names)| {
            if pos < named.len() {
                let at = named[pos].1.start;
                let sep = if multiline { format!(",{nl}{}", text::line_indent(src, at)) } else { ", ".to_string() };
                let text: String = names.iter().map(|n| format!("{n}{sep}")).collect();
                Edit::insert(at, text)
            } else {
                let last = named[named.len() - 1].1;
                let sep = if multiline { format!(",{nl}{}", text::line_indent(src, last.start)) } else { ", ".to_string() };
                let text: String = names.iter().map(|n| format!("{sep}{n}")).collect();
                Edit::insert(last.end, text)
            }
        })
        .collect();
    Some(edits)
}

/// One edit inserting new declarations after the last import (or before the first statement).
fn new_declarations(
    src: &str,
    program: &Program<'_>,
    imports: &[&ImportDeclaration<'_>],
    decls: &[(String, Option<String>, Vec<String>)],
) -> Edit {
    let nl = text::newline(src);
    let (quote, semi) = match imports.last() {
        Some(last) => {
            let q = src.as_bytes()[last.source.span.start as usize] as char;
            let q = if q == '\'' { '\'' } else { '"' };
            (q, if src[..last.span.end as usize].ends_with(';') { ";" } else { "" })
        }
        None => {
            let semi = program.body.first().is_some_and(|s| src[..s.span().end as usize].ends_with(';'));
            ('"', if semi { ";" } else { "" })
        }
    };
    let lines: Vec<String> = decls
        .iter()
        .map(|(source, default, named)| {
            let mut clause = Vec::new();
            if let Some(d) = default {
                clause.push(d.clone());
            }
            if !named.is_empty() {
                clause.push(format!("{{ {} }}", named.join(", ")));
            }
            format!("import {} from {quote}{source}{quote}{semi}", clause.join(", "))
        })
        .collect();
    match imports.last() {
        // After the last import's line, so a trailing comment stays where it was.
        Some(last) => Edit::insert(text::line_end(src, last.span.end), format!("{nl}{}", lines.join(nl))),
        None => {
            let at = program.body.first().map_or_else(
                || program.directives.last().map_or(0, |d| text::line_end(src, d.span.end)),
                |s| s.span().start,
            );
            let after = if program.body.is_empty() { nl.to_string() } else { format!("{nl}{nl}") };
            let before = if at > 0 && program.body.is_empty() { nl } else { "" };
            Edit::insert(at, format!("{before}{}{after}", lines.join(nl)))
        }
    }
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

    let mut edits = Vec::new();
    for stmt in &program.body {
        let Statement::ImportDeclaration(decl) = stmt else { continue };
        let Some(specifiers) = &decl.specifiers else { continue };
        let locals: Vec<(&str, Span, bool)> = specifiers
            .iter()
            .map(|s| match s {
                ImportDeclarationSpecifier::ImportSpecifier(s) => (s.local.name.as_str(), s.span, false),
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => (s.local.name.as_str(), s.span, true),
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => (s.local.name.as_str(), s.span, true),
            })
            .collect();
        let remove: Vec<bool> = locals.iter().map(|(name, _, _)| unused(name)).collect();
        if !remove.iter().any(|&r| r) {
            continue;
        }
        if remove.iter().all(|&r| r) {
            let (start, end) = mutator::removal_range(code, decl.span);
            edits.push(Edit::delete(start, end));
            continue;
        }
        edits.extend(specifier_removals(code, &locals, &remove));
    }
    if edits.is_empty() {
        return Ok(code.to_string());
    }
    Ok(text::apply_edits(code, &edits)?.0)
}

/// Deletions for a subset of specifiers, merging contiguous runs so ranges never overlap.
fn specifier_removals(code: &str, specs: &[(&str, Span, bool)], remove: &[bool]) -> Vec<Edit> {
    let named: Vec<usize> = (0..specs.len()).filter(|&i| !specs[i].2).collect();
    let mut edits = Vec::new();

    // Default/namespace specifier: `import D, { A } from` → `import { A } from`.
    for i in (0..specs.len()).filter(|&i| specs[i].2 && remove[i]) {
        let next_start = specs.get(i + 1).map_or(specs[i].1.end, |s| {
            // Delete up to the `{` that follows the comma.
            let between = &code[specs[i].1.end as usize..s.1.start as usize];
            specs[i].1.end + between.find('{').map_or(between.len(), |p| p) as u32
        });
        edits.push(Edit::delete(specs[i].1.start, next_start));
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
        let (first, last) = (specs[named[run_start]].1, specs[named[k - 1]].1);
        if k < named.len() {
            edits.push(Edit::delete(first.start, specs[named[k]].1.start));
        } else if run_start > 0 {
            edits.push(Edit::delete(specs[named[run_start - 1]].1.end, last.end));
        } else {
            // Every named specifier goes but a default stays: drop `, { … }`.
            let default_end = specs.iter().find(|s| s.2).map_or(first.start, |s| s.1.end);
            let close = code[last.end as usize..].find('}').map_or(last.end, |p| last.end + p as u32 + 1);
            edits.push(Edit::delete(default_end, close));
        }
    }
    edits
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}
