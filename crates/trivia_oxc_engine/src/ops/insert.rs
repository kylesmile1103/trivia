//! `insert` and `insertChild`: splice one JSX element (a snippet from outside the process)
//! next to or into a node, indented to match, plus the imports it needs.

use std::collections::BTreeSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Expression, Statement};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};

use super::{Doc, Outcome, Placement, finish, literal_ranges};
use crate::error::{EngineError, Result};
use crate::import_manager::{self, ImportSpec};
use crate::locator::JsxTable;
use crate::parse;
use crate::text;

impl Doc<'_, '_> {
    pub(super) fn insert(&self, target: usize, placement: Placement, snippet: &str, imports: &[ImportSpec]) -> Result<Outcome> {
        let snippet = snippet.trim();
        let parsed = parse_snippet(snippet)?;
        import_manager::validate_specs(imports)?;
        let anchor = self.anchor(target, placement)?;
        let nl = text::newline(self.src);
        let (snippet_unit, unit) = (text::indent_unit(snippet), text::indent_unit(self.src));
        let body = |indent: &str| text::reindent_snippet(snippet, indent, nl, &parsed.frozen, &snippet_unit, &unit);
        let (edit, offset) = self.anchor_edit(anchor, snippet, &body)?;
        // Only the imports the snippet actually references: the op touches nothing else.
        let used: Vec<ImportSpec> = imports.iter().filter(|s| parsed.free.contains(&s.name)).cloned().collect();
        if !used.is_empty() {
            self.check_not_shadowed(anchor.node(), &used)?;
        }
        let mut edits = vec![edit];
        edits.extend(import_manager::ensure_imports(self.src, self.file, self.program, &used, &parsed.components)?);
        let (code, starts) = text::apply_edits(self.src, &edits)?;
        let imported: Vec<&str> = used.iter().map(|s| s.name.as_str()).collect();
        finish(self.file, self.src, code, Some(starts[0] + offset), &imported)
    }

    /// Refuse an insert whose requested imports would be shadowed where the snippet lands
    /// (next to or inside `dest`): a `<Button>` placed in a scope that declares its own
    /// `Button` would render that one, not the import.
    pub(super) fn check_not_shadowed(&self, dest: usize, used: &[ImportSpec]) -> Result<()> {
        let semantic = SemanticBuilder::new().with_build_nodes(true).build(self.program).semantic;
        let scoping = semantic.scoping();
        let dest = self.jsx_ast_node(semantic.nodes(), dest)?;
        for spec in used {
            let there = scoping.find_binding(dest.scope_id(), spec.name.as_str().into());
            if let Some(local) = there
                && there != scoping.get_root_binding(spec.name.as_str().into())
            {
                return Err(EngineError::Unsupported(format!(
                    "`{}` where the element would go is the local declared on line {}, which would shadow `{}`; \
                     rename that local first",
                    spec.name,
                    text::line_col(self.src, scoping.symbol_span(local).start).0,
                    spec.declaration()
                )));
            }
        }
        Ok(())
    }
}

/// What a parsed snippet needs from the file it goes into.
pub(super) struct SnippetInfo {
    /// Component names its tags use (`Button`, `Card` in `Card.Header`): each must be bound
    /// in the file or come with an import.
    pub(super) components: Vec<String>,
    /// Every name it references without binding it (components and `{…}` identifiers):
    /// the imports worth adding.
    pub(super) free: BTreeSet<String>,
    /// Multi-line string/template literal ranges (relative to the snippet) not to re-indent.
    pub(super) frozen: Vec<(u32, u32)>,
}

/// Longest snippet accepted, in bytes (after trimming surrounding whitespace).
///
/// Operator chains nest one level per byte or two without a single bracket (`!!!!x`, `x!!!!`,
/// `-+-+x`, `x+x+…`, `x=x=…`, `a?b:a?b:…`, `a=>a=>…`, `x.y.y…`), and the semantic pass costs
/// about 1.2 KB of stack per level in a debug build (80 B in release). 4096 bytes of the
/// worst chain therefore need about 5 MB, which fits the 8 MiB of a main thread with room to
/// spare; 16 KiB would need about 20 MB (`tests/stack_budget.rs` runs the worst inputs on an
/// 8 MiB thread). Palette templates are a few hundred bytes.
pub const MAX_SNIPPET_BYTES: usize = 4096;

/// Deepest nesting a snippet may have, counting elements, `{…}` containers, brackets and
/// template substitutions ([`text::nesting_depth`]).
pub const MAX_SNIPPET_DEPTH: usize = 256;

/// Most tags and brackets (`<`, `(`, `[`, `{` bytes) a snippet may contain. The depth above
/// is an estimate; this bounds the real depth however the snippet is spelled
/// ([`text::MAX_TAGS_AND_BRACKETS`]).
pub const MAX_SNIPPET_TAGS_AND_BRACKETS: usize = text::MAX_TAGS_AND_BRACKETS;

/// The parser, and every pass after it, recurses once per nesting level, and a snippet comes
/// from outside the process: thousands of levels would overflow the native stack and kill the
/// host (the user's dev server) instead of failing. So its size and nesting are checked on
/// the bytes before anything parses them.
pub(super) fn check_snippet_size(snippet: &str) -> Result<()> {
    if snippet.len() > MAX_SNIPPET_BYTES {
        return Err(EngineError::InvalidSnippet(format!(
            "it is {} bytes long; the limit is {MAX_SNIPPET_BYTES}",
            snippet.len()
        )));
    }
    let openers = text::tags_and_brackets(snippet);
    if openers <= MAX_SNIPPET_DEPTH {
        // Every level starts at one of them.
        return Ok(());
    }
    let depth = text::nesting_depth(snippet);
    if depth > MAX_SNIPPET_DEPTH {
        return Err(EngineError::InvalidSnippet(format!(
            "it nests {depth} levels deep (elements, `{{…}}` and brackets); the limit is {MAX_SNIPPET_DEPTH}"
        )));
    }
    if openers > MAX_SNIPPET_TAGS_AND_BRACKETS {
        return Err(EngineError::InvalidSnippet(format!(
            "it has {openers} tags and brackets; the limit is {MAX_SNIPPET_TAGS_AND_BRACKETS}"
        )));
    }
    Ok(())
}

/// Parse a snippet as exactly one JSX element/fragment, with nothing else around it (no
/// comments, no parentheses: those would become JSX text once spliced into children).
pub(super) fn parse_snippet(snippet: &str) -> Result<SnippetInfo> {
    if snippet.is_empty() {
        return Err(EngineError::InvalidSnippet("empty snippet".into()));
    }
    check_snippet_size(snippet)?;
    const PREFIX: &str = "(\n";
    let wrapped = format!("{PREFIX}{snippet}\n);");
    let alloc = Allocator::default();
    let program = parse(&alloc, &wrapped, "snippet.tsx").map_err(|e| EngineError::InvalidSnippet(e.to_string()))?;
    let jsx = match program.body.as_slice() {
        [Statement::ExpressionStatement(stmt)] => match stmt.expression.without_parentheses() {
            e @ (Expression::JSXElement(_) | Expression::JSXFragment(_)) => Some(e.span()),
            _ => None,
        },
        _ => None,
    };
    let exact = Span::new(PREFIX.len() as u32, (PREFIX.len() + snippet.len()) as u32);
    match jsx {
        Some(span) if span == exact => {}
        Some(_) => {
            return Err(EngineError::InvalidSnippet(
                "expected exactly one JSX element, without surrounding parentheses or comments".into(),
            ));
        }
        None => return Err(EngineError::InvalidSnippet("expected exactly one JSX element".into())),
    }
    let table = JsxTable::build(&program, "snippet.tsx").map_err(|e| EngineError::InvalidSnippet(e.to_string()))?;
    let components: BTreeSet<String> =
        table.nodes.iter().filter_map(|n| n.component_ref().map(str::to_string)).collect();
    let semantic = oxc_semantic::SemanticBuilder::new().build(&program).semantic;
    let free = semantic.scoping().root_unresolved_references().keys().map(|name| name.to_string()).collect();
    let frozen = literal_ranges(&wrapped, &program, exact);
    Ok(SnippetInfo { components: components.into_iter().collect(), free, frozen })
}
